// ui-extras.js: self-contained UI helpers for the SPHEREx blink viewer (ES module, no dependencies).
//
// Exports:
//   createLoader(parent)                                   "flying through space" loading overlay
//   drawExtendedPreview(ctx, src, x, y, w, h, pad, t)       blurred mirrored "outpainting" around an image
//   invalidateExtendedPreview()                            drop the cached preview composite
//   drawHoverTile(ctx, x, y, w, h, t, label)               glowing outline for a not-yet-loaded tile
//   drawCoordGrid(ctx, opts)                               RA/Dec grid with labels and legend
//   nicePixelScaleBar(scaleArcsecPerPx, targetPx)          pick a "nice" scale-bar length
//
// Palette: space #070a14, indigo #8b93ff, gold #f2c46d, mint #6ee7b7, text #e6e9f5.

const C = {
  bg: '#070a14',
  indigo: '#8b93ff',
  gold: '#f2c46d',
  mint: '#6ee7b7',
  text: '#e6e9f5',
};

// Shared "nice" step set, in arcseconds: 1″ … 30°.
const NICE_ARCSEC = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
  3600, 7200, 18000, 36000, 54000, 108000];
// RA steps in seconds of time (1ˢ = 15″): the same ladder in time-friendly units.
const NICE_RA_TIME_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
  3600, 7200];

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/* ------------------------------------------------------------------------------------------ */
/* 1. Loader                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const LOADER_CSS = `
.ux-loader{position:fixed;top:50%;left:calc((100vw - var(--ux-panel-w, 0px)) / 2);
  transform:translate(-50%,-50%) scale(.97);z-index:9000;pointer-events:none;opacity:0;
  transition:opacity .2s ease, transform .2s ease;width:min(340px, calc(100vw - 32px));
  box-sizing:border-box;padding:18px 20px 16px;border-radius:16px;
  background:rgba(14,18,32,.82);border:1px solid rgba(148,163,255,.14);
  -webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);
  box-shadow:0 18px 50px rgba(0,0,0,.45), 0 0 0 1px rgba(7,10,20,.4) inset;
  color:${C.text};font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}
.ux-loader.ux-visible{opacity:1;transform:translate(-50%,-50%) scale(1)}
.ux-loader[hidden]{display:none}
.ux-loader-scene{position:relative;height:92px;margin:-4px -6px 10px;border-radius:12px;overflow:hidden;
  background:radial-gradient(120% 140% at 30% 50%, rgba(139,147,255,.16), rgba(7,10,20,0) 70%), ${C.bg}}
.ux-loader-stars{position:absolute;inset:0;width:100%;height:100%;display:block}
.ux-loader-craft{position:absolute;left:50%;top:50%;width:86px;height:86px;margin:-43px 0 0 -43px;
  animation:ux-bob 2.4s ease-in-out infinite;filter:drop-shadow(0 0 10px rgba(139,147,255,.35))}
.ux-loader-rocket{position:absolute;left:0;bottom:2px;width:132px;height:72px}
.ux-loader-cow{position:absolute;left:0;top:0;width:86px;height:86px;transform:rotate(-8deg);
  animation:ux-cow 3.1s ease-in-out infinite}
@keyframes ux-cow{0%,100%{transform:rotate(-8deg) translateY(0)}50%{transform:rotate(-3deg) translateY(-2px)}}
.ux-loader-quip{margin-top:8px;font-size:11px;font-style:italic;color:rgba(242,196,109,.85);min-height:15px}
.ux-loader-flame{transform-origin:100% 50%;animation:ux-flame .14s ease-in-out infinite alternate}
@keyframes ux-bob{0%,100%{transform:translateY(-3px) rotate(-3deg)}50%{transform:translateY(3px) rotate(2deg)}}
@keyframes ux-flame{from{transform:scaleX(.8);opacity:.85}to{transform:scaleX(1.15);opacity:1}}
.ux-loader-title{font-size:15px;font-weight:600;letter-spacing:.01em;color:${C.text};
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ux-loader-sub{margin-top:3px;font-size:12px;color:rgba(230,233,245,.66);min-height:17px;
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ux-loader-bar{position:relative;margin-top:12px;height:4px;border-radius:4px;overflow:hidden;
  background:rgba(148,163,255,.14)}
.ux-loader-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:4px;
  background:linear-gradient(90deg, ${C.indigo}, ${C.gold});transition:width .25s ease}
.ux-loader-bar.ux-indet .ux-loader-fill{width:38%;animation:ux-indet 1.3s ease-in-out infinite;
  background:linear-gradient(90deg, rgba(139,147,255,0), ${C.indigo}, ${C.gold}, rgba(242,196,109,0))}
@keyframes ux-indet{from{transform:translateX(-110%)}to{transform:translateX(280%)}}
@media (prefers-reduced-motion: reduce){
  .ux-loader-craft,.ux-loader-cow,.ux-loader-flame{animation:none}
  .ux-loader-bar.ux-indet .ux-loader-fill{animation:none;width:100%;opacity:.5}
  .ux-loader,.ux-loader-fill{transition:none}
}`;

// Space Valley's astronaut cow rides the rocket (AI-generated art, assets/cow/cow-rocket-192.png)
const COW_SRC = new URL('./assets/cow/cow-rocket-192.png', document.baseURI).href;
const QUIPS = ['Our astronaut cow is at the controls…', 'Mooo-ving through the Milky Way…', 'Grazing on infrared photons…',
  'Steering clear of the Moon (it was jumped over once already)…', 'Checking for udder-ly interesting objects…', 'Herding pixels from NASA…'];
const ROCKET_SVG = `
<svg class="ux-loader-rocket" viewBox="0 0 74 40" aria-hidden="true">
  <defs>
    <linearGradient id="ux-hull" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4f5fb"/><stop offset="1" stop-color="#b9bfe0"/>
    </linearGradient>
    <linearGradient id="ux-fire" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0" stop-color="${C.gold}"/><stop offset=".6" stop-color="#f59e5b"/>
      <stop offset="1" stop-color="#f59e5b" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <g class="ux-loader-flame"><path d="M2 20 Q10 14 19 15 L19 25 Q10 26 2 20 Z" fill="url(#ux-fire)"/></g>
  <path d="M26 9 L19 3 L16 3 L21 13 Z" fill="${C.indigo}"/>
  <path d="M26 31 L19 37 L16 37 L21 27 Z" fill="${C.indigo}"/>
  <path d="M18 13 L52 12 Q66 13 72 20 Q66 27 52 28 L18 27 Q15 20 18 13 Z" fill="url(#ux-hull)"/>
  <path d="M60 14.2 Q67 16 72 20 Q67 24 60 25.8 Q62 20 60 14.2 Z" fill="${C.indigo}"/>
  <circle cx="46" cy="20" r="4.6" fill="${C.bg}" stroke="${C.indigo}" stroke-width="1.6"/>
  <circle cx="44.8" cy="18.8" r="1.3" fill="rgba(230,233,245,.7)"/>
  <rect x="18" y="17.5" width="7" height="5" rx="1" fill="${C.indigo}" opacity=".85"/>
</svg>`;

// createLoader(parent = document.body) -> { show(title, subtitle), set(subtitle, fraction), hide(), el }
// A glassy card centred over the image area (viewport minus the right panel) with a bobbing rocket,
// star streaks rushing past, a title, a subtitle and a slim progress bar. pointer-events: none.
// set(subtitle, fraction): fraction 0..1 for a determinate bar, null for an indeterminate shimmer
// (pass undefined as subtitle to keep the current text). hide() keeps it visible >= 600 ms after show().
export function createLoader(parent = document.body) {
  if (!document.getElementById('ux-loader-style')) {
    const st = document.createElement('style');
    st.id = 'ux-loader-style';
    st.textContent = LOADER_CSS;
    document.head.appendChild(st);
  }
  const el = document.createElement('div');
  el.className = 'ux-loader';
  el.hidden = true;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="ux-loader-scene"><canvas class="ux-loader-stars"></canvas>
      <div class="ux-loader-craft"><img class="ux-loader-cow" src="${COW_SRC}" alt=""></div></div>
    <div class="ux-loader-title"></div>
    <div class="ux-loader-sub"></div>
    <div class="ux-loader-bar ux-indet"><div class="ux-loader-fill"></div></div>
    <div class="ux-loader-quip"></div>`;
  parent.appendChild(el);

  const titleEl = el.querySelector('.ux-loader-title');
  const subEl = el.querySelector('.ux-loader-sub');
  const barEl = el.querySelector('.ux-loader-bar');
  const fillEl = el.querySelector('.ux-loader-fill');
  const cv = el.querySelector('.ux-loader-stars');
  const cx = cv.getContext('2d');

  let visible = false, shownAt = 0, hideTimer = 0, fadeTimer = 0, raf = 0, last = 0;
  let observer = null;

  // Star streaks: particles moving right-to-left (rocket flies to the right).
  const stars = Array.from({ length: 46 }, () => newStar(true));
  function newStar(anywhere) {
    const z = Math.random();
    return { x: anywhere ? Math.random() : 1.05 + Math.random() * 0.2, y: Math.random(),
      z, v: 0.25 + z * 1.1, gold: Math.random() < 0.12 };
  }
  function drawStars(now) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    const still = prefersReducedMotion();
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, W, H);
    cx.lineCap = 'round';
    for (const s of stars) {
      if (!still) {
        s.x -= s.v * dt * 0.9;
        if (s.x < -0.3) Object.assign(s, newStar(false));
      }
      const len = still ? 1.5 : 6 + s.z * 46;
      const px = s.x * W, py = s.y * H;
      const col = s.gold ? '242,196,109' : (s.z > 0.6 ? '230,233,245' : '139,147,255');
      const g = cx.createLinearGradient(px, py, px + len, py);
      g.addColorStop(0, `rgba(${col},${0.35 + s.z * 0.6})`);
      g.addColorStop(1, `rgba(${col},0)`);
      cx.strokeStyle = g;
      cx.lineWidth = 0.6 + s.z * 1.3;
      cx.beginPath(); cx.moveTo(px, py); cx.lineTo(px + len, py); cx.stroke();
    }
  }
  function loop(now) {
    drawStars(now);
    raf = (visible && !prefersReducedMotion()) ? requestAnimationFrame(loop) : 0;
  }

  function updatePanelOffset() {
    // the side panel only takes room when it is open, and only on wide screens (on phones it comes up from the bottom)
    let pw = '0px';
    if (document.body.classList.contains('menu-open') && innerWidth > 700) {
      try { pw = getComputedStyle(document.documentElement).getPropertyValue('--panel-w').trim(); } catch {}
      if (!pw) pw = '360px';
      pw = `calc(${pw} + 20px)`;
    }
    el.style.setProperty('--ux-panel-w', pw);
  }

  // listeners (the VR panel in app-vr.js mirrors the card, since the DOM is invisible in a headset)
  const listeners = [], state = { visible: false, title: '', sub: '', fraction: null, quip: '' };
  const emit = () => { for (const f of listeners) { try { f(state); } catch {} } };
  function setText(title, subtitle) {
    if (title != null) { titleEl.textContent = title; state.title = title; }
    if (subtitle !== undefined) { subEl.textContent = subtitle ?? ''; state.sub = subtitle ?? ''; }
  }
  function setFraction(fraction) {
    state.fraction = (fraction == null || !isFinite(fraction)) ? null : Math.max(0, Math.min(1, fraction));
    if (fraction == null || !isFinite(fraction)) {
      barEl.classList.add('ux-indet');
      fillEl.style.width = '';
    } else {
      barEl.classList.remove('ux-indet');
      fillEl.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    }
  }

  return {
    el, state, subscribe(fn) { listeners.push(fn); fn(state); },
    // Show the overlay (or just update its text if already visible). Bar starts indeterminate.
    show(title = 'Flying to a new place', subtitle = '') {
      clearTimeout(hideTimer); hideTimer = 0;
      clearTimeout(fadeTimer); fadeTimer = 0;
      setText(title, subtitle);
      updatePanelOffset();
      if (visible) { emit(); return; }
      visible = true; state.visible = true;
      shownAt = performance.now();
      el.querySelector('.ux-loader-quip').textContent = state.quip = QUIPS[Math.floor(Math.random() * QUIPS.length)];
      setFraction(null);
      el.hidden = false;
      void el.offsetWidth; // restart the transition
      el.classList.add('ux-visible');
      if (!observer && 'MutationObserver' in window) {
        observer = new MutationObserver(updatePanelOffset);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
      }
      last = 0;
      if (!raf) raf = requestAnimationFrame(loop);
      emit();
    },
    // Update the subtitle and progress (fraction 0..1, or null for indeterminate).
    set(subtitle, fraction = null) {
      setText(null, subtitle);
      setFraction(fraction);
      emit();
    },
    // Fade out, but never before 600 ms have passed since show().
    hide() {
      if (!visible || hideTimer) return;
      const wait = Math.max(0, 600 - (performance.now() - shownAt));
      hideTimer = setTimeout(() => {
        hideTimer = 0;
        visible = false; state.visible = false; emit();
        el.classList.remove('ux-visible');
        if (observer) { observer.disconnect(); observer = null; }
        fadeTimer = setTimeout(() => { if (!visible) el.hidden = true; }, 220);
      }, wait);
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* 2. Extended ("outpainting") preview                                                          */
/* ------------------------------------------------------------------------------------------ */

