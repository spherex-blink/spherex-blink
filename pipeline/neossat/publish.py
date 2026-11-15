"""Step 7: publish NEOSSat cutouts + light curves as static JSON for the browser (web/lib/spherex/neossat/).

    .venv/Scripts/python -m pipeline.neossat.publish 3i-atlas

<slug>.json = {name, slug, about, credit, licence, frames: [{image, mjd, date_time, exptime_s, telescope, band, n, pix_arcsec,
  data_b64_f32le, targetPx, mag_10, valid, delta_au}], pairs: [{neossat (frame index), spherex_key, spherex_det, spherex_mjd,
  spherex_lambda_um, dt_hours, n, pix_arcsec (6.15), neossat_b64_f32le, spherex_b64_f32le, targetPx}],
  lightcurve: {neossat: [...], spherex: [...], spherex_binned: [...], cross_check: {...}}, validation: {...}}
Images: north up, east left, row 0 = south, float32 little-endian, background-subtracted (NEOSSat: counts per pixel;
SPHEREx: MJy/sr minus the cutout median), NaN = no data.  Written with Claude Code.
"""
import base64
import json
import sys
import warnings
from datetime import datetime
from pathlib import Path

import numpy as np
from astropy.time import Time

from pipeline.neossat.cutouts import neossat_cutout
from pipeline.neossat.ssois import OUT

warnings.simplefilter("ignore")
WEB = Path("web/lib/spherex/neossat")
CREDIT = ("NEOSSat data courtesy of the Canadian Space Agency (CSA), via the Canadian Astronomy Data Centre (CADC, NRC Canada); "
          "SSOIS by CADC. SPHEREx data: NASA/JPL-Caltech/IPAC (IRSA). Positions: JPL Horizons. Astrometric and photometric "
          "reference: ESA Gaia DR3.")
LICENCE = ("NEOSSat: \"NEOSSAT - Astronomy Data\" (open.canada.ca), Open Government Licence - Canada. "
           "Contains information licensed under the Open Government Licence - Canada.")
ABOUT = {
    "3i-atlas": ("Interstellar comet 3I/ATLAS seen by two space telescopes: Canada's NEOSSat (visible light, 15 cm telescope, "
                 "~800 km orbit) and NASA's SPHEREx (infrared, 0.75-5 um). NEOSSat followed it from July 2025 to February 2026, "
                 "through perihelion (29 Oct 2025)."),
}
NAMES = {"3i-atlas": "3I/ATLAS (C/2025 N1)", "vesta": "4 Vesta", "162882": "162882 (2001 FD58)"}
EPOCHS = {"Aug 2025": (60880, 60910), "Dec 2025": (61010, 61030), "Mar 2026": (61110, 61140)}
LBINS = [(0.7, 1.0), (1.0, 1.5), (1.5, 2.0), (2.0, 2.5), (2.5, 3.0), (3.0, 3.5), (3.5, 3.9), (3.9, 4.15), (4.15, 4.45),
         (4.45, 4.8), (4.8, 5.1)]
G_ZERO_JY = 3228.75          # Gaia G zero point (Vega), for an approximate mag -> mJy conversion


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode()


def iso(mjd):
    return Time(mjd, format="mjd").datetime.strftime("%Y-%m-%dT%H:%M:%SZ")


def r(x, n=4):
    return None if x is None or (isinstance(x, float) and not np.isfinite(x)) else round(float(x), n)


def spherex_cutout(key, ra, dec, n=61):
    """SPHEREx frame on the same object-centred north-up 6.15" grid (as getMoverVideo 'follow' mode does)."""
    from reproject import reproject_interp
    from pipeline.index.headers import cutout, fetch_header_facts, wcs_from_facts
    from pipeline.quickblink import target_grid
    f = fetch_header_facts(key)
    half = (n - 1) // 2
    got = cutout(key, f, ra, dec, half=half + 8)
    if got is None:
        return None, None
    data, (x0, y0) = got
    w = wcs_from_facts(f).slice((slice(y0, y0 + data.shape[0]), slice(x0, x0 + data.shape[1])))
    g = target_grid(ra, dec, n)
    img, _ = reproject_interp((data, w), g, shape_out=(n, n))
    lam = None
    return (img - np.nanmedian(img)).astype(np.float32), lam


