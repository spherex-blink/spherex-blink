"""List SPHEREx level-2 FITS files in the public NASA IRSA S3 bucket.

Usage (from repo root):
    .venv/Scripts/python -I -m pipeline.index.s3_keys --week dr1/level2/2025W23_2B/
    .venv/Scripts/python -I -m pipeline.index.s3_keys --all

Output of --all: data/index/s3_keys.parquet (git-ignored).
"""
from __future__ import annotations

import argparse
import re
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

BUCKET_URL = "https://nasa-irsa-spherex.s3.amazonaws.com/"
NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
RELEASES = ("dr1", "qr3")
MAX_TRIES = 5
TIMEOUT = 60

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_PATH = REPO_ROOT / "data" / "index" / "s3_keys.parquet"

# level2_2025W23_2B_0696_1D2_spx_l2b-v27-2026-201.fits -> obs_id 2025W23_2B_0696_1, detector 2
FNAME_RE = re.compile(r"^level2_(?P<obs>.+?)D(?P<det>[1-6])_spx_")


def _list_page(prefix: str, delimiter: str | None, token: str | None) -> ET.Element:
    """One ListObjectsV2 page, with retries and exponential back-off."""
    params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
    if delimiter:
        params["delimiter"] = delimiter
    if token:
        params["continuation-token"] = token
    url = BUCKET_URL + "?" + urllib.parse.urlencode(params)
    last_err = None
    for attempt in range(MAX_TRIES):
        try:
            r = requests.get(url, timeout=TIMEOUT)
            if r.status_code == 200:
                return ET.fromstring(r.content)
            last_err = f"HTTP {r.status_code}"
        except (requests.RequestException, ET.ParseError) as e:
            last_err = repr(e)
        time.sleep(2 ** attempt)
    raise RuntimeError(f"listing {prefix!r} failed after {MAX_TRIES} tries: {last_err}")


def _iter_pages(prefix: str, delimiter: str | None = None):
    token = None
    while True:
        root = _list_page(prefix, delimiter, token)
        yield root
        if root.findtext(f"{NS}IsTruncated") != "true":
            return
        token = root.findtext(f"{NS}NextContinuationToken")
        if not token:
            return


def _common_prefixes(prefix: str) -> list[str]:
    out = []
    for root in _iter_pages(prefix, delimiter="/"):
        for cp in root.findall(f"{NS}CommonPrefixes"):
            out.append(cp.findtext(f"{NS}Prefix"))
    return out


def _parse_week_prefix(prefix: str) -> tuple[str, str]:
    parts = [p for p in prefix.strip("/").split("/") if p]
    # e.g. ["dr1", "level2", "2025W23_2B"]
    return parts[0], parts[-1]


def list_week(prefix: str) -> list[dict]:
    """List all .fits files under one week folder, e.g. 'dr1/level2/2025W23_2B/'.

    Every version folder under the week (l2b-..., l2b_retry-...) is listed,
    and each row records which version folder it came from.
    """
    if not prefix.endswith("/"):
        prefix += "/"
    release, week = _parse_week_prefix(prefix)
    rows: list[dict] = []
    for version_prefix in _common_prefixes(prefix):
        version_folder = version_prefix[len(prefix):].strip("/")
        # No delimiter: one flat listing of the whole version folder (all detectors).
        for root in _iter_pages(version_prefix):
            for c in root.findall(f"{NS}Contents"):
                key = c.findtext(f"{NS}Key")
                if not key.endswith(".fits"):
                    continue
                fname = key.rsplit("/", 1)[-1]
                m = FNAME_RE.match(fname)
                if not m:
                    raise ValueError(f"unexpected filename: {key}")
                rows.append({
                    "release": release,
                    "week": week,
                    "version_folder": version_folder,
                    "detector": int(m.group("det")),
                    "obs_id": m.group("obs"),
                    "key": key,
                    "size": int(c.findtext(f"{NS}Size")),
                    "last_modified": c.findtext(f"{NS}LastModified"),
                })
    return rows


def list_weeks(releases=RELEASES) -> list[str]:
    weeks = []
    for rel in releases:
        weeks += _common_prefixes(f"{rel}/level2/")
    return weeks


def list_all(releases=RELEASES, threads: int = 8, out_path: Path = OUT_PATH):
    import pyarrow as pa
    import pyarrow.parquet as pq

    t0 = time.time()
    weeks = list_weeks(releases)
    print(f"{len(weeks)} week folders in {', '.join(releases)}; listing with {threads} threads", flush=True)

    rows: list[dict] = []
    done = 0
    with ThreadPoolExecutor(max_workers=threads) as ex:
        for week_rows in ex.map(list_week, weeks):
            rows.extend(week_rows)
            done += 1
            if done % 10 == 0 or done == len(weeks):
                print(f"  {done}/{len(weeks)} weeks, {len(rows)} files, {time.time() - t0:.0f}s", flush=True)

    schema = pa.schema([
        ("release", pa.string()), ("week", pa.string()), ("version_folder", pa.string()),
        ("detector", pa.int8()), ("obs_id", pa.string()), ("key", pa.string()),
        ("size", pa.int64()), ("last_modified", pa.string()),
    ])
    table = pa.Table.from_pylist(rows, schema=schema)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, out_path, compression="zstd")

    summarize(rows, out_path, time.time() - t0)
    return table


def summarize(rows: list[dict], out_path: Path | None = None, elapsed: float | None = None):
    from collections import Counter
    total_bytes = sum(r["size"] for r in rows)
    print(f"files: {len(rows)}  total: {total_bytes / 1e12:.2f} TB ({total_bytes / 2**40:.2f} TiB)")
    print("per release:", dict(Counter(r["release"] for r in rows)))
    print("per version folder:", dict(Counter(r["version_folder"] for r in rows)))
    print("per detector:", dict(sorted(Counter(r["detector"] for r in rows).items())))
    pairs = Counter((r["release"], r["obs_id"], r["detector"]) for r in rows)
    dup = sum(1 for n in pairs.values() if n > 1)
    print(f"duplicate (release, obs_id, detector) pairs: {dup}")
    if out_path is not None:
        print(f"wrote {out_path} ({out_path.stat().st_size / 1e6:.1f} MB)")
    if elapsed is not None:
        print(f"wall time: {elapsed:.0f}s")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--week", help="single week prefix, e.g. dr1/level2/2025W23_2B/")
    g.add_argument("--all", action="store_true", help="list every week of dr1 and qr3 and write parquet")
    ap.add_argument("--threads", type=int, default=8)
    args = ap.parse_args(argv)

    if args.week:
        t0 = time.time()
        rows = list_week(args.week)
        summarize(rows, None, time.time() - t0)
    else:
        list_all(threads=args.threads)
    return 0


if __name__ == "__main__":
    sys.exit(main())
