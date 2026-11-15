// SPHEREx Blink: the app (Maor's side). Data comes ONLY from Daniel's data layer in ./lib/spherex/ (never edited here):
// the browser reads NASA's SPHEREx images straight from NASA's S3 bucket; there is no server of ours.
// Offline fallback: ./lib/spherex/samples/*.json (same shape as a live getBlink() result).
// Written with the help of Claude (AI), per the Space Apps AI disclosure rule.
import * as THREE from 'three';
import { VRButton } from './vendor/VRButton.js';
import { createVrLoader } from './app-vr.js';
import { SkyIndex, getBlink, getDeepStack, resolveName, apertureSnr } from './lib/spherex/index.mjs';
import { Tiles, gnomonic, ungnomonic, nearestFrame, tileCenter } from './app-tiles.js';
import { exploreItems, loadExplore, surveyLightCurve, drawSurveyLightCurve } from './app-data.js';
import { createLoader, drawExtendedPreview, invalidateExtendedPreview, drawHoverTile, drawCoordGrid } from './ui-extras.js';
import { createHipsLayer } from './hips-tiles.js';
import { initUx, busy, drawFrameLabel, createDetStrip, makePathLine, disposeObject, pathExtentDeg, drawPathInset, hidePathInset, createPlaybar } from './app-ux.js';

const $ = (id) => document.getElementById(id);
// The five test targets (J2000, proper motion in mas/yr; handoff/daniel-to-maor/02-data.md). key = sample file name.
const PRESETS = [
  { key: 'barnard', label: "Barnard's Star", name: "Barnard's Star", ra: 269.45208, dec: 4.69336, pm: [-801.6, 10362.4] },
  { key: 'epsindB', label: 'Epsilon Indi B', name: 'Epsilon Indi B', ra: 331.04415, dec: -56.78284, pm: [3982.0, -2466.8] },
  { key: 'wise0855', label: 'WISE 0855', name: 'WISE 0855-0714', ra: 133.81891, dec: -7.24705, pm: [-8123.7, 673.2] },
  { key: 'rwaur', label: 'RW Aurigae', name: 'RW Aurigae', ra: 76.95653, dec: 30.40144, pm: [7.2, -20.3] },
  { key: 'rdra', label: 'R Draconis', name: 'R Draconis', ra: 248.16761, dec: 66.75498, pm: [-20.6, 6.1] },
];
const TRACK_COLORS = ['#f2c46d', '#8b93ff', '#ff7ab6', '#8ff0b0', '#c39bff'];
const NAN_RGB = [46, 52, 74], NAN_DIFF_RGB = [70, 74, 96];   // "no data" must never look like sky (02-data.md rule 2)

const S = {
  bundle: null, cur: null, frames: [], views: [], idx: 0, playing: true, speed: 2, acc: 0,
  mode: 'blink', ui: '2d', relief: 0.15, tilt: 50, showMotion: false, motion: null, ctx: null, stretch: 'asinh', white: 0.995, cmap: 'grey', smooth: 0, showPred: true, grid: false,
  detect: false, detDiff: false, minSize: 9, sigma: 5, detections: [],
  marks: [], saved: [], history: [], pickMode: false, pendingMarks: null, chart: 'light', lim: [0, 1], dlim: 1, stackImg: null, useName: false,
};

// ------------------------------------------------------------------ helpers
const finite = Number.isFinite;
function quantile(sorted, q) { if (!sorted.length) return NaN; const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1)))); return sorted[i]; }
function finiteSorted(arr, step = 1) { const v = []; for (let i = 0; i < arr.length; i += step) if (finite(arr[i])) v.push(arr[i]); return v.sort((a, b) => a - b); }
function b64ToBytes(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
function mjdToYear(mjd) { return 2000 + (mjd - 51544.5) / 365.25; }
function mjdToDate(mjd) { return new Date((mjd - 40587) * 86400000).toISOString().slice(0, 16).replace('T', ' '); }
function fmt(v, d = 3) { return v == null || !finite(v) ? '—' : (+v).toFixed(d); }
function setStatus(msg, kind = '') { const el = $('status'); el.textContent = msg; el.className = 'status ' + kind; }

function nanMean(arrs, n2) {
  const out = new Float32Array(n2), cnt = new Uint16Array(n2);
  for (const a of arrs) for (let i = 0; i < n2; i++) if (finite(a[i])) { out[i] += a[i]; cnt[i]++; }
  for (let i = 0; i < n2; i++) out[i] = cnt[i] ? out[i] / cnt[i] : NaN;
  return out;
}

function gaussSmooth(img, n, sigma) {
  if (!sigma) return img;
  const r = Math.max(1, Math.ceil(2.5 * sigma)), k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const pass = (src, horiz) => {
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let s = 0, w = 0;
      for (let i = -r; i <= r; i++) {
        const xx = horiz ? x + i : x, yy = horiz ? y : y + i;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const v = src[yy * n + xx];
        if (finite(v)) { s += v * k[i + r]; w += k[i + r]; }
      }
      out[y * n + x] = w ? s / w : NaN;
    }
    return out;
  };
  const sm = pass(pass(img, true), false);
  for (let i = 0; i < n * n; i++) if (!finite(img[i])) sm[i] = NaN;
  return sm;
}


// ------------------------------------------------------------------ data loading (through Daniel's data layer)
const QS = new URLSearchParams(location.search);
// On the site the sky index is at ./index/; anywhere else (localhost) use the live one, which allows CORS.
const INDEX_URL = QS.get('index') || (location.hostname.endsWith('github.io') ? new URL('./index/', location.href).href : 'https://spherex-blink.github.io/index/');
let skyIndex = null, ctrl = null, loadSeq = 0;
async function getIndex() { if (!skyIndex) skyIndex = await SkyIndex.load(INDEX_URL); return skyIndex; }
const loader = createLoader();
{ const hide0 = loader.hide.bind(loader); loader.hide = (...a) => { busy.settle(); return hide0(...a); }; }     // the first image of the new detector is on screen: stop dimming
// tiles around the point (cache + load order), see app-tiles.js
const tiles = new Tiles({ getIndex, getBlink, onChange: () => { invalidateTileCanvases(); draw2d(); } });
const detLabel = (d) => (typeof d === 'number' ? 'D' + d : d == null ? '?' : String(d));
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
function decodeSample(r) {
  for (const f of r.frames) if (!f.data) { const u = b64ToBytes(f.data_b64_f32le); f.data = new Float32Array(u.buffer, u.byteOffset, f.width * f.height); }
  return r;
}
// "auto" depends on what you look at (15.11): any spot on the sky -> D1 (0.75-1.1 um: lowest background, most stars, sharpest view);
// the five test targets -> the data layer's long-wave choice (cold brown dwarfs like WISE 0855 only show at 4-5 um, and the saved
// samples are D6); asteroids/comets keep their own files. If D1 has no image at a spot, loadTarget falls back to the long-wave rule.
function autoDetector() { return S.cur && !S.cur.key ? 1 : 'auto'; }
function opts() {
  const d = $('inDet').value;
  return { detector: d === 'auto' ? autoDetector() : +d, frames: $('inFrames').value, stack: +$('inStack').value, mode: $('inView').value, half: +$('inHalf').value };
}
// getBlink, but when the automatic D1 has no image here, retry with the data layer's own automatic choice
async function blinkAuto(index, args) {
  try { return await getBlink(index, args); }
  catch (e) { if ($('inDet').value === 'auto' && args.detector === 1 && /from detector/i.test(e.message)) return getBlink(index, { ...args, detector: 'auto' }); throw e; }
}
const isDefaultOpts = (o) => o.detector === 'auto' && o.frames === 'visits' && o.stack === 8 && o.mode === 'sky' && o.half === 30;

// res = a getBlink() result or a sample file (same shape)
function setResult(res, info) {
  const g = res.grid || {}, t = res.target, pm = t.pm_mas_yr, n = g.n ?? res.frames[0].width, pix = g.pix_arcsec || 6.15;
  S.bundle = {
    res, source: info.source,
    target: { key: info.key || null, name: t.name, ra: t.ra, dec: t.dec, center_ra: g.center_ra ?? t.ra, center_dec: g.center_dec ?? t.dec,
      pmra_masyr: pm ? pm[0] : 0, pmdec_masyr: pm ? pm[1] : 0 },
    grid: { n, pixel_arcsec: pix, fov_arcsec: n * pix, track: (res.options?.mode || g.mode) === 'track' },
  };
  S.provisional = false;
  if (tiles.center && !S.explore) tiles.recenter(S.bundle.target.center_ra, S.bundle.target.center_dec);     // neighbours around the image's real centre (proper motion)
  S.frames = res.frames.slice().sort((a, b) => a.mjd - b.mjd);
  if (!S.bundle0 || S.bundle0 !== info.key + ':' + t.name) { if (S.keepViewSeq !== loadSeq) Z.fitted = false; S.bundle0 = info.key + ':' + t.name; }
  S.marks = [];
  rebuild();
}

const netMsg = (e) => (e instanceof TypeError || /fetch|network/i.test(e.message) ? 'No connection to NASA data (check your internet). The five targets also work offline.' : e.message);
async function loadTarget(t) {
  S.vload = null;
  if (S.ui === 'dome' && S.bundle && S.cur && !S.keepNext && (Math.abs(S.cur.ra - t.ra) > 1e-6 || Math.abs(S.cur.dec - t.dec) > 1e-6)) pinCurrent();
  if (ctrl) ctrl.abort();
  ctrl = new AbortController(); const signal = ctrl.signal, seq = ++loadSeq;
  S.keepViewSeq = S.keepNext ? seq : -1; S.keepNext = false;     // double-clicked neighbour: keep the view where it is (no re-fit, no blank)
  if (S.cur && !S.skipHistory && (S.cur.ra !== t.ra || S.cur.dec !== t.dec)) { S.history.push(S.cur); S.history = S.history.slice(-20); }
  S.skipHistory = false;
  const sameSpot = !!(S.cur && S.bundle && S.cur.ra === t.ra && S.cur.dec === t.dec && !S.explore);     // a reload (e.g. another detector), not a new point
  S.cur = t; S.idx = 0; S.explore = null; clearMoverPath();
  S.ctx = null; S.hover = null;
  if (!t.key && S.keepViewSeq !== seq) { S.bundle = null; S.views = []; S.frames = []; S.motion = null; skyPlane.visible = false; ctxPlane.visible = false; draw2d(); render(); }     // never show the previous point's image under a new point
  $('inRa').value = t.ra.toFixed(5); $('inDec').value = t.dec.toFixed(5); S.useName = false;
  document.querySelectorAll('#presets button').forEach((x) => x.classList.toggle('on', x.dataset.key === t.key));
  document.querySelectorAll('#exploreList button').forEach((x) => x.classList.remove('on'));
  try { drawLocator(); } catch (e) { /* first call before the locator exists */ }
  $('deepBox').hidden = true; pickRing.visible = !t.key; if (!t.key) pickRing.position.copy(dirOf(t.ra, t.dec).multiplyScalar(R * 0.96)); ctxPlane.visible = false; $('ctxNote').textContent = '';
  const o = opts(); let haveSample = false;
  if (sameSpot) busy.begin(o.detector, t.name, true); else busy.end();      // "Loading D2 (1.1–1.6 µm)…" and the old image greyed out
  writeUrl();
  // the move starts NOW: the camera flies to the point and the zoom cone opens on a "loading" picture, before any data
  loader.show('Flying to ' + t.name, 'Finding SPHEREx images of this spot…');
  flyEarly(t, o);
  tiles.focus(t.ra, t.dec, o);
  S.lc = null;
  surveyLightCurve(t.key).then((lc) => { if (seq === loadSeq) { S.lc = lc; if (S.chart === 'survey') render(); } });
  if (t.key) {       // the five targets: show the saved sample at once (also the offline fallback), then replace it with live data
    try {
      const r = decodeSample(await getJSON(`lib/spherex/samples/${t.key}.json`));
      if (seq !== loadSeq) return;
      if ($('cbLive').checked && typeof o.detector === 'number' && r.detector !== o.detector) throw new Error('sample is another detector');     // a chosen detector must not show (or pin) the D6 sample
      setResult(r, { key: t.key, source: 'sample' }); onBundleLoaded(); haveSample = true; loader.hide();
    } catch (e) { /* no sample: live only */ }
  }
  const live = $('cbLive').checked;
  if (!live) {
    loader.hide(); busy.end();
    $('ctxNote').textContent = 'The surroundings load only with live data.';
    setStatus(haveSample ? `${t.name}: saved sample (offline mode), ${S.views.length} frames, ${detLabel(S.bundle.res.detector)}.` : 'Offline mode: saved samples exist only for the five targets. Tick "Live data" to load another point.', haveSample ? 'ok' : 'bad');
    return;
  }
  const useTiles = +$('inCtx').value > 0 && o.mode !== 'track';
  try {
    // the main tile may already be in the cache (you were here before): show it at once, nothing to download
    const cached = tiles.cachedMain();
    if (cached) {
      setResult(cached, { key: t.key, source: 'live' }); onBundleLoaded(); loader.hide();
      setStatus(`${t.name}: ${S.views.length} frames from the cache (loaded earlier).`, 'ok'); busy.end();
      if (useTiles) await tiles.ring('quick', cached.detector);
      return;
    }
    setStatus((haveSample ? 'Showing the saved sample. ' : '') + 'Looking up the SPHEREx images of this point…');
    const index = await getIndex(); if (seq !== loadSeq) return;
    let det = haveSample && !(typeof o.detector === 'number' && S.bundle.res.detector !== o.detector) ? S.bundle.res.detector : o.detector;
    // 1. ONE image of the clicked spot, so something real is on screen as fast as possible
    const cq = !haveSample && tiles.cachedMainQuick();
    if (cq) {          // this spot was a neighbour you double-clicked: its single image is already here
      setResult(cq, { key: t.key, source: 'live' }); onBundleLoaded(); loader.hide(); det = cq.detector;
    } else if (!haveSample) {
      loader.set('Downloading the first image from NASA…', null);
      const quick = await blinkAuto(index, { ra: t.ra, dec: t.dec, pm: t.pm || null, name: t.name, ...o, frames: 'exposures', maxFrames: 1, stack: 0, signal });
      if (seq !== loadSeq) return;
      setResult(quick, { key: t.key, source: 'live' }); onBundleLoaded(); loader.hide(); tiles.storeMain(quick, 'quick');
      det = quick.detector;
    }
    S.vload = { done: 0, total: null, live: haveSample }; render();     // banner on the image: the rest of the video (or the live data) is still coming
    // 2. ONE image of each surrounding tile (the blurred preview shows until each arrives)
    if (useTiles) {
      setStatus(`${t.name}: first image shown. Loading one image of each neighbouring field…`);
      await tiles.ring('quick', det); if (seq !== loadSeq) return;
    }
    // 3. the rest of the clicked spot's images: the video
    let got = 0, totalMain = '?';
    const say = () => setStatus(`${t.name}: loading the video from NASA, ${got}/${totalMain} frames…`);
    say();
    const res = await blinkAuto(index, { ra: t.ra, dec: t.dec, pm: t.pm || null, name: t.name, ...o, detector: det, signal,
      onFrame: (f, done, total) => { if (seq === loadSeq) { got = done; totalMain = total; say(); busy.progress(done, total); S.vload = { done: done + 1, total, live: haveSample }; render(); } } });
    if (seq !== loadSeq) return;
    S.vload = null;
    setResult(res, { key: t.key, source: 'live' }); onBundleLoaded(); loader.hide(); tiles.storeMain(res, 'full'); busy.end();
    const asOf = index.meta?.data_as_of_mjd ? mjdToDate(index.meta.data_as_of_mjd).slice(0, 10) : '?';
    setStatus(`${t.name}: ${S.views.length} live frames from NASA, detector ${detLabel(res.detector)}, ${res.n_exposures} exposures in the archive, ${res.visits?.length ?? '?'} visits. Data as of ${asOf}.` + (useTiles ? ' Neighbouring fields: one image each. Hover one: click to play its video, double-click to make it the centre.' : ''), 'ok');
    // 4. (on request) a neighbour's video: hover it and click; double-click makes it the new centre
  } catch (e) {
    loader.hide();
    if (e.name === 'AbortError' || seq !== loadSeq) return;
    window.skyblinkLastError = e; console.warn('[loadTarget]', e);     // the real error (the status line shows a friendly one)
    S.vload = null; render();
    busy.end();
    const why = netMsg(e);
    if (haveSample) setStatus(`${t.name}: showing the saved sample (${S.views.length} frames). Live data did not load: ${why}`, 'ok');
    else setStatus(why, 'bad');
  }
}

// the camera starts moving at once, and the zoom cone opens on a placeholder at the true spot, before any data arrives
// in VR, turn the sky so the picked point comes in front of you (just below eye level), in a smooth 0.8 s move
const vrTurn = { q0: null, q1: null, t: 0 };
function vrRecenter(ra, dec) {
  const cam = renderer.xr.getCamera(), q = new THREE.Quaternion(); cam.getWorldQuaternion(q);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q); fwd.y = 0; if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize(); fwd.y = -0.25; fwd.normalize();
  const cur = dirOf(ra, dec).applyQuaternion(sky.quaternion);
  vrTurn.q0 = sky.quaternion.clone(); vrTurn.q1 = new THREE.Quaternion().setFromUnitVectors(cur, fwd).multiply(sky.quaternion); vrTurn.t = 0;
}
function stepVrTurn(dt) {
  if (!vrTurn.q1) return;
  vrTurn.t = Math.min(1, vrTurn.t + dt / 0.8); const e = vrTurn.t < 0.5 ? 4 * vrTurn.t ** 3 : 1 - Math.pow(-2 * vrTurn.t + 2, 3) / 2;
  sky.quaternion.slerpQuaternions(vrTurn.q0, vrTurn.q1, e);
  if (S.bundle) placeContentToward();
  if (vrTurn.t >= 1) vrTurn.q1 = null;
}
function flyEarly(t, o) {
  if (renderer.xr.isPresenting) vrRecenter(t.ra, t.dec);
  const fovAs = (2 * o.half + 1) * 6.15;
  if (!S.bundle) { drawLoadingSky(t.name); skyTex.needsUpdate = true; placeCutoutAt(t.ra, t.dec, fovAs); S.provisional = true; }
  if (renderer.xr.isPresenting || S.ui === '2d') return;
  flyTo(t.ra, t.dec, S.ui === 'dome' ? Math.min(V.fov, 40) : (fovAs / 3600) / 0.7);
}
function drawLoadingSky(name) {
  const W = SKY.width, c = skyCtx;
  const g = c.createRadialGradient(W / 2, W / 2, W * 0.05, W / 2, W / 2, W * 0.7); g.addColorStop(0, '#141a33'); g.addColorStop(1, '#070a14');
  c.fillStyle = g; c.fillRect(0, 0, W, W);
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  c.fillStyle = 'rgba(230,233,245,.55)'; for (let i = 0; i < 260; i++) c.fillRect(rnd() * W, rnd() * W, 1.5 + rnd() * 2, 1.5 + rnd() * 2);
  if (!renderer.xr.isPresenting) {     // (in VR the cow-rocket loading panel in app-vr.js says it)
    c.fillStyle = '#e6e9f5'; c.textAlign = 'center'; c.font = `600 ${Math.round(W / 18)}px system-ui, sans-serif`; c.fillText('🚀 Loading…', W / 2, W / 2);
    c.fillStyle = '#8e98b8'; c.font = `${Math.round(W / 30)}px system-ui, sans-serif`; c.fillText(name || '', W / 2, W / 2 + W / 14); c.textAlign = 'start';
  }
}

// ------------------------------------------------------------------ Explore: asteroids & comets, and the Canadian NEOSSat data
async function openExplore(it) {
  S.vload = null;
  if (S.ui === 'dome' && S.bundle && S.explore !== it.id) pinCurrent();
  busy.end(); clearMoverPath();
  if (ctrl) ctrl.abort();
  ctrl = new AbortController(); const signal = ctrl.signal, seq = ++loadSeq;
  document.querySelectorAll('#exploreList button').forEach((x) => x.classList.toggle('on', x.dataset.id === it.id));
  document.querySelectorAll('#presets button').forEach((x) => x.classList.remove('on'));
  S.explore = it.id; S.lc = null; S.hover = null; tiles.focus(0, 0, opts()); tiles.center = null;
  loader.show(it.kind === 'flyby' ? 'Flying to the interstellar comet' : 'Flying to ' + it.label, it.kind === 'flyby' ? 'Loading the telescope sequence…' : 'Fetching its SPHEREx images from NASA…');
  setStatus(`Loading ${it.label}…`);
  writeUrl();
  try {
    const res = await loadExplore(it.id, { signal, onFrame: (f, done, total) => { if (seq === loadSeq) loader.set(`Fetching images from NASA… ${done + 1}/${total}`, (done + 1) / total); } });
    if (seq !== loadSeq) return;
    S.cur = { key: null, name: res.target.name, ra: res.target.ra, dec: res.target.dec, pm: null, explore: it.id };
    $('inRa').value = res.target.ra.toFixed(5); $('inDec').value = res.target.dec.toFixed(5);
    setResult(res, { key: 'explore:' + it.id, source: it.kind }); Z.fitted = false; onBundleLoaded(); loader.hide();
    setMoverPath(res);
    setStatus(`${res.target.name}: ${S.views.length} frames. ${res.about || ''} ${res.note || ''}`.trim(), 'ok');
    $('ctxNote').textContent = res.credit || '';
    writeUrl(); drawLocator();
  } catch (e) {
    loader.hide();
    if (e.name === 'AbortError' || seq !== loadSeq) return;
    setStatus(`${it.label} did not load: ${netMsg(e)}`, 'bad');
  }
}
async function fillExplore() {
  const box = $('exploreList'); if (!box) return;
  let items = [];
  try { items = await exploreItems(); } catch (e) { box.textContent = 'Not available offline.'; return; }
  let html = '', group = null;
  for (const it of items) {
    if (it.group !== group) { group = it.group; html += `<div class="small" style="width:100%;margin-top:4px">${group}</div>`; }
    html += `<button data-id="${it.id}" title="${it.hint.replace(/"/g, '&quot;')}">${it.label}</button>`;
  }
  box.innerHTML = html;
  S.exploreItems = items;
  box.addEventListener('click', (e) => { const id = e.target.dataset?.id; const it = id && items.find((q) => q.id === id); if (it) openExplore(it); });
  const want = QS.get('explore'); if (want) { const it = items.find((q) => q.id === want); if (it) openExplore(it); }
}

