"""Make real sample blink results for the web app (web/lib/spherex/samples/*.json) and the per-detector wavelength
tables (web/lib/spherex/calib/wcs_wave_D{n}.json), after checking that each table is identical in a DR1 and a QR3 file.

Usage (repo root, needs the sky index in data/index/sky): .venv/Scripts/python -m pipeline.tests.make_samples
Written with Claude Code.
"""
import base64
import json
import warnings
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS

from pipeline.index.lookup import SkyIndex
from pipeline.index.headers import _get, _split_headers
from pipeline.quickblink import quick_blink, group_visits

warnings.simplefilter("ignore")
OUT = Path("web/lib/spherex")
STACK = 8          # exposures combined per visit (matches getBlink default)
TARGETS = {
    "barnard": dict(name="Barnard's Star", ra=269.4520769586, dec=4.6933649666, pm=(-801.551, 10362.394), detector=None, per_visit=1),
    "rdra": dict(name="R Draconis", ra=248.16761, dec=66.75498, pm=None, detector=None, per_visit=1),
    "wise0855": dict(name="WISE 0855-0714", ra=133.81891, dec=-7.24705, pm=(-8123.7, 673.2), detector=None, per_visit=1),
    "epsindB": dict(name="Epsilon Indi B", ra=331.04415, dec=-56.78284, pm=(3982.0, -2466.8), detector=None, per_visit=1),
    "rwaur": dict(name="RW Aurigae", ra=76.95653, dec=30.40144, pm=None, detector=None, per_visit=1),
}


def wave_table(key):
    with fits.open("s3://nasa-irsa-spherex/" + key, use_fsspec=True, fsspec_kwargs={"anon": True}) as h:
        d = h["WCS-WAVE"].data
        return {"X": np.asarray(d["X"][0]).tolist(), "Y": np.asarray(d["Y"][0]).tolist(),
                "VALUES": np.asarray(d["VALUES"][0]).tolist(), "hdu": h["WCS-WAVE"].copy()}


def check_and_save_wave_tables(idx):
    rows = idx.covering(269.4486, 4.7385) + idx.covering(248.16761, 66.75498)
    tables = {}
    for det in range(1, 7):
        dr1 = next(r for r in rows if r["det"] == det and r["col"].startswith("dr1"))
        qr3 = next(r for r in rows if r["det"] == det and r["col"].startswith("qr3"))
        a, b = wave_table(dr1["key"]), wave_table(qr3["key"])
        same = a["X"] == b["X"] and a["Y"] == b["Y"] and np.array_equal(np.array(a["VALUES"]), np.array(b["VALUES"]))
        print(f"D{det}: WCS-WAVE table identical in DR1 ({dr1['obs']}) and QR3 ({qr3['obs']}): {same}")
        if not same:
            raise SystemExit(f"D{det} wavelength tables differ between releases: store per release/file instead")
        (OUT / "calib").mkdir(parents=True, exist_ok=True)
        (OUT / "calib" / f"wcs_wave_D{det}.json").write_text(json.dumps({k: a[k] for k in ("X", "Y", "VALUES")}))
        tables[det] = a["hdu"]
    return tables


def wavelength_at(key, det, tables, x, y):
    buf = _get(key, 0, 40959, None)
    (_, hdr), _ = _split_headers(buf)
    hl = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(header=hdr), tables[det]])
    ww = WCS(hdr, fobj=hl, key="W")
    ww.sip = None
    lam, dlam = ww.pixel_to_world(x, y)
    return float(lam.to("um").value), float(dlam.to("um").value)


def load_wave_tables():
    """Re-use the saved per-detector tables (already verified identical across releases) as FITS table HDUs."""
    tables = {}
    for det in range(1, 7):
        d = json.loads((OUT / "calib" / f"wcs_wave_D{det}.json").read_text())
        nx, ny = len(d["X"]), len(d["Y"])          # grid size differs per detector (D1 9x9, D2 11x11, ...)
        v = np.array([d["VALUES"]], dtype="f4")    # shape (1, ny, nx, 2) as astropy returned it
        cols = [fits.Column(name="X", format=f"{nx}J", array=np.array([d["X"]])),
                fits.Column(name="Y", format=f"{ny}J", array=np.array([d["Y"]])),
                fits.Column(name="VALUES", format=f"{v[0].size}E", dim=f"(2,{nx},{ny})", array=v)]
        tables[det] = fits.BinTableHDU.from_columns(cols, name="WCS-WAVE")
    return tables


