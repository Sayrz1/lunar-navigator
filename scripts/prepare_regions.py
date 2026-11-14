"""Build public/data/regions.json: NASA's Artemis candidate landing regions with checked
positions, ground heights and slope statistics.

Inputs (not in git):
  DATA/01_Real_Elevation_DEMs_and_Slopes.zip   team copy of the LOLA 5 m/px site DEMs
                                               (Barker et al., NASA GSFC PGDA)
  data-raw/artemis-iii-landing-region-candidates.jpg
        https://www.nasa.gov/wp-content/uploads/2024/10/artemis-iii-landing-region-candidates.jpg

Why this script exists: the team's coordinate table (and the Horizons runs made from it)
placed most regions 10-150 km away from where NASA drew them. We take positions from two
sources and check them against a third:
  1. The 5 m DEM tiles. Their GeoTIFF extents are exact, and six of them sit on boxes of
     NASA's 2024 map to within 0.3 km.
  2. NASA's 2024 map, registered to those tiles (scale, rotation, offset). This gives the
     three 2024 regions we have no tile for.
  3. Check: NASA's Lunar Surface Data Book (ACD-50044 Rev A, 2023), Table A2-2, lists the
     centres of the 2022 regions. Every tile centre should land on its entry.

usage: python scripts/prepare_regions.py
"""
import json
import math
import struct
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[1]
DEM_ZIP = ROOT / 'DATA' / '01_Real_Elevation_DEMs_and_Slopes.zip'
NASA_MAP = ROOT / 'data-raw' / 'artemis-iii-landing-region-candidates.jpg'
OUT = ROOT / 'public' / 'data' / 'regions.json'

R_KM = 1737.4

# Folder in the zip -> region. The folder names are the team's; several were wrong.
# "verified" says how we know where the tile is.
TILES = {
    '08_Haworth': ('haworth', 'matches NASA 2024 map box'),
    '09_Malapert_Massif': ('malapert-massif', 'matches NASA 2024 map box'),
    '10_Leibnitz_Beta_Plateau': ('mons-mouton', 'matches NASA 2024 map box'),
    '11_Nobile_Rim_1': ('nobile-rim-1', 'matches NASA 2024 map box'),
    '12_Nobile_Rim_2': ('nobile-rim-2', 'matches NASA 2024 map box'),
    '06_de_Gerlache_Rim_2': ('de-gerlache-rim-2', 'matches NASA 2024 map box'),
    '02_Peak_Near_Shackleton': ('peak-near-shackleton', 'consistent with NASA 2022 rendering'),
    '03_Connecting_Ridge': ('connecting-ridge', 'consistent with NASA 2022 rendering'),
    '04_Connecting_Ridge_Extension': ('connecting-ridge-extension', 'consistent with NASA 2022 rendering'),
    '05_de_Gerlache_Rim_1': ('de-gerlache-rim-1', 'consistent with NASA 2022 rendering'),
    '07_de_Gerlache_Kocher_Massif': ('de-gerlache-kocher-massif', 'consistent with NASA 2022 rendering'),
    # Labelled "Faustini Rim A" by the team, but it lies on Amundsen crater's inner rim,
    # where NASA's 2022 rendering draws Amundsen Rim.
    '01_Faustini_Rim_A': ('amundsen-rim', 'on Amundsen crater rim; team label said Faustini Rim A'),
    # Labelled "Amundsen Rim" by the team, but it is NASA's Shoemaker Rim C (LM4 in the
    # Data Book), not a candidate region. Kept as an extra study site.
    '13_Amundsen_Rim': ('shoemaker-rim', 'on Shoemaker crater rim; team label said Amundsen Rim'),
}

# NASA Lunar Surface Data Book, ACD-50044 Rev A (May 2023), Table A2-2: centres of the
# south pole sites, from the PGDA DEM files (accurate to 5-10 m).
# https://ntrs.nasa.gov/citations/20230007818
DATA_BOOK = {
    'amundsen-rim': (-84.2287, 69.44396),
    'nobile-rim-2': (-83.954, 58.82206),
    'haworth': (-86.7639, -22.777),
    'shoemaker-rim': (-88.9645, 37.23483),
    'faustini-rim-a': (-87.8897, 90.0),
    'connecting-ridge': (-89.4632, -137.49),
    'nobile-rim-1': (-85.4381, 37.36667),
    'peak-near-shackleton': (-88.811, 123.6901),
    'de-gerlache-rim-1': (-88.6834, -67.9321),
    'mons-mouton': (-85.4266, 31.74276),
    'malapert-massif': (-85.9948, -0.23578),
    'de-gerlache-kocher-massif': (-85.8296, -116.322),
    'de-gerlache-rim-2': (-88.23, -64.6284),
    'connecting-ridge-extension': (-89.0324, -101.999),
}
DATA_BOOK_SOURCE = 'NASA Lunar Surface Data Book, ACD-50044 Rev A (2023), Table A2-2'


