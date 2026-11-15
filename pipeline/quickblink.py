"""Click -> blink, end to end, from NASA's S3 bucket via our static sky index (reference for the browser version).

    from pipeline.quickblink import quick_blink
    res = quick_blink(269.452, 4.693, pm=(-801.551, 10362.394))   # Barnard's Star, proper motion in mas/yr
Steps: index lookup -> group exposures into visits -> pick frames -> headers + rows from S3 (parallel) -> reproject to one grid.
Written with Claude Code.
"""
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from astropy.coordinates import SkyCoord
from astropy.time import Time
from astropy.wcs import WCS
import astropy.units as u
from reproject import reproject_interp

from pipeline.index.lookup import SkyIndex
from pipeline.index.headers import fetch_header_facts, wcs_from_facts, cutout

PIX_DEG = 6.15 / 3600
VISIT_GAP_DAYS = 30


def group_visits(rows):
    """Split time-sorted exposures into visits at gaps > VISIT_GAP_DAYS, and also cap each visit at VISIT_GAP_DAYS long:
    near the ecliptic poles SPHEREx observes almost continuously, so gaps alone never split (R Dra, measured 14.11)."""
    visits, cur = [], []
    for r in rows:
        if cur and (r["t"] - cur[-1]["t"] > VISIT_GAP_DAYS or r["t"] - cur[0]["t"] > VISIT_GAP_DAYS):
            visits.append(cur); cur = []
        cur.append(r)
    if cur:
        visits.append(cur)
    # fold small tail stubs (< 20% of the previous visit, starting within VISIT_GAP_DAYS of it) back into that visit
    merged = []
    for v in visits:
        if merged and len(v) < 0.2 * len(merged[-1]) and v[0]["t"] - merged[-1][-1]["t"] <= VISIT_GAP_DAYS:
            merged[-1] = merged[-1] + v
        else:
            merged.append(v)
    return merged


AUTO_DETECTOR_ORDER = (6, 5, 4, 3, 2, 1)


def pick(visits, detector=None, per_visit=1, which="ends"):
    """Choose frames for one detector.
    detector=None ("auto"): prefer LONG wavelengths (D6, D5, D4, then D3..D1), taking the first detector seen in at least
    two visits (or in the only visit). Cold objects (brown dwarfs, a "Planet X") are brightest there and bright stars saturate
    less; WISE 0855 is invisible in D3 (measured 14.11).
    which="ends": the first and last visits THAT CONTAIN the detector (the plain first/last visit may lack it: R Dra gave a
    single frame, 14.11). which="all": every visit containing it. per_visit exposures each, spread through the visit."""
    if detector is None:
        n_vis = {d: sum(any(r["det"] == d for r in v) for v in visits) for d in AUTO_DETECTOR_ORDER}
        need = 2 if len(visits) > 1 else 1
        detector = next((d for d in AUTO_DETECTOR_ORDER if n_vis[d] >= need),
                        max(AUTO_DETECTOR_ORDER, key=lambda d: n_vis[d]))
    with_det = [v for v in visits if any(r["det"] == detector for r in v)]
    chosen_visits = [with_det[0], with_det[-1]] if which == "ends" and len(with_det) > 1 else with_det
    frames = []
    for vi, v in enumerate(chosen_visits):
        # never fall back to another detector: mixing detectors in one blink mixes wavelengths (bug found 14.11)
        cand = [r for r in v if r["det"] == detector]
        if not cand:
            continue
        idx = np.unique(np.linspace(0, len(cand) - 1, per_visit).round().astype(int))
        frames += [dict(cand[i], visit=vi) for i in idx]
    return frames, detector


def target_grid(ra, dec, n):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-PIX_DEG, PIX_DEG]
    return w


def position_at(ra, dec, pm, mjd):
    if not pm:
        return ra, dec
    c = SkyCoord(ra * u.deg, dec * u.deg, pm_ra_cosdec=pm[0] * u.mas / u.yr, pm_dec=pm[1] * u.mas / u.yr,
                 obstime=Time("J2000"), frame="icrs")
    p = c.apply_space_motion(new_obstime=Time(mjd, format="mjd"))
    return p.ra.deg, p.dec.deg


