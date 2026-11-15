// SPHEREx level-2 FITS helpers for the browser (and Node 18+). No dependencies.
// Mirrors pipeline/index/headers.py: header fetch, SIP WCS (matches astropy all_world2pix / all_pix2world),
// and one-Range-request cutouts straight from NASA's public S3 bucket (CORS-enabled).

export const BASE = "https://nasa-irsa-spherex.s3.amazonaws.com/";
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// ---------------------------------------------------------------- FITS header parsing
function parseValue(s) {
  s = s.trim();
  if (s[0] === "'") {                       // string, '' = escaped quote
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "'") { if (s[i + 1] === "'") { out += "'"; i++; } else break; }
      else out += s[i];
    }
    return out.replace(/\s+$/, "");
  }
  const v = s.split("/")[0].trim();
  if (v === "T") return true;
  if (v === "F") return false;
  const n = Number(v.replace(/[dD]/, "e"));
  return Number.isNaN(n) ? v : n;
}

// Parse header blocks starting at byte `pos`. Returns {cards, end} or null if END not inside buf.
function parseHeaderAt(u8, pos) {
  const cards = {};
  const dec = new TextDecoder("ascii");
  for (let b = pos; b + 2880 <= u8.length; b += 2880) {
    for (let c = 0; c < 36; c++) {
      const line = dec.decode(u8.subarray(b + c * 80, b + c * 80 + 80));
      const key = line.slice(0, 8).trim();
      if (key === "END") return { cards, end: b + 2880 };
      if (line.slice(8, 10) === "= ") cards[key] = parseValue(line.slice(10));
    }
  }
  return null;
}

// Returns {primary, image, imageDataOffset} or null if the buffer is too short.
export function parseFitsHeaders(arrayBuffer) {
  const u8 = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const p = parseHeaderAt(u8, 0);
  if (!p) return null;
  const im = parseHeaderAt(u8, p.end);
  if (!im) return null;
  return { primary: p.cards, image: im.cards, imageDataOffset: im.end };
}

async function rangeGet(key, start, end, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const r = await f(BASE + key, { headers: { Range: `bytes=${start}-${end}` } });
  if (r.status !== 200 && r.status !== 206) throw new Error(`HTTP ${r.status} for ${key}`);
  return new Uint8Array(await r.arrayBuffer());
}

// One Range request (first 40960 bytes); doubles the size if the IMAGE END card is not inside.
export async function fetchHeader(key, { fetchImpl, nbytes = 40960 } = {}) {
  for (;;) {
    const buf = await rangeGet(key, 0, nbytes - 1, fetchImpl);
    const h = parseFitsHeaders(buf);
    if (h) { h.key = key; return h; }
    if (buf.length < nbytes) throw new Error("FITS header END not found: " + key);
    nbytes *= 2;
  }
}

// ---------------------------------------------------------------- WCS
function sipPoly(img, name, order) {          // -> [[p,q,coef],...]
  const t = [];
  if (!order) return t;
  for (let p = 0; p <= order; p++) for (let q = 0; p + q <= order; q++) {
    const c = img[`${name}_${p}_${q}`];
    if (c) t.push([p, q, c]);
  }
  return t;
}
function evalPoly(t, u, v) {
  let s = 0;
  for (const [p, q, c] of t) s += c * Math.pow(u, p) * Math.pow(v, q);
  return s;
}

// Derived WCS terms, cached on the header object.
function wcsOf(hdr) {
  if (hdr._wcs) return hdr._wcs;
  const h = hdr.image;
  const c1 = h.CDELT1 ?? 1, c2 = h.CDELT2 ?? 1;
  const m = [[c1 * (h.PC1_1 ?? 1), c1 * (h.PC1_2 ?? 0)], [c2 * (h.PC2_1 ?? 0), c2 * (h.PC2_2 ?? 1)]];
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  const inv = [[m[1][1] / det, -m[0][1] / det], [-m[1][0] / det, m[0][0] / det]];
  const wcs = {
    crpix: [h.CRPIX1, h.CRPIX2], ra0: h.CRVAL1 * D2R, d0: h.CRVAL2 * D2R, m, inv,
    A: sipPoly(h, "A", h.A_ORDER), B: sipPoly(h, "B", h.B_ORDER),
    AP: sipPoly(h, "AP", h.AP_ORDER), BP: sipPoly(h, "BP", h.BP_ORDER),
  };
  Object.defineProperty(hdr, "_wcs", { value: wcs, enumerable: false });
  return wcs;
}

