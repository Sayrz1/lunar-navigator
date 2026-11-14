// LOLA grids from data-raw/, shared by the Node build scripts.
// Layouts come from the PDS labels (see scripts/check_tiles.py).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gridSampler } from '../src/core/horizon.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RAW = path.join(ROOT, 'data-raw');

export function readTyped(file, Type) {
  const b = fs.readFileSync(file);
  return new Type(b.buffer, b.byteOffset, b.byteLength / Type.BYTES_PER_ELEMENT);
}

export const readJson = file => JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));

// LDEM_80S_80M: 7600 x 7600 px, 80 m
export function ldem80() {
  return gridSampler({
    data: readTyped(path.join(RAW, 'ldem_80s_80m.img'), Int16Array),
    cols: 7600, rows: 7600, cellKm: 0.08,
    xc0: -3799.5 * 0.08, yc0: 3799.5 * 0.08, scale: 0.5,
  });
}

// LDEM_75S_240M fills in beyond 80 deg S, so rays from the northern regions reach 250 km
export function ldem240() {
  return gridSampler({
    data: readTyped(path.join(RAW, 'ldem_75s_240m.img'), Int16Array),
    cols: 3812, rows: 3812, cellKm: 0.24,
    xc0: -1905.5 * 0.24, yc0: 1905.5 * 0.24, scale: 0.5,
  });
}

// The region's 5 m tile from export_tiles.py, or null if the region has none.
export const tileIndex = readJson('data-raw/tiles/index.json');
export function tileSampler(region) {
  const t = tileIndex[region];
  if (!t) return null;
  return gridSampler({
    data: readTyped(path.join(RAW, 'tiles', `${region}.f32`), Float32Array),
    cols: t.cols, rows: t.rows, cellKm: t.cellKm,
    xc0: t.x0 + t.cellKm / 2, yc0: t.y1 - t.cellKm / 2,
  });
}