def quick_blink(ra, dec, pm=None, half=20, per_visit=1, detector=None, which="ends", index=None, threads=16, stack=0):
    """ra/dec at J2000 (+ optional proper motion in mas/yr). Returns frames reprojected onto one grid centred on the
    target's mean position, plus timings and the predicted pixel position of the target in every frame.
    stack=N (N >= 2): use N exposures per visit and combine them into ONE frame per visit (see stack_frames)."""
    tm = {}
    t0 = time.time()
    idx = index or SkyIndex()
    # look up at the position for the middle of the survey, then confirm per frame below
    mid_ra, mid_dec = position_at(ra, dec, pm, 61050)
    rows = idx.covering(mid_ra, mid_dec)
    tm["lookup_s"] = time.time() - t0
    if not rows:
        return {"frames": [], "timing": tm, "n_exposures": 0}
    visits = group_visits(rows)
    frames, det = pick(visits, detector, max(per_visit, stack), which)
    sess = requests.Session()
    sess.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=threads))

    def one(r):
        f = fetch_header_facts(r["key"], session=sess)
        pra, pdec = position_at(ra, dec, pm, f["mjd_avg"])
        c = cutout(r["key"], f, pra, pdec, half=half + 6, session=sess)   # margin for reprojection
        return r, f, (pra, pdec), c

    t1 = time.time()
    with ThreadPoolExecutor(threads) as pool:
        got = list(pool.map(one, frames))
    tm["fetch_s"] = time.time() - t1

    t2 = time.time()
    n = 2 * half + 1
    grid = target_grid(mid_ra, mid_dec, n)
    out = []
    for r, f, (pra, pdec), c in got:
        if c is None:
            continue
        data, (x0, y0) = c
        # Re-anchor the WCS on the cutout. Use WCS slicing: it also moves the SIP model's own copy of CRPIX.
        # (Editing w.wcs.crpix alone leaves w.sip.crpix behind and misaligned frames by up to 1.6 px, measured 14.11.)
        w = wcs_from_facts(f).slice((slice(y0, y0 + data.shape[0]), slice(x0, x0 + data.shape[1])))
        img, _ = reproject_interp((data, w), grid, shape_out=(n, n))
        px, py = grid.world_to_pixel(SkyCoord(pra * u.deg, pdec * u.deg))
        out.append({"obs": r["obs"], "det": r["det"], "t": r["t"], "date": f["date_avg"][:10], "key": r["key"],
                    "image": img.astype(np.float32), "target_px": (float(px), float(py)), "visit": r["visit"],
                    "mjd": f["mjd_avg"]})
    if stack and stack >= 2:
        out = stack_frames(out)
    tm["reproject_s"] = time.time() - t2
    tm["total_s"] = time.time() - t0
    return {"frames": out, "detector": det, "timing": tm, "n_exposures": len(rows), "n_visits": len(visits),
            "visits": [(round(v[0]["t"], 2), round(v[-1]["t"], 2), len(v)) for v in visits], "grid": grid}


def stack_frames(frames):
    """Combine the aligned exposures of each visit into one frame (NASA's "co-add per detector" idea).
    Each exposure first has its own median subtracted (removes the zodiacal background level), then per pixel:
    3-sigma clipped mean around the median (robust MAD sigma) when >= 3 exposures, else the plain mean.
    This removes cosmic rays, flagged speckles and most hot pixels, and lowers the noise ~sqrt(N).
    Measured 14.11: per-visit 8-exposure stacks make Epsilon Indi B's motion and RW Aur's brightness change clean."""
    out = []
    for v in sorted({f["visit"] for f in frames}):
        fs = sorted([f for f in frames if f["visit"] == v], key=lambda f: f["t"])
        cube = np.array([f["image"] - np.nanmedian(f["image"]) for f in fs])
        if len(fs) >= 3:
            med = np.nanmedian(cube, axis=0)
            sig = np.nanmedian(np.abs(cube - med), axis=0) * 1.4826
            keep = np.abs(cube - med) <= 3 * np.where(sig > 0, sig, np.inf)
            img = np.nanmean(np.where(keep, cube, np.nan), axis=0)
        else:
            img = np.nanmean(cube, axis=0)
        mjd = float(np.mean([f["mjd"] for f in fs]))
        out.append({"obs": fs[0]["obs"], "det": fs[0]["det"], "t": fs[0]["t"], "mjd": mjd,
                    "date": Time(mjd, format="mjd").iso[:10], "key": fs[0]["key"], "visit": v,
                    "image": img.astype(np.float32),
                    "target_px": tuple(float(x) for x in np.mean([f["target_px"] for f in fs], axis=0)),
                    "n_stack": len(fs), "members": [{"obs": f["obs"], "key": f["key"], "mjd": f["mjd"]} for f in fs]})
    return out


def clip_stack(cube):
    """Per-pixel 3-sigma clipped mean around the median (robust MAD sigma); plain mean for < 3 layers.
    Each layer must already have its own background (median) removed."""
    cube = np.asarray(cube, dtype=float)
    if len(cube) < 3:
        return np.nanmean(cube, axis=0)
    med = np.nanmedian(cube, axis=0)
    sig = np.nanmedian(np.abs(cube - med), axis=0) * 1.4826
    keep = np.abs(cube - med) <= 3 * np.where(sig > 0, sig, np.inf)
    return np.nanmean(np.where(keep, cube, np.nan), axis=0)


