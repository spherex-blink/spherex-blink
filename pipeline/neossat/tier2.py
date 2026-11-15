"""Tier 2: every asteroid / comet seen by BOTH NEOSSat (CSA) and SPHEREx (NASA) during the SPHEREx survey.

    .venv/Scripts/python -m pipeline.neossat.tier2 candidates     # build data/neossat/tier2/candidates.json
    .venv/Scripts/python -m pipeline.neossat.tier2 ssois          # SSOIS for every candidate -> NEOSSat rows in MJD 60790-61320
    .venv/Scripts/python -m pipeline.neossat.tier2 spherex        # SPHEREx exposures containing each object (sky index + Horizons)
    .venv/Scripts/python -m pipeline.neossat.tier2 build [slug..] # per object: select <=30 NEOSSat frames, download, fit, cut, publish
    .venv/Scripts/python -m pipeline.neossat.tier2 report

Candidates: our 11 movers (find_movers.CANDIDATES), asteroids 1-20, near-Earth asteroids with close approaches during the survey
(JPL cad.api: < 0.05 AU with H < 24, or < 0.2 AU with H < 19), and bright comets of 2025-26.
Written with Claude Code.
"""
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests

from pipeline.movers.find_movers import CANDIDATES
from pipeline.neossat.ssois import OUT as NOUT, is_neossat, query

T2 = NOUT / "tier2"
WEB = Path("web/lib/spherex/neossat")
MAX_NEO = 30
MJD0, MJD1 = 60790, 61320
COMETS = {   # name for SSOIS, Horizons command
    "C/2025 A6": ("C/2025 A6 (Lemmon)", "DES=C/2025 A6;"),
    "C/2025 R2": ("C/2025 R2 (SWAN)", "DES=C/2025 R2;"),
    "C/2025 K1": ("C/2025 K1 (ATLAS)", "DES=C/2025 K1;CAP;NOFRAG;"),     # broke up: several records in Horizons
    "C/2024 E1": ("C/2024 E1 (Wierzchos)", "DES=C/2024 E1;"),
    "C/2023 A3": ("C/2023 A3 (Tsuchinshan-ATLAS)", "DES=C/2023 A3;"),
    "210P": ("210P/Christensen", "DES=210P;CAP;"),
    "24P": ("24P/Schaumasse", "DES=24P;CAP;"),
    "29P": ("29P/Schwassmann-Wachmann", "DES=29P;CAP;"),
    "12P": ("12P/Pons-Brooks", "DES=12P;CAP;"),
    "C/2025 N1": ("3I/ATLAS (C/2025 N1)", "DES=C/2025 N1;"),
}
NAMES_1_20 = ["Ceres", "Pallas", "Juno", "Vesta", "Astraea", "Hebe", "Iris", "Flora", "Metis", "Hygiea", "Parthenope", "Victoria",
              "Egeria", "Irene", "Eunomia", "Psyche", "Thetis", "Melpomene", "Fortuna", "Massalia"]


def slugify(s):
    return "".join(c for c in s.lower().replace("/", "-").replace(" ", "") if c.isalnum() or c == "-")


def candidates():
    c = {}
    for i, n in enumerate(NAMES_1_20, 1):
        c[slugify(n)] = dict(name=f"{i} {n}", ssois=str(i), cmd=f"DES={2000000 + i};", kind="asteroid")
    for k, (name, cmd) in COMETS.items():
        c["3i-atlas" if k == "C/2025 N1" else slugify(k)] = dict(name=name, ssois=k, cmd=cmd, kind="comet")
    for slug, v in CANDIDATES.items():
        if slug not in c and v["cmd"] not in {x["cmd"] for x in c.values()}:
            d = v["cmd"][4:-1]
            ss = str(int(d) - 2000000) if d.isdigit() and int(d) > 2000000 else d
            c[slug] = dict(name=v["name"], ssois=ss, cmd=v["cmd"], kind="asteroid", approach=v.get("approach"))
    seen = {x["cmd"] for x in c.values()}
    for q in ({"dist-max": "0.05", "h-max": "24"}, {"dist-max": "0.2", "h-max": "19"}):
        r = requests.get("https://ssd-api.jpl.nasa.gov/cad.api", timeout=60,
                         params=dict(q, **{"date-min": "2025-05-01", "date-max": "2026-10-05", "fullname": "true"})).json()
        f = r["fields"]
        for row in r["data"]:
            d = dict(zip(f, row))
            des = d["des"]
            cmd = f"DES={2000000 + int(des)};" if des.isdigit() else f"DES={des};"
            if cmd in seen:
                continue
            seen.add(cmd)
            c[slugify(des)] = dict(name=d["fullname"].strip(), ssois=des, cmd=cmd, kind="NEA", h=float(d["h"]),
                                   approach=d["cd"], dist_au=float(d["dist"]))
    T2.mkdir(parents=True, exist_ok=True)
    (T2 / "candidates.json").write_text(json.dumps(c, indent=1))
    kinds = {}
    for v in c.values():
        kinds[v["kind"]] = kinds.get(v["kind"], 0) + 1
    print(f"{len(c)} candidates: {kinds}")
    return c


