"""Validate the full sky index against NASA's own sources.

1. Totals: exposures == S3 files (1,628,230 on 14.11) and per-collection counts == IRSA ObsCore counts; every exposure has a key.
2. Lookups: for the five test targets + random sky points, the set of (obs_id, detector) from our index must equal
   IRSA TAP CONTAINS over the whole archive.
Usage: .venv/Scripts/python -m pipeline.index.validate
Written with Claude Code.
"""
import json
import random
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pyarrow.parquet as pq

from pipeline.index.lookup import SkyIndex

TARGETS = {  # J2000 + proper motion is irrelevant here: we test lookups at fixed points
    "Barnard's Star (2026 pos.)": (269.4486, 4.7385),
    "eps Ind B": (331.0441, -56.7828),
    "WISE 0855": (133.8189, -7.2470),
    "RW Aur": (76.9565, 30.4014),
    "R Dra": (248.1676, 66.7550),
}


def tap_set(ra, dec):
    from astroquery.ipac.irsa import Irsa
    for i in range(4):
        try:
            r = Irsa.query_tap(f"SELECT obs_id, energy_bandpassname FROM spherex.obscore "
                               f"WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), poly)", maxrec=1_000_000).to_table()
            return {(str(a), int(str(b)[-1])) for a, b in zip(r["obs_id"], r["energy_bandpassname"])}
        except Exception:
            time.sleep(15 * (i + 1))
    raise RuntimeError("TAP failed")


def main(n_random=10, seed=11):
    meta = json.loads(open("data/index/sky/meta.json").read())
    s3 = pq.read_metadata("data/index/s3_keys.parquet").num_rows
    print(f"[totals] index exposures {meta['n_exposures']:,} vs S3 files {s3:,} -> {'OK' if meta['n_exposures'] == s3 else 'MISMATCH'}")
    print(f"[totals] keys: {meta['keys']} | data as of MJD {meta['data_as_of_mjd']} | collections {meta['collections']}")
    from astroquery.ipac.irsa import Irsa
    tc = Irsa.query_tap("SELECT obs_collection, COUNT(*) AS n FROM spherex.obscore GROUP BY obs_collection").to_table()
    import pyarrow as pa, glob
    parts = [pq.read_table(f, columns=["collection"]) for f in glob.glob("data/index/obscore/*.parquet")]
    t = pa.concat_tables([p for p in parts if p.num_rows > 0])
    mine = dict(zip(*np.unique(np.array(t["collection"].to_pylist()), return_counts=True)))
    for c, n in zip(tc["obs_collection"], tc["n"]):
        print(f"[totals] {c:18s} TAP {int(n):9,d}  index {int(mine.get(str(c), 0)):9,d}  {'OK' if int(n) == int(mine.get(str(c), 0)) else 'MISMATCH'}")

    random.seed(seed)
    pts = list(TARGETS.items()) + [(f"random {i}", (random.uniform(0, 360), float(np.degrees(np.arcsin(random.uniform(-1, 1))))))
                                   for i in range(n_random)]
    idx = SkyIndex()
    with ThreadPoolExecutor(4) as pool:
        truths = list(pool.map(lambda p: tap_set(*p[1]), pts))
    ok = 0
    for (name, (ra, dec)), truth in zip(pts, truths):
        t0 = time.time()
        got = {(r["obs"], r["det"]) for r in idx.covering(ra, dec)}
        ms = (time.time() - t0) * 1000
        same = got == truth
        ok += same
        print(f"[lookup] {name:28s} TAP {len(truth):5d} | index {len(got):5d} in {ms:6.0f} ms | "
              f"{'MATCH' if same else f'extra {len(got - truth)}, missing {len(truth - got)}'}")
    print(f"[lookup] {ok}/{len(pts)} identical")


if __name__ == "__main__":
    main()
