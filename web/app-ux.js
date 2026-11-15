// app-ux.js: three UX helpers for the SPHEREx Blink app (kept out of app.js so the two sides can edit in parallel).
//   1. Detector awareness: a big "D2 · 1.43 µm" label on every frame, a "Loading D2 (1.1–1.6 µm)…" overlay that greys the old image
//      while a reload is pending, and the "All 6 detectors" strip (one thumbnail per detector, fetched on demand).
//   2. A comet's path on the sky: the thin dome line and the "path on the sky" inset for the 2D view.
// Only plain DOM / canvas / three.js here, no data-layer internals. Written with Claude Code.
import * as THREE from 'three';

const D2R = Math.PI / 180;
export const DET_RANGE = { 1: [0.75, 1.1], 2: [1.1, 1.6], 3: [1.6, 2.4], 4: [2.4, 3.8], 5: [3.8, 4.4], 6: [4.4, 5.0] };   // calib/channels.json
const num = (x, d = 2) => (Number.isFinite(x) ? (+x).toFixed(d) : '?');
export const detName = (d) => (typeof d === 'number' ? 'D' + d : d == null ? '?' : String(d));
export const detRangeText = (d) => (DET_RANGE[d] ? `${DET_RANGE[d][0]}–${DET_RANGE[d][1]} µm` : '');

const CSS = `
#view2d.ux-dim{filter:grayscale(1) brightness(.42);transition:filter .25s}
#detBusy{position:fixed;left:50%;top:76px;transform:translateX(-50%);z-index:8;min-width:260px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:12px 18px 12px;
  border-radius:14px;background:var(--panel,rgba(14,18,32,.86));border:1px solid var(--accent,#8b93ff);box-shadow:0 10px 36px rgba(0,0,0,.5);
  backdrop-filter:blur(8px);color:var(--text,#e6e9f5);font:600 18px/1.3 system-ui,sans-serif;text-align:center;pointer-events:none}
#detBusy[hidden]{display:none}
#detBusy small{display:block;margin-top:3px;font:12px/1.3 system-ui,sans-serif;color:var(--muted,#8e98b8)}
#detBusy .bar{height:4px;margin-top:9px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden}
#detBusy .bar i{display:block;height:100%;width:0;background:var(--gold,#f2c46d);transition:width .2s}
#detBusy .bar.ind i{width:35%;animation:uxind 1.1s ease-in-out infinite alternate}
@keyframes uxind{from{margin-left:0}to{margin-left:65%}}
#detStrip{position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:8;display:flex;flex-direction:column;gap:6px;padding:10px 12px 10px;
  max-width:calc(100vw - 24px);box-sizing:border-box;border-radius:14px;background:var(--panel,rgba(14,18,32,.9));border:1px solid var(--line-strong,rgba(148,163,255,.28));
  box-shadow:0 14px 40px rgba(0,0,0,.5);backdrop-filter:blur(8px);color:var(--text,#e6e9f5);font:12px system-ui,sans-serif}
#detStrip[hidden]{display:none}
#detStrip .ds-head{display:flex;justify-content:space-between;align-items:center;gap:12px;color:var(--muted,#8e98b8)}
#detStrip .ds-head button{background:transparent;border:0;color:var(--text,#e6e9f5);cursor:pointer;font-size:15px;padding:0 4px}
#detStrip .ds-row{display:flex;gap:8px;overflow-x:auto}
#detStrip .ds-cell{flex:0 0 auto;width:132px;cursor:pointer;border-radius:10px;padding:4px;border:1px solid transparent;background:rgba(255,255,255,.03);text-align:center}
#detStrip .ds-cell:hover{background:var(--accent-soft,rgba(139,147,255,.16))}
#detStrip .ds-cell.on{border-color:var(--gold,#f2c46d)}
#detStrip canvas{display:block;width:122px;height:122px;border-radius:7px;background:#0b0f1d;image-rendering:pixelated}
#detStrip .ds-cap{margin-top:4px;font-weight:600;font-size:13px;white-space:nowrap}
#detStrip .ds-cap small{display:block;font-weight:400;font-size:11px;color:var(--muted,#8e98b8)}
#pathInset{position:fixed;right:14px;bottom:64px;z-index:6;padding:6px;border-radius:12px;background:var(--panel,rgba(14,18,32,.86));border:1px solid var(--line,rgba(148,163,255,.14));
  color:var(--text,#e6e9f5);font:11px system-ui,sans-serif;pointer-events:none}
#pathInset[hidden]{display:none}
#pathInset canvas{display:block;width:230px;height:140px;border-radius:8px}
#pathInset div{margin-top:4px;text-align:center;color:var(--muted,#8e98b8)}
@media(max-width:700px){#detStrip{bottom:112px}#detStrip .ds-cell{width:104px}#detStrip canvas{width:94px;height:94px}#pathInset{bottom:112px}#pathInset canvas{width:170px;height:104px}}
body.inxr #detBusy,body.inxr #detStrip,body.inxr #pathInset{display:none}
`;
let cssDone = false;
function addCss() { if (cssDone) return; cssDone = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }
const mk = (tag, id, parent = document.body) => { let e = id && document.getElementById(id); if (!e) { e = document.createElement(tag); if (id) e.id = id; parent.appendChild(e); } return e; };

