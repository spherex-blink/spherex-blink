import json, base64, random, warnings
import numpy as np
import astropy.units as u
from astropy.io import fits
from astropy.wcs import WCS
from astropy_healpix import HEALPix
warnings.simplefilter("ignore")
from pipeline.index.lookup import SkyIndex
from pipeline.index.headers import _get, _split_headers
from pipeline.quickblink import quick_blink, group_visits, pick, position_at, deep_stack

random.seed(1); np.random.seed(1)
idx = SkyIndex()
ref = {}
# 1 healpix
n = 20000
ra = np.random.uniform(0, 360, n); dec = np.degrees(np.arcsin(np.random.uniform(-1, 1, n)))
ra[:6] = [0, 360, 0, 90, 180, 270]; dec[:6] = [90, -90, 0, 0, 0, 89.9999999]
ra = np.append(ra, [359.9999999, 1e-9, 45, 135, 225, 315]); dec = np.append(dec, [10, 10, 41.8, -41.8, 0.0001, 66.5])
hp = HEALPix(nside=32, order="nested")
ref["healpix"] = {"ra": ra.tolist(), "dec": dec.tolist(), "cell": hp.lonlat_to_healpix(ra*u.deg, dec*u.deg).tolist()}
# 2 lookup
T = {"Barnard": (269.4486, 4.7385), "epsIndB": (331.0441, -56.7828), "WISE0855": (133.8189, -7.2470), "RWAur": (76.9565, 30.4014), "RDra": (248.1676, 66.7550)}
for i in range(5):
    T[f"rand{i}"] = (random.uniform(0, 360), float(np.degrees(np.arcsin(random.uniform(-1, 1)))))
ref["lookup"] = {k: {"ra": v[0], "dec": v[1], "set": sorted([r["obs"], r["det"]] for r in idx.covering(*v))} for k, v in T.items()}
# 3 pm
pms = {"Barnard": (269.4520769586, 4.6933649666, (-801.551, 10362.394)), "WISE0855": (133.81891, -7.24705, (-8123.7, 673.2))}
ref["pm"] = [{"name": k, "ra": a, "dec": d, "pm": p, "mjd": m, "pos": list(position_at(a, d, p, m))}
             for k, (a, d, p) in pms.items() for m in (60790, 60900, 61050, 61200, 61320)]
# 4 pick
ref["pick"] = []
cases = [("Barnard", 269.4520769586, 4.6933649666, (-801.551, 10362.394), None), ("RDra", 248.16761, 66.75498, None, None),
         ("WISE0855", 133.81891, -7.24705, (-8123.7, 673.2), 5), ("WISE0855", 133.81891, -7.24705, (-8123.7, 673.2), None),
         ("RDra", 248.16761, 66.75498, None, 3), ("Barnard", 269.4520769586, 4.6933649666, (-801.551, 10362.394), 1),
         ("EpsIndB", 331.0441, -56.7828, (3961.4, -2540.4), None), ("RWAur", 76.9565, 30.4014, None, None)]
for name, a, d, p, det in cases:
    mr, md = position_at(a, d, p, 61050)
    rows = idx.covering(mr, md); vis = group_visits(rows)
    for which, pv in (("ends", 1), ("all", 2)):
        fr, dt = pick(vis, det, pv, which)
        ref["pick"].append({"name": name, "ra": a, "dec": d, "pm": p, "det_arg": det, "which": which, "perVisit": pv,
                            "detector": dt, "frames": [[r["obs"], r["det"]] for r in fr], "nvis": len(vis), "visit": [r["visit"] for r in fr], "visits": [[round(v[0]["t"],2), round(v[-1]["t"],2), len(v)] for v in vis]})
# 5 full
ref["blink"] = []
for name, a, d, p, det, which, pv in [("Barnard", 269.4520769586, 4.6933649666, (-801.551, 10362.394), None, "all", 2),
                                      ("WISE0855", 133.81891, -7.24705, (-8123.7, 673.2), 5, "all", 2)]:
    r = quick_blink(a, d, pm=p, half=30, per_visit=pv, detector=det, which=which, index=idx)
    ref["blink"].append({"name": name, "ra": a, "dec": d, "pm": p, "detector_arg": det, "frames": [
        {"obs": f["obs"], "det": f["det"], "targetPx": f["target_px"], "b64": base64.b64encode(f["image"].astype("<f4").tobytes()).decode()} for f in r["frames"]],
        "detector": r["detector"]})
# 5b stacked: per-visit stacks of 8 exposures, detector 6, first/last visit
ref["stack"] = []
for name, a, d, p in [("Barnard", 269.4520769586, 4.6933649666, (-801.551, 10362.394)),
                      ("WISE0855", 133.81891, -7.24705, (-8123.7, 673.2))]:
    r = quick_blink(a, d, pm=p, half=30, detector=6, which="ends", stack=8, index=idx)
    ref["stack"].append({"name": name, "ra": a, "dec": d, "pm": p, "detector": r["detector"], "frames": [
        {"obs": f["obs"], "det": f["det"], "targetPx": f["target_px"], "n_stack": f["n_stack"], "mjd": f["mjd"],
         "date": f["date"], "members": [m["obs"] for m in f["members"]],
         "b64": base64.b64encode(f["image"].astype("<f4").tobytes()).decode()} for f in r["frames"]]})
    print("stack", name, [(f["n_stack"], f["date"]) for f in r["frames"]])