async function loadCustom() {
  try {
    const name = $('inName').value.trim();
    let ra = parseFloat($('inRa').value), dec = parseFloat($('inDec').value);
    if (name && (S.useName || !(finite(ra) && finite(dec)))) {
      const p = PRESETS.find((q) => [q.key, q.label, q.name].some((s) => s.toLowerCase() === name.toLowerCase()));
      if (p) return loadTarget(p);
      setStatus('Looking up ' + name + ' in CDS Sesame…');
      const r = await resolveName(name);
      return loadTarget({ key: null, name: r.name || name, ra: r.ra, dec: r.dec, pm: r.pm_mas_yr || null });
    }
    if (!finite(ra) || !finite(dec) || dec < -90 || dec > 90) { setStatus('Enter RA (0 to 360) and Dec (-90 to 90) in degrees, or an object name.', 'bad'); return; }
    ra = ((ra % 360) + 360) % 360;
    return loadTarget({ key: null, name: `RA ${ra.toFixed(4)}° Dec ${dec.toFixed(4)}°`, ra, dec, pm: null });
  } catch (e) { setStatus(netMsg(e), 'bad'); }
}
const reload = () => { if (S.cur) loadTarget(S.cur); };

function writeUrl() {
  const t = S.cur; if (!t && !S.explore) return;
  const p = new URLSearchParams(), o = opts();
  if (S.explore) { p.set('explore', S.explore); p.set('ui', S.ui); history.replaceState(null, '', '?' + p.toString()); return; }
  if (t.key) p.set('target', t.key); else { p.set('ra', t.ra.toFixed(5)); p.set('dec', t.dec.toFixed(5)); }
  p.set('det', $('inDet').value); p.set('half', o.half); p.set('mode', S.mode); p.set('ui', S.ui);     // 'auto' stays auto in shared links
  if (o.frames !== 'visits') p.set('frames', o.frames);
  if (o.stack !== 8) p.set('stack', o.stack);
  if (o.mode !== 'sky') p.set('view', o.mode);
  if (QS.get('index')) p.set('index', QS.get('index'));
  history.replaceState(null, '', '?' + p.toString());
}

// ------------------------------------------------------------------ building the sequence
function rebuild() {
  const b = S.bundle; if (!b) return;
  const n = b.grid.n, n2 = n * n;
  S.views = S.frames.map((f) => {
    // each frame's own median (the sky background) is removed for display, as the data layer's contract says
    const med = quantile(finiteSorted(f.data, Math.max(1, Math.floor(n2 / 20000))), 0.5) || 0;
    const a = new Float32Array(n2); for (let i = 0; i < n2; i++) a[i] = f.data[i] - med;
    return { img: gaussSmooth(a, n, S.smooth), mjd: f.mjd, date: f.date, det: f.det, lam: f.lambda_um, lamMin: f.lambda_min_um, lamMax: f.lambda_max_um,
      dlam: f.dlambda_um, nStack: f.n_stack || 1, ra: f.ra, dec: f.dec, targetPx: f.targetPx || [(n - 1) / 2, (n - 1) / 2], sat: !!f.saturatedAtTarget, obs: f.obs };
  });
  // ONE stretch for the whole sequence, so frames are comparable (rule 1)
  const sample = [], stepPx = Math.max(1, Math.floor(S.views.length * n2 / 400000));
  for (const v of S.views) for (let i = 0; i < n2; i += stepPx) if (finite(v.img[i])) sample.push(v.img[i]);
  sample.sort((a, c) => a - c);
  S.lim = [quantile(sample, 0.01), quantile(sample, S.white)];
  if (!(S.lim[1] > S.lim[0])) S.lim = [S.lim[0] || 0, (S.lim[0] || 0) + 1];
  const ref = S.views[0]?.img, dabs = [];
  if (ref) for (const v of S.views.slice(1)) for (let i = 0; i < n2; i += stepPx) { const d = v.img[i] - ref[i]; if (finite(d)) dabs.push(Math.abs(d)); }
  dabs.sort((a, c) => a - c);
  S.dlim = quantile(dabs, 0.995) || (S.lim[1] - S.lim[0]) * 0.2 || 1;
  S.stackImg = S.views.length ? nanMean(S.views.map((v) => v.img), n2) : null;
  S.idx = Math.min(S.idx, Math.max(0, S.views.length - 1));
  $('inTime').max = Math.max(0, S.views.length - 1);
  for (const m of S.marks) trackMark(m);
  S.motion = S.showMotion ? measureMotion() : null;
  render();
}

function currentImage() {
  const v = S.views[S.idx]; if (!v) return null;
  if (S.mode === 'stack') return S.stackImg;
  if (S.mode === 'diff') return diffImage(S.idx);
  return v.img;
}
function diffImage(i) {
  const n2 = S.bundle.grid.n ** 2, a = S.views[i].img, r = S.views[0].img, d = new Float32Array(n2);
  for (let k = 0; k < n2; k++) d[k] = a[k] - r[k];
  return d;
}

// ------------------------------------------------------------------ deep stack (shift-and-stack), drawn as in Daniel's demo
function drawDeep(cv, data, n, overlay) {
  const Z = Math.max(2, Math.floor(300 / n)), fin = finiteSorted(data);
  const med = fin.length ? fin[fin.length >> 1] : 0;
  const dev = fin.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const sig = Math.max((dev.length ? dev[dev.length >> 1] : 0) * 1.4826, 1e-9);
  const a0 = Math.asinh(-2), a1 = Math.asinh(8);
  cv.width = cv.height = n * Z;
  const sm = document.createElement('canvas'); sm.width = sm.height = n;
  const sc = sm.getContext('2d'), img = sc.createImageData(n, n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const v = data[(n - 1 - r) * n + c], o = (r * n + c) * 4;
    let rgb = NAN_RGB;
    if (finite(v)) { const g = Math.round(255 * Math.min(1, Math.max(0, (Math.asinh((v - med) / sig) - a0) / (a1 - a0)))); rgb = [g, g, g]; }
    img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
  }
  sc.putImageData(img, 0, 0);
  const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(sm, 0, 0, n * Z, n * Z);
  overlay(ctx, (x) => (x + 0.5) * Z, (y) => (n - 1 - y + 0.5) * Z);
}
async function runDeep() {
  const t = S.cur; if (!t) return;
  if (!$('cbLive').checked) { setStatus('Deep stack needs live data (internet). Tick "Live data from NASA".', 'bad'); return; }
  if (ctrl) ctrl.abort();
  ctrl = new AbortController(); const signal = ctrl.signal, seq = ++loadSeq;
  $('deepBox').hidden = false; $('deepVerdict').textContent = 'Computing…'; $('deepVerdict').className = '';
  try {
    setStatus('Deep stack: searching for exposures…');
    const index = await getIndex(), d = $('inDet').value;
    const res = await getDeepStack(index, { ra: t.ra, dec: t.dec, pm: t.pm || null, name: t.name, detector: d === 'auto' ? 'auto' : +d, half: Math.min(+$('inHalf').value, 60), signal,
      onProgress: (done, total) => { if (seq === loadSeq) setStatus(`Deep stack: ${done}/${total} exposures fetched and aligned…`); } });
    if (seq !== loadSeq) return;
    drawDeep($('cvDeepN'), res.sky, res.n, (c, X, Y) => {
      const p = res.sky_target_px || []; if (p.length < 2) return;
      c.strokeStyle = '#ff9a1f'; c.lineWidth = 2; c.beginPath(); p.forEach(([x, y], i) => (i ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y)))); c.stroke();
    });
    drawDeep($('cvDeepT'), res.track, res.n, (c, X, Y) => {
      const x = X(res.center_px[0]), y = Y(res.center_px[1]);
      c.strokeStyle = '#f2c46d'; c.lineWidth = 2; c.beginPath();
      c.moveTo(x - 16, y); c.lineTo(x - 6, y); c.moveTo(x + 6, y); c.lineTo(x + 16, y); c.moveTo(x, y - 16); c.lineTo(x, y - 6); c.moveTo(x, y + 6); c.lineTo(x, y + 16); c.stroke();
    });
    const month = (m) => mjdToDate(m).slice(0, 7);
    $('deepSnrN').textContent = `S/N ${fmt(res.snr_sky, 1)}`; $('deepSnrT').textContent = `S/N ${fmt(res.snr_track, 1)}`;
    $('deepVerdict').textContent = (res.detected ? 'Detected' : 'Not detected') + `: S/N ${fmt(res.snr_track, 1)} in ${res.n_used} exposures (D${res.detector}, ${month(res.mjd_range[0])} → ${month(res.mjd_range[1])})`;
    $('deepVerdict').className = res.detected ? 'yes' : 'no';
    setStatus(`${t.name}: deep stack ready (${res.n_used} of ${res.n_available} exposures, ${fmt(res.lambda_min_um, 2)}–${fmt(res.lambda_max_um, 2)} µm).`, 'ok');
  } catch (e) { if (e.name !== 'AbortError' && seq === loadSeq) { setStatus(netMsg(e), 'bad'); $('deepVerdict').textContent = '—'; } }
}

// ------------------------------------------------------------------ positions, tracking, photometry
function predictedAt(i) { const p = S.views[i].targetPx; return { x: p[0], y: p[1] }; }   // the data layer's predicted target position

function localStats(img, n, x, y, r0, r1) {
  const v = [];
  for (let j = Math.floor(y - r1); j <= Math.ceil(y + r1); j++) for (let i = Math.floor(x - r1); i <= Math.ceil(x + r1); i++) {
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const d = Math.hypot(i - x, j - y); if (d < r0 || d > r1) continue;
    const a = img[j * n + i]; if (finite(a)) v.push(a);
  }
  v.sort((a, b) => a - b);
  return quantile(v, 0.5);
}

function centroid(img, n, x0, y0, r = 2) {
  const bkg = localStats(img, n, x0, y0, 3, 5);
  let sx = 0, sy = 0, sw = 0;
  for (let j = Math.round(y0) - r; j <= Math.round(y0) + r; j++) for (let i = Math.round(x0) - r; i <= Math.round(x0) + r; i++) {
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const w = img[j * n + i] - (finite(bkg) ? bkg : 0);
    if (finite(w) && w > 0) { sx += w * i; sy += w * j; sw += w; }
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw, ok: true } : { x: x0, y: y0, ok: false };
}

function aperture(img, n, x, y, r = 1.6) {
  const bkg = localStats(img, n, x, y, 3, 5);
  let s = 0, cnt = 0, bad = 0;
  for (let j = Math.floor(y - r); j <= Math.ceil(y + r); j++) for (let i = Math.floor(x - r); i <= Math.ceil(x + r); i++) {
    if (i < 0 || j < 0 || i >= n || j >= n || Math.hypot(i - x, j - y) > r) continue;
    const a = img[j * n + i]; if (finite(a)) { s += a - (finite(bkg) ? bkg : 0); cnt++; } else bad++;
  }
  return cnt && bad <= cnt ? s : NaN;
}

function trackMark(m) {
  const n = S.bundle.grid.n, V = S.views; m.pos = new Array(V.length);
  if (!V.length) return;
  const start = Math.min(m.view, V.length - 1);
  m.pos[start] = { ...centroid(V[start].img, n, m.x, m.y) };
  const step = (from, to) => {
    const p = m.pos[from];
    const c = centroid(V[to].img, n, p.x, p.y);
    m.pos[to] = Math.hypot(c.x - p.x, c.y - p.y) < 2.5 ? c : { x: p.x, y: p.y, ok: false };
  };
  for (let i = start + 1; i < V.length; i++) step(i - 1, i);
  for (let i = start - 1; i >= 0; i--) step(i + 1, i);
  m.flux = V.map((v, i) => aperture(v.img, n, m.pos[i].x, m.pos[i].y));
  // linear fit of position vs time -> proper motion in arcsec / yr
  const pts = V.map((v, i) => ({ t: mjdToYear(v.mjd), ...m.pos[i] })).filter((p) => p.ok);
  m.fit = null;
  if (pts.length >= 3 && pts[pts.length - 1].t - pts[0].t > 0.3) {
    const fit = (k) => { const mt = pts.reduce((s, p) => s + p.t, 0) / pts.length, mv = pts.reduce((s, p) => s + p[k], 0) / pts.length;
      let num = 0, den = 0; for (const p of pts) { num += (p.t - mt) * (p[k] - mv); den += (p.t - mt) ** 2; } return { slope: num / den, mt, mv }; };
    const fx = fit('x'), fy = fit('y'), pix = S.bundle.grid.pixel_arcsec;
    const east = -fx.slope * pix, north = fy.slope * pix;
    m.fit = { fx, fy, east, north, total: Math.hypot(east, north), pa: (Math.atan2(east, north) * 180 / Math.PI + 360) % 360, span: pts[pts.length - 1].t - pts[0].t };
  }
}

function posAt(m, mjd) {
  if (m.fit) { const t = mjdToYear(mjd); return { x: m.fit.fx.mv + m.fit.fx.slope * (t - m.fit.fx.mt), y: m.fit.fy.mv + m.fit.fy.slope * (t - m.fit.fy.mt) }; }
  let best = 0, bd = Infinity; S.views.forEach((v, i) => { const d = Math.abs(v.mjd - mjd); if (d < bd) { bd = d; best = i; } });
  return m.pos[best];
}

function addMark(x, y) {
  const m = { x, y, view: S.idx, color: TRACK_COLORS[S.marks.length % TRACK_COLORS.length] };
  trackMark(m); S.marks.push(m); if (S.showMotion) S.motion = measureMotion(); render();
}

// ------------------------------------------------------------------ detection filter
function detect() {
  const n = S.bundle.grid.n;
  const useDiff = S.detDiff || S.mode === 'diff';
  const img = useDiff ? (S.idx === 0 && S.views.length > 1 ? diffImage(1) : diffImage(S.idx)) : currentImage();
  if (!img) return [];
  const vals = finiteSorted(img);
  const med = quantile(vals, 0.5);
  const mad = quantile(vals.map((v) => Math.abs(v - med)).sort((a, b) => a - b), 0.5) * 1.4826 || 1e-9;
  const thr = S.sigma * mad, lab = new Int32Array(n * n), out = [];
  const hot = (k) => finite(img[k]) && (useDiff ? Math.abs(img[k] - med) : img[k] - med) > thr;
  let id = 0;
  for (let k = 0; k < n * n; k++) {
    if (lab[k] || !hot(k)) continue;
    id++; const stack = [k]; lab[k] = id; const px = [];
    const sign = Math.sign(img[k] - med);
    while (stack.length) {
      const q = stack.pop(); px.push(q); const qx = q % n, qy = (q / n) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = qx + dx, yy = qy + dy; if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const kk = yy * n + xx; if (!lab[kk] && hot(kk) && Math.sign(img[kk] - med) === sign) { lab[kk] = id; stack.push(kk); }
      }
    }
    if (px.length < S.minSize) continue;
    let sx = 0, sy = 0, sw = 0, peak = 0;
    for (const q of px) { const w = Math.abs(img[q] - med); sx += w * (q % n); sy += w * ((q / n) | 0); sw += w; peak = Math.max(peak, w / mad); }
    out.push({ x: sx / sw, y: sy / sw, size: px.length, snr: peak, sign });
  }
  return out;
}

// ------------------------------------------------------------------ drawing the sky image
const SKY = document.createElement('canvas');
SKY.width = SKY.height = 1024;
const skyCtx = SKY.getContext('2d');
const small = document.createElement('canvas');

function colorize(v) {
  v = Math.max(0, Math.min(1, v));
  if (S.cmap === 'heat') return [255 * Math.min(1, 3 * v), 255 * Math.max(0, Math.min(1, 3 * v - 1)), 255 * Math.max(0, Math.min(1, 3 * v - 2))];
  if (S.cmap === 'inv') { const g = 255 * (1 - v); return [g, g, g]; }
  const g = 255 * v; return [g, g, g];
}
function diffRgb(t) { const w = Math.round(255 * (1 - Math.abs(t))); return t >= 0 ? [255, w, w] : [w, w, 255]; }   // blue ... white ... red
function stretchValue(x) {
  if (S.mode === 'diff') return 0.5 + 0.5 * Math.max(-1, Math.min(1, Math.asinh(10 * x / S.dlim) / Math.asinh(10)));
  const v = (x - S.lim[0]) / (S.lim[1] - S.lim[0]);
  if (S.stretch === 'asinh') return Math.asinh(Math.max(0, v) / 0.03) / Math.asinh(1 / 0.03);
  if (S.stretch === 'log') return Math.log10(1 + 1000 * Math.max(0, v)) / 3;
  return v;
}

