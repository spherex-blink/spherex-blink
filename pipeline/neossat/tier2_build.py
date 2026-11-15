"""Tier 2, per object: pick <= 30 NEOSSat frames (closest in time to SPHEREx), screen + download, Gaia WCS fit, positions, photometry,
cutouts, a few SPHEREx frames + pairs, and the SPHEREx path file in the mover format. Called by `python -m pipeline.neossat.tier2 build <slug>`.
Writes web/lib/spherex/neossat/<slug>.json and web/lib/spherex/neossat/spherex/<slug>.json.  Written with Claude Code.
"""
import json
import time

import numpy as np

from pipeline.neossat.tier2 import MAX_NEO, T2, WEB


def pick_neossat(rows, sx_mjds, max_n=MAX_NEO, min_gap_h=0.5, max_probe=90):
    """_cord FINE_POINT frames, closest in time to any SPHEREx exposure first, >= min_gap_h apart (NEOSSat observes in
    few-hour blocks per night, so a 2 h gap left only ~2 candidates per night; 0.5 h keeps several)."""
    from pipeline.neossat.modes import GOOD, modes
    rows = [r for r in rows if r["Image"].endswith("_cord")]
    if not rows:
        return []
    sx = np.sort(np.array(sx_mjds))

    def dt(r):
        m = float(r["MJD"])
        i = int(np.searchsorted(sx, m))
        return min(abs(m - sx[j]) for j in (i - 1, i) if 0 <= j < len(sx)) * 24

    ranked = sorted(rows, key=lambda r: (dt(r), -float(r["Exptime"] or 0)))
    cand, picked_t = [], []
    for r in ranked:
        m = float(r["MJD"])
        if all(abs(m - t) * 24 >= min_gap_h for t in picked_t):
            cand.append(r)
            picked_t.append(m)
        if len(cand) >= max_probe:
            break
    md = modes([r["Image"] for r in cand])
    good = [r for r in cand if md[r["Image"]]["mode"] == GOOD][:max_n]
    for r in good:
        r["dt_spherex_h"] = round(dt(r), 2)
    return sorted(good, key=lambda r: float(r["MJD"]))


