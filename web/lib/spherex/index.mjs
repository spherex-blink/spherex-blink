// SPHEREx browser data layer: sky-index lookup -> visits -> frame choice -> S3 cutouts -> reprojection onto one grid.
// Mirrors pipeline/quickblink.py + pipeline/index/lookup.py. No dependencies; browser and Node 18+.
// Written with Claude Code.
import { fetchHeader, fetchCutout, worldToPixel, roundHalfEven, parseFitsHeaders, BASE } from "./spherex.mjs";

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const PIX_ARCSEC = 6.15, PIX_DEG = PIX_ARCSEC / 3600;
const VISIT_GAP_DAYS = 30;
const MJD_J2000 = 51544.5;
const MJD_MID_SURVEY = 61050;

// ---------------------------------------------------------------- HEALPix (nested), ang2pix
function spreadBits(v) {             // interleave zeros between the bits of v (v < 2^16)
  let r = 0;
  for (let b = 0; b < 16; b++) r += ((v >> b) & 1) * Math.pow(4, b);
  return r;
}

export function healpixNested(nside, ra, dec) {
  const z = Math.sin(dec * D2R), za = Math.abs(z);
  let phi = (ra * D2R) % (2 * Math.PI); if (phi < 0) phi += 2 * Math.PI;
  const tt = phi / (Math.PI / 2);   // [0,4)
  let face, ix, iy;
  if (za <= 2 / 3) {
    const t1 = nside * (0.5 + tt), t2 = nside * z * 0.75;
    const jp = Math.floor(t1 - t2), jm = Math.floor(t1 + t2);
    const ifp = Math.floor(jp / nside), ifm = Math.floor(jm / nside);
    face = ifp === ifm ? (ifp | 4) : (ifp < ifm ? ifp : ifm + 8);
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    const ntt = Math.min(Math.floor(tt), 3), tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(Math.floor(tp * tmp), nside - 1), jm = Math.min(Math.floor((1 - tp) * tmp), nside - 1);
    if (z >= 0) { face = ntt; ix = nside - jm - 1; iy = nside - jp - 1; }
    else { face = ntt + 8; ix = jp; iy = jm; }
  }
  return face * nside * nside + spreadBits(ix) + 2 * spreadBits(iy);
}

// ---------------------------------------------------------------- footprint test (gnomonic, as lookup.py)
function gnomonic(ra0, dec0, ra, dec) {
  ra0 *= D2R; dec0 *= D2R; ra *= D2R; dec *= D2R;
  const cosc = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
  return [Math.cos(dec) * Math.sin(ra - ra0) / cosc,
    (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosc];
}

export function pointInFootprint(ra, dec, c) {
  let rmin = Infinity, rmax = -Infinity, rsum = 0, dsum = 0;
  for (let i = 0; i < 4; i++) {
    rmin = Math.min(rmin, c[2 * i]); rmax = Math.max(rmax, c[2 * i]); rsum += c[2 * i]; dsum += c[2 * i + 1];
  }
  const cra = rmax - rmin < 180 ? rsum / 4 : ra, cdec = dsum / 4;
  const [px, py] = gnomonic(cra, cdec, ra, dec);
  const q = [0, 1, 2, 3].map((i) => gnomonic(cra, cdec, c[2 * i], c[2 * i + 1]));
  let pos = true, neg = true;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const s = Math.sign((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]));
    if (s < 0) pos = false;
    if (s > 0) neg = false;
  }
  return pos || neg;
}

// ---------------------------------------------------------------- sky index
export class SkyIndex {
  constructor(baseUrl, meta, fetchImpl) {
    this.base = baseUrl; this.meta = meta; this._fetch = fetchImpl; this._cells = new Map();
  }

  static async load(baseUrl, { fetchImpl } = {}) {
    const f = fetchImpl || globalThis.fetch.bind(globalThis);
    const base = String(baseUrl).endsWith("/") ? String(baseUrl) : baseUrl + "/";
    const r = await f(base + "meta.json");
    if (!r.ok) throw new Error(`Could not load the SPHEREx sky index (HTTP ${r.status})`);
    return new SkyIndex(base, await r.json(), f);
  }

  cellOf(ra, dec) { return healpixNested(this.meta.nside, ra, dec); }

