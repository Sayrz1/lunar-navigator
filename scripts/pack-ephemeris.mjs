// Repack public/data/ephemeris.bin for the browser, without changing a single value.
//
// The hourly table is six float columns that change slowly, so neighbouring rows share
// most of their bits. Each column is stored as the difference between one row's raw
// 32-bit pattern and the next, then split into four byte planes. Gzip on GitHub Pages
// shrinks that to about a third of the plain table. src/core/ephemeris.js undoes it.
//
// usage: node scripts/pack-ephemeris.mjs   (data:ephemeris runs it after the fetch)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(ROOT, 'public/data/ephemeris');
const meta = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
const buf = fs.readFileSync(`${base}.bin`);
const bits = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const cols = meta.columns.length, rows = meta.rows;
if (bits.length !== rows * cols) throw new Error(`expected ${rows * cols} values, found ${bits.length}`);

const out = new Uint8Array(bits.length * 4);
const delta = new Int32Array(rows);
for (let c = 0; c < cols; c++) {
  let prev = 0;
  for (let r = 0; r < rows; r++) {
    const v = bits[r * cols + c];
    delta[r] = (v - prev) | 0;
    prev = v;
  }
  const bytes = new Uint8Array(delta.buffer);
  for (let k = 0; k < 4; k++) {
    const plane = (c * 4 + k) * rows;
    for (let r = 0; r < rows; r++) out[plane + r] = bytes[r * 4 + k];
  }
}
fs.writeFileSync(`${base}.packed.bin`, out);
console.log(`ephemeris.packed.bin: ${rows} rows x ${cols} columns, ${out.length} bytes`);