function drawSky() {
  const b = S.bundle, n = b.grid.n, W = SKY.width, sc = W / n;   // fixed-size canvas: a WebGL texture cannot change size
  small.width = small.height = n;
  const sctx = small.getContext('2d'), id = sctx.createImageData(n, n);
  const img = currentImage();
  for (let row = 0; row < n; row++) for (let x = 0; x < n; x++) {
    const v = img ? img[row * n + x] : NaN, o = ((n - 1 - row) * n + x) * 4;   // row 0 = south -> bottom
    const [r, g, bl] = !finite(v) ? (S.mode === 'diff' ? NAN_DIFF_RGB : NAN_RGB) : S.mode === 'diff' ? diffRgb(2 * stretchValue(v) - 1) : colorize(stretchValue(v));
    id.data[o] = r; id.data[o + 1] = g; id.data[o + 2] = bl; id.data[o + 3] = 255;
  }
  sctx.putImageData(id, 0, 0);
  skyCtx.imageSmoothingEnabled = reliefOn();     // pixel-sharp in 2D, smooth on the 3D surface
  skyCtx.drawImage(small, 0, 0, W, W);
  const P = (x, y) => [(x + 0.5) * sc, (n - 1 - y + 0.5) * sc];
  const v = S.views[S.idx];

  if (S.grid) { skyCtx.strokeStyle = 'rgba(120,140,220,.25)'; skyCtx.lineWidth = 1; for (let i = 0; i <= n; i++) { skyCtx.beginPath(); skyCtx.moveTo(i * sc, 0); skyCtx.lineTo(i * sc, W); skyCtx.moveTo(0, i * sc); skyCtx.lineTo(W, i * sc); skyCtx.stroke(); } }

  // predicted target position (targetPx): its path over the sequence, and a crosshair on the current frame (rule 5)
  if (S.showPred && v && S.mode !== 'stack') {
    const path = S.views.map((_, i) => predictedAt(i)), pc = predictedAt(S.idx);
    const moved = Math.hypot(path[path.length - 1].x - path[0].x, path[path.length - 1].y - path[0].y);
    skyCtx.strokeStyle = '#f2c46d'; skyCtx.lineWidth = Math.max(2, sc * 0.08);
    if (moved > 0.2) { skyCtx.setLineDash([sc * 0.4, sc * 0.3]); skyCtx.beginPath(); path.forEach((p, i) => (i ? skyCtx.lineTo(...P(p.x, p.y)) : skyCtx.moveTo(...P(p.x, p.y)))); skyCtx.stroke(); skyCtx.setLineDash([]); }
    const [X, Y] = P(pc.x, pc.y), a = Math.max(sc * 2.2, 26), b0 = Math.max(sc * 1.1, 12);
    skyCtx.beginPath(); skyCtx.moveTo(X - a, Y); skyCtx.lineTo(X - b0, Y); skyCtx.moveTo(X + b0, Y); skyCtx.lineTo(X + a, Y);
    skyCtx.moveTo(X, Y - a); skyCtx.lineTo(X, Y - b0); skyCtx.moveTo(X, Y + b0); skyCtx.lineTo(X, Y + a); skyCtx.stroke();
  }

  if (S.detect) for (const d of S.detections) {
    skyCtx.strokeStyle = d.sign < 0 ? '#8b93ff' : '#f2c46d'; skyCtx.lineWidth = Math.max(2, sc * 0.08);
    skyCtx.beginPath(); skyCtx.arc(...P(d.x, d.y), sc * (1 + Math.sqrt(d.size) * 0.35), 0, 2 * Math.PI); skyCtx.stroke();
  }

  for (const m of S.marks) {
    skyCtx.strokeStyle = m.color; skyCtx.fillStyle = m.color; skyCtx.lineWidth = Math.max(2, sc * 0.1);
    skyCtx.beginPath(); m.pos.forEach((p, i) => (i ? skyCtx.lineTo(...P(p.x, p.y)) : skyCtx.moveTo(...P(p.x, p.y)))); skyCtx.stroke();
    m.pos.forEach((p) => { skyCtx.beginPath(); skyCtx.arc(...P(p.x, p.y), sc * 0.18, 0, 2 * Math.PI); skyCtx.fill(); });
    const pc = m.pos[S.idx]; if (pc) { skyCtx.beginPath(); skyCtx.arc(...P(pc.x, pc.y), sc * 1.3, 0, 2 * Math.PI); skyCtx.stroke(); }
  }

  drawMotionArrow(P, sc);

  // compass and scale bar
  skyCtx.fillStyle = '#e8ecff'; skyCtx.strokeStyle = '#e8ecff'; skyCtx.lineWidth = 3;
  skyCtx.font = `bold ${Math.round(W / 34)}px system-ui, sans-serif`;
  const cx = W - W * 0.08, cy = W * 0.14, L = W * 0.06;
  skyCtx.beginPath(); skyCtx.moveTo(cx, cy); skyCtx.lineTo(cx, cy - L); skyCtx.moveTo(cx, cy); skyCtx.lineTo(cx - L, cy); skyCtx.stroke();
  skyCtx.fillText('N', cx - W / 80, cy - L - W / 80); skyCtx.fillText('E', cx - L - W / 25, cy + W / 90);
  const barAs = b.grid.fov_arcsec > 900 ? 300 : b.grid.fov_arcsec > 300 ? 60 : 30, bar = barAs / b.grid.pixel_arcsec * sc;
  skyCtx.beginPath(); skyCtx.moveTo(W * 0.05, W * 0.95); skyCtx.lineTo(W * 0.05 + bar, W * 0.95); skyCtx.stroke();
  skyCtx.fillText(barAs >= 60 ? barAs / 60 + '′' : barAs + '″', W * 0.05, W * 0.93);
  if (v) {   // every frame carries its date, detector and wavelength (rule 4)
    const lam = v.lamMin != null ? `${fmt(v.lam, 2)} µm (${fmt(v.lamMin, 2)}-${fmt(v.lamMax, 2)})` : `${fmt(v.lam, 3)} µm`;
    const what = S.mode === 'diff' ? `diff vs ${S.views[0].date}` : S.mode === 'stack' ? `mean of ${S.views.length}` : `${S.idx + 1}/${S.views.length}`;
    skyCtx.direction = 'ltr'; skyCtx.textAlign = 'left'; skyCtx.font = `${Math.round(W / 34)}px system-ui, sans-serif`;
    skyCtx.fillStyle = 'rgba(5,7,15,.6)'; skyCtx.fillRect(0, 0, W, W * 0.075); skyCtx.fillStyle = '#e8ecff';
    skyCtx.fillText(`${v.date} · ${detLabel(v.det)} · ${lam}${v.nStack > 1 ? ' · ×' + v.nStack : ''} · ${what}${v.sat ? ' · NaN core' : ''}`, W * 0.025, W * 0.05);
    drawFrameLabel(skyCtx, W, v);      // big "D2 · 1.43 µm" in the corner (app-ux.js)
  }
  if (S.vload) drawVideoLoading(skyCtx, W, S.vload);
}
// "Loading the video · 3 / 9" on the picture itself, under the date line: the first image is shown, the rest is still downloading
function drawVideoLoading(c, W, L) {
  const what = L.live ? 'live data from NASA' : 'the video';
  const txt = L.total ? `⏳ Loading ${what} · ${Math.min(L.done, L.total)} / ${L.total} frames` : (L.live ? '⏳ Loading live data from NASA…' : '⏳ Loading the rest of the video…');
  c.save(); c.direction = 'ltr'; c.textAlign = 'center'; c.font = `700 ${Math.round(W / 21)}px system-ui, sans-serif`;
  const w = Math.min(W * 0.96, c.measureText(txt).width + W * 0.07), h = W * 0.12, x = (W - w) / 2, y = W * 0.09;
  c.fillStyle = 'rgba(7,10,20,.78)'; c.beginPath(); c.roundRect(x, y, w, h, W * 0.02); c.fill();
  c.strokeStyle = 'rgba(242,196,109,.55)'; c.lineWidth = Math.max(2, W / 400); c.stroke();
  c.textBaseline = 'middle'; c.fillStyle = '#ffffff'; c.fillText(txt, W / 2, y + h * 0.4);
  const bx = x + W * 0.035, bw = w - W * 0.07, by = y + h * 0.76, bh = Math.max(4, W / 110);
  c.fillStyle = 'rgba(148,163,255,.25)'; c.fillRect(bx, by, bw, bh);
  c.fillStyle = '#f2c46d'; if (L.total) c.fillRect(bx, by, bw * Math.min(1, L.done / L.total), bh);
  else for (let i = 0; i < 6; i++) c.fillRect(bx + (i * 2 + ((performance.now() / 300) | 0) % 2) * bw / 12, by, bw / 12, bh);
  c.restore();
}

// ------------------------------------------------------------------ chart (light curve / spectrum)
function chartData() {
  const m = S.marks[0]; if (!m) return null;
  if (S.chart === 'light') return { pts: S.views.map((v, i) => ({ x: mjdToYear(v.mjd), y: m.flux[i] })).filter((p) => finite(p.y)), xl: 'Year', yl: 'Relative flux', cur: mjdToYear(S.views[S.idx].mjd) };
  const pts = S.views.map((v, i) => ({ x: v.lam, y: m.flux[i], band: 'D' + v.det })).filter((p) => finite(p.x) && finite(p.y));
  return { pts, xl: 'Wavelength µm', yl: 'Relative flux', cur: null };
}

function drawChart(cv, d) {
  const c = cv.getContext('2d'), W = cv.width, H = cv.height; c.clearRect(0, 0, W, H);
  c.fillStyle = '#0e1530'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#9fb0e8'; c.font = `${Math.round(H / 12)}px system-ui, sans-serif`;
  if (!d || d.pts.length < 2) { c.textAlign = 'center'; c.fillText(S.marks.length ? 'Not enough points' : 'Mark an object to see a chart', W / 2, H / 2); c.textAlign = 'start'; return; }
  const xs = d.pts.map((p) => p.x), ys = d.pts.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x1 === x0) x1 = x0 + 1; const pad = (y1 - y0) * 0.1 || 1; y0 -= pad; y1 += pad;
  const L = W * 0.12, R = W * 0.03, T = H * 0.08, B = H * 0.2;
  const X = (x) => L + (x - x0) / (x1 - x0) * (W - L - R), Y = (y) => H - B - (y - y0) / (y1 - y0) * (H - T - B);
  c.strokeStyle = '#2c3a6b'; c.lineWidth = 1; c.beginPath(); c.moveTo(L, T); c.lineTo(L, H - B); c.lineTo(W - R, H - B); c.stroke();
  c.textAlign = 'center'; c.fillText(d.xl, (L + W - R) / 2, H - H * 0.04); c.textAlign = 'left'; c.fillText(d.yl, L + 8, T + H * 0.06);
  c.fillText(x0.toFixed(2), L, H - B + H * 0.09); c.fillText(x1.toFixed(2), W - R - W * 0.1, H - B + H * 0.09);
  if (S.chart === 'light') { c.strokeStyle = S.marks[0].color; c.lineWidth = 2; c.beginPath(); d.pts.forEach((p, i) => (i ? c.lineTo(X(p.x), Y(p.y)) : c.moveTo(X(p.x), Y(p.y)))); c.stroke(); }
  const bandHue = { D1: '#7aa2ff', D2: '#5ee6ff', D3: '#8ff0b0', D4: '#ffd166', D5: '#ff9f66', D6: '#ff7ab6' };
  for (const p of d.pts) { c.fillStyle = p.band ? bandHue[p.band] : S.marks[0].color; c.beginPath(); c.arc(X(p.x), Y(p.y), Math.max(2.5, W / 160), 0, 2 * Math.PI); c.fill(); }
  if (d.cur != null) { c.strokeStyle = '#ffffff'; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(X(d.cur), T); c.lineTo(X(d.cur), H - B); c.stroke(); c.setLineDash([]); }
}

// ------------------------------------------------------------------ text panels
function readsHtml(rows) { return rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join(''); }

function infoRows() {
  const b = S.bundle, v = S.views[S.idx]; if (!b || !v) return [];
  const r = b.res, o = r.options || {};
  return [
    ['Date', `${v.date} (MJD ${fmt(v.mjd, 2)})`],
    ['Detector', detLabel(v.det) + (o.detectorRequested === 'auto' || $('inDet').value === 'auto' ? ' (auto)' : '')],
    ['Wavelength at target', finite(v.lam) ? fmt(v.lam) + ' µm' + (v.lamMin != null ? ` (${fmt(v.lamMin, 2)}–${fmt(v.lamMax, 2)})` : '') : '—'],
    ['Exposures in stack', v.nStack],
    ['Target core', v.sat ? 'Saturated (no data, slate)' : 'OK'],
    ['View', b.grid.track ? 'Track: object centred' : 'Sky fixed: object moves'],
    ['Field of view', `${fmt(b.grid.fov_arcsec / 60, 1)}′ (${b.grid.n}×${b.grid.n} px, ${b.grid.pixel_arcsec}″/px)`],
    ['Exposures in archive', r.n_exposures ?? '—'], ['Visits', r.visits?.length ?? '—'],
    ['Source', b.source === 'live' ? 'Live, NASA S3' : 'Saved sample'],
    ['Detections', S.detect ? S.detections.length : 'Off'],
    ['Exposure', v.obs || '—'],
  ];
}

function trackRows() {
  const out = [], t = S.bundle?.target;
  S.marks.forEach((m, i) => {
    const p = m.pos[S.idx], p0 = m.pos[0], pix = S.bundle.grid.pixel_arcsec;
    out.push([`Object ${i + 1} <span style="color:${m.color}">●</span>`, p ? `${fmt(Math.hypot(p.x - p0.x, p.y - p0.y) * pix, 1)}″ from the first image` : '—']);
    if (m.fit) out.push(['Measured motion', `${fmt(m.fit.total, 1)}″/yr, PA ${fmt(m.fit.pa, 0)}°`]);
  });
  if (t && (t.pmra_masyr || t.pmdec_masyr)) {
    const tot = Math.hypot(t.pmra_masyr, t.pmdec_masyr) / 1000, pa = (Math.atan2(t.pmra_masyr, t.pmdec_masyr) * 180 / Math.PI + 360) % 360;
    out.push(['Expected motion (Sesame)', `${fmt(tot, 1)}″/yr, PA ${fmt(pa, 0)}°`]);
    if (S.views.length > 1) { const y = mjdToYear(S.views[S.views.length - 1].mjd) - mjdToYear(S.views[0].mjd); out.push(['Expected shift over span', `${fmt(tot * y, 1)}″ = ${fmt(tot * y / S.bundle.grid.pixel_arcsec, 2)} px`]); }
  }
  return out;
}

// ------------------------------------------------------------------ three.js scene: a sky dome around the viewer
const D2R = Math.PI / 180, EYE = 1.6, R = 50;
const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
// centre wavelength (um) of the 102 frames of the SPHEREx DR1 all-sky cube (from its HiPS properties file)
const HIPS_LAM = [0.753,0.771,0.790,0.809,0.828,0.848,0.868,0.889,0.910,0.932,0.955,0.978,1.001,1.025,1.050,1.075,1.102,1.113,1.139,1.167,1.195,1.224,1.254,1.284,1.315,1.346,1.378,1.412,1.446,1.481,1.517,1.554,1.592,1.631,1.656,1.695,1.735,1.775,1.818,1.861,1.905,1.949,1.995,2.041,2.089,2.139,2.189,2.240,2.292,2.345,2.399,2.445,2.506,2.575,2.646,2.719,2.794,2.871,2.951,3.033,3.118,3.204,3.293,3.383,3.476,3.570,3.667,3.768,3.833,3.867,3.901,3.935,3.970,4.005,4.040,4.076,4.112,4.148,4.184,4.220,4.257,4.294,4.331,4.368,4.405,4.435,4.467,4.500,4.533,4.566,4.600,4.635,4.669,4.704,4.739,4.773,4.808,4.843,4.879,4.915,4.951,4.988];

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
$('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070f);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
camera.position.set(0, EYE, 0);

// The celestial sphere. A direction (RA, Dec) maps to x = cos d cos a, y = sin d (north up), z = -cos d sin a,
// so that from the inside, with north up, east is to the left, as on the real sky.
const sky = new THREE.Group(); sky.position.set(0, EYE, 0); scene.add(sky);
function dirOf(ra, dec, out = new THREE.Vector3()) { const a = ra * D2R, d = dec * D2R; return out.set(Math.cos(d) * Math.cos(a), Math.sin(d), -Math.cos(d) * Math.sin(a)); }
function raDecOf(v) { const n = v.clone().normalize(); return { ra: (Math.atan2(-n.z, n.x) / D2R + 360) % 360, dec: Math.asin(Math.max(-1, Math.min(1, n.y))) / D2R }; }

const domeCanvas = document.createElement('canvas'); domeCanvas.width = 2048; domeCanvas.height = 1024;
{ const c = domeCanvas.getContext('2d'); c.fillStyle = '#070a16'; c.fillRect(0, 0, 2048, 1024); }
const domeTex = new THREE.CanvasTexture(domeCanvas); domeTex.colorSpace = THREE.SRGBColorSpace;
const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 48), new THREE.MeshBasicMaterial({ map: domeTex, side: THREE.BackSide }));
sky.add(dome);
// sharp detail on top of the dome: HiPS tiles (orders 3-5, down to 12.9″/px) streamed only where you look (hips-tiles.js)
let domeReady = false;     // the sharp tiles start only after the blurry whole-sky map is on screen (it must never look black)
setTimeout(() => { domeReady = true; }, 5000);     // ...or after 5 s if that map failed to load
const hips = createHipsLayer({ THREE, parent: sky, radius: R, base: HIPS, slice: 17, cacheSize: 420,
  localBase: new URL('./assets/hips', location.href).href.replace(/\/$/, ''), localOrders: [3], localSlices: [17], localExt: 'webp' });     // the zoomed-out level of the default colour is on our site, 256 px WebP (pipeline/hips_mirror.py)

// placeholder stars until the all-sky map loads
const fakeStars = (() => {
  const g = new THREE.BufferGeometry(), N = 1500, pos = new Float32Array(N * 3);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < N; i++) { const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u), r = R * 0.99; pos.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3); }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8ea2ff, size: 0.12 }));
})();
sky.add(fakeStars);

// RA/Dec grid on the dome: a meridian every 30 deg (2 h), a parallel every 30 deg
{
  const pts = [], r = R * 0.995, push = (ra, dec) => { const v = dirOf(ra, dec).multiplyScalar(r); pts.push(v.x, v.y, v.z); };
  for (let ra = 0; ra < 360; ra += 30) for (let d = -88; d < 88; d += 2) { push(ra, d); push(ra, d + 2); }
  for (let d = -60; d <= 60; d += 30) for (let ra = 0; ra < 360; ra += 2) { push(ra, d); push(ra + 2, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  sky.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x3a4c8f, transparent: true, opacity: 0.45 })));
}

// --- the SPHEREx all-sky map (HiPS, HEALPix tiles) resampled onto the dome
function healpixToEquirect(img) {
  const tw = Math.round(img.width / 27), m = Math.round(Math.log2(tw)), nside = 8 * tw;   // Allsky file: 768 order-3 tiles, 27 per row
  const src = document.createElement('canvas'); src.width = img.width; src.height = img.height;
  const sc = src.getContext('2d', { willReadFrequently: true }); sc.drawImage(img, 0, 0);
  const sp = sc.getImageData(0, 0, src.width, src.height).data;
  const W = domeCanvas.width, H = domeCanvas.height, dc = domeCanvas.getContext('2d'), out = dc.createImageData(W, H);
  const spread = (v) => (v & 1) | ((v & 2) << 1) | ((v & 4) << 2);
  const lut = new Uint8Array(256); for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, 0.55));
  for (let j = 0; j < H; j++) {
    const z = Math.sin((90 - 180 * (j + 0.5) / H) * D2R), za = Math.abs(z);
    for (let i = 0; i < W; i++) {
      const tt = (((360 * (i + 0.5) / W + 180) % 360) / 90);     // SphereGeometry's u = 0 sits at RA 180 deg
      let face, ix, iy;
      if (za <= 2 / 3) {
        const t1 = nside * (0.5 + tt), t2 = nside * z * 0.75, jp = Math.floor(t1 - t2), jm = Math.floor(t1 + t2);
        const ifp = Math.floor(jp / nside), ifm = Math.floor(jm / nside);
        face = ifp === ifm ? (ifp & 3) | 4 : ifp < ifm ? ifp & 3 : (ifm & 3) + 8;
        ix = jm & (nside - 1); iy = nside - (jp & (nside - 1)) - 1;
      } else {
        const ntt = Math.min(3, Math.floor(tt)), tp = tt - ntt, tmp = nside * Math.sqrt(3 * (1 - za));
        const jp = Math.min(Math.floor(tp * tmp), nside - 1), jm = Math.min(Math.floor((1 - tp) * tmp), nside - 1);
        if (z >= 0) { face = ntt; ix = nside - jm - 1; iy = nside - jp - 1; } else { face = ntt + 8; ix = jp; iy = jm; }
      }
      const tile = face * 64 + spread(ix >> m) + 2 * spread(iy >> m);
      const X = (tile % 27) * tw + (iy & (tw - 1)), Y = Math.floor(tile / 27) * tw + (ix & (tw - 1));
      const v = lut[sp[(Y * src.width + X) * 4]], o = (j * W + i) * 4;
      out.data[o] = v * 0.86; out.data[o + 1] = v * 0.92; out.data[o + 2] = Math.min(255, v * 1.08 + 6); out.data[o + 3] = 255;
    }
  }
  dc.putImageData(out, 0, 0);
  domeTex.needsUpdate = true; fakeStars.visible = false; domeReady = true; if (typeof drawLocator === 'function') try { drawLocator(); } catch (e) { /* before init */ }
}

let domeSlice = -1;
function loadDome(slice) {
  if (typeof hips !== 'undefined') hips.setSlice(slice);
  domeSlice = slice;
  $('domeLabel').textContent = `${HIPS_LAM[slice].toFixed(2)} µm (${slice + 1}/102)`;
  const name = slice ? `Allsky_${slice}.png` : 'Allsky.png';
  const srcs = [...(slice === 17 ? ['assets/allsky_17.jpg'] : []), `${HIPS}/Norder3/${name}`];
  const tryNext = () => {
    if (slice !== domeSlice) return;
    const src = srcs.shift(); if (!src) { $('domeLabel').textContent += ' · not loaded'; return; }
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { if (slice === domeSlice) try { healpixToEquirect(img); } catch (e) { tryNext(); } };
    img.onerror = tryNext; img.src = src;
  };
  tryNext();
}

// --- the cutout, placed on the dome at its true position and true angular size
const skyTex = new THREE.CanvasTexture(SKY); skyTex.magFilter = THREE.NearestFilter; skyTex.minFilter = THREE.LinearFilter; skyTex.colorSpace = THREE.SRGBColorSpace;
const flatMat = new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.DoubleSide }), litMat = new THREE.MeshLambertMaterial({ map: skyTex, side: THREE.DoubleSide });
const flatMatVR = flatMat.clone(), litMatVR = litMat.clone();
let FOOT = null;     // the cutout's four corners on the dome (sky coordinates), for the zoom cone
const skyPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flatMat);
skyPlane.matrixAutoUpdate = false; skyPlane.visible = false; sky.add(skyPlane);
skyPlane.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 })));
function placeCutout() { const t = S.bundle.target; placeCutoutAt(t.center_ra, t.center_dec, S.bundle.grid.fov_arcsec); }
function placeCutoutAt(ra, dec, fovAs) {
  const a = ra * D2R, d = dec * D2R, r = R * 0.97;
  const c = dirOf(ra, dec);
  const east = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a)), north = new THREE.Vector3(-Math.sin(d) * Math.cos(a), Math.cos(d), Math.sin(d) * Math.sin(a));
  const size = (fovAs / 3600) * D2R * r;       // true angular size
  // image left = east, up = north, front face looks at the viewer
  skyPlane.matrix.makeBasis(east.clone().multiplyScalar(-size), north.clone().multiplyScalar(size), c.clone().negate().multiplyScalar(size)).setPosition(c.clone().multiplyScalar(r));
  // 3D mode: lean the image back so the brightness relief is seen from the side
  FOOT = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => c.clone().multiplyScalar(r).addScaledVector(east, -size * x).addScaledVector(north, size * y));
  if (reliefOn()) skyPlane.matrix.multiply(new THREE.Matrix4().makeRotationX(-S.tilt * D2R));
  skyPlane.matrixWorldNeedsUpdate = true; skyPlane.visible = true;
}

