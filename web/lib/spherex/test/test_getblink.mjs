// Tests for index.mjs against Python reference values (data/scratch/getblink/ref.json, made by
// `.venv/Scripts/python -m pipeline.tests.make_getblink_ref`, which writes data/scratch/getblink/ref.json).
// Usage: node web/lib/spherex/test/test_getblink.mjs
import fs from "node:fs";
import { SkyIndex, getBlink, getDeepStack, getMoverVideo, getLightCurve, loadLightCurve, lcFitPeriod, lcVerdict, loadMovers, loadMover, buildPixelMap, _makeGrid, MAP_STEP, groupVisits, pickFrames, positionAt, wavelengthAt, resolveName } from "../index.mjs";
import { fetchHeader } from "../spherex.mjs";

const ref = JSON.parse(fs.readFileSync(new URL("../../../../data/scratch/getblink/ref.json", import.meta.url)));
const INDEX = process.env.INDEX || "https://spherex-blink.github.io/index/";
const calibDir = new URL("../calib/", import.meta.url);
let fails = 0;
const report = (name, ok, msg) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${msg}`); };
const idx = await SkyIndex.load(INDEX);

// 1
{
  const h = ref.healpix; let bad = 0, tie = 0;
  h.ra.forEach((r, i) => { if (idx.cellOf(r, h.dec[i]) !== h.cell[i]) { if (h.dec[i] === 0) tie++; else bad++; } });
  report("1 healpix", bad === 0, `${h.ra.length - bad - tie}/${h.ra.length} equal, plus ${tie} exact-boundary ties (dec=0 on a cell edge) that astropy resolves the other way`);
}
// 2
{
  let ok = 0, tot = 0, det = [];
  for (const [k, v] of Object.entries(ref.lookup)) {
    const rows = await idx.covering(v.ra, v.dec);
    const a = new Set(rows.map((r) => r.obs + "|" + r.det)), b = new Set(v.set.map((x) => x[0] + "|" + x[1]));
    const same = a.size === b.size && [...a].every((x) => b.has(x));
    tot++; ok += same; det.push(`${k}:${a.size}${same ? "" : "!=" + b.size}`);
  }
  report("2 lookup", ok === tot, `${ok}/${tot} identical sets (${det.join(" ")})`);
}
// 3
{
  let mx = 0;
  for (const p of ref.pm) {
    const [r, d] = positionAt(p.ra, p.dec, p.pm, p.mjd);
    const dra = (r - p.pos[0]) * Math.cos(p.dec * Math.PI / 180) * 3.6e6, dd = (d - p.pos[1]) * 3.6e6;
    mx = Math.max(mx, Math.hypot(dra, dd));
  }
  report("3 proper motion", mx < 1, `max offset ${mx.toExponential(2)} mas over ${ref.pm.length} cases`);
}
// 4
{
  let ok = 0, tot = 0;
  for (const c of ref.pick) {
    const mid = positionAt(c.ra, c.dec, c.pm, 61050);
    const rows = await idx.covering(...mid);
    const vis = groupVisits(rows);
    const r = pickFrames(vis, { detector: c.det_arg ?? "auto", perVisit: c.perVisit, which: c.which === "all" ? "visits" : "ends" });
    const a = JSON.stringify(r.frames.map((x) => [x.obs, x.det, x.visit])), b = JSON.stringify(c.frames.map((x, i) => [...x, c.visit[i]]));
    const same = a === b && r.detector === c.detector && vis.length === c.nvis;
    tot++; ok += same;
    if (!same) console.log("  mismatch", c.name, c.which, r.detector, c.detector, vis.length, c.nvis);
  }
  report("4 pick", ok === tot, `${ok}/${tot} identical (obs,det,visit) lists`);
}
// 5
const b64 = (s) => new Float32Array(Uint8Array.from(Buffer.from(s, "base64")).buffer);
for (const c of ref.blink) {
  const res = await getBlink(idx, { ra: c.ra, dec: c.dec, pm: c.pm, detector: c.detector_arg ?? "auto", half: 30, frames: "visits", perVisit: 2, stack: 0, calibBaseUrl: calibDir });
  let maxPx = 0, maxRel = 0, agree = 0, tot = 0, nfin = 0, matched = 0;
  for (const rf of c.frames) {
    const f = res.frames.find((x) => x.obs === rf.obs && x.det === rf.det);
    if (!f) continue;
    matched++;
    maxPx = Math.max(maxPx, Math.abs(f.targetPx[0] - rf.targetPx[0]), Math.abs(f.targetPx[1] - rf.targetPx[1]));
    const d = b64(rf.b64);
    for (let i = 0; i < d.length; i++) {
      tot++;
      const a = f.data[i], b = d[i];
      if (Number.isNaN(a) === Number.isNaN(b)) agree++;
      if (!Number.isNaN(a) && !Number.isNaN(b)) { nfin++; maxRel = Math.max(maxRel, Math.abs(a - b) / (Math.abs(b) + 1)); }
    }
  }
  report(`5 getBlink ${c.name}`, matched === c.frames.length && res.frames.length === c.frames.length && maxPx < 0.01 && maxRel < 3e-4,
    `frames ${res.frames.length}/${c.frames.length}, det ${res.detector}, max targetPx diff ${maxPx.toFixed(5)}, max rel pixel diff ${maxRel.toExponential(2)} over ${nfin} finite px, NaN-mask agreement ${(100 * agree / tot).toFixed(3)}%`);
}
// 5b stacked frames vs Python stack_frames
for (const c of ref.stack) {
  const res = await getBlink(idx, { ra: c.ra, dec: c.dec, pm: c.pm, detector: 6, half: 30, frames: "ends", stack: 8, calibBaseUrl: calibDir });
  let maxPx = 0, maxRel = 0, agree = 0, tot = 0, nfin = 0, matched = 0, nEq = true;
  for (const rf of c.frames) {
    const f = res.frames.find((x) => x.obs === rf.obs && x.det === rf.det);
    if (!f) continue;
    matched++; nEq = nEq && f.n_stack === rf.n_stack && f.members.length === rf.members.length;
    maxPx = Math.max(maxPx, Math.abs(f.targetPx[0] - rf.targetPx[0]), Math.abs(f.targetPx[1] - rf.targetPx[1]));
    const d = b64(rf.b64);
    for (let i = 0; i < d.length; i++) {
      tot++; const a = f.data[i], b = d[i];
      if (Number.isNaN(a) === Number.isNaN(b)) agree++;
      if (!Number.isNaN(a) && !Number.isNaN(b)) { nfin++; maxRel = Math.max(maxRel, Math.abs(a - b) / (Math.abs(b) + 1)); }
    }
  }
  const pct = 100 * agree / tot;
  report(`5b stack ${c.name} D6 x8`, matched === c.frames.length && res.frames.length === c.frames.length && nEq && maxPx < 0.01 && maxRel < 1e-3 && pct >= 99.5,
    `frames ${res.frames.length}/${c.frames.length}, n_stack ${res.frames.map((f) => f.n_stack)}/${c.frames.map((f) => f.n_stack)}, max targetPx diff ${maxPx.toFixed(5)}, max rel diff ${maxRel.toExponential(2)} over ${nfin} finite px, NaN-mask agreement ${pct.toFixed(3)}%`);
}
// 6
{
  let mx = 0, n = 0, sat = 0;
  for (const slug of ["barnard", "rdra", "wise0855"]) {
    const s = JSON.parse(fs.readFileSync(new URL(`../samples/${slug}.json`, import.meta.url)));
    const calib = JSON.parse(fs.readFileSync(new URL(`../calib/wcs_wave_D${s.detector}.json`, import.meta.url)));
    for (const fr of s.frames) {
      const h = await fetchHeader(fr.key);
      // raw pixel of target: use JS pipeline position via getBlink is heavy; use worldToPixel at the sample's target
      const { positionAt: pa } = await import("../index.mjs");
      const { worldToPixel } = await import("../spherex.mjs");
      const [r, d] = pa(s.target.ra, s.target.dec, s.target.pm_mas_yr, h.image["MJD-AVG"]);
      const [x, y] = worldToPixel(h, r, d);
      const w = wavelengthAt(h, fr.det, x, y, calib);
      // stacked sample frames carry the MEAN wavelength of their members and the first member's key: check it lies in [min, max]
      const err = fr.n_stack ? Math.max(0, fr.lambda_min_um - 1e-3 - w.lambda_um, w.lambda_um - fr.lambda_max_um - 1e-3) : Math.abs(w.lambda_um - fr.lambda_um);
      mx = Math.max(mx, err); n++;
    }
  }
  report("6 wavelength vs samples", mx < 0.001, `${n} frames, max |dlambda| ${mx.toExponential(2)} um`);
}
// 6b
{
  let mx = 0, mxb = 0, perDet = [];
  for (const w of ref.wave) {
    const h = await fetchHeader(w.key);
    const calib = JSON.parse(fs.readFileSync(new URL(`../calib/wcs_wave_D${w.det}.json`, import.meta.url)));
    let m = 0;
    w.pts.forEach(([x, y], i) => {
      const r = wavelengthAt(h, w.det, x, y, calib);
      m = Math.max(m, Math.abs(r.lambda_um - w.vals[i][0])); mxb = Math.max(mxb, Math.abs(r.dlambda_um - w.vals[i][1]));
    });
    mx = Math.max(mx, m); perDet.push(`D${w.det}:${m.toExponential(1)}`);
  }
  report("6b wavelength vs astropy (real WCS-WAVE, 5 px, D1-D6)", mx < 0.001, `max |dlambda| ${mx.toExponential(2)} um, bandwidth ${mxb.toExponential(2)} um; ${perDet.join(" ")}`);
}
// 7
for (const [nm, ra, dec, pm, fr] of [["Barnard ends", 269.4520769586, 4.6933649666, [-801.551, 10362.394], "ends"], ["R Dra visits", 248.16761, 66.75498, null, "visits"]]) {
  const idx2 = await SkyIndex.load(INDEX);   // cold index cache
  const t = performance.now();
  const res = await getBlink(idx2, { ra, dec, pm, frames: fr, stack: 0, calibBaseUrl: calibDir });
  const wall = (performance.now() - t) / 1000;
  report(`7 timing ${nm}`, fr !== "ends" || wall < 3, `${JSON.stringify(res.timing_s)} wall ${wall.toFixed(2)}s, ${res.frames.length} frames, ${res.n_exposures} exposures, ${res.visits.length} visits, D${res.detector}`);
}
// 8
for (const [name, ra, dec, pm] of [["Barnard's Star", 269.452, 4.693, [-801.551, 10362.394]], ["R Dra", 248.1676, 66.755, null], ["WISE J085510.83-071442.5", 133.8188, -7.2451, [-8123.7, 673.2]]]) {
  try {
    const r = await resolveName(name);
    const ok = Math.abs(r.ra - ra) < 0.01 && Math.abs(r.dec - dec) < 0.01 && (!pm || (r.pm_mas_yr && Math.abs(r.pm_mas_yr[0] - pm[0]) < 30 && Math.abs(r.pm_mas_yr[1] - pm[1]) < 30));
    report(`8 resolveName ${name}`, ok, JSON.stringify(r));
  } catch (e) { report(`8 resolveName ${name}`, false, e.message); }
}
const T = {
  barnard: [269.4520769586, 4.6933649666, [-801.551, 10362.394]], wise: [133.81891, -7.24705, [-8123.7, 673.2]], rdra: [248.16761, 66.75498, null],
};
// 9 visits + stack 8
for (const [nm, [ra, dec, pm]] of Object.entries(T)) {
  const idx2 = await SkyIndex.load(INDEX);
  const res = await getBlink(idx2, { ra, dec, pm, calibBaseUrl: calibDir });     // defaults: visits, stack 8, sky
  const nv = res.visits.length;
  const refPick = ref.pick.find((p) => p.name.toLowerCase().startsWith(nm === "wise" ? "wise" : nm) && !p.det_arg && p.which === "all");
  const ok = res.frames.length === (refPick.frames.length / 2) && res.frames.every((f) => f.n_stack >= 1) && res.options.frames === "visits" && res.options.stack === 8;
  report(`9 visits+stack8 ${nm}`, ok, `${res.frames.length} frames of ${nv} visits (D${res.detector}), n_stack ${res.frames.map((f) => f.n_stack)}, timing ${JSON.stringify(res.timing_s)}, grid.autoHalf ${res.grid.autoHalf}`);
}
// 10 exposures
{
  const [ra, dec, pm] = T.wise;
  const rows = await idx.covering(...positionAt(ra, dec, pm, 61050));
  const res = await getBlink(idx, { ra, dec, pm, frames: "exposures", detector: 6, half: 15, calibBaseUrl: calibDir });
  const nD = rows.filter((r) => r.det === 6).length;
  const sorted = res.frames.every((f, i) => i === 0 || f.mjd >= res.frames[i - 1].mjd);
  report("10 exposures uncapped", res.frames.length === Math.min(nD, 120) && !res.frames.some((f) => f.n_stack) && sorted, `${res.frames.length} frames, D6 exposures ${nD}, stack option ${res.options.stack}`);
  const res2 = await getBlink(idx, { ra, dec, pm, frames: "exposures", detector: 6, half: 15, maxFrames: 5, calibBaseUrl: calibDir });
  report("10 exposures capped", res2.frames.length === Math.min(5, nD), `${res2.frames.length} frames with maxFrames 5`);
}
// 11 track mode
for (const nm of ["barnard", "wise"]) {
  const [ra, dec, pm] = T[nm];
  const sky = await getBlink(idx, { ra, dec, pm, half: 30, stack: 4, mode: "sky", calibBaseUrl: calibDir });
  const trk = await getBlink(idx, { ra, dec, pm, half: 30, stack: 4, mode: "track", calibBaseUrl: calibDir });
  const c = (trk.grid.n - 1) / 2;
  const dev = Math.max(...trk.frames.map((f) => Math.max(Math.abs(f.targetPx[0] - c), Math.abs(f.targetPx[1] - c))));
  report(`11 track ${nm}`, dev < 0.05 && trk.n_exposures >= sky.n_exposures && trk.frames.length >= 1,
    `${trk.frames.length} frames, max |targetPx - centre| ${dev.toExponential(2)} px; lookup exposures track ${trk.n_exposures} vs sky ${sky.n_exposures}; sky targetPx drift ${sky.frames.map((f) => f.targetPx.map((x) => x.toFixed(1)).join("/"))}`);
}
// 12 live timings with defaults (visits + stack 8)
for (const [nm, [ra, dec, pm]] of Object.entries(T)) {
  const idx2 = await SkyIndex.load(INDEX);
  const t = performance.now();
  const res = await getBlink(idx2, { ra, dec, pm, calibBaseUrl: calibDir });
  report(`12 timing ${nm} visits+stack8`, true, `${JSON.stringify(res.timing_s)} wall ${((performance.now() - t) / 1000).toFixed(2)}s, ${res.frames.length} frames, ${res.n_exposures} exposures`);
}
// 13 interpolated pixel map vs exact SIP Newton solve, full grids, several files and detectors
{
  let worst = 0, cases = 0; const perDet = {};
  for (const [ra, dec, pm] of [[248.16761, 66.75498, null], [133.81891, -7.24705, [-8123.7, 673.2]], [269.4520769586, 4.6933649666, [-801.551, 10362.394]], [331.0441, -56.7828, [3982.0, -2466.8]]]) {
    const rows = await idx.covering(...positionAt(ra, dec, pm, 61050));
    for (const det of [1, 2, 3, 4, 5, 6]) {
      const rs = rows.filter((r) => r.det === det); if (!rs.length) continue;
      for (const r of [rs[0], rs[rs.length - 1]]) {
        const hdr = await fetchHeader(r.key), [pr, pd] = positionAt(ra, dec, pm, hdr.image["MJD-AVG"]);
        for (const n of [11, 61, 151, 301]) {
          const g = _makeGrid(pr, pd, n), M = buildPixelMap(hdr, g, n), E = buildPixelMap(hdr, g, n, 1);
          let mx = 0; for (let p = 0; p < n * n; p++) mx = Math.max(mx, Math.abs(M.rx[p] - E.rx[p]), Math.abs(M.ry[p] - E.ry[p]));
          worst = Math.max(worst, mx); perDet[det] = Math.max(perDet[det] ?? 0, mx); cases++;
        }
      }
    }
  }
  report("13 interpolated pixel map vs exact", worst < 0.002, `step ${MAP_STEP}, ${cases} grids (n 11..301, D1-D6, 4 fields), max |dx|,|dy| ${worst.toExponential(2)} px (limit 0.002)`);
}
// 14 getDeepStack vs Python deep_stack. Pixel rel diff = |a-b| / (|b| + 1) (MJy/sr, background-subtracted stacks, so the +1 is a floor for ~0 pixels).
for (const c of ref.deep) {
  const res = await getDeepStack(idx, { ra: c.ra, dec: c.dec, pm: c.pm, calibBaseUrl: calibDir });
  let maxRel = 0, nfin = 0, agree = 0, tot = 0;
  for (const [a, b64s] of [[res.track, c.track_b64], [res.sky, c.sky_b64]]) {
    const d = b64(b64s);
    for (let i = 0; i < d.length; i++) {
      tot++; const x = a[i], y = d[i];
      if (Number.isNaN(x) === Number.isNaN(y)) agree++;
      if (!Number.isNaN(x) && !Number.isNaN(y)) { nfin++; maxRel = Math.max(maxRel, Math.abs(x - y) / (Math.abs(y) + 1)); }
    }
  }
  const pct = 100 * agree / tot, tol = (v) => Math.max(0.3, 0.02 * Math.abs(v));
  const wantDet = c.name === "WISE0855" || c.name === "EpsIndB";
  const ok = res.detector === c.detector && res.n_used === c.n_used && maxRel < 1e-3 && pct >= 99.5 &&
    Math.abs(res.snr_track - c.snr_track) <= tol(c.snr_track) && Math.abs(res.snr_sky - c.snr_sky) <= tol(c.snr_sky) && res.detected === wantDet;
  report(`14 deepStack ${c.name}`, ok, `D${res.detector}/D${c.detector}, n_used ${res.n_used}/${c.n_used}, snr track ${res.snr_track.toFixed(2)} (py ${c.snr_track.toFixed(2)}), sky ${res.snr_sky.toFixed(2)} (py ${c.snr_sky.toFixed(2)}), detected ${res.detected}, max rel px diff ${maxRel.toExponential(2)} over ${nfin} finite px, NaN-mask agreement ${pct.toFixed(3)}%`);
}
// 14b errors and progress
{
  let msg = "", prog = [];
  const only6 = { covering: async (...a) => (await idx.covering(...a)).filter((r) => r.det === 6) };
  try { await getDeepStack(only6, { ra: 133.81891, dec: -7.24705, pm: [-8123.7, 673.2], detector: 1, calibBaseUrl: calibDir }); } catch (e) { msg = e.message; }
  report("14b forced absent detector", /detector D1/.test(msg) && /available/.test(msg), msg);
  const ctrl = new AbortController(); let abortName = "";
  const pr = getDeepStack(idx, { ra: 133.81891, dec: -7.24705, pm: [-8123.7, 673.2], half: 10, signal: ctrl.signal, calibBaseUrl: calibDir, onProgress: (d, t) => { prog.push([d, t]); if (d === 3) ctrl.abort(); } });
  try { await pr; } catch (e) { abortName = e.name; }
  report("14b abort + progress", abortName === "AbortError" && prog.length >= 4 && prog[0][0] === 0, `${abortName}, progress calls ${prog.length}, first ${prog[0]}`);
}
// 15 deep stack timings (cold index)
for (const [nm, ra, dec, pm] of [["WISE 0855", 133.81891, -7.24705, [-8123.7, 673.2]], ["Eps Ind B", 331.0441, -56.7828, [3982.0, -2466.8]]]) {
  const idx2 = await SkyIndex.load(INDEX), t = performance.now();
  const res = await getDeepStack(idx2, { ra, dec, pm, calibBaseUrl: calibDir });
  report(`15 timing deepStack ${nm}`, true, `${JSON.stringify(res.timing_s)} wall ${((performance.now() - t) / 1000).toFixed(2)}s, ${res.n_used} exposures D${res.detector}`);
}
// 16 R Dra visits + stack 8 (before the pixel-map speed-up, measured in Node on this machine: reproject_s 1.20-1.23, total 2.8-4.3 s)
{
  const idx2 = await SkyIndex.load(INDEX), t = performance.now();
  const res = await getBlink(idx2, { ra: 248.16761, dec: 66.75498, pm: null, stack: 8, frames: "visits", calibBaseUrl: calibDir });
  report("16 timing R Dra visits+stack8 (reproject_s was ~1.2 s before)", res.timing_s.reproject_s < 0.6, `${JSON.stringify(res.timing_s)} wall ${((performance.now() - t) / 1000).toFixed(2)}s, ${res.frames.length} frames`);
}
// 17 getMoverVideo vs Python mover_video (Solar System movers)
{
  const moversUrl = new URL("../movers/", import.meta.url).href;
  const list = await loadMovers(moversUrl);
  report("17 loadMovers", list.length >= 3 && list.every((m) => m.slug && m.default?.mode), list.map((m) => m.slug + ":" + m.default.mode + "/" + m.default.span).join(" "));
  for (const c of ref.mover) {
    const mv = await loadMover(moversUrl, c.slug);
    const res = await getMoverVideo(mv, { mode: c.mode, span: c.span, maxFrames: c.max_frames || 60, calibBaseUrl: calibDir });
    const sameKeys = res.frames.length === c.frames.length && res.frames.every((f, i) => f.key === c.frames[i].key);
    let maxRel = 0, nfin = 0, agree = 0, tot = 0, maxPx = 0;
    c.frames.forEach((rf, i) => {
      const f = res.frames[i]; if (!f) return;
      maxPx = Math.max(maxPx, Math.abs(f.targetPx[0] - rf.target_px[0]), Math.abs(f.targetPx[1] - rf.target_px[1]));
      const d = b64(rf.b64);
      for (let k = 0; k < d.length; k++) {
        tot++; const a = f.data[k], b = d[k];
        if (Number.isNaN(a) === Number.isNaN(b)) agree++;
        if (!Number.isNaN(a) && !Number.isNaN(b)) { nfin++; maxRel = Math.max(maxRel, Math.abs(a - b) / (Math.abs(b) + 1)); }
      }
    });
    const pct = 100 * agree / tot, fr = res.frames;
    let modeOk = true, moved = 0;
    if (c.mode === "follow") modeOk = fr.every((f) => Math.abs(f.targetPx[0] - (res.n - 1) / 2) < 1e-6 && Math.abs(f.targetPx[1] - (res.n - 1) / 2) < 1e-6);
    else { const a = fr[0].targetPx, b = fr[fr.length - 1].targetPx; moved = Math.hypot(b[0] - a[0], b[1] - a[1]); const ra = c.frames[0].target_px, rb = c.frames[c.frames.length - 1].target_px; modeOk = Math.abs(moved - Math.hypot(rb[0] - ra[0], rb[1] - ra[1])) < 0.01; }
    modeOk = modeOk && fr.every((f) => Number.isFinite(f.ra) && Number.isFinite(f.dec));     // every mover frame carries the object's sky position
    const meta = res.half === c.half && res.n === c.n && res.n_selected === c.n_selected && Math.abs(res.center[0] - c.center[0]) < 1e-6 && Math.abs(res.center[1] - c.center[1]) < 1e-6;
    report(`17 mover ${c.slug} ${c.mode}/${c.span}`, sameKeys && meta && modeOk && maxRel < 1e-3 && pct >= 99.5 && maxPx < 0.01,
      `${fr.length}/${c.frames.length} frames same keys ${sameKeys}, half ${res.half}/${c.half}, selected ${res.n_selected}/${c.n_selected}, max targetPx diff ${maxPx.toExponential(2)}, max rel px diff ${maxRel.toExponential(2)} over ${nfin} finite px, NaN-mask ${pct.toFixed(3)}%${c.mode === "flyby" ? `, object moves ${moved.toFixed(1)} px` : ", targetPx at centre"}; JS ${JSON.stringify(res.timing_s)} vs Python ${c.timing.total_s.toFixed(2)}s; lambda ${fr[0].lambda_um.toFixed(3)}um, ${fr[0].date_time}`);
  }
}
// 18 getLightCurve vs Python lightcurve(max_exposures=60): same images/order, per-point flux (rel 1e-4), flags, channel, lambda, visits, verdict, method
for (const c of ref.lc) {
  const res = await getLightCurve(idx, { ra: c.ra, dec: c.dec, pm: c.pm, name: c.name, maxExposures: 60, calibBaseUrl: calibDir });
  const R = res.raw, P = c.raw, o = c.out;
  const sameImgs = R.length === P.length && R.every((p, i) => p.key === P[i].key && p.det === P[i].det);
  let mxF = 0, mxL = 0, flag = 0, subBad = 0, mxE = 0, mxX = 0, nF = 0;
  if (sameImgs) R.forEach((p, i) => {
    const q = P[i];
    if (p.valid !== q.valid || p.detected !== q.detected) flag++;
    if (p.sub !== q.sub) subBad++;
    mxL = Math.max(mxL, Math.abs(p.lambda_um - q.lambda_um)); mxX = Math.max(mxX, Math.abs(p.x - q.x), Math.abs(p.y - q.y));
    if (q.flux_mJy != null && Number.isFinite(p.flux_mJy)) { nF++; mxF = Math.max(mxF, Math.abs(p.flux_mJy - q.flux_mJy) / (Math.abs(q.flux_mJy) + 1e-9)); }
    if (q.err_mJy != null && Number.isFinite(p.err_mJy)) mxE = Math.max(mxE, Math.abs(p.err_mJy - q.err_mJy) / (Math.abs(q.err_mJy) + 1e-9));
  });
  const sigOk = Math.abs(res.verdict.sigma - o.verdict.sigma) <= Math.max(0.1, 0.02 * o.verdict.sigma);
  let visOk = res.visits.length === o.visits.length, mxV = 0;
  if (visOk) res.visits.forEach((v, i) => { const w = o.visits[i]; mxV = Math.max(mxV, Math.abs(v.mjd - w.mjd) / 1000, v.n === w.n ? 0 : 1, Math.abs((v.rel_all ?? 0) - (w.rel_all ?? 0))); });
  const perOk = (res.period === null) === (o.period === null) && (!o.period || Math.abs(res.period.period_d - o.period.period_d) <= 2);
  report(`18 getLightCurve ${c.name} (max 60)`, sameImgs && flag === 0 && subBad === 0 && mxF < 1e-4 && mxL < 1e-4 && res.method === o.method && sigOk && visOk && mxV < 1e-3 && perOk
      && res.n_images === o.n_images && res.n_measured === o.n_measured && res.n_detected === o.n_detected && res.verdict.variable === o.verdict.variable,
    `${res.method}, images ${res.n_images}/${o.n_images}, measured ${res.n_measured}/${o.n_measured}, detected ${res.n_detected}/${o.n_detected}, same order ${sameImgs}, flag diffs ${flag}, channel diffs ${subBad}, max rel flux diff ${mxF.toExponential(2)} (${nF} pts), err ${mxE.toExponential(2)}, lambda ${mxL.toExponential(2)} um, pixel ${mxX.toExponential(2)}, visits ${res.visits.length}/${o.visits.length} (max diff ${mxV.toExponential(1)}), verdict sigma ${res.verdict.sigma}/${o.verdict.sigma}, period ${res.period?.period_d}/${o.period?.period_d}, ${res.seconds}s`);
}
// 18b loadLightCurve returns the files; timing of getLightCurve with 120 exposures (cold index)
{
  for (const slug of ["barnard", "epsindB", "wise0855", "rwaur", "rdra"]) {
    const lc = await loadLightCurve(new URL("../lightcurves/", import.meta.url).href, slug);
    const file = JSON.parse(fs.readFileSync(new URL(`../lightcurves/${slug}.json`, import.meta.url)));
    report(`18b loadLightCurve ${slug}`, JSON.stringify(lc) === JSON.stringify(file) && lc.points.length === lc.n_measured, `${lc.method}, ${lc.n_measured} points, ${lc.visits.length} visits, verdict ${JSON.stringify(lc.verdict)}`);
  }
  for (const slug of ["rdra", "rwaur", "barnard", "epsindB", "wise0855"]) {      // period fit and verdict re-computed from the stored visits (exact Python inputs)
    const lc = JSON.parse(fs.readFileSync(new URL(`../lightcurves/${slug}.json`, import.meta.url)));
    const per = lcFitPeriod(lc.visits), vd = lcVerdict(lc.visits, lc.method === "ring" ? 0.02 : 0.01);
    const perOk = lc.period ? per && per.period_d === lc.period.period_d && Math.abs(per.amplitude_rel - lc.period.amplitude_rel) < 1e-3 : per === null;
    report(`18b fit_period + verdict from visits ${slug}`, perOk && vd.sigma === lc.verdict.sigma && vd.variable === lc.verdict.variable && vd.from === lc.verdict.from, `period ${per?.period_d}/${lc.period?.period_d}, amp ${per?.amplitude_rel}/${lc.period?.amplitude_rel}, sigma ${vd.sigma}/${lc.verdict.sigma}`);
  }
  for (const [nm, ra, dec, pm] of [["RW Aur", 76.95653, 30.40144, [7.2, -20.3]], ["R Dra", 248.16761, 66.75498, [-20.643, 6.149]]]) {
    const idx2 = await SkyIndex.load(INDEX), t = performance.now(); let last = null;
    const res = await getLightCurve(idx2, { ra, dec, pm, name: nm, maxExposures: 120, calibBaseUrl: calibDir, onProgress: (d, n, ph) => { last = [d, n, ph]; } });
    report(`18c timing getLightCurve ${nm} (120)`, res.n_images <= 120 && last[0] === last[1], `wall ${((performance.now() - t) / 1000).toFixed(1)}s, ${res.method}, ${res.n_detected}/${res.n_images} detected, ${res.visits.length} visits, verdict ${JSON.stringify(res.verdict)}, period ${res.period?.period_d}, last progress ${last}`);
  }
}
// 19 exptime_s / sc_pos_km on frames, stacked members and mover frames; onFrame 4th arg carries the grid
{
  let g4 = null;
  const res = await getBlink(idx, { ra: 133.81891, dec: -7.24705, pm: [-8123.7, 673.2], stack: 4, half: 15, calibBaseUrl: calibDir, onFrame: (f, i, t, prog) => { g4 = g4 ?? prog.grid; } });
  const ok = (e) => e.exptime_s > 0 && Array.isArray(e.sc_pos_km) && e.sc_pos_km.length === 3 && e.sc_pos_km.every(Number.isFinite);
  report("19 exptime_s + sc_pos_km (stacked frames and members)", res.frames.every((f) => ok(f) && f.members.every(ok)), `frame0 ${res.frames[0].exptime_s}s ${res.frames[0].sc_pos_km?.map((v) => v.toFixed(0))} km, member0 ${res.frames[0].members[0].exptime_s}s`);
  report("19 onFrame grid", g4 && JSON.stringify(g4) === JSON.stringify(res.grid) && g4.n === res.grid.n, JSON.stringify(g4).slice(0, 120));
  const raw = await getBlink(idx, { ra: 133.81891, dec: -7.24705, pm: [-8123.7, 673.2], stack: 0, half: 15, calibBaseUrl: calibDir });
  report("19 unstacked frames", raw.frames.every(ok), `${raw.frames.length} frames`);
  const mv = await loadMover(new URL("../movers/", import.meta.url).href, "vesta");
  const mres = await getMoverVideo(mv, { mode: "follow", span: "run", maxFrames: 4, calibBaseUrl: calibDir });
  report("19 mover frames", mres.frames.every(ok), `${mres.frames.length} frames, ${mres.frames[0].exptime_s}s`);
}
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
