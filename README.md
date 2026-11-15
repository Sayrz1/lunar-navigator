# Lunar Navigator

**Live site:** https://sayrz1.github.io/lunar-navigator/

Pick one of NASA's 9 candidate landing regions at the Moon's south pole (October 2024 list), or click your own point, and a time between November 2026 and the end of 2035. The app shows whether a lander there gets sunlight and a radio line to Earth, when that changes, which spot inside the region we pick, when the landing windows are, what happens if the landing slips, and how far it is to permanently shadowed ground where ice can survive and the radiation background there. The Sun, Earth, terrain and radiation numbers come from NASA data; the score weights and battery figures are our own assumptions. English and Arabic, on desktop and phone.

## What's on the page

- **Space view:** the whole Moon with the Sun and Earth placed from the JPL table, in two frames. Moon-fixed: press play and the Sun circles the Moon once a lunar day while Earth stays nearly still. Sun-fixed: the Sun holds still, the Moon turns and Earth goes round it once a month. The dashed lines show whether the chosen spot can see each one. Zoom with the wheel or the + and − buttons.
- **Site view:** the region's LOLA terrain lit from the Sun's true direction. "Stand on site" puts you 2 m above the spot with the real horizon around you and the Sun and Earth tracks for the next lunar day; "Face the Sun" and "Face Earth" turn you towards them. Layers show real light, the share of time sunlit, and permanent shadow.
- **Timeline:** Sun and Earth bands for the next few weeks. Drag to move the time, or play at 1 h, 6 h or 1 day per second.
- **Site score:** sunlight, Earth contact, the longest night and distance to ice, weighted by sliders. The score feeds the compare table and Navi.
- **Power:** battery needed to get through the longest night at a chosen power draw, compared with the region centre.
- **Planner:** a day-by-day calendar with a year picker, a mission period (from and to dates) with Sun, Earth, longest night and radiation over exactly those hours, landing windows for a chosen surface stay (6 days by default, the middle of the 5.75–6.25 days NASA gives for Artemis III), and an on-time vs late table for delays from 1 hour to 1 month.
- **Visibility rules:** choose how much of the Sun's disc must clear the terrain (any part by default, half, all) and how far above the terrain Earth must be for a usable radio link (0°, 2°, 5°). Everything about the chosen spot follows them; the compare table and our picks use the defaults.
- **Baseline comparison:** keep one site, spot and period as a baseline, then change any of them and see what you gain or lose: sunlight, Earth contact, longest night and outage, radiation and distance to ice.
- **Radiation:** the daily dose equivalent (mSv) on the surface from LRO CRaTER, 2009 to 2026, with days above our dose-rate threshold marked (mostly solar storms). It is an illustration of the unshielded environment, not a crew dose, so we do not compare it with astronaut limits. After the last measurement the rate comes from the same point of the previous 11-year solar cycle, shown as an estimate. The dose at the spot is scaled by how much of the sky its horizon leaves open.
- **Lunar eclipses:** when Earth passes in front of the Sun, a lander loses solar power for up to about five hours. The mission period lists any eclipse inside it, and landing windows whose stay could include one are tagged.
- **Named features:** the official IAU names near the spot (centre, diameter, latitude and longitude range), from the USGS Gazetteer, the same records LROC QuickMap shows.
- **Landing scatter:** a map of how sunlight and Earth contact change within 100 m of the spot, with steep ground crossed out.
- **Compare, water and trust:** all 9 regions side by side (centre and our pick), permanent shadow near the spot, and how each part was checked.
- **Share and export:** a link that reopens the same spot and time, and an hourly CSV for the next 30 days (Sun and Earth direction, terrain height in that direction, clearance, visible share of the Sun's disc, and the visibility rule in use).

## Run it

```
npm install
npm run dev
```

Everything the page needs is in `public/data`, so it runs offline and can be hosted as static files (`npm run build`, then serve `dist/`).

## How it works

- **Sun and Earth positions:** an hourly table of the sub-solar and sub-Earth points on the Moon from the JPL Horizons API (MOON_ME frame), November 2026 to January 2036, 80,353 rows. The browser rebuilds the direction of the Sun and Earth for any point from it, so the page never calls Horizons live. The browser gets a packed copy (`ephemeris.packed.bin`, `scripts/pack-ephemeris.mjs`): the same float values, stored as row-to-row differences in byte planes, which compresses to 0.5 MB instead of 1.7 MB.
- **Terrain horizons:** for each spot we walk 720 rays out to 250 km over LOLA terrain: the 5 m site tiles near the spot, then LDEM_80S_80M and LDEM_75S_240M. The eye is 2 m above the ground.
- **Our picks:** every 100 m inside each region we apply NASA's landing limits (slope under 10° over 100 m; 90% of the ground within 1 km under 20°; Earth visible at least 25% and Sun at least 5% of the time on NASA's long-term maps). The best 40 points get a full horizon and are ranked by hours with Sun and Earth together; the top one is our pick. That is the best of 40 worked-out candidates, not a proven best for the whole region. The requirements card then checks walkability over NASA's full 2 km.
- **Landing scatter:** a lander aims at a spot but lands somewhere near it. Around each centre and pick we rebuild the full horizon on a 9 × 9 grid, 25 m apart, and report the range within 100 m (NASA sets its slope limit over a 100 m landing area). Some picks are robust (Mons Mouton Plateau: 45–70% with Sun and Earth together); others are fragile (the peak near Cabeus B: 2–59%).
- **Custom points:** clicking the 3D terrain computes a horizon in the browser from lighter grids.
- **Radiation:** hourly dose rates from CRaTER's D1&2 detectors (two official products: absorbed dose in water, cGy/day, and dose equivalent, cSv/day, both corrected to the lunar surface). We keep the daily median and maximum. The background rate is the quieter quarter of the days within two weeks of the date, so storms don't inflate it; storms are counted separately.

