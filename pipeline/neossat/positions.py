"""Step 4: where is the object in each NEOSSat image, and can we trust the image's WCS?

    .venv/Scripts/python -m pipeline.neossat.positions 3i-atlas [--limit 10]

For every downloaded image:
  1. mid-exposure time = DATE-OBS (actual shutter-open, A_EXP_S) + EXPOSURE/2;
  2. object position from JPL Horizons, NEOSSat-centred ('500@-139089', includes the satellite's ~800 km orbit parallax)
     and geocentric ('500@399') for comparison;
  3. WCS check: detect stars, match to Gaia DR3 (ESA archive TAP), fit an affine correction to the header WCS
     (the header CRVAL equals the commanded pointing, so it may be attitude-based); report raw and fitted residuals;
  4. photometric zero point from the same Gaia stars (G mag vs counts/s in a 4 px aperture);
  5. the object's measured centroid vs the prediction (fitted WCS), in NEOSSat pixels (3.0").
Writes data/neossat/<slug>_positions.json. Written with Claude Code.
"""
import argparse
import io
import json
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS, FITSFixedWarning
from scipy import ndimage
from scipy.spatial import cKDTree

from pipeline.movers.find_movers import horizons_ephemeris
from pipeline.neossat.download import path_of
from pipeline.neossat.ssois import OUT

warnings.simplefilter("ignore", FITSFixedWarning)
NEOSSAT = "500@-139089"
GEO = "500@399"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
GAIA_CACHE = Path("cache/neossat/gaia")
PIX = 3.0                     # arcsec per NEOSSat pixel (nominal)


# ---------- image ----------
def load(image):
    """(data float64, header, wcs, mid-exposure MJD)."""
    with fits.open(path_of(image)) as h:
        hdr = h[0].header.copy()
        data = h[0].data.astype(float)
    for k in ("CUNIT1", "CUNIT2"):
        if hdr.get(k, "").strip().lower() in ("degrees", "degree"):
            hdr[k] = "deg"
    w = WCS(hdr, naxis=2)
    t0 = Time(hdr.get("A_EXP_S") or hdr["DATE-OBS"], scale="utc")
    mid = t0.mjd + float(hdr.get("EXPOSURE", hdr.get("AEXPTIME", 0))) / 2 / 86400
    return data, hdr, w, mid


def background(data, box=64):
    """Coarse median background (box x box tiles, smoothed), robust sigma of the residual."""
    ny, nx = data.shape
    gy, gx = ny // box, nx // box
    tiles = data[:gy * box, :gx * box].reshape(gy, box, gx, box).transpose(0, 2, 1, 3).reshape(gy, gx, -1)
    med = np.nanmedian(tiles, axis=2)
    med = ndimage.median_filter(med, 3, mode="nearest")
    bg = ndimage.zoom(med, (ny / gy, nx / gx), order=1)[:ny, :nx]
    res = data - bg
    sig = 1.4826 * np.nanmedian(np.abs(res - np.nanmedian(res)))
    return bg, sig


def detect(res, sig, nsig=8, max_n=400, edge=12):
    """Star-like peaks: local maxima of the smoothed image above nsig; flux-weighted centroids in 5x5 boxes."""
    sm = ndimage.gaussian_filter(np.nan_to_num(res), 1.0)
    mx = ndimage.maximum_filter(sm, 7)
    pk = (sm == mx) & (sm > nsig * sig / 2.0)
    ys, xs = np.nonzero(pk)
    ny, nx = res.shape
    ok = (xs > edge) & (xs < nx - edge) & (ys > edge) & (ys < ny - edge)
    ys, xs = ys[ok], xs[ok]
    order = np.argsort(-sm[ys, xs])[:max_n]
    out = []
    for y, x in zip(ys[order], xs[order]):
        win = np.clip(np.nan_to_num(res[y - 2:y + 3, x - 2:x + 3]), 0, None)
        if win.sum() <= 0:
            continue
        gy, gx = np.mgrid[y - 2:y + 3, x - 2:x + 3]
        out.append(((win * gx).sum() / win.sum(), (win * gy).sum() / win.sum(), float(sm[y, x])))
    return np.array(out) if out else np.zeros((0, 3))


