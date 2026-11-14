import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Ephemeris, siteFrame, sunEarthAt, SYNODIC_DAYS } from './core/ephemeris.js';
import { stateAt, track, hourlyFlags, summary, landingWindows, shareBetween, dailyShare, eclipses, rules, rulesKey, SUN, EARTH } from './core/analysis.js';
import { fromStereo, toStereo } from './core/horizon.js';
import { decodeRegion, polarSampler, customHorizon, slopeAt, iceNear, nasaVisibility, cellAt, cellCentre } from './core/terrain.js';
import { DEFAULT_WEIGHTS, siteScore, battery } from './core/score.js';
import { drawHorizonChart, drawCalendar, drawIceMap, drawScatter, drawRadiation } from './ui/charts.js';
import { drawTimeline } from './ui/timeline.js';
import { Stage } from './ui/stage3d.js';
import { SpaceView } from './ui/space3d.js';
import { createNavi } from './ui/navi.js';
import { t, setLang, getLang, fmtDate } from './i18n.js';

gsap.registerPlugin(ScrollTrigger);

const $ = id => document.getElementById(id);
const HOUR = 3600e3, DAY = 24 * HOUR;
const COLOURS = { centre: '#ece8df', best: '#ffb547', custom: '#8fe3ff' };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const app = {
  eph: null, regions: [], best: {}, checks: {}, terrainIndex: null, polar: null, grids: {},
  region: null, grid: null, kind: 'best', custom: null, spot: null,
  // stay: Artemis III plans 5.75-6.25 days on the surface (George et al., LPSC 2026, abstract 1901)
  hz: {}, hzReady: {}, flags: new Map(), t: 0, layer: 'relief', stay: 6, slip: 0, watts: 300,
  view: 'space', camera: 'overview', speed: 6, scatterMetric: 'both', scatter: null, weights: { ...DEFAULT_WEIGHTS },
  stage: null, space: null, tlFrom: 0,
};

// --- formatting --------------------------------------------------------------------------

const ar = () => getLang() === 'ar';
const locale = () => (ar() ? 'ar-EG-u-nu-latn' : 'en-GB');
const fmtDeg = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}°`;
const fmtPct = v => `${Math.round(v)}%`;
function fmtSpan(ms) {
  const h = ms / HOUR;
  if (h < 48) {
    const mins = Math.round(h * 60), hh = Math.floor(mins / 60), mm = mins % 60;
    return ar() ? `${hh} س ${mm} د` : `${hh} h ${mm} min`;
  }
  const total = Math.round(h), d = Math.floor(total / 24), r = total % 24;
  return ar() ? `${d} ي ${r} س` : `${d}d ${r}h`;
}
const fmtDays = h => (ar() ? `${(h / 24).toFixed(1)} يوم` : `${(h / 24).toFixed(1)} d`);
const latLon = (lat, lon) => `${Math.abs(lat).toFixed(3)}°S · ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
const span = (n, from) => (n ? fmtSpan(n.at - from) : t('span.more'));

// --- URL state: #site=haworth&spot=best&t=2027-01-16T10:00Z[&lat=..&lon=..][&view=site] --

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const num = k => (p.has(k) ? Number(p.get(k)) : NaN);
  return { site: p.get('site'), spot: p.get('spot'), t: p.get('t') ? Date.parse(p.get('t')) : NaN, lat: num('lat'), lon: num('lon'), view: p.get('view') };
}

function writeHash() {
  const p = new URLSearchParams({ site: app.region.id, spot: app.kind, t: new Date(app.t).toISOString().slice(0, 16) + 'Z' });
  if (app.kind === 'custom') { p.set('lat', app.custom.lat.toFixed(5)); p.set('lon', app.custom.lon.toFixed(5)); }
  if (app.view === 'site') p.set('view', 'site');
  history.replaceState(null, '', `#${p}`);
}

// --- loading -----------------------------------------------------------------------------

// GitHub Pages now and then answers 503 for a single file, so server and network errors
// get two more tries. A 404 fails at once.
async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    let r = null;
    try {
      r = await fetch(url);
    } catch (err) {
      if (i >= tries) throw err;
    }
    if (r?.ok) return r;
    if (r && (r.status < 500 || i >= tries)) throw new Error(`${url}: ${r.status}`);
    await new Promise(done => setTimeout(done, 400 * i));
  }
}
const json = url => get(url).then(r => r.json());
const bin = url => get(url).then(r => r.arrayBuffer());

function horizon(file) {
  app.hz[file] ??= json(`./data/horizons/${file}.json`).then(hz => (app.hzReady[file] = hz));
  return app.hz[file];
}

function grid(id) {
  app.grids[id] ??= bin(`./data/terrain/${id}.bin`)
    .then(b => decodeRegion(b, app.terrainIndex.regions[id], app.terrainIndex.cells))
    .then(g => (app.grids[id + ':ready'] = g));
  return app.grids[id];
}