def binned(sx):
    out = []
    for name, (a, b) in EPOCHS.items():
        pts = [p for p in sx if a <= p["mjd"] < b and p.get("valid_20")]
        for lo, hi in LBINS:
            f = np.array([p["flux_mJy_20"] for p in pts if lo <= p["lambda_um"] < hi])
            if len(f):
                out.append(dict(epoch=name, lambda_lo=lo, lambda_hi=hi, n=int(len(f)), median_mJy=r(np.median(f), 3),
                                p16_mJy=r(np.percentile(f, 16), 3), p84_mJy=r(np.percentile(f, 84), 3)))
    return out


def cross_check(neo, sxb):
    """NEOSSat (G-band, 20" aperture) vs SPHEREx (0.7-1.0 um, 20" aperture) per epoch; CO2 band ratio per epoch."""
    res = {}
    for name, (a, b) in EPOCHS.items():
        m = [p["mag_20"] for p in neo if a - 10 <= p["mjd"] < b + 10 and p["valid"] and p["mag_20"] is not None]
        s = next((x for x in sxb if x["epoch"] == name and x["lambda_lo"] == 0.7), None)
        co2 = next((x for x in sxb if x["epoch"] == name and x["lambda_lo"] == 4.15), None)
        lo = next((x for x in sxb if x["epoch"] == name and x["lambda_lo"] == 3.9), None)
        hi = next((x for x in sxb if x["epoch"] == name and x["lambda_lo"] == 4.45), None)
        cont = np.mean([x["median_mJy"] for x in (lo, hi) if x]) if (lo or hi) else None
        res[name] = dict(neossat_n=len(m), neossat_mag20_median=r(np.median(m), 3) if m else None,
                         neossat_mJy_approx=r(G_ZERO_JY * 1e3 * 10 ** (-np.median(m) / 2.5), 2) if m else None,
                         spherex_0p7_1p0um_mJy=s["median_mJy"] if s else None,
                         co2_band_mJy=co2["median_mJy"] if co2 else None, co2_continuum_mJy=r(cont, 3),
                         co2_ratio=r(co2["median_mJy"] / cont, 2) if co2 and cont and cont > 0 else None)
    return res


