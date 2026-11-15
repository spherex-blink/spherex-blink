"""Step 2: choose which NEOSSat images to download for an object.

    .venv/Scripts/python -m pipeline.neossat.select 3i-atlas [--max-nights 120] [--max-pairs 40]

(a) time-lapse: one image per UTC night (prefer *_cord = has celestial WCS, then the longest exposure, then the middle of
    the night's sequence); (b) pairs: for every SPHEREx image time of the object (web/lib/spherex/movers/<slug>.json), the
    closest NEOSSat image within +-6 h. Writes data/neossat/<slug>_selection.json.
Written with Claude Code.
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np

from pipeline.neossat.ssois import OUT, load

PAIR_H = 6.0


def _rank(r):
    return (r["Image"].endswith("_cord"), float(r["Exptime"] or 0))


def timelapse(rows, mjd0=None, mjd1=None, max_nights=None, per_night=4, min_gap_h=2.0):
    """Up to `per_night` images per UTC night, >= min_gap_h apart, best-ranked (_cord, longest exposure) first."""
    by = defaultdict(list)
    for r in rows:
        m = float(r["MJD"])
        if (mjd0 is None or m >= mjd0) and (mjd1 is None or m <= mjd1):
            by[int(np.floor(m))].append(r)
    picks = []
    for night in sorted(by):
        rs = sorted(by[night], key=lambda r: float(r["MJD"]))
        best = max(_rank(r) for r in rs)
        good = [r for r in rs if _rank(r) == best]
        chosen = [good[len(good) // 2]]
        for r in sorted(rs, key=lambda r: (_rank(r), abs(float(r["MJD"]) - float(chosen[0]["MJD"]))), reverse=True):
            if len(chosen) >= per_night:
                break
            if all(abs(float(r["MJD"]) - float(c["MJD"])) * 24 >= min_gap_h for c in chosen):
                chosen.append(r)
        picks.extend(sorted(chosen, key=lambda r: float(r["MJD"])))
    if max_nights and len(picks) > max_nights:
        idx = np.unique(np.linspace(0, len(picks) - 1, max_nights).round().astype(int))
        picks = [picks[i] for i in idx]
    return picks


def pairs(rows, spherex_exps, max_pairs=None, hours=PAIR_H):
    """One pair per distinct SPHEREx time cluster (exposures < 30 min apart count as one), NEOSSat image closest in time."""
    cord = [r for r in rows if r["Image"].endswith("_cord")] or rows
    nm = np.array([float(r["MJD"]) for r in cord])
    order = np.argsort(nm)
    nm, cord = nm[order], [cord[i] for i in order]
    sx = sorted(spherex_exps, key=lambda e: e["mjd"])
    clusters, cur = [], [sx[0]]
    for e in sx[1:]:
        if (e["mjd"] - cur[-1]["mjd"]) * 24 * 60 > 30:
            clusters.append(cur); cur = [e]
        else:
            cur.append(e)
    clusters.append(cur)
    out = []
    for c in clusters:
        best = None                                 # try each exposure of the cluster; keep the closest NEOSSat match
        for e in c:
            i = int(np.searchsorted(nm, e["mjd"]))
            for j in (i - 1, i):
                if 0 <= j < len(nm):
                    dt = (nm[j] - e["mjd"]) * 24
                    if abs(dt) <= hours and (best is None or abs(dt) < abs(best[2])):
                        best = (cord[j], e, dt)
        if best:
            out.append(dict(neossat=best[0]["Image"], neossat_mjd=float(best[0]["MJD"]), spherex_key=best[1]["key"],
                            spherex_mjd=best[1]["mjd"], spherex_det=best[1]["det"], dt_hours=round(best[2], 3)))
    if max_pairs and len(out) > max_pairs:
        out = sorted(out, key=lambda p: abs(p["dt_hours"]))[:max_pairs]
        out.sort(key=lambda p: p["spherex_mjd"])
    return out


def screen(rows, spherex_exps, per_slot=6):
    """Keep only FINE_POINT images among the best `per_slot` candidates of each night and of each SPHEREx time
    (header probe, see modes.py). Returns the usable rows."""
    from pipeline.neossat.modes import GOOD, modes
    cand = set()
    by = defaultdict(list)
    for r in rows:
        by[int(float(r["MJD"]))].append(r)
    for rs in by.values():
        cand |= {r["Image"] for r in sorted(rs, key=_rank, reverse=True)[:per_slot]}
    if spherex_exps:
        nm = np.array([float(r["MJD"]) for r in rows])
        for t in sorted({round(e["mjd"], 2) for e in spherex_exps}):
            near = np.nonzero(np.abs(nm - t) * 24 <= PAIR_H)[0]
            near = sorted(near, key=lambda i: (not rows[i]["Image"].endswith("_cord"), abs(nm[i] - t)))[:per_slot]
            cand |= {rows[i]["Image"] for i in near}
    md = modes(sorted(cand))
    ok = [r for r in rows if r["Image"] in cand and md[r["Image"]]["mode"] == GOOD]
    print(f"  screened {len(cand)} candidates: {len(ok)} FINE_POINT "
          f"({sum(m['mode'] is None for m in md.values())} unreadable)")
    return ok


def main(slug, max_nights=120, max_pairs=40, mjd0=None, mjd1=None, screen_modes=True, per_slot=6):
    all_rows = load(slug)
    sx_path = Path(f"web/lib/spherex/movers/{slug}.json")
    sx = json.loads(sx_path.read_text())["exposures"] if sx_path.exists() else []
    rows = screen(all_rows, sx, per_slot) if screen_modes else all_rows
    tl = timelapse(rows, mjd0, mjd1, max_nights)
    pr = pairs(rows, sx, max_pairs) if sx else []
    rows = all_rows
    byname = {r["Image"]: r for r in rows}
    want = {r["Image"] for r in tl} | {p["neossat"] for p in pr}
    images = [dict(image=n, mjd=float(byname[n]["MJD"]), exptime=float(byname[n]["Exptime"] or 0),
                   ra=float(byname[n]["Object_RA"]), dec=float(byname[n]["Object_Dec"]), target=byname[n]["Image_target"],
                   url=byname[n]["Datalink"], timelapse=n in {r["Image"] for r in tl})
              for n in sorted(want, key=lambda n: float(byname[n]["MJD"]))]
    doc = dict(slug=slug, n_ssois_neossat=len(rows), n_nights=len({int(float(r["MJD"])) for r in rows}),
               n_timelapse=len(tl), n_pairs=len(pr), images=images, pairs=pr)
    (OUT / f"{slug}_selection.json").write_text(json.dumps(doc, indent=1))
    dts = [abs(p["dt_hours"]) for p in pr]
    print(f"{slug}: {len(rows)} NEOSSat rows over {doc['n_nights']} nights -> time-lapse {len(tl)} images, "
          f"{len(pr)} pairs (|dt| median {np.median(dts) if dts else float('nan'):.2f} h, max {max(dts) if dts else float('nan'):.2f} h); "
          f"{len(images)} unique images to download")
    return doc


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--max-nights", type=int, default=120)
    ap.add_argument("--max-pairs", type=int, default=40)
    ap.add_argument("--per-slot", type=int, default=6)
    a = ap.parse_args()
    main(a.slug, a.max_nights, a.max_pairs, per_slot=a.per_slot)