async function loadRegion(id) {
  app.region = app.regions.find(r => r.id === id) ?? app.regions.find(r => r.id === 'malapert-massif') ?? app.regions[0];
  app.grid = await grid(app.region.id);
  const g = app.grid;
  // the 3D sky over the terrain box is drawn for the middle of the box
  const [lat, lon] = fromStereo((g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2);
  app.boxFrame = siteFrame(lat, lon, 0);
  $('site').value = app.region.id;
  app.stage?.setTerrain(g, { animate: app.view === 'site' });
  app.stage?.setLayer(app.layer);
}

function loadPolar() {
  app.polar ??= bin('./data/terrain/polar.bin').then(b => polarSampler(b, app.terrainIndex.polar));
  return app.polar;
}

// Share of the 2 km circle that is walkable (slope under 20 deg), from the light grid.
function walkable(g, x, y) {
  const c = cellAt(g, x, y);
  if (!c) return null;
  const reach = Math.ceil(1 / g.cellKm);
  let ok = 0, all = 0;
  for (let di = -reach; di <= reach; di++) for (let dj = -reach; dj <= reach; dj++) {
    const i = c.i + di, j = c.j + dj;
    if (i < 1 || j < 1 || i >= g.cells - 1 || j >= g.cells - 1) continue;
    const [cx, cy] = cellCentre(g, i, j);
    if (Math.hypot(cx - x, cy - y) > 1) continue;
    all++;
    if (slopeAt(g, cx, cy) < 20) ok++;
  }
  return all ? ok / all : null;
}

// The spot is the point everything on the page is about.
async function setSpot(kind, custom) {
  const r = app.region, best = app.best[r.id];
  if (kind === 'best' && !best?.best.length) kind = 'centre';
  app.kind = kind;
  let spot;
  if (kind === 'custom') {
    app.custom = custom ?? app.custom;
    const polar = await loadPolar();
    const hz = customHorizon(app.grid, polar, app.custom.lat, app.custom.lon);
    const [x, y] = toStereo(app.custom.lat, app.custom.lon);
    spot = { lat: app.custom.lat, lon: app.custom.lon, hz, slope: slopeAt(app.grid, x, y), walkable: walkable(app.grid, x, y) };
  } else {
    const hz = await horizon(kind === 'best' ? `${r.id}--best` : r.id);
    const s = kind === 'best' ? best.best[0] : best?.centre;
    const [x, y] = toStereo(hz.lat, hz.lon);
    spot = { lat: hz.lat, lon: hz.lon, hz, slope: s?.slope100Deg ?? slopeAt(app.grid, x, y), walkable: kind === 'best' ? s.walkable2km : walkable(app.grid, x, y) };
  }
  spot.frame = siteFrame(spot.lat, spot.lon, spot.hz.groundM + spot.hz.observerM);
  const key = (kind === 'custom' ? `custom:${spot.lat},${spot.lon}` : `${r.id}:${kind}`) + `|${rulesKey()}`;
  if (!app.flags.has(key)) app.flags.set(key, hourlyFlags(app.eph, spot.frame, spot.hz));
  spot.flags = app.flags.get(key);
  spot.summary = summary(spot.flags, app.eph.meta.stepHours);
  spot.ice = iceNear(app.grid, spot.lat, spot.lon);
  spot.nasa = nasaVisibility(app.grid, spot.lat, spot.lon);
  app.spot = spot;
  app.spotKey = key;
  for (const b of $('spot-kind').children) {
    b.setAttribute('aria-checked', String(b.dataset.kind === kind));
    if (b.dataset.kind === 'custom') b.disabled = !app.custom;
  }
  const path = track(app.eph, app.t, Math.round(SYNODIC_DAYS * 24), spot.frame, spot.hz);
  app.stage?.setSpot(spot, path, stateAt(app.eph, app.t, spot.frame, spot.hz));
  app.space?.setRegions(app.regions);
  renderSpot();
  renderNow({ full: true });
}

// --- rendering: things that depend on the spot ------------------------------------------

function spotLabel() {
  if (app.kind === 'custom') return `${app.region.name} (${t('spot.custom').toLowerCase()})`;
  return app.kind === 'best' ? `${app.region.name} · ${t('spot.best')}` : app.region.name;
}

const scoreOf = (s, iceKm) => siteScore(s, iceKm, app.weights);
const gradeKey = score => (score >= 70 ? 'good' : score >= 45 ? 'ok' : 'bad');
const grade = score => t(`grade.${gradeKey(score)}`);

function renderSpot() {
  const { spot, region } = app;
  $('site-name').textContent = region.name;
  $('assess-name').textContent = spotLabel();
  app.stage?.setMarkers(markers());

  const lat = Math.abs(spot.lat), s = spot.summary;
  const req = (cls, label, val) => `<li class="${cls}"><span class="mark">${{ pass: '✓', warn: '!', fail: '✗', na: '–' }[cls]}</span><span>${label}</span><span class="val">${val}</span></li>`;
  $('reqs').innerHTML = [
    req(lat >= 84 ? 'pass' : lat >= 83.5 ? 'warn' : 'fail', t('req.lat'), `${lat.toFixed(2)}°S`),
    req(spot.slope < 10 ? 'pass' : 'fail', t('req.slope'), `${spot.slope.toFixed(1)}°`),
    spot.walkable == null ? req('na', t('req.eva'), '') : req(spot.walkable >= 0.9 ? 'pass' : spot.walkable >= 0.75 ? 'warn' : 'fail', t('req.eva'), fmtPct(spot.walkable * 100)),
    req(s.earthPct >= 25 ? 'pass' : 'fail', t('req.earth'), fmtPct(s.earthPct)),
    req(s.sunPct >= 5 ? 'pass' : 'fail', t('req.sun'), fmtPct(s.sunPct)),
  ].join('');

  const centre = app.best[region.id]?.centre;
  const delta = (v, ref, better = 'up') => {
    if (app.kind === 'centre' || ref == null) return '';
    const d = v - ref;
    if (Math.abs(d) < 0.5) return '';
    const good = better === 'up' ? d > 0 : d < 0;
    const size = better === 'up' ? `${Math.abs(Math.round(d))} pts` : fmtDays(Math.abs(d));
    return `<span class="delta" style="color: var(${good ? '--ok' : '--bad'})">${d > 0 ? '+' : '−'}${size} ${ar() ? 'مقارنة بالمركز' : 'vs centre'}</span>`;
  };
  const stat = (label, value, extra = '') => `<div><dt>${label}</dt><dd>${value}${extra}</dd></div>`;
  $('long').innerHTML = [
    stat(t('long.sun'), fmtPct(s.sunPct), delta(s.sunPct, centre?.sunPct)),
    stat(t('long.earth'), fmtPct(s.earthPct), delta(s.earthPct, centre?.earthPct)),
    stat(t('long.both'), fmtPct(s.bothPct), delta(s.bothPct, centre?.bothPct)),
    stat(t('long.night'), fmtDays(s.longestDarkH), delta(s.longestDarkH, centre?.longestDarkH, 'down')),
    stat(t('long.gap'), fmtDays(s.longestNoEarthH), delta(s.longestNoEarthH, centre?.longestNoEarthH, 'down')),
  ].join('');

  renderScore();
  renderPower();
  renderRadiation();
  renderFeatures();
  renderScatter();
  renderPlanner();
  renderIce();
  renderCompare();
}

function renderScore() {
  const { spot } = app;
  const { score, parts } = scoreOf(spot.summary, spot.ice.nearestKm);
  app.score = score;
  $('score').textContent = score;
  $('grade').textContent = grade(score);
  $('grade').className = `grade ${gradeKey(score)}`;
  $('score-parts').innerHTML = Object.entries(parts).map(([k, v]) =>
    `<li><span>${t(`score.${k}`)}</span><span class="meter"><i style="width:${Math.round(v * 100)}%"></i></span><span class="num">${Math.round(v * 100)}</span></li>`).join('');
}

function renderWeights() {
  $('weights').innerHTML = Object.entries(app.weights).map(([k, v]) =>
    `<label class="weight"><span>${t(`score.${k}`)}</span><input type="range" min="0" max="10" step="1" value="${v}" data-weight="${k}"><output class="num">${v}</output></label>`).join('');
}

function renderPower() {
  const s = app.spot.summary;
  const here = battery(s.longestDarkH, app.watts);
  const c = app.best[app.region.id]?.centre;
  const row = (k, v) => `<dt>${t(k)}</dt><dd>${v}</dd>`;
  let html = row('power.night', fmtDays(s.longestDarkH)) +
    row('power.kwh', `${here.kWh.toFixed(1)} kWh`) +
    row('power.kg', `${Math.round(here.kg)} kg`);
  if (c && app.kind !== 'centre') {
    const there = battery(c.longestDarkH, app.watts);
    html += row('power.centre', `${there.kWh.toFixed(1)} kWh · ${Math.round(there.kg)} kg`);
  }
  $('power').innerHTML = html;
}

// --- radiation (LRO CRaTER, see scripts/fetch-crater.mjs) --------------------------------

const CYCLE_MS = 11 * 365.25 * DAY; // one solar cycle, near enough for an analogue
const STORM_MGY = 5;                // a day whose worst hour tops this is a solar storm day
const CAREER_MSV = 600;             // NASA career limit, NASA-STD-3001 Vol. 1 Rev. B (2022)

// Each day keeps absorbed dose (med, max in mGy/day) and dose equivalent (eq, eqMax in
// mSv/day). The page shows dose equivalent, the quantity crew limits are set in.
function prepareRadiation(doc) {
  const days = doc.days.map(([d, med, max, , eq, eqMax]) => ({ t: Date.parse(d + 'T00:00:00Z'), med, max, eq, eqMax }));
  const monthly = new Map();
  for (const d of days) {
    if (d.eq == null) continue;
    const k = new Date(d.t).toISOString().slice(0, 7);
    if (!monthly.has(k)) monthly.set(k, []);
    monthly.get(k).push(d.eq);
  }
  const median = v => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  // the cosmic-ray background: the quieter quarter of the days, so storm months don't lift it
  const quiet = v => [...v].sort((a, b) => a - b)[Math.floor(v.length / 4)];
  const months = [...monthly].filter(([, v]) => v.length >= 10).map(([k, v]) => ({ t: Date.parse(k + '-15T00:00:00Z'), v: quiet(v) }));
  const storms = days.filter(d => d.max > STORM_MGY);
  const worst = days.reduce((a, d) => ((d.eqMax ?? 0) > a.eqMax ? d : a), { eqMax: 0 });
  const rad = { days, months, storms: storms.map(d => d.t), worst, last: days.at(-1).t, median, quiet };
  // the dashed estimate on the chart: each month after the data, from one cycle earlier
  rad.estimate = [];
  for (let t = months.at(-1).t; t < Date.UTC(2036, 0, 1); t += 30 * DAY) rad.estimate.push({ t, v: radiationAt(rad, t).rate });
  return rad;
}

// Background dose rate around a date, from the daily medians within two weeks.
// After the last measured day, use the same point of the previous solar cycle.
function radiationAt(rad, ms) {
  let at = ms, estimated = false;
  while (at > rad.last) { at -= CYCLE_MS; estimated = true; }
  const near = rad.days.filter(d => d.eq != null && Math.abs(d.t - at) <= 14 * DAY).map(d => d.eq);
  return { rate: near.length ? rad.quiet(near) : NaN, from: at, estimated };
}

// Share of the open sky (upper hemisphere, by solid angle) the horizon leaves visible.
// Cosmic rays arrive from every direction, so dose scales with it. Over 1 on a peak.
function skyShare(hz) {
  let s = 0;
  for (const el of hz.el) s += 1 - Math.sin(el * Math.PI / 180);
  return s / hz.el.length;
}

function renderRadiation() {
  const rad = app.rad;
  if (!rad) { $('rad-rate').textContent = '–'; return; }
  const r = radiationAt(rad, app.t);
  const share = skyShare(app.spot.hz);
  const blocked = Math.round((1 - share) * 100);
  $('rad-rate').textContent = r.rate.toFixed(2);
  $('rad-basis').textContent = r.estimated ? t('rad.basis.estimate', { date: fmtDate(r.from).split(',')[0] }) : t('rad.basis.measured');
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const site = r.rate * app.stay * share;
  $('rad-rows').innerHTML =
    row(t('rad.r.stay', { days: app.stay }), `${(r.rate * app.stay).toFixed(1)} mSv`) +
    row(blocked >= 0 ? t('rad.r.site', { pct: blocked }) : t('rad.r.siteOpen', { pct: -blocked }), `${site.toFixed(1)} mSv`) +
    row(t('rad.r.limit', { limit: CAREER_MSV }), `${((site / CAREER_MSV) * 100).toFixed(1)}%`) +
    row(t('rad.r.storms'), String(rad.storms.length)) +
    row(t('rad.r.worst'), `${Math.round(rad.worst.eqMax)} mSv/day · ${new Date(rad.worst.t).toISOString().slice(0, 7)}`);
  drawRadiation($('rad-chart'), { months: rad.months, estimate: rad.estimate, storms: rad.storms, now: app.t, top: 2.5 });
  app.radNow = { rate: r.rate, total: r.rate * app.stay * share, estimated: r.estimated };
  if ($('ice-rad')) $('ice-rad').innerHTML = iceRadText();
}

// --- named features (IAU Gazetteer, see scripts/fetch-features.mjs) ------------------------

function renderFeatures() {
  if (!app.features) return;
  const [sx, sy] = toStereo(app.spot.lat, app.spot.lon);
  const near = app.features.map(f => {
    const [x, y] = toStereo(f.lat, f.lon);
    return { ...f, km: Math.hypot(x - sx, y - sy) };
  }).filter(f => f.km - f.diameterKm / 2 < 30).sort((a, b) => (a.km - a.diameterKm / 2) - (b.km - b.diameterKm / 2)).slice(0, 6);
  const deg = v => `${v.toFixed(3)}°`;
  const row = (k, v) => `<dt>${t(k)}</dt><dd>${v}</dd>`;
  $('feat-list').innerHTML = near.map((f, i) => `<details${i === 0 ? ' open' : ''}>
    <summary>${f.name}<span>${f.km < f.diameterKm / 2 ? t('feat.inside') : t('feat.away', { km: f.km.toFixed(1) })}</span></summary>
    <dl>${row('feat.type', f.type)}${row('feat.centre', `${deg(f.lat)}, ${deg(f.lon)}`)}${row('feat.diam', `${f.diameterKm.toFixed(2)} km`)}${row('feat.lat', `${deg(f.latRange[0])} … ${deg(f.latRange[1])}`)}${row('feat.lon', `${deg(f.lonRange[0])} … ${deg(f.lonRange[1])}`)}${f.origin ? row('feat.origin', `<span class="feat-origin">${f.origin}</span>`) : ''}${f.link ? row('feat.link', `<a href="${f.link.replace('http:', 'https:')}" target="_blank" rel="noopener">${f.link.split('/').pop()}</a>`) : ''}</dl>
  </details>`).join('');
}

// Landing scatter grid around the centre or best spot (precomputed, see scripts/landing-scatter.mjs).
function renderScatter() {
  const doc = app.scatter?.regions[app.region.id]?.[app.kind];
  const card = $('scatter-card');
  card.classList.toggle('empty', !doc);
  for (const b of $('scatter-metric').children) b.setAttribute('aria-checked', String(b.dataset.metric === app.scatterMetric));
  if (!doc) {
    $('scatter-text').textContent = t('scatter.none');
    $('scatter-stats').innerHTML = '';
    return;
  }
  const w = doc.within100m, m = app.scatterMetric;
  $('scatter-text').textContent = t('scatter.text', { what: t(`scatter.what.${m}`), lo: Math.round(w[m][0]), hi: Math.round(w[m][1]) });
  const range = ([a, b]) => `${Math.round(a)}–${Math.round(b)}%`;
  const row = (k, v) => `<dt>${t(k)}</dt><dd>${v}</dd>`;
  $('scatter-stats').innerHTML =
    row('scatter.r.sun', range(w.sun)) + row('scatter.r.earth', range(w.earth)) + row('scatter.r.both', range(w.both)) +
    row('scatter.r.dark', `${fmtDays(w.dark[0])} – ${fmtDays(w.dark[1])}`) +
    row('scatter.r.steep', t('scatter.of', { n: w.tooSteep, all: w.points }));
  drawScatter($('scatter-map'), { size: app.scatter.size, stepM: app.scatter.stepM, grid: doc }, m);
}

function markers() {
  const r = app.region, b = app.best[r.id];
  const list = [{ kind: 'centre', lat: r.lat, lon: r.lon }];
  if (b?.best.length) list.push({ kind: 'best', lat: b.best[0].lat, lon: b.best[0].lon });
  if (app.custom) list.push({ kind: 'custom', ...app.custom });
  return list.map(m => ({ ...m, colour: COLOURS[m.kind], active: m.kind === app.kind }));
}

function renderPlanner() {
  const { eph, spot } = app;
  app.windows = landingWindows(eph, spot.flags, app.stay * 24);
  app.days = dailyShare(eph, spot.flags);
  drawCal();
  const upcoming = app.windows.filter(w => w.close >= app.t);
  const list = (upcoming.length ? upcoming : app.windows).slice(0, 8);
  if (!app.windows.length) {
    $('windows').innerHTML = `<li class="note">${t('plan.nowindow')}</li>`;
    return;
  }
  $('windows').innerHTML = list.map(w => {
    const inside = app.t >= w.open && app.t <= w.close;
    const dim = eclipsesBetween(w.open, w.close + app.stay * DAY).length ? ` <span class="eclipse-tag">${t('plan.eclipse')}</span>` : '';
    const label = w.close - w.open < HOUR ? t('plan.windowAt', { open: fmtDate(w.open) }) : t('plan.window', { open: fmtDate(w.open), close: fmtDate(w.close) });
    return `<li class="${inside ? 'current' : ''}"><button type="button" data-open="${w.open}"><span>${label}${dim}</span><span class="dur">${fmtDays((w.close - w.open) / HOUR)}</span></button></li>`;
  }).join('') + (upcoming.length > list.length ? `<li class="note">${t('plan.more', { n: upcoming.length - list.length })}</li>` : '');
}

// The mission period: from the landing time for the length of the stay. Either end can be
// typed in; the numbers below cover every hour in between.
function longestWithout(flags, a, b, bit) {
  let run = 0, most = 0;
  for (let k = a; k < b; k++) {
    run = flags[k] & bit ? 0 : run + 1;
    if (run > most) most = run;
  }
  return most;
}

function renderPeriod() {
  const { eph, spot } = app;
  const from = app.t, to = Math.min(app.t + app.stay * DAY, eph.end);
  const iso = ms => new Date(ms).toISOString().slice(0, 16);
  if (document.activeElement !== $('per-from')) $('per-from').value = iso(from);
  if (document.activeElement !== $('per-to')) $('per-to').value = iso(to);
  const hours = (to - from) / HOUR;
  const a = Math.max(0, Math.round((from - eph.start) / eph.stepMs));
  const b = Math.min(spot.flags.length, a + Math.round(hours * HOUR / eph.stepMs));
  const step = eph.stepMs / HOUR;
  const share = bit => shareBetween(eph, spot.flags, from, hours, bit) * 100;
  const list = eclipsesBetween(from, to);
  const m = {
    sun: share(SUN), earth: share(EARTH), both: share(SUN | EARTH),
    dark: longestWithout(spot.flags, a, b, SUN) * step, noEarth: longestWithout(spot.flags, a, b, EARTH) * step,
    rad: app.radNow ? app.radNow.rate * (hours / 24) * skyShare(spot.hz) : NaN,
    ice: spot.ice.nearestKm ?? NaN, eclipses: list.length,
  };
  app.periodNow = { m, label: `${app.region.name} · ${t(`spot.${app.kind}`)}`, from, to };
  // [key, text, value, bigger is better]
  const items = [
    ['per.sun', `${Math.round(m.sun)}%`, m.sun, true], ['per.earth', `${Math.round(m.earth)}%`, m.earth, true],
    ['per.both', `${Math.round(m.both)}%`, m.both, true], ['per.dark', fmtSpan(m.dark * HOUR), m.dark, false],
    ['per.noearth', fmtSpan(m.noEarth * HOUR), m.noEarth, false], ['per.rad', Number.isFinite(m.rad) ? `${m.rad.toFixed(1)} mSv` : '–', m.rad, false],
    ['per.ice', Number.isFinite(m.ice) ? `${m.ice.toFixed(1)} km` : '–', m.ice, false],
  ];
  const base = app.baseline?.m;
  const keyOf = { 'per.sun': 'sun', 'per.earth': 'earth', 'per.both': 'both', 'per.dark': 'dark', 'per.noearth': 'noEarth', 'per.rad': 'rad', 'per.ice': 'ice' };
  const delta = (k, v, up) => {
    const was = base?.[keyOf[k]];
    if (!Number.isFinite(was) || !Number.isFinite(v)) return '';
    const d = v - was, small = k === 'per.rad' || k === 'per.ice' ? 0.05 : 0.5;
    if (Math.abs(d) < small) return `<small class="delta same">${t('per.same')}</small>`;
    const shown = k === 'per.dark' || k === 'per.noearth' ? fmtSpan(Math.abs(d) * HOUR)
      : k === 'per.rad' ? `${Math.abs(d).toFixed(1)} mSv` : k === 'per.ice' ? `${Math.abs(d).toFixed(1)} km` : `${Math.round(Math.abs(d))} pts`;
    return `<small class="delta ${(d > 0) === up ? 'better' : 'worse'}">${d > 0 ? '+' : '−'}${shown}</small>`;
  };
  const item = (k, v, d = '') => `<div><dt>${t(k)}</dt><dd>${v}${d}</dd></div>`;
  $('per-len').textContent = t('per.len', { len: fmtSpan(hours * HOUR) });
  $('per-rows').innerHTML = items.map(([k, text, v, up]) => item(k, text, delta(k, v, up))).join('') +
    item('per.eclipse', eclipseText(list));
  const b0 = app.baseline;
  $('per-base').innerHTML = b0 ? t('per.base', { label: b0.label, from: fmtDate(b0.from), to: fmtDate(b0.to) }) : t('per.base.none');
  $('per-pin').textContent = t(b0 ? 'per.repin' : 'per.pin');
  $('per-clear').hidden = !b0;
}

// Lunar eclipses that overlap a stretch of time, and a short description of them.
function eclipsesBetween(from, to) {
  return (app.eclipses ?? []).filter(e => e.end > from && e.start < to);
}
function eclipseText(list) {
  if (!list.length) return t('per.eclipse.none');
  return list.map(e => t(e.covered >= 1 ? 'per.eclipse.total' : 'per.eclipse.part', {
    date: fmtDate(e.peak), hours: ((e.end - e.start) / HOUR).toFixed(1), pct: Math.round(e.covered * 100),
  })).join('<br>');
}

// One year of the calendar at a time. It follows the chosen time into a new year,
// and the year buttons let you look ahead without moving the time.
function drawCal() {
  const tYear = new Date(app.t).getUTCFullYear();
  if (tYear !== app.calFollow) { app.calFollow = tYear; app.calYear = tYear; }
  // skip a stub year (the table ends at midnight on 1 January)
  const count = {};
  for (const d of app.days) { const y = new Date(d.t).getUTCFullYear(); count[y] = (count[y] ?? 0) + 1; }
  const years = Object.keys(count).map(Number).filter(y => count[y] >= 28 || y === tYear);
  const bar = $('cal-year');
  // each year's share of hours with Sun and Earth together at this spot
  if (bar.dataset.for !== app.spotKey) {
    const share = y => {
      const days = app.days.filter(d => new Date(d.t).getUTCFullYear() === y);
      return days.reduce((a, d) => a + d.both, 0) / days.length;
    };
    bar.innerHTML = years.map(y => `<button type="button" role="radio" data-year="${y}">${y}<small class="num">${Math.round(share(y) * 100)}%</small></button>`).join('');
    bar.dataset.for = app.spotKey;
  }
  for (const b of bar.children) b.setAttribute('aria-checked', String(Number(b.dataset.year) === app.calYear));
  const days = app.days.filter(d => new Date(d.t).getUTCFullYear() === app.calYear);
  app.calPick = drawCalendar($('calendar'), days, app.t, app.windows, locale());
}

// The water map and the numbers beside it all follow the chosen spot: shadow (water) around
// it, its own sunlight over the whole period, and its radiation now.
function renderIce() {
  const ice = app.spot.ice, near = ice.nearestKm, g = app.grid, s = app.spot.summary;
  const stat = (label, value, cls = '', id = '') => `<div><dt>${label}</dt><dd class="${cls}"${id ? ` id="${id}"` : ''}>${value}</dd></div>`;
  let shadow = 0;
  for (const v of g.psr) if (v >= 125) shadow++;
  $('ice-stats').innerHTML = [
    stat(t('ice.area'), `${ice.areaKm2.toFixed(1)} <small>km² · ${fmtPct((shadow / g.psr.length) * 100)} ${t('ice.ofmap')}</small>`),
    stat(t('ice.near'), near == null ? t('ice.none') : `${near.toFixed(1)} <small>km · ${near <= 2 ? t('ice.inreach') : t('ice.outreach')}</small>`, near != null && near <= 2 ? 'good' : 'far'),
    stat(t('ice.sun'), `${fmtPct(s.sunPct)} <small>${t('ice.sun.both', { both: fmtPct(s.bothPct) })}</small>`),
    stat(t('ice.rad'), iceRadText(), '', 'ice-rad'),
  ].join('');
  const mode = app.iceMode ?? 'ice';
  drawIceMap($('ice-map'), g, markers().map(m => ({ ...m, line: m.active && ice.nearest ? ice.nearest : null })), mode);
  $('ice-key').hidden = mode !== 'height';
  $('ice-key-lo').textContent = `${Math.round(g.minM)} m`;
  $('ice-key-hi').textContent = `${Math.round(g.maxM)} m`;
  $('ice-caption').textContent = t(mode === 'height' ? 'ice.map.height' : 'ice.map.caption');
}

function iceRadText() {
  const r = app.radNow;
  return r ? `${(r.rate * skyShare(app.spot.hz)).toFixed(2)} <small>mSv/day${r.estimated ? ' · ' + t('ice.rad.est') : ''}</small>` : '–';
}

// Compare table. Scores need each region's grid (for distance to ice), loaded in the background.
function renderCompare() {
  const groups = [['2024', t('cmp.g2024')], ['2022', t('cmp.g2022')], ['none', t('cmp.gother')]];
  const group = r => (r.nasa_lists.includes('2024') ? '2024' : r.nasa_lists.includes('2022') ? '2022' : 'none');
  // range of Sun + Earth within 100 m, drawn as a span on a 0-100 track
  const spread = v => (v ? `<span class="spread" title="${Math.round(v[0])}–${Math.round(v[1])}%"><i style="inset-inline-start:${v[0]}%;width:${Math.max(1, v[1] - v[0])}%"></i></span>${Math.round(v[0])}–${Math.round(v[1])}%` : '–');
  const bar = (v, cls) => `<span class="bar ${cls}" style="width:${Math.max(2, v * 0.6)}px"></span>${fmtPct(v)}`;
  let html = '';
  for (const [key, label] of groups) {
    const rs = app.regions.filter(r => group(r) === key && app.best[r.id]);
    if (!rs.length) continue;
    html += `<tr class="group"><td colspan="9">${label}</td></tr>`;
    for (const r of rs) {
      const b = app.best[r.id];
      const g = app.grids[r.id + ':ready'];
      for (const [kind, s] of [['centre', b.centre], ['best', b.best[0]]]) {
        if (!s) continue;
        const sc = g ? scoreOf(s, iceNear(g, s.lat, s.lon).nearestKm).score : '…';
        const sel = r.id === app.region.id && kind === app.kind ? ' selected' : '';
        html += `<tr data-id="${r.id}" data-kind="${kind}" class="${sel}">` +
          `<td class="name">${kind === 'centre' ? r.name : ''}</td><td>${t(kind === 'centre' ? 'spot.centre' : 'spot.best')}</td>` +
          `<td class="score-cell">${sc}</td>` +
          `<td>${bar(s.sunPct, '')}</td><td>${bar(s.earthPct, 'earth')}</td><td>${bar(s.bothPct, 'both')}</td>` +
          `<td>${spread(app.scatter?.regions[r.id]?.[kind]?.within100m.both)}</td>` +
          `<td>${fmtDays(s.longestDarkH)}</td><td class="now" data-now="${r.id}:${kind}"></td></tr>`;
      }
    }
  }
  $('cmp-body').innerHTML = html;
  renderCompareNow();
}

const frames = {};
function renderCompareNow() {
  for (const cell of document.querySelectorAll('#cmp-body td.now')) {
    const [id, kind] = cell.dataset.now.split(':');
    const hz = app.hzReady[kind === 'best' ? `${id}--best` : id];
    if (!hz) continue;
    const key = `${id}:${kind}`;
    frames[key] ??= siteFrame(hz.lat, hz.lon, hz.groundM + hz.observerM);
    const s = stateAt(app.eph, app.t, frames[key], hz);
    cell.innerHTML = `<span class="tag ${s.sunlit ? 'on-sun' : 'off'}">${t(s.sunlit ? 'cmp.lit' : 'cmp.dark')}</span>` +
      `<span class="tag ${s.earthInView ? 'on-earth' : 'off'}">${t(s.earthInView ? 'cmp.radio' : 'cmp.noradio')}</span>`;
  }
}

// --- rendering: things that depend on the time ------------------------------------------

// Next time the Sun (bit SUN) or Earth (bit EARTH) changes at the spot. Scans the hourly
// flags, then narrows the last hour down to a minute: far cheaper than stepping stateAt.
function nextFlip(ms, bit) {
  const { eph, spot } = app;
  const test = bit === SUN ? s => s.sunlit : s => s.earthInView;
  const now = test(stateAt(eph, ms, spot.frame, spot.hz));
  const k0 = Math.floor((ms - eph.start) / eph.stepMs) + 1;
  const kEnd = Math.min(spot.flags.length, k0 + Math.round((60 * DAY) / eph.stepMs));
  let k = k0;
  while (k < kEnd && Boolean(spot.flags[k] & bit) === now) k++;
  if (k >= kEnd) return null;
  let lo = Math.max(ms, eph.start + (k - 1) * eph.stepMs), hi = eph.start + k * eph.stepMs;
  while (hi - lo > 60e3) {
    const mid = (lo + hi) / 2;
    if (test(stateAt(eph, mid, spot.frame, spot.hz)) === now) lo = mid; else hi = mid;
  }
  return { at: hi, from: now };
}

let playing = null, slowTimer = 0, slowAt = 0;
function renderNow({ full = false } = {}) {
  const { eph, spot, t: now } = app;
  const s = stateAt(eph, now, spot.frame, spot.hz);
  app.state = s;
  const sunNext = nextFlip(now, SUN);
  const earthNext = nextFlip(now, EARTH);
  app.next = { sun: sunNext, earth: earthNext };

  // hero
  $('site-meta').textContent = `${latLon(spot.lat, spot.lon)} · ${Math.round(spot.hz.groundM)} m`;
  $('summary').textContent = (s.sunlit
    ? t('sum.sunup', { clear: Math.abs(s.sun.clear).toFixed(1), span: span(sunNext, now) })
    : t('sum.sundown', { clear: Math.abs(s.sun.clear).toFixed(1), span: span(sunNext, now) })) + ' ' +
    (s.earthInView ? t('sum.earthup', { clear: s.earth.clear.toFixed(1) }) : t('sum.earthdown', { span: span(earthNext, now) }));
  $('clock').textContent = new Date(now).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  const lunarDay = shareBetween(eph, spot.flags, now, SYNODIC_DAYS * 24, SUN);
  const p = (k, v, cls = '') => `<div><dt>${t(k)}</dt><dd class="${cls}">${v}</dd></div>`;
  $('panel').innerHTML = [
    p('panel.score', `${app.score ?? '–'}<small>/100</small>`, 'big'),
    p('panel.sunvs', fmtDeg(s.sun.clear), s.sunlit ? 'sun' : 'off'),
    p(s.sunlit ? 'panel.sunset' : 'panel.sunrise', span(sunNext, now)),
    p('panel.earth', t(s.earthInView ? 'earth.up' : 'earth.down'), s.earthInView ? 'earth' : 'off'),
    p(s.earthInView ? 'panel.earthset' : 'panel.earthrise', span(earthNext, now)),
    p('panel.lunarday', fmtPct(lunarDay * 100)),
  ].join('');

  // 3D
  if (app.stage) {
    const sky = sunEarthAt(eph, now, app.boxFrame);
    app.stage.setSky({ sun: sky.sun, earth: sky.earth });
    app.stage.updateSpotState(s);
  }
  if (app.space) renderSpace(full);
  const site = app.view === 'site';
  $('lbl-sun').textContent = site ? `${t('legend.sun')} ${s.sun.el.toFixed(1)}°` : t('legend.sun');
  $('lbl-earth').textContent = site ? `${t('legend.earth')} ${s.earth.el.toFixed(1)}°` : t('legend.earth');
  $('lbl-site').textContent = spotLabel();

  drawStrip();

  // the rest is heavier, so while playing it runs about four times a second
  clearTimeout(slowTimer);
  const wait = 250 - (performance.now() - slowAt);
  if (full || !playing || wait <= 0) renderSlow(s, sunNext, earthNext);
  else slowTimer = setTimeout(() => renderSlow(app.state, app.next.sun, app.next.earth), wait);
}

function renderSlow(s, sunNext, earthNext) {
  slowAt = performance.now();
  const { eph, spot, t: now } = app;
  const row = (k, v) => `<dt>${t(k)}</dt><dd>${v}</dd>`;
  $('sun-state').textContent = s.sunlit ? t('sun.lit', { disc: Math.round(s.sun.disc * 100) }) : t('sun.dark');
  $('sun-state').className = 'state ' + (s.sunlit ? 'ok' : 'bad');
  $('sun-numbers').innerHTML = row('row.el', fmtDeg(s.sun.el)) + row('row.horizon', fmtDeg(s.sun.horizon)) +
    row('row.clear', fmtDeg(s.sun.clear)) + row('row.az', `${s.sun.az.toFixed(1)}°`) + row(s.sunlit ? 'row.sunset' : 'row.sunrise', span(sunNext, now));
  $('earth-state').textContent = s.earthInView ? t('earth.up') : t('earth.down');
  $('earth-state').className = 'state ' + (s.earthInView ? 'ok' : 'bad');
  $('earth-numbers').innerHTML = row('row.el', fmtDeg(s.earth.el)) + row('row.horizon', fmtDeg(s.earth.horizon)) +
    row('row.clear', fmtDeg(s.earth.clear)) + row('row.az', `${s.earth.az.toFixed(1)}°`) + row(s.earthInView ? 'row.earthset' : 'row.earthrise', span(earthNext, now));

  renderRadiation();
  renderPeriod();
  drawHorizonChart($('horizon-chart'), spot.hz, track(eph, now, Math.round(SYNODIC_DAYS * 24), spot.frame, spot.hz), s);
  renderLate();
  renderCompareNow();
  if (app.days) drawCal();
  for (const li of $('windows').querySelectorAll('li')) {
    const b = li.querySelector('button');
    if (!b) continue;
    const w = app.windows.find(x => x.open === Number(b.dataset.open));
    li.classList.toggle('current', !!w && now >= w.open && now <= w.close);
  }
  writeHash();
}

function renderSpace(full) {
  const { eph, t: now, spot } = app;
  let path = null;
  // the Sun and Earth paths only move noticeably over a day or so
  if (full || !app.spacePathAt || Math.abs(now - app.spacePathAt) > DAY) {
    path = [];
    for (let k = 0; k <= SYNODIC_DAYS * 4; k++) {
      const ms = now + k * 6 * HOUR;
      if (eph.covers(ms)) path.push(eph.sample(ms));
    }
    app.spacePathAt = now;
  }
  // Earth's spin from Greenwich sidereal time; only for looks
  const gmst = (280.46061837 + 360.98564736629 * (now / DAY + 2440587.5 - 2451545)) % 360;
  app.space.setSky(eph.sample(now), path, gmst);
  app.space.setSite(spot.lat, spot.lon, { sunlit: app.state.sunlit, earthInView: app.state.earthInView });
}

// Timeline window: about four weeks, moved on when the time runs off either end.
function drawStrip() {
  const days = innerWidth < 700 ? 20 : 30;
  if (!app.tlFrom || app.t < app.tlFrom + DAY / 2 || app.t > app.tlFrom + (days - 2) * DAY) {
    app.tlFrom = Math.max(app.eph.start, Math.floor(app.t / DAY) * DAY - 2 * DAY);
  }
  app.tlPick = drawTimeline($('timeline'), { eph: app.eph, flags: app.spot.flags, from: app.tlFrom, days, now: app.t, locale: locale() });
}

function renderLate() {
  const { eph, spot } = app;
  const stayH = app.stay * 24;
  const onTime = Math.min(app.t, eph.end), late = Math.min(app.t + app.slip * HOUR, eph.end);
  const describe = ms => {
    const s = stateAt(eph, ms, spot.frame, spot.hz);
    const n = nextFlip(ms, SUN);
    let run = 0, longest = 0;
    const k0 = Math.round((ms - eph.start) / eph.stepMs);
    for (let k = k0; k < Math.min(spot.flags.length, k0 + stayH); k++) {
      if (spot.flags[k] & SUN) run = 0; else longest = Math.max(longest, ++run);
    }
    return {
      time: fmtDate(ms),
      sunlit: s.sunlit, earthUp: s.earthInView,
      sun: s.sunlit ? t('sun.lit', { disc: Math.round(s.sun.disc * 100) }) : t('sun.dark'),
      earth: t(s.earthInView ? 'earth.up' : 'earth.down'),
      next: `${t(s.sunlit ? 'row.sunset' : 'row.sunrise')} ${span(n, ms)}`,
      sunshare: shareBetween(eph, spot.flags, ms, stayH, SUN),
      earthshare: shareBetween(eph, spot.flags, ms, stayH, EARTH),
      both: shareBetween(eph, spot.flags, ms, stayH),
      dark: longest * eph.meta.stepHours,
    };
  };
  const a = describe(onTime), b = describe(late);
  const verdict = b.both >= 0.95 ? 'good' : b.both >= 0.6 ? 'ok' : 'bad';
  const slipText = app.slip < 48 ? t('late.hours', { n: app.slip }) : t('late.days', { n: (app.slip / 24).toFixed(1) });
  $('slip-out').textContent = slipText;
  $('slip').value = app.slip;
  $('late-verdict').className = `verdict ${verdict}`;
  let text = t(`late.verdict.${verdict}`);
  if (verdict !== 'good') {
    const next = app.windows.find(w => w.open > late);
    if (next) text += ` · ${t('late.next', { time: fmtDate(next.open) })}`;
  }
  $('late-verdict').textContent = text;
  const diff = (x, y) => {
    const d = Math.round((y - x) * 100);
    return d ? ` <small class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${Math.abs(d)}</small>` : '';
  };
  // mark the late column where the delay makes things worse: red for a loss at touchdown
  // or a big drop, amber for a smaller one
  const drop = (x, y) => (y < x - 0.15 ? 'bad' : y < x - 0.03 ? 'warn' : '');
  const rows = [
    ['late.r.time', a.time, b.time, ''],
    ['late.r.sun', a.sun, b.sun, a.sunlit && !b.sunlit ? 'bad' : ''],
    ['late.r.earth', a.earth, b.earth, a.earthUp && !b.earthUp ? 'bad' : ''],
    ['late.r.next', a.next, b.next, ''],
    ['late.r.sunshare', fmtPct(a.sunshare * 100), fmtPct(b.sunshare * 100) + diff(a.sunshare, b.sunshare), drop(a.sunshare, b.sunshare)],
    ['late.r.earthshare', fmtPct(a.earthshare * 100), fmtPct(b.earthshare * 100) + diff(a.earthshare, b.earthshare), drop(a.earthshare, b.earthshare)],
    ['late.r.both', fmtPct(a.both * 100), fmtPct(b.both * 100) + diff(a.both, b.both), drop(a.both, b.both)],
    ['late.r.dark', fmtDays(a.dark), fmtDays(b.dark), b.dark > a.dark + 24 ? 'bad' : b.dark > a.dark ? 'warn' : ''],
  ];
  $('late-table').innerHTML = `<thead><tr><th></th><th>${t('late.col.ontime')}</th><th>${t('late.col.late', { d: slipText })}</th></tr></thead><tbody>` +
    rows.map(([k, x, y, flag]) => `<tr><th>${t(k)}</th><td>${x}</td><td${flag ? ` class="worse ${flag}"` : ''}>${y}</td></tr>`).join('') + '</tbody>';
  for (const btn of $('delays').children) btn.classList.toggle('on', Number(btn.dataset.delay) === app.slip);
}

// --- trust -------------------------------------------------------------------------------

function renderTrust() {
  const { validation, tiles, illum, custom } = app.checks;
  const rms = Math.max(...tiles.tiles.map(x => x.height_vs_ldem80.rms_diff_m));
  const card = (title, big, body) => `<article class="card trust-card"><h3>${title}</h3><p class="big-num">${big}</p><p>${body}</p></article>`;
  $('trust-cards').innerHTML = [
    card(t('trust.eph'), `${(validation.worstDeg * 3600).toFixed(1)}″`, t('trust.eph.body', { n: validation.team.length + validation.live.length, arcsec: (validation.worstDeg * 3600).toFixed(1) })),
    card(t('trust.terrain'), `≤ ${rms.toFixed(1)} m`, t('trust.terrain.body', { rms: rms.toFixed(1) })),
    card(t('trust.light'), `${illum.summary.random.sun.medianAbsPts} pts`, t('trust.light.body', { n: illum.summary.random.sun.n, sun: illum.summary.random.sun.medianAbsPts, earth: illum.summary.random.earth.medianAbsPts })),
    card(t('trust.custom'), `${custom.sun.medianPts} pts`, t('trust.custom.body', { sun: custom.sun.medianPts, max: custom.sun.maxPts })),
    radiationCard(card),
    app.checks.eclipse ? card(t('trust.eclipse'), `${app.checks.eclipse.summary.worstDiffMin} min`, t('trust.eclipse.body', app.checks.eclipse.summary)) : '',
  ].join('');
  $('limits').innerHTML = t('limits.items').split('|').map(x => `<li>${x}</li>`).join('');
}

// CRaTER in orbit against the Chang'e-4 lander on the far side, over the same months.
// Chang'e-4 LND, Jan-Jun 2019 (Zhang et al. 2020, Sci. Adv. 6, eaaz1334): 13.2 uGy/h in
// silicon, about 20% of it from the ground (albedo), which CRaTER's surface figure leaves
// out; and a dose equivalent of 1369 uSv/day.
const CHANGE4_MGY = 13.2e-3 * 24 * 1.3 * 0.8, CHANGE4_MSV = 1.369;
function radiationCard(card) {
  if (!app.rad) return '';
  const from = Date.UTC(2019, 0, 3), to = Date.UTC(2019, 5, 30);
  const span = app.rad.days.filter(d => d.t >= from && d.t <= to);
  const gy = app.rad.median(span.map(d => d.med)), sv = app.rad.median(span.filter(d => d.eq != null).map(d => d.eq));
  return card(t('trust.rad'), `${gy.toFixed(2)} / ${CHANGE4_MGY.toFixed(2)}`,
    t('trust.rad.body', { ours: gy.toFixed(2), them: CHANGE4_MGY.toFixed(2), oursSv: sv.toFixed(2), themSv: CHANGE4_MSV.toFixed(2) }));
}

// --- Navi --------------------------------------------------------------------------------

function topSpots(n = 3) {
  const out = [];
  for (const r of app.regions) {
    const b = app.best[r.id], g = app.grids[r.id + ':ready'];
    if (!b?.best[0] || !g) continue;
    const s = b.best[0];
    out.push({ name: r.name, score: scoreOf(s, iceNear(g, s.lat, s.lon).nearestKm).score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, n);
}

function naviAnswer(intent) {
  const { state: s, next, spot } = app;
  const where = spotLabel();
  switch (intent) {
    case 'sun': return s.sunlit ? t('navi.sunup', { spot: where, disc: Math.round(s.sun.disc * 100), span: span(next.sun, app.t) }) : t('navi.sundown', { spot: where, span: span(next.sun, app.t) });
    case 'earth': return s.earthInView ? t('navi.earthup', { spot: where, clear: s.earth.clear.toFixed(1), span: span(next.earth, app.t) }) : t('navi.earthdown', { spot: where, span: span(next.earth, app.t) });
    case 'best': {
      const top = Object.values(app.best).filter(b => b.best[0]).sort((a, b) => b.best[0].bothPct - a.best[0].bothPct)[0];
      const list = topSpots().map(x => `${x.name} (${x.score})`).join(', ');
      return t('navi.best', { region: top.name, both: top.best[0].bothPct, night: (top.best[0].longestDarkH / 24).toFixed(0), mine: spot.summary.bothPct }) + (list ? ' ' + t('navi.top', { list }) : '');
    }
    case 'scatter': {
      const d = app.scatter?.regions[app.region.id]?.[app.kind]?.within100m;
      return d ? t('navi.scatter', { lo: Math.round(d.both[0]), hi: Math.round(d.both[1]), steep: d.tooSteep, all: d.points }) : t('scatter.none');
    }
    case 'rad': {
      if (!app.radNow) return t('navi.unknown');
      const r = app.radNow;
      return t('navi.rad', { rate: r.rate.toFixed(2), days: app.stay, total: r.total.toFixed(1), basis: r.estimated ? t('rad.basis.estimate', { date: fmtDate(radiationAt(app.rad, app.t).from).split(',')[0] }) : '' }).trim();
    }
    case 'score': return t('navi.score', { score: app.score, grade: grade(app.score) });
    case 'power': {
      const b = battery(spot.summary.longestDarkH, app.watts);
      return t('navi.power', { days: (spot.summary.longestDarkH / 24).toFixed(1), w: app.watts, kwh: b.kWh.toFixed(1), kg: Math.round(b.kg) });
    }
    case 'window': {
      const w = app.windows.find(x => x.close >= app.t);
      return w ? t('navi.window', { stay: app.stay, open: fmtDate(w.open), close: fmtDate(w.close) }) : t('navi.nowindow', { stay: app.stay });
    }
    case 'ice': return spot.ice.nearestKm == null ? t('navi.noice') : t('navi.ice', { km: spot.ice.nearestKm.toFixed(1), area: spot.ice.areaKm2.toFixed(1) });
    case 'trust': return t('navi.trust', { arcsec: (app.checks.validation.worstDeg * 3600).toFixed(1), sun: app.checks.illum.summary.random.sun.medianAbsPts });
    case 'slope': return t('navi.slope', { slope: spot.slope.toFixed(1) });
    default: return t('navi.unknown');
  }
}

// --- views -------------------------------------------------------------------------------

function viewNote() {
  $('view-note').textContent = t(app.view === 'space' ? (app.frame === 'sun' ? 'note.spaceSun' : 'note.space') : app.camera === 'ground' ? 'note.ground' : 'note.overview');
}

function setView(view) {
  app.view = view;
  document.body.dataset.view = view;
  for (const b of $('view').children) b.setAttribute('aria-checked', String(b.dataset.view === view));
  app.space?.setActive(view === 'space');
  app.stage?.setActive(view === 'site');
  if (view === 'site') app.stage?.setMode(app.camera);
  if (view === 'space') app.space?.resetCamera();
  viewNote();
  renderNow({ full: true });
}

function setCamera(cam) {
  app.camera = cam;
  document.body.dataset.cam = cam;
  for (const b of $('camera').children) b.setAttribute('aria-checked', String(b.dataset.cam === cam));
  app.stage?.setMode(cam);
  viewNote();
}

// --- controls ----------------------------------------------------------------------------

function setTime(ms) {
  const { eph } = app;
  app.t = Math.min(Math.max(Math.round(ms / 60e3) * 60e3, eph.start), eph.end);
  $('when').value = new Date(app.t).toISOString().slice(0, 16);
}

function fillRegionSelect() {
  const groups = [['2024', t('cmp.g2024')], ['2022', t('cmp.g2022')], ['none', t('cmp.gother')]];
  const group = r => (r.nasa_lists.includes('2024') ? '2024' : r.nasa_lists.includes('2022') ? '2022' : 'none');
  $('site').innerHTML = groups.map(([key, label]) => `<optgroup label="${label}">` +
    app.regions.filter(r => group(r) === key).map(r => `<option value="${r.id}">${r.name}</option>`).join('') + '</optgroup>').join('');
  if (app.region) $('site').value = app.region.id;
}

function play(on) {
  $('play').classList.toggle('on', on);
  $('play').setAttribute('aria-label', t(on ? 'time.pause' : 'time.play'));
  if (playing) { cancelAnimationFrame(playing); playing = null; }
  if (!on) { renderNow({ full: true }); return; }
  let last = performance.now();
  const tick = now => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (app.t >= app.eph.end) return play(false);
    setTime(app.t + dt * app.speed * HOUR);
    renderNow();
    playing = requestAnimationFrame(tick);
  };
  playing = requestAnimationFrame(tick);
}

function csv() {
  const { eph, spot } = app;
  const lines = ['time_utc,sun_az_deg,sun_el_deg,terrain_at_sun_deg,sunlit,sun_disc_pct,earth_az_deg,earth_el_deg,terrain_at_earth_deg,earth_in_view'];
  for (let k = 0; k < 30 * 24; k++) {
    const ms = app.t + k * HOUR;
    if (!eph.covers(ms)) break;
    const s = stateAt(eph, ms, spot.frame, spot.hz);
    lines.push([new Date(ms).toISOString().slice(0, 16) + 'Z', s.sun.az.toFixed(2), s.sun.el.toFixed(3), s.sun.horizon.toFixed(3), s.sunlit ? 1 : 0,
      Math.round(s.sun.disc * 100), s.earth.az.toFixed(2), s.earth.el.toFixed(3), s.earth.horizon.toFixed(3), s.earthInView ? 1 : 0].join(','));
  }
  const header = `# Lunar Navigator, ${spotLabel()}, ${spot.lat.toFixed(5)} ${spot.lon.toFixed(5)}, ground ${spot.hz.groundM} m, eye 2 m. Sun/Earth from JPL Horizons, terrain from NASA LOLA.\n`;
  const url = URL.createObjectURL(new Blob([header + lines.join('\n') + '\n'], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `lunar-navigator-${app.region.id}-${app.kind}-${new Date(app.t).toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const segPick = (id, fn) => $(id).addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b && !b.disabled) fn(b);
});

function bind() {
  segPick('view', b => setView(b.dataset.view));
  segPick('camera', b => setCamera(b.dataset.cam));
  segPick('spot-kind', b => setSpot(b.dataset.kind));
  segPick('layer', b => {
    app.layer = b.dataset.layer;
    for (const x of $('layer').children) x.setAttribute('aria-checked', String(x === b));
    app.stage?.setLayer(app.layer);
  });
  for (const b of document.querySelectorAll('[data-zoom]')) b.addEventListener('click', () => {
    (app.view === 'space' ? app.space : app.stage)?.zoom(Number(b.dataset.zoom));
  });
  segPick('ice-mode', b => {
    app.iceMode = b.dataset.mode;
    for (const x of $('ice-mode').children) x.setAttribute('aria-checked', String(x === b));
    renderIce();
  });
  segPick('frame', b => {
    app.frame = b.dataset.frame;
    for (const x of $('frame').children) x.setAttribute('aria-checked', String(x === b));
    app.space?.setFrame(app.frame);
    viewNote();
    renderNow({ full: true });
  });
  segPick('cal-year', b => { app.calYear = Number(b.dataset.year); drawCal(); });
  segPick('scatter-metric', b => { app.scatterMetric = b.dataset.metric; renderScatter(); });
  segPick('speed', b => {
    app.speed = Number(b.dataset.speed);
    for (const x of $('speed').children) x.setAttribute('aria-checked', String(x === b));
  });
  for (const b of document.querySelectorAll('[data-face]')) b.addEventListener('click', () => {
    const wasGround = app.camera === 'ground';
    if (!wasGround) setCamera('ground');
    setTimeout(() => app.stage?.face(b.dataset.face), wasGround ? 0 : 1700);
  });
  $('fly').addEventListener('click', async () => {
    await app.space?.flyToSite();
    setView('site');
  });
  $('site').addEventListener('change', async e => {
    play(false);
    app.custom = null;
    await loadRegion(e.target.value);
    await setSpot(app.kind === 'custom' ? 'best' : app.kind);
    if (app.view === 'space') app.space?.focusSite();
  });
  $('when').addEventListener('change', e => {
    const ms = Date.parse(e.target.value + 'Z');
    if (Number.isFinite(ms)) { setTime(ms); renderPlanner(); renderNow({ full: true }); }
  });
  $('play').addEventListener('click', () => play(!playing));

  const timeline = $('timeline');
  const scrub = e => {
    const r = timeline.getBoundingClientRect();
    const ms = app.tlPick?.(e.clientX - r.left);
    if (Number.isFinite(ms)) { setTime(ms); renderNow(); }
  };
  timeline.addEventListener('pointerdown', e => {
    play(false);
    timeline.setPointerCapture(e.pointerId);
    scrub(e);
    timeline.addEventListener('pointermove', scrub);
    timeline.addEventListener('pointerup', () => {
      timeline.removeEventListener('pointermove', scrub);
      renderNow({ full: true });
    }, { once: true });
  });

  const setStay = days => {
    app.stay = Math.round(Math.min(Math.max(days, 1 / 24), 365) * 24) / 24;
    $('stay').value = +app.stay.toFixed(2);
    renderPlanner(); renderLate(); renderRadiation(); renderPeriod();
  };
  $('stay').addEventListener('change', e => {
    const v = Number(e.target.value);
    if (v > 0) setStay(v);
  });
  $('per-pin').addEventListener('click', () => { app.baseline = structuredClone(app.periodNow); renderPeriod(); });
  $('per-clear').addEventListener('click', () => { app.baseline = null; renderPeriod(); });
  for (const id of ['rule-sun', 'rule-earth']) segPick(id, async b => {
    for (const x of $(id).children) x.setAttribute('aria-checked', String(x === b));
    if (id === 'rule-sun') rules.sunDisc = b.dataset.rule; else rules.earthMarginDeg = Number(b.dataset.rule);
    $('rules-off').hidden = rulesKey() === 'any,0';
    await setSpot(app.kind);
  });
  $('per-from').addEventListener('change', e => {
    const ms = Date.parse(e.target.value + 'Z');
    if (Number.isFinite(ms)) { setTime(ms); renderPlanner(); renderNow({ full: true }); }
  });
  $('per-to').addEventListener('change', e => {
    const ms = Date.parse(e.target.value + 'Z');
    if (Number.isFinite(ms) && ms > app.t) setStay((ms - app.t) / DAY);
    else renderPeriod();
  });
  $('slip').addEventListener('input', e => { app.slip = Number(e.target.value); renderLate(); });
  $('delays').addEventListener('click', e => {
    const b = e.target.closest('button[data-delay]');
    if (b) { app.slip = Number(b.dataset.delay); renderLate(); }
  });
  $('watts').addEventListener('input', e => {
    const v = Number(e.target.value);
    if (v > 0) { app.watts = v; renderPower(); }
  });
  $('weights').addEventListener('input', e => {
    const k = e.target.dataset.weight;
    if (!k) return;
    app.weights[k] = Number(e.target.value);
    e.target.nextElementSibling.textContent = e.target.value;
    renderScore();
    renderCompare();
    renderNow();
  });
  $('windows').addEventListener('click', e => {
    const b = e.target.closest('button[data-open]');
    if (b) { setTime(Number(b.dataset.open)); renderNow({ full: true }); }
  });
  $('calendar').addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    const ms = app.calPick?.(e.clientX - r.left, e.clientY - r.top);
    if (Number.isFinite(ms)) { setTime(ms + 12 * HOUR); renderPlanner(); renderNow({ full: true }); }
  });
  $('cmp-body').addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    if (tr.dataset.id !== app.region.id) { app.custom = null; await loadRegion(tr.dataset.id); }
    await setSpot(tr.dataset.kind);
    $('stage').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  });
  $('share').addEventListener('click', async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      $('share-status').textContent = t('share.copied');
    } catch {
      $('share-status').textContent = t('share.failed');
    }
    setTimeout(() => { $('share-status').textContent = ''; }, 2500);
  });
  $('csv').addEventListener('click', csv);
  $('theme').addEventListener('click', () => {
    const light = document.documentElement.dataset.theme !== 'light';
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    try { localStorage.setItem('theme', light ? 'light' : 'dark'); } catch { /* private mode */ }
    renderSpot();
    renderNow({ full: true });
  });
  $('lang').addEventListener('click', () => {
    const next = ar() ? 'en' : 'ar';
    try { localStorage.setItem('lang', next); } catch { /* private mode */ }
    applyLang(next);
  });
  window.addEventListener('hashchange', async () => {
    const h = readHash();
    if (Number.isFinite(h.t)) setTime(h.t);
    if (h.site && h.site !== app.region.id) { app.custom = null; await loadRegion(h.site); }
    if (h.spot === 'custom' && Number.isFinite(h.lat)) await setSpot('custom', { lat: h.lat, lon: h.lon });
    else if (h.spot && h.spot !== app.kind) await setSpot(h.spot);
    else renderNow({ full: true });
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { app.tlFrom = 0; renderNow({ full: true }); renderIce(); renderScatter(); }, 150);
  });
  addEventListener('keydown', e => {
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); play(!playing); }
  });
}

function applyLang(lang) {
  setLang(lang);
  fillRegionSelect();
  renderWeights();
  app.navi?.relabel();
  if (app.spot) { renderTrust(); renderSpot(); setView(app.view); }
}

// --- motion ------------------------------------------------------------------------------

function intro() {
  // the hero has its own Navi button, so the floating one waits until the hero scrolls away
  new IntersectionObserver(([e]) => document.body.classList.toggle('hero-on', e.isIntersecting), { threshold: 0.35 }).observe($('stage'));
  if (reduceMotion) return;
  gsap.from('.hud', { opacity: 0, y: 16, duration: 1, stagger: 0.08, delay: 0.3, ease: 'power3.out' });
  for (const band of document.querySelectorAll('.band')) {
    gsap.from(band.querySelectorAll('.band-head, .card, .chart, .table-wrap, .long'), {
      y: 30, opacity: 0, duration: 0.9, stagger: 0.05, ease: 'power3.out',
      scrollTrigger: { trigger: band, start: 'top 80%', once: true },
    });
  }
}

// --- start -------------------------------------------------------------------------------

async function start() {
  let saved = {};
  try { saved = { theme: localStorage.getItem('theme'), lang: localStorage.getItem('lang') }; } catch { /* private mode */ }
  if (saved.theme) document.documentElement.dataset.theme = saved.theme;
  setLang(saved.lang === 'ar' ? 'ar' : 'en');

  const [eph, regionDoc, best, validation, tiles, illum, custom, terrainIndex] = await Promise.all([
    Ephemeris.load('./data/ephemeris'),
    json('./data/regions.json'), json('./data/best_spots.json'), json('./data/validation.json'),
    json('./data/tile_check.json'), json('./data/illumination_check.json'), json('./data/custom_check.json'),
    json('./data/terrain/index.json'),
  ]);
  app.scatter = await json('./data/scatter.json').catch(() => null);
  app.features = await json('./data/features.json').then(d => d.features).catch(() => null);
  app.rad = await json('./data/radiation.json').then(prepareRadiation).catch(() => null);
  Object.assign(app, { eph, terrainIndex, checks: { validation, tiles, illum, custom } });
  app.eclipses = eclipses(eph);
  app.checks.eclipse = await json('./data/eclipse_check.json').catch(() => null);
  app.regions = regionDoc.regions.filter(r => r.lat !== null && terrainIndex.regions[r.id]);
  for (const b of best.regions) app.best[b.id] = b;
  fillRegionSelect();
  renderWeights();
  $('when').min = new Date(eph.start).toISOString().slice(0, 16);
  $('when').max = new Date(eph.end).toISOString().slice(0, 16);

  try {
    app.space = new SpaceView($('space'), { labels: { sun: $('lbl-sun'), earth: $('lbl-earth'), site: $('lbl-site') } });
    app.stage = new Stage($('scene'), { onPick: (lat, lon) => setSpot('custom', { lat, lon }), labels: { sun: $('lbl-sun'), earth: $('lbl-earth') } });
    app.stage.setActive(false);
    $('scene-msg').remove();
    if (import.meta.env.DEV) Object.assign(window, { stage: app.stage, space: app.space }); // for poking at them from devtools
  } catch (err) {
    console.warn('3D view off:', err);
    $('scene-msg').textContent = t('stage.nogl');
  }
  for (const x of $('layer').children) x.setAttribute('aria-checked', String(x.dataset.layer === app.layer));
  for (const x of $('speed').children) x.setAttribute('aria-checked', String(Number(x.dataset.speed) === app.speed));
  for (const x of $('camera').children) x.setAttribute('aria-checked', String(x.dataset.cam === app.camera));

  const h = readHash();
  setTime(Number.isFinite(h.t) ? h.t : Date.now());
  await loadRegion(h.site);
  if (h.spot === 'custom' && Number.isFinite(h.lat)) await setSpot('custom', { lat: h.lat, lon: h.lon });
  else await setSpot(h.spot === 'centre' ? 'centre' : 'best');
  setView(h.view === 'site' ? 'site' : 'space');

  renderTrust();
  app.navi = createNavi(naviAnswer);
  bind();
  intro();

  // background: every region's horizons and grid, for the compare table and Navi
  await Promise.all(app.regions.flatMap(r => [horizon(r.id), horizon(`${r.id}--best`), grid(r.id)]).map(p => p.catch(() => {})));
  renderCompare();
}

start().catch(err => {
  console.error(err);
  $('site-name').textContent = 'Could not load the data';
  $('site-meta').textContent = err.message;
});