# ---------- Gaia ----------
def gaia_cone(ra, dec, radius=0.45, gmax=15.5, tries=7):
    """Gaia DR3 stars (ra, dec, G) within radius deg; cached per ~0.1 deg position. Positions at J2016 (fine for 3" px)."""
    GAIA_CACHE.mkdir(parents=True, exist_ok=True)
    p = GAIA_CACHE / f"{ra:.1f}_{dec:+.1f}_{radius}_{gmax}.npy"
    if p.exists():
        return np.load(p)
    q = (f"SELECT ra, dec, phot_g_mean_mag FROM gaiadr3.gaia_source WHERE phot_g_mean_mag < {gmax} AND "
         f"1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{round(ra, 1)},{round(dec, 1)},{radius + 0.08}))")
    err = None
    for i in range(tries):
        try:
            r = requests.get(GAIA_TAP, params=dict(REQUEST="doQuery", LANG="ADQL", FORMAT="csv", QUERY=q), timeout=240)
            if r.status_code == 200 and r.text.startswith("ra"):
                a = np.loadtxt(io.StringIO(r.text), delimiter=",", skiprows=1, ndmin=2)
                np.save(p, a)
                return a
            err = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            err = repr(e)[:100]
        time.sleep(3 * (i + 1))
    raise IOError(f"Gaia query failed: {err}")


# ---------- WCS check / refit ----------
def fit_wcs(w, stars, gaia, shape, search_px=40, tol_px=2.5):
    """Match detected stars to Gaia; fit an affine pixel correction (6 params) so that  true_px = A @ wcs_px + b.
    Returns (corrected WCS, stats). The correction is folded into CRPIX/CD so the result is a plain TAN WCS."""
    gx, gy = w.all_world2pix(gaia[:, 0], gaia[:, 1], 0)
    ny, nx = shape
    inb = (gx > -20) & (gx < nx + 20) & (gy > -20) & (gy < ny + 20)
    gxy, gmag = np.c_[gx[inb], gy[inb]], gaia[inb, 2]
    st = dict(n_detected=len(stars), n_gaia=int(inb.sum()))
    if len(stars) < 6 or len(gxy) < 6:
        return w, dict(st, ok=False, why="too few stars")
    sxy = stars[:, :2]
    # 1) global shift: vote over all pairs within search_px (2D histogram of offsets, 1 px bins)
    tree = cKDTree(gxy)
    pairs = tree.query_ball_point(sxy, search_px)
    d = np.array([gxy[j] - sxy[i] for i, js in enumerate(pairs) for j in js]) if any(pairs) else np.zeros((0, 2))
    if len(d) < 6:
        return w, dict(st, ok=False, why="no offsets")
    H, xe, ye = np.histogram2d(d[:, 0], d[:, 1], bins=2 * search_px, range=[[-search_px, search_px]] * 2)
    i, j = np.unravel_index(np.argmax(H), H.shape)
    shift = np.array([(xe[i] + xe[i + 1]) / 2, (ye[j] + ye[j + 1]) / 2])     # gaia_px - star_px
    # 2) iterate: match within tol after the current transform, fit affine star_px -> gaia_px... (inverse wanted)
    A, b = np.eye(2), -shift          # model: true(star) px = A @ wcs_px(gaia) + b
    for tol in (6.0, tol_px, tol_px):
        pred = gxy @ A.T + b
        dd, k = cKDTree(sxy).query(pred, distance_upper_bound=tol)
        m = np.isfinite(dd)
        if m.sum() < 6:
            return w, dict(st, ok=False, why=f"only {int(m.sum())} matches", shift_px=shift.tolist())
        X = np.c_[gxy[m], np.ones(m.sum())]
        sol, *_ = np.linalg.lstsq(X, sxy[k[m]], rcond=None)
        A, b = sol[:2].T, sol[2]
    pred = gxy @ A.T + b
    dd, k = cKDTree(sxy).query(pred, distance_upper_bound=tol_px)
    m = np.isfinite(dd)
    # one Gaia star per detected star (the nearest): blends would bias the zero point
    best = {}
    for gi in np.nonzero(m)[0]:
        if k[gi] not in best or dd[gi] < dd[best[k[gi]]]:
            best[k[gi]] = gi
    m = np.zeros_like(m); m[list(best.values())] = True
    raw =np.hypot(*(sxy[k[m]] - gxy[m]).T)
    # fold into a new TAN WCS: world -> wcs_px (old) -> A,b -> true px.  true = A (p_old) + b  =>  p_old = A^-1 (true - b)
    Ai = np.linalg.inv(A)
    nw = w.deepcopy()
    crpix_old = np.array(w.wcs.crpix) - 1                     # 0-based
    nw.wcs.crpix = (A @ crpix_old + b) + 1
    cd = w.wcs.cd if w.wcs.has_cd() else np.diag(w.wcs.cdelt) @ w.wcs.get_pc()
    nw.wcs.cd = cd @ Ai
    if not w.wcs.has_cd():
        nw.wcs.cdelt = [1, 1]; nw.wcs.pc = cd @ Ai
    chk_x, chk_y = nw.all_world2pix(gaia[inb, 0][m], gaia[inb, 1][m], 0)
    post = np.hypot(chk_x - sxy[k[m], 0], chk_y - sxy[k[m], 1])
    scale = np.sqrt(abs(np.linalg.det(Ai))) * np.sqrt(abs(np.linalg.det(cd))) * 3600
    rot = np.degrees(np.arctan2(A[1, 0], A[0, 0]))
    return nw, dict(st, ok=True, n_match=int(m.sum()), shift_px=[float(b[0]), float(b[1])],
                    raw_median_px=float(np.median(raw)), raw_max_px=float(np.max(raw)),
                    rms_px=float(np.sqrt(np.mean(post ** 2))), rot_deg=float(rot), pix_arcsec=float(scale),
                    match_star_idx=k[m].tolist(), match_gmag=gmag[m].tolist())