// ------------------------------------------------------------------ 1a. the label on every frame
/** Draw "D2 · 1.43 µm" large in the bottom-right corner of a square canvas (W px). v = a view {det, lam, lamMin, lamMax, nStack}. */
export function drawFrameLabel(ctx, W, v) {
  if (!v) return;
  const rg = DET_RANGE[v.det];     // wavelength unknown (e.g. pre-made fly-by frames): the detector's band instead of "?"
  const big = `${detName(v.det)} · ${Number.isFinite(v.lam) ? num(v.lam, 2) + ' µm' : rg ? `${rg[0]}–${rg[1]} µm` : '?'}`;
  const sub = v.nStack > 1 && Number.isFinite(v.lamMin) ? `stack ×${v.nStack} · mean, range ${num(v.lamMin, 2)}–${num(v.lamMax, 2)} µm` : '';
  ctx.save(); ctx.direction = 'ltr'; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  const fs = Math.round(W / 15), fs2 = Math.round(W / 36);
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  const w1 = ctx.measureText(big).width; ctx.font = `${fs2}px system-ui, sans-serif`;
  const w = Math.max(w1, sub ? ctx.measureText(sub).width : 0) + W * 0.04, h = fs * 1.35 + (sub ? fs2 * 1.5 : 0), x1 = W - W * 0.02, y1 = W - W * 0.02;
  ctx.fillStyle = 'rgba(5,7,15,.68)'; ctx.beginPath(); ctx.roundRect(x1 - w, y1 - h, w, h, W * 0.015); ctx.fill();
  ctx.fillStyle = '#f2c46d'; ctx.font = `700 ${fs}px system-ui, sans-serif`; ctx.fillText(big, x1 - W * 0.02, y1 - h + fs * 1.05);
  if (sub) { ctx.fillStyle = '#c9d0ee'; ctx.font = `${fs2}px system-ui, sans-serif`; ctx.fillText(sub, x1 - W * 0.02, y1 - W * 0.012); }
  ctx.restore();
}

