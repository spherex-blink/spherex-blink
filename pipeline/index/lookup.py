"""Point lookup against the static sky index (the browser will do the same with fetch()).

    from pipeline.index.lookup import SkyIndex
    rows = SkyIndex().covering(248.1676, 66.7550)      # list of dicts, sorted by time
Written with Claude Code.
"""
import json
from functools import lru_cache
from pathlib import Path

import numpy as np
from astropy_healpix import HEALPix
import astropy.units as u

ROOT = Path("data/index/sky")


def _gnomonic(ra0, dec0, ra, dec):
    """Project (ra, dec) onto the tangent plane at (ra0, dec0); degrees in, tangent-plane units out."""
    ra0, dec0, ra, dec = map(np.radians, (ra0, dec0, np.asarray(ra, float), np.asarray(dec, float)))
    cosc = np.sin(dec0) * np.sin(dec) + np.cos(dec0) * np.cos(dec) * np.cos(ra - ra0)
    x = np.cos(dec) * np.sin(ra - ra0) / cosc
    y = (np.cos(dec0) * np.sin(dec) - np.sin(dec0) * np.cos(dec) * np.cos(ra - ra0)) / cosc
    return x, y


def point_in_footprint(ra, dec, corners):
    """corners = [ra1,dec1,...,ra4,dec4]. Great-circle edges are straight lines in the gnomonic projection,
    so a 2D point-in-convex-quad test there is exact."""
    cra = np.mean(corners[0::2]) if np.ptp(corners[0::2]) < 180 else ra
    cdec = np.mean(corners[1::2])
    px, py = _gnomonic(cra, cdec, ra, dec)
    qx, qy = _gnomonic(cra, cdec, corners[0::2], corners[1::2])
    s = [np.sign((qx[(i + 1) % 4] - qx[i]) * (py - qy[i]) - (qy[(i + 1) % 4] - qy[i]) * (px - qx[i])) for i in range(4)]
    return bool(all(v >= 0 for v in s) or all(v <= 0 for v in s))


class SkyIndex:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        self.meta = json.loads((self.root / "meta.json").read_text())
        self.hp = HEALPix(nside=self.meta["nside"], order="nested")
        self.dir = self.root / f"o{self.meta['order']}"

    @lru_cache(maxsize=4096)
    def _cell(self, c):
        p = self.dir / f"{c}.json"
        return json.loads(p.read_text()) if p.exists() else None

    def covering(self, ra, dec, t_range=None, detectors=None):
        c = int(self.hp.lonlat_to_healpix(ra * u.deg, dec * u.deg))
        out = []
        foot_r = self.meta.get("foot_r_deg", 2.7)
        for n in self.meta["near"][c]:
            rec = self._cell(n)
            if rec is None:
                continue
            # cheap vectorised pre-filter: a footprint can only contain P if its centre is within foot_r of P
            r1, d1 = np.radians(ra), np.radians(dec)
            r2, d2 = np.radians(np.asarray(rec["ra"])), np.radians(np.asarray(rec["dec"]))
            cosd = np.sin(d1) * np.sin(d2) + np.cos(d1) * np.cos(d2) * np.cos(r2 - r1)
            for i in np.nonzero(cosd >= np.cos(np.radians(foot_r)))[0]:
                if t_range and not (t_range[0] <= rec["t"][i] < t_range[1]):
                    continue
                if detectors and rec["det"][i] not in detectors:
                    continue
                if point_in_footprint(ra, dec, rec["corners"][i]):
                    out.append({k: rec[k][i] for k in rec})
        out.sort(key=lambda r: r["t"])
        return out
