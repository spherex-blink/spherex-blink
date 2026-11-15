"""Light curve + spectra for one star from SPHEREx images, with honest method choice and noise floor.

    from pipeline.lightcurve import lightcurve
    lc = lightcurve(248.16761, 66.75498, pm=(-20.643, 6.149))     # R Dra -> wing photometry, period ~239 d

Method: aperture photometry (r = 2 px) on every image; if fewer than half the images are valid (saturated star: blank
core), redo with WING photometry: a ring 3.5-7 px that avoids the blank core (validated 14.11: steady stars stay flat).
Matched wavelengths: each point is divided by the median of its own SPHEREx channel (detector + subchannel), so colour
differences cancel; "rel" = brightness relative to that channel's typical value. Visits: per-visit medians of rel for all,
short-wave (D1-D3) and long-wave (D4-D6) channels. Noise floor (visit-to-visit scatter of steady field stars in one channel,
measured 14.11 near RW Aur): aperture 2-3.4 % (90th pct up to 10 %), ring 6-9 %.
Written with Claude Code.
"""
import collections
import json
import sys
import time

import numpy as np
from astropy.time import Time

from pipeline.photometry import measure
from pipeline.quickblink import group_visits

APERTURE = dict(r_ap=2.0, r_ap_in=0.0, r_in=5.0, r_out=9.0)
RING = dict(r_ap=7.0, r_ap_in=3.5, r_in=10.0, r_out=14.0)
NOISE_FLOOR = {"aperture": 0.03, "ring": 0.08}       # typical visit-to-visit scatter per channel for steady stars
VISIT_FLOOR = {"aperture": 0.01, "ring": 0.02}       # systematic floor on a per-visit median (conservative)
MIN_SNR = 10                                         # a point enters the light curve only if flux >= 10 x its error
MIN_POINTS_PER_VISIT = 5


def _relative(points):
    by = collections.defaultdict(list)
    for p in points:
        # only real detections: a ratio of noise around zero is meaningless (WISE 0855 short-wave gave a fake "79 %
        # change at 10.9 sigma" before this cut, 14.11)
        p["detected"] = bool(p["valid"] and p["err_mJy"] and np.isfinite(p["err_mJy"]) and p["flux_mJy"] >= MIN_SNR * p["err_mJy"])
        if p["detected"]:
            by[(p["det"], p["sub"])].append(p)
    for q in by.values():
        m = float(np.median([p["flux_mJy"] for p in q]))
        for p in q:
            p["rel"] = p["flux_mJy"] / m


def _visits(points):
    V = [p for p in points if "rel" in p]
    out = []
    for v in group_visits([dict(p, t=p["mjd"]) for p in V]):
        if len(v) < MIN_POINTS_PER_VISIT:
            continue
        rel = [p["rel"] for p in v]
        sw = [p["rel"] for p in v if p["det"] <= 3]
        lw = [p["rel"] for p in v if p["det"] >= 4]
        mjd = float(np.mean([p["mjd"] for p in v]))
        def med_err(a):     # median and its standard error (1.2533 * robust sigma / sqrt(n))
            a = np.asarray(a, float)
            if not len(a):
                return None, None
            sig = 1.4826 * np.median(np.abs(a - np.median(a)))
            return round(float(np.median(a)), 4), round(float(1.2533 * sig / np.sqrt(len(a))), 4) if len(a) > 2 else None
        ra_, ea = med_err(rel); rs, es = med_err(sw); rl, el = med_err(lw)
        out.append({"mjd": round(mjd, 3), "date": Time(mjd, format="mjd").iso[:10], "n": len(v), "n_sw": len(sw), "n_lw": len(lw),
                    "rel_all": ra_, "rel_all_err": ea, "rel_sw": rs, "rel_sw_err": es, "rel_lw": rl, "rel_lw_err": el})
    return out


def verdict(visits, floor):
    """Most significant visit-to-visit change in any band (all / short-wave / long-wave): |a-b| / sqrt(ea^2 + eb^2 + 2*floor^2).
    Variable if >= 5 sigma. Bands are checked separately because a star can brighten at short wavelengths while fading at
    long ones (RW Aur, 2025-26), which cancels in an all-channel median."""
    best = {"sigma": 0.0}
    for band in ("all", "sw", "lw"):
        pts = [(v["date"], v[f"rel_{band}"], v[f"rel_{band}_err"]) for v in visits
               if v[f"rel_{band}"] is not None and v[f"rel_{band}_err"] is not None]
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                (da, a, ea), (db, b, eb) = pts[i], pts[j]
                sig = abs(a - b) / np.sqrt(ea ** 2 + eb ** 2 + 2 * floor ** 2)
                if sig > best["sigma"]:
                    best = {"sigma": round(float(sig), 1), "band": band, "from": da, "to": db,
                            "change": round(float(b / a - 1), 4) if a else None}
    best["variable"] = best["sigma"] >= 5
    return best


