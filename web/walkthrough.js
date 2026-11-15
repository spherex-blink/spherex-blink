// Walkthrough mode: a guided tour of every feature, one step per button, each with a good prepared example that shows at once.
// All the data of the tour is fetched in the background as soon as it opens (samples, light curves, the pre-baked deep stack and
// mover videos in lib/spherex/demo/, the Canadian NEOSSat sequences), so a click never waits for NASA.
// Open: the "Walkthrough" button in the menu, or ?walkthrough=1 in the address. Keys: PageDown / PageUp (presentation clickers), Esc.
// Talks to the app only through window.skyblink (setResult, onBundleLoaded, setMode, ...). Written with Claude Code (Daniel, 15.11).
import { surveyLightCurve, drawSurveyLightCurve, loadExplore } from './app-data.js';

const LIB = new URL('./lib/spherex/', import.meta.url);
const A = () => window.skyblink;
const $ = (id) => document.getElementById(id);
const getJSON = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`); return r.json(); };
const f32 = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new Float32Array(u.buffer); };
const dateOf = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 16).replace('T', ' ');
const month = (mjd) => new Date((mjd - 40587) * 86400000).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const preset = (key) => A().PRESETS.find((p) => p.key === key);
const inXR = () => !!A()?.renderer?.xr?.isPresenting;
// ?video=1: a short 25 s cut of the tour for the submission video (fewer steps, faster flights, no welcome card)
const VIDEO = new URLSearchParams(location.search).has('video');
const K = VIDEO ? 0.5 : 1;     // flight and pause durations scale

// ------------------------------------------------------------------ data of the tour (each loader -> a "prepared view")
async function sample(key) {
  const [r, lc] = await Promise.all([getJSON(new URL(`samples/${key}.json`, LIB)), surveyLightCurve(key)]);
  for (const f of r.frames) if (!f.data) { f.data = f32(f.data_b64_f32le); delete f.data_b64_f32le; }
  return { res: r, key, source: 'sample', cur: preset(key), lc };
}
async function mover(file, explore) {
  const d = await getJSON(new URL(`demo/${file}`, LIB)), n = d.n, follow = d.mode === 'follow';
  const frames = d.frames.map(({ data_b64_f32le, ...f }) => ({ ...f, data: f32(data_b64_f32le), width: n, height: n, date: dateOf(f.mjd), n_stack: 1 }))
    .sort((a, b) => a.mjd - b.mjd);
  const res = {
    path: d.span === 'all' ? d.path : null, span: d.span,
    target: { name: d.mover_name, ra: d.center[0], dec: d.center[1], pm_mas_yr: null },
    grid: { n, pix_arcsec: 6.15, center_ra: d.center[0], center_dec: d.center[1], mode: follow ? 'track' : 'sky' },
    options: { mode: follow ? 'track' : 'sky', detectorRequested: 'mixed', frames: 'exposures' },
    detector: frames[0]?.det, n_exposures: d.n_exposures, visits: null, frames, kind: 'mover', about: d.about,
    credit: 'SPHEREx: NASA/JPL-Caltech/IPAC (IRSA). Positions: JPL Horizons (SPHEREx-centred).',
  };
  return { res, key: 'explore:' + explore, source: 'mover', explore, cur: { key: null, name: d.mover_name, ra: d.center[0], dec: d.center[1], pm: null, explore } };
}
async function canada(which) {
  const id = 'canada:' + which, res = await loadExplore(id);
  return { res, key: 'explore:' + id, source: 'flyby', explore: id, cur: { key: null, name: res.target.name, ra: res.target.ra, dec: res.target.dec, pm: null, explore: id } };
}
async function deep() {
  const d = await getJSON(new URL('demo/wise0855-deep.json', LIB));
  return { ...d, track: f32(d.track_b64_f32le), sky: f32(d.sky_b64_f32le) };
}
const DATA = {
  barnard: () => sample('barnard'), wise: () => sample('wise0855'), wiseDeep: deep, rdra: () => sample('rdra'), rwaur: () => sample('rwaur'),
  epsLc: () => surveyLightCurve('epsindB'), fd58: () => mover('fd58-flyby.json', 'mover:162882'), atlas: () => mover('3i-atlas-path.json', 'mover:3i-atlas'),
  neossat: () => canada('neossat'), spxComet: () => canada('spherex'),
};
const cache = {};
const need = (k) => (cache[k] ||= DATA[k]().catch((e) => { delete cache[k]; throw e; }));

// ------------------------------------------------------------------ showing a prepared view in the app (no loader, no NASA request)
// desktop: the tour flies on the sky dome in three slow phases: zoom out (old picture), move across the sky at a wide view,
// then swap in the new picture and zoom in. In VR the head is the camera, so the picture just changes.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * K));
const alive = (my) => my === runSeq && isOpen();
async function flyOver(ra, dec, my) {
  const a = A(), V = a.V;
  const dra = ((ra - V.ra + 540) % 360) - 180, sep = Math.hypot(dra * Math.cos(((dec + V.dec) / 2) * Math.PI / 180), dec - V.dec);
  if (sep < 0.02) return;
  const wide = Math.min(100, Math.max(24, sep * 1.3));
  if (V.fov < wide * 0.85) { a.flyTo(V.ra, V.dec, wide, 1.0 * K); await sleep(1050); if (!alive(my)) return; }
  const mv = Math.min(1.9, 1.0 + sep / 70);
  a.flyTo(ra, dec, Math.max(a.V.fov, wide), mv * K); await sleep(mv * 1000 + 100);
}
async function show(p, mode = 'blink') {
  const a = A(), S = a.S, xr = inXR(), same = S.bundle?.res === p.res, my = runSeq;
  a.cancelLoad(); a.busy.end(); a.loader.hide();
  if (!xr && S.ui !== 'dome') a.setUi('dome');
  const g = p.res.grid || {}, cra = g.center_ra ?? p.res.target.ra, cdec = g.center_dec ?? p.res.target.dec;
  if (!xr && !same) { await flyOver(cra, cdec, my); if (!alive(my)) return; }
  a.clearMoverPath();
  if (S.showMotion) a.toggleMotion(false);
  S.detect = false; if ($('cbDetect')) $('cbDetect').checked = false;
  S.cur = p.cur; S.idx = 0; S.acc = 0; S.explore = p.explore || null; S.lc = p.lc || null; S.hover = null; S.ctx = null; S.playing = true;
  $('inRa').value = p.cur.ra.toFixed(5); $('inDec').value = p.cur.dec.toFixed(5);
  document.querySelectorAll('#presets button').forEach((x) => x.classList.toggle('on', x.dataset.key === p.cur.key));
  document.querySelectorAll('#exploreList button').forEach((x) => x.classList.toggle('on', x.dataset.id === p.explore));
  if ($('deepBox')) $('deepBox').hidden = true;
  a.setResult(p.res, { key: p.key, source: p.source }); a.Z.fitted = false; a.onBundleLoaded();
  if (p.res.path) a.setMoverPath(p.res);
  a.setMode(mode);
  try { a.drawLocator(); } catch (e) { /* locator not ready */ }
  a.setStatus(`${p.res.target.name}: ${a.S.views.length} frames (walkthrough example).`, 'ok');
  a.render();
  if (xr) return;
  if (p.res.path?.length > 1) { await sleep(1200); return; }     // a comet's whole path: setMoverPath flies out to show it; the zoom cone shows the moving image
  const d = same ? 0.4 : 1.3;
  a.flyTo(S.bundle.target.center_ra, S.bundle.target.center_dec, S.bundle.grid.fov_arcsec / 3600 / 0.7, d * K); await sleep(d * 1000 + 100);
}
async function skyOverview(my) {
  const a = A();
  a.cancelLoad(); a.busy.end(); a.loader.hide();
  if (a.S.showMotion) a.toggleMotion(false);
  if (inXR()) return;
  if (a.S.ui !== 'dome') a.setUi('dome');
  if (a.V.fov < 40) { a.flyTo(a.V.ra, a.V.dec, 60, 1.2 * K); await sleep(1250); if (!alive(my)) return; }
  a.flyTo(300, 28, 95, 1.8 * K); await sleep(1850);
}
// "the user drags the sky": a hand cursor sweeps across while the view pans, so a recording shows that you can look around
async function lookAround(my) {
  const a = A(); if (inXR()) return;
  const hand = document.createElement('div'); hand.className = 'wt-click wt-drag';
  hand.innerHTML = '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5V4a1.5 1.5 0 0 1 3 0v6m0-4.5a1.5 1.5 0 0 1 3 0V11m0-3.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.6-2.2L3.6 16a1.6 1.6 0 0 1 2.4-2.1L8 16" fill="#fff" stroke="#0b0e1a" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const r = a.renderer.domElement.getBoundingClientRect(), y = r.top + r.height * 0.55;
  Object.assign(hand.style, { left: (r.left + r.width * 0.62) + 'px', top: y + 'px', transition: `left ${1.4 * K}s ease-in-out, top ${1.4 * K}s ease-in-out` });
  document.body.appendChild(hand);
  const pan = async (ra, dec, x, ms) => { hand.style.left = (r.left + r.width * x) + 'px'; a.flyTo(ra, dec, 95, ms * K / 1000); await sleep(ms + 50); };
  await new Promise((res) => requestAnimationFrame(res));
  await pan(322, 34, 0.38, 1400); if (!alive(my)) { hand.remove(); return; }     // drag to the left: the view turns east
  await pan(284, 14, 0.66, 1400); hand.remove();                               // drag back: the Milky Way and Barnard's Star come into view
}
// "the user clicks here": a pointer and a ring at a sky position, so a recording shows the click before the flight
function clickAt(ra, dec) {
  const a = A(), D = Math.PI / 180;
  const dir = (r, d) => new a.THREE.Vector3(Math.cos(d * D) * Math.cos(r * D), Math.sin(d * D), -Math.cos(d * D) * Math.sin(r * D));
  // project with the view the app is heading to (V), not the camera of the last drawn frame (it lags if frames are throttled)
  const cam = a.camera.clone(); cam.fov = a.V.fov; cam.updateProjectionMatrix(); cam.up.set(0, 1, 0);
  cam.lookAt(dir(a.V.ra, a.V.dec).add(cam.position)); cam.updateMatrixWorld();
  const v = dir(ra, dec); if (a.sky) v.applyQuaternion(a.sky.quaternion);
  v.add(cam.position).project(cam);
  const r = a.renderer.domElement.getBoundingClientRect(), x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
  const c = document.createElement('div'); c.className = 'wt-click'; c.style.left = x + 'px'; c.style.top = y + 'px';
  c.innerHTML = '<i></i><svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2 L4 20 L9 15 L12.5 22 L15.5 20.6 L12 13.8 L19 13.8 Z" fill="#fff" stroke="#0b0e1a" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c); setTimeout(() => c.remove(), 1600);
}

// small pictures inside the card
function drawImage(cv, data, n, cross) {
  const v = []; for (const x of data) if (Number.isFinite(x)) v.push(x); v.sort((p, q) => p - q);
  const lo = v[Math.floor(v.length * 0.02)] ?? 0, hi = v[Math.floor(v.length * 0.998)] ?? 1;
  cv.width = cv.height = n; const c = cv.getContext('2d'), id = c.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const val = data[(n - 1 - y) * n + (n - 1 - x)], o = (y * n + x) * 4;     // row 0 = south, column 0 = east: north up, east left
    const t = Number.isFinite(val) ? Math.asinh(8 * Math.max(0, (val - lo) / (hi - lo))) / Math.asinh(8) : null;
    const g = t == null ? [46, 52, 74] : [255 * Math.min(1, t), 255 * Math.min(1, t), 255 * Math.min(1, t)];
    id.data[o] = g[0]; id.data[o + 1] = g[1]; id.data[o + 2] = g[2]; id.data[o + 3] = 255;
  }
  c.putImageData(id, 0, 0);
  if (cross) {
    const [x, y] = [n - 1 - cross[0], n - 1 - cross[1]];
    c.strokeStyle = '#f2c46d'; c.lineWidth = 1; c.beginPath();
    c.moveTo(x - 7, y); c.lineTo(x - 3, y); c.moveTo(x + 3, y); c.lineTo(x + 7, y); c.moveTo(x, y - 7); c.lineTo(x, y - 3); c.moveTo(x, y + 3); c.lineTo(x, y + 7); c.stroke();
  }
}
const lcCanvas = (lc, h = 150) => { const cv = document.createElement('canvas'); cv.width = 720; cv.height = h * 2; drawSurveyLightCurve(cv, lc); return cv; };

// ------------------------------------------------------------------ the steps
const CANADA = '🍁';     // (flag emoji show as letters on Windows)
const BARNARD = { ra: 269.45208, dec: 4.69336 };
const STEPS = [
  { t: 'Click any point of the sky', view: 3, data: ['barnard'], pre: () => need('barnard'),
    go: async (p, my) => {
      await skyOverview(my); if (!alive(my)) return;
      if (!inXR()) { await sleep(300); if (!alive(my)) return; await lookAround(my); if (!alive(my)) return; clickAt(BARNARD.ra, BARNARD.dec); await sleep(650); if (!alive(my)) return; }
      await show(p);
    },
    html: () => `NASA's SPHEREx maps the whole sky in <b>102 infrared colours</b>. <b>Click any point</b>: its video appears in seconds, straight from NASA.` },
  { t: "A star that moves: Barnard's Star", view: 3.5, data: ['barnard'], pre: () => need('barnard'), go: (p) => show(p),
    html: () => `The fastest star in our sky: <b>it jumps between visits</b>, the background stays still.` },
  { t: 'Difference view + measured motion', view: 3.5, data: ['barnard'], pre: () => need('barnard'), go: async (p) => { await show(p, 'diff'); A().toggleMotion(true); },
    html: () => `<b style="color:#ff8a8a">Red</b> = now, <b style="color:#8ab4ff">blue</b> = before. The arrow is the <b>speed and direction</b> measured from the images.` },
  { t: 'A hidden brown dwarf: WISE 0855', view: 3.5, data: ['wise', 'wiseDeep'], pre: async () => ({ p: await need('wise'), deep: await need('wiseDeep') }), go: (d) => show(d.p),
    html: (d) => `A cold brown dwarf, <b>invisible in single images</b>. Stacking ${d.deep.n_used} exposures along its motion reveals it.`,
    extra: ({ p, deep: d }, box) => {     // left: one visit (what a single blink frame shows); right: all exposures stacked along its motion
      const f = p.res.frames[0];
      box.innerHTML = `<div class="wt-two"><figure><canvas></canvas><figcaption>One visit</figcaption></figure>
        <figure><canvas></canvas><figcaption>${d.n_used} stacked along its motion · <b>S/N ${d.snr_track.toFixed(1)}</b></figcaption></figure></div>`;
      const [c1, c2] = box.querySelectorAll('canvas');
      drawImage(c1, f.data, f.width, f.targetPx); drawImage(c2, d.track, d.n, d.center_px);
    } },
  { t: 'A pulsating giant: R Draconis', view: 3, data: ['rdra'], pre: () => need('rdra'), go: (p) => show(p),
    html: (p) => `Too bright for the detector, yet its light curve gives the <b>${Math.round(p.lc?.period?.period_d || 239)}-day</b> cycle.`,
    extra: (p, box) => { box.replaceChildren(lcCanvas(p.lc)); } },
  { t: 'A flickering young star: RW Aurigae', view: 3, data: ['rwaur', 'epsLc'], pre: async () => ({ p: await need('rwaur'), eps: await need('epsLc') }), go: (d) => show(d.p),
    html: () => `A young star <b>fading at 4–5 µm</b>. The control star below stays steady.`,
    extra: (d, box) => { box.replaceChildren(lcCanvas(d.p.lc, 130), lcCanvas(d.eps, 130)); } },
  { t: 'An asteroid in minutes: 2001 FD58', view: 3, data: ['fd58'], pre: () => need('fd58'), go: (p) => show(p),
    html: () => `A near-Earth asteroid <b>crossing the stars in minutes</b>, positions computed as seen from SPHEREx.` },
  { t: 'The interstellar comet, over months', view: 3, data: ['atlas'], pre: () => need('atlas'), go: (p) => show(p),
    html: (p) => { const f = p.res.frames, mo = Math.round((f.at(-1).mjd - f[0].mjd) / 30.4);
      return `Comet 3I/ATLAS, from another star, <b>followed for ${mo} months</b>: the stars stream past.`; } },
  { t: `${CANADA} Canada's NEOSSat sees it too`, view: 3, canada: true, data: ['neossat'], pre: () => need('neossat'), go: (p) => show(p),
    html: () => `Canada's <b>NEOSSat</b> imaged the same comet <b>thousands of times</b>. Here: one hour, visible light.` },
  { t: `${CANADA} Two telescopes, one timeline`, view: 3.5, canada: true, data: ['spxComet'], pre: () => need('spxComet'), go: (p) => show(p),
    html: () => `SPHEREx sees it in infrared: <b>two telescopes, one timeline</b>. NEOSSat's orbit predicts where the comet is.
      <div class="wt-link"><a href="lib/spherex/demo-canada.html" target="_blank" rel="noopener">Open the two-telescope page ↗</a></div>` },
  { t: 'Step inside: VR', view: 3, pre: () => null,
    go: async () => { if (!inXR()) { const a = A(), t = a.S.bundle?.target; if (t) { a.flyTo(t.center_ra, t.center_dec, 30, 1.6); await sleep(1650); } } },
    html: () => inXR() ? `You are inside it: <b>point, zoom and play</b> with the controllers.` : `On a Meta Quest, press <b>VR</b> and stand inside the infrared sky.` },
  { t: 'Your turn', view: 3, pre: () => null, go: (d, my) => skyOverview(my),
    html: () => `<b>Click any point</b> of the sky and see what moves and what varies.` },
];

