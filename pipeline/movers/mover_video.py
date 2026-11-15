"""Reference for the browser's mover video: frames of a Solar System object across consecutive SPHEREx exposures.

    from pipeline.movers.mover_video import mover_video
    r = mover_video(json.load(open("web/lib/spherex/movers/162882.json")), mode="flyby", span="burst")

span: "burst" = longest sequence with <= 6 min between exposures (minutes; a fast NEO crosses the frame),
      "run"   = longest sequence with <= 12 h between exposures (hours to days; slow objects show motion),
      "all"   = ALL exposures of the object over the whole survey (months), sorted by (mjd, det), evenly thinned;
                the default mode is then "follow" (a fly-by grid over months would be degrees wide).
mode: None = "flyby" (or "follow" for span "all");
      "flyby"  = one fixed sky grid covering the whole path (stars fixed, the object moves),
      "follow" = each frame centred on the object's position (object fixed, stars stream past).
Frames: each exposure minus its own median; positions are SPHEREx-centred (from the mover file).
Written with Claude Code.
"""
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from astropy.coordinates import SkyCoord
import astropy.units as u
from reproject import reproject_interp

from pipeline.index.headers import fetch_header_facts, wcs_from_facts, cutout
from pipeline.quickblink import target_grid

GAPS_MIN = {"burst": 6.0, "run": 12 * 60.0, "all": None}


def select(exposures, span="burst", max_frames=60):
    ex = sorted(exposures, key=lambda e: (e["mjd"], e["det"]))
    if span == "all":
        best = ex
        if len(best) > max_frames:
            best = [best[i] for i in np.unique(np.linspace(0, len(best) - 1, max_frames).round().astype(int))]
        return best
    runs, cur = [], [ex[0]]
    for e in ex[1:]:
        if (e["mjd"] - cur[-1]["mjd"]) * 1440 <= GAPS_MIN[span]:
            cur.append(e)
        else:
            runs.append(cur); cur = [e]
    runs.append(cur)
    best = max(runs, key=len)                      # first longest (stable)
    if len(best) > max_frames:
        best = [best[i] for i in np.unique(np.linspace(0, len(best) - 1, max_frames).round().astype(int))]
    return best


def mover_video(mover, mode=None, span="burst", max_frames=60, half=None, threads=16):
    if mode is None:
        mode = "follow" if span == "all" else "flyby"
    tm = {}; t0 = time.time()
    sel = select(mover["exposures"], span, max_frames)
    ras, decs = np.array([e["ra"] for e in sel]), np.array([e["dec"] for e in sel])
    # centre of the path = middle of the great-circle extent (median of unit vectors)
    v = np.stack([np.cos(np.radians(decs)) * np.cos(np.radians(ras)), np.cos(np.radians(decs)) * np.sin(np.radians(ras)), np.sin(np.radians(decs))])
    m = np.median(v, axis=1); m /= np.linalg.norm(m)
    c = SkyCoord(np.degrees(np.arctan2(m[1], m[0])) % 360 * u.deg, np.degrees(np.arcsin(m[2])) * u.deg)
    if half is None:
        if mode == "flyby":
            span_px = max(c.separation(SkyCoord(r * u.deg, d * u.deg)).arcsec for r, d in zip(ras, decs)) / 6.15
            half = int(min(150, max(20, np.ceil(span_px) + 15)))
        else:
            half = 30
    n = 2 * half + 1
    fixed = target_grid(c.ra.deg, c.dec.deg, n) if mode == "flyby" else None
    sess = requests.Session(); sess.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=threads))

    def one(e):
        f = fetch_header_facts(e["key"], session=sess)
        # flyby: cut around the grid centre (so the whole grid is covered); follow: around the object
        cra, cdec = (c.ra.deg, c.dec.deg) if mode == "flyby" else (e["ra"], e["dec"])
        return e, f, cutout(e["key"], f, cra, cdec, half=half + 8, session=sess)

    t1 = time.time()
    with ThreadPoolExecutor(threads) as pool:
        got = list(pool.map(one, sel))
    tm["fetch_s"] = time.time() - t1
    frames = []
    for e, f, cut in got:
        if cut is None:
            continue
        data, (x0, y0) = cut
        w = wcs_from_facts(f).slice((slice(y0, y0 + data.shape[0]), slice(x0, x0 + data.shape[1])))
        grid = fixed if mode == "flyby" else target_grid(e["ra"], e["dec"], n)
        img, _ = reproject_interp((data, w), grid, shape_out=(n, n))
        px, py = grid.world_to_pixel(SkyCoord(e["ra"] * u.deg, e["dec"] * u.deg))
        frames.append({"key": e["key"], "obs": e["obs"], "det": e["det"], "mjd": e["mjd"],
                       "image": (img - np.nanmedian(img)).astype(np.float32), "target_px": (float(px), float(py)),
                       "delta_au": e["delta_au"], "ra": e["ra"], "dec": e["dec"]})
    tm["total_s"] = time.time() - t0
    return {"frames": frames, "half": half, "n": n, "mode": mode, "span": span, "n_selected": len(sel),
            "center": (float(c.ra.deg), float(c.dec.deg)), "timing": tm}