def main(slug, max_frames=200):
    pos = {p["image"]: p for p in json.loads((OUT / f"{slug}_positions.json").read_text())}
    phot = json.loads((OUT / f"{slug}_photometry.json").read_text())
    sel = json.loads((OUT / f"{slug}_selection.json").read_text())
    neo = phot["neossat"]
    # quality rules (14.11): a bad Gaia fit shows up as a zero point far from the others or the comet off its prediction
    zp_med = float(np.nanmedian([p["zp_G"] for p in pos.values() if p["wcs"].get("ok")]))
    for p in neo:
        row = pos[p["image"]]
        why = []
        if not np.isfinite(row["zp_G"]) or abs(row["zp_G"] - zp_med) > 0.4:
            why.append(f"zero point {row['zp_G']:.2f} vs median {zp_med:.2f}")
        if row["peak_over_sigma"] > 5 and row["off_neossat_fit_px"] > 2.5:
            why.append(f"centroid {row['off_neossat_fit_px']:.1f} px from prediction")
        if why and p["valid"]:
            p["valid"] = False
        p["quality_note"] = "; ".join(why) or None
    print("  rejected by quality rules:", [(p["image"][9:23], p["quality_note"]) for p in neo if p["quality_note"]])
    cache = {}
    frames, idx = [], {}
    for p in neo:
        row = pos[p["image"]]
        if not row["wcs"].get("ok"):
            continue
        img, tpx = neossat_cutout(row, 61, 3.0, cache)
        idx[p["image"]] = len(frames)
        frames.append(dict(image=p["image"], mjd=r(p["mjd"], 6), date_time=iso(p["mjd"]), exptime_s=r(p["exptime_s"], 2),
                           telescope="NEOSSat (CSA)", band="visible (CLEAR, 0.4-0.9 um)", n=61, pix_arcsec=3.0,
                           data_b64_f32le=b64(img), targetPx=[r(tpx[0], 3), r(tpx[1], 3)], mag_10=p["mag_10"],
                           valid=p["valid"], quality_note=p["quality_note"], delta_au=r(row["delta_au"], 5),
                           centroid_offset_px=r(row["off_neossat_fit_px"], 2) if row["peak_over_sigma"] > 5 else None))
    sx_mover = {e["key"]: e for e in json.load(open(f"web/lib/spherex/movers/{slug}.json"))["exposures"]}
    sx_phot = {p["key"]: p for p in phot["spherex"]}

    def snr(e):
        p = sx_phot.get(e["key"], {})
        f, s = p.get("flux_mJy_20"), p.get("err_mJy_20")
        return f / s if p.get("valid_20") and f is not None and s else -1e9

    # pairs: one per NEOSSat frame (valid ones), with the SPHEREx exposure within +-6 h where the comet has the highest S/N;
    # SPHEREx cutouts more than 20% empty (detector edge) are skipped and the next-best exposure is tried
    pairs, used, used_sx = [], set(), set()
    for pr in sel.get("pairs", []):
        nm = pr["neossat"]
        if nm not in idx or nm in used or not frames[idx[nm]]["valid"]:
            continue
        row = pos[nm]
        near = sorted((e for e in sx_mover.values() if abs(e["mjd"] - row["mjd"]) * 24 <= 6.0), key=snr, reverse=True)
        for e in [e for e in near if e["key"] not in used_sx][:6]:
            simg, _ = spherex_cutout(e["key"], e["ra"], e["dec"], 61)
            if simg is not None and np.isnan(simg).mean() < 0.2:
                break
        else:
            continue
        used.add(nm); used_sx.add(e["key"])
        nimg, tpx = neossat_cutout(row, 61, 6.15, cache)
        pairs.append(dict(neossat=idx[nm], spherex_key=e["key"], spherex_det=e["det"], spherex_mjd=e["mjd"],
                          spherex_date_time=iso(e["mjd"]), spherex_lambda_um=sx_phot.get(e["key"], {}).get("lambda_um"),
                          spherex_snr=r(snr(e), 1), dt_hours=r((e["mjd"] - row["mjd"]) * 24, 2), n=61, pix_arcsec=6.15,
                          neossat_b64_f32le=b64(nimg), spherex_b64_f32le=b64(simg), targetPx=[r(tpx[0], 3), r(tpx[1], 3)]))
    # SPHEREx frames for the combined time-lapse: one per UTC day, the exposure where the comet has the highest S/N
    # (20" aperture; often the 4.3 um CO2 band), object-centred, 31 x 31 px at 6.15" (~3.2', same field as the NEOSSat cutouts)
    by_day = {}
    for e in sorted(sx_mover.values(), key=lambda e: (e["mjd"], e["det"])):
        by_day.setdefault(int(e["mjd"]), []).append(e)

    sx_frames = []
    for day, es in sorted(by_day.items()):
        e = max(es, key=snr)
        img, _ = spherex_cutout(e["key"], e["ra"], e["dec"], 31)
        if img is None:
            continue
        sx_frames.append(dict(key=e["key"], obs=e["obs"], det=e["det"], mjd=e["mjd"], date_time=iso(e["mjd"]),
                              lambda_um=sx_phot.get(e["key"], {}).get("lambda_um"), n=31, pix_arcsec=6.15,
                              data_b64_f32le=b64(img), targetPx=[15.0, 15.0], delta_au=e["delta_au"]))
    sx = [dict(mjd=p["mjd"], det=p["det"], lambda_um=p.get("lambda_um"), flux_mJy_12=p.get("flux_mJy_12"),
               err_mJy_12=p.get("err_mJy_12"), flux_mJy_20=p.get("flux_mJy_20"), err_mJy_20=p.get("err_mJy_20"),
               valid=p.get("valid_20", False)) for p in phot["spherex"] if "error" not in p]
    sxb = binned([p for p in phot["spherex"] if "error" not in p])
    nl = [dict(mjd=p["mjd"], mag_5=p["mag_5"], mag_10=p["mag_10"], mag_20=p["mag_20"], mag_err_10=p["mag_err_10"],
               cps_10=r(p["cps_10"], 3), snr_10=p["snr_10"], valid=p["valid"], star_nearby=p["star_nearby"],
               horizons_Tmag=p["horizons_Tmag"]) for p in neo]
    ok = [p for p in pos.values() if p["wcs"].get("ok")]
    det = [p for p in ok if p["peak_over_sigma"] > 5 and p["off_neossat_fit_px"] < 3]
    validation = dict(
        n_images=len(pos), n_wcs_ok=len(ok),
        header_wcs_error_px_median=r(np.median([p["wcs"]["raw_median_px"] for p in ok]), 2),
        wcs_fit_rms_px_median=r(np.median([p["wcs"]["rms_px"] for p in ok]), 3),
        gaia_matches_median=int(np.median([p["wcs"]["n_match"] for p in ok])),
        n_clean_detections=len(det),
        offset_neossat_centred_px_median=r(np.median([p["off_neossat_fit_px"] for p in det]), 3),
        offset_geocentric_px_median=r(np.median([p["off_geo_fit_px"] for p in det]), 3),
        neossat_minus_geo_px_median=r(np.median([p["neossat_minus_geo_px"] for p in pos.values()]), 3),
        note="Offsets in NEOSSat pixels (3.0\"). Positions from JPL Horizons with NEOSSat (-139089) as observer.")
    doc = dict(name=NAMES.get(slug, slug), slug=slug, about=ABOUT.get(slug, ""), credit=CREDIT, licence=LICENCE,
               made=datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"),
               units=dict(neossat="background-subtracted counts per pixel (ADU); magnitudes on the Gaia G scale",
                          spherex="MJy/sr minus the cutout median; fluxes in mJy"),
               frames=frames, pairs=pairs, spherex_frames=sx_frames, spherex_mover=slug,
               lightcurve=dict(neossat=nl, spherex=sx, spherex_binned=sxb, cross_check=cross_check(neo, sxb),
                               apertures=dict(neossat_radius_arcsec=[5, 10, 20], neossat_annulus_arcsec=[40, 60],
                                              spherex_radius_arcsec=[12.3, 20.0], spherex_annulus_arcsec=[36.9, 61.5])),
               validation=validation)
    WEB.mkdir(parents=True, exist_ok=True)
    p = WEB / f"{slug}.json"
    p.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"{p}: {len(frames)} frames, {len(sx_frames)} SPHEREx frames, {len(pairs)} pairs, {len(nl)} + {len(sx)} light-curve points, {p.stat().st_size / 1e6:.2f} MB")
    print(json.dumps(doc["lightcurve"]["cross_check"], indent=1))
    print(json.dumps(validation, indent=1))
    return doc