// ------------------------------------------------------------------ 1b. "loading D2…" overlay + dimming of the old image
let busyEl = null, dimFn = null;
/** setDim(on): app callback that greys the dome's magnified image (the 2D canvas is dimmed here). */
export function initUx({ setDim } = {}) { addCss(); dimFn = setDim || null; }
const busyState = { on: false };
export const busy = {
  /** det: 1..6 | 'auto'; name: target name; dim: grey out the image that is on screen now */
  begin(det, name, dim = true) {
    addCss(); busyEl = busyEl || mk('div', 'detBusy'); busyState.on = true; busyState.settled = false;
    const d = DET_RANGE[det] ? `${detName(det)} (${detRangeText(det)})` : 'the best detector';
    busyEl.innerHTML = `<div>Loading ${d}…</div><small>${name ? name + ' · ' : ''}asking NASA for the images</small><div class="bar ind"><i></i></div>`;
    busyEl.hidden = false;
    if (dim) { document.getElementById('view2d')?.classList.add('ux-dim'); dimFn?.(true); }
  },
  progress(done, total) {
    if (!busyState.on || !busyEl) return;
    const sm = busyEl.querySelector('small'), bar = busyEl.querySelector('.bar'), fill = busyEl.querySelector('.bar i');
    if (sm) sm.textContent = `downloading from NASA · ${Math.min(total, done + 1)} / ${total}`;
    if (bar && total) { bar.classList.remove('ind'); fill.style.width = Math.round(100 * (done + 1) / total) + '%'; }
  },
  settle() {      // the first image of the new detector is on screen: stop dimming, keep the label and progress while the rest downloads
    if (!busyState.on || !busyEl) return;
    document.getElementById('view2d')?.classList.remove('ux-dim'); dimFn?.(false);
    const h = busyEl.firstElementChild; if (h && !busyState.settled) { h.textContent = h.textContent.replace(/^Loading/, 'Loading the video,'); busyState.settled = true; }
  },
  end() {
    busyState.on = false; busyState.settled = false; if (busyEl) busyEl.hidden = true;
    document.getElementById('view2d')?.classList.remove('ux-dim'); dimFn?.(false);
  },
  get on() { return busyState.on; },
};

// ------------------------------------------------------------------ 1c. the "All 6 detectors" strip
/** The six-thumbnail strip. cfg: {getIndex(), getBlink(), request() -> {ra, dec, pm, name, half, detector} | null,
 *  paint(canvas, data, n) (draw one thumbnail with the app's stretch), onPick(det), current() -> selected detector} */