def build(slug, threads=6):
    from pipeline.neossat import positions as P
    from pipeline.neossat.cutouts import neossat_cutout
    from pipeline.neossat.download import download, path_of
    from pipeline.neossat.photometry import neossat_point
    from pipeline.neossat.publish import CREDIT, LICENCE, b64, iso, r as rnd, spherex_cutout
    t0 = time.time()
    c = json.loads((T2 / "candidates.json").read_text())[slug]
    neo_rows = json.loads((T2 / f"{slug}_ssois.json").read_text())["neossat"]
    sx = json.loads((T2 / f"{slug}_spherex.json").read_text()).get("exposures", [])
    if not sx:
        print(f"{slug}: no SPHEREx exposures; skipped")
        return None
    picks = pick_neossat(neo_rows, [e["mjd_mid"] for e in sx])
    if not picks:
        res = dict(slug=slug, name=c["name"], status="no usable (FINE_POINT, _cord) NEOSSat frame", n_neossat_ssois=len(neo_rows),
                   n_spherex=len(sx))
        print("SKIPPED", json.dumps(res))
        (T2 / f"{slug}_build.json").write_text(json.dumps(res))
        return res
    download([r["Image"] for r in picks], threads)
    imgs = [r["Image"] for r in picks if path_of(r["Image"]).exists()]
    rows = P.run(slug, c["cmd"], imgs)                       # -> data/neossat/<slug>_positions.json
    ok = [r for r in rows if r["wcs"].get("ok")]
    frames, cache = [], {}
    for row in ok:
        p = neossat_point(row)
        img, tpx = neossat_cutout(row, 61, 3.0, cache)
        det = bool(np.isfinite(row["peak_over_sigma"]) and row["peak_over_sigma"] > 5 and row["off_neossat_fit_px"] <= 2.5)
        good_zp = bool(np.isfinite(row["zp_G"]) and abs(row["zp_G"] - 21.25) <= 0.4)
        frames.append(dict(image=row["image"], mjd=rnd(row["mjd"], 6), date_time=iso(row["mjd"]), exptime_s=rnd(row["exptime_s"], 2),
                           telescope="NEOSSat (CSA)", band="visible (CLEAR, 0.4-0.9 um)", n=61, pix_arcsec=3.0, data_b64_f32le=b64(img),
                           targetPx=[rnd(tpx[0], 3), rnd(tpx[1], 3)], mag_10=p["mag_10"], snr_10=p["snr_10"],
                           valid=bool(det and good_zp and (p["snr_10"] or 0) >= 5), detected=det,
                           predicted_mag=row["horizons_mag"], delta_au=rnd(row["delta_au"], 5),
                           centroid_offset_px=rnd(row["off_neossat_fit_px"], 2) if det else None))
    # SPHEREx path file, same format as web/lib/spherex/movers/*.json. Mid-exposure = t + 56.5 s (DATA.md: <= 0.13 px from MJD-AVG).
    mover = dict(name=c["name"], slug=slug, designation=c["cmd"], about=f"{c['name']}: seen by NEOSSat (CSA) and SPHEREx (NASA).",
                 observer="SPHEREx (JPL Horizons -163182), astrometric ICRF, at t + 56.5 s", n_exposures=len(sx),
                 exposures=[dict(key=e["key"], obs=e["obs"], det=e["det"], mjd=e["mjd_mid"], ra=e["ra"], dec=e["dec"],
                                 delta_au=e["delta_au"]) for e in sx])
    (WEB / "spherex").mkdir(parents=True, exist_ok=True)
    (WEB / "spherex" / f"{slug}.json").write_text(json.dumps(mover, separators=(",", ":")))
    # SPHEREx frames for the timeline: one per day (up to 12 days), shortest-wave detector
    by_day = {}
    for e in sorted(sx, key=lambda e: (e["mjd_mid"], e["det"])):
        by_day.setdefault(int(e["mjd_mid"]), []).append(e)
    days = sorted(by_day)
    if len(days) > 12:
        days = [days[i] for i in np.unique(np.linspace(0, len(days) - 1, 12).round().astype(int))]
    sx_frames = []
    for d in days:
        es = [x for x in by_day[d] if x["det"] == min(y["det"] for y in by_day[d])]
        e = es[len(es) // 2]
        try:
            img, _ = spherex_cutout(e["key"], e["ra"], e["dec"], 31)
        except Exception:
            img = None
        if img is not None and np.isnan(img).mean() < 0.3:
            sx_frames.append(dict(key=e["key"], obs=e["obs"], det=e["det"], mjd=e["mjd_mid"], date_time=iso(e["mjd_mid"]), n=31,
                                  pix_arcsec=6.15, data_b64_f32le=b64(img), targetPx=[15.0, 15.0], delta_au=e["delta_au"]))
    # up to 3 pairs: the NEOSSat frames closest in time to a SPHEREx exposure (<= 6 h)
    pairs = []
    sxm = np.array([e["mjd_mid"] for e in sx])
    for i in sorted(range(len(frames)), key=lambda i: np.min(np.abs(sxm - frames[i]["mjd"])))[:3]:
        f = frames[i]
        j = int(np.argmin(np.abs(sxm - f["mjd"])))
        dth = (sxm[j] - f["mjd"]) * 24
        if abs(dth) > 6:
            continue
        e = sx[j]
        row = next(r for r in ok if r["image"] == f["image"])
        try:
            simg, _ = spherex_cutout(e["key"], e["ra"], e["dec"], 61)
        except Exception:
            simg = None
        if simg is None or np.isnan(simg).mean() > 0.2:
            continue
        nimg, tpx = neossat_cutout(row, 61, 6.15, cache)
        pairs.append(dict(neossat=i, spherex_key=e["key"], spherex_det=e["det"], spherex_mjd=e["mjd_mid"],
                          spherex_date_time=iso(e["mjd_mid"]), dt_hours=rnd(dth, 2), n=61, pix_arcsec=6.15,
                          neossat_b64_f32le=b64(nimg), spherex_b64_f32le=b64(simg), targetPx=[rnd(tpx[0], 3), rnd(tpx[1], 3)]))
    det = [f for f in frames if f["detected"]]
    pm = [f["predicted_mag"] for f in frames if f["predicted_mag"] is not None]
    validation = dict(n_images=len(rows), n_wcs_ok=len(ok), n_detected=len(det),
                      offset_px_median=rnd(np.median([f["centroid_offset_px"] for f in det]), 3) if det else None,
                      wcs_fit_rms_px_median=rnd(np.median([r["wcs"]["rms_px"] for r in ok]), 3) if ok else None,
                      predicted_mag_median=rnd(np.median(pm), 2) if pm else None,
                      note="detected = peak > 5 sigma within 2.5 NEOSSat px (7.5\") of the NEOSSat-centred Horizons position")
    doc = dict(name=c["name"], slug=slug, kind=c["kind"], about=mover["about"], credit=CREDIT, licence=LICENCE,
               n_neossat_ssois=len(neo_rows), n_spherex=len(sx), spherex_mover=f"spherex/{slug}.json",
               frames=frames, spherex_frames=sx_frames, pairs=pairs,
               lightcurve=dict(neossat=[dict(mjd=f["mjd"], mag_10=f["mag_10"], snr_10=f["snr_10"], valid=f["valid"]) for f in frames]),
               validation=validation)
    pth = WEB / f"{slug}.json"
    pth.write_text(json.dumps(doc, separators=(",", ":")))
    res = dict(slug=slug, name=c["name"], kind=c["kind"], n_neossat_ssois=len(neo_rows), n_spherex=len(sx), n_frames=len(frames),
               n_detected=len(det), n_valid=sum(f["valid"] for f in frames), n_sx_frames=len(sx_frames), n_pairs=len(pairs),
               offset_px_median=validation["offset_px_median"], predicted_mag_median=validation["predicted_mag_median"],
               size_kb=round(pth.stat().st_size / 1e3), seconds=round(time.time() - t0))
    print("BUILT", json.dumps(res))
    (T2 / f"{slug}_build.json").write_text(json.dumps(res))
    return res