// --- labels for the test targets and a ring on the current target (constant size on screen)
function labelSprite(text, color) {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128; const c = cv.getContext('2d');
  c.strokeStyle = color; c.lineWidth = 6; c.beginPath(); c.arc(64, 64, 34, 0, 2 * Math.PI); c.stroke();
  c.fillStyle = color; c.font = '600 44px system-ui, sans-serif'; c.textBaseline = 'middle'; c.fillText(text, 118, 66);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
  s.center.set(0.125, 0.5); s.renderOrder = 5; return s;
}
const labels = PRESETS.map((p) => { const s = labelSprite(p.label, '#f2c46d'); s.position.copy(dirOf(p.ra, p.dec).multiplyScalar(R * 0.96)); s.userData = p; sky.add(s); return s; });
const pickRing = labelSprite('', '#8b93ff'); pickRing.visible = false; sky.add(pickRing);

// --- view: you stand at the centre and look out. Drag turns your head, the wheel zooms (changes the field of view).
const V = { ra: 200, dec: 20, fov: 75, anim: null };
const FOV_MIN = 0.02, FOV_MAX = 110;
const cutFov = () => (S.bundle ? S.bundle.grid.fov_arcsec / 3600 : 0.05);
// one smooth move: ease in/out, at most ~1.5 s; a long jump arcs out and back in (zoom out, then in) within the same move
function flyTo(ra, dec, fov, dur) {
  const dra = ((ra - V.ra + 540) % 360) - 180, sep = Math.hypot(dra * Math.cos(((dec + V.dec) / 2) * D2R), dec - V.dec);
  const bump = Math.max(0, Math.log(Math.min(70, sep * 1.3)) - Math.max(Math.log(V.fov), Math.log(fov)));
  V.anim = { t: 0, dur: dur ?? Math.min(1.5, 0.6 + 0.25 * Math.log10(1 + sep * 60)), ra0: V.ra, dec0: V.dec, dra, f0: Math.log(V.fov), f1: Math.log(fov), dec1: dec, bump };
}
const fitFov = () => (S.ctx ? (S.ctx.n * 6.15 / 3600) / 0.85 : cutFov() / 0.7);     // the cutout (or its surroundings) fills the screen
function flyToTarget() { const t = S.bundle?.target; if (t) flyTo(t.center_ra, t.center_dec, fitFov()); }
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
function applyView(dt) {
  const a = V.anim;
  if (a) {
    a.t += dt; const u = Math.min(1, a.t / a.dur), e = ease(u);
    V.ra = (a.ra0 + a.dra * e + 360) % 360; V.dec = a.dec0 + (a.dec1 - a.dec0) * e;
    V.fov = Math.exp(a.f0 + (a.f1 - a.f0) * e + a.bump * Math.sin(Math.PI * e));
    if (u >= 1) V.anim = null;
  }
  V.dec = Math.max(-89.5, Math.min(89.5, V.dec)); V.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, V.fov));
  camera.fov = V.fov; camera.updateProjectionMatrix();
  camera.up.set(0, 1, 0); camera.lookAt(dirOf(V.ra, V.dec).add(camera.position));
  // zoomed in past the all-sky map's resolution (~10'/px on the dome): fade the smeared map to dark sky, keep the grid
  const k = Math.max(0, Math.min(1, (Math.log(V.fov) - Math.log(1.5)) / (Math.log(10) - Math.log(1.5))));
  dome.material.color.setScalar(0.03 + 0.97 * k);
  hips.setOpacity(Math.max(0, Math.min(1, (Math.log(V.fov) - Math.log(0.25)) / (Math.log(1.2) - Math.log(0.25)))));     // the sharp tiles fade out only when zoomed in much closer (12.9″/px)
}
function scaleSprites(inXR) {
  const s = inXR ? R * 0.035 : R * 0.96 * Math.tan(Math.min(V.fov, 100) * D2R / 2) * 0.09;
  const zoomedIn = !inXR && V.fov < cutFov() * 20;     // close to a point: hide labels, rings and saved-point names
  for (const l of labels) { l.scale.set(s * 4, s, 1); l.visible = !zoomedIn; }
  pickRing.scale.set(s * 4, s, 1); if (zoomedIn) pickRing.visible = false; else if (S.cur && !S.cur.key && !S.explore) pickRing.visible = true;
  for (const l of savedLabels) { l.scale.set(s * 4, s, 1); l.visible = !zoomedIn; }
  for (const p of pins) p.marker.scale.set(s * 4, s, 1);       // remembered points (visibility: updatePins)
}

// --- VR: the dome stays around you; a large panel in front shows the same blink magnified, with the readouts beside it
const content = new THREE.Group(); content.position.set(0, EYE + 0.35, -2.4); content.visible = false; scene.add(content);
const vrTex = new THREE.CanvasTexture(SKY); vrTex.magFilter = THREE.NearestFilter; vrTex.colorSpace = THREE.SRGBColorSpace;
flatMatVR.map = vrTex; litMatVR.map = vrTex;
const vrFlatGeo = new THREE.PlaneGeometry(1, 1);
const vrPlane = new THREE.Mesh(skyPlane.geometry, flatMatVR);
vrPlane.scale.setScalar(1.8); vrPlane.rotation.x = 0;
content.add(vrPlane);
const VR_HIPS_CACHE = 110;     // the Quest crashed with ~420 sky tiles resident; the headset keeps about what it can see
// ...but the zoomed-out tiles of the default colour come from our own site as 256 px WebP (1/4 the memory of NASA's 512 px tiles):
// with those the headset can hold the whole view (~220 tiles, ~20 MB), so the sharp sky has no visible edge (15.11 emulator test)
const vrLocalSky = () => domeSlice === 17, VR_HIPS_CACHE_LOCAL = 220;
const HUD = document.createElement('canvas'); HUD.width = 720; HUD.height = 900;
const hudTex = new THREE.CanvasTexture(HUD); hudTex.colorSpace = THREE.SRGBColorSpace;
const hudPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.88, 1.1), new THREE.MeshBasicMaterial({ map: hudTex, transparent: true }));
hudPlane.position.set(-1.42, 0, 0.12); hudPlane.rotation.y = 0.35; content.add(hudPlane);
const hudChart = document.createElement('canvas'); hudChart.width = 660; hudChart.height = 300;
function orientSkyForVR() {   // once, on entering VR: turn the sky so the target sits ahead of you, below the panel (the zoom cone joins them)
  const t = S.bundle?.target; if (!t) return;
  sky.quaternion.setFromUnitVectors(dirOf(t.center_ra, t.center_dec), new THREE.Vector3(0, -0.3, -1).normalize());
  placeContentToward();
}
renderer.xr.addEventListener('sessionstart', () => { hips.setCacheSize(vrLocalSky() ? VR_HIPS_CACHE_LOCAL : VR_HIPS_CACHE); tiles.maxCached = 36; tiles.trim(36); content.visible = true; vrPlane.rotation.x = reliefOn() ? -0.5 : 0; dome.material.color.setScalar(1); hips.setOpacity(1); document.body.classList.add('inxr'); orientSkyForVR(); });
renderer.xr.addEventListener('sessionend', () => { hips.setCacheSize(420); tiles.maxCached = 90; content.visible = false; menuMesh.visible = false; document.body.classList.remove('inxr'); sky.quaternion.identity(); });

// 3D relief: the cutout is a surface whose height is the (stretched) brightness; in difference mode, dips and peaks
const reliefOn = () => false;     // the 3D relief view was removed (15.11): brightness-as-height is not a scientific display
function updateRelief() {
  // one vertex per pixel CENTRE (not per corner), so a star becomes a smooth peak rather than a flat-topped box
  const n = S.bundle.grid.n, h = reliefOn() ? S.relief : 0, img0 = currentImage(), img = h && img0 ? gaussSmooth(img0, n, 0.7) : img0;
  let g = skyPlane.geometry;
  if (g.parameters.widthSegments !== n - 1) {
    g.dispose(); g = new THREE.PlaneGeometry(1, 1, n - 1, n - 1);
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
      const k = iy * n + ix; p.setXY(k, (ix + 0.5) / n - 0.5, 0.5 - (iy + 0.5) / n); uv.setXY(k, (ix + 0.5) / n, 1 - (iy + 0.5) / n);
    }
    skyPlane.geometry = g; if (vrPlane.geometry !== vrFlatGeo) vrPlane.geometry = g;
  }
  const pos = g.attributes.position;
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    let z = 0;
    if (img && h > 0) { const v = img[(n - 1 - iy) * n + ix]; if (finite(v)) z = S.mode === 'diff' ? stretchValue(v) - 0.5 : Math.max(0, Math.min(1, stretchValue(v))); }
    pos.setZ(iy * n + ix, h * z);
  }
  pos.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere(); g.computeBoundingBox();
  if (vrPlane.geometry !== vrFlatGeo) vrPlane.geometry = g;
  const mat = h ? litMat : flatMat; if (skyPlane.material !== mat) { skyTex.magFilter = h ? THREE.LinearFilter : THREE.NearestFilter; skyTex.needsUpdate = true; skyPlane.material = mat; vrPlane.material = h ? litMatVR : flatMatVR; }
}

// in VR the sky stays put after you enter (so you keep your bearings); the panel moves round to face the chosen point
// zoom inside VR: the panel shows a magnified part of the image around the target (or your first mark); the cone follows that part
function vrWindow() {
  const z = S.vrZoom || 1, n = S.bundle?.grid.n || 1, r = 1 / z;
  if (z <= 1.001 || !S.bundle) return { u0: 0, v0: 0, r: 1 };
  let cu, cv;
  if (S.vrC) { cu = S.vrC.u; cv = S.vrC.v; }     // where you pointed when you zoomed (kept while you zoom, like the mouse wheel in 2D)
  else { const m = S.marks[0], p = m ? m.pos[S.idx] || m : S.views[S.idx] ? { x: S.views[S.idx].targetPx[0], y: S.views[S.idx].targetPx[1] } : { x: n / 2, y: n / 2 }; cu = (p.x + 0.5) / n; cv = (p.y + 0.5) / n; }
  return { u0: Math.max(0, Math.min(1 - r, cu - r / 2)), v0: Math.max(0, Math.min(1 - r, cv - r / 2)), r };
}
function applyVrZoom() {
  const w = vrWindow(); vrTex.repeat.set(w.r, w.r); vrTex.offset.set(w.u0, w.v0); vrTex.needsUpdate = true;
  vrPlane.geometry = w.r < 1 ? vrFlatGeo : skyPlane.geometry;
  // below ×1 the panel shrinks (zoom OUT): more of the real sky around you is visible
  vrPlane.scale.setScalar(1.8 * Math.min(1, S.vrZoom || 1));
}
// zoom like the mouse wheel in 2D: the image point under the pointer (panel coords q, 0..1) stays under the pointer while the scale eases to its goal
const VR_ZMIN = 0.3, VR_ZMAX = 12;
function setVrZoom(z, q) {
  S.vrGoal = Math.max(VR_ZMIN, Math.min(VR_ZMAX, z)); if (q) S.vrQ = q;
  if (!S.bundle) { S.vrZoom = S.vrGoal; drawHud(); }
}
function vrZoomBy(f, q) { setVrZoom((S.vrGoal || S.vrZoom || 1) * f, q); }
function stepVrZoom(dt) {
  const goal = S.vrGoal; if (goal == null || !S.bundle) return;
  const z0 = S.vrZoom || 1; if (Math.abs(goal - z0) < 1e-4 * z0) { if (z0 !== goal) S.vrZoom = goal; return; }
  const z1 = Math.abs(goal - z0) < 0.002 * z0 ? goal : z0 * Math.pow(goal / z0, 1 - Math.exp(-dt * 12));
  const q = S.vrQ || { x: 0.5, y: 0.5 }, w = vrWindow(), r1 = 1 / Math.max(1, z1);
  if (z1 > 1.001) {
    const pu = w.u0 + q.x * w.r, pv = w.v0 + q.y * w.r;      // image point under the pointer
    const u0 = Math.max(0, Math.min(1 - r1, pu - q.x * r1)), v0 = Math.max(0, Math.min(1 - r1, pv - q.y * r1));
    S.vrC = { u: u0 + r1 / 2, v: v0 + r1 / 2 };
  } else S.vrC = null;
  S.vrZoom = z1; applyVrZoom();
  const now = performance.now(); if (now - (S.vrHudT || 0) > 160 || z1 === goal) { S.vrHudT = now; drawHud(); }     // the HUD canvas is big: not every frame
}
// where the user points on the zoomed panel (a controller ray, else the head's gaze); null if not on it
const _zr = new THREE.Raycaster();
function vrPointerOnPanel(pref) {
  if (!S.bundle || !vrPlane.visible) return null;
  scene.updateMatrixWorld(true);
  const order = pref === 1 ? [ctrls[1], ctrls[0]] : [ctrls[0], ctrls[1]];
  for (const c of [...order, renderer.xr.getCamera()]) {
    const o = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld), d = new THREE.Vector3(0, 0, -1).transformDirection(c.matrixWorld);
    _zr.ray.origin.copy(o); _zr.ray.direction.copy(d);
    const h = _zr.intersectObject(vrPlane, false)[0]; if (h) return { x: h.uv.x, y: h.uv.y };
  }
  return null;
}
function placeContentToward() {
  const t = S.bundle?.target; if (!t) return;
  sky.updateMatrixWorld();
  const d = dirOf(t.center_ra, t.center_dec).applyQuaternion(sky.quaternion); const hz = new THREE.Vector3(d.x, 0, d.z);
  if (hz.lengthSq() < 1e-4) hz.set(0, 0, -1); hz.normalize();
  const up = d.y > 0.5 ? -0.35 : 0.35;                    // target high in the sky: panel below it, else above it
  content.position.set(hz.x * 2.4, EYE + up, hz.z * 2.4);
  content.lookAt(0, EYE + up, 0);
}
function onBundleLoaded() {
  S.vrC = null;     // a new picture: the zoomed panel starts on its target again
  placeCutout(); placeContext(); restorePendingMarks(); drawLocator(); strip.sync();
  if (renderer.xr.isPresenting) { const tt = S.bundle.target; vrRecenter(tt.center_ra, tt.center_dec); placeContentToward(); return; }     // VR: bring every new picture in front of you (the tour switches targets without the normal load path)
  const t = S.bundle.target;
  // dome: centre the new point but keep the zoom, so you still see where on the sky you are (the cone shows the magnified image)
  if (S.ui === 'dome') flyTo(t.center_ra, t.center_dec, Math.min(V.fov, 40)); else flyToTarget();
}

function drawHud() {
  const c = HUD.getContext('2d'), W = HUD.width;
  c.clearRect(0, 0, W, HUD.height); c.fillStyle = 'rgba(12,18,40,.92)'; c.beginPath(); c.roundRect(0, 0, W, HUD.height, 28); c.fill();
  c.direction = 'ltr'; c.textAlign = 'left'; c.fillStyle = '#e8ecff'; c.font = 'bold 40px system-ui, sans-serif';
  c.fillText(S.bundle ? S.bundle.target.name : 'SPHEREx Blink', 30, 62);
  c.font = '28px system-ui, sans-serif'; c.fillStyle = '#9fb0e8';
  c.fillText({ blink: 'Blink', diff: 'Difference', stack: 'Stack' }[S.mode] + (S.playing ? ' · playing' : ' · paused'), 30, 104);
  let y = 156;
  if (S.pickMode) { c.fillStyle = '#f2c46d'; c.font = 'bold 30px system-ui, sans-serif'; c.fillText('🎯 Aim at the sky and pull the trigger to pick a point', 30, 140); c.font = '28px system-ui, sans-serif'; } else
  c.font = '21px system-ui, sans-serif', c.fillStyle = '#f2c46d', c.fillText(`A/B/X/Y settings · left stick: ↔ rotate, ↕ next star · right stick: ↑ zoom in, ↓ zoom out (×${(S.vrZoom || 1).toFixed(1)})`, 30, 140); c.font = '28px system-ui, sans-serif'; y = 190;
  for (const [k, v] of [...infoRows().slice(0, 5), ...motionRows().slice(0, 1)]) {
    c.fillStyle = '#b8c4f0'; c.textAlign = 'left'; c.fillText(String(k).replace(/<[^>]+>/g, ''), 30, y);
    c.fillStyle = '#8ff0b0'; c.textAlign = 'right'; c.fillText(String(v), W - 30, y); y += 44;
  }
  // big buttons: trigger on them (the same actions as the A/B/X/Y menu, where they are hard to find)
  hudBtns = [
    { label: '🔍 Zoom in', act: () => vrZoomBy(1.6) }, { label: '🔍 Zoom out', act: () => vrZoomBy(1 / 1.6) },
    { label: S.detect ? '✓ Detect' : 'Detect', on: S.detect, act: () => { S.detect = !S.detect; $('cbDetect').checked = S.detect; render(); } },
    { label: '⭐ Save', act: () => { saveCurrent(); drawHud(); } }, { label: '☰ Menu', act: () => toggleMenu() },
  ];
  const by = HUD.height - 420, bw = (W - 60 - 4 * 10) / 5;
  hudBtns.forEach((b, i) => {
    Object.assign(b, { x: 30 + i * (bw + 10), y: by, w: bw, h: 70 });
    c.fillStyle = i === hudHover ? '#f2c46d' : b.on ? '#5b74e0' : '#2a3a7a'; c.beginPath(); c.roundRect(b.x, b.y, b.w, b.h, 14); c.fill();
    c.fillStyle = i === hudHover ? '#16203f' : '#fff'; c.textAlign = 'center'; c.font = '600 23px system-ui, sans-serif'; c.fillText(b.label, b.x + b.w / 2, b.y + 44);
  });
  c.textAlign = 'left';
  drawChart(hudChart, chartData()); c.drawImage(hudChart, 30, HUD.height - 330);
  hudTex.needsUpdate = true;
}
let hudBtns = [], hudHover = -1;
const hudBtnAt = (uv) => { const x = uv.x * HUD.width, y = (1 - uv.y) * HUD.height; return hudBtns.findIndex((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h); };

function updDetBar() {
  const bar = $('detBar'); if (!bar) return;
  const show = !!(S.bundle && !S.explore && !S.provisional && S.ui !== '3d');
  bar.hidden = !show; if (!show) return;
  const sel = $('inDet').value, actual = S.bundle.res?.detector;
  bar.querySelectorAll('button[data-det]').forEach((b) => {
    b.classList.toggle('on', b.dataset.det === sel);
    b.classList.toggle('auto-pick', sel === 'auto' && String(actual) === b.dataset.det);
  });
}
function render() {
  if (!S.bundle || !S.views.length) { drawHud(); return; }
  S.detections = S.detect ? detect() : [];
  drawSky(); skyTex.needsUpdate = true; updateRelief(); drawContext(); applyVrZoom();
  $('inTime').value = S.idx;
  const v = S.views[S.idx];
  $('timeLabel').textContent = `${S.idx + 1} / ${S.views.length} · ${mjdToDate(v.mjd)} UTC`;
  $('reads').innerHTML = readsHtml(infoRows());
  $('trackInfo').innerHTML = readsHtml(trackRows());
  $('motionInfo').innerHTML = readsHtml(motionRows()); $('btnMotion').disabled = S.views.length < 2;
  if (S.chart === 'survey') drawSurveyLightCurve($('chart'), S.lc); else drawChart($('chart'), chartData());
  followMover(); drawHud(); draw2d(); updDetBar();
}

// --- pointer: drag to look around, wheel to zoom, click to pick a point on the sky or mark an object in the cutout
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();

// ------------------------------------------------------------------ sky-dome view: neighbour tiles, loading preview, hover glow, pinned points
// put a unit plane on the dome at (ra, dec) with the true angular size; returns the four sky corners (for cone lines)
function placeOnDome(mesh, ra, dec, fovAs, rr) {
  const a = ra * D2R, d = dec * D2R, r = R * rr, c = dirOf(ra, dec);
  const east = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a)), north = new THREE.Vector3(-Math.sin(d) * Math.cos(a), Math.cos(d), Math.sin(d) * Math.sin(a));
  const size = (fovAs / 3600) * D2R * r;
  mesh.matrixAutoUpdate = false;
  mesh.matrix.makeBasis(east.clone().multiplyScalar(-size), north.clone().multiplyScalar(size), c.clone().negate().multiplyScalar(size)).setPosition(c.clone().multiplyScalar(r));
  mesh.matrixWorldNeedsUpdate = true;
  return [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => c.clone().multiplyScalar(r).addScaledVector(east, -size * x).addScaledVector(north, size * y));
}
const canvasTex = (cv, nearest = true) => { const t = new THREE.CanvasTexture(cv); if (nearest) t.magFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace; return t; };
const tileMeshes = new Map();
const PREV = document.createElement('canvas'); PREV.width = PREV.height = 768;
const previewMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: canvasTex(PREV, false), transparent: true, depthWrite: false, side: THREE.DoubleSide }));
previewMesh.visible = false; sky.add(previewMesh);
const HOV = document.createElement('canvas'); HOV.width = HOV.height = 320;
const hoverMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: canvasTex(HOV, false), transparent: true, depthWrite: false, side: THREE.DoubleSide }));
hoverMesh.visible = false; hoverMesh.renderOrder = 3; sky.add(hoverMesh);
function sync3dTiles(inXR) {
  const on = tilesOn() && (S.ui === 'dome' || inXR), live = new Set();
  if (on) {
    const v = S.views[S.idx], n = S.bundle.grid.n;
    for (const { tile } of tiles.loadedTiles()) {
      if (tile.n !== n) continue;
      live.add(tile.key);
      const f = nearestFrame(tiles.framesOf(tile), v.mjd), cv = tileCanvas(tile, f), sig = tileCv.get(tile.key)?.sig;
      let m = tileMeshes.get(tile.key);
      if (!m) {
        m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: canvasTex(cv), side: THREE.DoubleSide }));
        placeOnDome(m, tile.ra, tile.dec, n * 6.15, 0.9712); sky.add(m); tileMeshes.set(tile.key, m);
      }
      if (m.userData.f !== f || m.userData.sig !== sig) { m.material.map.image = cv; m.material.map.needsUpdate = true; m.userData.f = f; m.userData.sig = sig; }
      m.visible = true;
    }
  }
  if (tileCv.size > tiles.cache.size + 4) for (const k of [...tileCv.keys()]) if (!tiles.cache.has(k)) tileCv.delete(k);     // canvases of forgotten tiles
  for (const [k, m] of tileMeshes) if (!live.has(k)) { sky.remove(m); m.material.map.dispose(); m.material.dispose(); m.geometry.dispose(); tileMeshes.delete(k); }
  // the blurred "extend" preview behind the 3x3 block while neighbours are still loading
  const pend = on && !inXR && tiles.pendingRing().length > 0;
  previewMesh.visible = pend;
  const tNow = performance.now();
  if (pend && tNow - (previewMesh.userData.t || 0) > 120) {
    previewMesh.userData.t = tNow;
    const W = PREV.width, q = W / 3, c = PREV.getContext('2d');
    c.clearRect(0, 0, W, W); drawExtendedPreview(c, SKY, q, q, q, q, q, performance.now() / 1000); previewMesh.material.map.needsUpdate = true;
    if (previewMesh.userData.key !== tiles.focusKey) { const t = S.bundle.target; placeOnDome(previewMesh, t.center_ra, t.center_dec, S.bundle.grid.fov_arcsec * 3, 0.9718); previewMesh.userData.key = tiles.focusKey; }
  }
  // glow on the neighbour under the mouse
  hoverMesh.visible = !!(on && S.hover3);
  if (hoverMesh.visible) {
    const c = HOV.getContext('2d'); c.clearRect(0, 0, HOV.width, HOV.height); drawHoverTile(c, 18, 18, HOV.width - 36, HOV.height - 36, performance.now() / 1000, hoverLabel(S.hover3.dx, S.hover3.dy)); hoverMesh.material.map.needsUpdate = true;
    const k = S.hover3.dx + ',' + S.hover3.dy;
    if (hoverMesh.userData.k !== k) { const p = tileCenter(tiles.center.ra, tiles.center.dec, S.hover3.dx, S.hover3.dy, tiles.n); placeOnDome(hoverMesh, p.ra, p.dec, tiles.n * 6.15 * 1.08, 0.969); hoverMesh.userData.k = k; }
  }
}
function domeTileUnder(e) {      // which neighbouring field (dx, dy) is under the mouse in the dome view
  if (!tilesOn() || S.ui !== 'dome') return null;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
  const h = ray.intersectObject(dome, false)[0]; if (!h) return null;
  const p = raDecOf(sky.worldToLocal(h.point.clone())), g = gnomonic(tiles.center.ra, tiles.center.dec, p.ra, p.dec); if (!g) return null;
  const size = tiles.n * 6.15, t = { dx: Math.round(-g[0] / size), dy: Math.round(-g[1] / size) };
  return tiles.canHover(t.dx, t.dy) || (e.type === 'dblclick' && tiles.isLoaded(t.dx, t.dy)) ? t : null;
}