def aperture_snr(img, x, y, exclude=5, stride=3):
    """Signal-to-noise of a 3x3 aperture sum at (x, y): compared with the same aperture placed on a regular grid
    (every `stride` px) over the rest of the image, skipping a box of +-exclude px around (x, y) and any aperture
    containing NaN. Noise = robust sigma (1.4826*MAD) of those sums; signal = aperture - their median.
    Deterministic, so the JS port gives the same number."""
    n = img.shape[0]
    xi, yi = int(round(x)), int(round(y))
    ap = img[yi - 1:yi + 2, xi - 1:xi + 2]
    if ap.shape != (3, 3) or np.isnan(ap).any():
        return float("nan"), float("nan")
    sums = []
    for cy in range(1, n - 1, stride):
        for cx in range(1, n - 1, stride):
            if abs(cx - xi) <= exclude and abs(cy - yi) <= exclude:
                continue
            a = img[cy - 1:cy + 2, cx - 1:cx + 2]
            if not np.isnan(a).any():
                sums.append(a.sum())
    sums = np.array(sums)
    med = np.median(sums)
    sig = np.median(np.abs(sums - med)) * 1.4826
    return float((ap.sum() - med) / sig), float(ap.sum() - med)


def deep_stack(ra, dec, pm=None, detector=None, half=30, max_exposures=120, index=None, threads=24):
    """Shift-and-stack: combine (up to max_exposures) exposures of one detector over the WHOLE survey, aligned on the
    target's predicted position at each exposure's time, so a faint mover adds up while the stars smear out.
    Also returns the ordinary sky-aligned stack of the same exposures for comparison (there the mover smears).
    Measured 14.11: WISE 0855 is invisible in single D6 exposures and in 8-exposure visit stacks, but detected in
    the 45-exposure D6 shift-and-stack."""
    tm = {}
    t0 = time.time()
    idx = index or SkyIndex()
    from pipeline.index.lookup import point_in_footprint
    rows, seen = [], set()
    for m in (60790, 61050, 61320):           # look up along the predicted track
        pra, pdec = position_at(ra, dec, pm, m)
        for r in idx.covering(pra, pdec):
            if r["key"] not in seen:
                seen.add(r["key"]); rows.append(r)
    rows = [r for r in rows if point_in_footprint(*position_at(ra, dec, pm, r["t"]), r["corners"])]
    rows.sort(key=lambda r: r["t"])
    tm["lookup_s"] = time.time() - t0
    counts = {d: sum(r["det"] == d for r in rows) for d in AUTO_DETECTOR_ORDER}
    if detector is None:
        detector = next((d for d in AUTO_DETECTOR_ORDER if counts[d] >= 10), max(counts, key=counts.get))
    sel = [r for r in rows if r["det"] == detector]
    if len(sel) > max_exposures:
        sel = [sel[i] for i in np.unique(np.linspace(0, len(sel) - 1, max_exposures).round().astype(int))]
    sess = requests.Session()
    sess.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=threads))

    def one(r):
        f = fetch_header_facts(r["key"], session=sess)
        pra, pdec = position_at(ra, dec, pm, f["mjd_avg"])
        return r, f, (pra, pdec), cutout(r["key"], f, pra, pdec, half=half + 6, session=sess)

    t1 = time.time()
    with ThreadPoolExecutor(threads) as pool:
        got = [g for g in pool.map(one, sel) if g[3] is not None]
    tm["fetch_s"] = time.time() - t1
    t2 = time.time()
    n = 2 * half + 1
    mid_ra, mid_dec = position_at(ra, dec, pm, 61050)
    sky_grid = target_grid(mid_ra, mid_dec, n)
    trk, sky, tpx, mjds = [], [], [], []
    for r, f, (pra, pdec), (data, (x0, y0)) in got:
        w = wcs_from_facts(f).slice((slice(y0, y0 + data.shape[0]), slice(x0, x0 + data.shape[1])))
        a, _ = reproject_interp((data, w), target_grid(pra, pdec, n), shape_out=(n, n))
        b, _ = reproject_interp((data, w), sky_grid, shape_out=(n, n))
        trk.append(a - np.nanmedian(a)); sky.append(b - np.nanmedian(b))
        px, py = sky_grid.world_to_pixel(SkyCoord(pra * u.deg, pdec * u.deg)); tpx.append((float(px), float(py)))
        mjds.append(f["mjd_avg"])
    track_img, sky_img = clip_stack(trk), clip_stack(sky)
    tm["reproject_s"] = time.time() - t2
    c = (n - 1) / 2
    snr_t, flux_t = aperture_snr(track_img, c, c)
    mx, my = np.mean(tpx, axis=0)
    snr_s, flux_s = aperture_snr(sky_img, mx, my)
    tm["total_s"] = time.time() - t0
    return {"detector": detector, "n_used": len(got), "n_available": len(sel) if len(sel) < max_exposures else counts[detector],
            "mjd_range": [float(min(mjds)), float(max(mjds))], "track": track_img.astype(np.float32), "sky": sky_img.astype(np.float32),
            "center_px": (c, c), "sky_target_px": [list(p) for p in tpx], "snr_track": snr_t, "snr_sky": snr_s,
            "flux_track": flux_t, "flux_sky": flux_s, "timing": tm}
