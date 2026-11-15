// VR loading panel: the DOM loader card (ui-extras.js createLoader) and the "Loading D2 (1.1-1.6 um)..." overlay
// (app-ux.js busy) are invisible inside a headset, so this mirrors them on ONE canvas texture on a small panel in front of you.
// One canvas, one texture, one material for the whole session: nothing is created per update.
const COW_SRC = new URL('./assets/cow/cow-rocket-192.png', document.baseURI).href;

export function createVrLoader({ THREE, scene, loader, busy }) {
  const W = 768, H = 520, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d'), tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9 * H / W), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
  mesh.renderOrder = 30; mesh.visible = false; scene.add(mesh);
  const cow = new Image(); cow.src = COW_SRC;
  const stars = Array.from({ length: 40 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() }));
  const tmp = new THREE.Vector3(), fwd = new THREE.Vector3(), goal = new THREE.Vector3(), eye = new THREE.Vector3();
  let shown = false, lastDraw = 0;

  const busyInfo = () => {      // text of the desktop "Loading D2 ..." box, read from its DOM (app-ux.js owns it)
    if (!busy.on) return null;
    const el = document.getElementById('detBusy'); if (!el || el.hidden) return null;
    const fill = el.querySelector('.bar i'), bar = el.querySelector('.bar');
    const f = bar && !bar.classList.contains('ind') && fill ? parseFloat(fill.style.width) / 100 : null;
    return { head: el.firstElementChild?.textContent || '', small: el.querySelector('small')?.textContent || '', f: Number.isFinite(f) ? f : null };
  };
  function bar(x, y, w, f, t) {
    c.fillStyle = 'rgba(148,163,255,.16)'; c.beginPath(); c.roundRect(x, y, w, 12, 6); c.fill();
    const g = c.createLinearGradient(x, 0, x + w, 0); g.addColorStop(0, '#8b93ff'); g.addColorStop(1, '#f2c46d'); c.fillStyle = g;
    c.beginPath();
    if (f == null) { const p = (t / 1.3) % 1, bw = w * 0.38, bx = x - bw + p * (w + bw); c.save(); c.beginPath(); c.roundRect(x, y, w, 12, 6); c.clip(); c.roundRect(bx, y, bw, 12, 6); c.fill(); c.restore(); }
    else { c.roundRect(x, y, Math.max(12, w * f), 12, 6); c.fill(); }
  }
  function draw(t, dt, st, b) {
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(14,18,32,.92)'; c.beginPath(); c.roundRect(0, 0, W, H, 40); c.fill();
    c.strokeStyle = 'rgba(148,163,255,.25)'; c.lineWidth = 4; c.stroke();
    // star streaks rushing past behind the cow
    c.save(); c.beginPath(); c.roundRect(24, 24, W - 48, 190, 26); c.clip(); c.fillStyle = '#070a14'; c.fillRect(24, 24, W - 48, 190);
    c.lineCap = 'round';
    for (const s of stars) {
      s.x -= (0.25 + s.z * 1.1) * dt * 0.9; if (s.x < -0.2) { s.x = 1.05; s.y = Math.random(); s.z = Math.random(); }
      const px = 24 + s.x * (W - 48), py = 24 + s.y * 190, len = 10 + s.z * 70;
      const g = c.createLinearGradient(px, py, px + len, py); g.addColorStop(0, `rgba(${s.z > 0.6 ? '230,233,245' : '139,147,255'},${0.35 + s.z * 0.6})`); g.addColorStop(1, 'rgba(139,147,255,0)');
      c.strokeStyle = g; c.lineWidth = 1.5 + s.z * 2.5; c.beginPath(); c.moveTo(px, py); c.lineTo(px + len, py); c.stroke();
    }
    c.restore();
    if (cow.complete && cow.naturalWidth) { const bob = Math.sin(t * 2.6) * 5, S = 180; c.save(); c.translate(W / 2, 119 + bob); c.rotate(Math.sin(t * 2) * 0.05 - 0.1); c.drawImage(cow, -S / 2, -S / 2, S, S); c.restore(); }
    c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.direction = 'ltr';
    let y = 262;
    if (st.visible) {
      c.fillStyle = '#e6e9f5'; c.font = '600 34px system-ui, sans-serif'; c.fillText(String(st.title).slice(0, 38), W / 2, y); y += 40;
      c.fillStyle = 'rgba(230,233,245,.7)'; c.font = '26px system-ui, sans-serif'; c.fillText(String(st.sub).slice(0, 52), W / 2, y); y += 24;
      bar(64, y, W - 128, st.fraction, t); y += 52;
      c.fillStyle = 'rgba(242,196,109,.9)'; c.font = 'italic 22px system-ui, sans-serif'; c.fillText(st.quip || '', W / 2, y); y += 26;
    }
    if (b) {      // "Loading D2 (1.1–1.6 µm)…" + what it is doing
      y = Math.max(y + 28, st.visible ? 420 : 290);
      c.fillStyle = '#e6e9f5'; c.font = '600 32px system-ui, sans-serif'; c.fillText(b.head.slice(0, 44), W / 2, y); y += 36;
      c.fillStyle = '#8e98b8'; c.font = '24px system-ui, sans-serif'; c.fillText(b.small.slice(0, 56), W / 2, y); y += 22;
      bar(64, y, W - 128, b.f, t);
    }
    tex.needsUpdate = true;
  }
  function follow(camera, snap) {      // in front of you, a little below eye level; eases after your head so it never gets lost
    camera.getWorldPosition(eye); fwd.set(0, 0, -1).transformDirection(camera.matrixWorld); fwd.y = Math.max(-0.2, Math.min(0.2, fwd.y)); fwd.normalize();
    goal.copy(eye).addScaledVector(fwd, 1.25); goal.y = eye.y - 0.2;
    if (snap) mesh.position.copy(goal); else mesh.position.lerp(goal, 0.06);
    tmp.copy(eye); mesh.lookAt(tmp);
  }
  /** call every frame; camera = renderer.xr.getCamera() */
  function update(inXR, camera) {
    const now = performance.now();
    const st = loader.state, b = inXR ? busyInfo() : null, want = inXR && (st.visible || !!b);
    if (!want) { if (shown) { shown = false; mesh.visible = false; } return; }
    if (!shown) { shown = true; mesh.visible = true; follow(camera, true); lastDraw = 0; }
    else follow(camera, false);
    if (now - lastDraw > 66) { draw(now / 1000, Math.min(0.2, (now - lastDraw) / 1000), st, b); lastDraw = now; }
  }
  return { update, mesh, tex };
}