// --- UX glue (app-ux.js): detector strip + a comet's path on the sky
initUx({ setDim: (on) => { skyPlane.material.color.setScalar(on ? 0.4 : 1); magPlane.material.color.setScalar(on ? 0.4 : 1); } });
function paintThumb(cv, data, n) {     // one detector's picture, stretched like the main view (own median + percentile range, same colours, same "no data" colour)
  const n2 = n * n, med = quantile(finiteSorted(data, Math.max(1, Math.floor(n2 / 20000))), 0.5) || 0, a = new Float32Array(n2);
  for (let i = 0; i < n2; i++) a[i] = data[i] - med;
  const sorted = finiteSorted(a, Math.max(1, Math.floor(n2 / 20000)));
  const lim0 = S.lim, mode0 = S.mode; let lo = quantile(sorted, 0.01), hi = quantile(sorted, S.white); if (!(hi > lo)) hi = (lo || 0) + 1;
  S.lim = [lo, hi]; S.mode = 'blink'; cv.width = cv.height = n;
  const c = cv.getContext('2d'), id = c.createImageData(n, n);
  for (let row = 0; row < n; row++) for (let x = 0; x < n; x++) {
    const v = a[row * n + x], o = ((n - 1 - row) * n + x) * 4, rgb = finite(v) ? colorize(stretchValue(v)) : NAN_RGB;
    id.data[o] = rgb[0]; id.data[o + 1] = rgb[1]; id.data[o + 2] = rgb[2]; id.data[o + 3] = 255;
  }
  S.lim = lim0; S.mode = mode0; c.putImageData(id, 0, 0);
}
const strip = createDetStrip({
  getIndex, getBlink,
  request: () => (S.cur && !S.explore ? { ra: S.cur.ra, dec: S.cur.dec, pm: S.cur.pm || null, name: S.cur.name, half: +$('inHalf').value } : null),
  paint: paintThumb,
  current: () => { const d = $('inDet').value; return d === 'auto' ? S.bundle?.res?.detector : d; },
  onPick: (d) => { $('inDet').value = String(d); updDetBar(); reload(); },
});
let moverPath = null, pathLine = null;
function setMoverPath(res) {      // a comet's whole imaged path: thin line on the dome, zoomed out to show it all
  clearMoverPath();
  if (!res?.path || res.path.length < 2) return;
  moverPath = res.path; pathLine = makePathLine(res.path, dirOf, R * 0.955); sky.add(pathLine);
  if (!renderer.xr.isPresenting) { const e = pathExtentDeg(res.path); if (S.ui === 'dome') flyTo(e.ra, e.dec, Math.min(100, Math.max(e.size * 1.7, cutFov() * 3))); }
}
function clearMoverPath() { moverPath = null; if (pathLine) { disposeObject(pathLine); pathLine = null; } hidePathInset(); }
function followMover() {      // follow mode keeps the comet centred in the image, so the motion shows on the sky: the footprint (and zoom cone) moves to the frame's position
  const res = S.bundle?.res, v = S.views[S.idx];
  if (!moverPath || !v || !finite(v.ra) || !finite(v.dec) || res?.kind !== 'mover') { if (!moverPath) hidePathInset(); return; }
  if (S.ui === '2d') drawPathInset(moverPath, { ra: v.ra, dec: v.dec, date: v.date }, res.target?.name || ''); else hidePathInset();
  if (renderer.xr.isPresenting) return;
  placeCutoutAt(v.ra, v.dec, S.bundle.grid.fov_arcsec);
  if (S.ui === 'dome' && !V.anim && !drag) {      // the comet walks out of view: turn the camera after it (keeps the zoom)
    const q = dirOf(v.ra, v.dec).multiplyScalar(R * 0.97).applyMatrix4(sky.matrixWorld).project(camera);
    if (q.z > 1 || Math.abs(q.x) > 0.6 || Math.abs(q.y) > 0.6) flyTo(v.ra, v.dec, V.fov, 0.7);
  }
}

// playbar (app-ux.js): reads the app's own state (S.idx, S.acc, S.speed), seeking sets S.idx: no state of its own
const playbar = createPlaybar({ seek: (i) => { S.idx = i; S.acc = 0; render(); } });
function updPlaybar(inXR) {
  const n = S.views.length;
  if (inXR || n < 2 || !S.bundle || S.provisional) { playbar.update(null); return; }
  const mjd = S.views.map((v) => v.mjd), long = (mjd[n - 1] - mjd[0]) < 3, tm = (v) => (long ? v.date : String(v.date).slice(0, 10));
  const lastHold = S.idx === n - 1 ? 0.65 : 0, per = 1 / S.speed + lastHold;
  const ticks = S.views.map((v, i) => i > 0 && String(v.date).slice(0, 10) !== String(S.views[i - 1].date).slice(0, 10));
  playbar.update({ n, idx: S.idx, frac: S.playing && S.mode !== 'stack' ? Math.min(1, S.acc / per) : 0, first: tm(S.views[0]), last: tm(S.views[n - 1]), ticks, playing: S.playing });
}
// --- remembered points (dome view): ONE zoom cone / window is open at a time (the current point). Picking a new point closes the
//     previous one's cone and window but REMEMBERS the point: a small marker (dot + name + the square of its field) stays on the sky.
//     Hover a marker: its window and cone pop up again as a preview (from the images already kept, no download); move away and it
//     hides. Click a marker: that point becomes the open one. The ✕ on the preview window forgets the point. At most 30 are kept.
const pins = []; let pinSeq = 0, pinHover = null, previewPin = null, previewT = 0, pinMarkerHot = false;
const MAX_PINS = 30, MAX_PIN_BYTES = 300e6;
const pinBytes = (p) => p.views.length * p.n * p.n * 4;
function pinCurrent() {
  const b = S.bundle; if (!b || S.provisional || !S.views.length || renderer.xr.isPresenting) return;
  const t = b.target;
  for (const p of [...pins]) if (Math.abs(p.ra - t.center_ra) < 1e-5 && Math.abs(p.dec - t.center_dec) < 1e-5) removePin(p);
  const cv = document.createElement('canvas'); cv.width = cv.height = 320;
  const tex = canvasTex(cv);
  const p = { id: ++pinSeq, name: t.name, cur: S.cur ? { ...S.cur } : null, explore: S.explore, ra: t.center_ra, dec: t.center_dec, n: b.grid.n,
    views: S.views.map((v) => v.img), lim: S.lim.slice(), idx: S.idx, cv, tex, small: document.createElement('canvas') };
  p.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  p.foot = placeOnDome(p.plane, p.ra, p.dec, b.grid.fov_arcsec, 0.9705); sky.add(p.plane); p.plane.visible = false;
  p.win = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, depthTest: false, transparent: true }));
  p.win.renderOrder = 12; p.win.userData.pin = p; p.win.visible = false; scene.add(p.win);
  p.lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8b93ff, transparent: true, opacity: 0.55 }));
  p.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(16 * 3), 3)); p.lines.frustumCulled = false; p.lines.visible = false; scene.add(p.lines);
  p.outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(p.foot), new THREE.LineBasicMaterial({ color: 0x8b93ff, transparent: true, opacity: 0.7, depthTest: false }));
  p.outline.renderOrder = 4; p.outline.frustumCulled = false; sky.add(p.outline);
  p.marker = labelSprite(p.name.slice(0, 24), '#8b93ff'); p.marker.position.copy(dirOf(p.ra, p.dec).multiplyScalar(R * 0.96)); sky.add(p.marker);
  pins.push(p);
  while (pins.length > MAX_PINS || (pins.length > 1 && pins.reduce((a, q) => a + pinBytes(q), 0) > MAX_PIN_BYTES)) removePin(pins[0]);
  paintPin(p); updForget();
}
function removePin(p) {
  const i = pins.indexOf(p); if (i < 0) return; pins.splice(i, 1);
  sky.remove(p.plane, p.outline, p.marker); scene.remove(p.win, p.lines);
  p.tex.dispose(); p.marker.material.map.dispose(); p.marker.material.dispose();
  for (const m of [p.plane, p.win, p.lines, p.outline]) { m.geometry.dispose(); m.material.dispose(); }
  if (pinHover === p) pinHover = null; if (previewPin === p) previewPin = null;
  updForget();
}
function forgetPins() { for (const p of [...pins]) removePin(p); }
function updForget() { const b = $('btnForget'); if (b) { b.textContent = `Forget remembered points (${pins.length})`; b.disabled = !pins.length; } }
function paintPin(p) {
  const n = p.n, img = p.views[p.idx % p.views.length], sm = p.small; sm.width = sm.height = n;
  const sc = sm.getContext('2d'), id = sc.createImageData(n, n), lim0 = S.lim, mode0 = S.mode; S.lim = p.lim; S.mode = 'blink';
  for (let row = 0; row < n; row++) for (let x = 0; x < n; x++) {
    const v = img[row * n + x], o = ((n - 1 - row) * n + x) * 4, rgb = finite(v) ? colorize(stretchValue(v)) : NAN_RGB;
    id.data[o] = rgb[0]; id.data[o + 1] = rgb[1]; id.data[o + 2] = rgb[2]; id.data[o + 3] = 255;
  }
  S.lim = lim0; S.mode = mode0; sc.putImageData(id, 0, 0);
  const c = p.cv.getContext('2d'), W = p.cv.width;
  c.imageSmoothingEnabled = false; c.drawImage(sm, 0, 0, W, W);
  c.fillStyle = 'rgba(7,10,20,.72)'; c.fillRect(0, W - 34, W, 34);
  c.fillStyle = '#e6e9f5'; c.font = '600 17px system-ui, sans-serif'; c.textBaseline = 'middle'; c.fillText(p.name.slice(0, 30), 10, W - 17);
  c.strokeStyle = 'rgba(139,147,255,.8)'; c.lineWidth = 3; c.strokeRect(1.5, 1.5, W - 3, W - 3);
  if (previewPin === p) {      // the "forget this point" button
    c.fillStyle = p.hoverX ? '#fb7185' : 'rgba(7,10,20,.8)'; c.beginPath(); c.arc(W - 26, 26, 19, 0, 2 * Math.PI); c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = 3; c.beginPath(); c.moveTo(W - 33, 19); c.lineTo(W - 19, 33); c.moveTo(W - 19, 19); c.lineTo(W - 33, 33); c.stroke();
  }
  p.tex.needsUpdate = true;
}
function setPreview(p) {      // the one remembered point whose window + cone are shown right now (null: none)
  previewT = performance.now();
  if (p === previewPin) return;
  const old = previewPin; previewPin = p;
  if (old) { old.win.visible = old.lines.visible = old.plane.visible = false; paintPin(old); }
  if (p) paintPin(p);
}
function advancePins() { for (const p of pins) p.idx++; if (previewPin) paintPin(previewPin); }
function updatePins(inXR) {
  const show = S.ui === 'dome' && !inXR && V.fov > cutFov() * 20;
  if (previewPin && !pinHover && !pinMarkerHot && performance.now() - previewT > 500) setPreview(null);       // moved away: hide after a short grace so the ✕ can be reached
  sky.updateMatrixWorld();
  const H = 2 * 10 * Math.tan(V.fov * D2R / 2), h = H * 0.17;
  for (const q of pins) { q.outline.visible = S.ui === 'dome' || inXR; q.marker.visible = q.outline.visible && (inXR || V.fov >= cutFov() * 20); }
  const p = previewPin; if (!p) return;
  p.plane.visible = S.ui === 'dome'; p.win.visible = p.lines.visible = show;
  if (!show) return;
  const ndcX = -1 + 2 * (0.02 + 0.085 * innerHeight / innerWidth), ndcY = -1 + 2 * (0.03 + 0.085);
  const dir = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
  p.win.position.copy(camera.position).addScaledVector(dir, 10); p.win.quaternion.copy(camera.quaternion); p.win.scale.set(h, h, 1); p.win.updateMatrixWorld();
  const pc = CORN.map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(p.win.matrixWorld)), fc = p.foot.map((q) => q.clone().applyMatrix4(sky.matrixWorld));
  const L = p.lines.geometry.attributes.position;
  for (let k = 0; k < 4; k++) { const j = (k + 1) % 4; L.setXYZ(k * 2, ...pc[k].toArray()); L.setXYZ(k * 2 + 1, ...fc[k].toArray()); L.setXYZ(8 + k * 2, ...fc[k].toArray()); L.setXYZ(8 + k * 2 + 1, ...fc[j].toArray()); }
  L.needsUpdate = true;
}
function pinUnder(e) {      // the preview window under the mouse (only one can be open)
  if (!previewPin || !previewPin.win.visible || S.ui !== 'dome') return null;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
  const h = ray.intersectObject(previewPin.win, false)[0]; if (!h) return null;
  return { pin: h.object.userData.pin, onX: h.uv.x > 0.8 && h.uv.y > 0.8 };
}
function pinMarkerUnder(e) {      // the remembered point whose marker (or whose square, when zoomed in) is under the mouse
  if (!pins.length || S.ui !== 'dome') return null;
  sky.updateMatrixWorld();
  const v = new THREE.Vector3(); let best = null, bd = 1e9;
  for (const p of pins) {
    v.copy(dirOf(p.ra, p.dec)).multiplyScalar(R * 0.96).applyMatrix4(sky.matrixWorld).project(camera);
    if (v.z > 1) continue;
    const x = (v.x + 1) / 2 * innerWidth, y = (1 - v.y) / 2 * innerHeight, d = Math.hypot(e.clientX - x, e.clientY - y);
    const half = (p.n * 6.15 / 3600 / 2) / V.fov * innerHeight;       // half the square's side, in pixels
    if (d < Math.max(22, half) && d < bd) { best = p; bd = d; }
  }
  return best;
}
function domeHover(e) {      // mouse over the dome (no drag): a remembered point (preview), the preview's ✕, or a neighbouring field (glows)
  const pu = pinUnder(e), mk = pu ? null : pinMarkerUnder(e), np = pu?.pin || null, nx = !!pu?.onX;
  pinMarkerHot = !!mk; if (mk) setPreview(mk);
  if (np !== pinHover || (np && np.hoverX !== nx)) { pinHover = np; if (np) { np.hoverX = nx; paintPin(np); previewT = performance.now(); } }
  const t = pu || mk ? null : domeTileUnder(e);
  if ((t?.dx !== S.hover3?.dx) || (t?.dy !== S.hover3?.dy)) S.hover3 = t;
  el.style.cursor = pu || mk || t ? 'pointer' : 'grab';
}
function domeClick(e) {      // returns true when the click was used: forget a point (✕), open a remembered point, or load a neighbouring field
  const pu = pinUnder(e), mk = pu ? null : pinMarkerUnder(e);
  if (pu || mk) {
    const p = pu ? pu.pin : mk; removePin(p);
    if (!pu?.onX) { if (p.explore) { const it = S.exploreItems?.find((q) => q.id === p.explore); if (it) openExplore(it); } else if (p.cur) loadTarget(p.cur); }
    return true;
  }
  const tu = domeTileUnder(e);
  if (tu) { clearTimeout(S.clickT); S.clickT = setTimeout(() => clickNeighbour(tu.dx, tu.dy), 260); return true; }
  return false;
}

const el = renderer.domElement; el.style.touchAction = 'none'; el.style.cursor = 'grab';
let drag = null;
el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY }; el.setPointerCapture(e.pointerId); });
el.addEventListener('pointermove', (e) => {
  if (!drag) { domeHover(e); return; }
  const k = V.fov / innerHeight, dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
  if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
  V.anim = null; V.ra = (V.ra + dx * k / Math.max(0.05, Math.cos(V.dec * D2R)) + 360) % 360; V.dec += dy * k;
});
function skyHit(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
  const onCut = skyPlane.visible && ray.intersectObject(skyPlane, false)[0];
  if (onCut && V.fov < cutFov() * 6) return { uv: onCut.uv };
  const h = ray.intersectObject(dome, false)[0];
  return h ? raDecOf(sky.worldToLocal(h.point.clone())) : null;
}
function pickSky(p) {     // a click on the dome loads that point (or the test target / saved point next to it)
  const near = [...PRESETS, ...S.saved].map((q) => ({ q, d: Math.hypot(((q.ra - p.ra + 540) % 360 - 180) * Math.cos(p.dec * D2R), q.dec - p.dec) })).sort((a, b) => a.d - b.d)[0];
  if (near.d < Math.max(0.05, V.fov * 0.035)) { if (near.q.id) gotoSaved(near.q); else loadTarget(near.q); return; }
  $('inName').value = '';
  loadTarget({ key: null, name: `RA ${p.ra.toFixed(4)}° Dec ${p.dec.toFixed(4)}°`, ra: p.ra, dec: p.dec, pm: null });
  pickRing.position.copy(dirOf(p.ra, p.dec).multiplyScalar(R * 0.96)); pickRing.visible = true;
}
el.addEventListener('pointerup', (e) => {
  const d = drag; drag = null; if (!d || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4) return;
  if (domeClick(e)) return;
  const h = skyHit(e); if (!h) return;
  if (h.uv) { if (S.bundle) markFromUv(h.uv); } else pickSky(h);
});
el.addEventListener('dblclick', (e) => { const tu = domeTileUnder(e); if (tu) { clearTimeout(S.clickT); recenterTo(tu.dx, tu.dy); } });
el.addEventListener('wheel', (e) => { e.preventDefault(); V.anim = null; V.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, V.fov * Math.exp(e.deltaY * 0.0015))); }, { passive: false });
function markFromUv(uv) { const n = S.bundle.grid.n; addMark(uv.x * n - 0.5, uv.y * n - 0.5); }

