// Lunar eclipses found in our ephemeris against NASA's Five Millennium Catalog of Lunar
// Eclipses (Espenak & Meeus): https://eclipse.gsfc.nasa.gov/LEcat5/LE2001-2100.html
// The catalogue gives the time of greatest eclipse in TD; UT = TD - delta T (its own column).
// Writes public/data/eclipse_check.json.
//
// usage: node scripts/check-eclipses.mjs

import fs from 'node:fs';
import path from 'node:path';
import { Ephemeris } from '../src/core/ephemeris.js';
import { eclipses } from '../src/core/analysis.js';
import { ROOT, readJson, readTyped } from './rasters.mjs';

const URL = 'https://eclipse.gsfc.nasa.gov/LEcat5/LE2001-2100.html';
const file = path.join(ROOT, 'data-raw', 'eclipse', 'LE2001-2100.html');
if (!fs.existsSync(file)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await (await fetch(URL)).text());
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const text = fs.readFileSync(file, 'utf8').replace(/<[^>]*>/g, '');
const nasa = [];
for (const m of text.matchAll(/^\s*\d+\s+(\d{4}) (\w{3}) (\d\d)\s+(\d\d):(\d\d):(\d\d)\s+(-?\d+)\s+-?\d+\s+\d+\s+(\S+)/gm)) {
  const [, y, mon, d, hh, mm, ss, dT, type] = m;
  const td = Date.UTC(+y, MONTHS[mon], +d, +hh, +mm, +ss);
  nasa.push({ peak: td - Number(dT) * 1000, type });
}

const meta = readJson('public/data/ephemeris.json');
const eph = new Ephemeris(meta, readTyped(path.join(ROOT, 'public/data/ephemeris.bin'), Float32Array));
const ours = eclipses(eph);

const rows = [];
for (const n of nasa.filter(x => x.peak >= eph.start && x.peak <= eph.end)) {
  const o = ours.find(x => Math.abs(x.peak - n.peak) < 6 * 3600e3);
  rows.push({
    nasaPeakUtc: new Date(n.peak).toISOString().slice(0, 19) + 'Z', type: n.type,
    ourPeakUtc: o ? new Date(o.peak).toISOString().slice(0, 19) + 'Z' : null,
    diffMin: o ? +((o.peak - n.peak) / 60e3).toFixed(1) : null,
    sunCovered: o ? +o.covered.toFixed(2) : null,
    hours: o ? +((o.end - o.start) / 3600e3).toFixed(1) : null,
  });
}
const extra = ours.filter(o => !rows.some(r => r.ourPeakUtc === new Date(o.peak).toISOString().slice(0, 19) + 'Z'));
const found = rows.filter(r => r.ourPeakUtc);
const worst = Math.max(...found.map(r => Math.abs(r.diffMin)));
fs.writeFileSync(path.join(ROOT, 'public/data/eclipse_check.json'), JSON.stringify({
  about: 'Lunar eclipses from our ephemeris (Moon centre) vs NASA Five Millennium Catalog of Lunar Eclipses, times of greatest eclipse in UTC',
  source: URL,
  summary: { nasa: rows.length, matched: found.length, extraInOurs: extra.length, worstDiffMin: worst },
  rows,
}, null, 1) + '\n');
console.table(rows);
console.log(`NASA ${rows.length}, matched ${found.length}, extra ${extra.length}, worst ${worst} min`);
