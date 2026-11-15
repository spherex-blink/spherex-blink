"""Find Solar System movers that SPHEREx imaged many times, with SPHEREx-centred (-163182) positions.

    python -m pipeline.movers.find_movers ceres [vesta ...]     # slugs from CANDIDATES (or 'all')
    python -m pipeline.movers.find_movers validate ceres

Functions: horizons_ephemeris, exposures_containing, runs_of, validate.  Written with Claude Code.
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import requests
from scipy.interpolate import CubicSpline

from pipeline.index.lookup import SkyIndex, point_in_footprint

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
SPHEREX = "500@-163182"
GEO = "500@399"
T0, T1 = "2025-04-24", "2026-10-06"
OUT = Path("data/movers")
EXP_S = 113.0

# slug -> dict(name, cmd, step, approach (UT) for NEOs: +-2 d window)
CANDIDATES = {
    "ceres": dict(name="1 Ceres", cmd="DES=2000001;", step="1h"),
    "vesta": dict(name="4 Vesta", cmd="DES=2000004;", step="1h"),
    "pallas": dict(name="2 Pallas", cmd="DES=2000002;", step="1h"),
    "hygiea": dict(name="10 Hygiea", cmd="DES=2000010;", step="1h"),
    "juno": dict(name="3 Juno", cmd="DES=2000003;", step="1h"),
    "3i-atlas": dict(name="3I/ATLAS (C/2025 N1)", cmd="DES=C/2025 N1;", step="1h"),
    "162882": dict(name="162882 (2001 FD58)", cmd="DES=2162882;", step="10m", approach="2026-02-14 14:11"),
    "2005ez223": dict(name="2005 EZ223", cmd="DES=2005 EZ223;", step="10m", approach="2025-11-03 09:32"),
    "2022fg4": dict(name="2022 FG4", cmd="DES=2022 FG4;", step="10m", approach="2025-11-16 18:24"),
    "2025fa22": dict(name="2025 FA22", cmd="DES=2025 FA22;", step="10m", approach="2025-09-18 07:42"),
    "3361": dict(name="3361 Orpheus", cmd="DES=2003361;", step="10m", approach="2025-11-19 01:27"),
}


def mjd_to_jd(m):
    return m + 2400000.5


def _parse(text):
    if "$$SOE" not in text:
        raise RuntimeError(text[-800:])
    head, rest = text.split("$$SOE")
    rows = rest.split("$$EOE")[0].strip().splitlines()
    hl = [l for l in head.splitlines() if l.strip().startswith("Date__")][-1]
    cols = [c.strip() for c in hl.split(",")]
    return cols, [[c.strip() for c in r.split(",")] for r in rows]


def _call(params, tries=4):
    r = None
    for i in range(tries):
        r = requests.get(API, params=params, timeout=180)
        if r.status_code == 200:
            return r.text
        time.sleep(2 * (i + 1))
    raise IOError(f"Horizons HTTP {r.status_code}")


def horizons_ephemeris(cmd, start=T0, stop=T1, step="1h", center=SPHEREX, tlist=None, chunk_rows=20000):
    """ndarray (n,5): mjd(UT), ra, dec (deg, ICRF astrometric, light-time corrected), delta (AU), V/T mag (nan if none).
    center '500@-163182' = SPHEREx-centred (includes spacecraft parallax); '500@399' = geocentric."""
    from astropy.time import Time
    base = dict(format="text", COMMAND=f"'{cmd}'", OBJ_DATA="'NO'", MAKE_EPHEM="'YES'", EPHEM_TYPE="'OBSERVER'",
                CENTER=f"'{center}'", QUANTITIES="'1,9,20'", ANG_FORMAT="'DEG'", CSV_FORMAT="'YES'",
                CAL_FORMAT="'JD'", EXTRA_PREC="'YES'")
    chunks = []
    if tlist is not None:
        tl = list(tlist)
        for i in range(0, len(tl), 40):
            part = tl[i:i + 40]
            if len(part) == 1:          # Horizons mis-handles a one-element TLIST: pad with a later time
                part = part + [part[0] + 1e-4]
            chunks.append(dict(base, TLIST="'" + " ".join(f"{mjd_to_jd(m):.7f}" for m in part) + "'"))
    else:
        t0, t1 = Time(start, scale="utc").mjd, Time(stop, scale="utc").mjd
        unit = {"m": 1 / 1440, "h": 1 / 24, "d": 1}[step[-1]] * int(step[:-1])
        a = t0
        while a < t1:
            b = min(t1, a + chunk_rows * unit)
            chunks.append(dict(base, START_TIME=f"'JD {mjd_to_jd(a):.6f}'", STOP_TIME=f"'JD {mjd_to_jd(b):.6f}'",
                               STEP_SIZE=f"'{step}'"))
            a = b + unit
    res = []
    for p in chunks:
        cols, rows = _parse(_call(p))
        ira = next(i for i, c in enumerate(cols) if c.startswith("R.A."))
        idel = cols.index("delta")
        imag = next((i for i, c in enumerate(cols) if c in ("APmag", "T-mag")), None)
        for r in rows:
            try:
                v = float(r[imag]) if imag is not None else np.nan
            except ValueError:
                v = np.nan
            res.append((float(r[0]) - 2400000.5, float(r[ira]), float(r[ira + 1]), float(r[idel]), v))
    arr = np.array(res)
    if tlist is not None:
        return arr
    _, idx = np.unique(arr[:, 0], return_index=True)
    return arr[idx]


def _unit(ra, dec):
    ra, dec = np.radians(ra), np.radians(dec)
    return np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], -1)


def _radec(v):
    v = v / np.linalg.norm(v, axis=-1, keepdims=True)
    return np.degrees(np.arctan2(v[..., 1], v[..., 0])) % 360, np.degrees(np.arcsin(np.clip(v[..., 2], -1, 1)))


def interpolator(eph):
    """Cubic spline on unit vectors (no RA wrap problems) -> f(mjd) = (ra, dec)."""
    cs = CubicSpline(eph[:, 0], _unit(eph[:, 1], eph[:, 2]))
    return lambda m: _radec(cs(m))


def _sep(a, b):
    return np.degrees(np.arccos(np.clip(np.sum(a * b, -1), -1, 1)))


def exposures_containing(eph, index, spacing=0.25, verbose=False):
    """SPHEREx exposures whose footprint contains the object at exposure mid-time (t + 56.5 s).
    Query points are <= `spacing` deg apart along the path; each only keeps exposures in its time window."""
    f = interpolator(eph)
    m0, m1 = eph[0, 0], eph[-1, 0]
    u = _unit(eph[:, 1], eph[:, 2])
    seg = _sep(u[:-1], u[1:])
    tt = [eph[0, 0]]
    for i, s in enumerate(seg):
        n = max(1, int(np.ceil(s / spacing)))
        tt.extend(eph[i, 0] + (eph[i + 1, 0] - eph[i, 0]) * np.arange(1, n + 1) / n)
    tt = np.array(tt)
    ra, dec = f(tt)
    uu = _unit(ra, dec)
    keep = [0]
    for i in range(1, len(tt)):
        if _sep(uu[i], uu[keep[-1]]) >= spacing * 0.99:
            keep.append(i)
    if keep[-1] != len(tt) - 1:
        keep.append(len(tt) - 1)
    seen, cand = set(), []
    for j, i in enumerate(keep):
        tlo = tt[keep[j - 1]] if j else tt[i] - 0.01
        thi = tt[keep[j + 1]] if j + 1 < len(keep) else tt[i] + 0.01
        for r in index.covering(float(ra[i]), float(dec[i]), t_range=(tlo - 0.02, thi + 0.02)):
            if r["key"] not in seen:
                seen.add(r["key"])
                cand.append(r)
    if verbose:
        print(f"  {len(keep)} query points -> {len(cand)} candidate exposures", flush=True)
    out = []
    for r in cand:
        mid = r["t"] + EXP_S / 2 / 86400
        if not (m0 <= mid <= m1):
            continue
        o_ra, o_dec = (float(x) for x in f(mid))
        if point_in_footprint(o_ra, o_dec, r["corners"]):
            out.append(dict(r, mjd_mid=mid, ra_obj=o_ra, dec_obj=o_dec))
    out.sort(key=lambda r: r["mjd_mid"])
    return out


def runs_of(exps, gap_h=12.0):
    runs, cur = [], []
    for e in exps:
        if cur and (e["mjd_mid"] - cur[-1]["mjd_mid"]) * 24 > gap_h:
            runs.append(cur)
            cur = []
        cur.append(e)
    if cur:
        runs.append(cur)
    return runs


def px_per_frame(exps):
    """Median motion (px of 6.15") between consecutive exposures <6 min apart."""
    v = []
    for a, b in zip(exps, exps[1:]):
        dt = (b["mjd_mid"] - a["mjd_mid"]) * 1440
        if 0 < dt < 6:
            v.append(_sep(_unit(a["ra_obj"], a["dec_obj"]), _unit(b["ra_obj"], b["dec_obj"])) * 3600 / 6.15)
    return float(np.median(v)) if v else float("nan")


def stats(eph, exps):
    runs = runs_of(exps)
    bursts = runs_of(exps, 6 / 60)
    m = [e["mjd_mid"] for e in exps]
    return dict(n=len(exps), n_runs=len(runs), best_run=max((len(r) for r in runs), default=0),
                best_burst=max((len(b) for b in bursts), default=0), px_frame=px_per_frame(exps),
                vmag=float(np.nanmedian(np.interp(m, eph[:, 0], eph[:, 4]))) if exps else float("nan"),
                delta=float(np.median(np.interp(m, eph[:, 0], eph[:, 3]))) if exps else float("nan"))


def process(slug, index):
    c = CANDIDATES[slug]
    if "approach" in c:
        from astropy.time import Time
        ta = Time(c["approach"], scale="utc").mjd
        start, stop = Time(ta - 2, format="mjd").iso, Time(ta + 2, format="mjd").iso
    else:
        start, stop = T0, T1
    print(slug, c["name"], start, stop, c["step"], flush=True)
    eph = horizons_ephemeris(c["cmd"], start, stop, c["step"])
    eph = eph[eph[:, 0] >= 60789]
    exps = exposures_containing(eph, index, verbose=True)
    if exps:   # refine with exact-time SPHEREx-centred positions
        ut = sorted({round(e["mjd_mid"], 7) for e in exps})     # several detectors share the same time
        ex = horizons_ephemeris(c["cmd"], tlist=ut)
        lut = {t: row for t, row in zip(ut, ex)}
        for e in exps:
            row = lut[round(e["mjd_mid"], 7)]
            e["ra_obj"], e["dec_obj"] = float(row[1]), float(row[2])
        exps = [e for e in exps if point_in_footprint(e["ra_obj"], e["dec_obj"], e["corners"])]
    st = stats(eph, exps)
    runs = runs_of(exps)
    st["name"], st["slug"] = c["name"], slug
    e_out = eph[:: int(np.ceil(len(eph) / 12000))] if len(eph) > 12000 else eph
    doc = dict(name=c["name"], designation=c["cmd"], horizons_id=c["cmd"], observer="SPHEREx (-163182)",
               ephemeris=[[round(float(a), 6), round(float(b), 5), round(float(d), 5), round(float(g), 6),
                           None if np.isnan(v) else round(float(v), 2)] for a, b, d, g, v in e_out],
               exposures=[dict(key=e["key"], obs=e["obs"], det=e["det"], t=e["t"], mjd_mid=round(e["mjd_mid"], 6),
                               ra_obj=round(e["ra_obj"], 6), dec_obj=round(e["dec_obj"], 6)) for e in exps],
               runs=[dict(start_mjd=round(r[0]["mjd_mid"], 5), end_mjd=round(r[-1]["mjd_mid"], 5), n=len(r)) for r in runs])
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{slug}.json").write_text(json.dumps(doc, separators=(",", ":")))
    (OUT / f"{slug}.stats.json").write_text(json.dumps(st))
    print("  ", {k: (round(v, 2) if isinstance(v, float) else v) for k, v in st.items()}, flush=True)
    return st


def validate(slug, n=6, half=30):
    """Measure the object's centroid in n exposures (different detectors/days) vs predicted positions."""
    from pipeline.index.headers import fetch_header_facts, wcs_from_facts, cutout
    from scipy.ndimage import gaussian_filter
    doc = json.loads((OUT / f"{slug}.json").read_text())
    c = CANDIDATES[slug]
    by = {}
    for e in doc["exposures"]:
        by.setdefault((int(e["mjd_mid"]) // 5, e["det"]), e)
    sel = list(by.values())
    np.random.default_rng(1).shuffle(sel)
    out = []
    for e in sel:
        if len(out) >= n:
            break
        try:
            facts = fetch_header_facts(e["key"])
        except Exception as err:
            print("hdr fail", err)
            continue
        mid = facts["mjd_avg"]
        sp = horizons_ephemeris(c["cmd"], tlist=[mid], center=SPHEREX)[0]
        ge = horizons_ephemeris(c["cmd"], tlist=[mid], center=GEO)[0]
        w = wcs_from_facts(facts)
        ps = np.array(w.all_world2pix([sp[1]], [sp[2]], 0)).ravel()
        pg = np.array(w.all_world2pix([ge[1]], [ge[2]], 0)).ravel()
        got = cutout(e["key"], facts, sp[1], sp[2], half=half)
        if got is None:
            continue
        a, (x0, y0) = got
        sm = gaussian_filter(np.nan_to_num(a, nan=0.0), 1.2)
        bg = np.nanmedian(a)
        cx, cy = ps[0] - x0, ps[1] - y0
        yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
        sub = np.where((xx - cx) ** 2 + (yy - cy) ** 2 <= 10 ** 2, sm, -np.inf)
        iy, ix = np.unravel_index(np.argmax(sub), sub.shape)
        win = np.clip(np.nan_to_num(a[max(0, iy - 2):iy + 3, max(0, ix - 2):ix + 3] - bg, nan=0.0), 0, None)
        gy, gx = np.mgrid[max(0, iy - 2):max(0, iy - 2) + win.shape[0], max(0, ix - 2):max(0, ix - 2) + win.shape[1]]
        cen = ((win * gx).sum() / win.sum() + x0, (win * gy).sum() / win.sum() + y0) if win.sum() > 0 else (np.nan, np.nan)
        mad = 1.4826 * np.nanmedian(np.abs(a - bg))
        r = dict(det=e["det"], mjd=round(mid, 4), peak_over_mad=float((a[iy, ix] - bg) / mad) if mad > 0 else float("nan"),
                 rank_in_cutout=int((np.nan_to_num(a, nan=-1e30) > a[iy, ix]).sum()), n_nan=int(np.isnan(a).sum()),
                 off_sx=float(np.hypot(cen[0] - ps[0], cen[1] - ps[1])), off_geo=float(np.hypot(cen[0] - pg[0], cen[1] - pg[1])),
                 sx_minus_geo_px=float(np.hypot(*(ps - pg))), delta=float(sp[3]))
        out.append(r)
        print({k: (round(v, 2) if isinstance(v, float) else v) for k, v in r.items()}, flush=True)
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "validate":
        validate(args[1])
    else:
        idx = SkyIndex()
        for s in (list(CANDIDATES) if args == ["all"] else args):
            process(s, idx)
