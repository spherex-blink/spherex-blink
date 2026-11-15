// Extra data for the SPHEREx Blink app: asteroids & comets (SPHEREx mover files), the Canadian NEOSSat data (CSA) and the
// pre-computed survey light curves of the five test targets. Everything is turned into the SAME result shape the viewer
// already plays (a getBlink() result: {target, grid, options, detector, frames[{data, width, height, mjd, date, det, lambda_um, targetPx}]}).
// Uses only Daniel's data layer (lib/spherex/). Written with Claude Code.
import { loadMovers, loadMover, getMoverVideo, loadLightCurve } from './lib/spherex/index.mjs';
import { loadNeossatIndex, decodeF32 } from './lib/spherex/neossat.mjs';

const LIB = new URL('./lib/spherex/', import.meta.url);
const getJSON = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`); return r.json(); };
const dateOf = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 16).replace('T', ' ');

/** Everything the "Explore" list can open: [{id, label, group, kind, hint}] (order = display order). */
export async function exploreItems() {
  const items = [
    { id: 'canada:neossat', group: 'Canada 🇨🇦', kind: 'flyby', label: '3I/ATLAS · NEOSSat (CSA)', hint: 'Interstellar comet crossing the stars, 58 min on 27 Nov 2025, Canada\'s NEOSSat' },
    { id: 'canada:spherex', group: 'Canada 🇨🇦', kind: 'flyby', label: '3I/ATLAS · SPHEREx 13 h', hint: 'The same comet seen by SPHEREx on 14 Dec 2025' },
  ];
  try {
    for (const m of await loadMovers()) items.push({ id: 'mover:' + m.slug, group: 'Asteroids & comets', kind: 'mover', label: m.name, hint: `SPHEREx images of ${m.name}`, def: m.default });
  } catch (e) { /* movers index missing: skip */ }
  try {
    const idx = await loadNeossatIndex();
    for (const o of idx.objects) if (o.slug !== '3i-atlas') items.push({ id: 'neocomet:' + o.slug, group: 'Comets seen by both telescopes', kind: 'mover', label: o.name, hint: `${o.name}: also imaged by NEOSSat (CSA)`, path: o.spherex_mover });
  } catch (e) { /* no NEOSSat gallery */ }
  return items;
}

/** Load one Explore item as a viewer result. opts: {signal, onFrame(frame, done, total)}. */
export async function loadExplore(id, opts = {}) {
  const [kind, slug] = id.split(':');
  if (kind === 'canada') return flybyResult(slug);
  let mover;
  if (kind === 'mover') mover = await loadMover(undefined, slug);
  else if (kind === 'neocomet') mover = await getJSON(new URL(`neossat/spherex/${slug}.json`, LIB));
  else throw new Error('Unknown item ' + id);
  // comets play their ENTIRE imaged path (every exposure over the survey, thinned to ~60 frames, in time order, object centred);
  // asteroids keep the default burst/run of their own file
  const comet = kind === 'neocomet' || slug === '3i-atlas';
  const m0 = (await loadMovers().catch(() => [])).find((m) => m.slug === slug);
  const d0 = m0?.default || {};
  const o = comet ? { mode: 'follow', span: 'all', maxFrames: 60, signal: opts.signal, onFrame: opts.onFrame }
    : { mode: d0.mode || 'flyby', span: d0.span || 'run', maxFrames: 40, signal: opts.signal, onFrame: opts.onFrame };
  const v = await getMoverVideo(mover, o);
  return moverResult(v, mover, o);
}

function moverResult(v, mover, o) {
  const n = v.n, frames = v.frames.slice().sort((a, b) => a.mjd - b.mjd).map((f) => ({
    ...f, width: n, height: n, date: dateOf(f.mjd), n_stack: 1,
  }));
  const track = v.mode === 'follow';
  // every exposure's sky position (for the thin path line on the dome and the 2D "path on the sky" inset), thinned to <= 600 points
  const all = (mover.exposures || []).slice().sort((a, b) => a.mjd - b.mjd), st = Math.max(1, Math.ceil(all.length / 600));
  const path = all.filter((_, i) => i % st === 0 || i === all.length - 1).map((e) => ({ ra: e.ra, dec: e.dec, mjd: e.mjd }));
  return {
    path: o.span === 'all' ? path : null, span: o.span,
    target: { name: mover.name, ra: v.center[0], dec: v.center[1], pm_mas_yr: null },
    grid: { n, pix_arcsec: 6.15, center_ra: v.center[0], center_dec: v.center[1], mode: track ? 'track' : 'sky' },
    options: { mode: track ? 'track' : 'sky', detectorRequested: 'mixed', frames: 'exposures' },
    detector: frames[0]?.det, n_exposures: mover.exposures?.length, visits: null, frames,
    kind: 'mover', about: mover.about || '', credit: 'SPHEREx: NASA/JPL-Caltech/IPAC (IRSA). Positions: JPL Horizons (SPHEREx-centred).',
    note: track ? 'Each frame is centred on the object (stars stream past).' : 'Stars fixed: the object crosses the frame.',
  };
}

async function flybyResult(which) {
  const d = await getJSON(new URL(`neossat/3i-atlas-flyby-${which}.json`, LIB));
  const n = d.n, neo = which === 'neossat';
  const frames = d.frames.map((f) => ({
    data: decodeF32(f.data_b64_f32le), width: n, height: n, mjd: f.mjd, date: dateOf(f.mjd), date_time: f.date_time,
    det: neo ? 'NEOSSat' : f.det, lambda_um: neo ? 0.65 : null, lambda_min_um: neo ? 0.4 : null, lambda_max_um: neo ? 0.9 : null,
    targetPx: f.targetPx, n_stack: 1, obs: f.image || f.key || '', exptime_s: f.exptime_s,
  }));
  return {
    target: { name: '3I/ATLAS (interstellar comet)', ra: d.center[0], dec: d.center[1], pm_mas_yr: null },
    grid: { n, pix_arcsec: d.pix_arcsec, center_ra: d.center[0], center_dec: d.center[1], mode: 'sky' },
    options: { mode: 'sky', detectorRequested: neo ? 'NEOSSat' : 'D' + d.det, frames: 'exposures' },
    detector: neo ? 'NEOSSat' : d.det, n_exposures: d.n_frames, visits: null, frames,
    kind: 'flyby', telescope: d.telescope, band: d.band,
    about: neo ? `Canada's NEOSSat watched the interstellar comet for ${Math.round(d.duration_min)} minutes on ${d.date}: it moves ${(d.motion_arcsec / 60).toFixed(1)}′ across fixed stars.`
      : `NASA's SPHEREx followed the same comet for ${d.duration_h} hours on ${d.date}: it crosses ${(d.motion_arcsec / 60).toFixed(0)}′ of sky.`,
    credit: d.credit,
    note: 'Stars fixed: the comet crosses the frame.',
  };
}