def run_ssois(threads=4):
    c = json.loads((T2 / "candidates.json").read_text())
    t0 = time.time()

    def one(item):
        slug, v = item
        p = T2 / f"{slug}_ssois.json"
        if p.exists():
            return slug, json.loads(p.read_text())
        try:
            rows = query(v["ssois"], timeout=180)
        except Exception as e:
            return slug, dict(error=repr(e)[:200])
        neo = [r for r in rows if is_neossat(r) and MJD0 <= float(r["MJD"]) <= MJD1]
        res = dict(n_all=len(rows), neossat=neo)
        p.write_text(json.dumps(res))
        return slug, res

    with ThreadPoolExecutor(threads) as pool:
        out = dict(pool.map(one, c.items()))
    hits = {s: len(v["neossat"]) for s, v in out.items() if "neossat" in v and v["neossat"]}
    errs = [s for s, v in out.items() if "error" in v]
    print(f"SSOIS for {len(c)} candidates in {time.time() - t0:.0f} s: {len(hits)} with NEOSSat images in the SPHEREx era, {len(errs)} errors")
    for s, n in sorted(hits.items(), key=lambda x: -x[1]):
        cord = sum(r["Image"].endswith("_cord") for r in out[s]["neossat"])
        print(f"  {s:14s} {c[s]['name'][:34]:34s} {c[s]['kind']:8s} NEOSSat {n:5d} ({cord} _cord)")
    if errs:
        print("  errors:", errs[:20])
    return out


def spherex_exposures(threads=3):
    """For every candidate with NEOSSat rows: Horizons (SPHEREx-centred) + sky index -> SPHEREx exposures containing it."""
    from pipeline.index.lookup import SkyIndex, point_in_footprint
    from pipeline.movers.find_movers import T0, T1, exposures_containing, horizons_ephemeris
    c = json.loads((T2 / "candidates.json").read_text())
    todo = []
    for s, v in c.items():
        p = T2 / f"{s}_ssois.json"
        if p.exists() and json.loads(p.read_text()).get("neossat"):
            todo.append(s)
    idx = SkyIndex()
    t0 = time.time()

    def one(s):
        p = T2 / f"{s}_spherex.json"
        if p.exists():
            return s, json.loads(p.read_text())
        v = c[s]
        try:
            step = "10m" if v["kind"] == "NEA" else "1h"
            if v["kind"] == "NEA" and v.get("approach"):     # NEAs: +-15 d around closest approach at 10 min; rest of survey hourly
                from astropy.time import Time
                ta = Time(datetime_fix(v["approach"]), scale="utc").mjd
                m0, m1 = Time(T0).mjd, Time(T1).mjd
                a, b = max(m0, ta - 15), min(m1, ta + 15)
                iso_ = lambda m: Time(m, format="mjd").iso[:16]
                parts = []
                if a - m0 > 0.5:
                    parts.append(horizons_ephemeris(v["cmd"], T0, iso_(a), "1h"))
                parts.append(horizons_ephemeris(v["cmd"], iso_(a), iso_(b), "10m"))
                if m1 - b > 0.5:
                    parts.append(horizons_ephemeris(v["cmd"], iso_(b), T1, "1h"))
                eph = np.vstack([e for e in parts if e.ndim == 2 and len(e)])
                _, k = np.unique(eph[:, 0], return_index=True)
                eph = eph[k]
            else:
                eph = horizons_ephemeris(v["cmd"], T0, T1, step)
            eph = eph[eph[:, 0] >= MJD0 - 1]
            exps = exposures_containing(eph, idx)
            if exps:
                ut = sorted({round(e["mjd_mid"], 7) for e in exps})
                ex = horizons_ephemeris(v["cmd"], tlist=ut)
                lut = {t: row for t, row in zip(ut, ex)}
                for e in exps:
                    row = lut[round(e["mjd_mid"], 7)]
                    e["ra_obj"], e["dec_obj"], e["delta"], e["vmag"] = float(row[1]), float(row[2]), float(row[3]), float(row[4])
                exps = [e for e in exps if point_in_footprint(e["ra_obj"], e["dec_obj"], e["corners"])]
            res = dict(n=len(exps), exposures=[dict(key=e["key"], obs=e["obs"], det=e["det"], t=e["t"], mjd_mid=round(e["mjd_mid"], 7),
                                                    ra=round(e["ra_obj"], 7), dec=round(e["dec_obj"], 7), delta_au=round(e["delta"], 6),
                                                    vmag=None if np.isnan(e["vmag"]) else round(e["vmag"], 2)) for e in exps])
        except Exception as e:
            res = dict(error=repr(e)[:300])
        p.write_text(json.dumps(res))
        return s, res

    with ThreadPoolExecutor(threads) as pool:
        out = dict(pool.map(one, todo))
    both = {s: v["n"] for s, v in out.items() if v.get("n")}
    print(f"SPHEREx search for {len(todo)} objects in {time.time() - t0:.0f} s: {len(both)} seen by BOTH telescopes; "
          f"errors {[s for s, v in out.items() if 'error' in v]}")
    for s, n in sorted(both.items(), key=lambda x: -x[1]):
        print(f"  {s:14s} {c[s]['name'][:34]:34s} SPHEREx {n:4d}  NEOSSat {len(json.loads((T2 / f'{s}_ssois.json').read_text())['neossat'])}")
    return out


def datetime_fix(cd):
    """cad.api '2025-May-03 08:56' -> '2025-05-03 08:56'."""
    from datetime import datetime
    return datetime.strptime(cd, "%Y-%b-%d %H:%M").strftime("%Y-%m-%d %H:%M")


if __name__ == "__main__":
    a = sys.argv[1:] or ["report"]
    if a[0] == "candidates":
        candidates()
    elif a[0] == "ssois":
        run_ssois()
    elif a[0] == "spherex":
        spherex_exposures()
    elif a[0] == "build":
        from pipeline.neossat.tier2_build import build
        for s_ in a[1:]:
            try:
                build(s_)
            except Exception as e:
                import traceback
                traceback.print_exc()
                print("BUILD FAILED", s_, repr(e)[:200])
