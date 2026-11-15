"""Cheap per-file facts and fast cutouts for SPHEREx level-2 images on S3.

fetch_header_facts: one Range request (first 40 KiB) -> compact JSON-able dict.
wcs_from_facts:     rebuild the SIP WCS from that dict.
cutout:             one Range request for just the IMAGE rows around (ra, dec).
"""
import re

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS

BASE = "https://nasa-irsa-spherex.s3.amazonaws.com/"
_SIP_RE = re.compile(r"^(A|B|AP|BP)_\d+_\d+$")
_SIP_ORD = ("A_ORDER", "B_ORDER", "AP_ORDER", "BP_ORDER")
_LIN = ("CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "PC1_1", "PC1_2", "PC2_1", "PC2_2",
        "CDELT1", "CDELT2", "CTYPE1", "CTYPE2")


def _get(key, start, end, session, tries=4):
    """One Range request to NASA's S3, retried with back-off on dropped connections / 5xx (seen 14.11 on long runs)."""
    import time
    s = session or requests
    for i in range(tries):
        try:
            r = s.get(BASE + key, headers={"Range": f"bytes={start}-{end}"}, timeout=60)
            if r.status_code in (200, 206):
                return r.content
            if r.status_code < 500:
                raise IOError(f"HTTP {r.status_code} for {key}")
        except (requests.ConnectionError, requests.Timeout):
            if i == tries - 1:
                raise
        time.sleep(1.5 * (i + 1))
    raise IOError(f"S3 kept failing for {key}")


def _split_headers(buf):
    """Return ([Header, Header], end_offset) for the first two HDUs, or None if END missing."""
    pos, hdrs = 0, []
    while len(hdrs) < 2:
        i = pos
        while True:
            blk = buf[i:i + 2880]
            if len(blk) < 2880:
                return None
            i += 2880
            if any(blk[j:j + 8] == b"END     " for j in range(0, 2880, 80)):
                break
        hdrs.append(fits.Header.fromstring(buf[pos:i].decode("ascii")))
        pos = i
    return hdrs, pos


def fetch_header_facts(key, session=None, nbytes=40960):
    buf = _get(key, 0, nbytes - 1, session)
    res = _split_headers(buf)
    while res is None:                      # END not inside what we have: extend
        nbytes *= 2
        buf = _get(key, 0, nbytes - 1, session)
        res = _split_headers(buf)
    (prim, h), datloc = res
    f = {"key": key, "image_datloc": datloc, "naxis1": h["NAXIS1"], "naxis2": h["NAXIS2"],
         "detector": h.get("DETECTOR"), "mjd_avg": h.get("MJD-AVG"),
         "date_avg": h.get("DATE-AVG"), "xposure": h.get("XPOSURE")}
    for k in _LIN:
        f[k] = h[k]
    for k in ("CRPIX1A", "CRPIX2A"):
        if k in h:
            f[k] = h[k]
    sip = {k: h[k] for k in h.keys() if _SIP_RE.match(k) or k in _SIP_ORD}
    f["sip"] = sip
    return f


def wcs_from_facts(facts):
    h = fits.Header()
    h["WCSAXES"] = 2
    for k in _LIN:
        h[k] = facts[k]
    h["CUNIT1"] = h["CUNIT2"] = "deg"
    for k, v in facts["sip"].items():
        h[k] = v
    return WCS(h)


def cutout(key, facts, ra, dec, half=14, session=None):
    """Return (float32 array, (x0, y0)) with x0,y0 the 0-based raw-pixel corner, or None."""
    w = wcs_from_facts(facts)
    # all_world2pix applies the full SIP distortion. wcs_world2pix ignores it and was measured 1-3.9 px off on
    # Barnard's Star (all_world2pix: 0.1-0.45 px). Never use wcs_world2pix for positions.
    px, py = (float(v[0]) for v in w.all_world2pix([ra], [dec], 0))
    n1, n2 = facts["naxis1"], facts["naxis2"]
    x, y = int(round(px)), int(round(py))
    if not (0 <= x < n1 and 0 <= y < n2):
        return None
    x0, x1 = max(0, x - half), min(n1, x + half + 1)
    y0, y1 = max(0, y - half), min(n2, y + half + 1)
    d = facts["image_datloc"]
    raw = _get(key, d + y0 * n1 * 4, d + y1 * n1 * 4 - 1, session)
    a = np.frombuffer(raw, dtype=">f4").reshape(y1 - y0, n1)[:, x0:x1]
    return a.astype(np.float32), (x0, y0)
