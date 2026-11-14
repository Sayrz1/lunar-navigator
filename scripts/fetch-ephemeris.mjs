// Download the hourly sub-solar / sub-Earth table from JPL Horizons and write
// public/data/ephemeris.bin (Float32, 6 values per hour) + ephemeris.json.
//
// One Horizons request per calendar year keeps each response well under the API limits.
//
// usage: node scripts/fetch-ephemeris.mjs [START] [STOP] [STEP_HOURS] [OUT]
//        default 2026-11-01 to 2036-01-01, 1 h, public/data/ephemeris
//        (validate-illumination.mjs uses an 18.6-year, 6 h table in data-raw/)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { horizons, tableHeader, tableRows, parseHorizonsTime } from './horizons.mjs';
import { COLUMNS } from '../src/core/ephemeris.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [start = '2026-11-01', stop = '2036-01-01', stepArg = '1', outArg = 'public/data/ephemeris'] = process.argv.slice(2);
const stepHours = Number(stepArg);
const OUT_BASE = path.resolve(ROOT, outArg);

// Moon (301) observed from Earth's centre (500@399):
//   14 = observer sub-longitude/latitude (sub-Earth point on the Moon)
//   15 = Sun sub-longitude/latitude (sub-solar point on the Moon)
//   19 = Sun-Moon range r (au), 20 = Earth-Moon range delta (au)
const QUERY = {
  COMMAND: '301', CENTER: '500@399', EPHEM_TYPE: 'OBSERVER', QUANTITIES: '14,15,19,20',
  STEP_SIZE: `${stepHours}h`, ANG_FORMAT: 'DEG', EXTRA_PREC: 'YES', CSV_FORMAT: 'YES',
};

function yearChunks(a, b) {
  const chunks = [];
  let t = new Date(a + 'T00:00:00Z');
  const end = new Date(b + 'T00:00:00Z');
  while (t < end) {
    const next = new Date(Date.UTC(t.getUTCFullYear() + 1, 0, 1));
    const stopAt = next < end ? next : end;
    chunks.push([t, stopAt]);
    t = stopAt;
  }
  return chunks;
}

const fmt = d => d.toISOString().slice(0, 16).replace('T', ' ');
const rows = new Map();
let frameLine = '';

for (const [a, b] of yearChunks(start, stop)) {
  process.stdout.write(`Horizons ${fmt(a)} -> ${fmt(b)} ... `);
  const text = await horizons({ ...QUERY, START_TIME: fmt(a), STOP_TIME: fmt(b) });
  frameLine ||= (text.match(/Target pole\/equ : (\S+)/) || [])[1];
  const head = tableHeader(text);
  const col = name => head.indexOf(name);
  const idx = [col('SunSub-LON'), col('SunSub-LAT'), col('r'), col('ObsSub-LON'), col('ObsSub-LAT'), col('delta')];
  if (idx.includes(-1)) throw new Error(`unexpected columns: ${head.join(' | ')}`);
  for (const r of tableRows(text)) rows.set(parseHorizonsTime(r[0]), idx.map(i => +r[i]));
  console.log(`${rows.size} rows`);
}

const times = [...rows.keys()].sort((x, y) => x - y);
for (let i = 1; i < times.length; i++) {
  if (times[i] - times[i - 1] !== stepHours * 3600e3) throw new Error(`gap in table at ${new Date(times[i]).toISOString()}`);
}

const values = new Float32Array(times.length * COLUMNS.length);
times.forEach((t, i) => values.set(rows.get(t), i * COLUMNS.length));

fs.mkdirSync(path.dirname(OUT_BASE), { recursive: true });
fs.writeFileSync(`${OUT_BASE}.bin`, Buffer.from(values.buffer));
const meta = {
  source: 'JPL Horizons API, https://ssd.jpl.nasa.gov/horizons/',
  query: { ...QUERY, START_TIME: start, STOP_TIME: stop },
  frame: frameLine,
  description: 'Sub-solar and sub-Earth points on the Moon (deg, east longitude) and Sun-Moon / Earth-Moon range (au), Moon observed from the geocentre',
  columns: COLUMNS,
  dtype: 'float32 little-endian',
  start: new Date(times[0]).toISOString(),
  stepHours,
  rows: times.length,
  fetched: new Date().toISOString(),
};
fs.writeFileSync(`${OUT_BASE}.json`, JSON.stringify(meta, null, 1) + '\n');
console.log(`wrote ${times.length} rows (${(values.byteLength / 1024).toFixed(0)} KB), frame ${frameLine}`);