def metres_between(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 1737.4e3 * math.asin(math.sqrt(h))

REGIONS = {
    # id: (name, earlier names, lists it appears in)
    'peak-near-cabeus-b': ('Peak near Cabeus B', [], ['2024']),
    'haworth': ('Haworth', [], ['2022', '2024']),
    'malapert-massif': ('Malapert Massif', [], ['2022', '2024']),
    'mons-mouton-plateau': ('Mons Mouton Plateau', [], ['2024']),
    'mons-mouton': ('Mons Mouton', ['Leibnitz Beta Plateau'], ['2022', '2024']),
    'nobile-rim-1': ('Nobile Rim 1', [], ['2022', '2024']),
    'nobile-rim-2': ('Nobile Rim 2', [], ['2022', '2024']),
    'de-gerlache-rim-2': ('de Gerlache Rim 2', [], ['2022', '2024']),
    'slater-plain': ('Slater Plain', [], ['2024']),
    'peak-near-shackleton': ('Peak Near Shackleton', [], ['2022']),
    'connecting-ridge': ('Connecting Ridge', [], ['2022']),
    'connecting-ridge-extension': ('Connecting Ridge Extension', [], ['2022']),
    'de-gerlache-rim-1': ('de Gerlache Rim 1', [], ['2022']),
    'de-gerlache-kocher-massif': ('de Gerlache-Kocher Massif', [], ['2022']),
    'amundsen-rim': ('Amundsen Rim', [], ['2022']),
    'faustini-rim-a': ('Faustini Rim A', [], ['2022']),
    'shoemaker-rim': ('Shoemaker Rim C', [], []),
}

# Approximate pixel centre of each labelled box on NASA's 2024 map, read by eye from the
# printed labels. Only used to tell the detected boxes apart.
MAP_LABELS = {
    'peak-near-cabeus-b': (102, 511),
    'haworth': (610, 437),
    'malapert-massif': (745, 326),
    'mons-mouton-plateau': (1060, 232),
    'nobile-rim-2': (1309, 421),
    'de-gerlache-rim-2': (573, 679),
    'slater-plain': (997, 940),
}


def stereo_to_latlon(x_km, y_km):
    """South polar stereographic (LOLA convention, +y toward 0 deg E) to lat/lon."""
    rho = math.hypot(x_km, y_km)
    lat = -90 + math.degrees(2 * math.atan(rho / (2 * R_KM)))
    lon = math.degrees(math.atan2(x_km, y_km))
    return lat, lon


LDEM80 = ROOT / 'data-raw' / 'ldem_80s_80m.img'


def ldem80_height(x_km, y_km):
    """Height (m) from LOLA LDEM_80S_80M for regions without a 5 m tile. Grid layout from
    its PDS label: 7600 x 7600 int16, DN * 0.5 m, 80 m/px, projection offset 3799.5 px."""
    dn = np.memmap(LDEM80, dtype='<i2', mode='r', shape=(7600, 7600))
    col = x_km * 1000 / 80 + 3799.5
    row = 3799.5 - y_km * 1000 / 80
    h = ndi.map_coordinates(dn.astype(np.float32)[int(row) - 2:int(row) + 4, int(col) - 2:int(col) + 4],
                            [[row - (int(row) - 2)], [col - (int(col) - 2)]], order=1)[0] * 0.5
    return round(float(h), 1)


def read_tiff(data):
    """Minimal reader for the uncompressed float32 GeoTIFFs in the zip."""
    bo = '<' if data[:2] == b'II' else '>'
    ifd = struct.unpack(bo + 'I', data[4:8])[0]
    count = struct.unpack(bo + 'H', data[ifd:ifd + 2])[0]
    size = {3: 2, 4: 4, 12: 8}
    code = {3: 'H', 4: 'I', 12: 'd'}
    tags = {}
    for i in range(count):
        e = data[ifd + 2 + 12 * i: ifd + 14 + 12 * i]
        tag, typ, n = struct.unpack(bo + 'HHI', e[:8])
        if typ not in code:
            continue
        nbytes = size[typ] * n
        raw = e[8:8 + nbytes] if nbytes <= 4 else data[struct.unpack(bo + 'I', e[8:12])[0]:][:nbytes]
        tags[tag] = struct.unpack(bo + code[typ] * n, raw)
    w, h = tags[256][0], tags[257][0]
    assert tags.get(259, (1,))[0] == 1, 'compressed TIFF not supported'
    assert tags[258][0] == 32, 'expected float32 samples'
    pixels = b''.join(data[o:o + c] for o, c in zip(tags[273], tags[279]))
    z = np.frombuffer(pixels, dtype=bo + 'f4').reshape(h, w)
    scale, tie = tags[33550], tags[33922]
    x0, y1 = tie[3] / 1000, tie[4] / 1000  # top-left corner, km
    return z, (x0, x0 + w * scale[0] / 1000, y1 - h * scale[1] / 1000, y1)


def tile_stats(zf, folder):
    names = [n for n in zf.namelist() if n.split('/')[-2:-1] == [folder] and n.endswith('.tif')]
    dem_name = next(n for n in names if '_DEM_' in n)
    slope_name = next(n for n in names if '_SLOPE_' in n)
    grid, (xa, xb, ya, yb) = read_tiff(zf.read(dem_name))
    s, _ = read_tiff(zf.read(slope_name))
    h, w = grid.shape
    centre_height = float(np.nanmedian(grid[h // 2 - 2:h // 2 + 3, w // 2 - 2:w // 2 + 3]))
    z = grid[np.isfinite(grid)]
    s = s[np.isfinite(s)]
    cx, cy = (xa + xb) / 2, (ya + yb) / 2
    return {
        'centre_km': (cx, cy),
        'extent_km': [round(v, 3) for v in (xa, xb, ya, yb)],
        'size_km': [round(xb - xa, 2), round(yb - ya, 2)],
        'source_file': dem_name.split('/')[-1],
        'height_m': {
            'centre': round(centre_height, 1),
            'min': round(float(z.min()), 1),
            'mean': round(float(z.mean()), 1),
            'max': round(float(z.max()), 1),
        },
        'slope_deg': {
            'mean': round(float(s.mean()), 2),
            'p90': round(float(np.percentile(s, 90)), 2),
            'pct_under_5': round(float((s < 5).mean() * 100), 1),
            'pct_under_10': round(float((s < 10).mean() * 100), 1),
        },
    }


def detect_boxes(path):
    rgb = np.asarray(Image.open(path).convert('RGB')).astype(int)
    yellow = (rgb[..., 0] > 180) & (rgb[..., 1] > 180) & (rgb[..., 2] < 90)
    lab, _ = ndi.label(yellow, structure=np.ones((3, 3)))
    boxes = []
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if h < 40 or w < 40:
            continue
        sub = lab[sl] == i
        # Box edges are the long straight runs. This also separates the large Mons Mouton
        # Plateau box from the two smaller boxes that touch it.
        rows = [sl[0].start + k for k, r in enumerate(sub) if r.sum() > 0.6 * w]
        cols = [sl[1].start + k for k, c in enumerate(sub.T) if c.sum() > 0.6 * h]
        boxes.append((min(cols), max(cols), min(rows), max(rows)))
    return boxes


def register(pairs):
    """Least-squares similarity transform, map pixels -> stereographic km.
    pairs: list of ((px, py), (x_km, y_km)). Image y points down, so we fit on x - iy."""
    p = np.array([complex(*a) for a, _ in pairs])
    w = np.array([complex(x, -y) for _, (x, y) in pairs])
    a = np.sum((p - p.mean()) * np.conj(w - w.mean())) / np.sum(abs(w - w.mean()) ** 2)
    c = p.mean() - a * w.mean()
    residuals = abs(a * w + c - p) / abs(a)

    def to_km(px, py):
        q = (complex(px, py) - c) / a
        return q.real, -q.imag

    return to_km, 1 / abs(a), math.degrees(np.angle(a)), residuals


def main():
    zf = zipfile.ZipFile(DEM_ZIP)
    tiles = {folder: tile_stats(zf, folder) for folder in TILES}

    # Register NASA's 2024 map using the boxes that have a tile.
    boxes = detect_boxes(NASA_MAP)
    centre = {b: ((b[0] + b[1]) / 2, (b[2] + b[3]) / 2) for b in boxes}
    box_of = {}
    for rid, (lx, ly) in MAP_LABELS.items():
        box_of[rid] = min(boxes, key=lambda b: math.hypot(centre[b][0] - lx, centre[b][1] - ly))
    tile_of = {rid: folder for folder, (rid, _) in TILES.items()}
    pairs = [(centre[box_of[rid]], tiles[tile_of[rid]]['centre_km'])
             for rid in MAP_LABELS if rid in tile_of]
    to_km, km_per_px, rot, res = register(pairs)
    print(f'map registration: {km_per_px:.4f} km/px, rotation {rot:+.2f} deg, '
          f'residuals {", ".join(f"{r:.2f}" for r in res)} km ({len(pairs)} tiles)')

    out = []
    for rid, (name, aka, lists) in REGIONS.items():
        entry = {'id': rid, 'name': name, 'formerly': aka, 'nasa_lists': lists}
        folder = tile_of.get(rid)
        if folder:
            t = tiles[folder]
            lat, lon = stereo_to_latlon(*t['centre_km'])
            entry.update({
                'lat': round(lat, 4), 'lon': round(lon, 4),
                'position_source': f'5 m LOLA tile extent ({t["source_file"]})',
                'position_check': TILES[folder][1],
                'team_folder': folder,
                **{k: t[k] for k in ('extent_km', 'size_km', 'height_m', 'slope_deg')},
            })
            if rid in box_of:
                mx, my = to_km(*centre[box_of[rid]])
                tx, ty = t['centre_km']
                entry['map_offset_km'] = round(math.hypot(mx - tx, my - ty), 2)
        elif rid in box_of:
            b = box_of[rid]
            x, y = to_km(*centre[b])
            lat, lon = stereo_to_latlon(x, y)
            entry.update({
                'lat': round(lat, 4), 'lon': round(lon, 4),
                'position_source': 'NASA 2024 region map, registered to our 5 m tiles',
                'size_km': [round((b[1] - b[0]) * km_per_px, 1), round((b[3] - b[2]) * km_per_px, 1)],
                'height_m': {'centre': ldem80_height(x, y), 'source': 'LDEM_80S_80M'} if LDEM80.exists() else None,
                'slope_deg': None,
            })
        else:
            entry.update({'lat': None, 'lon': None,
                          'position_source': 'not modelled: no 5 m tile, and not on the 2024 map'})
        if rid in DATA_BOOK:
            nasa = DATA_BOOK[rid]
            entry['nasa_data_book'] = {'lat': nasa[0], 'lon': nasa[1]}
            if entry['lat'] is not None:
                entry['nasa_data_book']['diff_m'] = round(metres_between((entry['lat'], entry['lon']), nasa))
        out.append(entry)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        'about': 'NASA Artemis candidate landing regions (2022 list of 13, 2024 list of 9). '
                 'See position_source for each entry; nasa_data_book is NASA\'s published centre '
                 '(2022 regions only) and how far ours is from it.',
        'heights': 'metres above the 1737.4 km reference sphere (LOLA)',
        'map_registration': {'km_per_px': round(km_per_px, 4), 'rotation_deg': round(rot, 3),
                             'residuals_km': [round(float(r), 3) for r in res]},
        'sources': {
            'dem': 'LOLA 5 m/px south pole site DEMs, Barker et al., NASA GSFC Planetary '
                   'Geodesy Data Archive, https://pgda.gsfc.nasa.gov/',
            'map_2024': 'https://www.nasa.gov/wp-content/uploads/2024/10/artemis-iii-landing-region-candidates.jpg',
            'list_2024': 'https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/',
            'list_2022': 'https://www.nasa.gov/news-release/nasa-identifies-candidate-regions-for-landing-next-americans-on-moon/',
            'data_book': DATA_BOOK_SOURCE + ', https://ntrs.nasa.gov/citations/20230007818',
        },
        'regions': out,
    }
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    for e in out:
        where = f'{e["lat"]:8.3f}, {e["lon"]:8.2f}' if e['lat'] is not None else '   unknown        '
        h = e.get('height_m') or {}
        nb = e.get('nasa_data_book', {}).get('diff_m')
        print(f'{e["name"]:28s} {where}  {"/".join(e["nasa_lists"]) or "-":9s} '
              f'centre {h.get("centre", "-")!s:>7} m  {e["position_source"][:40]}'
              + (f'  Data Book {nb} m' if nb is not None else ''))


if __name__ == '__main__':
    main()
