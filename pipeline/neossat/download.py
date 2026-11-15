"""Step 3: download NEOSSat FITS files from CADC (parallel, retry with back-off, validated) into cache/neossat/.

    .venv/Scripts/python -m pipeline.neossat.download 3i-atlas [--limit 1] [--threads 6]

Each file must start with b"SIMPLE" and be a whole number of 2880-byte FITS blocks; anything else is retried.
Written with Claude Code.
"""
import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from pipeline.neossat.ssois import OUT

CACHE = Path("cache/neossat")
BASE = "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/data/pub/NEOSSAT/{}.fits"


def path_of(image):
    return CACHE / f"{image}.fits"


def valid(p):
    if not p.exists() or p.stat().st_size < 2880 or p.stat().st_size % 2880:
        return False
    with open(p, "rb") as f:
        return f.read(6) == b"SIMPLE"


def fetch(image, session=None, tries=5):
    p = path_of(image)
    if valid(p):
        return image, "cached", 0.0, 0
    CACHE.mkdir(parents=True, exist_ok=True)
    s = session or requests
    t0, err = time.time(), None
    for i in range(tries):
        try:
            r = s.get(BASE.format(image), timeout=120)
            if r.status_code == 200 and r.content[:6] == b"SIMPLE":
                tmp = p.with_suffix(".part")
                tmp.write_bytes(r.content)
                tmp.replace(p)
                if valid(p):
                    return image, "ok", time.time() - t0, i
                err = f"bad size {p.stat().st_size}"
            else:
                err = f"HTTP {r.status_code} {r.content[:60]!r}"
        except requests.RequestException as e:
            err = repr(e)[:120]
        time.sleep(2 ** i)
    return image, f"FAILED: {err}", time.time() - t0, tries


def download(images, threads=6):
    sess = requests.Session()
    sess.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=threads))
    t0 = time.time()
    with ThreadPoolExecutor(threads) as pool:
        res = list(pool.map(lambda n: fetch(n, sess), images))
    st = {}
    for _, s, _, _ in res:
        k = "failed" if s.startswith("FAILED") else s
        st[k] = st.get(k, 0) + 1
    retries = sum(r[3] for r in res if r[1] == "ok")
    secs = [r[2] for r in res if r[1] == "ok"]
    print(f"{len(images)} files in {time.time() - t0:.0f} s with {threads} threads: {st}; retries {retries}; "
          f"per file median {sorted(secs)[len(secs) // 2] if secs else 0:.1f} s")
    for r in res:
        if r[1].startswith("FAILED"):
            print("  ", r[0], r[1])
    return res


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--threads", type=int, default=6)
    a = ap.parse_args()
    sel = json.loads((OUT / f"{a.slug}_selection.json").read_text())
    names = [im["image"] for im in sel["images"]]
    download(names[: a.limit] if a.limit else names, a.threads)