// VR controllers: trigger on the panel marks an object, elsewhere steps; grip toggles play; stick zooms the panel / steps
const ctrls = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0xf2c46d, transparent: true, depthTest: false }));
  line.scale.z = 5; line.renderOrder = 26; c.add(line); c.userData.line = line;
  c.addEventListener('selectstart', () => {
    scene.updateMatrixWorld(true);
    const m = new THREE.Matrix4().extractRotation(c.matrixWorld);
    ray.ray.origin.setFromMatrixPosition(c.matrixWorld); ray.ray.direction.set(0, 0, -1).applyMatrix4(m);
    if (menuMesh.visible) {
      const mh = ray.intersectObject(menuMesh, false)[0]; if (mh) { menuClick(mh.uv); return; }
      const dh0 = ray.intersectObject(dome, false)[0];
      if (dh0 && !ray.intersectObject(vrPlane, false)[0] && !ray.intersectObject(hudPlane, false)[0]) { menuMesh.visible = false; S.pickMode = false; pickSky(raDecOf(sky.worldToLocal(dh0.point.clone()))); }
      return;
    }
    const hit = S.bundle && ray.intersectObject(vrPlane, false)[0];
    if (hit) { const w = vrWindow(); markFromUv({ x: w.u0 + hit.uv.x * w.r, y: w.v0 + hit.uv.y * w.r }); return; }
    const hb = ray.intersectObject(hudPlane, false)[0]; if (hb) { const bi = hudBtnAt(hb.uv); if (bi >= 0) hudBtns[bi].act(); else step(1); return; }
    const dh = ray.intersectObject(dome, false)[0];      // pointing at the sky: load that point
    if (dh) { S.pickMode = false; pickSky(raDecOf(sky.worldToLocal(dh.point.clone()))); drawHud(); }
  });
  c.addEventListener('squeezestart', () => togglePlay());
  scene.add(c); return c;
});
let stickCool = 0; const btnPrev = {}, stickLatch = {};
// turn the whole world around you (sky, panels, menu) so you can look elsewhere without turning your body
function snapTurn(deg) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg * D2R);
  const cam = renderer.xr.getCamera(), p = new THREE.Vector3(); cam.getWorldPosition(p);
  for (const o of [sky, content, menuMesh]) { o.position.sub(p).applyQuaternion(q).add(p); o.quaternion.premultiply(q); }
}
// jump to the next/previous star: the five targets, then your saved points
function cycleTarget(d) {
  const list = [...PRESETS, ...S.saved.filter((e) => !e.key)];
  const i = list.findIndex((q) => S.cur && Math.abs(q.ra - S.cur.ra) < 1e-3 && Math.abs(q.dec - S.cur.dec) < 1e-3);
  const n = list[((i < 0 ? 0 : i + d) + list.length) % list.length];
  if (n.id) gotoSaved(n); else loadTarget(n);
}
// one reticle per hand: a ring where the ray meets the sky and a large, outlined label with RA/Dec
const reticles = [0, 1].map(() => {
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 128;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
  sp.center.set(64 / 1024, 0.5); sp.renderOrder = 6; sp.visible = false; scene.add(sp);
  return { sp, cv, txt: '' };
});
const reticle = reticles[0].sp;     // kept for the debug object
const cursors = ctrls.map(() => { const m = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.022, 24), new THREE.MeshBasicMaterial({ color: 0xf2c46d, depthTest: false, transparent: true, side: THREE.DoubleSide }));
  m.renderOrder = 27; m.visible = false; scene.add(m); return m; });
let menuHover = -1;
function setReticleText(r, txt, color) {
  if (txt === r.txt) return; r.txt = txt;
  const g = r.cv.getContext('2d'), W = r.cv.width, H = r.cv.height; g.clearRect(0, 0, W, H);
  g.font = '700 46px system-ui, sans-serif'; g.textBaseline = 'middle';
  const tw = g.measureText(txt).width;
  g.fillStyle = 'rgba(7,10,20,.78)'; g.beginPath(); g.roundRect(118, 20, Math.min(W - 124, tw + 40), H - 40, 22); g.fill();
  g.strokeStyle = color; g.lineWidth = 9; g.beginPath(); g.arc(64, 64, 38, 0, 2 * Math.PI); g.stroke();
  g.lineWidth = 3; g.beginPath(); g.moveTo(64, 18); g.lineTo(64, 38); g.moveTo(64, 90); g.lineTo(64, 110); g.moveTo(18, 64); g.lineTo(38, 64); g.moveTo(90, 64); g.lineTo(110, 64); g.stroke();
  g.fillStyle = '#ffffff'; g.fillText(txt, 138, 66); r.sp.material.map.needsUpdate = true;
}
function updateReticle() {     // what each controller points at, and what the trigger will do there
  for (const r of reticles) r.sp.visible = false; for (const k of cursors) k.visible = false;
  if (!renderer.xr.isPresenting) return;
  scene.updateMatrixWorld(true);     // this frame's controller poses and panel positions, so each ray (and its drawn line) ends exactly on the surface it hits
  let hover = -1, hh2 = -1;
  ctrls.forEach((c, ci) => {
    const m = new THREE.Matrix4().extractRotation(c.matrixWorld);
    ray.ray.origin.setFromMatrixPosition(c.matrixWorld); ray.ray.direction.set(0, 0, -1).applyMatrix4(m);
    const put = (h, color) => { const k = cursors[ci]; k.position.copy(h.point); k.lookAt(ray.ray.origin); k.material.color.set(color); k.visible = true; c.userData.line.scale.z = Math.max(0.05, h.distance); };
    const mh = menuMesh.visible && ray.intersectObject(menuMesh, false)[0];
    if (mh) {
      put(mh, 0xf2c46d);
      const x = mh.uv.x * MENU.width, y = (1 - mh.uv.y) * MENU.height;
      const bi = menuBtns.findIndex((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h); if (bi >= 0) hover = bi;
      return;
    }
    const ph = S.bundle && ray.intersectObject(vrPlane, false)[0]; if (ph) { put(ph, 0x8b93ff); return; }
    const hh = ray.intersectObject(hudPlane, false)[0]; if (hh) { put(hh, 0xb8c4f0); const bi = hudBtnAt(hh.uv); if (bi >= 0) hh2 = bi; return; }
    c.userData.line.scale.z = 5;
    const h = ray.intersectObject(dome, false)[0]; if (!h) return;
    const p = raDecOf(sky.worldToLocal(h.point.clone())), r = reticles[ci];
    r.sp.position.copy(h.point).multiplyScalar(0.9); r.sp.scale.set(9.6, 1.2, 1); r.sp.visible = true;
    setReticleText(r, `RA ${p.ra.toFixed(2)}°  Dec ${p.dec >= 0 ? '+' : ''}${p.dec.toFixed(2)}°  ·  trigger: load`, S.pickMode ? '#f2c46d' : '#6ee7b7');
  });
  if (hh2 !== hudHover) { hudHover = hh2; drawHud(); }
  if (menuMesh.visible && hover !== menuHover) { menuHover = hover; drawMenu(); }
}
function pollSticks(dt) {
  const session = renderer.xr.getSession(); if (!session) return;
  stickCool -= dt;
  for (const src of session.inputSources) {
    const bt = src.gamepad?.buttons || [], pressed = !!(bt[4]?.pressed || bt[5]?.pressed), key = src.handedness;
    if (pressed && !btnPrev[key]) toggleMenu();     // A/B (right) or X/Y (left): open / close the settings
    btnPrev[key] = pressed;
    const ax = src.gamepad?.axes; if (!ax || ax.length < 4) continue;
    const sx = ax[2], sy = ax[3], k = key || 'right';
    if (k === 'left') {
      // LEFT stick: move yourself. Sideways = turn 30° (no need to turn your body); forward/back = fly to the next/previous star
      if (Math.abs(sx) > 0.7 && !(stickLatch[k + 'x'])) { snapTurn(sx > 0 ? -30 : 30); stickLatch[k + 'x'] = true; }
      if (Math.abs(sx) < 0.3) stickLatch[k + 'x'] = false;
      if (Math.abs(sy) > 0.7 && !(stickLatch[k + 'y'])) { cycleTarget(sy < 0 ? 1 : -1); stickLatch[k + 'y'] = true; }
      if (Math.abs(sy) < 0.3) stickLatch[k + 'y'] = false;
    } else {
      // RIGHT stick: forward/back = zoom the image, sideways = previous/next frame
      if (Math.abs(sy) > 0.2) vrZoomBy(Math.exp(-sy * dt * 2.2), vrPointerOnPanel(1));
      if (Math.abs(sx) > 0.7 && stickCool <= 0) { step(sx > 0 ? 1 : -1); stickCool = 0.35; }
    }
  }
}

// ------------------------------------------------------------------ light for the 3D relief (the dome and the flat views ignore it)
scene.add(new THREE.AmbientLight(0xffffff, 1.4));
{ const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(-1.2, 1.5, 0.4); camera.add(sun); const tg = new THREE.Object3D(); tg.position.set(0, 0, -3); camera.add(tg); sun.target = tg; scene.add(camera); }

// ------------------------------------------------------------------ the surroundings of the point (G2): a wider, lower-priority request
const CTXC = document.createElement('canvas'); CTXC.width = CTXC.height = 4;
let ctxTex = null;
const ctxPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.92 }));
ctxPlane.matrixAutoUpdate = false; ctxPlane.visible = false; sky.add(ctxPlane);
function applyContext(t, r, res) {
  if (!r.frames.length || r.detector !== res.detector) return;
  const n = r.grid.n, n2 = n * n;
  S.ctx = { n, ra: r.grid.center_ra ?? t.ra, dec: r.grid.center_dec ?? t.dec, frames: r.frames.map((f) => {
    const med = quantile(finiteSorted(f.data, 7), 0.5) || 0, a = new Float32Array(n2); for (let i = 0; i < n2; i++) a[i] = f.data[i] - med;
    return { mjd: f.mjd, img: a };
  }) };
  CTXC.width = CTXC.height = n;
  if (ctxTex) ctxTex.dispose();
  ctxTex = new THREE.CanvasTexture(CTXC); ctxTex.magFilter = THREE.NearestFilter; ctxTex.colorSpace = THREE.SRGBColorSpace;
  ctxPlane.material.map = ctxTex; ctxPlane.material.needsUpdate = true;
  $('ctxNote').textContent = `Surroundings: ${fmt(n * 6.15 / 60, 0)}′ around the point, detector D${r.detector}, first and last visit, same stretch. Only the inner square (the frame) blinks through all visits.`;
}
function placeContext() {
  if (!S.ctx) return;
  const a = S.ctx.ra * D2R, d = S.ctx.dec * D2R, r = R * 0.975, c = dirOf(S.ctx.ra, S.ctx.dec);
  const east = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a)), north = new THREE.Vector3(-Math.sin(d) * Math.cos(a), Math.cos(d), Math.sin(d) * Math.sin(a));
  const size = (S.ctx.n * 6.15 / 3600) * D2R * r;
  ctxPlane.matrix.makeBasis(east.clone().multiplyScalar(-size), north.clone().multiplyScalar(size), c.clone().negate().multiplyScalar(size)).setPosition(c.clone().multiplyScalar(r));
  ctxPlane.matrixWorldNeedsUpdate = true; ctxPlane.visible = !reliefOn();
}
function drawContext() {     // the surroundings, at the visit nearest in time to the current frame, with the main stretch
  const C = S.ctx, v = S.views[S.idx]; if (!C || !v) return;
  const f = C.frames.reduce((b, x) => (Math.abs(x.mjd - v.mjd) < Math.abs(b.mjd - v.mjd) ? x : b), C.frames[0]), n = C.n;
  const cx = CTXC.getContext('2d'), id = cx.createImageData(n, n), diff = S.mode === 'diff';
  for (let row = 0; row < n; row++) for (let x = 0; x < n; x++) {
    const val = f.img[row * n + x], o = ((n - 1 - row) * n + x) * 4;
    let rgb;
    if (!finite(val)) rgb = NAN_RGB;
    else { const sv = (() => { const m = S.mode; S.mode = 'blink'; const r0 = stretchValue(val); S.mode = m; return r0; })(); rgb = colorize(sv); if (diff) rgb = rgb.map((q) => q * 0.45); }
    id.data[o] = rgb[0]; id.data[o + 1] = rgb[1]; id.data[o + 2] = rgb[2]; id.data[o + 3] = 255;
  }
  cx.putImageData(id, 0, 0); if (ctxTex) ctxTex.needsUpdate = true;
}

// ------------------------------------------------------------------ G4: measured direction and speed of the object
function measureMotion() {
  const b = S.bundle; if (!b || S.views.length < 2) return null;
  const n = b.grid.n, pix = b.grid.pixel_arcsec, m = S.marks[0];
  let pts = S.views.map((v, i) => {
    const p = m ? m.pos[i] : (() => { const c = centroid(v.img, n, v.targetPx[0], v.targetPx[1], 2); return c; })();
    // is the object really seen in this frame? aperture S/N against the frame's robust noise
    // (Daniel's apertureSnr, the same test the deep stack uses; a saturated core counts as seen)
    const snr = v.sat ? Infinity : finite(p.x) ? apertureSnr(v.img, n, p.x, p.y)[0] : NaN;
    return { t: mjdToYear(v.mjd), x: p.x, y: p.y, ok: p.ok !== false, snr };
  }).filter((p) => p.ok && finite(p.x) && finite(p.y));
  if (pts.filter((p) => p.snr >= 5).length < 2) return { error: 'The object is not clearly visible in single images (S/N below 5), so there is nothing to measure. Try "Deep stack".' };
  if (pts.length < 2) return { error: 'The object was not found in more than one image.' };
  const span = pts[pts.length - 1].t - pts[0].t; if (span < 0.05) return { error: 'The images are too close in time to measure motion.' };
  const fit = (k) => {
    const N = pts.length, mt = pts.reduce((q, p) => q + p.t, 0) / N, mv = pts.reduce((q, p) => q + p[k], 0) / N;
    let num = 0, den = 0; for (const p of pts) { num += (p.t - mt) * (p[k] - mv); den += (p.t - mt) ** 2; }
    const slope = num / den; let rss = 0; for (const p of pts) rss += (p[k] - (mv + slope * (p.t - mt))) ** 2;
    const sFit = N > 2 ? Math.sqrt(rss / (N - 2) / den) : 0;
    return { slope, mt, mv, err: Math.max(sFit, 0.28 / span) };     // floor: +-0.2 px per position (stated in the UI)
  };
  const fx = fit('x'), fy = fit('y');
  const east = -fx.slope * pix, north = fy.slope * pix, total = Math.hypot(east, north);
  const se = fx.err * pix, sn = fy.err * pix;
  const err = total > 0 ? Math.sqrt((east * se) ** 2 + (north * sn) ** 2) / total : Math.hypot(se, sn);
  const pa = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
  const at = (t) => ({ x: fx.mv + fx.slope * (t - fx.mt), y: fy.mv + fy.slope * (t - fy.mt) });
  const t0 = mjdToYear(S.views[0].mjd), t1 = mjdToYear(S.views[S.views.length - 1].mjd), p0 = at(t0), p1 = at(t1);
  const dpx = Math.hypot(p1.x - p0.x, p1.y - p0.y), days = (S.views[S.views.length - 1].mjd - S.views[0].mjd);
  const t = b.target, cat = Math.hypot(t.pmra_masyr, t.pmdec_masyr) / 1000;
  return { weak: pts.some((p) => p.snr < 10), east, north, total, err, pa, p0, p1, dpx, days, n: pts.length, sig: total > 3 * err && dpx > 0.3, who: m ? 'marked object' : 'target',
    cat: m ? null : { total: cat, pa: (Math.atan2(t.pmra_masyr, t.pmdec_masyr) * 180 / Math.PI + 360) % 360 }, track: b.grid.track };
}
function motionRows() {
  const M = S.motion; if (!S.showMotion || !M) return [];
  if (M.error) return [['Direction & speed', M.error]];
  if (M.track) return [['Direction & speed', 'Motion is cancelled in "Track" view. Switch to "Sky fixed".']];
  const rows = [['Measured (' + M.who + ')', M.sig ? `${fmt(M.total, 1)} ± ${fmt(M.err, 1)}″/yr, PA ${fmt(M.pa, 0)}°` : `No significant motion (${fmt(M.total, 1)} ± ${fmt(M.err, 1)}″/yr)`],
    ['Shift in images', `${fmt(M.dpx, 2)} px over ${fmt(M.days, 0)} days, ${M.n} measurements`]];
  if (M.cat) rows.push(['Catalogue (Sesame)', M.cat.total > 0.05 ? `${fmt(M.cat.total, 1)}″/yr, PA ${fmt(M.cat.pa, 0)}°` : 'Almost no proper motion'],
    ['Difference from catalogue', M.cat.total > 0.05 && M.sig ? `${fmt(M.total - M.cat.total, 1)}″/yr, ${fmt(((M.pa - M.cat.pa + 540) % 360) - 180, 0)}°` : '—']);
  if (M.weak) rows.push(['Note', 'The object is faint (S/N < 10) in some images: the measured position may be pulled toward the predicted one.']);
  rows.push(['Precision', 'Includes a ±0.2 px floor on position. PA 0° = north, 90° = east.']);
  return rows;
}
function drawMotionArrow(P, sc) {
  const M = S.motion; if (!S.showMotion || !M || M.error || M.track) return;
  const W = SKY.width; skyCtx.save();
  skyCtx.font = `bold ${Math.round(W / 32)}px system-ui, sans-serif`; skyCtx.direction = 'ltr'; skyCtx.textAlign = 'left';
  if (!M.sig) {
    const [X, Y] = P(M.p0.x, M.p0.y); skyCtx.strokeStyle = '#8ff0b0'; skyCtx.lineWidth = 4; skyCtx.beginPath(); skyCtx.arc(X, Y, sc * 2.6, 0, 2 * Math.PI); skyCtx.stroke();
    skyCtx.fillStyle = '#8ff0b0'; skyCtx.fillText('no significant motion', X + sc * 3, Y + sc * 4); skyCtx.restore(); return;
  }
  const k = Math.max(1, Math.ceil(5 / Math.max(M.dpx, 0.01)));
  const ex = M.p0.x + (M.p1.x - M.p0.x) * k, ey = M.p0.y + (M.p1.y - M.p0.y) * k;
  const [X0, Y0] = P(M.p0.x, M.p0.y), [X1, Y1] = P(ex, ey), ang = Math.atan2(Y1 - Y0, X1 - X0), hl = Math.max(18, sc * 1.4);
  skyCtx.strokeStyle = '#f2c46d'; skyCtx.fillStyle = '#f2c46d'; skyCtx.lineWidth = Math.max(4, sc * 0.22); skyCtx.lineCap = 'round';
  skyCtx.shadowColor = 'rgba(0,0,0,.8)'; skyCtx.shadowBlur = 6;
  skyCtx.beginPath(); skyCtx.moveTo(X0, Y0); skyCtx.lineTo(X1, Y1); skyCtx.stroke();
  skyCtx.beginPath(); skyCtx.moveTo(X1, Y1); skyCtx.lineTo(X1 - hl * Math.cos(ang - 0.45), Y1 - hl * Math.sin(ang - 0.45)); skyCtx.lineTo(X1 - hl * Math.cos(ang + 0.45), Y1 - hl * Math.sin(ang + 0.45)); skyCtx.closePath(); skyCtx.fill();
  const txt = `${M.total.toFixed(1)}±${M.err.toFixed(1)}"/yr · PA ${M.pa.toFixed(0)}°${k > 1 ? ` · arrow ×${k}` : ''}`;
  skyCtx.fillText(txt, Math.min(W - skyCtx.measureText(txt).width - 20, Math.max(20, X1 + 14)), Math.max(W * 0.12, Math.min(W * 0.9, Y1 + (Y1 < Y0 ? -14 : 34))));
  skyCtx.restore();
}

