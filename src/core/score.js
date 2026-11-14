// Site score and battery sizing, both from the hour-by-hour summary of a spot.

export const DEFAULT_WEIGHTS = { power: 4, earth: 3, night: 2, water: 1 };

// Each part runs 0-1:
//   power  share of hours sunlit (85 % or more counts as full marks)
//   earth  share of hours with Earth in view
//   night  longest night: 0 days = 1, 30 days or more = 0
//   water  nearest permanent shadow: 0.5 km or closer = 1, 10 km or more (or none) = 0
export function siteScore(summary, iceKm, weights = DEFAULT_WEIGHTS) {
  const clamp = v => Math.min(1, Math.max(0, v));
  const parts = {
    power: clamp(summary.sunPct / 85),
    earth: clamp(summary.earthPct / 100),
    night: clamp(1 - summary.longestDarkH / 24 / 30),
    water: iceKm == null ? 0 : clamp(1 - (iceKm - 0.5) / 9.5),
  };
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const score = Object.entries(parts).reduce((a, [k, v]) => a + v * (weights[k] ?? 0), 0) / total;
  return { score: Math.round(score * 100), parts };
}

// Battery that carries a lander through the longest night at `watts`.
// Lithium-ion packs at about 150 Wh/kg, drawn down to 20 % at most.
export function battery(nightHours, watts, whPerKg = 150, depth = 0.8) {
  const kWh = (watts * nightHours) / depth / 1000;
  return { kWh, kg: (kWh * 1000) / whPerKg };
}
