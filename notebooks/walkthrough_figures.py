"""Figures + numbers for the Phase 0 walkthrough page. Usage (repo root): .venv/Scripts/python notebooks/walkthrough_figures.py out.json
Also the reference for safe IRSA downloads: see fetch() (validate FITS, back off on "Server busy").
Written with Claude Code."""
import base64, io, json, re, sys, time, warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS, FITSFixedWarning
import astropy.units as u
from astroquery.ipac.irsa import Irsa
from reproject import reproject_interp

warnings.simplefilter("ignore", FITSFixedWarning)
import logging; logging.getLogger("astropy").setLevel(logging.ERROR)

CACHE = Path("cache"); CACHE.mkdir(exist_ok=True)
OUT = Path(sys.argv[1])
BAD_BITS = sum(1 << b for b in [0, 1, 2, 6, 7, 9, 10, 11, 14, 15, 17, 19, 20, 22, 23, 24, 25, 26, 27, 28])
out = {}


def sesame(name):
    x = requests.get("https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/S?" + requests.utils.quote(name), timeout=30).text
    g = lambda t: float(re.search(f"<{t}>([^<]+)</{t}>", x).group(1)) if re.search(f"<{t}>", x) else 0.0
    return dict(ra=g("jradeg"), dec=g("jdedeg"), pmra=g("pmRA"), pmdec=g("pmDE"))


def pos_at(v, mjd):
    c = SkyCoord(v["ra"] * u.deg, v["dec"] * u.deg, pm_ra_cosdec=v["pmra"] * u.mas / u.yr,
                 pm_dec=v["pmdec"] * u.mas / u.yr, obstime=Time("J2000"), frame="icrs")
    return c.apply_space_motion(new_obstime=Time(mjd, format="mjd"))


def exposures(ra, dec, band, size):
    q = f"""SELECT 'https://irsa.ipac.caltech.edu/' || a.uri || '?center={ra},{dec}d&size={size}' AS uri,
           p.time_bounds_lower AS mjd FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
           WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly) AND p.energy_bandpassname = '{band}'
           ORDER BY p.time_bounds_lower"""
    return Irsa.query_tap(q).to_table()


BUSY = {"n": 0}


def fetch(url, name):
    """Download a cutout; IRSA answers 'Server busy, retry later.' under load, so validate and back off."""
    f = CACHE / name
    if f.exists() and f.read_bytes()[:6] == b"SIMPLE":
        return f
    for attempt in range(8):
        r = requests.get(url, timeout=180)
        if r.content[:6] == b"SIMPLE":
            f.write_bytes(r.content)
            return f
        BUSY["n"] += 1
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"IRSA kept refusing {name}: {r.status_code} {r.content[:60]!r}")


def png(arr, vmin, vmax, cmap="gray", stretch="linear", bad=(0.35, 0.1, 0.1)):
    a = np.clip((arr - vmin) / (vmax - vmin), 0, 1)
    if stretch == "asinh":
        a = np.arcsinh(a * 30) / np.arcsinh(30)
    cm = matplotlib.colormaps[cmap].copy(); cm.set_bad(bad)
    buf = io.BytesIO()
    plt.imsave(buf, np.ma.masked_invalid(a), cmap=cm, origin="lower", format="png", vmin=0, vmax=1)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def target_grid(ra, dec, n=31, scale_deg=0.00170):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-scale_deg, scale_deg]
    return w, (n, n)


DISPLAY_BAD = sum(1 << b for b in [6, 9, 10, 11])   # nonfunctional, missing, hot, cold only


def clean(h, bits=None):
    img = h["IMAGE"].data.astype(float) - h["ZODI"].data
    img[(h["FLAGS"].data & (DISPLAY_BAD if bits is None else bits)) != 0] = np.nan
    return img - np.nanmedian(img)


def lam_at(h, ra, dec):
    w = WCS(h["IMAGE"].header)
    x, y = w.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))
    ww = WCS(h["IMAGE"].header, fobj=h, key="W"); ww.sip = None
    lam, dlam = ww.pixel_to_world(x, y)
    return float(x), float(y), float(lam.to(u.um).value), float(dlam.to(u.um).value)


# ---------------- R Dra ----------------
rdra = sesame("R Dra")
t0 = time.time(); ex = exposures(rdra["ra"], rdra["dec"], "SPHEREx-D2", 0.05); out["tap_seconds"] = round(time.time() - t0, 1)
mjd = np.asarray(ex["mjd"], float)
out["rdra_d2_mjd"] = [round(m, 3) for m in mjd]

# 1) HDU panels from the first exposure
h0 = fits.open(fetch(ex["uri"][0], "rdra_D2_0.fits"))
panels = {}
for name in ["IMAGE", "ZODI", "VARIANCE"]:
    d = h0[name].data.astype(float)
    panels[name] = png(d, np.nanpercentile(d, 1), np.nanpercentile(d, 99.5))
fl = h0["FLAGS"].data
panels["FLAGS"] = png(((fl & BAD_BITS) != 0).astype(float) + 0.5 * ((fl & (1 << 21)) != 0), 0, 1.5, cmap="magma")
sub = clean(h0)
panels["CLEAN"] = png(sub, np.nanpercentile(sub, 2), np.nanmax(sub), stretch="asinh")
out["panels"] = panels
hd = h0["IMAGE"].header
out["header"] = {k: hd.get(k) for k in ["DETECTOR", "OBSID", "DATE-AVG", "XPOSURE", "BUNIT", "PSF_FWHM", "OMEGA_MEDIAN",
                                        "MATCH_NSTARS", "X_SC", "Y_SC", "Z_SC", "VX_SC", "VY_SC", "VZ_SC",
                                        "SGT_LAT_MIDPT", "SGT_LON_MIDPT", "L2DQAFLG", "NSNOWSRC", "L2 SATSTRKS"]}
