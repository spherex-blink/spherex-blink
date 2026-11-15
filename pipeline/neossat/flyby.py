"""Fly-by videos: the sky stays still, the comet moves across it.

    .venv/Scripts/python -m pipeline.neossat.flyby neossat     # one NEOSSat sequence (27 Nov 2025, 70 frames in ~1 h)
    .venv/Scripts/python -m pipeline.neossat.flyby spherex     # SPHEREx's longest run of 3I (one detector)

Every frame is reprojected onto ONE fixed north-up grid that covers the whole path (NEOSSat: Gaia-refitted WCS per frame, so stars
line up to ~0.2 px; SPHEREx: the library's WCS). Writes web/lib/spherex/neossat/3i-atlas-flyby.json:
{neossat: {n, pix_arcsec, center, frames: [{mjd, date_time, exptime_s, data_b64_f32le, targetPx}], path, motion_arcsec, duration_min, ...},
 spherex: {...same...}}.  Written with Claude Code.
"""
import json
import sys
import warnings
from pathlib import Path

import numpy as np
from astropy.coordinates import SkyCoord
import astropy.units as u
from reproject import reproject_interp

from pipeline.neossat.cutouts import fitted_wcs, grid
from pipeline.neossat.positions import background, load
from pipeline.neossat.publish import b64, iso, r as rnd

warnings.simplefilter("ignore")
OUT = Path("web/lib/spherex/neossat/3i-atlas-flyby.json")
CMD = "DES=C/2025 N1;"


def _mid(ras, decs):
    v = np.stack([np.cos(np.radians(decs)) * np.cos(np.radians(ras)), np.cos(np.radians(decs)) * np.sin(np.radians(ras)),
                  np.sin(np.radians(decs))]).mean(axis=1)
    v /= np.linalg.norm(v)
    return float(np.degrees(np.arctan2(v[1], v[0])) % 360), float(np.degrees(np.arcsin(v[2])))


def neossat(max_frames=40, margin_px=22):
    from pipeline.neossat import positions as P
    names = json.loads(Path("data/neossat/3i-atlas_flyby_images.json").read_text())
    pf = Path("data/neossat/3i-atlas-flyby_positions.json")
    rows = json.loads(pf.read_text()) if pf.exists() else P.run("3i-atlas-flyby", CMD, names)
    rows = sorted([r for r in rows if r["wcs"].get("ok") and r["wcs"]["rms_px"] < 0.6], key=lambda r: r["mjd"])
    if len(rows) > max_frames:
        rows = [rows[i] for i in np.unique(np.linspace(0, len(rows) - 1, max_frames).round().astype(int))]
    ras, decs = np.array([r["ra_neossat"] for r in rows]), np.array([r["dec_neossat"] for r in rows])
    cra, cdec = _mid(ras, decs)
    c = SkyCoord(cra * u.deg, cdec * u.deg)
    span = max(c.separation(SkyCoord(a * u.deg, d * u.deg)).arcsec for a, d in zip(ras, decs)) / 3.0
    half = int(np.ceil(span + margin_px))
    n = 2 * half + 1
    g = grid(cra, cdec, n, 3.0)
    frames = []
    for row in rows:
        data, hdr, w0, _ = load(row["image"])
        bg, _ = background(data)
        res, w = data - bg, fitted_wcs(row, w0)
        x, y = (float(v) for v in w.all_world2pix([[cra, cdec]], 0)[0])
        m = half + 12
        xi, yi = int(round(x)), int(round(y))
        y0, y1, x0, x1 = max(0, yi - m), min(res.shape[0], yi + m + 1), max(0, xi - m), min(res.shape[1], xi + m + 1)
        img, foot = reproject_interp((res[y0:y1, x0:x1], w.slice((slice(y0, y1), slice(x0, x1)))), g, shape_out=(n, n), order="bilinear")
        img[foot == 0] = np.nan
        tx, ty = (float(v) for v in g.all_world2pix([[row["ra_neossat"], row["dec_neossat"]]], 0)[0])
        frames.append(dict(mjd=rnd(row["mjd"], 6), date_time=iso(row["mjd"]), exptime_s=rnd(row["exptime_s"], 2), image=row["image"],
                           data_b64_f32le=b64(img.astype(np.float32)), targetPx=[rnd(tx, 2), rnd(ty, 2)]))
    dur = (rows[-1]["mjd"] - rows[0]["mjd"]) * 1440
    mot = SkyCoord(ras[0] * u.deg, decs[0] * u.deg).separation(SkyCoord(ras[-1] * u.deg, decs[-1] * u.deg)).arcsec
    det = [r for r in rows if r["peak_over_sigma"] > 5]
    out = dict(telescope="NEOSSat (CSA)", band="visible (CLEAR, 0.4-0.9 um)", n=n, pix_arcsec=3.0, center=[cra, cdec],
               date=iso(rows[0]["mjd"])[:10], duration_min=rnd(dur, 1), motion_arcsec=rnd(mot, 1), n_frames=len(frames),
               n_in_sequence=len(names), wcs_rms_px_median=rnd(np.median([r["wcs"]["rms_px"] for r in rows]), 3),
               centroid_offset_px_median=rnd(np.median([r["off_neossat_fit_px"] for r in det]), 3) if det else None,
               path=[f["targetPx"] for f in frames], frames=frames)
    print(f"NEOSSat fly-by {out['date']}: {len(frames)} frames over {dur:.0f} min, comet moves {mot:.0f}\" ({mot / 3:.0f} px), "
          f"grid {n} px = {n * 3 / 60:.1f}', WCS rms {out['wcs_rms_px_median']} px, comet {out['centroid_offset_px_median']} px from prediction")
    return out


