// Sun and Earth positions as seen from any point on the Moon.
//
// The data is an hourly table from JPL Horizons (scripts/fetch-ephemeris.mjs): the
// sub-solar point and sub-Earth point on the Moon in the MOON_ME frame, plus the
// Sun-Moon and Earth-Moon distances. From those we can rebuild the topocentric direction
// of the Sun and Earth for any site, so custom points need no extra API calls.

export const MOON_RADIUS_KM = 1737.4;
export const SYNODIC_DAYS = 29.530589;

const AU_KM = 149597870.7;
const C_KMS = 299792.458;
const EARTH_ORBIT_KMS = 29.78;
const DEG = Math.PI / 180;

// Columns of one row in the binary table.
export const COLUMNS = ['sunLon', 'sunLat', 'sunAu', 'earthLon', 'earthLat', 'earthAu'];

function unpack(bytes, rows, cols) {
  const bits = new Int32Array(rows * cols);
  for (let c = 0; c < cols; c++) {
    const p = c * 4 * rows;
    let v = 0;
    for (let r = 0; r < rows; r++) {
      const d = bytes[p + r] | (bytes[p + rows + r] << 8) | (bytes[p + 2 * rows + r] << 16) | (bytes[p + 3 * rows + r] << 24);
      v = (v + d) | 0;
      bits[r * cols + c] = v;
    }
  }
  return new Float32Array(bits.buffer);
}

export class Ephemeris {
  constructor(meta, values) {
    this.start = Date.parse(meta.start);
    this.stepMs = meta.stepHours * 3600e3;
    this.rows = meta.rows;
    this.meta = meta;
    this.v = values;
  }

  // The browser gets the packed copy (scripts/pack-ephemeris.mjs): per column, the
  // difference between neighbouring rows' 32-bit patterns, split into byte planes.
  static async load(base = './data/ephemeris') {
    const [meta, buf] = await Promise.all([
      fetch(`${base}.json`).then(r => r.json()),
      fetch(`${base}.packed.bin`).then(r => r.arrayBuffer()),
    ]);
    return new Ephemeris(meta, unpack(new Uint8Array(buf), meta.rows, COLUMNS.length));
  }

  get end() {
    return this.start + (this.rows - 1) * this.stepMs;
  }

  covers(ms) {
    return ms >= this.start && ms <= this.end;
  }

  // Linear interpolation between hourly rows. Longitudes are unwrapped first.
  // Over one hour the sub-solar point moves about 0.5 deg at a near-constant rate,
  // so the interpolation error is far below the table's own accuracy.
  sample(ms) {
    if (!this.covers(ms)) throw new RangeError(`date outside ephemeris: ${new Date(ms).toISOString()}`);
    const f = (ms - this.start) / this.stepMs;
    const i = Math.min(Math.floor(f), this.rows - 2);
    const k = f - i;
    const n = COLUMNS.length;
    const a = i * n, b = a + n, v = this.v;
    const lerp = j => v[a + j] + (v[b + j] - v[a + j]) * k;
    const lerpLon = j => {
      let d = v[b + j] - v[a + j];
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      return v[a + j] + d * k;
    };
    return {
      sunLon: lerpLon(0), sunLat: lerp(1), sunKm: lerp(2) * AU_KM,
      earthLon: lerpLon(3), earthLat: lerp(4), earthKm: lerp(5) * AU_KM,
    };
  }
}

function unit(latDeg, lonDeg) {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Local East/North/Up frame of a site in the Moon's body-fixed (MOON_ME) frame.
// heightM is above the 1737.4 km reference sphere, the same datum as LOLA.
export function siteFrame(lat, lon, heightM = 0) {
  const up = unit(lat, lon);
  const lo = lon * DEG, la = lat * DEG;
  return {
    lat, lon, heightM,
    pos: up.map(c => c * (MOON_RADIUS_KM + heightM / 1000)),
    up,
    east: [-Math.sin(lo), Math.cos(lo), 0],
    north: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
  };
}

function toAzEl(frame, d) {
  const n = Math.hypot(d[0], d[1], d[2]);
  const el = Math.asin(dot(d, frame.up) / n) / DEG;
  let az = Math.atan2(dot(d, frame.east), dot(d, frame.north)) / DEG;
  if (az < 0) az += 360;
  return { az, el, km: n };
}

// Annual aberration seen from the Moon (about 20.5 arcsec). The sub-Earth point that
// Horizons reports does not include it for a lunar observer, so we add it to the Earth
// direction. The size comes from the Moon's ~29.8 km/s motion around the Sun, and the
// direction is along that motion in the ecliptic, which is within 1.6 deg of the Moon's
// equator. The sign was set by comparing with Horizons topocentric output: with it, the
// worst difference over 13 sites and a year of data is 1.2 arcsec (validate-horizons.mjs).
function withAberration(d, s) {
  const n = Math.hypot(d[0], d[1], d[2]);
  const u = d.map(c => c / n);
  const sun = unit(s.sunLat, s.sunLon);
  const v = [-sun[1], sun[0], 0];
  const au = s.sunKm / AU_KM;
  const k = EARTH_ORBIT_KMS * Math.sqrt(2 / au - 1) / C_KMS / Math.hypot(v[0], v[1]);
  const vu = dot(v, u) * k;
  return u.map((c, i) => (c + v[i] * k - vu * c) * n);
}

// Topocentric azimuth (from North through East) and elevation above the flat local
// horizon, in degrees, for the Sun and Earth centres. No terrain here: horizon.js does that.
export function sunEarthAt(eph, ms, frame) {
  const s = eph.sample(ms);
  const sunVec = unit(s.sunLat, s.sunLon).map((c, i) => c * s.sunKm - frame.pos[i]);
  const earthVec = unit(s.earthLat, s.earthLon).map((c, i) => c * s.earthKm - frame.pos[i]);
  return {
    sun: toAzEl(frame, sunVec),
    earth: toAzEl(frame, withAberration(earthVec, s)),
  };
}
