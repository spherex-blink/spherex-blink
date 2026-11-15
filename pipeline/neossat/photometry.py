"""Step 6: visible (NEOSSat) and infrared (SPHEREx) light curves of a moving object.

    .venv/Scripts/python -m pipeline.neossat.photometry 3i-atlas

NEOSSat: aperture sums on the ORIGINAL pixels at the NEOSSat-centred predicted position (Gaia-refitted WCS; measured to be
0.4 px from the comet's centroid), radii 5", 10", 20", sky annulus 40"-60" (3-sigma clipped median), counts/s, and a
magnitude on the Gaia G scale from each image's own zero point (positions.py: G = ZP - 2.5 log10(counts/s) for field stars).
A comet is extended, so aperture magnitudes are NOT total magnitudes; they grow brighter with radius.
Frames with a Gaia star (G < 16) within 25" of the comet are flagged `star_nearby` (contaminated).
SPHEREx: pipeline.photometry._one (the same aperture() code as the star light curves) at the SPHEREx-centred positions from
web/lib/spherex/movers/<slug>.json, radii 2 px (12.3") and 3.25 px (20"), annulus 6-10 px; flux in mJy + wavelength.
Writes data/neossat/<slug>_photometry.json.  Written with Claude Code.
"""
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests

from pipeline.neossat.cutouts import fitted_wcs
from pipeline.neossat.positions import ap_sum, background, gaia_cone, load
from pipeline.neossat.ssois import OUT

NEO_PIX = 3.0
RADII_ARCSEC = (5.0, 10.0, 20.0)
ANN_ARCSEC = (40.0, 60.0)
GAIN = 1.10                     # e-/ADU (header GAIN)
SX_PIX = 6.15
SX_RADII_PX = (2.0, 3.25)


def neossat_point(row):
    data, hdr, w0, mid = load(row["image"])
    bg, sig = background(data)
    res = data - bg
    w = fitted_wcs(row, w0)
    x, y = (float(v) for v in w.all_world2pix([[row["ra_neossat"], row["dec_neossat"]]], 0)[0])
    t = row["exptime_s"]
    out = dict(image=row["image"], mjd=round(row["mjd"], 6), exptime_s=t, zp_G=row["zp_G"], n_zp=row["n_zp"],
               delta_au=row["delta_au"], horizons_Tmag=row["horizons_mag"], x=x, y=y)
    for r in RADII_ARCSEC:
        s, e_sky, _ = ap_sum(res, x, y, r / NEO_PIX, ANN_ARCSEC[0] / NEO_PIX, ANN_ARCSEC[1] / NEO_PIX)
        e = float(np.sqrt(e_sky ** 2 + max(s, 0) / GAIN)) if np.isfinite(s) else np.nan
        k = f"{int(r)}"
        out[f"cps_{k}"] = s / t if np.isfinite(s) else None
        out[f"cps_err_{k}"] = e / t if np.isfinite(e) else None
        ok = np.isfinite(s) and s > 0 and np.isfinite(row["zp_G"])
        out[f"mag_{k}"] = round(row["zp_G"] - 2.5 * np.log10(s / t), 3) if ok else None
        out[f"mag_err_{k}"] = round(1.0857 * e / s, 3) if ok else None
        out[f"snr_{k}"] = round(s / e, 1) if np.isfinite(s) and e > 0 else None
    g = gaia_cone(*(float(v) for v in w0.all_pix2world([[data.shape[1] / 2, data.shape[0] / 2]], 0)[0]))
    d = np.hypot((g[:, 0] - row["ra_neossat"]) * np.cos(np.radians(row["dec_neossat"])), g[:, 1] - row["dec_neossat"]) * 3600
    near = (d < 25) & (g[:, 2] < 16)
    out["star_nearby"] = bool(near.any())
    out["star_nearby_G"] = round(float(g[near, 2].min()), 2) if near.any() else None
    out["valid"] = bool(row["wcs"].get("ok") and np.isfinite(row["zp_G"]) and out["mag_10"] is not None
                        and (out["snr_10"] or 0) >= 5)
    return out


def neossat_lightcurve(slug, threads=4):
    rows = [r for r in json.loads((OUT / f"{slug}_positions.json").read_text()) if r["wcs"].get("ok")]
    with ThreadPoolExecutor(threads) as pool:
        pts = list(pool.map(neossat_point, rows))
    return sorted(pts, key=lambda p: p["mjd"])


def spherex_lightcurve(slug, threads=24):
    from pipeline.photometry import _one
    mover = json.load(open(f"web/lib/spherex/movers/{slug}.json"))
    sess = requests.Session()
    sess.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=threads))
    half = 12

    def one(e):
        out = dict(key=e["key"], det=e["det"], mjd=e["mjd"], delta_au=e["delta_au"])
        for r in SX_RADII_PX:
            try:
                p = _one({"key": e["key"], "obs": e["obs"]}, e["ra"], e["dec"], None, half, sess, r, 6.0, 10.0)
            except Exception as err:
                out["error"] = repr(err)[:120]
                return out
            if p is None:
                out["error"] = "near detector edge"
                return out
            k = f"{round(r * SX_PIX)}"
            out[f"flux_mJy_{k}"] = round(p["flux_mJy"], 5)
            out[f"err_mJy_{k}"] = round(p["err_mJy"], 5)
            out[f"valid_{k}"] = bool(p["valid"])
            out["lambda_um"] = round(p["lambda_um"], 4)
            out["sub"] = p["sub"]
        return out

    with ThreadPoolExecutor(threads) as pool:
        pts = list(pool.map(one, mover["exposures"]))
    return sorted(pts, key=lambda p: (p["mjd"], p["det"]))


def main(slug):
    t0 = time.time()
    neo = neossat_lightcurve(slug)
    t1 = time.time()
    sx = spherex_lightcurve(slug)
    t2 = time.time()
    (OUT / f"{slug}_photometry.json").write_text(json.dumps(dict(neossat=neo, spherex=sx), indent=1, default=float))
    v = [p for p in neo if p["valid"]]
    print(f"NEOSSat: {len(neo)} images, {len(v)} valid (S/N10 >= 5), {sum(p['star_nearby'] for p in v)} of them with a star within 25\" "
          f"({t1 - t0:.0f} s)")
    for p in neo:
        print(f"  {p['image'][9:23]} {p['mjd']:.2f} m5 {p['mag_5']} m10 {p['mag_10']}±{p['mag_err_10']} m20 {p['mag_20']} "
              f"snr10 {p['snr_10']} T {p['horizons_Tmag']} star {p['star_nearby_G']} valid {p['valid']}")
    ok = [p for p in sx if "error" not in p]
    print(f"SPHEREx: {len(sx)} exposures, {len(ok)} measured, {sum(p.get('valid_20', False) for p in ok)} valid at 20\" ({t2 - t1:.0f} s)")
    for p in ok[:: max(1, len(ok) // 25)]:
        print(f"  {p['mjd']:.3f} D{p['det']} {p['lambda_um']:.3f} um  f12 {p.get('flux_mJy_12')}±{p.get('err_mJy_12')}  "
              f"f20 {p.get('flux_mJy_20')}±{p.get('err_mJy_20')} valid {p.get('valid_20')}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "3i-atlas")
