"""Refine a mover file for the web app: each exposure's TRUE mid-time (MJD-AVG from its header) and the object's
SPHEREx-centred position from JPL Horizons at exactly that time. Writes web/lib/spherex/movers/<slug>.json.
Usage: .venv/Scripts/python -m pipeline.movers.refine slug [slug ...]
Written with Claude Code.
"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from pipeline.index.headers import fetch_header_facts
from pipeline.movers.find_movers import CANDIDATES, horizons_ephemeris

OUT = Path("web/lib/spherex/movers")
BLURB = {
    "162882": "Near-Earth asteroid passing ~0.05 AU from Earth in Feb 2026: crosses the frame in minutes.",
    "3i-atlas": "Interstellar comet 3I/ATLAS, only the third known visitor from another star system.",
    "vesta": "Asteroid 4 Vesta, the brightest asteroid: slow, steady motion over days.",
    "ceres": "Dwarf planet 1 Ceres in the asteroid belt.",
}


def refine(slug):
    src = json.load(open(f"data/movers/{slug}.json"))
    exps = src["exposures"]
    with ThreadPoolExecutor(16) as pool:
        facts = list(pool.map(lambda e: fetch_header_facts(e["key"]), exps))
    mjd = np.array([f["mjd_avg"] for f in facts])
    uniq = np.unique(np.round(mjd, 7))
    eph = horizons_ephemeris(CANDIDATES[slug]["cmd"], tlist=list(uniq))   # rows come back in the requested order
    assert len(eph) >= len(uniq), f"Horizons returned {len(eph)} rows for {len(uniq)} times"
    for t, r in zip(uniq, eph):                                            # sanity: returned time == requested time
        assert abs(float(r[0]) - float(t)) * 86400 < 1.0, f"time mismatch {r[0]} vs {t}"
    pos = {round(float(t), 7): (float(r[1]), float(r[2]), float(r[3])) for t, r in zip(uniq, eph)}
    out_exps, missing, shift = [], 0, []
    for e, f, m in zip(exps, facts, mjd):
        p = pos.get(round(float(m), 7))
        if p is None:                                   # Horizons rounds times; fall back to the nearest returned time
            k = min(pos, key=lambda t: abs(t - m))
            if abs(k - m) * 86400 > 2:
                missing += 1; continue
            p = pos[k]
        dra = (p[0] - e["ra_obj"]) * np.cos(np.radians(p[1])) * 3600 / 6.15
        shift.append(np.hypot(dra, (p[1] - e["dec_obj"]) * 3600 / 6.15))
        out_exps.append({"key": e["key"], "obs": e["obs"], "det": e["det"], "mjd": round(float(m), 7),
                         "ra": round(p[0], 7), "dec": round(p[1], 7), "delta_au": round(p[2], 5)})
    out = {"name": src["name"], "slug": slug, "designation": src.get("designation"), "about": BLURB.get(slug, ""),
           "observer": "SPHEREx (JPL Horizons -163182), astrometric ICRF, at each exposure's MJD-AVG",
           "n_exposures": len(out_exps), "exposures": out_exps}
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / f"{slug}.json"
    p.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{slug}: {len(out_exps)} exposures ({missing} dropped), position change vs t+56.5s: median {np.median(shift):.2f} px, "
          f"max {np.max(shift):.2f} px; {p.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    for s in sys.argv[1:]:
        refine(s)