// ------------------------------------------------------------------ G3: the flat 2D viewer (default)
const V2 = $('view2d'), v2c = V2.getContext('2d');
const Z = { s: 1, ox: 0, oy: 0, fitted: false };
const panelW = () => (innerWidth > 700 && document.body.classList.contains('menu-open') ? $('panel').offsetWidth + 20 : 0);
function fit2d() {
  if (!S.bundle) return;
  const n = S.bundle.grid.n, aw = innerWidth - panelW(), ah = innerWidth > 700 || !document.body.classList.contains('menu-open') ? innerHeight : innerHeight * 0.52;
  const ring = tilesOn(), ext = ring ? 2.2 * n : n, cx = n / 2, cy = n / 2;
  Z.s = (ring ? 0.98 : 0.78) * Math.min(aw, ah) / ext; Z.ox = aw / 2 - cx * Z.s; Z.oy = ah / 2 - cy * Z.s; Z.fitted = true; draw2d();
}
function ctxOffset() {     // where the surroundings sit, in main-grid pixels
  const C = S.ctx; if (!C || !S.bundle) return null;
  const n = S.bundle.grid.n, cosd = Math.cos(S.bundle.target.center_dec * D2R);
  const dx = -(((C.ra - S.bundle.target.center_ra + 540) % 360) - 180) * cosd * 3600 / 6.15, dy = -(C.dec - S.bundle.target.center_dec) * 3600 / 6.15;
  return { x0: n / 2 + dx - C.n / 2, y0: n / 2 + dy - C.n / 2 };
}
function zoom2d(f, X, Y) {
  if (X == null) { X = (innerWidth - panelW()) / 2; Y = innerHeight / 2; }
  const s = Math.max(0.3, Math.min(400, Z.s * f)); f = s / Z.s; Z.ox = X - (X - Z.ox) * f; Z.oy = Y - (Y - Z.oy) * f; Z.s = s; draw2d();
}
const tileCv = new Map();     // tile key -> {cv, f, lim, mode} (rendered with the main stretch)
function invalidateTileCanvases() { for (const v of tileCv.values()) v.f = null; }
function tileCanvas(tile, f) {
  let e = tileCv.get(tile.key);
  const n = tile.n, sig = S.lim[0] + ',' + S.lim[1] + ',' + S.mode + ',' + S.cmap + ',' + S.stretch;
  if (e && e.f === f && e.sig === sig) return e.cv;
  if (!e) { e = { cv: document.createElement('canvas') }; tileCv.set(tile.key, e); }
  if (!f._img) { const med = quantile(finiteSorted(f.data, 7), 0.5) || 0; f._img = new Float32Array(f.data.length); for (let i = 0; i < f.data.length; i++) f._img[i] = f.data[i] - med; }
  e.cv.width = e.cv.height = n;
  const cx = e.cv.getContext('2d'), id = cx.createImageData(n, n), diff = S.mode === 'diff';
  for (let row = 0; row < n; row++) for (let x = 0; x < n; x++) {
    const val = f._img[row * n + x], o = ((n - 1 - row) * n + x) * 4;
    let rgb;
    if (!finite(val)) rgb = NAN_RGB;
    else { const m = S.mode; S.mode = 'blink'; const sv = stretchValue(val); S.mode = m; rgb = colorize(sv); if (diff) rgb = rgb.map((q) => q * 0.45); }
    id.data[o] = rgb[0]; id.data[o + 1] = rgb[1]; id.data[o + 2] = rgb[2]; id.data[o + 3] = 255;
  }
  cx.putImageData(id, 0, 0); e.f = f; e.sig = sig;
  return e.cv;
}
const tilesOn = () => !!(S.bundle && !S.bundle.grid.track && !S.explore && tiles.center && +$('inCtx').value > 0);
function draw2d() {
  if (S.ui !== '2d') return;
  const dpr = Math.min(2, devicePixelRatio || 1), W = innerWidth, H = innerHeight;
  if (V2.width !== Math.round(W * dpr) || V2.height !== Math.round(H * dpr)) { V2.width = Math.round(W * dpr); V2.height = Math.round(H * dpr); }
  v2c.setTransform(dpr, 0, 0, dpr, 0, 0); v2c.fillStyle = '#070a14'; v2c.fillRect(0, 0, W, H);
  if (!S.bundle) return;
  if (!Z.fitted) fit2d();
  const n = S.bundle.grid.n, N = n * Z.s, t = performance.now() / 1000; v2c.imageSmoothingEnabled = false;
  if (tilesOn()) {
    // not-yet-loaded neighbours: an obviously fake, blurred continuation of the edges ("AI extend") while they load
    if (tiles.pendingRing().length) drawExtendedPreview(v2c, SKY, Z.ox, Z.oy, N, N, N, t);
    const v = S.views[S.idx];
    for (const { dx, dy, tile } of tiles.loadedTiles()) {
      if (tile.n !== n) continue;
      const f = nearestFrame(tiles.framesOf(tile), v.mjd);
      v2c.drawImage(tileCanvas(tile, f), Z.ox + dx * N, Z.oy + dy * N, N, N);
    }
  }
  v2c.drawImage(SKY, Z.ox, Z.oy, N, N);
  v2c.strokeStyle = 'rgba(139,147,255,.55)'; v2c.lineWidth = 1.5; v2c.strokeRect(Z.ox - 0.5, Z.oy - 0.5, N + 1, N + 1);
  if (S.hover && tilesOn()) drawHoverTile(v2c, Z.ox + S.hover.dx * N, Z.oy + S.hover.dy * N, N, N, t, hoverLabel(S.hover.dx, S.hover.dy));
  if (S.coords) {
    const c = S.bundle.target, pix = S.bundle.grid.pixel_arcsec;
    drawCoordGrid(v2c, { width: W - panelW(), height: H, scaleArcsecPerPx: pix / Z.s,
      project: (ra, dec) => { const g = gnomonic(c.center_ra, c.center_dec, ra, dec); if (!g) return null; const x = (n - 1) / 2 - g[0] / pix, y = (n - 1) / 2 + g[1] / pix; return [Z.ox + (x + 0.5) * Z.s, Z.oy + (n - 1 - y + 0.5) * Z.s]; },
      unproject: (X, Y) => { const x = (X - Z.ox) / Z.s - 0.5, y = n - 1 - ((Y - Z.oy) / Z.s - 0.5); return ungnomonic(c.center_ra, c.center_dec, ((n - 1) / 2 - x) * pix, (y - (n - 1) / 2) * pix); } });
  }
}
// double-click a neighbouring field: it becomes the new centre (its own neighbours load; everything already loaded stays)
function recenterTo(dx, dy) {
  if (!tilesOn()) return;
  const c = tileCenter(tiles.center.ra, tiles.center.dec, dx, dy, tiles.n);
  if (S.ui === '2d') { const N = S.bundle.grid.n * Z.s; Z.ox += dx * N; Z.oy += dy * N; }
  S.keepNext = true; S.hover = null; S.hover3 = null; $('inName').value = '';
  loadTarget({ key: null, name: `RA ${c.ra.toFixed(4)}° Dec ${c.dec.toFixed(4)}°`, ra: c.ra, dec: c.dec, pm: null });
}
// one click on a neighbour: not loaded -> its single image; single image -> its video
function clickNeighbour(dx, dy) {
  const det = S.bundle.res.detector, which = tiles.isLoaded(dx, dy) ? 'full' : 'quick';
  setStatus(which === 'full' ? 'Loading the video of that neighbouring field…' : 'Loading one image of that neighbouring field…');
  tiles.load(dx, dy, which, det).then((t) => { if (t?.[which]) setStatus(which === 'full' ? `Neighbouring field: ${t.full.frames.length} frames playing. Double-click it to make it the centre.` : 'Neighbouring field loaded. Click again for its video, double-click to make it the centre.', 'ok'); });
}
const hoverLabel = (dx, dy) => (tiles.isLoaded(dx, dy) ? 'Click: play video · Double-click: centre here' : 'Click to load this area');
// ---- growing surroundings (15.11): as you pan / zoom out (2D) or look around (dome), the still image of every field in view that
//      touches the loaded area is fetched, nearest to the view centre first, 4 at a time, up to 4 fields from the centre (9x9).
const GROW_MAX = 4, GROW_PAR = 4;
function growCandidates() {
  if (!tilesOn() || tiles.pendingRing().length) return [];       // first the 8 direct neighbours (load order 1-3)
  const n = tiles.n; let c, r;
  if (S.ui === '2d') {
    const N = n * Z.s, W = innerWidth - panelW(), H = innerHeight;
    const x0 = Math.floor(-Z.ox / N), x1 = Math.floor((W - Z.ox) / N), y0 = Math.floor(-Z.oy / N), y1 = Math.floor((H - Z.oy) / N);
    c = { dx: ((W / 2 - Z.ox) / N) - 0.5, dy: ((H / 2 - Z.oy) / N) - 0.5 };
    const out = [];
    for (let dy = Math.max(-GROW_MAX, y0); dy <= Math.min(GROW_MAX, y1); dy++) for (let dx = Math.max(-GROW_MAX, x0); dx <= Math.min(GROW_MAX, x1); dx++)
      if (tiles.canLoad(dx, dy)) out.push({ dx, dy, d: Math.hypot(dx - c.dx, dy - c.dy) });
    return out.sort((a, b) => a.d - b.d);
  }
  if (S.ui === 'dome' && V.fov < 6) {          // looking around the point in the dome (not from far away)
    const g = gnomonic(tiles.center.ra, tiles.center.dec, V.ra, V.dec); if (!g) return [];
    const size = n * 6.15; c = { dx: -g[0] / size, dy: -g[1] / size }; r = Math.ceil((V.fov * 3600 * 0.55) / size);
    const out = [];
    for (let dy = Math.round(c.dy) - r; dy <= Math.round(c.dy) + r; dy++) for (let dx = Math.round(c.dx) - r; dx <= Math.round(c.dx) + r; dx++)
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= GROW_MAX && tiles.canLoad(dx, dy)) out.push({ dx, dy, d: Math.hypot(dx - c.dx, dy - c.dy) });
    return out.sort((a, b) => a.d - b.d);
  }
  return [];
}
let growBusy = 0;
setInterval(() => {
  if (document.hidden || renderer.xr.isPresenting || !S.bundle) return;
  const det = S.bundle.res?.detector;
  for (const t of growCandidates()) {
    if (growBusy >= GROW_PAR) break;
    growBusy++; tiles.load(t.dx, t.dy, 'quick', det).finally(() => { growBusy--; });
  }
}, 400);
// the 2D view keeps animating while something shimmers (loading preview, hover glow)
let last2dAnim = 0;
const needs2dAnim = () => { if (!(S.ui === '2d' && S.bundle && ((tilesOn() && tiles.pendingRing().length) || S.hover))) return false; const t = performance.now(); if (t - last2dAnim < 70) return false; last2dAnim = t; return true; };     // shimmer at ~14 fps is plenty
{
  let d2 = null;
  const tileUnder = (e) => { if (!S.bundle) return null; const N = S.bundle.grid.n * Z.s; return { dx: Math.floor((e.clientX - Z.ox) / N), dy: Math.floor((e.clientY - Z.oy) / N) }; };
  V2.addEventListener('pointerdown', (e) => { d2 = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY }; V2.setPointerCapture(e.pointerId); V2.style.cursor = 'grabbing'; });
  V2.addEventListener('pointermove', (e) => {
    if (d2) { Z.ox += e.clientX - d2.x; Z.oy += e.clientY - d2.y; d2.x = e.clientX; d2.y = e.clientY; draw2d(); return; }
    const tu = tileUnder(e), h = tu && tilesOn() && tiles.canHover(tu.dx, tu.dy) ? tu : null;
    if ((h?.dx !== S.hover?.dx) || (h?.dy !== S.hover?.dy)) { S.hover = h; V2.style.cursor = h ? 'pointer' : 'grab'; draw2d(); }
  });
  V2.addEventListener('pointerleave', () => { if (S.hover) { S.hover = null; draw2d(); } });
  V2.addEventListener('pointerup', (e) => {
    const d = d2; d2 = null; V2.style.cursor = 'grab'; if (!d || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4 || !S.bundle) return;
    const n = S.bundle.grid.n, px = (e.clientX - Z.ox) / Z.s, py = (e.clientY - Z.oy) / Z.s;
    if (px >= 0 && py >= 0 && px < n && py < n) { addMark(px - 0.5, n - 0.5 - py); return; }
    const tu = tileUnder(e);
    if (tu && tilesOn() && tiles.canHover(tu.dx, tu.dy)) {      // wait a moment: a double-click recentres instead
      clearTimeout(S.clickT); S.clickT = setTimeout(() => clickNeighbour(tu.dx, tu.dy), 260);
    }
  });
  V2.addEventListener('wheel', (e) => { e.preventDefault(); zoom2d(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  V2.addEventListener('dblclick', (e) => { clearTimeout(S.clickT); const tu = tileUnder(e); if (tu && (tu.dx || tu.dy) && tilesOn() && (tiles.isLoaded(tu.dx, tu.dy) || tiles.canLoad(tu.dx, tu.dy))) recenterTo(tu.dx, tu.dy); else fit2d(); });
}

// ------------------------------------------------------------------ the view switch: 2D | 3D | sky dome
function setUi(v) {
  if (!['2d', 'dome'].includes(v)) v = '2d';
  S.ui = v; document.body.classList.toggle('ui2d', v === '2d');
  document.querySelectorAll('#uiSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  $('reliefRow').hidden = true; document.body.classList.toggle('uidome', v === 'dome');
  vrPlane.rotation.x = 0;
  if (S.bundle) { placeCutout(); placeContext(); render(); }
  followMover();
  if (v === '2d') { Z.fitted = false; draw2d(); }
  else if (S.bundle && !renderer.xr.isPresenting) flyTo(S.bundle.target.center_ra, S.bundle.target.center_dec, fitFov() * 4);
  writeUrl();
}

// ------------------------------------------------------------------ the zoom cone: joins the magnified image to its true spot on the sky
const magPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: skyTex, depthTest: false, transparent: true }));
magPlane.renderOrder = 10; magPlane.visible = false; scene.add(magPlane);
{ const fr = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0x8b93ff, depthTest: false, transparent: true })); fr.renderOrder = 11; magPlane.add(fr); }
const coneLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8b93ff, transparent: true, opacity: 0.9 }));
coneLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(16 * 3), 3));
const coneFaces = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x8b93ff, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
coneFaces.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(24 * 3), 3));
coneLines.frustumCulled = coneFaces.frustumCulled = false; scene.add(coneLines, coneFaces);
coneLines.renderOrder = 5; coneFaces.renderOrder = 4;
function setConeOver(on) {     // default: the lines pass BEHIND the magnified image; on: drawn over it
  S.coneOver = on; $('cbConeOver').checked = on;
  coneLines.renderOrder = on ? 30 : 5; coneLines.material.depthTest = !on; coneLines.material.needsUpdate = true;
}
const CORN = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
function updateCone(inXR) {
  const show = !!((S.bundle || S.provisional) && FOOT && skyPlane.visible && (inXR || (S.ui === 'dome' && V.fov > cutFov() * 20)));
  magPlane.visible = show && !inXR; coneLines.visible = show; coneFaces.visible = show && !inXR;     // in VR only the outline: a filled cone covers half the view
  if (!show) return;
  sky.updateMatrixWorld();
  let fc = FOOT.map((p) => p.clone().applyMatrix4(sky.matrixWorld));
  if (inXR && (S.vrZoom || 1) > 1.001) {     // the part of the sky the zoomed panel shows
    const w = vrWindow(), at = (u, v) => { const a = FOOT[0], b = FOOT[1], d = FOOT[3]; return a.clone().addScaledVector(b.clone().sub(a), u).addScaledVector(d.clone().sub(a), v).applyMatrix4(sky.matrixWorld); };
    fc = [at(w.u0, w.v0), at(w.u0 + w.r, w.v0), at(w.u0 + w.r, w.v0 + w.r), at(w.u0, w.v0 + w.r)];
  }
  let pc;
  if (inXR) { vrPlane.updateMatrixWorld(); pc = CORN.map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(vrPlane.matrixWorld)); }
  else {
    const ctr = fc.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(0.25), dir = ctr.clone().sub(camera.position).normalize();
    const dist = 10, h = 2 * dist * Math.tan(V.fov * D2R / 2) * 0.3, up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const ny = ctr.clone().project(camera).y;
    magPlane.position.copy(camera.position).addScaledVector(dir, dist).addScaledVector(up, (ny < 0.15 ? 1 : -1) * h * 0.95);
    magPlane.quaternion.copy(camera.quaternion); magPlane.scale.set(h, h, 1); magPlane.updateMatrixWorld();
    pc = CORN.map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(magPlane.matrixWorld));
  }
  const L = coneLines.geometry.attributes.position, F = coneFaces.geometry.attributes.position;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    L.setXYZ(i * 2, ...pc[i].toArray()); L.setXYZ(i * 2 + 1, ...fc[i].toArray());          // corner to corner
    L.setXYZ(8 + i * 2, ...fc[i].toArray()); L.setXYZ(8 + i * 2 + 1, ...fc[j].toArray());   // outline of the true spot
    const q = [pc[i], pc[j], fc[j], pc[i], fc[j], fc[i]];
    q.forEach((p, k) => F.setXYZ(i * 6 + k, ...p.toArray()));
  }
  L.needsUpdate = F.needsUpdate = true;
}

