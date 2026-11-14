# Lunar Navigator

Team Tuwaiq Lunar, NASA Space Apps Challenge 2026, challenge "Lunar Landing Site Navigator".

**Live site:** https://sayrz1.github.io/lunar-navigator/

Pick a landing region at the Moon's south pole and a time between November 2026 and January 2029. The app shows whether a lander there gets sunlight and a radio line to Earth, when that changes, which spot inside the region is best, when the landing windows are, what happens if the landing slips, and how far it is to permanently shadowed ground where ice can survive. English and Arabic.

## What's on the page

- **Space view:** the whole Moon in its own fixed frame, with the Sun and Earth placed from the JPL table. Press play and the Sun circles the Moon once a lunar day while Earth stays nearly still. The dashed lines show whether the chosen spot can see each one.
- **Site view:** the region's LOLA terrain lit from the Sun's true direction. "Stand on site" puts you 2 m above the spot with the real horizon around you and the Sun and Earth tracks for the next lunar day; "Face the Sun" and "Face Earth" turn you towards them. Layers show real light, the share of time sunlit, and permanent shadow.
- **Timeline:** Sun and Earth bands for the next few weeks. Drag to move the time, or play at 1 h, 6 h or 1 day per second.
- **Site score:** sunlight, Earth contact, the longest night and distance to ice, weighted by sliders. The score feeds the compare table and Navi.
- **Power:** battery needed to get through the longest night at a chosen power draw, compared with the region centre.
- **Planner:** a day-by-day calendar for the whole period, landing windows for a chosen surface stay, and an on-time vs late table for delays from 1 hour to 1 month.
- **Compare, water and trust:** all regions side by side, permanent shadow near the spot, and how each part was checked.
- **Share and export:** a link that reopens the same spot and time, and an hourly CSV for the next 30 days.

## Run it

```
npm install
npm run dev
```

Everything the page needs is in `public/data`, so it runs offline and can be hosted as static files (`npm run build`, then serve `dist/`).

## How it works

- **Sun and Earth positions:** an hourly table of the sub-solar and sub-Earth points on the Moon from JPL Horizons (MOON_ME frame). The browser rebuilds the direction of the Sun and Earth for any point from it.
- **Terrain horizons:** for each spot we walk 720 rays out to 250 km over LOLA terrain: the 5 m site tiles near the spot, then LDEM_80S_80M and LDEM_75S_240M. The eye is 2 m above the ground.
- **Best spots:** every 100 m inside each region we apply NASA's landing limits (slope under 10° over 100 m; 90% of the ground within 1 km under 20°; Earth visible at least 25% and Sun at least 5% of the time on NASA's long-term maps). The best 40 points get a full horizon and are ranked by hours with Sun and Earth together.
- **Custom points:** clicking the 3D terrain computes a horizon in the browser from lighter grids.

## Checks

| What | Against | Result |
|---|---|---|
| Ephemeris | 58 independent Horizons runs | worst difference 1.3 arcseconds |
| 5 m tiles | LDEM_80S_80M | 1–2 m RMS, no offset |
| Sunlight model | NASA LOLA illumination maps, 18.6 years, 200 random points | median 0.29 points (Sun), 0.06 (Earth) |
| Custom points | full 5 m build at 32 spots | median 1.9 points (Sun), worst 19 on steep ground |

Scripts: `npm run check:horizons`, `check:tiles`, `check:illumination`, `check:custom`. Data builds: `data:regions`, `data:ephemeris`, `data:horizons`, `data:best-spots`, `data:terrain`. The raw inputs (`data-raw/`, about 2 GB) are not in the repo; the sources are listed below.

## Data

- High-resolution LOLA topography for south pole sites, 5 m (Barker et al. 2021): https://pgda.gsfc.nasa.gov/products/78
- LOLA LDEM_80S_80M, LDEM_75S_240M, LDEM_75S_120M (NASA PDS): https://pds-geosciences.wustl.edu/missions/lro/lola.htm
- LOLA polar illumination and Earth visibility maps (Mazarico et al. 2011): https://pgda.gsfc.nasa.gov/products/69
- JPL Horizons: https://ssd.jpl.nasa.gov/horizons/
- Landing requirements: NASA Artemis Human Landing System update, 2024: https://ntrs.nasa.gov/citations/20240009596
- 3D Moon texture: NASA SVS CGI Moon Kit (LROC colour map): https://svs.gsfc.nasa.gov/4720/
- Earth texture: three.js example textures (MIT): https://github.com/mrdoob/three.js/tree/r170/examples/textures/planets
- Landing regions: NASA, October 2024: https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/

## Use of AI

We used an AI coding assistant (Claude, by Anthropic) to help optimize code and clean text. We ran and checked all the data processing ourselves, and every result traces back to the NASA and JPL sources above. The in-app helper "Navi" is not an AI model: it answers from the page's own numbers with fixed rules. No AI-generated images are used. The Navi mascot is a small drawing made in CSS for this project.

Not an official NASA product.
