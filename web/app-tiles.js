// Tiles around the chosen point, with a cache and a load order that shows something as fast as possible.
//
// The chosen point is tile (0, 0). Its neighbours are tiles of the same size on the same north-up grid: (dx, dy) in SCREEN
// direction (dx = +1 is one tile to the right = west, dy = +1 is one tile down = south). Every tile is an ordinary getBlink()
// result centred on its own sky position, so tiles line up to a fraction of a pixel at these small sizes.
//
// Load order (team leader's spec, 15.11):
//   1. ONE image of the clicked tile           (app.js: loadTarget, "quick")
//   2. ONE image of each surrounding tile      (ring(…, 'quick'))
//   3. the rest of the clicked tile's images    (app.js: the full video)
//   4. the rest of the surrounding tiles' images (ring(…, 'full'))
// Every loaded tile stays in the cache (keyed by sky position + options), so moving back never reloads it.
// Written with Claude Code.

const D2R = Math.PI / 180;
export const PIX = 6.15;           // arcsec per SPHEREx pixel (the grid the data layer resamples to)

/** Sky position of the tile centre (dx, dy) tiles away from (ra0, dec0), for tiles of n pixels (inverse gnomonic). */
export function tileCenter(ra0, dec0, dx, dy, n, pix = PIX) {
  const xi = (-dx * n * pix / 3600) * D2R, eta = (-dy * n * pix / 3600) * D2R;     // east = left, north = up
  const a0 = ra0 * D2R, d0 = dec0 * D2R, rho = Math.hypot(xi, eta);
  if (rho < 1e-12) return { ra: ra0, dec: dec0 };
  const c = Math.atan(rho), sc = Math.sin(c), cc = Math.cos(c);
  const dec = Math.asin(cc * Math.sin(d0) + eta * sc * Math.cos(d0) / rho);
  const ra = a0 + Math.atan2(xi * sc, rho * Math.cos(d0) * cc - eta * Math.sin(d0) * sc);
  return { ra: ((ra / D2R) % 360 + 360) % 360, dec: dec / D2R };
}

/** Gnomonic projection around (ra0, dec0): sky -> offsets in arcsec (east positive, north positive), or null behind. */
export function gnomonic(ra0, dec0, ra, dec) {
  const a = ra * D2R, d = dec * D2R, a0 = ra0 * D2R, d0 = dec0 * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  if (cosc <= 0.01) return null;
  const xi = Math.cos(d) * Math.sin(a - a0) / cosc, eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
  return [xi / D2R * 3600, eta / D2R * 3600];
}
/** Inverse of gnomonic(): arcsec offsets -> {ra, dec}. */
export function ungnomonic(ra0, dec0, xiAs, etaAs) {
  const xi = xiAs / 3600 * D2R, eta = etaAs / 3600 * D2R, a0 = ra0 * D2R, d0 = dec0 * D2R, rho = Math.hypot(xi, eta);
  if (rho < 1e-12) return { ra: ra0, dec: dec0 };
  const c = Math.atan(rho), sc = Math.sin(c), cc = Math.cos(c);
  const dec = Math.asin(cc * Math.sin(d0) + eta * sc * Math.cos(d0) / rho);
  const ra = a0 + Math.atan2(xi * sc, rho * Math.cos(d0) * cc - eta * Math.sin(d0) * sc);
  return { ra: ((ra / D2R) % 360 + 360) % 360, dec: dec / D2R };
}

const keyOf = (ra, dec, o) => `${ra.toFixed(5)},${dec.toFixed(5)}|${o.detector}|${o.half}|${o.frames}|${o.stack}`;

export class Tiles {
  /** getIndex(): Promise<SkyIndex>; getBlink: the data layer's function; onChange(): redraw request. */
  constructor({ getIndex, getBlink, onChange }) {
    this.getIndex = getIndex; this.getBlink = getBlink; this.onChange = onChange || (() => {});
    this.cache = new Map();          // key -> {key, ra, dec, n, quick: frames[] | null, full: frames[] | null, detector, state}
    this.focusKey = null; this.center = null; this.o = null; this.n = 0; this.ctrl = null; this.active = new Map();   // "dx,dy" -> key
  }