# ---------- photometry helpers ----------
def ap_sum(res, x, y, r, r_in=None, r_out=None):
    """Sum in a circular aperture of radius r px (exact-ish via 5x5 sub-sampling) minus annulus median."""
    r_in = r_in or r + 4
    r_out = r_out or r_in + 6
    R = int(np.ceil(r_out)) + 1
    xi, yi = int(round(x)), int(round(y))
    ny, nx = res.shape
    if xi - R < 0 or yi - R < 0 or xi + R >= nx or yi + R >= ny:
        return np.nan, np.nan, np.nan
    sub = res[yi - R:yi + R + 1, xi - R:xi + R + 1]
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1] + np.array([yi, xi])[:, None, None]
    d = np.hypot(xx - x, yy - y)
    ann = sub[(d >= r_in) & (d <= r_out)]
    ann = ann[np.isfinite(ann)]
    if ann.size < 10:
        return np.nan, np.nan, np.nan
    med = np.median(ann)
    for _ in range(3):
        sg = 1.4826 * np.median(np.abs(ann - med))
        med = np.median(ann[np.abs(ann - med) <= 3 * sg]) if sg > 0 else med
    sg = 1.4826 * np.median(np.abs(ann - med))
    o = (np.arange(5) + 0.5) / 5 - 0.5
    wts = np.zeros_like(sub)
    for j, i in zip(*np.nonzero(d <= r + 1)):
        rr = np.hypot(xx[j, i] + o[None, :] - x, yy[j, i] + o[:, None] - y)
        wts[j, i] = np.mean(rr <= r)
    s = float(np.nansum((sub - med) * wts))
    return s, float(sg * np.sqrt(wts.sum())), float(med)


