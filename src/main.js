import { Ephemeris, siteFrame, SYNODIC_DAYS } from './core/ephemeris.js';
import { stateAt, nextChange, track } from './core/analysis.js';
import { drawHorizonChart } from './ui/charts.js';

const $ = id => document.getElementById(id);
const app = { eph: null, regions: [], site: null, hz: null, frame: null, t: 0 };

const fmtDeg = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}°`;
const fmtUtc = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function fmtSpan(ms) {
  const h = ms / 3600e3;
  if (h < 48) return `${Math.floor(h)} h ${Math.round((h % 1) * 60)} min`;
  return `${(h / 24).toFixed(1)} days`;
}

// --- URL state: #site=haworth&t=2027-01-16T10:00Z ---------------------------------------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { site: p.get('site'), t: p.get('t') ? Date.parse(p.get('t')) : NaN };
}

function writeHash() {
  const t = new Date(app.t).toISOString().slice(0, 16) + 'Z';
  history.replaceState(null, '', `#site=${app.site.id}&t=${t}`);
}

// --- loading -----------------------------------------------------------------------------

async function loadSite(id) {
  app.site = app.regions.find(r => r.id === id) ?? app.regions[0];
  app.hz = await fetch(`./data/horizons/${app.site.id}.json`).then(r => r.json());
  app.frame = siteFrame(app.hz.lat, app.hz.lon, app.hz.groundM + app.hz.observerM);
  $('site').value = app.site.id;
}

// --- rendering ---------------------------------------------------------------------------

function row(label, value) {
  return `<dt>${label}</dt><dd>${value}</dd>`;
}

function render() {
  const { eph, site, hz, frame, t } = app;
  const s = stateAt(eph, t, frame, hz);

  $('site-name').textContent = site.name;
  $('site-meta').textContent =
    `${Math.abs(site.lat).toFixed(3)}°S ${Math.abs(site.lon).toFixed(3)}°${site.lon >= 0 ? 'E' : 'W'} · ` +
    `ground ${hz.groundM.toFixed(0)} m · ${fmtUtc(t)}`;

  const sunNext = nextChange(eph, t, frame, hz, x => x.sunlit);
  const earthNext = nextChange(eph, t, frame, hz, x => x.earthInView);

  $('sun-state').textContent = s.sunlit ? `Sunlit (${Math.round(s.sun.disc * 100)}% of disc)` : 'In shadow';
  $('sun-state').className = 'state ' + (s.sunlit ? 'ok' : 'bad');
  $('sun-numbers').innerHTML =
    row('Elevation', fmtDeg(s.sun.el)) +
    row('Terrain at that azimuth', fmtDeg(s.sun.horizon)) +
    row('Clearance', fmtDeg(s.sun.clear)) +
    row('Azimuth', `${s.sun.az.toFixed(1)}°`) +
    row(s.sunlit ? 'Sunset in' : 'Sunrise in', sunNext ? fmtSpan(sunNext.at - t) : '> 60 days');

  $('earth-state').textContent = s.earthInView ? 'In view' : 'Below the terrain';
  $('earth-state').className = 'state ' + (s.earthInView ? 'ok' : 'bad');
  $('earth-numbers').innerHTML =
    row('Elevation', fmtDeg(s.earth.el)) +
    row('Terrain at that azimuth', fmtDeg(s.earth.horizon)) +
    row('Clearance', fmtDeg(s.earth.clear)) +
    row('Azimuth', `${s.earth.az.toFixed(1)}°`) +
    row(s.earthInView ? 'Earthset in' : 'Earthrise in', earthNext ? fmtSpan(earthNext.at - t) : '> 60 days');

  const path = track(eph, t, Math.round(SYNODIC_DAYS * 24), frame, hz);
  drawHorizonChart($('horizon-chart'), hz, path, s);
  writeHash();
}

function setTime(ms) {
  const { eph } = app;
  app.t = Math.min(Math.max(ms, eph.start), eph.end);
  $('when').value = new Date(app.t).toISOString().slice(0, 16);
}

// --- start -------------------------------------------------------------------------------

async function start() {
  const [eph, regionDoc, validation] = await Promise.all([
    Ephemeris.load('./data/ephemeris'),
    fetch('./data/regions.json').then(r => r.json()),
    fetch('./data/validation.json').then(r => r.json()),
  ]);
  app.eph = eph;
  app.regions = regionDoc.regions.filter(r => r.lat !== null);

  const groups = { 2024: 'NASA candidate regions (2024)', 2022: 'Earlier candidates (2022 only)', none: 'Other study sites' };
  const group = r => (r.nasa_lists.includes('2024') ? 2024 : r.nasa_lists.includes('2022') ? 2022 : 'none');
  $('site').innerHTML = Object.entries(groups).map(([key, label]) =>
    `<optgroup label="${label}">` +
    app.regions.filter(r => String(group(r)) === key).map(r => `<option value="${r.id}">${r.name}</option>`).join('') +
    '</optgroup>').join('');

  $('when').min = new Date(eph.start).toISOString().slice(0, 16);
  $('when').max = new Date(eph.end).toISOString().slice(0, 16);

  const fromUrl = readHash();
  setTime(Number.isFinite(fromUrl.t) ? fromUrl.t : Date.now());
  await loadSite(fromUrl.site);

  $('trust-line').textContent =
    `Sun and Earth positions come from JPL Horizons. Checked against ${validation.team.length + validation.live.length} ` +
    `Horizons tables: worst difference ${(validation.worstDeg * 3600).toFixed(1)} arcseconds.`;

  $('site').addEventListener('change', async e => { await loadSite(e.target.value); render(); });
  $('when').addEventListener('change', e => {
    const ms = Date.parse(e.target.value + 'Z');
    if (Number.isFinite(ms)) { setTime(ms); render(); }
  });
  // someone pastes or follows a shared link while the app is open
  window.addEventListener('hashchange', async () => {
    const h = readHash();
    if (Number.isFinite(h.t)) setTime(h.t);
    if (h.site && h.site !== app.site.id) await loadSite(h.site);
    render();
  });
  $('theme').addEventListener('click', () => {
    const light = document.documentElement.dataset.theme !== 'light';
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    $('theme').textContent = light ? 'Dark' : 'Light';
    render();
  });

  render();
}

start().catch(err => {
  console.error(err);
  $('site-name').textContent = 'Could not load the data';
  $('site-meta').textContent = err.message;
});