  _cell(n) {
    let p = this._cells.get(n);
    if (!p) {
      p = (async () => {
        const r = await this._fetch(`${this.base}o${this.meta.order}/${n}.json`);
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`Sky index cell ${n}: HTTP ${r.status}`);
        return r.json();
      })();
      p.catch(() => this._cells.delete(n));
      this._cells.set(n, p);
    }
    return p;
  }

  async covering(ra, dec) {
    const c = this.cellOf(ra, dec);
    const recs = await Promise.all(this.meta.near[c].map((n) => this._cell(n)));
    const footR = this.meta.foot_r_deg ?? 2.7, cosLim = Math.cos(footR * D2R);
    const r1 = ra * D2R, d1 = dec * D2R, sd1 = Math.sin(d1), cd1 = Math.cos(d1);
    const out = [];
    for (const rec of recs) {
      if (!rec) continue;
      const keys = Object.keys(rec);
      for (let i = 0; i < rec.ra.length; i++) {
        const d2 = rec.dec[i] * D2R;
        const cosd = sd1 * Math.sin(d2) + cd1 * Math.cos(d2) * Math.cos(rec.ra[i] * D2R - r1);
        if (cosd < cosLim) continue;
        if (!pointInFootprint(ra, dec, rec.corners[i])) continue;
        const row = {};
        for (const k of keys) row[k] = rec[k][i];
        out.push(row);
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
}

// ---------------------------------------------------------------- visits and frame choice
export function groupVisits(rows) {
  const visits = [];
  let cur = [];
  for (const r of rows) {
    if (cur.length && (r.t - cur[cur.length - 1].t > VISIT_GAP_DAYS || r.t - cur[0].t > VISIT_GAP_DAYS)) {
      visits.push(cur); cur = [];
    }
    cur.push(r);
  }
  if (cur.length) visits.push(cur);
  const merged = [];
  for (const v of visits) {
    const prev = merged[merged.length - 1];
    if (prev && v.length < 0.2 * prev.length && v[0].t - prev[prev.length - 1].t <= VISIT_GAP_DAYS) {
      merged[merged.length - 1] = prev.concat(v);
    } else merged.push(v);
  }
  return merged;
}

// detector: "auto"/null or 1..6. which: "ends" (first + last visit CONTAINING the detector) or "visits"/"all".
// Mirrors quickblink.pick(): auto prefers long wavelengths (6,5,4,3,2,1), first detector present in >= 2 visits
// (>= 1 if there is only one visit), else the one in most visits. Every frame carries `visit` (index into the chosen visits).
export const AUTO_DETECTOR_ORDER = [6, 5, 4, 3, 2, 1];
export function pickFrames(visits, { detector = "auto", perVisit = 1, which = "ends" } = {}) {
  let det = detector === "auto" || detector == null ? null : Number(detector);
  if (det == null) {
    const nVis = (d) => visits.filter((v) => v.some((r) => r.det === d)).length;
    const need = visits.length > 1 ? 2 : 1;
    det = AUTO_DETECTOR_ORDER.find((d) => nVis(d) >= need);
    if (det == null) {
      let best = -1;
      for (const d of AUTO_DETECTOR_ORDER) { const c = nVis(d); if (c > best) { best = c; det = d; } }
    }
  }
  const withDet = visits.filter((v) => v.some((r) => r.det === det));
  const chosen = which === "ends" && withDet.length > 1 ? [withDet[0], withDet[withDet.length - 1]] : withDet;
  const frames = [];
  chosen.forEach((v, vi) => {
    const cand = v.filter((r) => r.det === det);     // never fall back to another detector
    if (!cand.length) return;
    const idx = new Set();
    for (let i = 0; i < perVisit; i++) {
      const val = perVisit === 1 ? 0 : i === perVisit - 1 ? cand.length - 1 : i * ((cand.length - 1) / (perVisit - 1));
      idx.add(roundHalfEven(val));
    }
    for (const i of [...idx].sort((a, b) => a - b)) frames.push({ ...cand[i], visit: vi });
  });
  return { frames, detector: det };
}

// ---------------------------------------------------------------- proper motion
// 3D unit-vector + tangential velocity propagation (no distance, no RV), as astropy apply_space_motion.
export function positionAt(ra, dec, pm, mjd) {
  if (!pm) return [ra, dec];
  const dt = (mjd - MJD_J2000) / 365.25;                        // Julian years
  const mas = D2R / 3.6e6;
  const a = ra * D2R, d = dec * D2R;
  const sa = Math.sin(a), ca = Math.cos(a), sd = Math.sin(d), cd = Math.cos(d);
  const px = cd * ca, py = cd * sa, pz = sd;
  const vE = pm[0] * mas, vN = pm[1] * mas;                      // pm_ra_cosdec, pm_dec  (rad/yr)
  const vx = -sa * vE - sd * ca * vN, vy = ca * vE - sd * sa * vN, vz = cd * vN;
  const x = px + vx * dt, y = py + vy * dt, z = pz + vz * dt;
  let r = Math.atan2(y, x) * R2D; if (r < 0) r += 360;
  return [r, Math.atan2(z, Math.hypot(x, y)) * R2D];
}

// ---------------------------------------------------------------- wavelength (WAVE-TAB lookup, key "W")
function locate(vec, v) {            // fractional 0-based index of v in monotonic vector (clamped, like wcslib tab extrapolation-free)
  const n = vec.length;
  if (v <= vec[0]) return 0;
  if (v >= vec[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (vec[m] <= v) lo = m; else hi = m; }
  return lo + (v - vec[lo]) / (vec[hi] - vec[lo]);
}

// hdr: result of fetchHeader(); x, y: 0-based raw detector pixel. calib: {X,Y,VALUES} for this detector, or {1:{...},...}.
export function wavelengthAt(hdr, det, x, y, calib) {
  const t = calib.X ? calib : calib[det];
  const h = hdr.image ?? hdr;
  const psi = [1, 2].map((i) => {
    const p = i === 1 ? x + 1 : y + 1;
    return (h[`CRVAL${i}W`] ?? 0) + (h[`CDELT${i}W`] ?? 1) * (p - (h[`CRPIX${i}W`] ?? 0));
  });
  const fi = locate(t.X, psi[0]), fj = locate(t.Y, psi[1]);
  const i0 = Math.min(Math.floor(fi), t.X.length - 2), j0 = Math.min(Math.floor(fj), t.Y.length - 2);
  const a = fi - i0, b = fj - j0;
  const out = [1, 2].map((k) => {
    const m = (h[`PV${k}_3W`] ?? k) - 1;
    const V = (j, i) => t.VALUES[j][i][m];
    return (1 - b) * ((1 - a) * V(j0, i0) + a * V(j0, i0 + 1)) + b * ((1 - a) * V(j0 + 1, i0) + a * V(j0 + 1, i0 + 1));
  });
  return { lambda_um: out[0], dlambda_um: out[1] };
}

const _calib = new Map();
async function loadCalib(det, calibBaseUrl, fetchImpl) {
  const base = calibBaseUrl ? String(calibBaseUrl) : new URL("./calib/", import.meta.url).href;
  const url = (base.endsWith("/") ? base : base + "/") + `wcs_wave_D${det}.json`;
  if (!_calib.has(url)) {
    _calib.set(url, (async () => {
      if (url.startsWith("file:")) {
        const fs = await import("node:fs/promises");
        return JSON.parse(await fs.readFile(new URL(url), "utf8"));
      }
      const r = await (fetchImpl || globalThis.fetch.bind(globalThis))(url);
      if (!r.ok) throw new Error(`Wavelength table D${det}: HTTP ${r.status}`);
      return r.json();
    })());
    _calib.get(url).catch(() => _calib.delete(url));
  }
  return _calib.get(url);
}

// ---------------------------------------------------------------- reprojection
function abortError() {
  const e = new Error("Aborted"); e.name = "AbortError"; return e;
}

// Output grid pixel (0-based col i, row j) -> sky, TAN centred on (ra0, dec0), cdelt = (-PIX_DEG, +PIX_DEG).
function makeGrid(ra0, dec0, n) {
  const crpix = (n + 1) / 2, a0 = ra0 * D2R, d0 = dec0 * D2R, s0 = Math.sin(d0), c0 = Math.cos(d0);
  return {
    toWorld(i, j) {
      const xi = -PIX_DEG * (i + 1 - crpix) * D2R, eta = PIX_DEG * (j + 1 - crpix) * D2R;
      const t = c0 - eta * s0;
      return [(a0 + Math.atan2(xi, t)) * R2D, Math.atan2(s0 + eta * c0, Math.hypot(xi, t)) * R2D];
    },
    toPixel(ra, dec) {
      const a = ra * D2R, d = dec * D2R, da = a - a0;
      const D = s0 * Math.sin(d) + c0 * Math.cos(d) * Math.cos(da);
      const xi = R2D * Math.cos(d) * Math.sin(da) / D;
      const eta = R2D * (c0 * Math.sin(d) - s0 * Math.cos(d) * Math.cos(da)) / D;
      return [xi / -PIX_DEG + crpix - 1, eta / PIX_DEG + crpix - 1];
    },
  };
}

// Output pixel -> raw detector pixel for the whole n x n grid. The exact SIP Newton solve (worldToPixel) is run on a coarse
// sub-grid (every `step` px plus the last row/column) and the raw coordinates are interpolated in between with a separable
// cubic Lagrange stencil (4 nearest nodes, shifted at the borders). The mapping is very smooth; measured error vs the exact
// solve is reported by test 13. (Plain bilinear was tried first: 4e-5 px error, but that moved pixels next to bright stars
// by up to 1.8e-3 relative, above the existing test tolerance.) step 1 = exact everywhere.
export const MAP_STEP = 8;
function lagrangeStencils(nodes, n) {          // per output index: first node of the stencil and k weights
  const m = nodes.length, k = Math.min(4, m);
  const start = new Int32Array(n), w = new Float64Array(n * k);
  for (let i = 0, s = 0; i < n; i++) {
    while (s < m - 2 && i > nodes[s + 1]) s++;
    const s0 = Math.max(0, Math.min(m - k, s - (k >= 4 ? 1 : 0)));
    start[i] = s0;
    for (let a = 0; a < k; a++) {
      let l = 1;
      for (let b = 0; b < k; b++) if (b !== a) l *= (i - nodes[s0 + b]) / (nodes[s0 + a] - nodes[s0 + b]);
      w[i * k + a] = l;
    }
  }
  return { start, w, k };
}
export function buildPixelMap(hdr, grid, n, step = MAP_STEP) {
  if (step <= 1) {
    const rx = new Float64Array(n * n), ry = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const [ra, dec] = grid.toWorld(i, j);
      [rx[j * n + i], ry[j * n + i]] = worldToPixel(hdr, ra, dec);
    }
    return { rx, ry };
  }
  const nodes = [];
  for (let i = 0; i < n - 1; i += step) nodes.push(i);
  nodes.push(n - 1);
  const m = nodes.length, cx = new Float64Array(m * m), cy = new Float64Array(m * m);
  for (let b = 0; b < m; b++) for (let a = 0; a < m; a++) {
    const [ra, dec] = grid.toWorld(nodes[a], nodes[b]);
    [cx[b * m + a], cy[b * m + a]] = worldToPixel(hdr, ra, dec);
  }
  const { start, w, k } = lagrangeStencils(nodes, n);
  // pass 1: along columns (i) on each coarse row; pass 2: along rows (j)
  const tx = new Float64Array(m * n), ty = new Float64Array(m * n);
  for (let b = 0; b < m; b++) for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0;
    for (let a = 0; a < k; a++) { const wt = w[i * k + a], q = b * m + start[i] + a; sx += wt * cx[q]; sy += wt * cy[q]; }
    tx[b * n + i] = sx; ty[b * n + i] = sy;
  }
  const rx = new Float64Array(n * n), ry = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0;
    for (let a = 0; a < k; a++) { const wt = w[j * k + a], q = (start[j] + a) * n + i; sx += wt * tx[q]; sy += wt * ty[q]; }
    rx[j * n + i] = sx; ry[j * n + i] = sy;
  }
  return { rx, ry };
}