  /** Start a new focus point (tile 0,0). Keeps the cache; cancels pending neighbour requests. */
  focus(ra, dec, o) {
    if (this.ctrl) this.ctrl.abort();
    this.ctrl = new AbortController();
    this.center = { ra, dec }; this.o = { ...o }; this.n = 2 * o.half + 1; this.active = new Map();
    const m = this.findCached(ra, dec, o);
    this.focusKey = m ? m.key : keyOf(ra, dec, o);
    this.adopt();
  }

  /** Move the tile grid's origin to the main image's real centre (for stars with proper motion the image is centred on the
   *  star's position at the observation epoch, minutes of arc from its J2000 catalogue position). Keeps the cache key. */
  recenter(ra, dec) {
    if (!this.center || (Math.abs(this.center.ra - ra) * Math.cos(dec * D2R) < 5e-5 && Math.abs(this.center.dec - dec) < 5e-5)) return;   // < 0.2″: same grid
    this.center = { ra, dec }; this.active = new Map(); this.adopt();
  }

  /** A cached tile with the same options whose centre is within 0.5″ of (ra, dec) (tile centres computed from a neighbouring
   *  origin differ from exact keys by hundredths of an arcsecond), or null. */
  findCached(ra, dec, o) {
    const suffix = keyOf(0, 0, o).split('|').slice(1).join('|');
    for (const t of this.cache.values()) {
      if (t.key.split('|').slice(1).join('|') !== suffix) continue;
      const g = gnomonic(ra, dec, t.ra, t.dec);
      if (g && Math.hypot(g[0], g[1]) < 0.5) return t;
    }
    return null;
  }
  /** Put every cached tile that sits on the current grid (within 4 tiles) back in place, so moving the centre keeps what is loaded. */
  adopt() {
    if (!this.center) return;
    const suffix = keyOf(0, 0, this.o).split('|').slice(1).join('|'), size = this.n * PIX;
    for (const t of this.cache.values()) {
      if (t.n !== this.n || t.key.split('|').slice(1).join('|') !== suffix || !(t.quick || t.full)) continue;
      const g = gnomonic(this.center.ra, this.center.dec, t.ra, t.dec); if (!g) continue;
      const fx = -g[0] / size, fy = -g[1] / size, dx = Math.round(fx), dy = Math.round(fy);
      if ((!dx && !dy) || Math.abs(fx - dx) > 0.02 || Math.abs(fy - dy) > 0.02 || Math.max(Math.abs(dx), Math.abs(dy)) > 4) continue;
      this.active.set(dx + ',' + dy, t.key);
    }
  }

  /** Remember the main tile's frames (so returning to it is instant). which = 'quick' | 'full'. */
  storeMain(res, which) {
    const k = this.focusKey; if (!k) return;
    const t = this.cache.get(k) || { key: k, ra: this.center.ra, dec: this.center.dec, n: this.n, quick: null, full: null };
    t[which] = res; t.detector = res.detector; this.cache.delete(k); this.cache.set(k, t); this.trim();
  }
  /** Keep memory bounded: forget the oldest tiles (frames are big) that are not on the current grid. */
  trim(max = this.maxCached || 90) {
    if (this.cache.size <= max) return;
    const keep = new Set([this.focusKey, ...this.active.values()]);
    for (const k of [...this.cache.keys()]) { if (this.cache.size <= max) break; if (!keep.has(k)) this.cache.delete(k); }
  }
  /** The cached full result of the main tile, if any. */
  cachedMain() { const t = this.cache.get(this.focusKey); return t?.full || null; }
  /** The cached single quick image of the main tile (e.g. it was a neighbour before you double-clicked it), if any. */
  cachedMainQuick() { const t = this.cache.get(this.focusKey); return t?.quick || null; }