export function createDetStrip(cfg) {
  addCss();
  const el = mk('div', 'detStrip'); el.hidden = true;
  el.innerHTML = '<div class="ds-head"><span>One image per detector at this point (click one to switch)</span><button type="button" aria-label="Close" title="Close">✕</button></div><div class="ds-row"></div>';
  const row = el.querySelector('.ds-row'), cells = [];
  for (let d = 1; d <= 6; d++) {
    const c = document.createElement('div'); c.className = 'ds-cell'; c.dataset.det = d;
    c.innerHTML = `<canvas width="61" height="61"></canvas><div class="ds-cap">D${d}<small>${detRangeText(d)}</small></div>`;
    row.appendChild(c); cells.push(c);
  }
  const cache = new Map();      // key -> {data, n, lam, det, mjd} | {none: true}
  let ctrl = null, shown = null;
  const keyOf = (r, d) => [r.ra.toFixed(5), r.dec.toFixed(5), d, r.half, r.pm ? r.pm.join(',') : ''].join('|');
  const cap = (c, d, txt) => { c.querySelector('.ds-cap').innerHTML = `D${d}<small>${txt}</small>`; };
  function paintCell(d, e) {
    const c = cells[d - 1], cv = c.querySelector('canvas');
    if (e?.data) { cfg.paint(cv, e.data, e.n); cap(c, d, `${num(e.lam, 2)} µm`); c.title = `D${d} · ${num(e.lam, 3)} µm · ${e.date || ''}`; c.style.opacity = 1; }
    else if (e?.none) { const x = cv.getContext('2d'); cv.width = cv.height = 61; x.fillStyle = '#0b0f1d'; x.fillRect(0, 0, 61, 61); x.fillStyle = '#8e98b8'; x.font = '9px system-ui'; x.textAlign = 'center'; x.fillText('no image here', 30, 33); cap(c, d, detRangeText(d)); c.style.opacity = .6; }
    else { const x = cv.getContext('2d'); cv.width = cv.height = 61; x.fillStyle = '#0b0f1d'; x.fillRect(0, 0, 61, 61); x.fillStyle = '#8e98b8'; x.font = '10px system-ui'; x.textAlign = 'center'; x.fillText('loading…', 30, 33); cap(c, d, detRangeText(d)); c.style.opacity = 1; }
  }
  function mark() { const cur = String(cfg.current?.()); cells.forEach((c) => c.classList.toggle('on', c.dataset.det === cur)); }
  async function one(r, d, parent) {
    const k = keyOf(r, d); if (cache.has(k)) return cache.get(k);
    const sub = new AbortController(); const link = () => sub.abort(); parent.addEventListener('abort', link);
    let first = null;
    try {
      const index = await cfg.getIndex();
      await cfg.getBlink(index, { ra: r.ra, dec: r.dec, pm: r.pm || null, name: r.name, detector: d, frames: 'ends', stack: 4, half: r.half, signal: sub.signal,
        onFrame: (f) => { if (!first) { first = f; sub.abort(); } } });
    } catch (e) { if (!first) { if (parent.aborted) throw e; if (e.name === 'AbortError') throw e; cache.set(k, { none: true }); return cache.get(k); } }
    finally { parent.removeEventListener('abort', link); }
    if (!first) { cache.set(k, { none: true }); return cache.get(k); }
    const e = { data: first.data, n: first.width, lam: first.lambda_um, det: d, mjd: first.mjd, date: first.date };
    cache.set(k, e); return e;
  }
  function refresh() {
    const r = cfg.request?.(); if (!r || el.hidden) return;
    mark(); if (ctrl) ctrl.abort(); ctrl = new AbortController(); const sig = ctrl.signal; shown = r;
    for (let d = 1; d <= 6; d++) { const e = cache.get(keyOf(r, d)); paintCell(d, e); }
    for (let d = 1; d <= 6; d++) one(r, d, sig).then((e) => { if (!sig.aborted) paintCell(d, e); }).catch(() => {});
  }
  row.addEventListener('click', (e) => { const c = e.target.closest('.ds-cell'); if (c) { cfg.onPick(+c.dataset.det); mark(); } });
  el.querySelector('.ds-head button').onclick = () => api.close();
  const api = {
    get open() { return !el.hidden; },
    toggle() { return el.hidden ? api.show() : api.close(); },
    show() { el.hidden = false; refresh(); return true; },
    close() { el.hidden = true; if (ctrl) ctrl.abort(); return false; },
    /** call when the point or the current detector changed while the strip is open */
    sync() { if (el.hidden) return; const r = cfg.request?.(); if (r && shown && keyOf(r, 1) === keyOf(shown, 1)) mark(); else refresh(); },
  };
  return api;
}

// ------------------------------------------------------------------ 2. a comet's path on the sky
/** A thin line on the dome through every exposure's position. path: [{ra, dec}], dirOf(ra, dec) -> unit Vector3, r = dome radius for the line. */
export function makePathLine(path, dirOf, r, color = 0xf2c46d) {
  const pts = path.map((p) => dirOf(p.ra, p.dec).multiplyScalar(r));
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }));
  line.renderOrder = 4; line.frustumCulled = false; return line;
}
export function disposeObject(o) { if (!o) return; o.parent?.remove(o); o.geometry?.dispose(); o.material?.dispose(); }

/** Angular extent (degrees) of a path around its middle, for choosing a zoom. */
export function pathExtentDeg(path) {
  const ra0 = path[0].ra; const unwrap = (ra) => ((ra - ra0 + 540) % 360) - 180 + ra0;
  const xs = path.map((p) => unwrap(p.ra)), ys = path.map((p) => p.dec);
  const d0 = (Math.min(...ys) + Math.max(...ys)) / 2, x0 = (Math.min(...xs) + Math.max(...xs)) / 2;
  const w = (Math.max(...xs) - Math.min(...xs)) * Math.cos(d0 * D2R), h = Math.max(...ys) - Math.min(...ys);
  return { ra: ((x0 % 360) + 360) % 360, dec: d0, size: Math.max(w, h, 0.05) };
}