// Bilinear, NaN if any neighbour is NaN or the point is outside the cutout (scipy map_coordinates order=1).
function reproject(hdr, cut, grid, n, step = MAP_STEP) {
  const out = new Float32Array(n * n).fill(NaN);
  const { data, width, height, x0, y0 } = cut;
  const { rx, ry } = buildPixelMap(hdr, grid, n, step);
  const wm2 = width - 2 < 0 ? 0 : width - 2, hm2 = height - 2 < 0 ? 0 : height - 2;
  for (let p = 0; p < n * n; p++) {
    let cx = rx[p] - x0, cy = ry[p] - y0;
    // reproject accepts points up to half a pixel outside the edge pixel centres (edge value replicated)
    if (!(cx >= -0.5 && cx <= width - 0.5 && cy >= -0.5 && cy <= height - 0.5)) continue;
    cx = Math.min(Math.max(cx, 0), width - 1); cy = Math.min(Math.max(cy, 0), height - 1);
    const ix = Math.min(Math.floor(cx), wm2), iy = Math.min(Math.floor(cy), hm2);
    const fx = cx - ix, fy = cy - iy;
    const ix1 = Math.min(ix + 1, width - 1), iy1 = Math.min(iy + 1, height - 1);
    const v00 = data[iy * width + ix], v01 = data[iy * width + ix1];
    const v10 = data[iy1 * width + ix], v11 = data[iy1 * width + ix1];
    out[p] = (1 - fy) * ((1 - fx) * v00 + fx * v01) + fy * ((1 - fx) * v10 + fx * v11);
  }
  return out;
}
export { makeGrid as _makeGrid };

// ---------------------------------------------------------------- stacking (mirrors quickblink.stack_frames)
const f32 = Math.fround;
function medianOfSorted(a, k) {          // a sorted ascending, first k entries; numpy median (mean of the two middles)
  if (k === 0) return NaN;
  const h = k >> 1;
  return k % 2 ? a[h] : f32(f32(a[h - 1] + a[h]) * 0.5);
}
function nanMedian(data) {
  const v = new Float32Array(data.length);
  let k = 0;
  for (let i = 0; i < data.length; i++) { const x = data[i]; if (x === x) v[k++] = x; }
  const s = v.subarray(0, k).sort();
  return medianOfSorted(s, k);
}

// datas: aligned Float32Arrays of one visit. Each has its own median removed; then per pixel a 3-sigma clipped mean around
// the per-pixel median (sigma = 1.4826 MAD; sigma 0 keeps all) when >= 3 exposures, else the plain nan-mean.
export function stackData(datas) {
  const m = datas.length, len = datas[0].length;
  const subs = datas.map((d) => { const md = nanMedian(d), o = new Float32Array(len); for (let i = 0; i < len; i++) o[i] = f32(d[i] - md); return o; });
  const out = new Float32Array(len).fill(NaN);
  const buf = new Float32Array(m), dev = new Float32Array(m), tmp = new Float32Array(m);
  for (let p = 0; p < len; p++) {
    let k = 0;
    for (let e = 0; e < m; e++) { const v = subs[e][p]; if (v === v) buf[k++] = v; }
    if (!k) continue;
    let sum = 0, cnt = 0;
    if (m >= 3) {
      tmp.set(buf.subarray(0, k)); const med = medianOfSorted(tmp.subarray(0, k).sort(), k);
      for (let e = 0; e < k; e++) dev[e] = f32(Math.abs(f32(buf[e] - med)));
      tmp.set(dev.subarray(0, k)); const sig = f32(medianOfSorted(tmp.subarray(0, k).sort(), k) * 1.4826);
      const lim = sig > 0 ? f32(3 * sig) : Infinity;
      for (let e = 0; e < k; e++) if (dev[e] <= lim) { sum += buf[e]; cnt++; }
    } else { for (let e = 0; e < k; e++) sum += buf[e]; cnt = k; }
    if (cnt) out[p] = f32(sum / cnt);
  }
  return out;
}

// ---------------------------------------------------------------- getBlink
// exposure time (XPOSURE, s) and geocentric spacecraft position at mid-exposure (X_SC, Y_SC, Z_SC, km) from the image header; null if absent
function expInfo(hdr) {
  const h = hdr.image, num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const sc = [num(h.X_SC), num(h.Y_SC), num(h.Z_SC)];
  return { exptime_s: num(h.XPOSURE), sc_pos_km: sc.every((v) => v !== null) ? sc : null };
}
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const mjdToDate = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);

