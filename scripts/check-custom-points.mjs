// How close are custom points (computed in the browser from the light grids) to the full
// build (5 m tile + 80 m + 240 m)? We redo every region centre and best spot both ways.
//
// Writes public/data/custom_check.json.
// usage: node scripts/check-custom-points.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Ephemeris, siteFrame } from '../src/core/ephemeris.js';
import { hourlyFlags, summary } from '../src/core/analysis.js';
import { customHorizon, decodeRegion, polarSampler } from '../src/core/terrain.js';
import { ROOT, readJson, readTyped } from './rasters.mjs';

const meta = readJson('public/data/ephemeris.json');
const eph = new Ephemeris(meta, readTyped(path.join(ROOT, 'public/data/ephemeris.bin'), Float32Array));
const index = readJson('public/data/terrain/index.json');
const buf = f => { const b = fs.readFileSync(path.join(ROOT, 'public/data/terrain', f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const polar = polarSampler(buf('polar.bin'), index.polar);
const best = readJson('public/data/best_spots.json').regions;

const rows = [];
for (const r of best) {
  const g = decodeRegion(buf(`${r.id}.bin`), index.regions[r.id], index.cells);
  for (const [kind, s, file] of [['centre', r.centre, r.id], ['best', r.best[0], `${r.id}--best`]]) {
    if (!s) continue;
    const full = readJson(`public/data/horizons/${file}.json`);
    const fullS = summary(hourlyFlags(eph, siteFrame(full.lat, full.lon, full.groundM + full.observerM), full), meta.stepHours);
    const hz = customHorizon(g, polar, full.lat, full.lon);
    const light = summary(hourlyFlags(eph, siteFrame(full.lat, full.lon, hz.groundM + hz.observerM), hz), meta.stepHours);
    rows.push({ id: r.id, kind, full: fullS, light, groundDiffM: +(hz.groundM - full.groundM).toFixed(1) });
    console.log(`${r.id.padEnd(27)} ${kind.padEnd(6)} Sun ${fullS.sunPct} vs ${light.sunPct}   Earth ${fullS.earthPct} vs ${light.earthPct}   ground ${(hz.groundM - full.groundM).toFixed(0)} m`);
  }
}

const diffs = k => rows.map(x => Math.abs(x.full[k] - x.light[k])).sort((a, b) => a - b);
const stat = k => { const d = diffs(k); const r = v => +v.toFixed(1); return { medianPts: r(d[Math.floor(d.length / 2)]), p90Pts: r(d[Math.floor(0.9 * (d.length - 1))]), maxPts: r(d.at(-1)) }; };
const out = { about: 'Custom-point horizons from the light browser grids vs the full build, share of hours Nov 2026 - Jan 2029', sun: stat('sunPct'), earth: stat('earthPct'), both: stat('bothPct'), rows };
console.log('Sun', out.sun, 'Earth', out.earth, 'both', out.both);
fs.writeFileSync(path.join(ROOT, 'public/data/custom_check.json'), JSON.stringify(out, null, 1) + '\n');