let extCache = null; // { src, w, h, pad, canvas, s }

// invalidateExtendedPreview(): drop the cached blurred composite (call when the frame/image changes).
export function invalidateExtendedPreview() { extCache = null; }

function makeCanvas(w, h) {
  // A plain <canvas> (not OffscreenCanvas): measured ~2x faster to drawImage() onto the main canvas.
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function buildExtended(src, w, h, pad) {
  // Rendered at reduced resolution: it gets blurred heavily anyway, and it keeps the build cheap.
  const s = Math.min(1, 700 / Math.max(w, h));
  const W = Math.max(2, Math.round((w + 2 * pad) * s));
  const H = Math.max(2, Math.round((h + 2 * pad) * s));
  const iw = w * s, ih = h * s, p = pad * s;

  // a) 3x3 mirrored tiling: each neighbour reflects the image across the shared edge.
  const m = makeCanvas(W, H);
  const mc = m.getContext('2d');
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      mc.save();
      // Tile (i,j) covers [p + i*iw, p + (i+1)*iw]; flipped tiles are drawn mirrored in place.
      const ox = p + i * iw, oy = p + j * ih;
      mc.translate(ox + (i !== 0 ? iw : 0), oy + (j !== 0 ? ih : 0));
      mc.scale(i !== 0 ? -1 : 1, j !== 0 ? -1 : 1);
      mc.drawImage(src, 0, 0, iw, ih);
      mc.restore();
    }
  }

  // b) Heavy blur + desaturation.
  const blurPx = Math.max(6, pad / 14) * s;
  const out = makeCanvas(W, H);
  const oc = out.getContext('2d');
  if ('filter' in oc) {
    oc.filter = `blur(${blurPx.toFixed(1)}px) saturate(0.45) brightness(1.25) contrast(1.1)`;
    oc.drawImage(m, 0, 0);
    oc.filter = 'none';
  } else {
    // Fallback blur: downsample then upsample with smoothing.
    const k = Math.max(4, Math.round(blurPx));
    const sm = makeCanvas(Math.max(1, Math.round(W / k)), Math.max(1, Math.round(H / k)));
    const sc = sm.getContext('2d');
    sc.imageSmoothingEnabled = true;
    sc.drawImage(m, 0, 0, sm.width, sm.height);
    oc.imageSmoothingEnabled = true;
    oc.drawImage(sm, 0, 0, W, H);
  }

  // c) Indigo tint.
  oc.globalCompositeOperation = 'source-atop';
  oc.fillStyle = 'rgba(139,147,255,0.16)';
  oc.fillRect(0, 0, W, H);

  // d) Fade-out mask with distance from the real image (side bands: linear; corners: radial).
  const mask = makeCanvas(W, H);
  const k2 = mask.getContext('2d');
  const a0 = 0.8;  // opacity right at the image edge
  const stops = (g) => {
    g.addColorStop(0, `rgba(0,0,0,${a0})`);
    g.addColorStop(0.45, `rgba(0,0,0,${a0 * 0.4})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    return g;
  };
  const x0 = p, y0 = p, x1 = p + iw, y1 = p + ih;
  k2.fillStyle = stops(k2.createLinearGradient(x0, 0, x0 - p, 0)); k2.fillRect(0, y0, x0, ih);
  k2.fillStyle = stops(k2.createLinearGradient(x1, 0, x1 + p, 0)); k2.fillRect(x1, y0, W - x1, ih);
  k2.fillStyle = stops(k2.createLinearGradient(0, y0, 0, y0 - p)); k2.fillRect(x0, 0, iw, y0);
  k2.fillStyle = stops(k2.createLinearGradient(0, y1, 0, y1 + p)); k2.fillRect(x0, y1, iw, H - y1);
  for (const [cxp, cyp, rx, ry] of [[x0, y0, 0, 0], [x1, y0, x1, 0], [x0, y1, 0, y1], [x1, y1, x1, y1]]) {
    k2.fillStyle = stops(k2.createRadialGradient(cxp, cyp, 0, cxp, cyp, p));
    k2.fillRect(rx, ry, cxp === x0 ? x0 : W - x1, cyp === y0 ? y0 : H - y1);
  }
  oc.globalCompositeOperation = 'destination-in';
  oc.drawImage(mask, 0, 0);

  // e) Never paint over the real image.
  oc.globalCompositeOperation = 'source-over';
  oc.clearRect(x0, y0, iw, ih);

  return { canvas: out, s };
}

// drawExtendedPreview(ctx, src, x, y, w, h, pad, t)
// Paints a clearly-fake, blurred, indigo-tinted, fading MIRRORED continuation of `src` in the band of
// width `pad` around the on-screen rect (x, y, w, h), plus a diagonal shimmer sweep driven by t (s).
// Nothing is drawn over the rect itself. The heavy composite is cached (src identity + w + h + pad);
// only the shimmer is redrawn per frame.
export function drawExtendedPreview(ctx, src, x, y, w, h, pad, t = 0) {
  if (!src || !(w > 1) || !(h > 1) || !(pad > 1)) return;
  const kw = Math.round(w), kh = Math.round(h), kp = Math.round(pad);
  if (!extCache || extCache.src !== src || extCache.w !== kw || extCache.h !== kh || extCache.pad !== kp) {
    try {
      const b = buildExtended(src, kw, kh, kp);
      extCache = { src, w: kw, h: kh, pad: kp, canvas: b.canvas, s: b.s };
    } catch (e) {
      extCache = null;
      return;
    }
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  // Blit only the 4 band pieces of the cached composite (top, bottom, left, right), scaled to the
  // exact (possibly fractional) on-screen rect; the transparent centre is never touched.
  const cvs = extCache.canvas, cs = extCache.s;
  const CW = cvs.width, CH = cvs.height;
  const sp = kp * cs, sih = CH - 2 * sp; // source-space band width and image height
  const ox = x - pad, oy = y - pad, OW = w + 2 * pad, OH = h + 2 * pad;
  ctx.drawImage(cvs, 0, 0, CW, sp, ox, oy, OW, pad);                 // top (with corners)
  ctx.drawImage(cvs, 0, CH - sp, CW, sp, ox, y + h, OW, pad);        // bottom (with corners)
  ctx.drawImage(cvs, 0, sp, sp, sih, ox, y, pad, h);                 // left
  ctx.drawImage(cvs, CW - sp, sp, sp, sih, x + w, y, pad, h);        // right

  // Shimmer: a soft diagonal light strip sweeping across the band area only (evenodd clip). Only the
  // strip polygon is filled, so the per-frame fill cost stays small.
  ctx.beginPath();
  ctx.rect(ox, oy, OW, OH);
  ctx.rect(x, y, w, h);
  ctx.clip('evenodd');
  if (!prefersReducedMotion()) {
    // u = dx + dy along the top-left -> bottom-right diagonal; a strip of half-width bw sweeps across.
    const period = 2.4;
    const ph = (((t % period) + period) % period) / period; // 0..1
    const bw = Math.max(80, Math.min(OW, OH) * 0.3);
    const u = -bw + ph * (OW + OH + 2 * bw);
    const g = ctx.createLinearGradient(ox + (u - bw) / 2, oy + (u - bw) / 2, ox + (u + bw) / 2, oy + (u + bw) / 2);
    g.addColorStop(0, 'rgba(139,147,255,0)');
    g.addColorStop(0.5, 'rgba(200,205,255,0.16)');
    g.addColorStop(1, 'rgba(139,147,255,0)');
    ctx.fillStyle = g;
    // Strip polygon: points with u-bw <= dx+dy <= u+bw (a parallelogram crossing the box).
    const L = OW + OH;
    ctx.beginPath();
    ctx.moveTo(ox + (u - bw), oy);
    ctx.lineTo(ox + (u + bw), oy);
    ctx.lineTo(ox + (u + bw) - L, oy + L);
    ctx.lineTo(ox + (u - bw) - L, oy + L);
    ctx.closePath();
    ctx.fill();
  }
  // Faint dashed boundary marking where the real data ends.
  ctx.setLineDash([4, 6]);
  ctx.lineDashOffset = -t * 12;
  ctx.strokeStyle = 'rgba(139,147,255,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
  ctx.restore();
}

/* ------------------------------------------------------------------------------------------ */
/* 3. Hover tile                                                                               */
/* ------------------------------------------------------------------------------------------ */

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pill(ctx, text, cx, cy, { font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif',
  bg = 'rgba(7,10,20,.78)', fg = C.text, border = 'rgba(148,163,255,.28)', align = 'center',
  padX = 8, h = 20 } = {}) {
  ctx.font = font;
  const tw = ctx.measureText(text).width;
  const w = tw + padX * 2;
  let x = cx - w / 2;
  if (align === 'left') x = cx;
  else if (align === 'right') x = cx - w;
  const y = cy - h / 2;
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, cy + 0.5);
  return { x, y, w, h };
}

// drawHoverTile(ctx, x, y, w, h, t, label = 'Click to load this area')
// A gently pulsing, glowing indigo rounded outline with a faint fill and a centred pill label,
// marking a not-yet-loaded neighbouring tile under the mouse. Restores ctx state.
export function drawHoverTile(ctx, x, y, w, h, t = 0, label = 'Click to load this area') {
  const pulse = prefersReducedMotion() ? 0.5 : 0.5 + 0.5 * Math.sin(t * 3.2);
  const r = Math.min(14, w / 8, h / 8);
  ctx.save();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = 'rgba(139,147,255,.06)';
  ctx.fill();
  ctx.shadowColor = `rgba(139,147,255,${0.55 + 0.35 * pulse})`;
  ctx.shadowBlur = 10 + 14 * pulse;
  ctx.strokeStyle = `rgba(139,147,255,${0.6 + 0.35 * pulse})`;
  ctx.lineWidth = 1.5 + 0.5 * pulse;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  if (label && w > 60 && h > 30) {
    pill(ctx, label, x + w / 2, y + h / 2, { border: `rgba(139,147,255,${0.35 + 0.3 * pulse})`, h: 24, padX: 11 });
  }
  ctx.restore();
}

/* ------------------------------------------------------------------------------------------ */
/* 4. RA/Dec coordinate grid                                                                   */
/* ------------------------------------------------------------------------------------------ */

const mod = (a, n) => ((a % n) + n) % n;
const wrap180 = (a) => mod(a + 180, 360) - 180;

function pickStep(span, ladder, unitDeg) {
  // Smallest step giving <= 7 lines (and so typically >= 3-4 lines given the ladder ratios).
  for (const s of ladder) if (span / (s * unitDeg) <= 7) return s;
  return ladder[ladder.length - 1];
}

function fmtArcStep(arcsec) {
  if (arcsec >= 3600) return `${+(arcsec / 3600).toFixed(2)}°`;
  if (arcsec >= 60) return `${+(arcsec / 60).toFixed(2)}′`;
  return `${+arcsec.toFixed(2)}″`;
}
function fmtTimeStep(sec) {
  if (sec >= 3600) return `${+(sec / 3600).toFixed(2)}ʰ`;
  if (sec >= 60) return `${+(sec / 60).toFixed(2)}ᵐ`;
  return `${+sec.toFixed(2)}ˢ`;
}

function fmtDec(dec, stepArcsec) {
  const total = Math.round(Math.abs(dec) * 3600);
  const sign = dec < 0 && total > 0 ? '−' : '+';
  const d = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  let out = `${sign}${String(d).padStart(2, '0')}°`;
  if (stepArcsec < 3600 || m || s) out += `${String(m).padStart(2, '0')}′`;
  if (stepArcsec < 60 || s) out += `${String(s).padStart(2, '0')}″`;
  return out;
}

function fmtRA(raDeg, stepSec) {
  const dec = stepSec < 1 ? 1 : 0; // decimals of time seconds
  const f = Math.pow(10, dec);
  let totalSec = Math.round(mod(raDeg, 360) / 15 * 3600 * f) / f;
  if (totalSec >= 86400) totalSec -= 86400;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec - h * 3600) / 60);
  const s = totalSec - h * 3600 - m * 60;
  let out = `${String(h).padStart(2, '0')}ʰ`;
  if (stepSec < 3600 || m || s) out += `${String(m).padStart(2, '0')}ᵐ`;
  if (stepSec < 60 || s) out += `${s.toFixed(dec).padStart(dec ? 4 : 2, '0')}ˢ`;
  const stepDeg = stepSec * 15 / 3600;
  if (stepDeg >= 1 / 60) {
    const nd = Math.max(0, Math.min(4, Math.ceil(-Math.log10(stepDeg)) + 1));
    out += ` (${mod(raDeg, 360).toFixed(nd)}°)`;
  }
  return out;
}

// drawCoordGrid(ctx, opts)
// opts = { width, height, project(ra, dec) -> [x, y] | null, unproject(x, y) -> {ra, dec},
//          scaleArcsecPerPx, color = 'rgba(230,233,245,.35)', labelColor = '#e6e9f5' }
// Draws a lightly-dashed RA/Dec grid over 0..width x 0..height (CSS px) with "nice" steps
// (~4-7 lines each way), Dec labels on the left edge, RA labels on the bottom edge, and a
// small legend top-left. Assumes north up, east left. Handles RA wrap at 0/360.
export function drawCoordGrid(ctx, opts) {
  const { width: W, height: H, project, unproject } = opts;
  const color = opts.color || 'rgba(230,233,245,.35)';
  const labelColor = opts.labelColor || C.text;
  if (!(W > 0) || !(H > 0) || typeof project !== 'function' || typeof unproject !== 'function') return;

  // View extent from corners, edge midpoints and centre, RA relative to the centre RA.
  const c0 = unproject(W / 2, H / 2);
  if (!c0 || !isFinite(c0.ra) || !isFinite(c0.dec)) return;
  const ra0 = c0.ra;
  let dMin = Infinity, dMax = -Infinity, rMin = Infinity, rMax = -Infinity;
  for (const [px, py] of [[0, 0], [W / 2, 0], [W, 0], [0, H / 2], [W / 2, H / 2], [W, H / 2],
    [0, H], [W / 2, H], [W, H]]) {
    const q = unproject(px, py);
    if (!q || !isFinite(q.ra) || !isFinite(q.dec)) continue;
    dMin = Math.min(dMin, q.dec); dMax = Math.max(dMax, q.dec);
    const dr = wrap180(q.ra - ra0);
    rMin = Math.min(rMin, dr); rMax = Math.max(rMax, dr);
  }
  if (!isFinite(dMin)) return;
  // A pole inside the view: all RAs are visible.
  for (const pd of [90, -90]) {
    const pp = project(0, pd);
    if (pp && pp[0] >= 0 && pp[0] <= W && pp[1] >= 0 && pp[1] <= H) {
      rMin = -180; rMax = 180;
      if (pd > 0) dMax = 90; else dMin = -90;
    }
  }

  const decSpan = Math.max(1e-6, dMax - dMin);
  const cosd = Math.max(0.02, Math.cos(c0.dec * Math.PI / 180));
  // RA span in true RA degrees (already includes the 1/cos(dec) stretch); fall back to scale if degenerate.
  let raSpan = rMax - rMin;
  if (!(raSpan > 0)) raSpan = (W * (opts.scaleArcsecPerPx || 1) / 3600) / cosd;
  const decStep = pickStep(decSpan, NICE_ARCSEC, 1 / 3600);          // arcsec
  const raStep = pickStep(raSpan, NICE_RA_TIME_S, 15 / 3600);         // seconds of time
  const decStepDeg = decStep / 3600, raStepDeg = raStep * 15 / 3600;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.setLineDash([5, 4]);

  const MARGIN = 200;
  const inside = (p) => p && isFinite(p[0]) && isFinite(p[1]) &&
    p[0] > -MARGIN && p[0] < W + MARGIN && p[1] > -MARGIN && p[1] < H + MARGIN;
  const samples = Math.min(400, Math.ceil(Math.hypot(W, H) * 1.3 / 12) + 2);

  // Sample a line, stroke it in visible runs, return the visible points for labelling.
  function traceLine(fn) {
    const pts = [];
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        ctx.beginPath();
        ctx.moveTo(run[0][0], run[0][1]);
        for (let i = 1; i < run.length; i++) ctx.lineTo(run[i][0], run[i][1]);
        ctx.stroke();
      }
      run = [];
    };
    for (let i = 0; i <= samples; i++) {
      const p = fn(i / samples);
      if (inside(p)) { run.push(p); pts.push(p); } else { flush(); pts.push(null); }
    }
    flush();
    return pts;
  }
  // Where a polyline crosses an axis-aligned edge (axis 0: x = v, axis 1: y = v).
  function crossing(pts, axis, v) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (!a || !b) continue;
      if ((a[axis] - v) * (b[axis] - v) <= 0 && a[axis] !== b[axis]) {
        const f = (v - a[axis]) / (b[axis] - a[axis]);
        return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
      }
    }
    return null;
  }

  const padR = (rMax - rMin) * 0.15 + raStepDeg;
  const padD = decSpan * 0.15 + decStepDeg;
  const raLo = rMin - padR, raHi = rMax + padR;
  const deLo = Math.max(-90, dMin - padD), deHi = Math.min(90, dMax + padD);

  const labels = [];
  // Dec lines (constant dec, varying RA).
  const kd0 = Math.ceil(deLo / decStepDeg), kd1 = Math.floor(deHi / decStepDeg);
  if (kd1 - kd0 < 60) {
    for (let k = kd0; k <= kd1; k++) {
      const dec = k * decStepDeg;
      if (Math.abs(dec) >= 90) continue;
      const pts = traceLine((f) => project(mod(ra0 + raLo + f * (raHi - raLo), 360), dec));
      const cp = crossing(pts, 0, 0);
      if (cp && cp[1] > 34 && cp[1] < H - 34) labels.push({ kind: 'dec', text: fmtDec(dec, decStep), x: 6, y: cp[1] });
    }
  }
  // RA lines (constant RA, varying dec).
  const raStart = ra0 + raLo, raEnd = ra0 + raHi;
  const kr0 = Math.ceil(raStart / raStepDeg), kr1 = Math.floor(raEnd / raStepDeg);
  if (kr1 - kr0 < 80) {
    const seen = new Set();
    for (let k = kr0; k <= kr1; k++) {
      const ra = mod(k * raStepDeg, 360);
      const key = Math.round(ra * 1e6);
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = traceLine((f) => project(ra, deLo + f * (deHi - deLo)));
      const cp = crossing(pts, 1, H);
      if (cp && cp[0] > 50 && cp[0] < W - 50) labels.push({ kind: 'ra', text: fmtRA(ra, raStep), x: cp[0], y: H - 14 });
    }
  }

  // Labels.
  ctx.setLineDash([]);
  const font = '500 11px ui-monospace, "SF Mono", Consolas, "Segoe UI", monospace';
  const placed = [];
  const overlaps = (r) => placed.some((q) => r.x < q.x + q.w + 4 && q.x < r.x + r.w + 4 && r.y < q.y + q.h + 2 && q.y < r.y + r.h + 2);
  for (const L of labels) {
    ctx.font = font;
    const tw = ctx.measureText(L.text).width + 14;
    const r = L.kind === 'dec' ? { x: L.x, y: L.y - 9, w: tw, h: 18 } : { x: L.x - tw / 2, y: L.y - 9, w: tw, h: 18 };
    if (overlaps(r)) continue;
    placed.push(r);
    pill(ctx, L.text, L.kind === 'dec' ? L.x : L.x, L.y, {
      font, fg: labelColor, bg: 'rgba(7,10,20,.66)', border: 'rgba(148,163,255,.18)',
      align: L.kind === 'dec' ? 'left' : 'center', padX: 7, h: 18,
    });
  }

  // Legend.
  const legend = `RA/Dec grid · step ${fmtArcStep(decStep)} × ${fmtTimeStep(raStep)}`;
  pill(ctx, legend, 10, 18, {
    font: '500 11px system-ui, -apple-system, "Segoe UI", sans-serif', fg: labelColor,
    bg: 'rgba(7,10,20,.7)', border: 'rgba(148,163,255,.18)', align: 'left', padX: 8, h: 20,
  });
  ctx.restore();
}

/* ------------------------------------------------------------------------------------------ */
/* Scale bar                                                                                   */
/* ------------------------------------------------------------------------------------------ */

// nicePixelScaleBar(scaleArcsecPerPx, targetPx = 120) -> { px, label }
// Picks the "nice" angular length (1″ … 30°) whose on-screen length is closest to targetPx.
export function nicePixelScaleBar(scaleArcsecPerPx, targetPx = 120) {
  if (!(scaleArcsecPerPx > 0)) return { px: targetPx, label: '' };
  let best = NICE_ARCSEC[0], bestErr = Infinity;
  for (const a of NICE_ARCSEC) {
    const err = Math.abs(Math.log((a / scaleArcsecPerPx) / targetPx));
    if (err < bestErr) { bestErr = err; best = a; }
  }
  return { px: best / scaleArcsecPerPx, label: fmtArcStep(best) };
}