def write_index():
    """index.json = gallery of every published object (re-scanned from the files on disk)."""
    objs = []
    for p in sorted(WEB.glob("*.json")):
        if p.name == "index.json":
            continue
        d = json.loads(p.read_text())
        fr = d.get("frames", [])
        mv = Path(f"web/lib/spherex/movers/{d['slug']}.json")
        sxn = d.get("n_spherex") or (json.loads(mv.read_text())["n_exposures"] if mv.exists() else 0)
        v = d.get("validation", {})
        objs.append(dict(slug=d["slug"], name=d["name"], kind=d.get("kind", "comet" if "3i" in d["slug"] else "asteroid"),
                         about=d.get("about", ""), n_neossat=len(fr), n_pairs=len(d.get("pairs", [])), n_spherex=sxn,
                         n_neossat_archive=d.get("n_neossat_ssois", 3699 if d["slug"] == "3i-atlas" else None),
                         n_detected=v.get("n_detected", v.get("n_clean_detections")),
                         first=fr[0]["date_time"][:10] if fr else None, last=fr[-1]["date_time"][:10] if fr else None,
                         spherex_mover=d.get("spherex_mover", d["slug"]), size_kb=round(p.stat().st_size / 1e3)))
    objs.sort(key=lambda o: (o["slug"] != "3i-atlas", o["kind"] != "comet", -(o["n_detected"] or 0), -o["n_neossat"]))
    cand = OUT / "tier2" / "candidates.json"
    n_cand = len(json.loads(cand.read_text())) if cand.exists() else None
    n_both = sum(1 for q in (OUT / "tier2").glob("*_spherex.json") if json.loads(q.read_text()).get("n")) if cand.exists() else None
    doc = dict(_doc="NEOSSat (CSA) images of Solar System objects also imaged by SPHEREx; files made by pipeline/neossat/publish.py. "
                    "Load with web/lib/spherex/neossat.mjs.", credit=CREDIT, licence=LICENCE, n_candidates=n_cand, n_in_both=n_both, objects=objs,
               total_kb=sum(o["size_kb"] for o in objs))
    (WEB / "index.json").write_text(json.dumps(doc, indent=1))
    print(f"index.json: {len(objs)} objects, {doc['total_kb'] / 1e3:.2f} MB total")


if __name__ == "__main__":
    for s in (sys.argv[1:] or ["3i-atlas"]):
        if s != "index":
            main(s)
    write_index()
