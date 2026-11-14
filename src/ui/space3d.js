// Space view: the whole Moon in its own fixed frame, with the Sun and Earth placed from the
// JPL table (sub-solar and sub-Earth points). In this frame the Sun circles the Moon once a
// lunar day and Earth hangs almost still, rocking a few degrees: what a crew on the surface sees.
//
// Moon-fixed axes (MOON_ME): x to 0 deg E, y to 90 deg E, z to the north pole.
// Three.js: x = x, y = z (north up), z = -y. Sizes and distances are not to scale.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { gsap } from 'gsap';

const DEG = Math.PI / 180;
const EARTH_DIST = 3.4, EARTH_R = 0.27, SUN_DIST = 5.5;

export function moonVector(lat, lon, r = 1) {
  const la = lat * DEG, lo = lon * DEG;
  return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

function glow(colour, size, opacity = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, colour);
  g.addColorStop(0.25, colour.replace('1)', '0.45)'));
  g.addColorStop(1, colour.replace('1)', '0)'));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity, blending: THREE.AdditiveBlending }));
  s.scale.setScalar(size);
  return s;
}

function dashed(colour) {
  const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: colour, dashSize: 0.06, gapSize: 0.05, transparent: true, opacity: 0.9 }));
  line.frustumCulled = false;
  return line;
}

export class SpaceView {
  constructor(container, { labels } = {}) {
    this.container = container;
    this.labels = labels; // { sun, earth, site } HTML elements positioned over the canvas
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.append(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#020203');
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.25;
    this.controls.maxDistance = 22;

    this.addStars();
    const loader = new THREE.TextureLoader();
    const moonTex = loader.load('./data/moon.jpg');
    moonTex.colorSpace = THREE.SRGBColorSpace;
    moonTex.anisotropy = 8;
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 80), new THREE.MeshStandardMaterial({ map: moonTex, roughness: 1, metalness: 0 }));
    this.scene.add(this.moon);

