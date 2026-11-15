"""Build the static sky index: "which SPHEREx exposures cover this point?" without asking IRSA.

Layout (all static JSON, served by Firebase and readable by the browser):
    data/index/sky/meta.json         order, counts, data_as_of, and for every HEALPix cell the list of cells to read
    data/index/sky/o{order}/{cell}.json   exposures whose CENTRE falls in that cell (columnar arrays)

Lookup for a point P: cell C = healpix(P) -> read meta["near"][C] cell files -> keep exposures whose
footprint polygon contains P. Each exposure is stored once; "near" is precomputed so it is exact:
a footprint's centre is never more than FOOT_R from any point it covers.

Usage (repo root):
    .venv/Scripts/python -m pipeline.index.build_index --order 5
Written with Claude Code.
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from astropy_healpix import HEALPix
import astropy.units as u

SRC = Path("data/index/obscore")
KEYS = Path("data/index/s3_keys.parquet")
OUT = Path("data/index/sky")
FOOT_R = 2.70   # deg; measured max centre->corner distance of a footprint: 2.583 (full archive, 14.11)


def load_exposures():
    files = sorted(SRC.glob("*.parquet"))
    tables = [pq.read_table(f) for f in files]
    t = pa.concat_tables([x for x in tables if x.num_rows > 0])   # chunks after the newest data are empty
    return t, len(files)


def sep_deg(ra1, dec1, ra2, dec2):
    """Great-circle distance in degrees (vectorised, haversine)."""
    r1, d1, r2, d2 = map(np.radians, (ra1, dec1, ra2, dec2))
    a = np.sin((d2 - d1) / 2) ** 2 + np.cos(d1) * np.cos(d2) * np.sin((r2 - r1) / 2) ** 2
    return np.degrees(2 * np.arcsin(np.sqrt(np.clip(a, 0, 1))))


def neighbour_table(hp):
    """For every cell: the cells whose exposures could cover some point of it."""
    n = hp.npix
    lon, lat = hp.healpix_to_lonlat(np.arange(n))
    clon, clat = lon.to_value(u.deg), lat.to_value(u.deg)
    blon, blat = hp.boundaries_lonlat(np.arange(n), step=2)
    r_cell = sep_deg(clon[:, None], clat[:, None], blon.to_value(u.deg), blat.to_value(u.deg)).max(axis=1)
    near = []
    for i in range(n):
        d = sep_deg(clon[i], clat[i], clon, clat)
        near.append(np.nonzero(d <= FOOT_R + r_cell[i] + r_cell)[0].tolist())
    return near, float(r_cell.max())


def attach_keys(t):
    """Join S3 keys by (obs_id, detector) if the S3 listing exists; else leave keys empty."""
    if not KEYS.exists():
        return [None] * t.num_rows, "no s3_keys.parquet yet"
    k = pq.read_table(KEYS).to_pydict()
    # if an exposure exists in several version folders, keep the newest (last_modified); see s3_keys.py notes
    best = {}
    for obs, det, key, lm in zip(k["obs_id"], k["detector"], k["key"], k["last_modified"]):
        cur = best.get((obs, det))
        if cur is None or lm > cur[1]:
            best[(obs, det)] = (key, lm)
    obs, det = t["obs_id"].to_pylist(), t["detector"].to_pylist()
    keys = [best.get((o, d), (None,))[0] for o, d in zip(obs, det)]
    missing = sum(x is None for x in keys)
    return keys, f"{missing} exposures without an S3 key"


def build(order):
    t0 = time.time()
    t, nfiles = load_exposures()
    hp = HEALPix(nside=2 ** order, order="nested")
    ra, dec = t["ra"].to_numpy(), t["dec"].to_numpy()
    cell = hp.lonlat_to_healpix(ra * u.deg, dec * u.deg)
    keys, key_note = attach_keys(t)
    corners = np.stack([t[f"c{i}"].to_numpy() for i in range(8)], axis=1)
    foot_r = float(np.nanmax(np.max([sep_deg(ra, dec, corners[:, 2 * j], corners[:, 2 * j + 1]) for j in range(4)], axis=0)))
    if foot_r > FOOT_R:
        raise RuntimeError(f"a footprint reaches {foot_r:.3f} deg from its centre > FOOT_R={FOOT_R}; raise FOOT_R")

    out = OUT / f"o{order}"
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.json"):
        old.unlink()
    d = {name: t[name].to_numpy(zero_copy_only=False) for name in ("obs_id", "collection", "detector", "t_min", "em_min_um", "em_max_um")}
    order_idx = np.argsort(cell, kind="stable")
    bounds = np.searchsorted(cell[order_idx], np.arange(hp.npix + 1))
    sizes = []
    for c in range(hp.npix):
        idx = order_idx[bounds[c]:bounds[c + 1]]
        if len(idx) == 0:
            continue
        idx = idx[np.argsort(d["t_min"][idx])]
        rec = {
            "obs": [str(x) for x in d["obs_id"][idx]],
            "det": [int(x) for x in d["detector"][idx]],
            "t": [round(float(x), 5) for x in d["t_min"][idx]],
            "ra": [round(float(x), 6) for x in ra[idx]],
            "dec": [round(float(x), 6) for x in dec[idx]],
            "corners": [[round(float(v), 5) for v in corners[i]] for i in idx],
            "col": [str(x).replace("spherex_", "") for x in d["collection"][idx]],
            "lam": [[round(float(a), 4), round(float(b), 4)] for a, b in zip(d["em_min_um"][idx], d["em_max_um"][idx])],
            "key": [keys[i] for i in idx],
        }
        path = out / f"{c}.json"
        path.write_text(json.dumps(rec, separators=(",", ":")))
        sizes.append(path.stat().st_size)

    near, r_max = neighbour_table(hp)
    meta = {
        "order": order, "nside": 2 ** order, "scheme": "nested", "foot_r_deg": FOOT_R,
        "n_exposures": t.num_rows, "n_cells_nonempty": len(sizes), "source_chunks": nfiles,
        "data_as_of_mjd": round(float(np.max(d["t_min"])), 5), "built_unix": int(time.time()),
        "collections": sorted(set(str(x) for x in d["collection"])), "keys": key_note,
        "near": near,
    }
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    sizes = np.array(sizes)
    nn = np.array([len(x) for x in near])
    print(f"order {order}: {t.num_rows} exposures from {nfiles} chunks -> {len(sizes)} cell files, "
          f"total {sizes.sum() / 1e6:.1f} MB, median {np.median(sizes) / 1e3:.1f} KB, max {sizes.max() / 1e3:.0f} KB; "
          f"cells read per lookup: median {int(np.median(nn))}, max {nn.max()}; max footprint radius {foot_r:.3f} deg; "
          f"{key_note}; {time.time() - t0:.0f}s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--order", type=int, default=5)
    build(ap.parse_args().order)
