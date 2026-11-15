"""Step 5: north-up, object-centred, background-subtracted NEOSSat cutouts (the browser can't read CADC: no CORS).

    from pipeline.neossat.cutouts import neossat_cutout
    img, tpx = neossat_cutout(pos_row, n=61, pix_arcsec=3.0)        # native-ish 3"/px
    img, tpx = neossat_cutout(pos_row, n=61, pix_arcsec=6.15)       # on SPHEREx's grid (for side-by-side pairs)

Grid convention = the SPHEREx library's (pipeline.quickblink.target_grid): TAN, centred on the object's NEOSSat-centred
position, north up, east left, row 0 = south. Uses the Gaia-refitted WCS from positions.py (the header WCS is ~44" off).
Written with Claude Code.
"""
import numpy as np
from astropy.wcs import WCS
from reproject import reproject_interp

from pipeline.neossat.positions import background, load


def grid(ra, dec, n, pix_arcsec):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-pix_arcsec / 3600, pix_arcsec / 3600]
    return w


def fitted_wcs(row, w):
    nw = w.deepcopy()
    f = row["wcs_fit"]
    nw.wcs.crpix = f["crpix"]
    if f["cd"] is not None:
        nw.wcs.cd = np.array(f["cd"])
    return nw


def neossat_cutout(row, n=61, pix_arcsec=3.0, cache=None):
    """(image float32 n x n, background-subtracted counts per NEOSSat pixel (flux-conserving: scaled by the pixel-area ratio),
    target pixel (x, y) on the grid). `cache` = optional dict to reuse (res, wcs) per image."""
    key = row["image"]
    if cache is not None and key in cache:
        res, w = cache[key]
    else:
        data, hdr, w0, _ = load(key)
        bg, _ = background(data)
        res, w = data - bg, fitted_wcs(row, w0)
        if cache is not None:
            cache[key] = (res, w)
    g = grid(row["ra_neossat"], row["dec_neossat"], n, pix_arcsec)
    # cut a sub-image first (reproject is slow on 1024^2), generous margin for any rotation
    x, y = (float(v) for v in w.all_world2pix([[row["ra_neossat"], row["dec_neossat"]]], 0)[0])
    m = int(np.ceil(n * pix_arcsec / 3.0 * 0.75)) + 4
    xi, yi = int(round(x)), int(round(y))
    y0, y1 = max(0, yi - m), min(res.shape[0], yi + m + 1)
    x0, x1 = max(0, xi - m), min(res.shape[1], xi + m + 1)
    sub = res[y0:y1, x0:x1]
    ws = w.slice((slice(y0, y1), slice(x0, x1)))
    img, foot = reproject_interp((sub, ws), g, shape_out=(n, n), order="bilinear")
    img[foot == 0] = np.nan
    img *= (pix_arcsec / 3.0) ** 2            # keep counts per output pixel ~ flux-conserving
    tx, ty = (float(v) for v in g.all_world2pix([[row["ra_neossat"], row["dec_neossat"]]], 0)[0])
    return img.astype(np.float32), (tx, ty)
