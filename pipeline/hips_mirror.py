"""Mirror the zoomed-out level of NASA's SPHEREx all-sky HiPS map into the web app, so the sky dome is sharp at once
(IRSA throttles tile requests to about one every few seconds after the first ~50).

    .venv/Scripts/python -m pipeline.hips_mirror [--order 3] [--slice 17] [--threads 4]

Writes web/assets/hips/Norder{K}/Dir{D}/Npix{N}_{slice}.png (the same layout as the HiPS), validated (PNG signature) and
retried with back-off. Order 3 = 768 tiles = the whole sky at ~51"/px. Written with Claude Code.
"""
import argparse
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

BASE = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
OUT = Path("web/assets/hips")
PNG = b"\x89PNG\r\n\x1a\n"


def rel(order, n, sl):
    return f"Norder{order}/Dir{n // 10000 * 10000}/Npix{n}{'_' + str(sl) if sl else ''}.png"


def fetch(session, order, n, sl, tries=8):
    p = OUT / rel(order, n, sl)
    if p.exists() and p.read_bytes()[:8] == PNG:
        return "cached", p.stat().st_size
    p.parent.mkdir(parents=True, exist_ok=True)
    err = None
    for i in range(tries):
        try:
            r = session.get(f"{BASE}/{rel(order, n, sl)}", timeout=60)
            if r.status_code == 200 and r.content[:8] == PNG:
                p.write_bytes(r.content)
                return "ok", len(r.content)
            err = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            err = repr(e)[:80]
        time.sleep(min(30, 2 ** i))
    return f"FAILED {err}", 0


def main(order=3, sl=17, threads=4):
    n_tiles = 12 * 4 ** order
    s = requests.Session()
    s.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=threads))
    t0, done, sizes, fails = time.time(), 0, [], []
    with ThreadPoolExecutor(threads) as pool:
        for n, (st, size) in zip(range(n_tiles), pool.map(lambda n: fetch(s, order, n, sl), range(n_tiles))):
            done += 1
            if st.startswith("FAILED"):
                fails.append((n, st))
            else:
                sizes.append(size)
            if done % 50 == 0:
                print(f"{done}/{n_tiles} in {time.time() - t0:.0f} s", flush=True)
    print(f"order {order} slice {sl}: {len(sizes)}/{n_tiles} tiles, {sum(sizes) / 1e6:.1f} MB, {len(fails)} failed, {time.time() - t0:.0f} s")
    for f in fails[:20]:
        print("  ", f)


def to_webp(order=3, sl=17, size=256, quality=85, remove_png=True):
    """Shrink the mirrored tiles for fast first loads: 512 px PNG (~106 KB) -> 256 px WebP (~22 KB), 1.7"/px at order 3,
    still finer than a screen pixel when the whole sky is in view (measured 15.11: 228 tiles 24 MB -> 5 MB)."""
    from PIL import Image
    n_tiles, tot = 12 * 4 ** order, 0
    for n in range(n_tiles):
        p = OUT / rel(order, n, sl)
        q = p.with_suffix(".webp")
        if not q.exists():
            Image.open(p).convert("L").resize((size, size), Image.LANCZOS).save(q, "WEBP", quality=quality, method=6)
        tot += q.stat().st_size
        if remove_png and p.exists():
            p.unlink()
    print(f"{n_tiles} tiles -> {size}px WebP q{quality}: {tot / 1e6:.1f} MB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--order", type=int, default=3)
    ap.add_argument("--slice", type=int, default=17)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--webp", type=int, default=0, help="after downloading, shrink to this many px as WebP (e.g. 256)")
    a = ap.parse_args()
    main(a.order, a.slice, a.threads)
    if a.webp:
        to_webp(a.order, a.slice, a.webp)
