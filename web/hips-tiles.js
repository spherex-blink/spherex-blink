// hips-tiles.js: sharp SPHEREx sky on the dome, streamed as HiPS tiles where the user is looking.
//
// The HiPS (IRSA, SPHEREx DR1 all-sky cube): hips_order = 5 (max), hips_tile_width = 512, hips_tile_format = png
// (8-bit grey palette), hips_frame = equatorial, hips_cube_depth = 102 (hips_cube_firstframe = 1 is only the default view).
// Tile URL: <base>/Norder{K}/Dir{D}/Npix{N}.png for slice 0, <base>/Norder{K}/Dir{D}/Npix{N}_{slice}.png for slice 1..101,
// D = floor(N / 10000) * 10000. CORS: Access-Control-Allow-Origin: *.
// Texel size: 51.5" at order 3, 25.8" at order 4, 12.9" at order 5 (native). The Allsky_<slice>.png dome is ~10'/texel.
//
// Inside a tile image, column = HEALPix iy and row (from the top) = HEALPix ix, the same as in the Allsky mosaic
// (see healpixToEquirect in app.js).
//
// API
//   import { createHipsLayer } from './hips-tiles.js';
//   const hips = createHipsLayer({ THREE, parent: sky, radius: 50, base, slice: 17, maxTiles: 48, cacheSize: 150 });
//   hips.update(camera, { fovDeg, inXR, viewHeight, maxTiles, order })   // every animation frame
//       camera     : the camera that renders (in VR: renderer.xr.getCamera())
//       fovDeg     : vertical field of view in degrees (desktop; ignored in XR)
//       inXR       : true in WebXR; then the view is a ~50 deg cone around where the head points, texel ~3'/px
//       viewHeight : canvas height in CSS px (default innerHeight)
//       maxTiles   : override the cap on tiles at the chosen order (default: the one given at creation)
//       order      : force a HiPS order (3..5)
//   hips.setSlice(slice)   // 0..101, same numbering as Allsky_<slice>.png
//   hips.setOpacity(a)     // 0..1, multiplies every tile
//   hips.setVisible(bool)
//   hips.dispose()
//   hips.stats()  -> { order, visible, loaded, pending, cached }
//
// The tiles sit slightly inside the dome (radius * (0.999 - 0.0002 K)), use depthWrite false and a negative renderOrder,
// so they draw over the opaque dome but under other transparent things (grid lines, markers) and behind nearer opaque
// meshes (the cutout plane). Their colours follow the dome: tone curve v = (i/255)^0.55 then (0.86, 0.92, 1.08 + 6/255).

const TILE_DEG = 58.6323;                       // sqrt(4 pi / 12) in degrees: the side of an order-0 HEALPix pixel
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];
const HALF_PI = Math.PI / 2, D2R = Math.PI / 180;
const MAX_CONCURRENT = 6, FADE_MS = 250, RETRY_MS = 2000, VR_PX_DEG = 0.05, VR_CONE_DEG = 50;

const spread = (v) => { v &= 0xffff; v = (v | (v << 8)) & 0x00ff00ff; v = (v | (v << 4)) & 0x0f0f0f0f; v = (v | (v << 2)) & 0x33333333; return (v | (v << 1)) & 0x55555555; };
const compact = (v) => { v &= 0x55555555; v = (v | (v >>> 1)) & 0x33333333; v = (v | (v >>> 2)) & 0x0f0f0f0f; v = (v | (v >>> 4)) & 0x00ff00ff; return (v | (v >>> 8)) & 0xffff; };

// HEALPix face coordinates (x, y in [0, 1] along ix, iy) -> unit vector in the app's sky frame
// (x = cos d cos a, y = sin d, z = -cos d sin a). Same as healpix_base::xyf2loc.
function xyf2dir(x, y, face, out) {
  const jr = JRLL[face] - x - y; let nr, z;
  if (jr < 1) { nr = jr; z = 1 - nr * nr / 3; } else if (jr > 3) { nr = 4 - jr; z = nr * nr / 3 - 1; } else { nr = 1; z = (2 - jr) * 2 / 3; }
  let t = JPLL[face] * nr + x - y; if (t < 0) t += 8; if (t >= 8) t -= 8;
  const phi = nr < 1e-15 ? 0 : (Math.PI / 4) * t / nr, s = Math.sqrt(Math.max(0, 1 - z * z));
  out.x = s * Math.cos(phi); out.y = z; out.z = -s * Math.sin(phi);
  return out;
}