// Options: ra, dec, pm [mas/yr], detector "auto"|1..6, half (field of view, 5..150 px of 6.15"),
//   frames "visits" (default: one frame per visit) | "ends" (first + last visit) | "exposures" (every exposure, unstacked),
//   stack N exposures per visit combined into one frame (default 8; 0/1 = off), mode "sky" (fixed grid) | "track" (grid follows target),
//   maxFrames (exposures mode, default 120), perVisit, onFrame(frame, done, total), signal, fetchImpl, calibBaseUrl, name.
export async function getBlink(index, opts = {}) {
  const {
    ra, dec, pm = null, detector = "auto", frames: which = "visits", perVisit = 1, mode = "sky", maxFrames = 120,
    onFrame, signal, fetchImpl, calibBaseUrl, name,
  } = opts;
  const stackReq = Math.max(0, Math.round(Number(opts.stack ?? 8)) || 0);
  const stack = which === "exposures" || stackReq < 2 ? 0 : stackReq;
  if (!["visits", "ends", "exposures", "all"].includes(which)) throw new Error(`Unknown frames option "${which}"`);
  if (!["sky", "track"].includes(mode)) throw new Error(`Unknown mode "${mode}"`);
  let half = clamp(Math.round(opts.half ?? 30), 5, 150);
  const now = () => (globalThis.performance ? performance.now() : Date.now()) / 1000;
  const t0 = now(), tm = {};
  const check = () => { if (signal?.aborted) throw abortError(); };
  const base = fetchImpl || globalThis.fetch.bind(globalThis);
  const f = signal ? (u, init = {}) => base(u, { ...init, signal }) : base;

  check();
  const [midRa, midDec] = positionAt(ra, dec, pm, MJD_MID_SURVEY);
  let rows;
  if (mode === "track") {
    // union of the images covering the predicted track, then keep those whose footprint holds the target at their own time
    const seen = new Map();
    for (const mjd of [60790, MJD_MID_SURVEY, 61320]) {
      const [pr, pd] = positionAt(ra, dec, pm, mjd);
      for (const r of await index.covering(pr, pd)) if (!seen.has(r.key)) seen.set(r.key, r);
    }
    rows = [...seen.values()].filter((r) => { const [pr, pd] = positionAt(ra, dec, pm, r.t); return pointInFootprint(pr, pd, r.corners); });
    rows.sort((a, b) => a.t - b.t);
  } else rows = await index.covering(midRa, midDec);
  check();
  tm.lookup_s = now() - t0;
  if (!rows.length) throw new Error("No SPHEREx images cover this position yet");
  const visits = groupVisits(rows);
  let det, picks;
  if (which === "exposures") {
    det = pickFrames(visits, { detector, which: "visits" }).detector;
    picks = rows.filter((r) => r.det === det).map((r) => ({ ...r, visit: 0 }));
    if (picks.length > maxFrames) {
      const m = Math.max(1, Math.floor(maxFrames)), keep = new Set();
      for (let i = 0; i < m; i++) keep.add(roundHalfEven(m === 1 ? 0 : i * ((picks.length - 1) / (m - 1))));
      picks = [...keep].sort((a, b) => a - b).map((i) => picks[i]);
    }
  } else {
    ({ frames: picks, detector: det } = pickFrames(visits, { detector, perVisit: Math.max(perVisit, stack), which: which === "ends" ? "ends" : "visits" }));
  }
  if (!picks.length) throw new Error(`No SPHEREx images from detector D${detector} at this position; try auto`);

  // sky mode: widen the field when the target moves a lot between the first and last survey epochs
  let autoHalf = false, trackPx = 0;
  if (mode === "sky" && pm) {
    const [r1, d1] = positionAt(ra, dec, pm, 60790), [r2, d2] = positionAt(ra, dec, pm, 61320);
    const [gx, gy] = gnomonic(r1, d1, r2, d2);
    trackPx = Math.hypot(gx, gy) * R2D / PIX_DEG;
    if (trackPx > 1.5 * half) { half = Math.min(150, Math.max(half, Math.ceil(0.75 * trackPx))); autoHalf = true; }
  }

  const calibP = loadCalib(det, calibBaseUrl, fetchImpl);
  const n = 2 * half + 1, skyGrid = mode === "sky" ? makeGrid(midRa, midDec, n) : null;
  const gridInfo = mode === "sky"
    ? { n, mode, pix_arcsec: PIX_ARCSEC, center_ra: midRa, center_dec: midDec, autoHalf, track_px: Math.round(trackPx * 100) / 100,
      orientation: "row 0 = SOUTH edge, column 0 = EAST edge (north up, east left when drawn with rows flipped)" }
    : { n, mode, pix_arcsec: PIX_ARCSEC, center_ra: null, center_dec: null, autoHalf: false,
      orientation: "row 0 = SOUTH edge, column 0 = EAST edge; every frame is centred on the target's predicted position at that frame's time (background streams past)" };
  const out = [];
  let tReproject = 0, fetched = 0, emitted = 0;
  const tFetch0 = now();
  const groups = new Map();                       // visit index -> {left, parts}
  for (const r of picks) { const g = groups.get(r.visit) || { left: 0, parts: [] }; g.left++; groups.set(r.visit, g); }
  const totalFrames = stack ? groups.size : picks.length;

  function emit(frame) {
    out.push(frame);
    if (onFrame) onFrame(frame, emitted, totalFrames, { fetched, exposures: picks.length, grid: gridInfo });
    emitted++;
  }

  function combine(parts) {
    parts.sort((a, b) => a.t - b.t);
    const ts = now();
    const data = stackData(parts.map((p) => p.data));
    const mjd = mean(parts.map((p) => p.mjd));
    const tx = mean(parts.map((p) => p.targetPx[0])), ty = mean(parts.map((p) => p.targetPx[1]));
    const lams = parts.map((p) => p.lambda_um);
    const frame = {
      obs: parts[0].obs, det: parts[0].det, mjd: Math.round(mjd * 1e5) / 1e5, date: mjdToDate(mjd), key: parts[0].key, visit: parts[0].visit,
      lambda_um: Math.round(mean(lams) * 1e4) / 1e4, lambda_min_um: Math.min(...lams), lambda_max_um: Math.max(...lams),
      dlambda_um: Math.round(mean(parts.map((p) => p.dlambda_um)) * 1e4) / 1e4,
      targetPx: [tx, ty], saturatedAtTarget: nanNear(data, n, tx, ty),
      n_stack: parts.length, members: parts.map((p) => ({ obs: p.obs, key: p.key, mjd: p.mjd, exptime_s: p.exptime_s, sc_pos_km: p.sc_pos_km })),
      exptime_s: parts.every((p) => p.exptime_s != null) ? parts.reduce((a, p) => a + p.exptime_s, 0) : null,       // total of the stacked exposures
      sc_pos_km: parts.every((p) => p.sc_pos_km) ? [0, 1, 2].map((k) => mean(parts.map((p) => p.sc_pos_km[k]))) : null,   // mean of the members
      width: n, height: n, data,
    };
    tReproject += now() - ts;
    return frame;
  }

  async function one(r) {
    check();
    const hdr = await fetchHeader(r.key, { fetchImpl: f });
    const mjd = hdr.image["MJD-AVG"];
    const [pra, pdec] = positionAt(ra, dec, pm, mjd);
    const grid = skyGrid || makeGrid(pra, pdec, n);
    const [tx, ty] = grid.toPixel(pra, pdec);
    const margin = Math.max(6, Math.ceil(Math.hypot(tx - (n - 1) / 2, ty - (n - 1) / 2)) + 2);
    const cut = await fetchCutout(r.key, hdr, pra, pdec, half + margin, { fetchImpl: f });
    check();
    fetched++;
    let frame = null;
    if (cut) {
      const ts = now();
      const data = reproject(hdr, cut, grid, n);
      const [rx, ry] = worldToPixel(hdr, pra, pdec);
      const w = wavelengthAt(hdr, r.det, rx, ry, await calibP);
      frame = {
        obs: r.obs, det: r.det, t: r.t, visit: r.visit, mjd, key: r.key, lambda_um: w.lambda_um, dlambda_um: w.dlambda_um,
        targetPx: [tx, ty], data, ra: pra, dec: pdec, date: String(hdr.image["DATE-AVG"]).slice(0, 10), ...expInfo(hdr),
      };
      tReproject += now() - ts;
    }
    const g = groups.get(r.visit);
    g.left--;
    if (frame) g.parts.push(frame);
    if (stack) {
      if (g.left === 0 && g.parts.length) emit(combine(g.parts));
      else if (g.left === 0) emitted++;
    } else if (frame) {
      emit({
        obs: frame.obs, det: frame.det, visit: frame.visit, mjd: Math.round(mjd * 1e5) / 1e5, date: frame.date, key: frame.key,
        lambda_um: Math.round(frame.lambda_um * 1e4) / 1e4, dlambda_um: Math.round(frame.dlambda_um * 1e4) / 1e4,
        targetPx: [Math.round(tx * 1e3) / 1e3, Math.round(ty * 1e3) / 1e3], saturatedAtTarget: nanNear(frame.data, n, tx, ty),
        ra: pra, dec: pdec, width: n, height: n, data: frame.data, exptime_s: frame.exptime_s, sc_pos_km: frame.sc_pos_km,
      });
    } else emitted++;
  }

  const CAP = 16;
  let next = 0;
  const worker = async () => { while (next < picks.length) { const r = picks[next++]; await one(r); } };
  await Promise.all(Array.from({ length: Math.min(CAP, picks.length) }, worker));
  check();
  tm.fetch_s = now() - tFetch0 - tReproject;
  tm.reproject_s = tReproject;
  tm.total_s = now() - t0;
  out.sort((a, b) => a.mjd - b.mjd);
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    target: { name: name ?? null, ra, dec, pm_mas_yr: pm },
    options: { detector: det, detectorRequested: detector, frames: which, stack, mode, half, perVisit, maxFrames },
    n_exposures: rows.length,
    visits: visits.map((v) => ({ start_mjd: r2(v[0].t), end_mjd: r2(v[v.length - 1].t), n: v.length })),
    detector: det,
    grid: gridInfo,
    units: stack ? "MJy/sr with each exposure's own median removed before stacking (so about 0 = typical sky; zodiacal light NOT subtracted beyond that), NaN = no data"
      : "MJy/sr, zodiacal light NOT subtracted, NaN = no data (saturated core, dead pixel, off detector)",
    frames: out,
    timing_s: Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, Math.round(v * 1e3) / 1e3])),
  };
}

// ---------------------------------------------------------------- deep stack (mirrors quickblink.aperture_snr / deep_stack)
// 3x3 aperture sum at (x, y) vs the same aperture on a stride-3 grid over the rest of the image (skipping +-exclude px around
// the target and any aperture with NaN). Noise = 1.4826 * MAD of those sums. Returns [snr, flux] (flux = sum - median of sums).
export function apertureSnr(img, n, x, y, exclude = 5, stride = 3) {
  const xi = roundHalfEven(x), yi = roundHalfEven(y);
  if (xi < 1 || yi < 1 || xi > n - 2 || yi > n - 2) return [NaN, NaN];
  const sum3 = (cx, cy) => {
    let s = 0;
    for (let j = cy - 1; j <= cy + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) { const v = img[j * n + i]; if (v !== v) return NaN; s += v; }
    return s;
  };
  const ap = sum3(xi, yi);
  if (ap !== ap) return [NaN, NaN];
  const sums = [];
  for (let cy = 1; cy < n - 1; cy += stride) for (let cx = 1; cx < n - 1; cx += stride) {
    if (Math.abs(cx - xi) <= exclude && Math.abs(cy - yi) <= exclude) continue;
    const v = sum3(cx, cy);
    if (v === v) sums.push(v);
  }
  if (!sums.length) return [NaN, NaN];
  const med64 = (a) => { const b = Float64Array.from(a).sort(), k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };
  const med = med64(sums), sig = med64(sums.map((v) => Math.abs(v - med))) * 1.4826;
  return [(ap - med) / sig, ap - med];
}