def fit_period(visits, pmin=60, pmax=500):
    """Weighted sinusoid fit to per-visit rel_all; returns best period (d), amplitude, and the period grid's chi2 curve."""
    if len(visits) < 6:
        return None
    mj = np.array([v["mjd"] for v in visits]); y = np.array([v["rel_all"] for v in visits]); w = np.sqrt([v["n"] for v in visits])
    best = None
    for P in np.arange(pmin, pmax + 1, 1.0):
        A = np.vstack([np.ones_like(mj), np.sin(2 * np.pi * mj / P), np.cos(2 * np.pi * mj / P)]).T
        coef, *_ = np.linalg.lstsq(A * w[:, None], y * w, rcond=None)
        res = float(np.sum(w ** 2 * (y - A @ coef) ** 2))
        if best is None or res < best[0]:
            best = (res, P, coef)
    return {"period_d": float(best[1]), "amplitude_rel": round(float(np.hypot(*best[2][1:])), 4),
            "mean": round(float(best[2][0]), 4), "phase_coef": [round(float(c), 5) for c in best[2][1:]],
            "baseline_d": round(float(mj.max() - mj.min()), 1), "n_visits": len(visits)}


def lightcurve(ra, dec, pm=None, name=None, max_exposures=None, index=None):
    t0 = time.time()
    r = measure(ra, dec, pm=pm, max_exposures=max_exposures, index=index, **APERTURE)
    method = "aperture"
    if r["points"] and sum(p["valid"] for p in r["points"]) < 0.5 * len(r["points"]):
        r = measure(ra, dec, pm=pm, max_exposures=max_exposures, index=index, **RING)
        method = "ring"
    P = r["points"]
    _relative(P)
    visits = _visits(P)
    vd = verdict(visits, VISIT_FLOOR[method]) if len(visits) >= 2 else {"sigma": 0.0, "variable": None,
          "note": "not enough detected points for a light curve (target too faint in single images)"}
    out = {"target": {"name": name, "ra": ra, "dec": dec, "pm_mas_yr": pm},
           "method": method, "aperture_px": r["aperture"], "noise_floor_rel": NOISE_FLOOR[method],
           "n_images": r["n_images"], "n_measured": len(P), "n_valid": sum(p["valid"] for p in P),
           "visits": visits, "verdict": vd, "variable": vd["variable"],
           "period": fit_period(visits),
           "points": [{"mjd": round(p["mjd"], 5), "det": p["det"], "sub": p["sub"], "lambda_um": round(p["lambda_um"], 4),
                       "flux_mJy": round(p["flux_mJy"], 3), "err_mJy": round(p["err_mJy"], 3) if np.isfinite(p["err_mJy"]) else None,
                       "rel": round(p["rel"], 4) if "rel" in p else None, "valid": p["valid"], "detected": p["detected"]} for p in P],
           "n_detected": sum(p["detected"] for p in P), "min_snr": MIN_SNR,
           "seconds": round(time.time() - t0, 1)}
    return out


if __name__ == "__main__":
    # pre-compute the five test targets into web/lib/spherex/lightcurves/
    from pathlib import Path
    from pipeline.index.lookup import SkyIndex
    T = {"barnard": ("Barnard's Star", 269.4520769586, 4.6933649666, (-801.551, 10362.394)),
         "epsindB": ("Epsilon Indi B", 331.04415, -56.78284, (3982.0, -2466.8)),
         "wise0855": ("WISE 0855-0714", 133.81891, -7.24705, (-8123.7, 673.2)),
         "rwaur": ("RW Aurigae", 76.95653, 30.40144, (7.2, -20.3)),
         "rdra": ("R Draconis", 248.16761, 66.75498, (-20.643, 6.149))}
    only = sys.argv[1:] or list(T)
    idx = SkyIndex(); outdir = Path("web/lib/spherex/lightcurves"); outdir.mkdir(parents=True, exist_ok=True)
    for slug in only:
        name, ra, dec, pm = T[slug]
        lc = lightcurve(ra, dec, pm=pm, name=name, index=idx)
        (outdir / f"{slug}.json").write_text(json.dumps(lc, separators=(",", ":"), default=lambda o: o.item() if hasattr(o, "item") else str(o)))
        per = lc["period"]
        vd = lc["verdict"]
        print(f"{slug}: {lc['method']}, {lc['n_valid']}/{lc['n_measured']} valid, {lc['n_detected']} detected (S/N>={lc['min_snr']}), {len(lc['visits'])} visits, strongest change "
              f"{vd.get('change')} in {vd.get('band')} ({vd.get('from')} -> {vd.get('to')}) at {vd['sigma']} sigma -> variable={lc['variable']}"
              + (f", period {per['period_d']:.0f} d amp {per['amplitude_rel']:.2f}" if per else "") + f", {lc['seconds']:.0f}s, "
              f"{(outdir / f'{slug}.json').stat().st_size/1e3:.0f} KB")
