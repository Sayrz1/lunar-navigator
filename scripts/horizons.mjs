// Small helpers for the JPL Horizons API (https://ssd-api.jpl.nasa.gov/doc/horizons.html).
// Used by the build scripts only: the API sends no CORS headers, so the browser can't call it.

const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

export async function horizons(params, tries = 3) {
  const q = new URLSearchParams({ format: 'json' });
  for (const [k, v] of Object.entries(params)) q.set(k, `'${v}'`);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${API}?${q}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      if (!body.result.includes('$$SOE')) throw new Error(body.result.slice(0, 400));
      return body.result;
    } catch (err) {
      if (attempt >= tries) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// Rows between $$SOE and $$EOE, split into trimmed CSV fields.
export function tableRows(text) {
  const a = text.indexOf('$$SOE') + 5;
  const b = text.indexOf('$$EOE');
  return text.slice(a, b).trim().split('\n').map(line => line.split(',').map(s => s.trim()));
}

// Column names from the header line just above $$SOE.
export function tableHeader(text) {
  const head = text.slice(0, text.indexOf('$$SOE')).trimEnd().split('\n');
  const line = head.reverse().find(l => l.includes('Date__'));
  return line.split(',').map(s => s.trim());
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// "2026-Nov-14 00:00" (UT) -> ms since epoch
export function parseHorizonsTime(s) {
  const m = s.match(/(\d{4})-(\w{3})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?/);
  if (!m) throw new Error(`bad Horizons time: ${s}`);
  return Date.UTC(+m[1], MONTHS[m[2]], +m[3], +m[4], +m[5], 0) + (m[6] ? +m[6] * 1000 : 0);
}