// Shift-and-stack of one detector over the whole survey: every exposure is aligned on the target's predicted position at its own
// time ("track" stack: target sharp, stars smeared) and also on the fixed sky grid ("sky" stack: stars sharp, mover smeared).
// Options: ra, dec, pm, detector "auto"|1..6, half (default 30), maxExposures (default 120), onProgress(done, total), signal,
//   fetchImpl, calibBaseUrl, name.
export async function getDeepStack(index, opts = {}) {
  const { ra, dec, pm = null, detector = "auto", maxExposures = 120, onProgress, signal, fetchImpl, calibBaseUrl, name } = opts;
  const half = clamp(Math.round(opts.half ?? 30), 5, 150), n = 2 * half + 1, c = (n - 1) / 2;
  const now = () => (globalThis.performance ? performance.now() : Date.now()) / 1000;
  const t0 = now(), tm = {};
  const check = () => { if (signal?.aborted) throw abortError(); };
  const base = fetchImpl || globalThis.fetch.bind(globalThis);
  const f = signal ? (u, init = {}) => base(u, { ...init, signal }) : base;

  check();
  const seen = new Map();
  for (const mjd of [60790, MJD_MID_SURVEY, 61320]) {
    const [pr, pd] = positionAt(ra, dec, pm, mjd);
    for (const r of await index.covering(pr, pd)) if (!seen.has(r.key)) seen.set(r.key, r);
  }
  const rows = [...seen.values()].filter((r) => { const [pr, pd] = positionAt(ra, dec, pm, r.t); return pointInFootprint(pr, pd, r.corners); });
  rows.sort((a, b) => a.t - b.t);
  check();
  tm.lookup_s = now() - t0;
  if (!rows.length) throw new Error("No SPHEREx images cover this position yet");
  const counts = Object.fromEntries(AUTO_DETECTOR_ORDER.map((d) => [d, rows.filter((r) => r.det === d).length]));
  let det;
  if (detector === "auto" || detector == null) {
    det = AUTO_DETECTOR_ORDER.find((d) => counts[d] >= 10);
    if (det == null) { let best = -1; for (const d of AUTO_DETECTOR_ORDER) if (counts[d] > best) { best = counts[d]; det = d; } }
  } else {
    det = Number(detector);
    if (!(counts[det] > 0)) throw new Error(`No SPHEREx images from detector D${detector} at this position (available: ${AUTO_DETECTOR_ORDER.filter((d) => counts[d]).map((d) => "D" + d).join(", ")}); try auto`);
  }
  let sel = rows.filter((r) => r.det === det);
  if (sel.length > maxExposures) {          // numpy: np.unique(np.linspace(0, len-1, max).round().astype(int)), round half to even
    const m = Math.max(1, Math.floor(maxExposures)), stepv = m === 1 ? 0 : (sel.length - 1) / (m - 1), keep = new Set();
    for (let i = 0; i < m; i++) keep.add(roundHalfEven(i === m - 1 && m > 1 ? sel.length - 1 : i * stepv));
    sel = [...keep].sort((a, b) => a - b).map((i) => sel[i]);
  }

  const [midRa, midDec] = positionAt(ra, dec, pm, MJD_MID_SURVEY);
  const skyGrid = makeGrid(midRa, midDec, n);
  const calibP = loadCalib(det, calibBaseUrl, fetchImpl);
  const got = new Array(sel.length).fill(null);
  let done = 0, tReproject = 0;
  const tFetch0 = now();
  if (onProgress) onProgress(0, sel.length);
  async function one(i) {
    check();
    const r = sel[i];
    const hdr = await fetchHeader(r.key, { fetchImpl: f });
    const mjd = hdr.image["MJD-AVG"];
    const [pra, pdec] = positionAt(ra, dec, pm, mjd);
    const cut = await fetchCutout(r.key, hdr, pra, pdec, half + 6, { fetchImpl: f });
    check();
    if (cut) {
      const ts = now();
      const trk = reproject(hdr, cut, makeGrid(pra, pdec, n), n), sky = reproject(hdr, cut, skyGrid, n);
      const [rx, ry] = worldToPixel(hdr, pra, pdec);
      const w = wavelengthAt(hdr, r.det, rx, ry, await calibP);
      got[i] = { trk, sky, mjd, tpx: skyGrid.toPixel(pra, pdec), lam: w.lambda_um };
      tReproject += now() - ts;
    }
    done++;
    if (onProgress) onProgress(done, sel.length);
  }
  let next = 0;
  const worker = async () => { while (next < sel.length) await one(next++); };
  await Promise.all(Array.from({ length: Math.min(16, sel.length) }, worker));
  check();
  const used = got.filter(Boolean);
  if (!used.length) throw new Error("None of the SPHEREx exposures could be cut out at the target position");
  tm.fetch_s = now() - tFetch0 - tReproject;
  const ts = now();
  const track = stackData(used.map((g) => g.trk)), sky = stackData(used.map((g) => g.sky));
  const tpx = used.map((g) => g.tpx), mx = mean(tpx.map((p) => p[0])), my = mean(tpx.map((p) => p[1]));
  const [snrT, fluxT] = apertureSnr(track, n, c, c), [snrS, fluxS] = apertureSnr(sky, n, mx, my);
  tm.reproject_s = tReproject + (now() - ts);
  tm.total_s = now() - t0;
  const mjds = used.map((g) => g.mjd), lams = used.map((g) => g.lam);
  return {
    target: { name: name ?? null, ra, dec, pm_mas_yr: pm },
    detector: det, n_used: used.length, n_available: counts[det],
    mjd_range: [Math.min(...mjds), Math.max(...mjds)], n, track, sky, center_px: [c, c], sky_target_px: tpx,
    snr_track: snrT, snr_sky: snrS, flux_track: fluxT, flux_sky: fluxS, detected: snrT >= 5,
    lambda_min_um: Math.min(...lams), lambda_max_um: Math.max(...lams),
    timing_s: Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, Math.round(v * 1e3) / 1e3])),
    units: "MJy/sr with each exposure's own median removed before stacking (about 0 = typical sky, zodiacal light NOT subtracted beyond that), NaN = no data; row 0 = SOUTH edge, column 0 = EAST edge",
  };
}

// any NaN in the 3x3 around the (rounded) target pixel
function nanNear(data, n, tx, ty) {
  const cx = roundHalfEven(tx), cy = roundHalfEven(ty);
  for (let j = Math.max(0, cy - 1); j < Math.min(n, cy + 2); j++)
    for (let i = Math.max(0, cx - 1); i < Math.min(n, cx + 2); i++) if (Number.isNaN(data[j * n + i])) return true;
  return false;
}