def zero_point(res, stars, st, exptime, sat=None, r=4.0):
    """ZP such that  G = ZP - 2.5 log10(counts/s), from matched Gaia stars with 9.5 < G < 14.5 (median, clipped)."""
    if not st.get("ok"):
        return np.nan, 0
    zs = []
    for si, g in zip(st["match_star_idx"], st["match_gmag"]):
        if not (9.5 < g < 14.5):
            continue
        x, y = stars[si, :2]
        if sat is not None and res[int(round(y)), int(round(x))] > sat:
            continue
        s, e, _ = ap_sum(res, x, y, r)
        if np.isfinite(s) and s > 0 and e > 0 and s / e > 20:
            zs.append(g + 2.5 * np.log10(s / exptime))
    if len(zs) < 3:
        return np.nan, len(zs)
    zs = np.array(zs)
    med = np.median(zs)
    keep = np.abs(zs - med) < max(0.3, 3 * 1.4826 * np.median(np.abs(zs - med)))
    return float(np.median(zs[keep])), int(keep.sum())


def centroid(res, x, y, search=8, win=3):
    """Brightest smoothed pixel within `search` px of (x, y), then a flux-weighted centroid in a (2win+1) box."""
    ny, nx = res.shape
    xi, yi = int(round(x)), int(round(y))
    if not (search + win <= xi < nx - search - win and search + win <= yi < ny - search - win):
        return np.nan, np.nan, np.nan
    sm = ndimage.gaussian_filter(np.nan_to_num(res[yi - search - win:yi + search + win + 1,
                                                   xi - search - win:xi + search + win + 1]), 1.5)
    yy, xx = np.mgrid[-search - win:search + win + 1, -search - win:search + win + 1]
    sm = np.where(np.hypot(xx, yy) <= search, sm, -np.inf)
    j, i = np.unravel_index(np.argmax(sm), sm.shape)
    py, px = yi + yy[j, i], xi + xx[j, i]
    w = np.clip(np.nan_to_num(res[py - win:py + win + 1, px - win:px + win + 1]), 0, None)
    if w.sum() <= 0:
        return np.nan, np.nan, np.nan
    gy, gx = np.mgrid[py - win:py + win + 1, px - win:px + win + 1]
    return float((w * gx).sum() / w.sum()), float((w * gy).sum() / w.sum()), float(sm[j, i])


# ---------- per image ----------
def analyse(image, sp, ge):
    """sp, ge: (mjd, ra, dec, delta, mag) rows NEOSSat-centred / geocentric at mid-exposure."""
    data, hdr, w, mid = load(image)
    bg, sig = background(data)
    res = data - bg
    exptime = float(hdr.get("EXPOSURE", 0))
    c_ra, c_dec = w.all_pix2world([[data.shape[1] / 2, data.shape[0] / 2]], 0)[0]
    gaia = gaia_cone(float(c_ra), float(c_dec))
    stars = detect(res, sig)
    nw, st = fit_wcs(w, stars, gaia, data.shape)
    zp, nzp = zero_point(res, stars, st, exptime, sat=np.nanpercentile(data, 99.995))
    out = dict(image=image, mjd=mid, exptime_s=exptime, mode=str(hdr.get("MODE", "")), object=str(hdr.get("OBJECT", "")),
               moving=str(hdr.get("MOVING", "")), sky_sigma=float(sig), wcs=st | dict(match_star_idx=None, match_gmag=None),
               zp_G=zp, n_zp=nzp, ra_neossat=float(sp[1]), dec_neossat=float(sp[2]), ra_geo=float(ge[1]), dec_geo=float(ge[2]),
               delta_au=float(sp[3]), horizons_mag=None if np.isnan(sp[4]) else float(sp[4]))
    for tag, ww in (("raw", w), ("fit", nw)):
        px_s = np.array(ww.all_world2pix([[sp[1], sp[2]]], 0)[0])
        px_g = np.array(ww.all_world2pix([[ge[1], ge[2]]], 0)[0])
        out[f"px_neossat_{tag}"] = px_s.tolist()
        out[f"px_geo_{tag}"] = px_g.tolist()
    out["neossat_minus_geo_px"] = float(np.hypot(*(np.array(out["px_neossat_fit"]) - out["px_geo_fit"])))
    cx, cy, pk = centroid(res, *out["px_neossat_fit"])
    out["centroid_px"] = [cx, cy]
    out["peak_over_sigma"] = pk / sig if np.isfinite(pk) else np.nan
    for tag in ("raw", "fit"):
        out[f"off_neossat_{tag}_px"] = float(np.hypot(cx - out[f"px_neossat_{tag}"][0], cy - out[f"px_neossat_{tag}"][1]))
        out[f"off_geo_{tag}_px"] = float(np.hypot(cx - out[f"px_geo_{tag}"][0], cy - out[f"px_geo_{tag}"][1]))
    out["wcs_fit"] = dict(crpix=list(map(float, nw.wcs.crpix)), cd=nw.wcs.cd.tolist() if nw.wcs.has_cd() else None,
                          crval=list(map(float, nw.wcs.crval)))
    return out


