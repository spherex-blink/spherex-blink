"""Per-image photometry of one star across SPHEREx: the input for light curves and spectra ("spectra on the fly").

    from pipeline.photometry import measure
    pts = measure(76.95653, 30.40144)          # RW Aur: one dict per SPHEREx image of it

For every image: the star's position at that image's time (proper motion), its raw-pixel position (full SIP WCS),
an aperture sum on the ORIGINAL pixels (no resampling) minus a sigma-clipped sky annulus, converted to mJy with the
image's pixel solid angle, an uncertainty from the sky scatter, the wavelength at the star (WCS-WAVE), its SPHEREx
channel (1 of 102), and validity flags (any NaN in the aperture = saturated core or bad pixel -> not valid).
Written with Claude Code.
"""
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS

from pipeline.index.headers import _get, _split_headers
from pipeline.index.lookup import SkyIndex, point_in_footprint
from pipeline.quickblink import position_at

SR_PER_ARCSEC2 = 1 / 206264.806 ** 2
CALIB = Path("web/lib/spherex/calib")
_CH = json.loads((CALIB / "channels.json").read_text())["channels"]


def _wave_tables():
    t = {}
    for det in range(1, 7):
        d = json.loads((CALIB / f"wcs_wave_D{det}.json").read_text())
        nx, ny = len(d["X"]), len(d["Y"])
        v = np.array([d["VALUES"]], dtype="f4")
        cols = [fits.Column(name="X", format=f"{nx}J", array=np.array([d["X"]])),
                fits.Column(name="Y", format=f"{ny}J", array=np.array([d["Y"]])),
                fits.Column(name="VALUES", format=f"{v[0].size}E", dim=f"(2,{nx},{ny})", array=v)]
        t[det] = fits.BinTableHDU.from_columns(cols, name="WCS-WAVE")
    return t


_TABLES = _wave_tables()


def channel_of(det, lam):
    """SPHEREx channel (det, sub 1..17) whose [wl_min, wl_max) contains lam; nearest centre otherwise."""
    cands = [c for c in _CH if c["det"] == det]
    for c in cands:
        if c["wl_min"] <= lam < c["wl_max"]:
            return c["sub"]
    return min(cands, key=lambda c: abs(c["wl"] - lam))["sub"]


def aperture(img, x, y, r_ap=2.0, r_in=5.0, r_out=9.0, sub=5, r_ap_in=0.0):
    """Aperture sum around (x, y) (0-based, pixel centres at integers) with sub-pixel sampling, minus the
    3-sigma-clipped median of the annulus. r_ap_in > 0 makes the aperture a RING (r_ap_in..r_ap): "wing photometry"
    for saturated stars, whose blank (NaN) core must lie inside r_ap_in.
    Returns (sum, sky_per_px, sky_sigma, n_ap_px, any_nan_in_aperture)."""
    h, w = img.shape
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.hypot(xx - x, yy - y)
    ann = img[(d >= r_in) & (d <= r_out)]
    ann = ann[np.isfinite(ann)]
    if ann.size < 10:
        return np.nan, np.nan, np.nan, 0, True
    med = np.median(ann)
    for _ in range(3):
        sig = 1.4826 * np.median(np.abs(ann - med))
        keep = np.abs(ann - med) <= 3 * sig if sig > 0 else np.ones_like(ann, bool)
        med = np.median(ann[keep])
    sig = 1.4826 * np.median(np.abs(ann[keep] - med))
    # fractional pixel weights from sub-sampling
    o = (np.arange(sub) + 0.5) / sub - 0.5
    ox, oy = np.meshgrid(o, o)
    near = d <= r_ap + 1
    wts = np.zeros_like(img, dtype=float)
    for j, i in zip(*np.nonzero(near)):
        rr = np.hypot(i + ox - x, j + oy - y)
        wts[j, i] = np.mean((rr <= r_ap) & (rr >= r_ap_in))
    inside = wts > 0
    bad = bool(np.isnan(img[inside]).any())
    s = float(np.nansum((img[inside] - med) * wts[inside]))
    return s, float(med), float(sig), float(wts.sum()), bad