  tileAt(dx, dy) { const k = this.active.get(dx + ',' + dy); return k ? this.cache.get(k) : null; }
  /** Best frames available for a tile: the full video, else the single quick image. */
  framesOf(t) { return t?.full?.frames || t?.quick?.frames || null; }
  isLoaded(dx, dy) { return !!this.framesOf(this.tileAt(dx, dy)); }
  isLoading(dx, dy) { const t = this.tileAt(dx, dy); return !!t && t.state === 'loading' && !this.framesOf(t); }
  /** Has this neighbour its full video (not just the single quick image)? */
  isFull(dx, dy) { return !!this.tileAt(dx, dy)?.full; }
  /** Should the mouse over (dx, dy) glow? Unloaded neighbours next to loaded ones (click = load one image) and neighbours that
   *  show only their single image (click = load their video; double-click = make it the centre). */
  canHover(dx, dy) {
    if (!dx && !dy) return false;
    const t = this.tileAt(dx, dy);
    if (t && t.state === 'loading') return false;
    if (this.isLoaded(dx, dy)) return !t.full;
    return this.canLoad(dx, dy);
  }

  /** Load one tile at (dx, dy), 'quick' (one exposure) or 'full' (same options as the main tile). Uses the cache. */
  async load(dx, dy, which = 'quick', detector) {
    if (!this.center || (dx === 0 && dy === 0)) return null;
    const c = tileCenter(this.center.ra, this.center.dec, dx, dy, this.n), o = this.o;
    let t = this.cache.get(keyOf(c.ra, c.dec, o)) || this.findCached(c.ra, c.dec, o);
    if (!t) { const k = keyOf(c.ra, c.dec, o); t = { key: k, ra: c.ra, dec: c.dec, n: this.n, quick: null, full: null, state: 'idle' }; this.cache.set(k, t); }
    this.active.set(dx + ',' + dy, t.key);
    if (t[which] || (which === 'quick' && t.full)) return t;
    const signal = this.ctrl.signal;
    t.state = 'loading'; this.onChange();
    try {
      const index = await this.getIndex();
      const det = detector ?? (o.detector === 'auto' ? 'auto' : o.detector);
      const opts = which === 'quick'
        ? { ra: c.ra, dec: c.dec, detector: det, half: o.half, frames: 'exposures', maxFrames: 1, stack: 0, mode: 'sky', signal }
        : { ra: c.ra, dec: c.dec, detector: det, half: o.half, frames: o.frames, stack: o.stack, mode: 'sky', signal };
      const res = await this.getBlink(index, opts);
      t[which] = res; t.detector = res.detector; t.state = 'ok'; this.trim();
    } catch (e) {
      t.state = e.name === 'AbortError' ? 'idle' : 'failed'; t.error = e.message;
    }
    this.onChange();
    return t;
  }

  /** Load the 8 neighbours (ring 1), all in parallel. */
  ring(which, detector) {
    const jobs = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) jobs.push(this.load(dx, dy, which, detector));
    return Promise.allSettled(jobs);
  }

  /** Loaded tiles in the active grid: [{dx, dy, tile}] (excluding the main tile). */
  loadedTiles() {
    const out = [];
    for (const [pos, k] of this.active) { const [dx, dy] = pos.split(',').map(Number); const t = this.cache.get(k); if (this.framesOf(t)) out.push({ dx, dy, tile: t }); }
    return out;
  }
  /** Ring-1 positions not loaded yet (for the blurred "extend" preview). */
  pendingRing() {
    const out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && !this.isLoaded(dx, dy)) out.push({ dx, dy });
    return out;
  }
  /** Can (dx, dy) be clicked to load? (not loaded, next to a loaded tile or the main tile, at most 3 tiles out) */
  canLoad(dx, dy) {
    if ((!dx && !dy) || this.isLoaded(dx, dy) || this.isLoading(dx, dy) || Math.max(Math.abs(dx), Math.abs(dy)) > 4) return false;     // up to 9x9 fields
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { if (!i && !j) continue; const x = dx + i, y = dy + j; if ((!x && !y) || this.isLoaded(x, y)) return true; }
    return false;
  }
  stats() { let n = 0, full = 0; for (const t of this.cache.values()) { if (t.quick || t.full) n++; if (t.full) full++; } return { tiles: n, full }; }
}

/** The frame of `frames` nearest in time to mjd. */
export function nearestFrame(frames, mjd) {
  let best = frames[0];
  for (const f of frames) if (Math.abs(f.mjd - mjd) < Math.abs(best.mjd - mjd)) best = f;
  return best;
}
