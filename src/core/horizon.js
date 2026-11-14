// Terrain horizon ("skyline") around a point on the Moon.
//
// For each azimuth we walk outward along the great circle and keep the highest elevation
// angle of the terrain, measured from the observer's eye. The Moon's curvature is exact
// (we work with radii and central angles), and there is no atmosphere, so no refraction.
// Heights come from one or more DEM grids in south polar stereographic coordinates.

import { MOON_RADIUS_KM } from './ephemeris.js';

const DEG = Math.PI / 180;
const R = MOON_RADIUS_KM;

// --- projection -------------------------------------------------------------------------

// South polar stereographic, LOLA convention: +y toward 0 deg E, +x toward 90 deg E.
export function toStereo(latDeg, lonDeg) {
  const rho = 2 * R * Math.tan(Math.PI / 4 + (latDeg * DEG) / 2);
  return [rho * Math.sin(lonDeg * DEG), rho * Math.cos(lonDeg * DEG)];
}

export function fromStereo(x, y) {
  const lat = -90 + (2 * Math.atan(Math.hypot(x, y) / (2 * R))) / DEG;
  return [lat, Math.atan2(x, y) / DEG];
}

// --- DEM sampling -----------------------------------------------------------------------

// A grid is { data, cols, rows, cellKm, xc0, yc0, scale }:
// xc0 / yc0 are the stereographic km of the centre of column 0 / row 0 (row 0 is the top),
// and height in metres = data[i] * scale. NaN or nodata means "no data here".
export function gridSampler(grid) {
  const { data, cols, rows, cellKm, xc0, yc0, scale = 1, nodata } = grid;
  return (x, y) => {
    const fx = (x - xc0) / cellKm;
    const fy = (yc0 - y) / cellKm;
    const j = Math.floor(fx), i = Math.floor(fy);
    if (j < 0 || i < 0 || j >= cols - 1 || i >= rows - 1) return NaN;
    const tx = fx - j, ty = fy - i, k = i * cols + j;
    const a = data[k], b = data[k + 1], c = data[k + cols], d = data[k + cols + 1];
    if (a === nodata || b === nodata || c === nodata || d === nodata) return NaN;
    return ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) * scale;
  };
}

// Try each sampler in turn (finest first) and use the first one with data.
export function layered(...samplers) {
  return (x, y) => {
    for (const s of samplers) {
      const h = s(x, y);
      if (h === h) return h; // not NaN
    }
    return NaN;
  };
}

// --- horizon ----------------------------------------------------------------------------

export const DEFAULTS = {
  observerM: 2,      // eye height above the ground: a lander's solar panel or antenna
  azStep: 0.5,       // degrees between azimuths
  maxDistKm: 250,
  firstStepKm: 0.015,
  minStepKm: 0.005,  // matches the 5 m tiles near the site
  growth: 0.004,     // step = 0.4 % of the distance travelled, so far terrain is sampled coarser
};

export function computeHorizon(sample, lat, lon, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const [x0, y0] = toStereo(lat, lon);
  const groundM = o.groundM ?? sample(x0, y0);
  if (!(groundM === groundM)) throw new Error(`no height data at ${lat}, ${lon}`);
  const r0 = R + (groundM + o.observerM) / 1000;

  const n = Math.round(360 / o.azStep);
  const el = new Float32Array(n);
  const reachKm = new Float32Array(n); // how far the data went on each ray
  const phi1 = lat * DEG, sinP1 = Math.sin(phi1), cosP1 = Math.cos(phi1);

  // the distances are the same for every azimuth
  const steps = [];
  for (let s = o.firstStepKm; s <= o.maxDistKm; s += Math.max(o.minStepKm, s * o.growth)) steps.push(s / R);
  const sinD = steps.map(Math.sin), cosD = steps.map(Math.cos);

  for (let k = 0; k < n; k++) {
    const az = k * o.azStep * DEG;
    const sinA = Math.sin(az), cosA = Math.cos(az);
    let best = -Infinity, reach = 0;
    for (let m = 0; m < steps.length; m++) {
      // point at angular distance d along azimuth az (spherical trigonometry)
      const sinP2 = sinP1 * cosD[m] + cosP1 * sinD[m] * cosA;
      const lat2 = Math.asin(sinP2);
      const lon2 = lon * DEG + Math.atan2(sinA * sinD[m] * cosP1, cosD[m] - sinP1 * sinP2);
      const rho = 2 * R * Math.tan(Math.PI / 4 + lat2 / 2);
      const h = sample(rho * Math.sin(lon2), rho * Math.cos(lon2));
      if (!(h === h)) continue;
      reach = steps[m] * R;
      const r1 = R + h / 1000;
      const e = Math.atan2(r1 * cosD[m] - r0, r1 * sinD[m]);
      if (e > best) best = e;
    }
    el[k] = best / DEG;
    reachKm[k] = reach;
  }
  return { azStep: o.azStep, el, reachKm, groundM, observerM: o.observerM, lat, lon };
}

// Horizon elevation at any azimuth, linear between samples.
export function horizonAt(hz, azDeg) {
  const n = hz.el.length;
  const f = ((((azDeg % 360) + 360) % 360) / hz.azStep);
  const i = Math.floor(f) % n, t = f - Math.floor(f);
  return hz.el[i] * (1 - t) + hz.el[(i + 1) % n] * t;
}

// Fraction of the Sun's disc above the horizon, treating the horizon as straight across
// the disc. clearDeg = Sun centre elevation minus horizon elevation; radiusDeg ~ 0.267.
export function discFraction(clearDeg, radiusDeg = 0.267) {
  if (clearDeg >= radiusDeg) return 1;
  if (clearDeg <= -radiusDeg) return 0;
  const r = radiusDeg, d = -clearDeg; // signed height of the horizon line above the centre
  const visible = r * r * Math.acos(d / r) - d * Math.sqrt(r * r - d * d); // disc area above the line
  return visible / (Math.PI * r * r);
}