// unit vector (sky frame) -> NESTED pixel index at the given order (standard ang2pix_nest)
function dir2pixNest(order, vx, vy, vz) {
  const nside = 1 << order, z = Math.max(-1, Math.min(1, vy)), za = Math.abs(z);
  let phi = Math.atan2(-vz, vx); if (phi < 0) phi += 2 * Math.PI;
  let tt = phi / HALF_PI; if (tt >= 4) tt -= 4;
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
  return face * nside * nside + (spread(ix) | (spread(iy) << 1));
}

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = /* glsl */`
uniform sampler2D map; uniform float opacity;
varying vec2 vUv;
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void main() {
  float v = pow(texture2D(map, vUv).r, 0.55);
  vec3 c = vec3(v * 0.86, v * 0.92, min(1.0, v * 1.08 + 6.0 / 255.0));   // the dome's look, in display (sRGB) values
  gl_FragColor = vec4(srgbToLinear(c), opacity);
  #include <colorspace_fragment>
}`;

export function createHipsLayer({
  THREE, parent, radius = 50, base = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube',
  slice = 17, maxTiles = 48, cacheSize = 150, maxOrder = 5, minOrder = 3, tileWidth = 512, ext = 'png',
  localBase = null, localOrders = [], localSlices = [], localExt = 'webp',     // a copy on our own site (e.g. the zoomed-out level): tried first, NASA as fallback
}) {
  const group = new THREE.Group(); group.name = 'hips-tiles'; parent.add(group);
  const cache = new Map();                 // key -> entry, in LRU order (oldest first; touched entries are re-inserted)
  let curSlice = slice, opacity = 1, frame = 0, inflight = 0, dirtyWant = true, dirtyShow = false, needPump = false, disposed = false;
  let want = [], wantSet = new Set(), shown = [], fading = 0, curOrder = minOrder;
  const lastFwd = new THREE.Vector3(0, 0, 0), fwd = new THREE.Vector3(), qInv = new THREE.Quaternion(), tmpV = new THREE.Vector3();
  let lastFov = 0, lastMax = 0, lastXR = null, lastForced = null;

  // optional: read the properties once to confirm max order / tile width (falls back to the defaults above)
  fetch(`${base}/properties`).then((r) => r.ok ? r.text() : '').then((txt) => {
    const get = (k) => { const m = txt.match(new RegExp(`^${k}\\s*=\\s*(\\S+)`, 'm')); return m ? m[1] : null; };
    const o = parseInt(get('hips_order')), w = parseInt(get('hips_tile_width')), f = get('hips_tile_format');
    if (o >= minOrder) maxOrder = Math.min(maxOrder, o);
    if (w > 0) tileWidth = w;
    if (f && !f.split(/\s+/).includes(ext)) ext = f.split(/\s+/)[0];
  }).catch(() => { /* offline: keep defaults */ });

  const keyOf = (s, k, n) => `${s}/${k}/${n}`;
  const path = (k, n, s, e = ext) => `Norder${k}/Dir${Math.floor(n / 10000) * 10000}/Npix${n}${s ? '_' + s : ''}.${e}`;
  const isLocal = (k, s) => !!localBase && localOrders.includes(k) && localSlices.includes(s);
  // first try: our own (smaller) copy when we have one; a retry goes to NASA's server
  const urlOf = (k, n, s, tries = 1) => (isLocal(k, s) && tries <= 1 ? `${localBase}/${path(k, n, s, localExt)}` : `${base}/${path(k, n, s)}`);

  function entryFor(k, n, create) {
    const key = keyOf(curSlice, k, n); let e = cache.get(key);
    if (!e && create) { e = { key, k, n, slice: curSlice, state: 'idle', tries: 0, retryAt: 0, ctrl: null, tex: null, mesh: null, fadeStart: -1, used: 0 }; cache.set(key, e); }
    return e;
  }

  function buildMesh(e, bitmap) {
    const tex = new THREE.Texture(bitmap);
    tex.format = THREE.RedFormat; tex.flipY = false; tex.colorSpace = THREE.NoColorSpace; tex.anisotropy = 4;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true; tex.needsUpdate = true;
    tex.onUpdate = () => { if (bitmap.close) bitmap.close(); tex.image = null; tex.onUpdate = null; };     // the pixels live on the GPU now: free the decoded copy (1 MB per tile)
    const S = e.k >= 5 ? 8 : 16, K = e.k, side = 1 << K, face = e.n >> (2 * K), sub = e.n & ((1 << (2 * K)) - 1);
    const tx = compact(sub), ty = compact(sub >>> 1), r = radius * (0.999 - 0.0002 * K);
    const pos = new Float32Array((S + 1) * (S + 1) * 3), uv = new Float32Array((S + 1) * (S + 1) * 2), idx = [];
    for (let i = 0; i <= S; i++) for (let j = 0; j <= S; j++) {     // i along ix (image rows), j along iy (image columns)
      const p = i * (S + 1) + j;
      xyf2dir((tx + i / S) / side, (ty + j / S) / side, face, tmpV);
      pos[p * 3] = tmpV.x * r; pos[p * 3 + 1] = tmpV.y * r; pos[p * 3 + 2] = tmpV.z * r;
      uv[p * 2] = j / S; uv[p * 2 + 1] = i / S;                    // flipY = false: v = 0 is the top row of the PNG
    }
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) { const a = i * (S + 1) + j, b = a + 1, c = a + S + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
    g.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: tex }, opacity: { value: 0 } }, vertexShader: VERT, fragmentShader: FRAG,
      side: THREE.DoubleSide, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(g, mat); mesh.renderOrder = -20 + K; mesh.visible = false; mesh.matrixAutoUpdate = false;
    group.add(mesh); e.tex = tex; e.mesh = mesh;
  }

  function freeEntry(e) {
    if (e.ctrl) { e.ctrl.abort(); e.ctrl = null; }
    if (e.mesh) { group.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh.material.dispose(); e.mesh = null; }
    if (e.tex) { if (e.tex.image && e.tex.image.close) e.tex.image.close(); e.tex.dispose(); e.tex = null; }
    cache.delete(e.key);
  }

  function load(e) {
    const ctrl = new AbortController(); e.ctrl = ctrl; e.state = 'loading'; e.tries++; inflight++;
    const sliceAtStart = e.slice;
    fetch(urlOf(e.k, e.n, e.slice, e.tries), { signal: ctrl.signal, mode: 'cors' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then((b) => createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
      .then((bmp) => {
        if (disposed || e.ctrl !== ctrl || !cache.has(e.key) || sliceAtStart !== e.slice) { bmp.close && bmp.close(); return; }
        buildMesh(e, bmp); e.state = 'ready'; e.fadeStart = -1;
      })
      .catch((err) => {
        if (e.ctrl !== ctrl) return;                                    // aborted on purpose (stale)
        if (e.tries < 2) { e.state = 'idle'; e.retryAt = performance.now() + (isLocal(e.k, e.slice) ? 0 : RETRY_MS); setTimeout(() => { needPump = true; }, RETRY_MS + 10); }
        else e.state = 'failed';                                        // give up: the blurry dome shows through
      })
      .finally(() => { inflight--; if (e.ctrl === ctrl) e.ctrl = null; dirtyShow = true; needPump = true; });
  }

  function pump(now) {
    needPump = false;
    for (let i = 0; i < want.length && inflight < MAX_CONCURRENT; i++) {
      const e = want[i];
      if (e.state !== 'idle') continue;
      if (e.retryAt > now) { needPump = true; continue; }
      if (!cache.has(e.key)) continue;
      load(e);
    }
  }

  // the tile set at the chosen order around the forward direction
  function recomputeWant(order, coneDeg, cap) {
    const side = TILE_DEG / (1 << order), step = side * 0.35 * D2R, rad = Math.min(coneDeg + side * 0.75, 180) * D2R;
    // orthonormal basis around fwd
    const fx = fwd.x, fy = fwd.y, fz = fwd.z;
    let ux = 0, uy = 1, uz = 0; if (Math.abs(fy) > 0.9) { ux = 1; uy = 0; }
    let rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux; const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
    ux = ry * fz - rz * fy; uy = rz * fx - rx * fz; uz = rx * fy - ry * fx;
    const pix = new Map(), n = Math.ceil(rad / step);
    pix.set(dir2pixNest(order, fx, fy, fz), 0);
    for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
      const rho = Math.hypot(a, b) * step; if (rho > rad || rho === 0) continue;
      const c = Math.cos(rho), s = Math.sin(rho) / (Math.hypot(a, b));
      const dx = c * fx + s * (a * rx + b * ux), dy = c * fy + s * (a * ry + b * uy), dz = c * fz + s * (a * rz + b * uz);
      const p = dir2pixNest(order, dx, dy, dz); if (!pix.has(p)) pix.set(p, 0);
    }
    const side2 = 1 << order, list = [];
    for (const p of pix.keys()) {
      const face = p >> (2 * order), sub = p & ((1 << (2 * order)) - 1);
      xyf2dir((compact(sub) + 0.5) / side2, (compact(sub >>> 1) + 0.5) / side2, face, tmpV);
      list.push([p, -(tmpV.x * fx + tmpV.y * fy + tmpV.z * fz)]);
    }
    list.sort((u, v) => u[1] - v[1]);
    if (list.length > cap) list.length = cap;
    want = list.map(([p]) => entryFor(order, p, true));
    wantSet = new Set(want);
    // cancel requests that are no longer wanted
    for (const e of cache.values()) if (e.state === 'loading' && !wantSet.has(e)) { e.ctrl.abort(); e.ctrl = null; e.state = 'idle'; e.tries = Math.max(0, e.tries - 1); }
    needPump = true; dirtyShow = true;
  }

  function show(e, list) { if (e.used !== frame) { e.used = frame; list.push(e); } }
  function readyAncestor(e) {
    for (let k = e.k - 1, n = e.n >> 2; k >= minOrder; k--, n >>= 2) {
      const a = cache.get(keyOf(curSlice, k, n));
      if (a && a.state === 'ready') return a;
    }
    return null;
  }
  function addReadyDescendants(k, n, list, depth) {
    if (depth === 0 || k + 1 > maxOrder) return;
    for (let c = 0; c < 4; c++) {
      const d = cache.get(keyOf(curSlice, k + 1, (n << 2) | c));
      if (d && d.state === 'ready') show(d, list); else addReadyDescendants(k + 1, (n << 2) | c, list, depth - 1);
    }
  }

  function refreshShow(now) {
    dirtyShow = false; frame++;
    const next = [];
    for (const e of want) {
      if (e.state === 'ready') {
        show(e, next);
        if (e.fadeStart < 0 || now - e.fadeStart < FADE_MS) { const a = readyAncestor(e); if (a) show(a, next); }
      } else {
        const a = readyAncestor(e); if (a) show(a, next);
        addReadyDescendants(e.k, e.n, next, 2);
      }
    }
    for (const e of shown) if (e.used !== frame && e.mesh) e.mesh.visible = false;
    fading = 0;
    for (const e of next) {
      if (e.fadeStart < 0) e.fadeStart = now;
      const f = Math.min(1, (now - e.fadeStart) / FADE_MS); if (f < 1) fading++;
      e.mesh.visible = true; e.mesh.material.uniforms.opacity.value = f * opacity;
      cache.delete(e.key); cache.set(e.key, e);                        // LRU touch
    }
    for (const e of want) { cache.delete(e.key); cache.set(e.key, e); }
    shown = next;
    // forget entries without data that are no longer wanted, then evict the least recently used loaded tiles
    let held = 0;
    for (const e of cache.values()) {
      if (e.state === 'ready') held++;
      else if (e.state !== 'loading' && !wantSet.has(e)) cache.delete(e.key);
    }
    if (held > cacheSize) {
      for (const e of cache.values()) {
        if (held <= cacheSize) break;
        if (e.state !== 'ready' || e.used === frame || wantSet.has(e)) continue;
        freeEntry(e); held--;
      }
    }
  }

  function update(camera, opts = {}) {
    if (disposed) return;
    const now = performance.now(), inXR = !!opts.inXR;
    camera.getWorldDirection(fwd);
    parent.getWorldQuaternion(qInv); qInv.invert(); fwd.applyQuaternion(qInv).normalize();
    // the first VR frame can come before the headset pose (a zero matrix -> NaN direction); storing that as the last view
    // would make every later "has the view moved?" test false, so the sky would never sharpen in the headset (found 15.11)
    if (!Number.isFinite(fwd.x + fwd.y + fwd.z) || fwd.lengthSq() < 0.5) return;
    const fovDeg = inXR ? 100 : (opts.fovDeg || camera.fov || 60), cap = opts.maxTiles || maxTiles;
    // order: lowest K whose texel is <= 1.5 screen px
    let order = opts.order;
    if (!order) {
      const pxDeg = inXR ? VR_PX_DEG : fovDeg / (opts.viewHeight || (typeof innerHeight !== 'undefined' ? innerHeight : 1000));
      order = minOrder;
      while (order < maxOrder && TILE_DEG / (1 << order) / tileWidth > 1.5 * pxDeg) order++;
    }
    order = Math.max(minOrder, Math.min(maxOrder, order));
    const side = TILE_DEG / (1 << order);
    if (!dirtyWant) {
      const moved = lastFwd.dot(fwd) < Math.cos(side / 4 * D2R);
      if (moved || order !== curOrder || Math.abs(fovDeg - lastFov) > 0.1 * lastFov || cap !== lastMax || inXR !== lastXR || opts.order !== lastForced) dirtyWant = true;
    }
    if (dirtyWant) {
      dirtyWant = false; curOrder = order; lastFwd.copy(fwd); lastFov = fovDeg; lastMax = cap; lastXR = inXR; lastForced = opts.order;
      let coneDeg;
      if (inXR) coneDeg = VR_CONE_DEG;
      else {
        const aspect = camera.aspect || 1.6, t = Math.tan(fovDeg / 2 * D2R);
        coneDeg = Math.min(89, Math.atan(t * Math.sqrt(1 + aspect * aspect)) / D2R);
      }
      recomputeWant(order, coneDeg, cap);
    }
    if (needPump && inflight < MAX_CONCURRENT) pump(now);
    if (dirtyShow) refreshShow(now);
    else if (fading) {
      let still = 0;
      for (let i = 0; i < shown.length; i++) {
        const e = shown[i], f = Math.min(1, (now - e.fadeStart) / FADE_MS);
        e.mesh.material.uniforms.opacity.value = f * opacity; if (f < 1) still++;
      }
      if (!still) dirtyShow = true;                                     // fades done: hide the coarser parents next frame
      fading = still;
    }
  }

  function setSlice(s) {
    if (s === curSlice) return;
    curSlice = s;
    for (const e of cache.values()) if (e.state === 'loading') { e.ctrl.abort(); e.ctrl = null; e.state = 'idle'; }
    for (const e of shown) if (e.mesh) e.mesh.visible = false;
    shown = []; want = []; wantSet = new Set(); dirtyWant = true;
  }

  function setOpacity(a) {
    opacity = a;
    for (const e of shown) { const f = Math.min(1, (performance.now() - e.fadeStart) / FADE_MS); e.mesh.material.uniforms.opacity.value = f * opacity; }
  }

  function dispose() {
    disposed = true;
    for (const e of [...cache.values()]) freeEntry(e);
    parent.remove(group); shown = []; want = [];
  }

  function stats() {
    let loaded = 0, queued = 0;
    for (const e of cache.values()) if (e.state === 'ready') loaded++;
    for (const e of want) if (e.state === 'idle') queued++;
    return { order: curOrder, visible: shown.length, loaded, pending: inflight + queued, cached: cache.size };
  }

  const setCacheSize = (n) => { cacheSize = n; dirtyShow = true; };     // the headset has little memory: fewer tiles are kept there
  return { update, setSlice, setCacheSize, setOpacity, setVisible: (v) => { group.visible = v; }, dispose, stats, group, _dir2pixNest: dir2pixNest, _xyf2dir: xyf2dir };
}
