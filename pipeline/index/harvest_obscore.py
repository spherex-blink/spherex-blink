"""Harvest SPHEREx exposure metadata (position, footprint, time, detector, release) from IRSA's ObsCore table.

One parquet file per time chunk in data/index/obscore/, so the harvest is resumable and the daily updater
only has to fetch the newest chunk. Each chunk is checked against a COUNT(*) for the same time range.

Usage (repo root):
    .venv/Scripts/python -I -m pipeline.index.harvest_obscore --start 60850 --end 60851        # test one day
    .venv/Scripts/python -I -m pipeline.index.harvest_obscore --all --threads 4                # everything
Written with Claude Code.
"""
import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

OUT = Path("data/index/obscore")
COLS = "obs_id, obs_collection, energy_bandpassname, t_min, s_ra, s_dec, s_region, em_min, em_max"
FIRST_MJD = 60789          # 2025-04-30, before the first SPHEREx survey image


def _tap(query, tries=5):
    from astroquery.ipac.irsa import Irsa
    for i in range(tries):
        try:
            return Irsa.query_tap(query, maxrec=2_000_000).to_table()
        except Exception as e:  # IRSA hiccups: back off and retry
            if i == tries - 1:
                raise
            time.sleep(10 * (i + 1))
            print(f"  retry {i + 1} after {type(e).__name__}: {str(e)[:120]}", file=sys.stderr)


def parse_region(s):
    """'POLYGON ICRS ra1 dec1 ra2 dec2 ...' -> flat list of floats (4 corners expected)."""
    parts = str(s).split()
    return [float(x) for x in parts[2:]]


def harvest_chunk(t0, t1, check=True):
    path = OUT / f"{t0:.0f}_{t1:.0f}.parquet"
    if path.exists():
        return path, pq.read_metadata(path).num_rows, 0.0, "cached"
    start = time.time()
    t = _tap(f"SELECT {COLS} FROM spherex.obscore WHERE t_min >= {t0} AND t_min < {t1}")
    n = len(t)
    if check:
        expected = int(_tap(f"SELECT COUNT(*) AS n FROM spherex.obscore WHERE t_min >= {t0} AND t_min < {t1}")["n"][0])
        if expected != n:
            raise RuntimeError(f"chunk {t0}-{t1}: got {n} rows, COUNT says {expected}")
    corners = [parse_region(s) for s in t["s_region"]]
    # IRSA polygons list 4 corners, usually closed by repeating the first one (10 numbers)
    bad = sum(not (len(c) == 8 or (len(c) == 10 and c[:2] == c[8:])) for c in corners)
    corners8 = np.array([c[:8] if len(c) >= 8 else [np.nan] * 8 for c in corners], dtype="float64").reshape(-1, 8)
    det = np.array([int(str(b)[-1]) for b in t["energy_bandpassname"]], dtype="int8")
    table = pa.table({
        "obs_id": pa.array([str(x) for x in t["obs_id"]], type=pa.string()),          # explicit types: empty chunks
        "collection": pa.array([str(x) for x in t["obs_collection"]], type=pa.string()),  # must keep the schema
        "detector": pa.array(det),
        "t_min": pa.array(np.asarray(t["t_min"], dtype="float64")),
        "ra": pa.array(np.asarray(t["s_ra"], dtype="float64")),
        "dec": pa.array(np.asarray(t["s_dec"], dtype="float64")),
        "em_min_um": pa.array(np.asarray(t["em_min"], dtype="float64") * 1e6),
        "em_max_um": pa.array(np.asarray(t["em_max"], dtype="float64") * 1e6),
        **{f"c{i}": pa.array(corners8[:, i]) for i in range(8)},   # corners: c0,c1 = ra,dec of corner 1 ...
    })
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    pq.write_table(table, tmp, compression="zstd")
    tmp.replace(path)
    return path, n, time.time() - start, f"{bad} odd regions" if bad else "ok"


def chunks(start, end, days):
    t = start
    while t < end:
        yield t, min(t + days, end)
        t += days


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=float, default=FIRST_MJD)
    ap.add_argument("--end", type=float)
    ap.add_argument("--days", type=float, default=3)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--no-check", action="store_true")
    ap.add_argument("--refresh-days", type=float, default=0,
                    help="re-fetch cached chunks starting within this many days of today (IRSA publishes data 3-4 weeks after "
                         "observation, so recent chunks fill up later). Daily runs use ~75.")
    a = ap.parse_args()
    from astropy.time import Time
    if a.end is None:
        a.end = float(np.ceil(Time.now().mjd)) + 1
    if a.refresh_days:
        cutoff = Time.now().mjd - a.refresh_days
        stale = [p for p in OUT.glob("*.parquet") if float(p.stem.split("_")[0]) >= cutoff]
        for p in stale:
            p.unlink()
        print(f"refresh: dropped {len(stale)} cached chunks starting after MJD {cutoff:.0f}", flush=True)
    jobs = list(chunks(a.start, a.end, a.days))
    print(f"{len(jobs)} chunks of {a.days} d, MJD {a.start}-{a.end}, {a.threads} threads", flush=True)
    t_all, total = time.time(), 0
    with ThreadPoolExecutor(a.threads) as pool:
        futs = {pool.submit(harvest_chunk, t0, t1, not a.no_check): (t0, t1) for t0, t1 in jobs}
        for f in as_completed(futs):
            t0, t1 = futs[f]
            try:
                path, n, dt, note = f.result()
                total += n
                print(f"{t0:.0f}-{t1:.0f}: {n:6d} rows {dt:6.1f}s {note}", flush=True)
            except Exception as e:
                print(f"{t0:.0f}-{t1:.0f}: FAILED {type(e).__name__}: {str(e)[:200]}", flush=True)
    print(f"done: {total} rows in {time.time() - t_all:.0f}s", flush=True)


if __name__ == "__main__":
    main()
