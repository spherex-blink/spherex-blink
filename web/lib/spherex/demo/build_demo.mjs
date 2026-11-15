// Pre-bakes the heavy examples of the app's Walkthrough mode, so the demo shows them with no waiting:
//   wise0855-deep.json   shift-and-stack of WISE 0855 (getDeepStack: sky stack vs track stack)
//   3i-atlas-path.json   the interstellar comet's whole imaged path (getMoverVideo follow/all, 60 frames)
//   fd58-flyby.json      a near-Earth asteroid crossing fixed stars in minutes (getMoverVideo flyby/burst)
// Run from the repo root:  node web/lib/spherex/demo/build_demo.mjs [wise|atlas|fd58 ...]
// Images are stored as base64 little-endian float32 (same as the samples). Written with Claude Code.
import fs from "node:fs";
import { SkyIndex, getDeepStack, getMoverVideo, loadMover } from "../index.mjs";

const OUT = new URL("./", import.meta.url);
const calibBaseUrl = new URL("../calib/", import.meta.url);
const movers = new URL("../movers/", import.meta.url).href;
const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
const f32 = (a) => (a instanceof Float32Array ? a : Float32Array.from(a));
const save = (name, obj) => { const s = JSON.stringify(obj); fs.writeFileSync(new URL(name, OUT), s); console.log(`${name}: ${(s.length / 1e6).toFixed(2)} MB`); };
// NASA's S3 sometimes resets a connection under many parallel range requests: retry up to 5 times
const fetchImpl = async (u, init) => {
  for (let k = 0; ; k++) {
    try { return await fetch(u, init); } catch (e) { if (k >= 5) throw e; await new Promise((r) => setTimeout(r, 500 * (k + 1))); }
  }
};
const want = process.argv.slice(2);
const on = (k) => !want.length || want.includes(k);

if (on("wise")) {
  const idx = await SkyIndex.load("https://spherex-blink.github.io/index/");
  const r = await getDeepStack(idx, { ra: 133.81891, dec: -7.24705, pm: [-8123.7, 673.2], name: "WISE 0855-0714", half: 30, calibBaseUrl, fetchImpl,
    onProgress: (d, t) => { if (d % 20 === 0) console.log(`wise deep ${d}/${t}`); } });
  const { track, sky, ...rest } = r;
  save("wise0855-deep.json", { ...rest, track_b64_f32le: b64(f32(track)), sky_b64_f32le: b64(f32(sky)), made: new Date().toISOString() });
}

async function mover(slug, o, file) {
  const mv = await loadMover(movers, slug);
  const v = await getMoverVideo(mv, { ...o, calibBaseUrl, fetchImpl });
  const frames = v.frames.map(({ data, ...f }) => ({ ...f, data_b64_f32le: b64(f32(data)) }));
  // every exposure's sky position (the thin path line), thinned to <= 600 points
  const all = (mv.exposures || []).slice().sort((a, b) => a.mjd - b.mjd), st = Math.max(1, Math.ceil(all.length / 600));
  const path = all.filter((_, i) => i % st === 0 || i === all.length - 1).map((e) => ({ ra: e.ra, dec: e.dec, mjd: e.mjd }));
  save(file, { ...v, frames, mover_name: mv.name, about: mv.about || "", n_exposures: mv.exposures?.length, path, made: new Date().toISOString() });
}
if (on("atlas")) await mover("3i-atlas", { mode: "follow", span: "all", maxFrames: 60 }, "3i-atlas-path.json");
if (on("fd58")) await mover("162882", { mode: "flyby", span: "burst", maxFrames: 30 }, "fd58-flyby.json");
