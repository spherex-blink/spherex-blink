"""Read just the first FITS header block(s) of NEOSSat files (HTTP range request, ~6 KB, ~3.5 s) to learn the pointing MODE
before downloading 4.3 MB. Only '16 - FINE_POINT' images are usable: ST_ACQUIRE / ST_REACQUIRE / FINE_SETTLE frames show
no stars, only scattered light and slew streaks (checked visually on 10 images, 14.11).
Cache: data/neossat/modes.json {image: {"mode": str, "exptime": float}}.  Written with Claude Code.
"""
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from pipeline.neossat.download import BASE, path_of, valid
from pipeline.neossat.ssois import OUT

CACHE = OUT / "modes.json"
GOOD = "16 - FINE_POINT"
_lock = threading.Lock()


def _parse(buf):
    txt = buf.decode("latin-1")
    m = re.search(r"MODE    = '([^']*)'", txt)
    e = re.search(r"EXPOSURE= +([0-9.]+)", txt)
    return dict(mode=m.group(1).strip() if m else None, exptime=float(e.group(1)) if e else None)


def probe(image, session=None, tries=4):
    p = path_of(image)
    if valid(p):
        with open(p, "rb") as f:
            return _parse(f.read(8640))
    s = session or requests
    for i in range(tries):
        try:
            r = s.get(BASE.format(image), headers={"Range": "bytes=0-8639"}, timeout=60)
            if r.status_code in (200, 206) and r.content[:6] == b"SIMPLE":
                return _parse(r.content[:8640])
        except requests.RequestException:
            pass
        time.sleep(2 ** i)
    return dict(mode=None, exptime=None)


def modes(images, threads=12):
    """{image: {mode, exptime}} for all images (cached)."""
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    todo = [n for n in dict.fromkeys(images) if n not in cache or cache[n]["mode"] is None]
    if todo:
        t0 = time.time()
        sess = requests.Session()
        sess.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=threads))
        with ThreadPoolExecutor(threads) as pool:
            for n, m in zip(todo, pool.map(lambda n: probe(n, sess), todo)):
                cache[n] = m
        with _lock:
            CACHE.write_text(json.dumps(cache))
        print(f"  probed {len(todo)} headers in {time.time() - t0:.0f} s")
    return {n: cache[n] for n in images}