    const earthTex = loader.load('./data/earth.jpg');
    earthTex.colorSpace = THREE.SRGBColorSpace;
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 64, 32), new THREE.MeshStandardMaterial({ map: earthTex, roughness: 0.75 }));
    this.earth.add(glow('rgba(90,169,255,1)', EARTH_R * 3.2, 0.5));
    this.scene.add(this.earth);

    this.sun = new THREE.Group();
    this.sun.add(new THREE.Mesh(new THREE.SphereGeometry(0.32, 32, 16), new THREE.MeshBasicMaterial({ color: '#fff3d6' })));
    this.sun.add(glow('rgba(255,181,71,1)', 3.4));
    this.scene.add(this.sun);

    this.sunLight = new THREE.DirectionalLight('#fff4e0', 3);
    this.scene.add(this.sunLight, this.sunLight.target);
    this.scene.add(new THREE.AmbientLight('#2a3446', 0.25));

    const pathMat = colour => new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.55 });
    this.sunPath = new THREE.Line(new THREE.BufferGeometry(), pathMat('#ffb547'));
    this.earthPath = new THREE.Line(new THREE.BufferGeometry(), pathMat('#5aa9ff'));
    this.sunRay = dashed('#ffb547');
    this.earthRay = dashed('#5aa9ff');
    this.scene.add(this.sunPath, this.earthPath, this.sunRay, this.earthRay);

    this.site = new THREE.Group();
    this.site.add(new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12), new THREE.MeshBasicMaterial({ color: '#ffffff' })));
    this.site.add(glow('rgba(255,255,255,1)', 0.09, 0.8));
    this.scene.add(this.site);
    this.regionDots = new THREE.Group();
    this.scene.add(this.regionDots);

    this.camera.position.set(1.9, -2.3, 2.6);
    this.controls.target.set(0, -0.35, 0);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.active = true;
    this.renderer.setAnimationLoop(() => {
      if (!this.active) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.placeLabels();
    });
  }

  addStars() {
    const pts = [];
    for (let i = 0; i < 2500; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(60 + Math.random() * 30);
      pts.push(v.x, v.y, v.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: '#d6dbe6', size: 0.12, transparent: true, opacity: 0.75 })));
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // on wide screens push the picture away from the title (left in English, right in Arabic)
    const away = document.documentElement.dir === 'rtl' ? 1 : -1;
    if (w > 900) this.camera.setViewOffset(w, h, away * w * 0.14, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  setActive(on) {
    this.active = on;
    this.container.hidden = !on;
    if (on) this.resize();
  }

  // row: { sunLon, sunLat, earthLon, earthLat } from the ephemeris; path: rows over the next lunar day
  setSky(row, path, earthRotDeg) {
    const sunDir = moonVector(row.sunLat, row.sunLon);
    const earthDir = moonVector(row.earthLat, row.earthLon);
    this.sun.position.copy(sunDir).multiplyScalar(SUN_DIST);
    this.earth.position.copy(earthDir).multiplyScalar(EARTH_DIST);
    this.earth.rotation.y = earthRotDeg * DEG;
    this.sunLight.position.copy(sunDir).multiplyScalar(20);
    if (path) {
      this.sunPath.geometry.setFromPoints(path.map(p => moonVector(p.sunLat, p.sunLon, SUN_DIST)));
      this.earthPath.geometry.setFromPoints(path.map(p => moonVector(p.earthLat, p.earthLon, EARTH_DIST)));
    }
    this.updateRays();
  }

  setSite(lat, lon, { sunlit, earthInView } = {}) {
    this.sitePos = moonVector(lat, lon, 1.003);
    this.site.position.copy(this.sitePos);
    this.vis = { sunlit, earthInView };
    this.updateRays();
  }

  setRegions(list) {
    this.regionDots.clear();
    for (const r of list) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffb547', transparent: true, opacity: 0.7 }));
      dot.position.copy(moonVector(r.lat, r.lon, 1.002));
      this.regionDots.add(dot);
    }
  }

  updateRays() {
    if (!this.sitePos) return;
    this.sunRay.geometry.setFromPoints([this.sitePos, this.sun.position]);
    this.earthRay.geometry.setFromPoints([this.sitePos, this.earth.position]);
    this.sunRay.computeLineDistances();
    this.earthRay.computeLineDistances();
    this.sunRay.material.opacity = this.vis?.sunlit ? 0.9 : 0.25;
    this.earthRay.material.opacity = this.vis?.earthInView ? 0.9 : 0.25;
  }

  placeLabels() {
    if (!this.labels) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const put = (el, pos, dx = 14, dy = -10) => {
      if (!el || !pos) return;
      const p = pos.clone().project(this.camera);
      const visible = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      el.style.opacity = visible ? 1 : 0;
      el.style.transform = `translate(${((p.x + 1) / 2) * w + dx}px, ${((1 - p.y) / 2) * h + dy}px)`;
    };
    put(this.labels.sun, this.sun.position, 24);
    put(this.labels.earth, this.earth.position, 22);
    put(this.labels.site, this.sitePos);
  }

  // Move in towards the site; resolves when the camera arrives.
  flyToSite() {
    return new Promise(resolve => {
      if (!this.sitePos || matchMedia('(prefers-reduced-motion: reduce)').matches) return resolve();
      const end = this.sitePos.clone().multiplyScalar(1.35);
      gsap.to(this.controls.target, { x: this.sitePos.x, y: this.sitePos.y, z: this.sitePos.z, duration: 1.4, ease: 'power2.inOut' });
      gsap.to(this.camera.position, { x: end.x, y: end.y, z: end.z, duration: 1.6, ease: 'power3.in', onComplete: resolve });
    });
  }

  // Look from the side, a little below, with the Sun partly behind the camera so the
  // south pole is lit and Earth is in frame.
  resetCamera() {
    const sun = this.sun.position.clone().normalize();
    const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sun).normalize();
    if (side.dot(this.earth.position) < 0) side.negate();
    const dir = side.add(sun.multiplyScalar(0.55)).add(new THREE.Vector3(0, -0.8, 0)).normalize();
    this.camera.position.copy(dir.multiplyScalar(8));
    this.controls.target.set(0, -0.3, 0);
  }

}