def _one(row, ra, dec, pm, half, session, r_ap, r_in, r_out, r_ap_in=0.0):
    buf = _get(row["key"], 0, 40959, session)
    res = _split_headers(buf)
    if res is None:
        buf = _get(row["key"], 0, 81919, session); res = _split_headers(buf)
    (prim, hdr), datloc = res
    mjd = hdr["MJD-AVG"]
    pra, pdec = position_at(ra, dec, pm, mjd)
    w = WCS(hdr)                                     # full SIP from the real header
    x, y = (float(v[0]) for v in w.all_world2pix([pra], [pdec], 0))
    n1, n2 = hdr["NAXIS1"], hdr["NAXIS2"]
    xi, yi = int(round(x)), int(round(y))
    if not (half <= xi < n1 - half and half <= yi < n2 - half):
        return None                                  # too close to the detector edge for the sky annulus
    y0, y1 = yi - half, yi + half + 1
    raw = _get(row["key"], datloc + y0 * n1 * 4, datloc + y1 * n1 * 4 - 1, session)
    img = np.frombuffer(raw, ">f4").reshape(y1 - y0, n1)[:, xi - half:xi + half + 1].astype(float)
    s, sky, sig, nap, bad = aperture(img, x - (xi - half), y - y0, r_ap, r_in, r_out, r_ap_in=r_ap_in)
    core = img[max(0, yi - y0 - 12):yi - y0 + 13, max(0, xi - (xi - half) - 12):xi - (xi - half) + 13]
    yy, xx = np.nonzero(np.isnan(core))
    nan_r = float(np.hypot(xx + max(0, xi - (xi - half) - 12) - (x - (xi - half)), yy + max(0, yi - y0 - 12) - (y - y0)).max()) if len(xx) else 0.0
    omega_sr = hdr["OMEGA_MEDIAN"] * SR_PER_ARCSEC2
    to_mjy = omega_sr * 1e9                          # MJy/sr * sr -> MJy -> mJy
    hl = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(header=hdr), _TABLES[hdr["DETECTOR"]]])
    ww = WCS(hdr, fobj=hl, key="W"); ww.sip = None
    lam, dlam = (float(q.to("um").value) for q in ww.pixel_to_world(x, y))
    det = int(hdr["DETECTOR"])
    return {"obs": row["obs"], "key": row["key"], "det": det, "mjd": float(mjd), "lambda_um": lam, "dlambda_um": dlam,
            "sub": channel_of(det, lam), "x": x, "y": y,
            "flux_mJy": s * to_mjy, "err_mJy": sig * np.sqrt(nap) * to_mjy if np.isfinite(sig) else np.nan,
            "sky_MJysr": sky, "valid": (not bad) and np.isfinite(s), "nan_in_aperture": bad, "nan_radius_px": nan_r}


def measure(ra, dec, pm=None, detectors=None, max_exposures=None, index=None, threads=24,
            r_ap=2.0, r_in=5.0, r_out=9.0, r_ap_in=0.0):
    """Photometry of one star in every SPHEREx image containing it (optionally only some detectors / thinned)."""
    t0 = time.time()
    idx = index or SkyIndex()
    rows, seen = [], set()
    for m in ((60790, 61050, 61320) if pm else (61050,)):
        pra, pdec = position_at(ra, dec, pm, m)
        for r in idx.covering(pra, pdec):
            if r["key"] not in seen:
                seen.add(r["key"]); rows.append(r)
    if pm:
        rows = [r for r in rows if point_in_footprint(*position_at(ra, dec, pm, r["t"]), r["corners"])]
    if detectors:
        rows = [r for r in rows if r["det"] in detectors]
    rows.sort(key=lambda r: r["t"])
    if max_exposures and len(rows) > max_exposures:
        rows = [rows[i] for i in np.unique(np.linspace(0, len(rows) - 1, max_exposures).round().astype(int))]
    sess = requests.Session()
    sess.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=threads))
    half = int(np.ceil(r_out)) + 2
    with ThreadPoolExecutor(threads) as pool:
        out = [p for p in pool.map(lambda r: _one(r, ra, dec, pm, half, sess, r_ap, r_in, r_out, r_ap_in), rows) if p]
    out.sort(key=lambda p: (p["mjd"], p["det"]))
    return {"points": out, "n_images": len(rows), "seconds": time.time() - t0,
            "aperture": {"r_ap_px": r_ap, "r_ap_in_px": r_ap_in, "r_in_px": r_in, "r_out_px": r_out}}