def main():
    import sys
    only = sys.argv[1:]                     # e.g. "epsindB rwaur"; empty = all, and re-verify the wavelength tables
    idx = SkyIndex()
    tables = load_wave_tables() if only else check_and_save_wave_tables(idx)
    (OUT / "samples").mkdir(parents=True, exist_ok=True)
    for slug, t in TARGETS.items():
        if only and slug not in only:
            continue
        r = quick_blink(t["ra"], t["dec"], pm=t["pm"], half=30, which="all", stack=STACK,
                        detector=t["detector"], index=idx)
        frames = []
        for f in r["frames"]:
            # wavelength at the target for every exposure in the stack -> mean, min, max
            from pipeline.index.headers import fetch_header_facts, wcs_from_facts
            from pipeline.quickblink import position_at
            lams = []
            for m in f.get("members", [{"key": f["key"]}]):
                facts = fetch_header_facts(m["key"])
                pra, pdec = position_at(t["ra"], t["dec"], t["pm"], facts["mjd_avg"])
                rx, ry = (float(v[0]) for v in wcs_from_facts(facts).all_world2pix([pra], [pdec], 0))
                lams.append(wavelength_at(m["key"], f["det"], tables, rx, ry)[0])
            img = f["image"].astype("<f4")
            tx, ty = f["target_px"]
            core = img[int(round(ty)) - 1:int(round(ty)) + 2, int(round(tx)) - 1:int(round(tx)) + 2]
            frames.append({
                "obs": f["obs"], "det": f["det"], "mjd": round(f["mjd"], 5), "date": f["date"], "key": f["key"],
                "n_stack": f.get("n_stack", 1), "members": f.get("members", []),
                "lambda_um": round(float(np.mean(lams)), 4), "lambda_min_um": round(min(lams), 4), "lambda_max_um": round(max(lams), 4),
                "targetPx": [round(tx, 3), round(ty, 3)], "saturatedAtTarget": bool(np.isnan(core).any()),
                "width": img.shape[1], "height": img.shape[0], "data_b64_f32le": base64.b64encode(img.tobytes()).decode()})
        g = r["grid"]
        out = {"_doc": "Sample getBlink() result (frames=visits, stack=8, detector auto). See handoff/daniel-to-maor/03-js-api.md. Real SPHEREx data, made by pipeline/tests/make_samples.py",
               "target": {"name": t["name"], "ra": t["ra"], "dec": t["dec"], "pm_mas_yr": t["pm"]},
               "n_exposures": r["n_exposures"], "visits": [{"start_mjd": a, "end_mjd": b, "n": n} for a, b, n in r["visits"]],
               "detector": r["detector"],
               "grid": {"n": g.pixel_shape[0] if g.pixel_shape else frames[0]["width"], "pix_arcsec": 6.15,
                        "center_ra": float(g.wcs.crval[0]), "center_dec": float(g.wcs.crval[1]),
                        "orientation": "row 0 = SOUTH edge, column 0 = EAST edge (north up, east left when drawn with rows flipped)"},
               "units": "MJy/sr, zodiacal light NOT subtracted, NaN = no data (saturated core, dead pixel, off detector)",
               "frames": frames, "timing_s": {k: round(v, 3) for k, v in r["timing"].items()}}
        p = OUT / "samples" / f"{slug}.json"
        p.write_text(json.dumps(out, separators=(",", ":")))
        print(f"{slug}: {len(frames)} frames D{r['detector']}, lambda {[fr['lambda_um'] for fr in frames]}, "
              f"stack {[fr['n_stack'] for fr in frames]}, saturated {sum(fr['saturatedAtTarget'] for fr in frames)}, {p.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
