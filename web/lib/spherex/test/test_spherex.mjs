// Run: node web/lib/spherex/test/test_spherex.mjs   (needs data/scratch/js/fixture.json from pipeline/tests/make_js_fixture.py)
import { readFileSync } from "node:fs";
import { fetchHeader, worldToPixel, pixelToWorld, fetchCutout } from "../spherex.mjs";

const fx = JSON.parse(readFileSync(new URL("../../../../data/scratch/js/fixture.json", import.meta.url)));
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + " " + info); if (!ok) fail++; };

// Test 1+2: WCS vs astropy
let maxPx = 0, maxPxApprox = 0, maxArc = 0;
for (const f of fx.wcs) {
  const hdr = await fetchHeader(f.key);
  for (const p of f.pts) {
    const [x, y] = worldToPixel(hdr, p.ra, p.dec);
    maxPx = Math.max(maxPx, Math.hypot(x - p.bx, y - p.by));
    const [xa, ya] = worldToPixel(hdr, p.ra, p.dec, { approx: true });
    maxPxApprox = Math.max(maxPxApprox, Math.hypot(xa - p.bx, ya - p.by));
    const [ra, dec] = pixelToWorld(hdr, p.x, p.y);
    let dra = (ra - p.ra + 540) % 360 - 180;
    maxArc = Math.max(maxArc, 3600 * Math.hypot(dra * Math.cos(p.dec * Math.PI / 180), dec - p.dec));
  }
}
check("worldToPixel refined", maxPx < 0.01, `max |dpix| = ${maxPx.toExponential(2)} px`);
console.log(`     AP/BP-only max |dpix| = ${maxPxApprox.toFixed(4)} px`);
check("pixelToWorld", maxArc < 0.05, `max = ${maxArc.toExponential(2)} arcsec`);

// Test 3: cutout equality
let nbad = 0, total = 0;
for (const c of fx.cutouts) {
  const hdr = await fetchHeader(c.key);
  const r = await fetchCutout(c.key, hdr, c.ra, c.dec);
  let ok = r && r.x0 === c.x0 && r.y0 === c.y0 && r.height === c.shape[0] && r.width === c.shape[1];
  if (ok) for (let i = 0; i < c.data.length; i++) {
    const a = r.data[i], b = c.data[i];
    if (b === null ? !Number.isNaN(a) : a !== b) { ok = false; break; }
  }
  total++; if (!ok) nbad++;
}
check("cutout equality", nbad === 0, `${total - nbad}/${total} identical (incl. NaN, x0, y0, edge cases)`);

// Test 4: timing
const { keys, pts } = fx.timing;
async function pool(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}
let t0 = performance.now();
const hdrs = await pool(keys, 16, (k) => fetchHeader(k));
const tH = performance.now() - t0;
t0 = performance.now();
const cuts = await pool(keys, 16, (k, i) => fetchCutout(k, hdrs[i], pts[i][0], pts[i][1]));
const tC = performance.now() - t0;
console.log(`TIMING 32 headers: ${(tH / 1000).toFixed(2)} s; 32 cutouts: ${(tC / 1000).toFixed(2)} s (non-null: ${cuts.filter(Boolean).length})`);
process.exit(fail ? 1 : 0);