// ---------------------------------------------------------------- name resolver (CDS Sesame)
export async function resolveName(name, { fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch.bind(globalThis);
  let txt;
  try {
    const r = await f("https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/S?" + encodeURIComponent(name));
    if (!r.ok) throw new Error("HTTP " + r.status);
    txt = await r.text();
  } catch (e) {
    throw new Error(`Name lookup failed (${e.message}). Enter coordinates as "ra, dec" instead.`);
  }
  const g = (tag) => { const m = txt.match(new RegExp(`<${tag}>\\s*([-+0-9.eE]+)\\s*</${tag}>`)); return m ? Number(m[1]) : null; };
  const ra = g("jradeg"), dec = g("jdedeg");
  if (ra == null || dec == null) throw new Error(`Could not find "${name}" in SIMBAD/Sesame`);
  const pmra = g("pmRA"), pmde = g("pmDE");
  return { name, ra, dec, pm_mas_yr: pmra != null && pmde != null ? [pmra, pmde] : null };
}

// ---------------------------------------------------------------- Solar System movers (mirrors pipeline/movers/mover_video.py)
async function getJson(url, fetchImpl) {
  if (url.startsWith("file:")) {
    const fs = await import("node:fs/promises");
    return JSON.parse(await fs.readFile(new URL(url), "utf8"));
  }
  const r = await (fetchImpl || globalThis.fetch.bind(globalThis))(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
const moversBase = (baseUrl) => { const b = baseUrl ? String(baseUrl) : new URL("./movers/", import.meta.url).href; return b.endsWith("/") ? b : b + "/"; };
// -> [{slug, name, default: {mode, span}}]
export async function loadMovers(baseUrl, { fetchImpl } = {}) { return (await getJson(moversBase(baseUrl) + "index.json", fetchImpl)).movers; }
// -> {name, slug, about, exposures: [{key, obs, det, mjd, ra, dec, delta_au}]}
export async function loadMover(baseUrl, slug, { fetchImpl } = {}) { return getJson(moversBase(baseUrl) + `${slug}.json`, fetchImpl); }

const MOVER_GAP_MIN = { burst: 6, run: 12 * 60, all: null };
export function selectMoverExposures(exposures, span = "burst", maxFrames = 60) {
  const ex = [...exposures].sort((a, b) => a.mjd - b.mjd || a.det - b.det);
  let best;
  if (span === "all") best = ex;                       // every exposure over the whole survey
  else {
    const runs = []; let cur = [ex[0]];
    for (const e of ex.slice(1)) {
      if ((e.mjd - cur[cur.length - 1].mjd) * 1440 <= MOVER_GAP_MIN[span]) cur.push(e); else { runs.push(cur); cur = [e]; }
    }
    runs.push(cur);
    best = runs[0]; for (const r of runs) if (r.length > best.length) best = r;     // first longest
  }
  if (best.length > maxFrames) {
    const m = Math.max(1, Math.floor(maxFrames)), stepv = m === 1 ? 0 : (best.length - 1) / (m - 1), keep = new Set();
    for (let i = 0; i < m; i++) keep.add(roundHalfEven(i === m - 1 && m > 1 ? best.length - 1 : i * stepv));
    best = [...keep].sort((a, b) => a - b).map((i) => best[i]);
  }
  return best;
}

const unitVec = (ra, dec) => [Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)];
function medianF64(a) { const b = Float64Array.from(a).sort(), k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; }
function sepArcsec(ra1, dec1, ra2, dec2) {       // Vincenty, as astropy separation
  const a1 = ra1 * D2R, d1 = dec1 * D2R, a2 = ra2 * D2R, d2 = dec2 * D2R, dl = a2 - a1;
  const x = Math.cos(d2) * Math.sin(dl), y = Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(dl);
  const z = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(dl);
  return Math.atan2(Math.hypot(x, y), z) * R2D * 3600;
}

// mover: parsed movers/<slug>.json. Options: mode "flyby" (one fixed sky grid covering the whole path: stars fixed, object moves) |
// "follow" (each frame centred on the object), span "burst" (gaps <= 6 min) | "run" (gaps <= 12 h) | "all" (every exposure of the survey, default mode follow), maxFrames (60), half (flyby: auto
// 20..150 from the path length; follow: 30), onFrame(frame, done, total), signal, fetchImpl, calibBaseUrl.
// Frames: each reprojected exposure minus its own nanmedian (MJy/sr, ~0 = typical sky), row 0 = SOUTH, column 0 = EAST. Frames of
// different detectors alternate, so normalise each for display.
export async function getMoverVideo(mover, opts = {}) {
  const { span = "burst", maxFrames = 60, onFrame, signal, fetchImpl, calibBaseUrl } = opts;
  const mode = opts.mode || (span === "all" ? "follow" : "flyby");
  if (!["flyby", "follow"].includes(mode)) throw new Error(`Unknown mode "${mode}"`);
  if (!(span in MOVER_GAP_MIN)) throw new Error(`Unknown span "${span}"`);
  const now = () => (globalThis.performance ? performance.now() : Date.now()) / 1000;
  const t0 = now(), tm = {};
  const check = () => { if (signal?.aborted) throw abortError(); };
  const base = fetchImpl || globalThis.fetch.bind(globalThis);
  const f = signal ? (u, init = {}) => base(u, { ...init, signal }) : base;
  check();
  const sel = selectMoverExposures(mover.exposures, span, maxFrames);
  // centre of the path = normalised per-axis median of the unit vectors
  const vs = sel.map((e) => unitVec(e.ra, e.dec));
  const m = [0, 1, 2].map((k) => medianF64(vs.map((v) => v[k]))), mn = Math.hypot(...m);
  let cra = Math.atan2(m[1], m[0]) * R2D % 360; if (cra < 0) cra += 360;
  const cdec = Math.asin(m[2] / mn) * R2D;
  let half = opts.half;
  if (half == null) {
    if (mode === "flyby") {
      const spanPx = Math.max(...sel.map((e) => sepArcsec(cra, cdec, e.ra, e.dec))) / PIX_ARCSEC;
      half = Math.min(150, Math.max(20, Math.ceil(spanPx) + 15));
    } else half = 30;
  }
  half = Math.round(half);
  const n = 2 * half + 1, fixed = mode === "flyby" ? makeGrid(cra, cdec, n) : null;
  const calibs = new Map();
  const calibFor = (det) => { if (!calibs.has(det)) calibs.set(det, loadCalib(det, calibBaseUrl, fetchImpl)); return calibs.get(det); };
  const got = new Array(sel.length).fill(null);
  let done = 0, tReproject = 0;
  const tFetch0 = now();
  async function one(i) {
    check();
    const e = sel[i];
    const hdr = await fetchHeader(e.key, { fetchImpl: f });
    const [qra, qdec] = mode === "flyby" ? [cra, cdec] : [e.ra, e.dec];
    const cut = await fetchCutout(e.key, hdr, qra, qdec, half + 8, { fetchImpl: f });
    check();
    if (cut) {
      const ts = now();
      const grid = fixed || makeGrid(e.ra, e.dec, n);
      const data = reproject(hdr, cut, grid, n);
      const md = nanMedian(data);
      for (let p = 0; p < data.length; p++) data[p] = f32(data[p] - md);
      const [tx, ty] = grid.toPixel(e.ra, e.dec);
      const [rx, ry] = worldToPixel(hdr, e.ra, e.dec);
      const w = wavelengthAt(hdr, e.det, rx, ry, await calibFor(e.det));
      got[i] = {
        key: e.key, obs: e.obs, det: e.det, mjd: e.mjd, date_time: new Date((e.mjd - 40587) * 86400000).toISOString().slice(0, 19) + "Z",
        data, targetPx: [tx, ty], delta_au: e.delta_au, ra: e.ra, dec: e.dec, lambda_um: w.lambda_um, ...expInfo(hdr),
      };
      tReproject += now() - ts;
      if (onFrame) onFrame(got[i], done, sel.length);
    }
    done++;
  }
  let next = 0;
  const worker = async () => { while (next < sel.length) await one(next++); };
  await Promise.all(Array.from({ length: Math.min(16, sel.length) }, worker));
  check();
  tm.fetch_s = now() - tFetch0 - tReproject;
  tm.reproject_s = tReproject;
  tm.total_s = now() - t0;
  const frames = got.filter(Boolean);
  if (!frames.length) throw new Error("None of the exposures could be cut out at the object's position");
  return {
    mover: { name: mover.name, slug: mover.slug, about: mover.about }, mode, span, n, half, center: [cra, cdec], n_selected: sel.length, frames,
    timing_s: Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, Math.round(v * 1e3) / 1e3])),
    units: "MJy/sr, each frame minus its own median; row 0 = SOUTH edge, column 0 = EAST edge; targetPx = predicted object position [x, y] on that frame's grid",
  };
}

