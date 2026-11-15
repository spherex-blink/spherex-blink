// NEOSSat (Canadian Space Agency) data for the SPHEREx blink tool: "one interstellar comet, two space telescopes".
// Plain ES module, no dependencies; browser and Node 18+. Data: ./neossat/<slug>.json, made offline by pipeline/neossat/publish.py
// (CADC sends no CORS headers, so the browser can't read NEOSSat files directly).
//
//   import { loadNeossatIndex, loadNeossat, mergeTimeline, normaliseFrame, NEOSSAT_CREDIT } from "./lib/spherex/neossat.mjs";
//   const neo = await loadNeossat(undefined, "3i-atlas");      // frames[i].data = Float32Array (n*n, row 0 = south)
//   const v   = await getMoverVideo(await loadMover(undefined, "3i-atlas"), { mode: "follow", span: "run" });   // index.mjs
//   const timeline = mergeTimeline(neo.frames, v);            // one time-sorted list, each item tagged with its telescope
//
// Written with Claude Code.

export const NEOSSAT_CREDIT =
  "NEOSSat data courtesy of the Canadian Space Agency (CSA), via the Canadian Astronomy Data Centre (CADC, NRC Canada); SSOIS by CADC. " +
  "Contains information licensed under the Open Government Licence – Canada.";

export const TELESCOPES = {
  neossat: { telescope: "NEOSSat", agency: "CSA", band: "visible", label: "NEOSSat · CSA · visible" },
  spherex: { telescope: "SPHEREx", agency: "NASA", band: "infrared", label: "SPHEREx · NASA · infrared" },
};

const base = (baseUrl) => {
  const b = baseUrl ? String(baseUrl) : new URL("./neossat/", import.meta.url).href;
  return b.endsWith("/") ? b : b + "/";
};

async function getJson(url, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const r = await f(url);
  if (!r.ok) throw new Error(`Could not load ${url} (HTTP ${r.status})`);
  return r.json();
}

/** base64 of little-endian float32 -> Float32Array (works in browsers and Node). */
export function decodeF32(b64) {
  let bytes;
  if (typeof atob === "function") {
    const s = atob(b64);
    bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  } else {
    bytes = new Uint8Array(Buffer.from(b64, "base64"));
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

/** -> {objects: [{slug, name, kind, n_neossat, n_spherex, ...}], credit, licence} */
export async function loadNeossatIndex(baseUrl, { fetchImpl } = {}) {
  return getJson(base(baseUrl) + "index.json", fetchImpl);
}

/** Load one object. Each frame gets `data` (Float32Array, n*n), `telescope: "neossat"` and `label`;
 *  each pair gets `neossatData`, `spherexData` (Float32Array on the same 6.15" grid). */
export async function loadNeossat(baseUrl, slug, { fetchImpl } = {}) {
  const doc = await getJson(base(baseUrl) + `${slug}.json`, fetchImpl);
  for (const f of doc.frames || []) {
    f.data = decodeF32(f.data_b64_f32le);
    delete f.data_b64_f32le;
    f.telescope_id = "neossat";
    f.label = TELESCOPES.neossat.label;
  }
  for (const f of doc.spherex_frames || []) {      // pre-baked SPHEREx frames (31 x 31 at 6.15"), same shape as getMoverVideo frames
    f.data = decodeF32(f.data_b64_f32le);
    delete f.data_b64_f32le;
  }
  for (const p of doc.pairs || []) {
    p.neossatData = decodeF32(p.neossat_b64_f32le);
    p.spherexData = decodeF32(p.spherex_b64_f32le);
    delete p.neossat_b64_f32le;
    delete p.spherex_b64_f32le;
  }
  return doc;
}

/** One time-sorted list of frames from both telescopes.
 *  neossatFrames: loadNeossat(...).frames;  moverVideo: getMoverVideo(...) result (or an array of its frames), may be null.
 *  -> [{telescope_id: "neossat"|"spherex", label, mjd, date_time, n, pix_arcsec, data, targetPx, source}]  (source = original frame) */
export function mergeTimeline(neossatFrames, moverVideo, { onlyValid = false } = {}) {
  const out = [];
  for (const f of neossatFrames || []) {
    if (onlyValid && f.valid === false) continue;
    out.push({ telescope_id: "neossat", label: TELESCOPES.neossat.label, mjd: f.mjd, date_time: f.date_time, n: f.n,
               pix_arcsec: f.pix_arcsec ?? 3.0, data: f.data, targetPx: f.targetPx, exptime_s: f.exptime_s, source: f });
  }
  const sx = Array.isArray(moverVideo) ? moverVideo : (moverVideo?.frames || []);
  const n = Array.isArray(moverVideo) ? null : moverVideo?.n;
  for (const f of sx) {
    out.push({ telescope_id: "spherex", label: `${TELESCOPES.spherex.label} · D${f.det}${f.lambda_um ? ` · ${f.lambda_um.toFixed(2)} µm` : ""}`,
               mjd: f.mjd, date_time: f.date_time, n: f.n ?? n ?? Math.round(Math.sqrt(f.data?.length || 0)), pix_arcsec: 6.15,
               data: f.data, targetPx: f.targetPx, exptime_s: f.exptime_s, source: f });
  }
  out.sort((a, b) => a.mjd - b.mjd || (a.telescope_id < b.telescope_id ? -1 : 1));
  return out;
}

/** Robust display normalisation for one frame: (v - median) / (1.4826 * MAD); NaN stays NaN. */
export function normaliseFrame(data) {
  const v = Array.from(data).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return new Float32Array(data.length).fill(NaN);
  const med = v[v.length >> 1];
  const dev = v.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  const sig = 1.4826 * dev[dev.length >> 1] || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Number.isFinite(data[i]) ? (data[i] - med) / sig : NaN;
  return out;
}