let insetEl = null;
/** The small "path on the sky" map for the 2D view. path [{ra, dec}], cur {ra, dec, date} or null (hides the inset when path is null). */
export function drawPathInset(path, cur, label = '') {
  addCss(); insetEl = insetEl || mk('div', 'pathInset');
  if (!path || path.length < 2) { insetEl.hidden = true; return; }
  if (!insetEl.firstChild) { insetEl.innerHTML = '<canvas width="460" height="280"></canvas><div></div>'; }
  insetEl.hidden = false;
  const cv = insetEl.querySelector('canvas'), c = cv.getContext('2d'), W = cv.width, H = cv.height;
  const ra0 = path[0].ra, un = (ra) => ((ra - ra0 + 540) % 360) - 180;
  const xs = path.map((p) => un(p.ra)), ys = path.map((p) => p.dec), dm = (Math.min(...ys) + Math.max(...ys)) / 2, k = Math.cos(dm * D2R);
  const X = path.map((_, i) => -xs[i] * k), Y = ys;                    // east to the left, north up
  const x0 = Math.min(...X), x1 = Math.max(...X), y0 = Math.min(...Y), y1 = Math.max(...Y), pad = 34;
  const s = Math.min((W - 2 * pad) / Math.max(1e-6, x1 - x0), (H - 2 * pad) / Math.max(1e-6, y1 - y0));
  const px = (x) => W / 2 + (x - (x0 + x1) / 2) * s, py = (y) => H / 2 - (y - (y0 + y1) / 2) * s;
  c.clearRect(0, 0, W, H); c.fillStyle = '#0b0f1d'; c.fillRect(0, 0, W, H);
  c.strokeStyle = 'rgba(242,196,109,.8)'; c.lineWidth = 2; c.beginPath(); path.forEach((p, i) => (i ? c.lineTo(px(X[i]), py(Y[i])) : c.moveTo(px(X[i]), py(Y[i])))); c.stroke();
  c.fillStyle = '#8e98b8'; c.font = '20px system-ui, sans-serif'; c.textAlign = 'left'; c.fillText('path on the sky', 10, 24);
  c.textAlign = 'right'; c.fillText('N↑  E←', W - 10, 24);
  const span = Math.max(x1 - x0, y1 - y0); c.textAlign = 'left'; c.fillText(`${span.toFixed(span < 1 ? 2 : 1)}° wide`, 10, H - 10);
  if (cur) {
    const cx = -un(cur.ra) * k, cxp = px(cx), cyp = py(cur.dec);
    c.strokeStyle = '#6ee7b7'; c.fillStyle = '#6ee7b7'; c.lineWidth = 3; c.beginPath(); c.arc(cxp, cyp, 9, 0, 2 * Math.PI); c.stroke();
    c.beginPath(); c.arc(cxp, cyp, 3.5, 0, 2 * Math.PI); c.fill();
  }
  insetEl.querySelector('div').textContent = cur ? `${label ? label + ' · ' : ''}RA ${cur.ra.toFixed(3)}°  Dec ${cur.dec >= 0 ? '+' : ''}${cur.dec.toFixed(3)}°${cur.date ? ' · ' + cur.date : ''}` : label;
}
export function hidePathInset() { if (insetEl) insetEl.hidden = true; }