/** The pre-computed survey light curve of one of the five test targets (or null if there is none). */
export async function surveyLightCurve(key) {
  if (!key) return null;
  try { return await loadLightCurve(undefined, key); } catch (e) { return null; }
}

const BAND = (lam) => (lam < 1.1 ? '#8b93ff' : lam < 1.6 ? '#a78bfa' : lam < 2.4 ? '#6ee7b7' : lam < 3.8 ? '#f2c46d' : lam < 4.4 ? '#fb923c' : '#fb7185');

/** Draw a survey light curve on a canvas: every image as a faint dot coloured by wavelength, visit means with error bars,
 *  and the verdict / period as a caption. */
export function drawSurveyLightCurve(cv, lc) {
  const c = cv.getContext('2d'), W = cv.width, H = cv.height;
  c.clearRect(0, 0, W, H); c.fillStyle = '#0c1020'; c.fillRect(0, 0, W, H);
  c.font = `${Math.round(H / 13)}px system-ui, sans-serif`; c.fillStyle = '#8e98b8';
  if (!lc) { c.textAlign = 'center'; c.fillText('Survey light curves exist for the five test targets', W / 2, H / 2); c.textAlign = 'start'; return; }
  const pts = (lc.points || []).filter((p) => p.valid && Number.isFinite(p.rel));
  const vis = (lc.visits || []).filter((v) => Number.isFinite(v.rel_all));
  const yr = (m) => 2000 + (m - 51544.5) / 365.25;
  const xs = [...pts.map((p) => yr(p.mjd)), ...vis.map((v) => yr(v.mjd))];
  if (!xs.length) { c.fillText('No valid points', 20, H / 2); return; }
  const ys = vis.length ? vis.flatMap((v) => [v.rel_all - (v.rel_all_err || 0), v.rel_all + (v.rel_all_err || 0)]) : pts.map((p) => p.rel);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys, 0.85), y1 = Math.max(...ys, 1.15);
  const pad = (y1 - y0) * 0.12; y0 -= pad; y1 += pad; if (x1 - x0 < 0.05) x1 = x0 + 0.05;
  const L = W * 0.1, R = W * 0.03, T = H * 0.16, B = H * 0.17;
  const X = (x) => L + (x - x0) / (x1 - x0) * (W - L - R), Y = (y) => H - B - (y - y0) / (y1 - y0) * (H - T - B);
  c.strokeStyle = 'rgba(148,163,255,.18)'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(L, Y(1)); c.lineTo(W - R, Y(1)); c.stroke();
  c.beginPath(); c.moveTo(L, T); c.lineTo(L, H - B); c.lineTo(W - R, H - B); c.stroke();
  for (const p of pts) { if (p.rel < y0 || p.rel > y1) continue; c.fillStyle = BAND(p.lambda_um); c.globalAlpha = 0.28; c.fillRect(X(yr(p.mjd)) - 1.2, Y(p.rel) - 1.2, 2.4, 2.4); }
  c.globalAlpha = 1;
  c.strokeStyle = '#e6e9f5'; c.fillStyle = '#e6e9f5'; c.lineWidth = 1.5;
  for (const v of vis) {
    const x = X(yr(v.mjd)), y = Y(v.rel_all), e = (v.rel_all_err || 0) / (y1 - y0) * (H - T - B);
    c.beginPath(); c.moveTo(x, y - e); c.lineTo(x, y + e); c.stroke();
    c.beginPath(); c.arc(x, y, Math.max(2.5, W / 200), 0, 2 * Math.PI); c.fill();
  }
  c.fillStyle = '#8e98b8'; c.font = `${Math.round(H / 15)}px system-ui, sans-serif`;
  c.textAlign = 'left'; c.fillText('brightness ÷ median', L + 6, T - 6);
  c.textAlign = 'center'; c.fillText('year', (L + W - R) / 2, H - H * 0.03);
  c.fillText(x0.toFixed(2), L + 20, H - B + H * 0.09); c.fillText(x1.toFixed(2), W - R - 20, H - B + H * 0.09);
  c.textAlign = 'left'; c.fillStyle = lc.variable ? '#f2c46d' : '#6ee7b7'; c.font = `600 ${Math.round(H / 13)}px system-ui, sans-serif`;
  const per = lc.period?.period_d ? ` · period ${Math.round(lc.period.period_d)} d` : '';
  c.fillText(`${lc.variable ? 'Variable' : 'Steady'}${per} · ${lc.n_valid ?? pts.length} images`, L, H * 0.09);
  c.textAlign = 'start';
}