// ------------------------------------------------------------------ VR settings menu (A/B or X/Y on the Quest controllers)
const MENU = document.createElement('canvas'); MENU.width = 1024; MENU.height = 1320;
const menuTex = new THREE.CanvasTexture(MENU); menuTex.colorSpace = THREE.SRGBColorSpace;
const menuMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5 * 1320 / 1024), new THREE.MeshBasicMaterial({ map: menuTex, transparent: true, depthTest: false }));
menuMesh.renderOrder = 20; menuMesh.visible = false; scene.add(menuMesh);
let menuBtns = [];
function menuRows() {
  const det = $('inDet').value, half = $('inHalf').value, setSel = (id, v) => { $(id).value = v; reload(); };
  const t = S.cur, stepDeg = ((2 * +half + 1) * 6.15) / 3600;
  const nudge = (dn, de) => { if (!t) return; const dec = Math.max(-89.9, Math.min(89.9, t.dec + dn * stepDeg)), ra = ((t.ra + de * stepDeg / Math.max(0.05, Math.cos(t.dec * D2R))) % 360 + 360) % 360;
    loadTarget({ key: null, name: `RA ${ra.toFixed(4)}° Dec ${dec.toFixed(4)}°`, ra, dec, pm: null }); };
  return [
    ['Point', [{ label: '🎯 Pick in sky', on: S.pickMode, hint: 'Closes the menu; aim at the sky and pull the trigger', act: () => { S.pickMode = true; menuMesh.visible = false; drawHud(); } },
      { label: '↑ North', hint: 'One field north', act: () => nudge(1, 0) }, { label: '↓ South', hint: 'One field south', act: () => nudge(-1, 0) },
      { label: '← East', hint: 'One field east', act: () => nudge(0, 1) }, { label: '→ West', hint: 'One field west', act: () => nudge(0, -1) },
      { label: '↩ Previous', hint: 'The previous point', act: () => { const p = S.history.pop(); if (p) { S.skipHistory = true; loadTarget(p); } } }]],
    ['Target', PRESETS.map((p) => ({ label: p.label, on: S.cur?.key === p.key, act: () => loadTarget(p) }))],
    ['Mode', [['blink', 'Blink'], ['diff', 'Difference'], ['stack', 'Stack']].map(([v, l]) => ({ label: l, on: S.mode === v, act: () => setMode(v) }))],
    ['View', [
      { label: 'Direction & speed', on: S.showMotion, act: () => toggleMotion() },
      { label: '▶ Walkthrough', hint: 'A guided tour', act: () => { menuMesh.visible = false; window.skyblink.walkthrough?.open(0); } }]],
    ['Time', [{ label: '◀', act: () => step(-1) }, { label: S.playing ? '⏸ Pause' : '▶ Play', on: S.playing, act: togglePlay }, { label: '▶', act: () => step(1) },
      { label: 'Slower', act: () => setSpeed(S.speed - 0.5) }, { label: `Faster (${S.speed})`, act: () => setSpeed(S.speed + 0.5) }]],
    ['Detector', ['auto', '1', '2', '3', '4', '5', '6'].map((v) => ({ label: v === 'auto' ? 'Auto' : 'D' + v, on: det === v, act: () => setSel('inDet', v) }))],
    ['FOV', [['15', '3′'], ['30', '6′'], ['60', '12′'], ['100', '20′']].map(([v, l]) => ({ label: l, on: half === v, act: () => setSel('inHalf', v) }))],
    ['Zoom', [{ label: 'Zoom +', act: () => vrZoomBy(1.6) }, { label: 'Zoom −', act: () => vrZoomBy(1 / 1.6) }, { label: `×${(S.vrZoom || 1).toFixed(1)} reset`, act: () => setVrZoom(1) },
      { label: 'Larger panel', act: () => { content.scale.multiplyScalar(1.25).clampScalar(0.4, 4); } }, { label: 'Smaller panel', act: () => { content.scale.multiplyScalar(0.8).clampScalar(0.4, 4); } },
      { label: 'Lines on top', on: S.coneOver, act: () => setConeOver(!S.coneOver) }]],
    ['Detect', [{ label: S.detect ? '✓ Detection on' : 'Detection off', on: S.detect, act: () => { S.detect = !S.detect; $('cbDetect').checked = S.detect; render(); } },
      { label: 'Only changes', on: S.detDiff, act: () => { S.detDiff = !S.detDiff; $('cbDetDiff').checked = S.detDiff; render(); } },
      { label: `Threshold ${S.sigma}σ −`, act: () => { S.sigma = Math.max(3, S.sigma - 0.5); $('inSigma').value = S.sigma; $('sigLabel').textContent = S.sigma; render(); } },
      { label: '+', act: () => { S.sigma = Math.min(10, S.sigma + 0.5); $('inSigma').value = S.sigma; $('sigLabel').textContent = S.sigma; render(); } }]],
    ['Saved', [{ label: '⭐ Save this point', act: saveCurrent }, ...S.saved.slice(0, 4).map((e) => ({ label: e.label, on: S.cur && Math.abs(S.cur.ra - e.ra) < 1e-4, act: () => gotoSaved(e) }))]],
    ['Marks', [{ label: 'Track the target', act: () => trackTarget() }, { label: 'Clear', act: () => { S.marks = []; rebuild(); } },
      { label: 'Dome −', act: () => setDome(domeSlice - 6) }, { label: 'Dome +', act: () => setDome(domeSlice + 6) }]],
  ];
}
function drawMenu() {
  const c = MENU.getContext('2d'), W = MENU.width, H = MENU.height;
  c.clearRect(0, 0, W, H); c.fillStyle = 'rgba(12,18,40,.96)'; c.beginPath(); c.roundRect(0, 0, W, H, 34); c.fill();
  c.strokeStyle = '#2c3a6b'; c.lineWidth = 4; c.stroke();
  c.direction = 'ltr'; c.textAlign = 'left'; c.textBaseline = 'middle';
  c.fillStyle = '#e8ecff'; c.font = 'bold 44px system-ui, sans-serif'; c.fillText('Settings', 36, 52);
  c.fillStyle = '#9fb0e8'; c.font = '26px system-ui, sans-serif'; c.fillText('Point (button lights up), pull trigger · A/B or X/Y closes', 240, 54);
  menuBtns = [{ x: W - 100, y: 22, w: 70, h: 60, label: '✕', act: () => { menuMesh.visible = false; } }];
  let y = 112;
  for (const [title, btns] of menuRows()) {
    c.fillStyle = '#9fb0e8'; c.font = '30px system-ui, sans-serif'; c.textAlign = 'left'; c.fillText(title, 36, y + 34);
    const x0 = 210, x1 = W - 30, gap = 10, bw = (x1 - x0 - gap * (btns.length - 1)) / btns.length;
    btns.forEach((b, i) => menuBtns.push({ ...b, x: x0 + i * (bw + gap), y, w: bw, h: 68 }));
    y += 98;
  }
  menuBtns.forEach((b, bi) => {
    const hov = bi === menuHover;
    c.fillStyle = hov ? '#f2c46d' : b.on ? '#5b74e0' : '#2a3a7a'; c.beginPath(); c.roundRect(b.x, b.y, b.w, b.h, 14); c.fill();
    if (hov) { c.strokeStyle = '#ffffff'; c.lineWidth = 4; c.stroke(); }
    c.fillStyle = '#fff'; c.textAlign = 'center'; let fs = 30; do { c.font = `${hov ? '700 ' : ''}${fs}px system-ui, sans-serif`; fs -= 2; } while (fs > 14 && c.measureText(b.label).width > b.w - 14);
    c.fillStyle = hov ? '#16203F' : '#fff'; c.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 2);
  });
  // the bottom line says what the pointed button will do, so nothing has to be guessed
  const hb = menuBtns[menuHover];
  c.fillStyle = 'rgba(242,196,109,.12)'; c.fillRect(30, H - 92, W - 60, 64);
  c.direction = 'ltr'; c.textAlign = 'left'; c.font = '30px system-ui, sans-serif'; c.fillStyle = hb ? '#f2c46d' : '#9fb0e8';
  c.fillText(hb ? `Trigger now: ${hb.label}${hb.hint ? ' · ' + hb.hint : ''}` : 'Point the ray at a button: it lights up gold', 50, H - 60);
  menuTex.needsUpdate = true;
}
function toggleMenu() {
  if (menuMesh.visible) { menuMesh.visible = false; return; }
  const cam = renderer.xr.getCamera(), p = new THREE.Vector3(), q = new THREE.Quaternion();
  cam.getWorldPosition(p); cam.getWorldQuaternion(q);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q); fwd.y = 0; fwd.normalize();
  menuMesh.position.copy(p).addScaledVector(fwd, 1.25); menuMesh.position.y = p.y - 0.15;
  menuMesh.lookAt(p.x, menuMesh.position.y, p.z);
  menuHover = -1; drawMenu(); menuMesh.visible = true;
}
function menuClick(uv) {
  const x = uv.x * MENU.width, y = (1 - uv.y) * MENU.height;
  const b = menuBtns.find((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
  if (b) { b.act(); menuHover = -1; setTimeout(() => { if (menuMesh.visible) drawMenu(); }, 60); }
}
function setSpeed(v) { S.speed = Math.max(0.5, Math.min(10, v)); $('inSpeed').value = S.speed; }
function setDome(v) { v = (v + 102) % 102; $('inDome').value = v; loadDome(v); }
function toggleMotion(on = !S.showMotion) {
  S.showMotion = on; $('btnMotion').classList.toggle('on', on);
  if (on && S.mode !== 'diff') setMode('diff');
  S.motion = on ? measureMotion() : null; render();
}

// ------------------------------------------------------------------ saved points and marks (kept in this browser)
const SAVE_KEY = 'skyblink.saved.v1';
try { S.saved = JSON.parse(localStorage.getItem(SAVE_KEY) || '[]'); } catch (e) { S.saved = []; }
let savedLabels = [];
function persistSaved() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(S.saved)); } catch (e) { /* storage off: list lives until reload */ } }
function saveCurrent() {
  const t = S.cur; if (!t) return;
  const e = { id: Date.now().toString(36), key: t.key || null, label: t.key ? (PRESETS.find((p) => p.key === t.key)?.label || t.name) : t.name.replace(/^RA /, 'RA '),
    name: t.name, ra: t.ra, dec: t.dec, pm: t.pm || null, det: $('inDet').value, half: $('inHalf').value, mode: S.mode,
    marks: S.marks.map((m) => ({ x: m.x, y: m.y, view: m.view })), date: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  const same = S.saved.findIndex((q) => Math.abs(q.ra - e.ra) < 1e-4 && Math.abs(q.dec - e.dec) < 1e-4);
  if (same >= 0) { e.label = S.saved[same].label; S.saved[same] = e; } else S.saved.unshift(e);
  S.saved = S.saved.slice(0, 30); persistSaved(); renderSaved();
  setStatus(`Saved: ${e.label}${e.marks.length ? ` with ${e.marks.length} marks` : ''}. Jump back to it from the "Saved points" list.`, 'ok');
}
function gotoSaved(e) {
  $('inDet').value = e.det || 'auto'; $('inHalf').value = e.half || '30';
  S.pendingMarks = { ra: e.ra, dec: e.dec, marks: e.marks || [] };
  if (e.mode) setMode(e.mode);
  loadTarget(e.key ? PRESETS.find((p) => p.key === e.key) : { key: null, name: e.name, ra: e.ra, dec: e.dec, pm: e.pm });
}
function restorePendingMarks() {
  const P = S.pendingMarks, t = S.cur; if (!P || !t || Math.abs(P.ra - t.ra) > 1e-4 || Math.abs(P.dec - t.dec) > 1e-4 || !S.views.length) return;
  const n = S.bundle.grid.n; S.marks = [];
  for (const m of P.marks) if (m.x >= 0 && m.y >= 0 && m.x < n && m.y < n) { const k = { x: m.x, y: m.y, view: Math.min(m.view || 0, S.views.length - 1), color: TRACK_COLORS[S.marks.length % TRACK_COLORS.length] }; trackMark(k); S.marks.push(k); }
  if (S.bundle.source === 'live') S.pendingMarks = null;     // keep them for the live result that replaces the sample
  if (S.showMotion) S.motion = measureMotion(); render();
}
function renderSaved() {
  $('savedList').innerHTML = S.saved.length ? S.saved.map((e) => `<span class="chip"><button data-go="${e.id}" title="${e.date}">⭐ ${e.label}${e.marks?.length ? ` (${e.marks.length})` : ''}</button><button data-del="${e.id}" class="x" aria-label="Delete">×</button></span>`).join('')
    : '<span class="small">None yet. "Save point" stores the place, the settings and the marks.</span>';
  for (const l of savedLabels) { sky.remove(l); l.material.map.dispose(); l.material.dispose(); }
  savedLabels = S.saved.filter((e) => !e.key).map((e) => { const s = labelSprite('⭐ ' + e.label, '#8b93ff'); s.position.copy(dirOf(e.ra, e.dec).multiplyScalar(R * 0.955)); sky.add(s); return s; });
  drawLocator();
}

// ------------------------------------------------------------------ locator: a small all-sky map that always shows where you are looking
const LOC = $('locator'), locCtx = LOC.getContext('2d');
function drawLocator() {
  const W = LOC.width, H = LOC.height; locCtx.clearRect(0, 0, W, H);
  locCtx.save(); locCtx.scale(-1, 1); locCtx.drawImage(domeCanvas, -W, 0, W, H); locCtx.restore();     // RA grows to the left, like a sky chart
  const X = (ra) => W * (1 - (((ra - 180 + 360) % 360) / 360)), Y = (dec) => (90 - dec) / 180 * H;
  locCtx.fillStyle = 'rgba(5,7,15,.25)'; locCtx.fillRect(0, 0, W, H);
  locCtx.strokeStyle = 'rgba(120,140,220,.35)'; locCtx.lineWidth = 1;
  for (let ra = 0; ra < 360; ra += 60) { locCtx.beginPath(); locCtx.moveTo(X(ra), 0); locCtx.lineTo(X(ra), H); locCtx.stroke(); }
  for (let d = -60; d <= 60; d += 30) { locCtx.beginPath(); locCtx.moveTo(0, Y(d)); locCtx.lineTo(W, Y(d)); locCtx.stroke(); }
  for (const p of PRESETS) { locCtx.fillStyle = '#f2c46d'; locCtx.fillRect(X(p.ra) - 2, Y(p.dec) - 2, 4, 4); }
  for (const e of S.saved) { locCtx.fillStyle = '#8b93ff'; locCtx.fillRect(X(e.ra) - 2, Y(e.dec) - 2, 4, 4); }
  const t = S.cur; if (!t) return;
  const x = X(t.ra), y = Y(t.dec);
  locCtx.strokeStyle = '#f2c46d'; locCtx.lineWidth = 2; locCtx.beginPath(); locCtx.arc(x, y, 7, 0, 2 * Math.PI);
  locCtx.moveTo(x - 13, y); locCtx.lineTo(x - 8, y); locCtx.moveTo(x + 8, y); locCtx.lineTo(x + 13, y); locCtx.moveTo(x, y - 13); locCtx.lineTo(x, y - 8); locCtx.moveTo(x, y + 8); locCtx.lineTo(x, y + 13); locCtx.stroke();
  $('locLabel').textContent = `${t.key ? PRESETS.find((p) => p.key === t.key)?.label + ' · ' : ''}RA ${t.ra.toFixed(4)}°  Dec ${t.dec >= 0 ? '+' : ''}${t.dec.toFixed(4)}°`;
}
LOC.addEventListener('click', () => setUi('dome'));

// ------------------------------------------------------------------ controls
function step(d) { if (!S.views.length) return; S.idx = (S.idx + d + S.views.length) % S.views.length; render(); }
function togglePlay() { S.playing = !S.playing; $('btnPlay').textContent = S.playing ? '⏸ Pause' : '▶ Play'; drawHud(); }
function setMode(m) { S.mode = m; document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === m)); writeUrl(); $('legend').innerHTML = m === 'diff' ? '<i style="background:#ff4040"></i> brighter since the first image <i style="background:#4040ff"></i> fainter <i style="background:#464a60"></i> slate = no data' : '<i style="background:#2e344a"></i> slate = no data (saturated core, dead pixel). One stretch for all images, north up, east left.'; render(); }
function zoom(f) { V.anim = null; V.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, V.fov * f)); }

$('presets').innerHTML = PRESETS.map((p) => `<button data-key="${p.key}">${p.label}</button>`).join('');
$('presets').addEventListener('click', (e) => { const k = e.target.dataset?.key; if (k) { $('inName').value = ''; loadTarget(PRESETS.find((p) => p.key === k)); } });
$('btnLoad').onclick = loadCustom;
$('inName').oninput = () => { S.useName = true; };
$('inRa').oninput = $('inDec').oninput = () => { S.useName = false; };
for (const id of ['inName', 'inRa', 'inDec']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') loadCustom(); });
for (const id of ['inDet', 'inHalf', 'inFrames', 'inStack', 'inView', 'cbLive']) $(id).onchange = reload;
$('btnDeep').onclick = runDeep;
$('detBar')?.addEventListener('click', (e) => { const d = e.target.dataset?.det; if (!d) return; $('inDet').value = d; updDetBar(); reload(); });
$('btnPlay').onclick = togglePlay;
$('btnPrev').onclick = () => step(-1);
$('btnNext').onclick = () => step(1);
$('inSpeed').oninput = (e) => { S.speed = +e.target.value; };
$('inTime').oninput = (e) => { S.idx = +e.target.value; render(); };
$('modeSeg').addEventListener('click', (e) => { if (e.target.dataset?.v) setMode(e.target.dataset.v); });
$('chartSeg').addEventListener('click', (e) => { const v = e.target.dataset?.v; if (!v) return; S.chart = v; document.querySelectorAll('#chartSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); render(); });
$('inStretch').onchange = (e) => { S.stretch = e.target.value; render(); };
$('inWhite').oninput = (e) => { S.white = +e.target.value / 1000; rebuild(); };
$('inCmap').onchange = (e) => { S.cmap = e.target.value; render(); };
$('inSmooth').oninput = (e) => { S.smooth = +e.target.value; $('smoothLabel').textContent = S.smooth; rebuild(); };
$('cbPred').onchange = (e) => { S.showPred = e.target.checked; render(); };
$('cbGrid').onchange = (e) => { S.grid = e.target.checked; render(); };
if ($('cbCoords')) $('cbCoords').onchange = (e) => { S.coords = e.target.checked; draw2d(); };
new MutationObserver(() => { Z.fitted = false; draw2d(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
$('cbDetect').onchange = (e) => { S.detect = e.target.checked; render(); };
$('cbDetDiff').onchange = (e) => { S.detDiff = e.target.checked; render(); };
$('inMinSize').onchange = (e) => { S.minSize = +e.target.value; render(); };
$('inSigma').oninput = (e) => { S.sigma = +e.target.value; $('sigLabel').textContent = S.sigma; render(); };
const reliefUi = () => { S.relief = +$('inRelief').value; S.tilt = +$('inTilt').value; if (S.bundle) { placeCutout(); render(); } };
$('inRelief').oninput = reliefUi; $('inTilt').oninput = reliefUi;
$('uiSeg').addEventListener('click', (e) => { if (e.target.dataset?.v) setUi(e.target.dataset.v); });
$('btnMotion').onclick = () => toggleMotion();
$('btnSave').onclick = saveCurrent;
if ($('btnForget')) $('btnForget').onclick = forgetPins;
if ($('detAll')) $('detAll').onclick = () => { const on = strip.toggle(); $('detAll').classList.toggle('on', on); };
$('cbConeOver').onchange = (e) => setConeOver(e.target.checked);
$('inCtx').onchange = reload;
$('savedList').addEventListener('click', (e) => {
  const go = e.target.dataset?.go, del = e.target.dataset?.del;
  if (go) gotoSaved(S.saved.find((q) => q.id === go));
  if (del) { S.saved = S.saved.filter((q) => q.id !== del); persistSaved(); renderSaved(); }
});
$('btnZoomIn').onclick = () => (S.ui === '2d' ? zoom2d(1.33) : zoom(0.75)); $('btnZoomOut').onclick = () => (S.ui === '2d' ? zoom2d(0.75) : zoom(1.33));
$('btnZoomReset').onclick = () => (S.ui === '2d' ? fit2d() : flyToTarget());
$('btnFly').onclick = () => (S.ui === '2d' ? fit2d() : flyToTarget());
$('btnAllSky').onclick = () => { if (S.ui !== 'dome') setUi('dome'); setTimeout(() => flyTo(V.ra, V.dec, 80), 0); };
$('inDome').onchange = (e) => loadDome(+e.target.value);
$('inDome').oninput = (e) => { $('domeLabel').textContent = `${HIPS_LAM[+e.target.value].toFixed(2)} µm (${+e.target.value + 1}/102)`; };
$('btnClear').onclick = () => { S.marks = []; render(); };
const trackTarget = () => { if (!S.views.length) return; const p = predictedAt(S.idx); addMark(p.x, p.y); };
$('btnTrackTarget').onclick = trackTarget;
addEventListener('keydown', (e) => {
  const ae = document.activeElement, tag = ae?.tagName;
  if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && ['text', 'number'].includes(ae.type)) || (tag === 'BUTTON' && e.key === ' ')) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === '+' || e.key === '=') (S.ui === '2d' ? zoom2d(1.33) : zoom(0.75));
  else if (e.key === '-') (S.ui === '2d' ? zoom2d(0.75) : zoom(1.33));
  else if (e.key.toLowerCase() === 'd') setMode(S.mode === 'diff' ? 'blink' : 'diff');
  else if (e.key.toLowerCase() === 'm') trackTarget();
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); Z.fitted = false; draw2d(); });

// VR button
const vrHint = () => { $('vrSlot').innerHTML = '<span class="small">🥽 VR: open this page in the Meta Quest browser</span>'; };
if ('xr' in navigator) {
  // only show the button where an immersive VR session can really start (a Quest, or a desktop with a headset);
  // elsewhere three.js's button would just say "VR NOT SUPPORTED"
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) { vrHint(); return; }
    const btn = VRButton.createButton(renderer);
    Object.assign(btn.style, { position: 'static', left: 'auto', bottom: 'auto', width: 'auto', padding: '7px 14px', fontSize: '13px', borderRadius: '999px',
      border: '1px solid rgba(139,147,255,.5)', background: 'rgba(139,147,255,.16)', color: '#e6e9f5', opacity: '1', font: 'inherit', cursor: 'pointer' });
    $('vrSlot').appendChild(btn);
  }).catch(vrHint);
} else $('vrSlot').textContent = 'VR: open https://spherex-blink.github.io/ in the Quest browser';

const vrLoader = createVrLoader({ THREE, scene, loader, busy });     // loading card + "Loading D2 …" inside the headset (app-vr.js)
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.1, clock.getDelta());
  pollSticks(dt); if (renderer.xr.isPresenting) { stepVrTurn(dt); stepVrZoom(dt); }
  vrLoader.update(renderer.xr.isPresenting, renderer.xr.getCamera());
  const inXR = renderer.xr.isPresenting;
  if (!inXR) applyView(dt);
  scaleSprites(inXR); updateCone(inXR); updateReticle(); sync3dTiles(inXR); updatePins(inXR);
  if (S.playing && S.views.length > 1 && S.mode !== 'stack') { S.acc += dt; if (S.acc >= 1 / S.speed + (S.idx === S.views.length - 1 ? 0.65 : 0)) { S.acc = 0; step(1); advancePins(); } }
  updPlaybar(inXR);
  if (inXR || S.ui !== '2d') { if (domeReady) hips.update(inXR ? renderer.xr.getCamera() : camera, { fovDeg: V.fov, inXR, maxTiles: inXR ? (vrLocalSky() ? 200 : 90) : V.fov > 20 ? 340 : 60, order: inXR ? (vrLocalSky() ? 3 : undefined) : V.fov > 20 ? 3 : V.fov > 4.5 ? 4 : undefined }); renderer.render(scene, camera); }
  else if (needs2dAnim()) draw2d();     // the 2D view is a plain canvas: no need to draw the 3D scene
});

window.skyblink = { hips, tiles, loader, openExplore, snapTurn, cycleTarget, getHover: () => menuHover, setVrZoom, vrWindow, vrTex, setConeOver, coneLines, magPlane, menuButtons: () => menuBtns, reticle, THREE, scene, camera, renderer, sky, dome, ctrls, content, vrPlane, saveCurrent, gotoSaved, S, V, Z, PRESETS, loadTarget, setUi, toggleMenu, drawMenu, menuRows, measureMotion, menuMesh, updateCone, coneLines };   // for debugging from the browser console
window.skyblink.vrLoader = vrLoader; window.skyblink.vrZoomBy = vrZoomBy; window.skyblink.vrPointerOnPanel = vrPointerOnPanel;

// Walkthrough mode (walkthrough.js, Daniel 15.11): shows prepared results with no waiting, through these few entry points only
Object.assign(window.skyblink, { setResult, onBundleLoaded, setMode, toggleMotion, setMoverPath, clearMoverPath, render, setStatus, flyTo, busy, drawLocator,
  cancelLoad: () => { if (ctrl) ctrl.abort(); ctrl = null; loadSeq++; } });

// start: URL state (T3), else the first preset
{
  const set = (id, v) => { if (v != null && [...$(id).options].some((o) => o.value === String(v))) $(id).value = v; };
  set('inDet', QS.get('det')); set('inHalf', QS.get('half')); set('inFrames', QS.get('frames')); set('inStack', QS.get('stack')); set('inView', QS.get('view'));
  if (QS.get('offline') === '1') $('cbLive').checked = false;
  const ra = parseFloat(QS.get('ra')), dec = parseFloat(QS.get('dec'));
  const chosen = QS.get('explore') || (finite(ra) && finite(dec)) || PRESETS.some((p) => p.key === QS.get('target'));
  // the bare address opens on the whole sky (the dome, zoomed out over the Milky Way), nothing selected yet
  setUi(QS.get('ui') || (chosen ? '2d' : 'dome'));
  setMode(['blink', 'diff', 'stack'].includes(QS.get('mode')) ? QS.get('mode') : 'blink');
  drawHud(); loadDome(17); renderSaved(); fillExplore();
  setTimeout(() => getIndex().catch(() => {}), 2500);     // warm up the sky index while the overview shows, so the first click is faster
  if (QS.get('explore')) { /* fillExplore() opens it */ }
  else if (finite(ra) && finite(dec)) loadTarget({ key: null, name: `RA ${ra.toFixed(4)}° Dec ${dec.toFixed(4)}°`, ra, dec, pm: null });
  else if (chosen) loadTarget(PRESETS.find((p) => p.key === QS.get('target')));
  else {
    V.ra = 300; V.dec = 28; V.fov = 95;      // the Milky Way in Cygnus/Aquila, away from the target labels
    const msg = 'Drag to look around, scroll to zoom. Click anywhere on the sky to load SPHEREx images of that spot, or open ☰ Controls for targets and comets.';
    setStatus(msg);
    // the welcome card ("Watch the 1-minute tour" / "Jump in") and the hint after it are in walkthrough.js
  }
}
