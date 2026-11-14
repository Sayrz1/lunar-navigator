// 3D view of a landing region: LOLA terrain lit by the Sun from its true direction,
// Earth in the sky, and markers for the centre, best spot and the user's own point.
//
// Scene units are km. Three's x = polar stereographic x, three's z = -stereographic y,
// both measured from the middle of the region box; y is up (true scale, no exaggeration).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { gsap } from 'gsap';
import { fromStereo, toStereo } from '../core/horizon.js';
import { regionSampler } from '../core/terrain.js';
import { heightRamp } from './charts.js';

const DEG = Math.PI / 180;

function discTexture(draw, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const sunTexture = () => discTexture((ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,245,1)');
  g.addColorStop(0.12, 'rgba(255,240,200,1)');
  g.addColorStop(0.2, 'rgba(255,190,90,0.55)');
  g.addColorStop(1, 'rgba(255,140,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
});

const earthTexture = () => discTexture((ctx, s) => {
  const r = s * 0.36, c = s / 2;
  const glow = ctx.createRadialGradient(c, c, r * 0.9, c, c, s / 2);
  glow.addColorStop(0, 'rgba(90,169,255,0.45)');
  glow.addColorStop(1, 'rgba(90,169,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, s, s);
  const body = ctx.createRadialGradient(c - r * 0.3, c - r * 0.3, r * 0.1, c, c, r);
  body.addColorStop(0, '#9fd0ff');
  body.addColorStop(0.6, '#2f6fc4');
  body.addColorStop(1, '#0d2a55');
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(c, c, r, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (const [dx, dy, w] of [[-0.3, -0.2, 0.35], [0.2, 0.25, 0.3], [0.1, -0.45, 0.25]]) {
    ctx.beginPath(); ctx.ellipse(c + dx * r, c + dy * r, w * r, w * r * 0.25, 0.4, 0, 2 * Math.PI); ctx.fill();
  }
});

// Colour ramps, sRGB 0-1
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function sunRamp(v) {
  const stops = [[0.05, 0.06, 0.09], [0.32, 0.18, 0.12], [0.85, 0.42, 0.1], [1, 0.75, 0.35], [1, 0.95, 0.8]];
  const f = Math.min(0.9999, Math.max(0, v)) * (stops.length - 1);
  const i = Math.floor(f);
  return mix(stops[i], stops[i + 1], f - i);
}

export class Stage {
  constructor(container, { onPick, labels } = {}) {
    this.container = container;
    this.onPick = onPick;
    this.labels = labels; // { sun, earth } HTML elements placed over the canvas
    this.layer = 'relief';
    this.mode = 'overview';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.append(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#030305');
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 88 * DEG;

    this.sunLight = new THREE.DirectionalLight('#fff4e0', 3.2);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.02;
    this.scene.add(this.sunLight, this.sunLight.target);
    this.studio = new THREE.DirectionalLight('#ffffff', 1.4);
    this.scene.add(this.studio, this.studio.target);
    this.earthshine = new THREE.HemisphereLight('#6d8fbf', '#000000', 0.08);
    this.scene.add(this.earthshine);

    this.sky = new THREE.Group();
    this.scene.add(this.sky);
    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTexture(), depthWrite: false, transparent: true, fog: false }));
    this.earthSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: earthTexture(), depthWrite: false, transparent: true, fog: false }));
    this.sky.add(this.sunSprite, this.earthSprite);
    this.markers = new THREE.Group();
    this.scene.add(this.markers);
    this.ground = new THREE.Group(); // skyline and sky tracks for the stand-on-site view
    this.ground.visible = false;
    this.scene.add(this.ground);

    this.raycaster = new THREE.Raycaster();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.visible = true;
    new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; }).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      if (!this.visible || this.container.hidden) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.placeLabels();
    });
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // g: decoded region grid from core/terrain.js
  setTerrain(g, { animate = true } = {}) {
    this.g = g;
    this.sample = regionSampler(g);
    const n = g.cells, size = g.x1 - g.x0;
    this.size = size;
    this.cx = (g.x0 + g.x1) / 2;
    this.cy = (g.y0 + g.y1) / 2;
    const heights = Array.from(g.height);
    this.midM = (Math.min(...heights) + Math.max(...heights)) / 2;

    const geo = new THREE.PlaneGeometry(size - g.cellKm, size - g.cellKm, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let k = 0; k < n * n; k++) pos.setY(k, (g.height[k] - this.midM) / 1000);
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));

    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.scene.add(this.mesh);
    this.paint();

    // stars on a far shell
    if (this.stars) this.scene.remove(this.stars);
    const R = size * 14, pts = [];
    for (let i = 0; i < 1800; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * 2 * Math.PI, s = Math.sqrt(1 - u * u);
      pts.push(R * s * Math.cos(a), R * Math.abs(u) * 0.9 + R * 0.02, R * s * Math.sin(a));
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#cfd6e6', size: size * 0.012, sizeAttenuation: true, transparent: true, opacity: 0.8 }));
    this.scene.add(this.stars);
    this.camera.far = size * 40;
    this.camera.near = size * 0.001;
    this.camera.updateProjectionMatrix();

    const cam = this.sunLight.shadow.camera;
    cam.left = cam.bottom = -size * 0.75;
    cam.right = cam.top = size * 0.75;
    cam.near = 0.1; cam.far = size * 6;
    cam.updateProjectionMatrix();

    this.controls.minDistance = size * 0.08;
    this.controls.maxDistance = size * 3;
    this.controls.target.set(0, 0, 0);
    // the camera is placed on the next setSky call, with the Sun behind it
    this.pendingCamera = { animate };
  }

  placeCamera() {
    const pending = this.pendingCamera;
    if (!pending || !this.size) return;
    this.pendingCamera = null;
    const s = this.size;
    let dir = new THREE.Vector3(0.54, 0, 0.84);
    if (this.skyState) {
      const sun = this.direction(this.skyState.sun.az, 0);
      // a little off the Sun's line so the shadows show depth
      dir = sun.applyAxisAngle(new THREE.Vector3(0, 1, 0), 30 * DEG);
    }
    const end = new THREE.Vector3(dir.x * s * 1.1, s * 0.78, dir.z * s * 1.1);
    if (pending.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.camera.position.copy(end).multiplyScalar(1.9);
      gsap.to(this.camera.position, { x: end.x, y: end.y, z: end.z, duration: 2.2, ease: 'power3.out' });
    } else {
      this.camera.position.copy(end);
    }
  }

  setLayer(name) {
    this.layer = name;
    this.paint();
    this.applyLight();
  }

  paint() {
    if (!this.mesh) return;
    const g = this.g, col = this.mesh.geometry.attributes.color, c = new THREE.Color();
    const span = Math.max(1, g.maxM - g.minM);
    for (let k = 0; k < g.cells * g.cells; k++) {
      let rgb;
      if (this.layer === 'sun') rgb = sunRamp(g.sun[k] / 250);
      else if (this.layer === 'height') rgb = heightRamp((g.height[k] - g.minM) / span).map(v => v / 255);
      else {
        const grey = 0.5 + 0.12 * ((g.height[k] - g.minM) / span);
        rgb = [grey, grey * 0.985, grey * 0.96];
        if (this.layer === 'ice') rgb = mix(rgb, [0.45, 0.9, 1], Math.min(1, (g.psr[k] / 250) * 1.4));
      }
      c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
      col.setXYZ(k, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  // Unit vector in scene space for an azimuth / elevation seen at stereographic point
  // `at` (default: the middle of the box). North is the direction away from the pole.
  direction(az, el, at = [this.cx, this.cy]) {
    const lon = Math.atan2(at[0], at[1]);
    const north = [Math.sin(lon), Math.cos(lon)];
    const east = [Math.cos(lon), -Math.sin(lon)];
    const a = az * DEG, e = el * DEG;
    const dx = north[0] * Math.cos(a) + east[0] * Math.sin(a);
    const dy = north[1] * Math.cos(a) + east[1] * Math.sin(a);
    return new THREE.Vector3(dx * Math.cos(e), Math.sin(e), -dy * Math.cos(e));
  }

  // sky: { sun: {az, el}, earth: {az, el}, sunlit }
  setSky(sky) {
    this.skyState = sky;
    if (!this.size) return;
    const s = this.size, R = s * 10;
    const sunDir = this.direction(sky.sun.az, sky.sun.el);
    this.sunLight.position.copy(sunDir).multiplyScalar(s * 3);
    this.sunLight.target.position.set(0, 0, 0);
    if (this.mode === 'ground') {
      this.placeGroundSky();
    } else {
      const earthDir = this.direction(sky.earth.az, sky.earth.el);
      this.sunSprite.position.copy(sunDir).multiplyScalar(R);
      this.sunSprite.scale.setScalar(R * Math.tan(0.53 * DEG) * 14);
      this.earthSprite.position.copy(earthDir).multiplyScalar(R);
      this.earthSprite.scale.setScalar(R * Math.tan(1.9 * DEG) * 4);
    }
    this.applyLight();
    this.placeCamera();
  }

  applyLight() {
    const real = this.layer === 'relief';
    // no cut-off at 0 deg: from high ground the Sun can be below the flat horizontal and still
    // shine on the peaks, so the terrain shadows decide what is lit
    this.sunLight.visible = real;
    this.studio.visible = !real;
    this.studio.position.set(-this.size * 0.6 || -1, this.size || 1, this.size * 0.4 || 1);
    this.earthshine.intensity = real ? 0.45 : 0.9;
    this.renderer.toneMappingExposure = real ? 1.15 : 1;
  }

  heightAt(lat, lon) {
    const [x, y] = toStereo(lat, lon);
    const h = this.sample(x, y);
    return h === h ? h : this.midM;
  }

  toScene(lat, lon) {
    const [x, y] = toStereo(lat, lon);
    return new THREE.Vector3(x - this.cx, (this.heightAt(lat, lon) - this.midM) / 1000, -(y - this.cy));
  }

  // [{ lat, lon, colour, active }]
  setMarkers(list) {
    this.markers.clear();
    if (!this.size) return;
    const s = this.size;
    for (const m of list) {
      const p = this.toScene(m.lat, m.lon);
      const tall = s * (m.active ? 0.07 : 0.045);
      const mat = new THREE.MeshBasicMaterial({ color: m.colour, transparent: true, opacity: 0.95 });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.0012, s * 0.0012, tall, 6), mat);
      pole.position.set(p.x, p.y + tall / 2, p.z);
      const head = new THREE.Mesh(new THREE.SphereGeometry(s * (m.active ? 0.009 : 0.006), 16, 12), mat);
      head.position.set(p.x, p.y + tall, p.z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(s * 0.008, s * 0.011, 32), new THREE.MeshBasicMaterial({ color: m.colour, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, p.y + s * 0.0015, p.z);
      this.markers.add(pole, head, ring);
    }
  }

  bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', e => {
      if (!down || !this.mesh || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const r = el.getBoundingClientRect();
      this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const hit = this.raycaster.intersectObject(this.mesh)[0];
      if (!hit) return;
      const [lat, lon] = fromStereo(hit.point.x + this.cx, this.cy - hit.point.z);
      this.onPick?.(lat, lon);
    });
  }

  // --- stand on site ------------------------------------------------------------------

  // spot: { lat, lon, hz }, path: hourly states over the next lunar day, now: current state
  setSpot(spot, path, now) {
    this.spot = spot;
    this.spotNow = now;
    if (!this.size) return;
    const [x, y] = toStereo(spot.lat, spot.lon);
    this.spotXY = [x, y];
    const meshM = this.sample(x, y);
    const groundM = spot.hz.groundM;
    const eyeM = Math.max(groundM, meshM === meshM ? meshM : groundM) + 4;
    this.eye = new THREE.Vector3(x - this.cx, (eyeM - this.midM) / 1000, -(y - this.cy));

    this.ground.clear();
    this.ground.position.copy(this.eye);
    const D = this.size * 3;
    const hz = spot.hz, n = Math.round(360 / hz.azStep);

    // skyline: a ribbon from the true horizon (far terrain included) down 15 deg
    const top = [], verts = [], idx = [];
    for (let k = 0; k <= n; k++) {
      const az = k * hz.azStep, el = hz.el[k % n];
      const a = this.direction(az, el, this.spotXY).multiplyScalar(D);
      const b = this.direction(az, el - 15, this.spotXY).multiplyScalar(D);
      top.push(a);
      verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      if (k < n) idx.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    rg.setIndex(idx);
    this.ground.add(new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: '#23252c', side: THREE.DoubleSide })));
    this.ground.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(top), new THREE.LineBasicMaterial({ color: '#d9d4c7', transparent: true, opacity: 0.9 })));

    // Sun and Earth tracks over the next lunar day, split where the azimuth wraps
    const track = (key, colour) => {
      const parts = [[]];
      let prev = null;
      for (const p of path) {
        if (prev !== null && Math.abs(p[key].az - prev) > 180) parts.push([]);
        parts.at(-1).push(this.direction(p[key].az, p[key].el, this.spotXY).multiplyScalar(D * 0.97));
        prev = p[key].az;
      }
      for (const pts of parts) {
        if (pts.length < 2) continue;
        this.ground.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.75 })));
      }
    };
    track('sun', '#ffb547');
    track('earth', '#5aa9ff');

    // compass letters just above the skyline
    for (const [az, letter] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgba(236,232,223,0.85)';
      ctx.font = '600 34px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(letter, 32, 32);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
      sp.position.copy(this.direction(az, hz.el[Math.round(az / hz.azStep) % n] + 2.2, this.spotXY).multiplyScalar(D * 0.95));
      sp.scale.setScalar(D * 0.035);
      this.ground.add(sp);
    }
    if (this.mode === 'ground') { this.enterGround(false); this.placeGroundSky(); }
  }

  updateSpotState(now) {
    this.spotNow = now;
    if (this.mode === 'ground') this.placeGroundSky();
  }

  placeGroundSky() {
    if (!this.spotNow || !this.eye) return;
    const D = this.size * 3 * 0.96, s = this.spotNow;
    this.sunSprite.position.copy(this.eye).add(this.direction(s.sun.az, s.sun.el, this.spotXY).multiplyScalar(D));
    this.sunSprite.scale.setScalar(D * Math.tan(0.53 * DEG) * 9);
    this.earthSprite.position.copy(this.eye).add(this.direction(s.earth.az, s.earth.el, this.spotXY).multiplyScalar(D));
    this.earthSprite.scale.setScalar(D * Math.tan(1.9 * DEG) * 3);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'ground') return this.enterGround(true);
    this.ground.visible = false;
    this.markers.visible = true;
    Object.assign(this.controls, {
      enableZoom: true, enablePan: true, rotateSpeed: 1, minPolarAngle: 0, maxPolarAngle: 88 * DEG,
      minDistance: this.size * 0.08, maxDistance: this.size * 3,
    });
    this.camera.near = this.size * 0.001;
    this.camera.fov = 42;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.pendingCamera = { animate: true };
    if (this.skyState) this.setSky(this.skyState);
  }

  // Put the eye on the spot and turn orbiting into looking around.
  enterGround(animate) {
    if (!this.eye) return;
    this.ground.visible = true;
    this.markers.visible = false;
    this.camera.near = 0.0005;
    this.camera.fov = 60;
    this.camera.updateProjectionMatrix();
    Object.assign(this.controls, {
      enableZoom: false, enablePan: false, rotateSpeed: -0.35,
      minDistance: 0, maxDistance: Infinity, minPolarAngle: 5 * DEG, maxPolarAngle: 175 * DEG,
    });
    const s = this.spotNow;
    const look = this.direction(s ? s.sun.az : 0, 2, this.spotXY);
    const target = this.eye.clone().add(look.multiplyScalar(0.01));
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      gsap.to(this.camera.position, { x: this.eye.x, y: this.eye.y, z: this.eye.z, duration: 1.6, ease: 'power3.inOut' });
      gsap.to(this.controls.target, { x: target.x, y: target.y, z: target.z, duration: 1.6, ease: 'power3.inOut' });
    } else {
      this.camera.position.copy(this.eye);
      this.controls.target.copy(target);
    }
    this.placeGroundSky();
  }

  // Turn to face the Sun or Earth (stand-on-site view only).
  face(which) {
    if (this.mode !== 'ground' || !this.spotNow) return;
    const b = this.spotNow[which];
    const look = this.direction(b.az, Math.max(b.el, -5) - 1, this.spotXY);
    const target = this.eye.clone().add(look.multiplyScalar(0.01));
    gsap.to(this.controls.target, { x: target.x, y: target.y, z: target.z, duration: 1.2, ease: 'power2.inOut' });
  }

  // Zoom buttons: move the camera towards or away from what it orbits. Standing on the
  // ground the camera can't move, so narrow or widen the lens instead.
  zoom(factor) {
    const c = this.controls;
    if (c.enableZoom === false) {
      this.camera.fov = Math.min(Math.max(this.camera.fov * factor, 15), 75);
      this.camera.updateProjectionMatrix();
      return;
    }
    const off = this.camera.position.clone().sub(c.target);
    const d = Math.min(Math.max(off.length() * factor, c.minDistance), c.maxDistance);
    const end = c.target.clone().add(off.setLength(d));
    gsap.to(this.camera.position, { x: end.x, y: end.y, z: end.z, duration: 0.35, ease: 'power2.out' });
  }

  setActive(on) {
    this.container.hidden = !on;
    if (on) this.resize();
  }

  placeLabels() {
    if (!this.labels) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    for (const [key, sprite] of [['sun', this.sunSprite], ['earth', this.earthSprite]]) {
      const el = this.labels[key];
      if (!el) continue;
      const p = sprite.position.clone().project(this.camera);
      const on = p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
      el.style.opacity = on ? 1 : 0;
      el.style.transform = `translate(${((p.x + 1) / 2) * w + 16}px, ${((1 - p.y) / 2) * h - 10}px)`;
    }
  }
}