if (VIDEO) {
  const pick = (t) => STEPS.find((x) => x.t.startsWith(t));
  const v = [
    { ...pick("A star that moves"), t: "Barnard's Star: a star that moves", view: 2.2,
      go: async (p, my) => {
        await skyOverview(my); if (!alive(my)) return;
        await lookAround(my); if (!alive(my)) return;
        clickAt(BARNARD.ra, BARNARD.dec); await sleep(650); if (!alive(my)) return;
        await show(p);
      },
      html: () => `<b>Click any point</b> of the sky: its SPHEREx video appears in seconds. The fastest star in our sky <b>jumps between visits</b>.` },
    { ...pick('Difference view'), view: 2.8 },
    { ...pick('A hidden brown dwarf'), view: 3.0 },
    { ...pick(`${CANADA} Canada's NEOSSat`), t: `${CANADA} Canada's NEOSSat: the comet in one hour`, view: 3.4,
      html: () => `Possible only because NEOSSat <b>imaged the comet every 1.7 minutes</b>: 40 shots in one hour, so you watch it <b>cross the stars</b>.` },
  ];
  STEPS.splice(0, STEPS.length, ...v);
}

// ------------------------------------------------------------------ the card
const CSS = `
#wt{position:fixed;left:14px;top:62px;z-index:8000;width:min(390px,calc(100vw - 28px));max-height:calc(100vh - 230px);overflow:auto;
  box-sizing:border-box;padding:14px 16px 12px;border-radius:14px;background:rgba(14,18,32,.92);border:1px solid rgba(148,163,255,.22);
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 18px 50px rgba(0,0,0,.45);color:#e6e9f5;
  font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#wt[hidden]{display:none}
#wt.wt-canada{border-color:rgba(255,92,92,.55);box-shadow:0 18px 50px rgba(0,0,0,.45),0 0 0 1px rgba(255,92,92,.25) inset}
#wt .wt-top{display:flex;align-items:center;gap:8px;margin-bottom:8px}
#wt .wt-kicker{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8b93ff;flex:1}
#wt .wt-x{background:none;border:0;color:#8e98b8;font-size:16px;cursor:pointer;padding:2px 6px}
#wt h2{margin:0 0 6px;font-size:18px;line-height:1.3}
#wt .wt-body b{color:#f2c46d;font-weight:600}
#wt .wt-extra canvas{display:block;width:100%;height:auto;border-radius:8px;margin-top:8px;image-rendering:pixelated}
#wt .wt-two{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
#wt .wt-two figure{margin:0}#wt .wt-two canvas{margin-top:0}
#wt figcaption{font-size:11px;color:#8e98b8;margin-top:3px;text-align:center}
#wt .wt-link{margin-top:8px}#wt .wt-link a{color:#8b93ff}
#wt .wt-nav{display:flex;gap:8px;margin-top:12px}
#wt .wt-nav button{flex:1;padding:8px 10px;border-radius:9px;border:1px solid rgba(148,163,255,.3);background:rgba(28,34,58,.9);color:#e6e9f5;
  font:600 13px system-ui,sans-serif;cursor:pointer}
#wt .wt-nav button.wt-next{background:#6f78f0;border-color:#6f78f0}
#wt .wt-nav button:disabled{opacity:.4;cursor:default}
#wt .wt-dots{display:flex;flex-wrap:wrap;gap:4px;margin-top:10px}
#wt .wt-dots button{min-width:26px;height:24px;padding:0 5px;border-radius:7px;border:1px solid rgba(148,163,255,.25);background:transparent;color:#8e98b8;
  font:12px system-ui,sans-serif;cursor:pointer}
#wt .wt-dots button.on{background:#8b93ff;border-color:#8b93ff;color:#0b0e1a;font-weight:700}
#wt .wt-dots button.ca{border-color:rgba(255,92,92,.6)}
#wt .wt-dots button.ready::after{content:'';display:inline-block;width:4px;height:4px;border-radius:2px;background:#6ee7b7;margin-left:3px;vertical-align:middle}
#wt .wt-prep{font-size:11px;color:#8e98b8;margin-top:6px;min-height:15px}
#wt .wt-wait{color:#8e98b8;font-style:italic}
@media(max-width:700px){#wt{top:auto;bottom:10px;max-height:46vh}}
#wt .wt-bar{height:3px;border-radius:3px;background:rgba(148,163,255,.16);margin-top:10px;overflow:hidden}
#wt .wt-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#8b93ff,#f2c46d)}
#wt-welcome{position:fixed;inset:0;z-index:8500;display:flex;align-items:center;justify-content:center;pointer-events:none}
#wt-welcome .card{pointer-events:auto;width:min(460px,calc(100vw - 32px));box-sizing:border-box;padding:22px 24px 20px;border-radius:18px;text-align:center;
  background:rgba(14,18,32,.88);border:1px solid rgba(148,163,255,.25);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  box-shadow:0 24px 70px rgba(0,0,0,.5);color:#e6e9f5;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#wt-welcome img{width:96px;height:96px}
#wt-welcome h1{margin:6px 0 4px;font-size:26px;letter-spacing:.01em}
#wt-welcome p{margin:0 0 16px;color:#b8bfd8}
#wt-welcome .row{display:flex;gap:10px}
#wt-welcome button{flex:1;padding:12px 10px;border-radius:11px;border:1px solid rgba(148,163,255,.35);background:rgba(28,34,58,.9);color:#e6e9f5;
  font:600 15px system-ui,sans-serif;cursor:pointer}
#wt-welcome button.go{background:#6f78f0;border-color:#6f78f0}
.wt-click{position:fixed;z-index:8400;pointer-events:none;width:0;height:0}
.wt-click svg{position:absolute;left:-3px;top:-2px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))}
.wt-click i{position:absolute;left:-22px;top:-22px;width:44px;height:44px;border-radius:50%;border:3px solid #f2c46d;box-sizing:border-box;
  animation:wt-ring 1s ease-out .35s both}
@keyframes wt-ring{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}
#wt-welcome .small{margin-top:12px;font-size:12px;color:#8e98b8}`;