flag_names = {}
fh = h0["FLAGS"].header
for k in fh:
    if k.startswith("MSKN"):
        n = int(k[4:]); flag_names[n] = [fh[k], fh.get(f"MSKD{n:04d}", "")]
out["flag_names"] = flag_names
out["n_flag_pixels"] = {flag_names[b][0]: int(((fl & (1 << b)) != 0).sum()) for b in flag_names}
out["cutout_bytes"] = (CACHE / "rdra_D2_0.fits").stat().st_size

# 2) Sample 12 exposures across all visits: wavelength + flux at the target, and raw-vs-reprojected
idx = np.unique(np.linspace(0, len(ex) - 1, 12).astype(int))
t0 = time.time()
with ThreadPoolExecutor(3) as pool:
    files = list(pool.map(lambda i: fetch(ex["uri"][i], f"rdra_D2_{i}.fits"), idx))
out["parallel_download"] = {"n": len(idx), "seconds": round(time.time() - t0, 1), "threads": 3, "busy_retries": BUSY["n"]}
grid, shape = target_grid(rdra["ra"], rdra["dec"])
samples = []
for i, f in zip(idx, files):
    h = fits.open(f)
    x, y, lam, dlam = lam_at(h, rdra["ra"], rdra["dec"])
    img = clean(h, BAD_BITS)
    xi, yi = int(round(x)), int(round(y))
    box = img[yi - 2:yi + 3, xi - 2:xi + 3]
    omega_sr = h["IMAGE"].header["OMEGA_MEDIAN"] / 206264.806 ** 2
    flux_mjy = float(np.nansum(box) * omega_sr * 1e9)
    sat = int((h["FLAGS"].data[yi - 1:yi + 2, xi - 1:xi + 2] & ((1 << 1) | (1 << 15))).any())
    samples.append(dict(i=int(i), mjd=float(mjd[i]), lam=round(lam, 4), dlam=round(dlam, 4), flux_mjy=round(flux_mjy, 1), sat=sat))
out["rdra_samples"] = samples

# raw vs reprojected for two exposures from different visits
a, b = idx[0], idx[-1]
ha, hb = fits.open(CACHE / f"rdra_D2_{a}.fits"), fits.open(CACHE / f"rdra_D2_{b}.fits")
ia, ib = clean(ha), clean(hb)
lo, hi = np.nanpercentile(np.r_[ia.ravel(), ib.ravel()], 2), np.nanmax(np.r_[ia.ravel(), ib.ravel()])
ra_, _ = reproject_interp((ia, WCS(ha["IMAGE"].header)), grid, shape_out=shape)
rb_, _ = reproject_interp((ib, WCS(hb["IMAGE"].header)), grid, shape_out=shape)
out["rotation"] = {"raw": [png(ia, lo, hi, stretch="asinh"), png(ib, lo, hi, stretch="asinh")], "aligned": [png(ra_, lo, hi, stretch="asinh"), png(rb_, lo, hi, stretch="asinh")],
                   "dates": [Time(mjd[a], format="mjd").iso[:10], Time(mjd[b], format="mjd").iso[:10]]}

# ---------------- Barnard's Star: first vs last exposure ----------------
bar = sesame("Barnard's Star")
mid = pos_at(bar, 61070)
exb = exposures(mid.ra.deg, mid.dec.deg, "SPHEREx-D2", 0.07)
mb = np.asarray(exb["mjd"], float)
out["barnard_n_d2"] = len(exb)
ends = [0, len(exb) - 1]
grid_b, shape_b = target_grid(mid.ra.deg, mid.dec.deg, n=35)
frames, preds = [], []
for k in ends:
    h = fits.open(fetch(exb["uri"][k], f"barnard_D2_{k}.fits"))
    r, _ = reproject_interp((clean(h), WCS(h["IMAGE"].header)), grid_b, shape_out=shape_b)
    frames.append(r)
    p = pos_at(bar, mb[k]); px, py = grid_b.world_to_pixel(p)
    _, _, lam, _ = lam_at(h, p.ra.deg, p.dec.deg)
    preds.append(dict(x=float(px), y=float(py), date=Time(mb[k], format="mjd").iso[:10], lam=round(lam, 3)))
lo, hi = np.nanpercentile(np.r_[frames[0].ravel(), frames[1].ravel()], 2), np.nanmax(np.r_[frames[0].ravel(), frames[1].ravel()])
out["barnard"] = {"frames": [png(f, lo, hi, stretch="asinh") for f in frames], "pred": preds, "n": 35,
                  "shift_arcsec": round(float(np.hypot(preds[1]["x"] - preds[0]["x"], preds[1]["y"] - preds[0]["y"]) * 0.00170 * 3600), 1)}
diff = frames[1] - frames[0]
s = np.nanpercentile(np.abs(diff), 99.5)
out["barnard"]["diff"] = png(diff, -s, s, cmap="RdBu_r", bad=(0.5, 0.5, 0.5))

OUT.write_text(json.dumps(out))
print("ok", OUT, OUT.stat().st_size, "bytes")
print(json.dumps({k: out[k] for k in ["tap_seconds", "parallel_download", "barnard_n_d2"]}))
print(json.dumps(out["rdra_samples"]))
print(json.dumps(out["barnard"]["pred"]), out["barnard"]["shift_arcsec"])
