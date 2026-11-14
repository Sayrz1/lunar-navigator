// Named features near the south pole from the IAU Gazetteer of Planetary Nomenclature
// (USGS Astrogeology), the same records LROC QuickMap shows in its object inspector:
//   https://planetarynames.wr.usgs.gov/
// Reads the attribute table (.dbf) of the Moon centre-points shapefile and keeps features
// south of 75 S. Writes public/data/features.json.
//
// usage: node scripts/fetch-features.mjs

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './rasters.mjs';

const URL = 'https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip';
const RAW = path.join(ROOT, 'data-raw', 'iau');
const DBF = path.join(RAW, 'MOON_nomenclature_center_pts.dbf');

if (!fs.existsSync(DBF)) {
  fs.mkdirSync(RAW, { recursive: true });
  const zip = path.join(RAW, 'moon.zip');
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['-xf', zip, '-C', RAW]);
}

// dBase III: a 32-byte header, 32-byte field descriptors up to 0x0D, then fixed-width records
function readDbf(buf) {
  const rows = buf.readUInt32LE(4), headerLen = buf.readUInt16LE(8), recLen = buf.readUInt16LE(10);
  const fields = [];
  for (let o = 32, at = 1; buf[o] !== 0x0d; o += 32) {
    const name = buf.toString('latin1', o, o + 11).replace(/\0.*$/, '');
    const len = buf[o + 16];
    fields.push({ name, at, len });
    at += len;
  }
  const out = [];
  for (let i = 0; i < rows; i++) {
    const r = headerLen + i * recLen;
    if (buf[r] === 0x2a) continue; // deleted
    const row = {};
    for (const f of fields) row[f.name] = buf.toString('utf8', r + f.at, r + f.at + f.len).trim();
    out.push(row);
  }
  return out;
}

const num = v => +Number(v).toFixed(3);
const lon180 = v => num(((Number(v) + 540) % 360) - 180);
const features = readDbf(fs.readFileSync(DBF))
  .filter(r => Number(r.center_lat ?? r.CENTER_LAT) < -75)
  .map(r => {
    const g = k => r[k] ?? r[k.toUpperCase()];
    return {
      name: g('clean_name') || g('name'),
      type: g('type'),
      lat: num(g('center_lat')), lon: lon180(g('center_lon')),
      diameterKm: num(g('diameter')),
      latRange: [num(g('min_lat')), num(g('max_lat'))],
      lonRange: [lon180(g('min_lon')), lon180(g('max_lon'))],
      origin: g('origin'),
      link: g('link'),
    };
  })
  .sort((a, b) => b.diameterKm - a.diameterKm);

fs.writeFileSync(path.join(ROOT, 'public/data/features.json'), JSON.stringify({
  source: 'IAU Gazetteer of Planetary Nomenclature, USGS Astrogeology: https://planetarynames.wr.usgs.gov/',
  note: 'Longitudes in degrees east, -180 to 180. Ranges are the bounding box the Gazetteer gives.',
  features,
}) + '\n');
console.log(`${features.length} features south of 75 S`);