def ephemerides(cmd, mjds):
    sp = horizons_ephemeris(cmd, tlist=list(mjds), center=NEOSSAT)
    ge = horizons_ephemeris(cmd, tlist=list(mjds), center=GEO)
    for t, a, b in zip(mjds, sp, ge):
        assert abs(a[0] - t) * 86400 < 1 and abs(b[0] - t) * 86400 < 1, (t, a[0], b[0])
    return sp, ge


def run(slug, cmd, images, threads=4):
    t0 = time.time()
    mids = [load(n)[3] for n in images]
    sp, ge = ephemerides(cmd, mids)
    t1 = time.time()
    with ThreadPoolExecutor(threads) as pool:
        rows = list(pool.map(lambda a: _safe(*a), zip(images, sp, ge)))
    rows = [r for r in rows if r]
    (OUT / f"{slug}_positions.json").write_text(json.dumps(rows, indent=1, default=float))
    print(f"{slug}: {len(rows)}/{len(images)} images analysed (Horizons {t1 - t0:.0f} s, images {time.time() - t1:.0f} s)")
    report(rows)
    return rows


def _safe(image, sp, ge):
    try:
        return analyse(image, sp, ge)
    except Exception as e:
        print("  FAIL", image, repr(e)[:200])
        return None


def report(rows):
    ok = [r for r in rows if r["wcs"].get("ok")]
    f = lambda a: f"median {np.nanmedian(a):.2f}, 90% {np.nanpercentile(a, 90):.2f}, max {np.nanmax(a):.2f}" if len(a) else "n/a"
    print(f"  WCS fit ok in {len(ok)}/{len(rows)}; header WCS error (median per image) {f([r['wcs']['raw_median_px'] for r in ok])} px; "
          f"after fit rms {f([r['wcs']['rms_px'] for r in ok])} px; matches {f([r['wcs']['n_match'] for r in ok])}")
    print(f"  pixel scale {f([r['wcs']['pix_arcsec'] for r in ok])} arcsec; ZP(G) {f([r['zp_G'] for r in rows])} (n stars {f([r['n_zp'] for r in rows])})")
    print(f"  NEOSSat-centred vs geocentric: {f([r['neossat_minus_geo_px'] for r in rows])} px")
    det = [r for r in rows if np.isfinite(r["peak_over_sigma"]) and r["peak_over_sigma"] > 5]
    print(f"  object detected (peak > 5 sigma) in {len(det)}/{len(rows)}")
    for k in ("off_neossat_fit_px", "off_geo_fit_px", "off_neossat_raw_px"):
        print(f"    centroid - prediction [{k}]: {f([r[k] for r in det])}")


if __name__ == "__main__":
    from pipeline.movers.find_movers import CANDIDATES
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--cmd", default=None)
    a = ap.parse_args()
    sel = json.loads((OUT / f"{a.slug}_selection.json").read_text())
    names = [im["image"] for im in sel["images"] if path_of(im["image"]).exists()]
    if a.limit:
        names = [names[i] for i in np.unique(np.linspace(0, len(names) - 1, a.limit).round().astype(int))]
    run(a.slug, a.cmd or CANDIDATES[a.slug]["cmd"], names)