// ---------------------------------------------------------------- light curves + spectra (mirrors pipeline/photometry.py + pipeline/lightcurve.py)
const SR_PER_ARCSEC2 = 1 / (206264.806 ** 2);
const LC_APERTURE = { r_ap: 2.0, r_ap_in: 0.0, r_in: 5.0, r_out: 9.0 };
const LC_RING = { r_ap: 7.0, r_ap_in: 3.5, r_in: 10.0, r_out: 14.0 };
const LC_NOISE_FLOOR = { aperture: 0.03, ring: 0.08 };
const LC_VISIT_FLOOR = { aperture: 0.01, ring: 0.02 };
const LC_MIN_SNR = 10, LC_MIN_POINTS_PER_VISIT = 5;
const pyRound = (x, d) => { const k = 10 ** d; return Math.round(x * k) / k; };
const finite = Number.isFinite;

function median64(a) {                  // np.median on float64
  const b = Float64Array.from(a).sort(), k = b.length >> 1;
  return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2;
}

let _channels = null;
async function loadChannels(calibBaseUrl, fetchImpl) {
  const base = calibBaseUrl ? String(calibBaseUrl) : new URL("./calib/", import.meta.url).href;
  const url = (base.endsWith("/") ? base : base + "/") + "channels.json";
  if (!_channels || _channels.url !== url) {
    const p = getJson(url, fetchImpl).then((j) => j.channels);
    p.catch(() => { _channels = null; });
    _channels = { url, p };
  }
  return _channels.p;
}
// SPHEREx channel (sub 1..17) of detector det whose [wl_min, wl_max) contains lam; nearest centre otherwise (photometry.channel_of)
export function channelOf(channels, det, lam) {
  const cands = channels.filter((c) => c.det === det);
  for (const c of cands) if (c.wl_min <= lam && lam < c.wl_max) return c.sub;
  let best = cands[0];
  for (const c of cands) if (Math.abs(c.wl - lam) < Math.abs(best.wl - lam)) best = c;
  return best.sub;
}

// img: Float64Array h*w (row-major); x, y 0-based position inside it. Returns [sum, sky_per_px, sky_sigma, n_ap_px, any_nan] as photometry.aperture.
export function aperturePhot(img, w, h, x, y, { r_ap = 2.0, r_in = 5.0, r_out = 9.0, r_ap_in = 0.0, sub = 5 } = {}) {
  const D = new Float64Array(w * h), annVals = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const d = Math.hypot(i - x, j - y); D[j * w + i] = d;
    if (d >= r_in && d <= r_out) { const v = img[j * w + i]; if (v === v) annVals.push(v); }
  }
  if (annVals.length < 10) return [NaN, NaN, NaN, 0, true];
  const ann = Float64Array.from(annVals);
  let med = median64(ann), keep = ann, sig = 0;
  for (let it = 0; it < 3; it++) {
    sig = 1.4826 * median64(ann.map((v) => Math.abs(v - med)));
    keep = sig > 0 ? ann.filter((v) => Math.abs(v - med) <= 3 * sig) : ann;
    med = median64(keep);
  }
  sig = 1.4826 * median64(keep.map((v) => Math.abs(v - med)));
  const o = Array.from({ length: sub }, (_, k) => (k + 0.5) / sub - 0.5);
  let s = 0, nap = 0, bad = false;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!(D[j * w + i] <= r_ap + 1)) continue;
    let cnt = 0;
    for (const oy of o) for (const ox of o) { const rr = Math.hypot(i + ox - x, j + oy - y); if (rr <= r_ap && rr >= r_ap_in) cnt++; }
    const wt = cnt / (sub * sub);
    nap += wt;
    if (wt > 0) { const v = img[j * w + i]; if (v !== v) bad = true; else s += (v - med) * wt; }
  }
  return [s, med, sig, nap, bad];
}

function lcRelative(P) {
  const by = new Map();
  for (const p of P) {
    p.detected = !!(p.valid && p.err_mJy && finite(p.err_mJy) && p.flux_mJy >= LC_MIN_SNR * p.err_mJy);
    if (p.detected) { const k = p.det + "/" + p.sub; if (!by.has(k)) by.set(k, []); by.get(k).push(p); }
  }
  for (const q of by.values()) { const m = median64(q.map((p) => p.flux_mJy)); for (const p of q) p.rel = p.flux_mJy / m; }
}

function lcVisits(P) {
  const V = P.filter((p) => p.rel !== undefined).map((p) => ({ ...p, t: p.mjd }));
  const out = [];
  for (const v of groupVisits(V)) {
    if (v.length < LC_MIN_POINTS_PER_VISIT) continue;
    const rel = v.map((p) => p.rel), sw = v.filter((p) => p.det <= 3).map((p) => p.rel), lw = v.filter((p) => p.det >= 4).map((p) => p.rel);
    const mjd = mean(v.map((p) => p.mjd));
    const medErr = (a) => {
      if (!a.length) return [null, null];
      const m = median64(a), sg = 1.4826 * median64(a.map((x) => Math.abs(x - m)));
      return [pyRound(m, 4), a.length > 2 ? pyRound(1.2533 * sg / Math.sqrt(a.length), 4) : null];
    };
    const [ra_, ea] = medErr(rel), [rs, es] = medErr(sw), [rl, el] = medErr(lw);
    out.push({ mjd: pyRound(mjd, 3), date: mjdToDate(mjd), n: v.length, n_sw: sw.length, n_lw: lw.length,
      rel_all: ra_, rel_all_err: ea, rel_sw: rs, rel_sw_err: es, rel_lw: rl, rel_lw_err: el });
  }
  return out;
}

export function lcVerdict(visits, floor) {
  let best = { sigma: 0.0 };
  for (const band of ["all", "sw", "lw"]) {
    const pts = visits.filter((v) => v[`rel_${band}`] != null && v[`rel_${band}_err`] != null).map((v) => [v.date, v[`rel_${band}`], v[`rel_${band}_err`]]);
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const [da, a, ea] = pts[i], [db, b, eb] = pts[j];
      const sig = Math.abs(a - b) / Math.sqrt(ea ** 2 + eb ** 2 + 2 * floor ** 2);
      if (sig > best.sigma) best = { sigma: pyRound(sig, 1), band, from: da, to: db, change: a ? pyRound(b / a - 1, 4) : null };
    }
  }
  best.variable = best.sigma >= 5;
  return best;
}

function solve3(M, b) {                    // Gaussian elimination with partial pivoting; null if singular
  const a = M.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = c + 1; r < 3; r++) { const f = a[r][c] / a[c][c]; for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k]; }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) { let s = a[r][3]; for (let k = r + 1; k < 3; k++) s -= a[r][k] * x[k]; x[r] = s / a[r][r]; }
  return x;
}
// weighted sinusoid fit to per-visit rel_all over trial periods pmin..pmax (1 d steps); 3x3 normal equations per period
export function lcFitPeriod(visits, pmin = 60, pmax = 500) {
  if (visits.length < 6) return null;
  const mj = visits.map((v) => v.mjd), y = visits.map((v) => v.rel_all), w2 = visits.map((v) => v.n);   // weight^2 = n
  let best = null;
  for (let P = pmin; P <= pmax; P++) {
    const A = mj.map((m) => [1, Math.sin(2 * Math.PI * m / P), Math.cos(2 * Math.PI * m / P)]);
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    A.forEach((r, i) => { for (let a = 0; a < 3; a++) { b[a] += w2[i] * r[a] * y[i]; for (let c = 0; c < 3; c++) M[a][c] += w2[i] * r[a] * r[c]; } });
    const coef = solve3(M, b);
    if (!coef) continue;
    let res = 0;
    A.forEach((r, i) => { const fit = r[0] * coef[0] + r[1] * coef[1] + r[2] * coef[2]; res += w2[i] * (y[i] - fit) ** 2; });
    if (!best || res < best[0]) best = [res, P, coef];
  }
  if (!best) return null;
  const c = best[2];
  return { period_d: best[1], amplitude_rel: pyRound(Math.hypot(c[1], c[2]), 4), mean: pyRound(c[0], 4), phase_coef: [pyRound(c[1], 5), pyRound(c[2], 5)],
    baseline_d: pyRound(Math.max(...mj) - Math.min(...mj), 1), n_visits: visits.length };
}

