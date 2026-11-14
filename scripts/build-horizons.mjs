// Precompute the terrain horizon for every region in public/data/regions.json.
//
// Near the site we use the region's 5 m LOLA tile (data-raw/tiles, from export_tiles.py),
// and LOLA LDEM_80S_80M everywhere else, out to 250 km. The same src/core/horizon.js runs
// in the browser for custom points, on a lighter grid.
//
// Writes public/data/horizons/<region>.json and public/data/horizons/index.json.
// usage: node scripts/build-horizons.mjs

import fs from 'node:fs';
import path from 'node:path';
import { computeHorizon, layered } from '../src/core/horizon.js';
import { ROOT, ldem80, ldem240, tileSampler } from './rasters.mjs';

const OUT = path.join(ROOT, 'public', 'data', 'horizons');
const ldem = ldem80();
const ldem75 = ldem240();

const regions = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/regions.json'), 'utf8')).regions;
fs.mkdirSync(OUT, { recursive: true });
const index = [];

for (const r of regions.filter(r => r.lat !== null)) {
  const t0 = Date.now();
  const tile = tileSampler(r.id);
  const sample = tile ? layered(tile, ldem, ldem75) : layered(ldem, ldem75);
  const hz = computeHorizon(sample, r.lat, r.lon);
  const short = [...hz.reachKm].filter(d => d < 200).length;
  const doc = {
    id: r.id, lat: r.lat, lon: r.lon,
    groundM: +hz.groundM.toFixed(1), observerM: hz.observerM,
    azStep: hz.azStep,
    el: [...hz.el].map(v => +v.toFixed(4)),
    dem: tile ? ['LOLA 5 m tile', 'LDEM_80S_80M', 'LDEM_75S_240M'] : ['LDEM_80S_80M', 'LDEM_75S_240M'],
    raysCutShortOfDataKm200: short,
  };
  fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(doc) + '\n');
  const max = Math.max(...hz.el), min = Math.min(...hz.el);
  index.push({ id: r.id, groundM: doc.groundM, maxEl: +max.toFixed(3), minEl: +min.toFixed(3) });
  console.log(`${r.id.padEnd(28)} ground ${hz.groundM.toFixed(0).padStart(5)} m  horizon ${min.toFixed(2).padStart(6)} .. ${max.toFixed(2).padStart(5)} deg  ` +
    `${short ? short + ' rays end before 200 km  ' : ''}${Date.now() - t0} ms`);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1) + '\n');
