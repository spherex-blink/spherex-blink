// Tests for neossat.mjs on the published files (web/lib/spherex/neossat/). Offline: reads the JSON from disk.
// Usage: node web/lib/spherex/test/test_neossat.mjs        Written with Claude Code.
import fs from "node:fs";
import { loadNeossatIndex, loadNeossat, mergeTimeline, decodeF32, normaliseFrame, NEOSSAT_CREDIT } from "../neossat.mjs";

const dir = new URL("../neossat/", import.meta.url);
const fileFetch = async (url) => {
  const p = new URL(url);
  if (!fs.existsSync(p)) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, "utf8")) };
};
let fails = 0;
const report = (name, ok, msg) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${msg}`); };

// 1 decode: known little-endian float32 values
{
  const f = new Float32Array([1.5, -2.25, NaN, 3e-5]);
  const b64 = Buffer.from(new Uint8Array(f.buffer)).toString("base64");
  const d = decodeF32(b64);
  report("1 decodeF32", d[0] === 1.5 && d[1] === -2.25 && Number.isNaN(d[2]) && Math.abs(d[3] - 3e-5) < 1e-10, Array.from(d).join(", "));
}
// 2 index
const idx = await loadNeossatIndex(dir.href, { fetchImpl: fileFetch });
report("2 index", Array.isArray(idx.objects) && idx.objects.some((o) => o.slug === "3i-atlas") && /Canadian Space Agency/.test(idx.credit),
  `${idx.objects.length} objects: ${idx.objects.map((o) => o.slug).join(", ")}`);
// 3 object: frames decode to n*n, time-sorted, targetPx near the centre, credit present
const neo = await loadNeossat(dir.href, "3i-atlas", { fetchImpl: fileFetch });
{
  const f = neo.frames;
  const sizes = f.every((x) => x.data instanceof Float32Array && x.data.length === x.n * x.n);
  const sorted = f.every((x, i) => i === 0 || x.mjd >= f[i - 1].mjd);
  const centred = f.every((x) => Math.abs(x.targetPx[0] - (x.n - 1) / 2) < 0.01 && Math.abs(x.targetPx[1] - (x.n - 1) / 2) < 0.01);
  const finite = f.map((x) => x.data.filter(Number.isFinite).length / x.data.length);
  report("3 frames", f.length >= 40 && sizes && sorted && centred && Math.min(...finite) > 0.9,
    `${f.length} frames, sizes ok ${sizes}, sorted ${sorted}, target centred ${centred}, min finite ${Math.min(...finite).toFixed(3)}`);
  report("3b credit", neo.credit.includes("CSA") && neo.licence.includes("Open Government Licence"), neo.licence.slice(0, 80));
}
// 4 the comet is the brightest thing near the centre in most valid frames (data really is object-centred)
{
  let hit = 0, tot = 0;
  for (const f of neo.frames.filter((x) => x.valid)) {
    const z = normaliseFrame(f.data), n = f.n, c = (n - 1) / 2;
    let best = -Infinity, bx = 0, by = 0;
    for (let y = c - 6; y <= c + 6; y++) for (let x = c - 6; x <= c + 6; x++) { const v = z[y * n + x]; if (v > best) { best = v; bx = x; by = y; } }
    tot++; if (Math.hypot(bx - c, by - c) <= 3 && best > 5) hit++;
  }
  report("4 comet centred", hit / tot >= 0.8, `${hit}/${tot} valid frames peak > 5 sigma within 3 px of the centre`);
}
// 5 pairs: both images decode on the same grid, |dt| <= 6 h, frame index valid
{
  const p = neo.pairs;
  const ok = p.every((x) => x.neossatData.length === x.n * x.n && x.spherexData.length === x.n * x.n && Math.abs(x.dt_hours) <= 6 &&
                            x.neossat >= 0 && x.neossat < neo.frames.length);
  report("5 pairs", p.length > 0 && ok, `${p.length} pairs, |dt| max ${Math.max(...p.map((x) => Math.abs(x.dt_hours))).toFixed(2)} h`);
}
// 6 mergeTimeline with a fake mover video: sorted, tagged, all frames kept, onlyValid filter works
{
  const fake = { n: 61, frames: [{ mjd: 60900.5, date_time: "x", det: 4, lambda_um: 2.6, data: new Float32Array(61 * 61), targetPx: [30, 30] },
                                 { mjd: 61023.3, date_time: "y", det: 5, lambda_um: 4.3, data: new Float32Array(61 * 61), targetPx: [30, 30] }] };
  const t = mergeTimeline(neo.frames, fake);
  const sorted = t.every((x, i) => i === 0 || x.mjd >= t[i - 1].mjd);
  const tags = new Set(t.map((x) => x.telescope_id));
  const v = mergeTimeline(neo.frames, fake, { onlyValid: true });
  report("6 mergeTimeline", t.length === neo.frames.length + 2 && sorted && tags.has("neossat") && tags.has("spherex") &&
    v.length === neo.frames.filter((f) => f.valid).length + 2 && t.find((x) => x.telescope_id === "spherex").label.includes("SPHEREx · NASA"),
    `${t.length} items, sorted ${sorted}, valid-only ${v.length}`);
}
// 7 light curve sanity: NEOSSat brightest near Nov 2025 (after perihelion 29 Oct), fainter in Aug and Feb
{
  const lc = neo.lightcurve.neossat.filter((p) => p.valid);
  const brightest = lc.reduce((a, b) => (b.mag_10 < a.mag_10 ? b : a));
  const aug = lc.filter((p) => p.mjd < 60920).map((p) => p.mag_10), feb = lc.filter((p) => p.mjd > 61080).map((p) => p.mag_10);
  report("7 light curve", brightest.mjd > 60975 && brightest.mjd < 61010 && Math.min(...aug) > brightest.mag_10 + 3 && Math.min(...feb) > brightest.mag_10 + 3,
    `brightest G10 ${brightest.mag_10} at MJD ${brightest.mjd.toFixed(1)}; Aug ${Math.min(...aug).toFixed(2)}, Feb ${Math.min(...feb).toFixed(2)}; ${lc.length} valid`);
}
console.log(fails ? `${fails} FAILED` : "ALL PASS", "|", NEOSSAT_CREDIT.slice(0, 60) + "…");
process.exit(fails ? 1 : 0);