def spherex(max_frames=40, det=None):
    from pipeline.movers.mover_video import mover_video
    mover = json.load(open("web/lib/spherex/movers/3i-atlas.json"))
    ex = mover["exposures"]
    # the longest run (<= 12 h gaps), one detector so the star field looks the same in every frame
    ex = sorted(ex, key=lambda e: e["mjd"])
    runs, cur = [], [ex[0]]
    for e in ex[1:]:
        if (e["mjd"] - cur[-1]["mjd"]) * 24 <= 12:
            cur.append(e)
        else:
            runs.append(cur); cur = [e]
    runs.append(cur)
    best = max(runs, key=len)
    counts = {d: sum(e["det"] == d for e in best) for d in range(1, 7)}
    det = det or max(counts, key=counts.get)
    sel = [e for e in best if e["det"] == det]
    # grid big enough for the whole path (+15 px margin), then 3x3 binning (18.45"/px) to keep the file small
    c = SkyCoord(*_mid(np.array([e["ra"] for e in sel]), np.array([e["dec"] for e in sel])), unit="deg")
    span = max(c.separation(SkyCoord(e["ra"] * u.deg, e["dec"] * u.deg)).arcsec for e in sel) / 6.15
    half = int(np.ceil(span)) + 15
    res = mover_video(dict(mover, exposures=sel), mode="flyby", span="run", max_frames=max_frames, half=half)
    B = 3
    n = res["n"] // B
    n0 = n * B

    def bin2(a):
        a = a[:n0, :n0].reshape(n, B, n, B)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return np.nanmean(a, axis=(1, 3)).astype(np.float32)
    frames = [dict(mjd=f["mjd"], date_time=iso(f["mjd"]), det=f["det"], key=f["key"], data_b64_f32le=b64(bin2(f["image"])),
                   targetPx=[rnd((f["target_px"][0] + 0.5) / B - 0.5, 2), rnd((f["target_px"][1] + 0.5) / B - 0.5, 2)]) for f in res["frames"]]
    p0, p1 = frames[0]["targetPx"], frames[-1]["targetPx"]
    mot = np.hypot(p1[0] - p0[0], p1[1] - p0[1]) * 6.15 * B
    dur = (frames[-1]["mjd"] - frames[0]["mjd"]) * 24
    out = dict(telescope="SPHEREx (NASA)", band=f"infrared, detector D{det}", det=det, n=n, pix_arcsec=6.15 * B, binned=f"{B}x{B} from 6.15\"", center=list(res["center"]),
               date=frames[0]["date_time"][:10], duration_h=rnd(dur, 1), motion_arcsec=rnd(mot, 1), n_frames=len(frames),
               detector_counts=counts, path=[f["targetPx"] for f in frames], frames=frames)
    print(f"SPHEREx fly-by {out['date']}: D{det}, {len(frames)} frames over {dur:.1f} h, comet moves {mot:.0f}\" ({mot / 6.15:.0f} px), "
          f"grid {n} px = {n * 6.15 / 60:.1f}' (detectors in run {counts})")
    return out


CREDIT = ("NEOSSat data courtesy of the Canadian Space Agency (CSA), via CADC (NRC Canada). Contains information licensed under "
                     "the Open Government Licence - Canada. SPHEREx: NASA/JPL-Caltech/IPAC (IRSA). Positions: JPL Horizons; astrometry: ESA Gaia DR3.")


if __name__ == "__main__":
    for which in (sys.argv[1:] or ["neossat", "spherex"]):
        out = OUT.with_name(f"3i-atlas-flyby-{which}.json")
        doc = neossat() if which == "neossat" else spherex()
        doc["credit"] = CREDIT
        out.write_text(json.dumps(doc, separators=(",", ":")))
        print(f"{out}: {out.stat().st_size / 1e6:.2f} MB")