// ------------------------------------------------------------------ 3. playbar: where the video is, where it starts and ends, when it loops
const PB_CSS = `
#playbar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:7;width:min(560px,calc(100vw - 32px));box-sizing:border-box;padding:7px 12px 6px;border-radius:12px;
  background:var(--panel,rgba(14,18,32,.86));border:1px solid var(--line-strong,rgba(148,163,255,.28));color:var(--text,#e6e9f5);font:12px system-ui,sans-serif;
  backdrop-filter:blur(8px);user-select:none;touch-action:none}
#playbar[hidden]{display:none}
#playbar canvas{display:block;width:100%;height:22px;cursor:pointer}
#playbar .pb-l{display:flex;justify-content:space-between;gap:8px;margin-top:3px;color:var(--muted,#8e98b8);white-space:nowrap}
#playbar .pb-l b{color:var(--text,#e6e9f5);font-weight:600}
#playbar .pb-loop{position:absolute;right:12px;top:-26px;padding:2px 10px;border-radius:999px;background:var(--gold,#f2c46d);color:#0b0e1a;font-weight:700;opacity:0;transition:opacity .5s;pointer-events:none}
#playbar .pb-loop.on{opacity:1;transition:none}
@media(min-width:701px){body:not(.uidome) #playbar{left:356px;right:14px;transform:none;width:auto;max-width:560px;margin:0 auto}}
@media(min-width:701px){body.menu-open:not(.uidome) #playbar{right:calc(var(--panel-w,360px) + 36px)}body.menu-open.uidome #playbar{left:calc((100vw - var(--panel-w,360px) - 24px) / 2);width:min(560px,calc(100vw - var(--panel-w,360px) - 64px))}}
@media(max-width:700px){#playbar{bottom:10px;font-size:11px}body:not(.uidome) #detBar{bottom:96px}}
body.inxr #playbar{display:none}
`;
/** The playbar. cfg: {seek(i)}. update({n, idx, frac, first, last, ticks[bool], playing, mover}) every animation frame. */
export function createPlaybar(cfg) {
  addCss(); const st = document.createElement('style'); st.textContent = PB_CSS; document.head.appendChild(st);
  const el = mk('div', 'playbar'); el.hidden = true;
  el.innerHTML = '<span class="pb-loop">↻ loop</span><canvas width="1120" height="44"></canvas><div class="pb-l"><span class="a"></span><span class="m"></span><span class="z"></span></div>';
  const cv = el.querySelector('canvas'), c = cv.getContext('2d'), A = el.querySelector('.a'), M = el.querySelector('.m'), Z = el.querySelector('.z'), loop = el.querySelector('.pb-loop');
  let last = { n: 0, idx: 0 }, prevIdx = -1, seeking = false, flashT = 0;
  const idxAt = (e) => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(last.n - 1, Math.floor((e.clientX - r.left) / r.width * last.n))); };
  cv.addEventListener('pointerdown', (e) => { seeking = true; cv.setPointerCapture(e.pointerId); cfg.seek(idxAt(e)); });
  cv.addEventListener('pointermove', (e) => { if (seeking) cfg.seek(idxAt(e)); });
  cv.addEventListener('pointerup', () => { seeking = false; });
  cv.addEventListener('pointercancel', () => { seeking = false; });
  return {
    update(s) {
      if (!s || s.n < 2) { el.hidden = true; prevIdx = -1; return; }
      el.hidden = false; last = s;
      if (s.playing && prevIdx === s.n - 1 && s.idx === 0 && !seeking) { loop.classList.add('on'); clearTimeout(flashT); flashT = setTimeout(() => loop.classList.remove('on'), 900); }
      prevIdx = s.idx;
      const W = cv.width, H = cv.height, n = s.n, seg = W / n, gap = n <= 24 ? Math.min(6, seg * 0.12) : 0;
      c.clearRect(0, 0, W, H);
      for (let i = 0; i < n; i++) {
        c.fillStyle = i < s.idx ? 'rgba(139,147,255,.55)' : 'rgba(255,255,255,.12)';
        c.fillRect(i * seg + gap / 2, 8, Math.max(1, seg - gap), H - 16);
        if (s.ticks?.[i] && n > 24) { c.fillStyle = 'rgba(230,233,245,.55)'; c.fillRect(i * seg, 2, 2, H - 4); }
      }
      c.fillStyle = '#f2c46d'; c.fillRect(s.idx * seg + gap / 2, 8, Math.max(2, seg - gap) * Math.max(0.04, Math.min(1, s.frac)), H - 16);     // progress inside the current frame
      c.strokeStyle = '#f2c46d'; c.lineWidth = 3; c.strokeRect(s.idx * seg + gap / 2 - 1, 5, Math.max(3, seg - gap) + 2, H - 10);
      A.innerHTML = '▸ <b>' + s.first + '</b>'; Z.innerHTML = '<b>' + s.last + '</b> ◂'; M.textContent = `${s.idx + 1} / ${n}${s.playing ? '' : ' · paused'}`;
    },
  };
}