# 6b wavelength vs astropy for real files
def wave(key, det, pts):
    with fits.open("s3://nasa-irsa-spherex/" + key, use_fsspec=True, fsspec_kwargs={"anon": True}) as h:
        tab = h["WCS-WAVE"].copy()
    buf = _get(key, 0, 40959, None)
    (_, hdr), _ = _split_headers(buf)
    hl = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(header=hdr), tab])
    ww = WCS(hdr, fobj=hl, key="W"); ww.sip = None
    out = []
    for x, y in pts:
        lam, dl = ww.pixel_to_world(x, y)
        out.append([float(lam.to("um").value), float(dl.to("um").value)])
    return out
pts = [(10, 10), (2030, 15), (1020, 1020), (300.5, 1700.25), (1800.7, 400.3)]
rows = idx.covering(269.4486, 4.7385) + idx.covering(248.16761, 66.75498)
ref["wave"] = []
for det in (1, 2, 3, 4, 5, 6):
    r = next(r for r in rows if r["det"] == det)
    ref["wave"].append({"key": r["key"], "det": det, "pts": pts, "vals": wave(r["key"], det, pts)})
    print("wave", det, ref["wave"][-1]["vals"][:2])
# 7 deep stack (shift-and-stack, whole survey, one detector)
ref["deep"] = []
for name, a, d, p in [("WISE0855", 133.81891, -7.24705, (-8123.7, 673.2)), ("WISE0855_nopm", 133.81891, -7.24705, None),
                      ("empty", 140.5, -20.25, None), ("EpsIndB", 331.0441, -56.7828, (3982.0, -2466.8))]:
    r = deep_stack(a, d, pm=p, index=idx)
    ref["deep"].append({"name": name, "ra": a, "dec": d, "pm": p, "detector": r["detector"], "n_used": r["n_used"], "n_available": r["n_available"],
                        "snr_track": r["snr_track"], "snr_sky": r["snr_sky"], "flux_track": r["flux_track"], "flux_sky": r["flux_sky"],
                        "mjd_range": r["mjd_range"], "n": r["track"].shape[0],
                        "track_b64": base64.b64encode(r["track"].astype("<f4").tobytes()).decode(),
                        "sky_b64": base64.b64encode(r["sky"].astype("<f4").tobytes()).decode()})
    print("deep", name, r["detector"], r["n_used"], round(r["snr_track"], 2), round(r["snr_sky"], 2))
# 8 movers (Solar System): mover_video reference
from pipeline.movers.mover_video import mover_video
ref["mover"] = []
for slug, mode, span in [("162882", "flyby", "burst"), ("162882", "follow", "burst"), ("3i-atlas", "follow", "run"), ("vesta", "flyby", "run"), ("3i-atlas", "follow", "all")]:
    mv = json.load(open(f"web/lib/spherex/movers/{slug}.json"))
    r = mover_video(mv, mode=mode, span=span, **({"max_frames": 60} if span == "all" else {}))
    ref["mover"].append({"slug": slug, "mode": mode, "span": span, "max_frames": 60, "half": r["half"], "n": r["n"], "n_selected": r["n_selected"], "center": r["center"],
                         "timing": r["timing"], "frames": [{"key": f["key"], "target_px": f["target_px"], "b64": base64.b64encode(f["image"].astype("<f4").tobytes()).decode()} for f in r["frames"]]})
    print("mover", slug, mode, span, r["half"], len(r["frames"]), r["timing"])
# 9 light curves (JS getLightCurve port): same thinning (max_exposures=60), raw unrounded points captured from measure()
import pipeline.lightcurve as _lc
_orig_measure = _lc.measure
_cap = {}
def _measure(*a, **k):
    r = _orig_measure(*a, **k); _cap["r"] = r; return r
_lc.measure = _measure
ref["lc"] = []
for name, a, d, p in [("RWAur", 76.95653, 30.40144, (7.2, -20.3)), ("RDra", 248.16761, 66.75498, (-20.643, 6.149)),
                      ("Barnard", 269.4520769586, 4.6933649666, (-801.551, 10362.394))]:
    out = _lc.lightcurve(a, d, pm=p, name=name, max_exposures=60, index=idx)
    raw = [{k: (None if (isinstance(v, float) and not np.isfinite(v)) else v) for k, v in q.items()
            if k in ("obs", "key", "det", "sub", "mjd", "lambda_um", "flux_mJy", "err_mJy", "rel", "valid", "detected", "x", "y")} for q in _cap["r"]["points"]]
    def _clean(o):
        if isinstance(o, dict): return {k: _clean(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)): return [_clean(v) for v in o]
        if hasattr(o, "item"): o = o.item()
        return None if isinstance(o, float) and not np.isfinite(o) else o
    out = _clean(out); raw = _clean(raw)
    ref["lc"].append({"name": name, "ra": a, "dec": d, "pm": p, "out": out, "raw": raw})
    print("lc", name, out["method"], out["n_images"], out["n_measured"], out["n_detected"], out["verdict"], out["period"] and out["period"]["period_d"])
import os; os.makedirs("data/scratch/getblink", exist_ok=True)
with open("data/scratch/getblink/ref.json", "w") as _f:
    json.dump(ref, _f)
print("ok")