// Options: ra, dec, pm [mas/yr], name, maxExposures (120; falsy = all), onProgress(done, total, phase), signal, fetchImpl, calibBaseUrl.
// Same shape as pipeline.lightcurve.lightcurve() / lightcurves/<slug>.json. Extra NON-enumerable property `raw`: the unrounded points
// (with obs/key/x/y), used by the tests.
export async function getLightCurve(index, opts = {}) {
  const { ra, dec, pm = null, name, maxExposures = 120, onProgress, signal, fetchImpl, calibBaseUrl } = opts;
  const now = () => (globalThis.performance ? performance.now() : Date.now()) / 1000;
  const t0 = now();
  const check = () => { if (signal?.aborted) throw abortError(); };
  const base = fetchImpl || globalThis.fetch.bind(globalThis);
  const f = signal ? (u, init = {}) => base(u, { ...init, signal }) : base;
  check();
  const seen = new Map();
  for (const mjd of pm ? [60790, MJD_MID_SURVEY, 61320] : [MJD_MID_SURVEY]) {
    const [pr, pd] = positionAt(ra, dec, pm, mjd);
    for (const r of await index.covering(pr, pd)) if (!seen.has(r.key)) seen.set(r.key, r);
  }
  let rows = [...seen.values()];
  if (pm) rows = rows.filter((r) => { const [pr, pd] = positionAt(ra, dec, pm, r.t); return pointInFootprint(pr, pd, r.corners); });
  rows.sort((a, b) => a.t - b.t);
  check();
  if (!rows.length) throw new Error("No SPHEREx images cover this position yet");
  if (maxExposures && rows.length > maxExposures) {      // np.unique(np.linspace(0, n-1, m).round().astype(int))
    const m = Math.max(1, Math.floor(maxExposures)), stepv = m === 1 ? 0 : (rows.length - 1) / (m - 1), keep = new Set();
    for (let i = 0; i < m; i++) keep.add(roundHalfEven(i === m - 1 && m > 1 ? rows.length - 1 : i * stepv));
    rows = [...keep].sort((a, b) => a - b).map((i) => rows[i]);
  }
  const channels = await loadChannels(calibBaseUrl, fetchImpl);
  const hdrs = new Map();                                // one header request per image, reused by the ring pass
  // spherex.mjs does not parse HIERARCH cards, and OMEGA_MEDIAN (pixel solid angle, arcsec^2) is one: same single Range request as fetchHeader, plus a text scan
  async function fetchHeaderOmega(key) {
    for (let nbytes = 40960; ; nbytes *= 2) {
      const r = await f(BASE + key, { headers: { Range: `bytes=0-${nbytes - 1}` } });
      if (r.status !== 200 && r.status !== 206) throw new Error(`HTTP ${r.status} for ${key}`);
      const buf = new Uint8Array(await r.arrayBuffer()), hd = parseFitsHeaders(buf);
      if (hd) {
        hd.key = key;
        const m = new TextDecoder("ascii").decode(buf.subarray(0, hd.imageDataOffset)).match(/HIERARCH OMEGA_MEDIAN\s*=\s*([-+0-9.eE]+)/);
        if (!m) throw new Error("OMEGA_MEDIAN not found in header of " + key);
        hd.image.OMEGA_MEDIAN = Number(m[1]);
        return hd;
      }
      if (buf.length < nbytes) throw new Error("FITS header END not found: " + key);
    }
  }
  const getHdr = (key) => {
    if (!hdrs.has(key)) { const p = fetchHeaderOmega(key); p.catch(() => hdrs.delete(key)); hdrs.set(key, p); }
    return hdrs.get(key);
  };

  async function measure(par, phase) {
    const half = Math.ceil(par.r_out) + 2, got = new Array(rows.length).fill(null);
    let done = 0, next = 0;
    if (onProgress) onProgress(0, rows.length, phase);
    async function one(i) {
      check();
      const r = rows[i], hdr = await getHdr(r.key), h = hdr.image, mjd = h["MJD-AVG"];
      const [pra, pdec] = positionAt(ra, dec, pm, mjd);
      const [x, y] = worldToPixel(hdr, pra, pdec);
      const xi = roundHalfEven(x), yi = roundHalfEven(y), n1 = h.NAXIS1, n2 = h.NAXIS2;
      if (half <= xi && xi < n1 - half && half <= yi && yi < n2 - half) {      // else too close to the detector edge for the sky annulus
        const cut = await fetchCutout(r.key, hdr, pra, pdec, half, { fetchImpl: f });
        check();
        if (cut && cut.width === 2 * half + 1 && cut.height === 2 * half + 1) {
          const img = Float64Array.from(cut.data);
          const [s, sky, sig, nap, bad] = aperturePhot(img, cut.width, cut.height, x - cut.x0, y - cut.y0, par);
          const toMjy = h.OMEGA_MEDIAN * SR_PER_ARCSEC2 * 1e9;
          const det = Number(h.DETECTOR ?? r.det);
          const lam = wavelengthAt(hdr, det, x, y, await loadCalib(det, calibBaseUrl, fetchImpl)).lambda_um;
          got[i] = { obs: r.obs, key: r.key, det, mjd, lambda_um: lam, sub: channelOf(channels, det, lam), x, y,
            flux_mJy: s * toMjy, err_mJy: finite(sig) ? sig * Math.sqrt(nap) * toMjy : NaN, sky_MJysr: sky, valid: !bad && finite(s) };
        }
      }
      done++;
      if (onProgress) onProgress(done, rows.length, phase);
    }
    const worker = async () => { while (next < rows.length) await one(next++); };
    await Promise.all(Array.from({ length: Math.min(16, rows.length) }, worker));
    const P = got.filter(Boolean);
    P.sort((a, b) => a.mjd - b.mjd || a.det - b.det);
    return { P, aperture: { r_ap_px: par.r_ap, r_ap_in_px: par.r_ap_in, r_in_px: par.r_in, r_out_px: par.r_out } };
  }

  let method = "aperture", r = await measure(LC_APERTURE, "aperture");
  if (r.P.length && r.P.filter((p) => p.valid).length < 0.5 * r.P.length) { r = await measure(LC_RING, "ring"); method = "ring"; }
  const P = r.P;
  lcRelative(P);
  const visits = lcVisits(P);
  const vd = visits.length >= 2 ? lcVerdict(visits, LC_VISIT_FLOOR[method])
    : { sigma: 0.0, variable: null, note: "not enough detected points for a light curve (target too faint in single images)" };
  const nn = (x, d) => (finite(x) ? pyRound(x, d) : null);
  const out = {
    target: { name: name ?? null, ra, dec, pm_mas_yr: pm }, method, aperture_px: r.aperture, noise_floor_rel: LC_NOISE_FLOOR[method],
    n_images: rows.length, n_measured: P.length, n_valid: P.filter((p) => p.valid).length,
    visits, verdict: vd, variable: vd.variable, period: lcFitPeriod(visits),
    points: P.map((p) => ({ mjd: pyRound(p.mjd, 5), det: p.det, sub: p.sub, lambda_um: pyRound(p.lambda_um, 4), flux_mJy: nn(p.flux_mJy, 3),
      err_mJy: nn(p.err_mJy, 3), rel: p.rel !== undefined ? pyRound(p.rel, 4) : null, valid: p.valid, detected: p.detected })),
    n_detected: P.filter((p) => p.detected).length, min_snr: LC_MIN_SNR, seconds: pyRound(now() - t0, 1),
  };
  Object.defineProperty(out, "raw", { value: P, enumerable: false });
  return out;
}

// Pre-computed light curve of one of the five test targets (lightcurves/<slug>.json next to this file by default).
export async function loadLightCurve(baseUrl, slug, { fetchImpl } = {}) {
  const b = baseUrl ? String(baseUrl) : new URL("./lightcurves/", import.meta.url).href;
  return getJson((b.endsWith("/") ? b : b + "/") + `${slug}.json`, fetchImpl);
}