## Checks

| What | Against | Result |
|---|---|---|
| Ephemeris | 58 independent Horizons runs | worst difference 1.4 arcseconds |
| 5 m tiles | LDEM_80S_80M | 1–2 m RMS, no offset |
| Sunlight model | NASA LOLA illumination maps, 18.6 years, 200 random points | median 0.29 points (Sun), 0.06 (Earth); mean 0.68 and 0.48; correlation 0.993 (Sun), 0.997 (Earth) |
| Custom points | full 5 m build at 32 spots | median 1.9 points (Sun), worst 19 on steep ground |
| Region positions | NASA Lunar Surface Data Book (ACD-50044 Rev A, 2023), Table A2-2 | all 6 of our regions that it lists match to the metre (the other 7 it lists, from NASA's 2022 list, match too but are no longer shown); the three 2024 regions come from NASA's 2024 map |
| Longest night | Data Book: about 150 h without sunlight in winter at the best-lit spots of Connecting Ridge and de Gerlache | 137–139 h every year, 2027–2035, at the sunniest point of NASA's map in Connecting Ridge and de Gerlache Rim 1 |
| Highest Sun | Data Book: the Sun gets no higher than about 7° at the south pole | 7.6° at Nobile Rim 2, the region furthest from the pole; 2.1° at Connecting Ridge |
| Lunar eclipses | NASA Five Millennium Catalog of Lunar Eclipses, 2026–2035 | 19 of 21 found, peak times within 0.9 min; the 2 missed only graze the Moon's edge |
| Radiation | CRaTER record itself | measured every day from 27 June 2009 to 7 October 2026 (6,207 days); no instrument has measured radiation at the south pole yet, so there is no surface reading to compare with |

Scripts: `npm run check:horizons`, `check:tiles`, `check:illumination`, `check:custom`, `check:eclipses`. Data builds: `data:regions`, `data:ephemeris`, `data:horizons`, `data:best-spots`, `data:terrain`, `data:scatter`, `data:radiation`, `data:features`. The raw inputs (`data-raw/`, about 2 GB) are not in the repo; the sources are listed below.

## Limits

Horizons are for an eye 2 m above the ground, and times are UTC. Dates run from November 2026 to the end of 2035. Earth "in view" means a clear line of sight to its centre: no link budget or relay satellites. By default the Sun counts as up when any part of its disc clears the terrain (the planner can change this); panel tilt, dust and temperature are not modelled. Terrain is 5 m only inside NASA's high-resolution tiles. The battery figure is energy only. Permanent shadow marks where ice can survive, not where it has been found. Sun percentages do not take out lunar eclipses (listed separately in the planner). The 9 regions were chosen for Artemis III; since February 2026 the first crewed landing is Artemis IV (targeted for 2028), and the 9 regions are still NASA's published candidates. Radiation is dose equivalent from CRaTER's own particle weighting; after 7 October 2026 (the last file the CRaTER team has published) it is an estimate from the previous solar cycle, and it leaves out shielding by a lander or habitat.

## About

Built by team Tuwaiq Lunar for the NASA Space Apps Challenge 2026, for the challenge "Lunar Landing Site Navigator". The data it uses is listed below.

Not an official NASA product.

## Data

- High-resolution LOLA topography for south pole sites, 5 m (Barker et al. 2021): https://pgda.gsfc.nasa.gov/products/78
- LOLA LDEM_80S_80M, LDEM_75S_240M, LDEM_75S_120M (NASA PDS): https://pds-geosciences.wustl.edu/missions/lro/lola.htm
- LOLA polar illumination and Earth visibility maps (Mazarico et al. 2011): https://pgda.gsfc.nasa.gov/products/69
- JPL Horizons: https://ssd.jpl.nasa.gov/horizons/
- Landing requirements: NASA Artemis Human Landing System update, 2024: https://ntrs.nasa.gov/citations/20240009596
- 3D Moon texture: NASA SVS CGI Moon Kit (LROC colour map): https://svs.gsfc.nasa.gov/4720/
- Earth texture: three.js example textures (MIT): https://github.com/mrdoob/three.js/tree/r170/examples/textures/planets
- LRO CRaTER dose rates (NASA LRO instrument, data hosted by the University of New Hampshire team): https://crater-web.sr.unh.edu/doserates.html
- IAU Gazetteer of Planetary Nomenclature (USGS Astrogeology): https://planetarynames.wr.usgs.gov/
- Artemis III site selection update: T. George, M. A. Rubio, S. J. Lawrence and P. Curell (NASA), "Artemis III Site Selection Update: Down-selection from 13 to 9 Candidate Regions", 57th Lunar and Planetary Science Conference (2026), abstract 1901: https://www.hou.usra.edu/meetings/lpsc2026/pdf/1901.pdf
- NASA Artemis III site selection report (NTRS 20250011660): https://ntrs.nasa.gov/citations/20250011660
- NASA Five Millennium Catalog of Lunar Eclipses (Espenak & Meeus): https://eclipse.gsfc.nasa.gov/LEcat5/LE2001-2100.html
- NASA Lunar Surface Data Book, ACD-50044 Rev A (2023): region centres (Table A2-2), polar night survival (Appendix E): https://ntrs.nasa.gov/citations/20230007818
- Landing regions: NASA, October 2024: https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/
- NASA's October 2024 region map, used to place the three regions that are not in the Data Book: https://www.nasa.gov/wp-content/uploads/2024/10/artemis-iii-landing-region-candidates.jpg

## Use of AI

We used an AI coding assistant (Claude, by Anthropic) to help write and review some of the code, check our numbers against the NASA sources and edit the text. The team chose the data, the design and the checks, and reviewed every result.

The Sun, Earth, terrain and radiation numbers all come from the NASA and JPL data listed above. Navi, the in-app helper, is not an AI: it answers from the page's own numbers using fixed rules. No image in this project is AI-generated; the Navi mascot is a small drawing made in code for this project.
