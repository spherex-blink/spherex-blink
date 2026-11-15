"""Visual + numeric check of a mover's best burst: frames on ONE fixed sky grid (fly-by view), predicted position marked,
measured centroid vs prediction. Usage: .venv/Scripts/python -m pipeline.movers.burst_sheet out.png slug [slug ...]
Written with Claude Code.
"""
import json
import sys
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from astropy.coordinates import SkyCoord
import astropy.units as u
from reproject import reproject_interp

from pipeline.index.headers import fetch_header_facts, wcs_from_facts, cutout
from pipeline.quickblink import target_grid

warnings.simplefilter("ignore")


def best_burst(exps, gap_min=6.0):
    exps = sorted(exps, key=lambda e: e["mjd_mid"])
    runs, cur = [], [exps[0]]
    for e in exps[1:]:
        if (e["mjd_mid"] - cur[-1]["mjd_mid"]) * 1440 <= gap_min:
            cur.append(e)
        else:
            runs.append(cur); cur = [e]
    runs.append(cur)
    return max(runs, key=len)


def burst_frames(mover, max_frames=10):
    b = best_burst(mover["exposures"])[:max_frames]
    ras, decs = np.array([e["ra_obj"] for e in b]), np.array([e["dec_obj"] for e in b])
    c = SkyCoord(np.median(ras) * u.deg, np.median(decs) * u.deg)
    span = max(c.separation(SkyCoord(r * u.deg, d * u.deg)).arcsec for r, d in zip(ras, decs)) / 6.15
    half = int(min(150, max(20, span + 15)))
    grid = target_grid(c.ra.deg, c.dec.deg, 2 * half + 1)

    def one(e):
        f = fetch_header_facts(e["key"])
        cut = cutout(e["key"], f, e["ra_obj"], e["dec_obj"], half=half + 8)
        if cut is None:
            return None
        data, (x0, y0) = cut
        w = wcs_from_facts(f).slice((slice(y0, y0 + data.shape[0]), slice(x0, x0 + data.shape[1])))
        img, _ = reproject_interp((data, w), grid, shape_out=(2 * half + 1, 2 * half + 1))
        px, py = grid.world_to_pixel(SkyCoord(e["ra_obj"] * u.deg, e["dec_obj"] * u.deg))
        return dict(e, image=img - np.nanmedian(img), px=float(px), py=float(py))

    with ThreadPoolExecutor(10) as pool:
        fr = [x for x in pool.map(one, b) if x is not None]
    return fr, half


def centroid_near(img, px, py, r=4):
    xi, yi = int(round(px)), int(round(py))
    sub = img[yi - r:yi + r + 1, xi - r:xi + r + 1]
    if sub.size == 0 or np.all(np.isnan(sub)):
        return np.nan, np.nan, np.nan
    s = np.nan_to_num(sub); j, i = np.unravel_index(np.argmax(s), s.shape)
    j0, j1, i0, i1 = max(0, j - 1), min(s.shape[0], j + 2), max(0, i - 1), min(s.shape[1], i + 2)
    win = s[j0:j1, i0:i1]; win = win - win.min() + 1e-12
    yy, xx = np.mgrid[j0:j1, i0:i1]
    cx, cy = (xx * win).sum() / win.sum(), (yy * win).sum() / win.sum()
    noise = np.nanmedian(np.abs(img - np.nanmedian(img))) * 1.4826
    return xi - r + cx, yi - r + cy, float(s[j, i] / noise)


def main(out, slugs):
    rows = []
    for slug in slugs:
        mover = json.load(open(f"data/movers/{slug}.json"))
        fr, half = burst_frames(mover)
        rows.append((mover["name"], fr, half))
        offs = []
        for f in fr:
            cx, cy, peak = centroid_near(f["image"], f["px"], f["py"])
            offs.append((np.hypot(cx - f["px"], cy - f["py"]), peak, f["det"]))
        # D1/D4, D2/D5, D3/D6 are exposed at the same instant: measure motion between DISTINCT times only
        uniq = [f for k, f in enumerate(fr) if k == 0 or abs(f["mjd_mid"] - fr[k - 1]["mjd_mid"]) * 86400 > 10]
        step = [np.hypot(uniq[k + 1]["px"] - uniq[k]["px"], uniq[k + 1]["py"] - uniq[k]["py"]) for k in range(len(uniq) - 1)]
        print(f"{mover['name']:22s} burst {len(fr)} frames, field {2*half+1}px, moves {np.median(step) if step else 0:.1f} px/frame; "
              f"offset measured-predicted px: {[round(o[0], 2) for o in offs]}; peak S/N: {[round(o[1], 1) for o in offs]}; dets {[o[2] for o in offs]}")
    ncol = max(len(r[1]) for r in rows)
    fig, ax = plt.subplots(len(rows), ncol, figsize=(1.9 * ncol, 2.1 * len(rows)), squeeze=False)
    for k, (name, fr, half) in enumerate(rows):
        for j in range(ncol):
            a = ax[k, j]; a.set_xticks([]); a.set_yticks([])
            if j >= len(fr):
                a.axis("off"); continue
            im = fr[j]["image"]; s = np.nanmedian(np.abs(im - np.nanmedian(im))) * 1.4826
            a.imshow(im, origin="lower", cmap="gray", vmin=-2 * s, vmax=10 * s, interpolation="nearest")
            a.plot([f["px"] for f in fr], [f["py"] for f in fr], "-", color="#ff7f0e", lw=0.6)
            a.plot(fr[j]["px"], fr[j]["py"], "o", mfc="none", mec="#4fc3f7", ms=9, mew=0.8)
            a.set_title(f"{name[:14]} D{fr[j]['det']}\n+{(fr[j]['mjd_mid'] - fr[0]['mjd_mid']) * 1440:.0f} min", fontsize=6)
    plt.tight_layout(); plt.savefig(out, dpi=75)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