// World -> pixel using only the AP/BP inverse SIP polynomials (what astropy wcs_world2pix does). 0-based.
export function worldToPixelApprox(hdr, ra, dec) {
  const w = wcsOf(hdr);
  const a = ra * D2R, d = dec * D2R, da = a - w.ra0;
  const sd = Math.sin(d), cd = Math.cos(d), s0 = Math.sin(w.d0), c0 = Math.cos(w.d0);
  const D = s0 * sd + c0 * cd * Math.cos(da);
  const xi = R2D * cd * Math.sin(da) / D;
  const eta = R2D * (c0 * sd - s0 * cd * Math.cos(da)) / D;
  const U = w.inv[0][0] * xi + w.inv[0][1] * eta;
  const V = w.inv[1][0] * xi + w.inv[1][1] * eta;
  return { U, V, u: U + evalPoly(w.AP, U, V), v: V + evalPoly(w.BP, U, V), w };
}

// World -> pixel, 0-based, equivalent to astropy all_world2pix(ra, dec, 0).
// AP/BP give the starting point; Newton iterations on the forward A/B polynomials refine it.
export function worldToPixel(hdr, ra, dec, { approx = false } = {}) {
  const { U, V, u: u0, v: v0, w } = worldToPixelApprox(hdr, ra, dec);
  let u = u0, v = v0;
  if (!approx && (w.A.length || w.B.length)) {
    for (let it = 0; it < 20; it++) {
      const fu = u + evalPoly(w.A, u, v) - U, fv = v + evalPoly(w.B, u, v) - V;
      const e = 1e-3;
      const dAu = (evalPoly(w.A, u + e, v) - evalPoly(w.A, u - e, v)) / (2 * e);
      const dAv = (evalPoly(w.A, u, v + e) - evalPoly(w.A, u, v - e)) / (2 * e);
      const dBu = (evalPoly(w.B, u + e, v) - evalPoly(w.B, u - e, v)) / (2 * e);
      const dBv = (evalPoly(w.B, u, v + e) - evalPoly(w.B, u, v - e)) / (2 * e);
      const j11 = 1 + dAu, j12 = dAv, j21 = dBu, j22 = 1 + dBv, dj = j11 * j22 - j12 * j21;
      const su = (j22 * fu - j12 * fv) / dj, sv = (-j21 * fu + j11 * fv) / dj;
      u -= su; v -= sv;
      if (Math.abs(su) < 1e-9 && Math.abs(sv) < 1e-9) break;
    }
  }
  return [u + w.crpix[0] - 1, v + w.crpix[1] - 1];
}

// Pixel (0-based) -> [ra, dec] degrees, equivalent to astropy all_pix2world(x, y, 0).
export function pixelToWorld(hdr, x, y) {
  const w = wcsOf(hdr);
  const u = x + 1 - w.crpix[0], v = y + 1 - w.crpix[1];
  const U = u + evalPoly(w.A, u, v), V = v + evalPoly(w.B, u, v);
  const xi = (w.m[0][0] * U + w.m[0][1] * V) * D2R, eta = (w.m[1][0] * U + w.m[1][1] * V) * D2R;
  const s0 = Math.sin(w.d0), c0 = Math.cos(w.d0);
  const t = c0 - eta * s0;
  const ra = w.ra0 + Math.atan2(xi, t);
  const dec = Math.atan2(s0 + eta * c0, Math.hypot(xi, t));
  let r = (ra * R2D) % 360; if (r < 0) r += 360;
  return [r, dec * R2D];
}

// ---------------------------------------------------------------- cutout
// Python round() is half-to-even; Math.round is half-up. This implements half-even so results equal int(round(px)).
export function roundHalfEven(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

// One Range request for the rows [y0, y1) (full rows), then column-slice. Returns null if off-detector.
export async function fetchCutout(key, hdr, ra, dec, half = 14, { fetchImpl } = {}) {
  const [px, py] = worldToPixel(hdr, ra, dec);
  const n1 = hdr.image.NAXIS1, n2 = hdr.image.NAXIS2;
  const x = roundHalfEven(px), y = roundHalfEven(py);
  if (!(x >= 0 && x < n1 && y >= 0 && y < n2)) return null;
  const x0 = Math.max(0, x - half), x1 = Math.min(n1, x + half + 1);
  const y0 = Math.max(0, y - half), y1 = Math.min(n2, y + half + 1);
  const d = hdr.imageDataOffset;
  const raw = await rangeGet(key, d + y0 * n1 * 4, d + y1 * n1 * 4 - 1, fetchImpl);
  const width = x1 - x0, height = y1 - y0;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const data = new Float32Array(width * height);
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) data[r * width + c] = dv.getFloat32((r * n1 + x0 + c) * 4, false);
  return { data, width, height, x0, y0 };
}
