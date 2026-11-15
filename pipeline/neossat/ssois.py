"""Step 1: which NEOSSat images contain a Solar System object? Asks CADC's SSOIS (Solar System Object Image Search).

    .venv/Scripts/python -m pipeline.neossat.ssois                 # 3i-atlas, vesta, 162882
    .venv/Scripts/python -m pipeline.neossat.ssois "C/2025 N1" ...  # any names SSOIS understands

Writes data/neossat/<slug>_ssois.tsv (all telescopes) and <slug>_neossat.tsv (NEOSSat rows only), prints counts per month.
Written with Claude Code.
"""
import csv
import io
import sys
import time
from collections import Counter
from pathlib import Path
from urllib.parse import quote_plus

import requests
from astropy.time import Time

URL = ("https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/cadcbin/ssos/ssosclf.pl?lang=en&object={obj}&search=bynameall"
       "&epoch1={e1}&epoch2={e2}&eunits=arcseconds&extres=no&xyres=no&format=tsv")
OUT = Path("data/neossat")
E1, E2 = "2025 04 20", "2026 10 10"          # SPHEREx survey era (MJD ~60785-61323)
OBJECTS = {"3i-atlas": "C/2025 N1", "vesta": "Vesta", "162882": "162882"}


def query(name, e1=E1, e2=E2, tries=4, timeout=300):
    """List of dict rows (all telescopes). Columns: Image, MJD, Filter, Exptime, Object_RA, Object_Dec, Image_target,
    Telescope/Instrument, Datalink."""
    url = URL.format(obj=quote_plus(name), e1=e1.replace(" ", "+"), e2=e2.replace(" ", "+"))
    err = None
    for i in range(tries):
        try:
            r = requests.get(url, timeout=timeout)
            if r.status_code == 200 and r.text.lstrip().startswith("Image"):
                return list(csv.DictReader(io.StringIO(r.text), delimiter="\t"))
            if r.status_code == 200 and not r.text.strip():
                return []
            err = f"HTTP {r.status_code}: {r.text[:200]!r}"
        except requests.RequestException as e:
            err = repr(e)
        time.sleep(3 * (i + 1))
    raise IOError(f"SSOIS failed for {name}: {err}")


def is_neossat(row):
    return "NEOSSAT" in row.get("Telescope/Instrument", "").upper()


def save(rows, path):
    if not rows:
        path.write_text("")
        return
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), delimiter="\t")
        w.writeheader()
        w.writerows(rows)


def load(slug, which="neossat"):
    p = OUT / f"{slug}_{which}.tsv"
    txt = p.read_text()
    return list(csv.DictReader(io.StringIO(txt), delimiter="\t")) if txt.strip() else []


def run(slug, name):
    t0 = time.time()
    rows = query(name)
    neo = [r for r in rows if is_neossat(r)]
    OUT.mkdir(parents=True, exist_ok=True)
    save(rows, OUT / f"{slug}_ssois.tsv")
    save(neo, OUT / f"{slug}_neossat.tsv")
    months = Counter(Time(float(r["MJD"]), format="mjd").datetime.strftime("%Y-%m") for r in neo)
    cord = sum(r["Image"].endswith("_cord") for r in neo)
    print(f"{slug} ({name}): {len(rows)} images in SSOIS, {len(neo)} NEOSSat ({cord} _cord) in {time.time() - t0:.0f} s")
    if neo:
        print("  targets:", dict(Counter(r["Image_target"] for r in neo).most_common(6)))
        print("  exptime:", dict(Counter(r["Exptime"] for r in neo).most_common(6)))
        print("  per month:", " ".join(f"{m}:{n}" for m, n in sorted(months.items())))
    return neo


if __name__ == "__main__":
    args = sys.argv[1:]
    todo = {a.lower().replace("/", "").replace(" ", ""): a for a in args} if args else OBJECTS
    for s, n in todo.items():
        run(s, n)