let el = null, cur = 0, runSeq = 0, auto = true, timer = 0;
function build() {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  el = document.createElement('div'); el.id = 'wt'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Walkthrough');
  el.innerHTML = `<div class="wt-top"><span class="wt-kicker"></span><button class="wt-x" title="Close the walkthrough (Esc)" aria-label="Close">✕</button></div>
    <h2></h2><div class="wt-body"></div><div class="wt-extra"></div>
    <div class="wt-bar"><i></i></div>
    <div class="wt-nav"><button class="wt-prev" title="Previous step (PageUp)">◀</button><button class="wt-play" title="Pause / play the tour">⏸ Pause</button><button class="wt-next" title="Next step (PageDown)">Next ▶</button></div>
    <div class="wt-dots">${STEPS.map((s, i) => `<button data-i="${i}" class="${s.canada ? 'ca' : ''}" title="${s.t.replace(/"/g, '&quot;')}">${s.canada ? CANADA : i + 1}</button>`).join('')}</div>
    <div class="wt-prep"></div>`;
  document.body.appendChild(el);
  el.querySelector('.wt-x').onclick = close;
  el.querySelector('.wt-prev').onclick = () => go(cur - 1);
  el.querySelector('.wt-next').onclick = () => (cur === STEPS.length - 1 ? close() : go(cur + 1));
  el.querySelector('.wt-play').onclick = () => setAuto(!auto);
  el.querySelector('.wt-dots').onclick = (e) => { const i = e.target.closest('button')?.dataset.i; if (i != null) go(+i); };
  addEventListener('keydown', (e) => {
    if (el.hidden || e.target.matches?.('input, select, textarea')) return;
    if (e.key === 'PageDown') { e.preventDefault(); if (cur < STEPS.length - 1) go(cur + 1); }
    else if (e.key === 'PageUp') { e.preventDefault(); if (cur > 0) go(cur - 1); }
    else if (e.key === 'Escape' && !document.body.classList.contains('menu-open')) close();
  });
}
const ready = new Set();
function prefetch() {
  const keys = [...new Set(STEPS.flatMap((s) => s.data || []))], prep = el.querySelector('.wt-prep');
  const upd = () => {
    const n = keys.filter((k) => ready.has(k)).length;
    prep.textContent = n < keys.length ? `Preparing the examples… ${n}/${keys.length}` : 'All examples ready: no waiting.';
    el.querySelectorAll('.wt-dots button').forEach((b) => b.classList.toggle('ready', (STEPS[+b.dataset.i].data || []).every((k) => ready.has(k))));
  };
  upd();
  for (const k of keys) need(k).then(() => { ready.add(k); upd(); }, () => { prep.textContent = 'Some examples could not be prepared (check the connection).'; });
}

// auto-play: each step shows for its own duration (about a minute in all); the frame rate is set so a video plays through once
function setAuto(on) {
  auto = on; el.querySelector('.wt-play').textContent = on ? '⏸ Pause' : '▶ Play';
  clearTimeout(timer);
  const bar = el.querySelector('.wt-bar i');
  if (on) { if (cur === STEPS.length - 1) { go(0); return; } arm(); } else { bar.style.transition = 'none'; bar.style.width = getComputedStyle(bar).width; }
  vrDraw();
}
function arm() {
  const s = STEPS[cur], bar = el.querySelector('.wt-bar i'), ms = ((s.view || 3) + (inXR() ? 3 : 0)) * 1000;     // VR skips the flights: hold each step longer
  clearTimeout(timer);
  bar.style.transition = 'none'; bar.style.width = '0'; void bar.offsetWidth;
  bar.style.transition = `width ${ms}ms linear`; bar.style.width = '100%';
  timer = setTimeout(() => { if (!el.hidden && auto) { if (cur < STEPS.length - 1) go(cur + 1); else { setAuto(false); if (VIDEO) window.skyblinkVideo.end = performance.now(); } } }, ms);
}
function pace(s) {
  const S = A().S, n = S.views?.length || 0;
  if (n < 2) return;
  const fps = Math.max(1.5, Math.min(12, n / Math.max(1, (s.view || 5) - 0.5)));
  S.speed = fps; const sp = $('inSpeed'); if (sp) sp.value = Math.min(10, Math.round(fps * 2) / 2);
}
async function go(i) {
  i = Math.max(0, Math.min(STEPS.length - 1, i)); cur = i; const s = STEPS[i], seq = ++runSeq;
  if (VIDEO) (window.skyblinkVideo.steps ||= []).push(Math.round(performance.now()));
  clearTimeout(timer);
  el.classList.toggle('wt-canada', !!s.canada);
  el.querySelector('.wt-kicker').textContent = `Walkthrough · ${i + 1} of ${STEPS.length}${s.canada ? ' · Canadian Space Agency data' : ''}`;
  el.querySelector('h2').textContent = s.t;
  el.querySelector('.wt-body').innerHTML = '<span class="wt-wait">One moment…</span>';
  el.querySelector('.wt-extra').replaceChildren();
  el.querySelectorAll('.wt-dots button').forEach((b) => b.classList.toggle('on', +b.dataset.i === i));
  el.querySelector('.wt-prev').disabled = i === 0;
  el.querySelector('.wt-next').textContent = i === STEPS.length - 1 ? 'Finish ✓' : 'Next ▶';
  const bar = el.querySelector('.wt-bar i'); bar.style.transition = 'none'; bar.style.width = '0';
  try {
    const d = await s.pre();
    if (seq !== runSeq) return;
    el.querySelector('.wt-body').innerHTML = s.html(d);     // the text shows during the flight, so there is time to read it
    if (s.extra) s.extra(d, el.querySelector('.wt-extra'));
    vrDraw();
    await s.go(d, seq);
    if (seq !== runSeq) return;
    pace(s);
  } catch (e) {
    if (seq !== runSeq) return;
    el.querySelector('.wt-body').textContent = `This example did not load (${e.message}).`;
  }
  vrDraw();
  if (auto) arm();
}
export function open(step = 0) {
  if (!el) build();
  hideWelcome();
  if (document.body.classList.contains('menu-open')) $('btnMenuClose')?.click();
  el.hidden = false; prefetch(); auto = true; el.querySelector('.wt-play').textContent = '⏸ Pause'; go(step);
}
export function close() {
  if (!el) return;
  el.hidden = true; runSeq++; clearTimeout(timer); vrDraw();
}
export const isOpen = () => !!el && !el.hidden;

// ------------------------------------------------------------------ the same card inside VR (DOM is invisible there): one canvas texture, right of the image
let vr = null;
function vrDraw() {
  const a = A(); if (!a?.THREE || !a.content) return;
  if (!vr) {
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 800;
    const tex = new a.THREE.CanvasTexture(cv); tex.colorSpace = a.THREE.SRGBColorSpace;
    const mesh = new a.THREE.Mesh(new a.THREE.PlaneGeometry(1.2, 0.8), new a.THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
    mesh.position.set(1.5, 0, 0.12); mesh.rotation.y = -0.35; mesh.renderOrder = 20; a.content.add(mesh);
    vr = { cv, tex, mesh };
  }
  const show = isOpen();
  vr.mesh.visible = show; if (!show) return;
  const c = vr.cv.getContext('2d'), W = vr.cv.width, H = vr.cv.height, s = STEPS[cur];
  c.clearRect(0, 0, W, H);
  c.fillStyle = 'rgba(14,18,32,.94)'; c.strokeStyle = s.canada ? 'rgba(255,92,92,.8)' : 'rgba(148,163,255,.45)'; c.lineWidth = 4;
  c.beginPath(); if (c.roundRect) c.roundRect(4, 4, W - 8, H - 8, 34); else c.rect(4, 4, W - 8, H - 8); c.fill(); c.stroke();
  c.fillStyle = '#8b93ff'; c.font = '600 28px system-ui, sans-serif';
  c.fillText(`WALKTHROUGH · ${cur + 1} OF ${STEPS.length}${s.canada ? ' · CANADIAN SPACE AGENCY' : ''}${auto ? '' : ' · PAUSED'}`, 44, 64);
  c.fillStyle = '#e6e9f5'; c.font = '700 48px system-ui, sans-serif'; c.fillText(s.t, 44, 128);
  // body text with the bold parts in gold, word-wrapped
  const tmp = document.createElement('div'); tmp.innerHTML = el.querySelector('.wt-body').innerHTML;
  tmp.querySelectorAll('.wt-link').forEach((n) => n.remove());
  const words = [];
  const walk = (n, bold) => { for (const ch of n.childNodes) { if (ch.nodeType === 3) ch.textContent.split(/\s+/).filter(Boolean).forEach((w) => words.push([w, bold])); else walk(ch, bold || ch.tagName === 'B'); } };
  walk(tmp, false);
  const canvases = [...el.querySelectorAll('.wt-extra canvas')], lh = 42, maxY = canvases.length ? 470 : 740;
  let x = 44, y = 196;
  for (const [w, b] of words) {
    c.font = `${b ? 600 : 400} 32px system-ui, sans-serif`; const ww = c.measureText(w + ' ').width;
    if (x + ww > W - 44) { x = 44; y += lh; if (y > maxY) break; }
    c.fillStyle = b ? '#f2c46d' : '#e6e9f5'; c.fillText(w, x, y); x += ww;
  }
  if (canvases.length) {     // the step's pictures (deep stack, light curves) along the bottom
    const gap = 20, top = 500, h = H - top - 40, w = (W - 88 - gap * (canvases.length - 1)) / canvases.length;
    canvases.forEach((cv, k) => { const sc = Math.min(w / cv.width, h / cv.height), dw = cv.width * sc, dh = cv.height * sc;
      c.imageSmoothingEnabled = cv.width > 200; c.drawImage(cv, 44 + k * (w + gap) + (w - dw) / 2, top + (h - dh) / 2, dw, dh); });
  }
  c.fillStyle = 'rgba(148,163,255,.25)'; c.fillRect(44, H - 26, W - 88, 6);
  c.fillStyle = '#8b93ff'; c.fillRect(44, H - 26, (W - 88) * (cur + 1) / STEPS.length, 6);
  vr.tex.needsUpdate = true;
}

// ------------------------------------------------------------------ first visit: the sky, no menu, and two choices
let welcomeEl = null;
function hideWelcome() { if (welcomeEl) { welcomeEl.remove(); welcomeEl = null; } }
function welcome() {
  if (!document.getElementById('wt-style-w')) { const st = document.createElement('style'); st.id = 'wt-style-w'; st.textContent = CSS.slice(CSS.indexOf('#wt-welcome')); document.head.appendChild(st); }
  if (document.body.classList.contains('menu-open')) $('btnMenuClose')?.click();
  welcomeEl = document.createElement('div'); welcomeEl.id = 'wt-welcome';
  welcomeEl.innerHTML = `<div class="card"><img src="assets/cow/cow-wave-128.png" alt=""><h1>SPHEREx Blink</h1>
    <p>See how the infrared sky changes: what moves and what varies. Every image of NASA's SPHEREx, at any point of the sky.</p>
    <div class="row"><button class="go">▶ Watch the 1-minute tour</button><button class="jump">🚀 Jump in</button></div>
    <div class="small">The tour plays by itself; Pause, Back and Next are on its card. It also runs inside VR.</div></div>`;
  document.body.appendChild(welcomeEl);
  welcomeEl.querySelector('.go').onclick = () => open(0);
  welcomeEl.querySelector('.jump').onclick = () => { hideWelcome(); hint(); };
}
function hint() {
  const msg = 'Drag to look around, scroll to zoom. Click anywhere on the sky to load SPHEREx images of that spot, or open ☰ Controls for targets, comets and the walkthrough.';
  const h = document.createElement('div');
  h.innerHTML = '<img class="hint-cow" src="assets/cow/cow-wave-128.png" alt=""><span><b>Moo, welcome aboard!</b> ' + msg + '</span>';
  Object.assign(h.style, { position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', maxWidth: 'min(560px, calc(100vw - 32px))', zIndex: 6,
    padding: '10px 16px', borderRadius: '12px', background: 'rgba(14,18,32,.86)', border: '1px solid rgba(148,163,255,.18)', color: '#e6e9f5',
    font: '14px/1.45 system-ui, sans-serif', textAlign: 'left', backdropFilter: 'blur(8px)', pointerEvents: 'none', transition: 'opacity .4s',
    display: 'flex', alignItems: 'center', gap: '12px' });
  document.body.appendChild(h);
  const bye = () => { h.style.opacity = '0'; setTimeout(() => h.remove(), 500); removeEventListener('pointerdown', bye, true); };
  setTimeout(() => addEventListener('pointerdown', bye, true), 300);
}

// wire up once the app is ready
(async () => {
  for (let k = 0; k < 400 && !window.skyblink?.setResult; k++) await new Promise((r) => setTimeout(r, 50));
  if (!window.skyblink?.setResult) return;
  window.skyblink.walkthrough = { open, close, isOpen };
  const b = $('btnWalk'); if (b) b.onclick = () => open(0);
  const Q = new URLSearchParams(location.search), q = Q.get('walkthrough');
  if (VIDEO) { window.skyblinkVideo = { start: performance.now() }; open(0); }
  else if (q != null) open(Math.max(0, (parseInt(q, 10) || 1) - 1));
  else if (!['target', 'explore', 'ra', 'dec'].some((k) => Q.has(k))) welcome();
  window.skyblink.renderer?.xr?.addEventListener?.('sessionstart', () => setTimeout(vrDraw, 300));
})();
