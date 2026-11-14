// Light terrain grids (scripts/export_terrain.py) and what we compute from them in the
// browser: custom-point horizons, slope, and distance to permanent shadow.

import { computeHorizon, fromStereo, gridSampler, layered, toStereo } from './horizon.js';

// <region>.bin: int16 height, then uint8 sun, earth, psr (0-250 = 0-100 %), n x n each.
export function decodeRegion(buffer, meta, cells) {
  const n = cells * cells;
  const height = new Int16Array(buffer, 0, n);
  const bytes = new Uint8Array(buffer, 2 * n);
  return {
    ...meta, cells, height,
    sun: bytes.subarray(0, n), earth: bytes.subarray(n, 2 * n), psr: bytes.subarray(2 * n, 3 * n),
  };
}

export const regionSampler = g => gridSampler({
  data: g.height, cols: g.cells, rows: g.cells, cellKm: g.cellKm,
  xc0: g.x0 + g.cellKm / 2, yc0: g.y1 - g.cellKm / 2,
});

export const polarSampler = (buffer, p) => gridSampler({
  data: new Int16Array(buffer), cols: p.cols, rows: p.rows, cellKm: p.cellKm, xc0: p.xc0, yc0: p.yc0,
});

// Coarser than the build scripts (1 deg azimuth, 50 m first steps) so it runs in a blink.
export const LIGHT = { azStep: 1, firstStepKm: 0.05, minStepKm: 0.05, growth: 0.01 };

export function customHorizon(region, polar, lat, lon) {
  return computeHorizon(layered(regionSampler(region), polar), lat, lon, LIGHT);
}

// Grid cell (row, col) under a stereographic point, or null outside the box.
export function cellAt(g, x, y) {
  const j = Math.floor((x - g.x0) / g.cellKm), i = Math.floor((g.y1 - y) / g.cellKm);
  return i < 0 || j < 0 || i >= g.cells || j >= g.cells ? null : { i, j };
}

// Slope across one grid cell (about 100-190 m, or 485 m on Mons Mouton Plateau).
export function slopeAt(g, x, y) {
  const s = regionSampler(g), d = g.cellKm;
  const gx = (s(x + d, y) - s(x - d, y)) / (2 * d * 1000);
  const gy = (s(x, y + d) - s(x, y - d)) / (2 * d * 1000);
  return Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
}

export const cellCentre = (g, i, j) => [g.x0 + (j + 0.5) * g.cellKm, g.y1 - (i + 0.5) * g.cellKm];

// Nearest cell that is at least half permanent shadow, and the region's total shadow area.
export function iceNear(g, lat, lon) {
  const [x, y] = toStereo(lat, lon);
  let best = Infinity, at = null, area = 0;
  for (let i = 0; i < g.cells; i++) for (let j = 0; j < g.cells; j++) {
    const v = g.psr[i * g.cells + j];
    area += v / 250;
    if (v < 125) continue;
    const [cx, cy] = cellCentre(g, i, j);
    const d = Math.hypot(cx - x, cy - y);
    if (d < best) { best = d; at = fromStereo(cx, cy); }
  }
  return { nearestKm: at ? best : null, nearest: at, areaKm2: area * g.cellKm * g.cellKm };
}

// Long-term Sun and Earth visibility from NASA's maps at a point (0-1).
export function nasaVisibility(g, lat, lon) {
  const c = cellAt(g, ...toStereo(lat, lon));
  if (!c) return null;
  const k = c.i * g.cells + c.j;
  return { sun: g.sun[k] / 250, earth: g.earth[k] / 250, psr: g.psr[k] / 250 };
}
