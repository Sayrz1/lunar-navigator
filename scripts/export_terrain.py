"""Light terrain grids for the browser: the 3D stage, the ice layer and custom points.

For every region, a 160 x 160 grid over its box (the 5 m tile, or NASA's map box) with
  height  int16, metres (LOLA, smoothed to the cell size)
  sun     uint8, NASA long-term Sun visibility, 0-250 = 0-100 %
  earth   uint8, NASA long-term Earth visibility, 0-250 = 0-100 %
  psr     uint8, share of the cell never sunlit in 18.6 years (permanent shadow), 0-250
stored one after the other in public/data/terrain/<region>.bin, layout in index.json.

Plus polar.bin: LDEM_75S_240M averaged to 960 m, int16 metres, for far horizons of
custom points.

usage: python scripts/export_terrain.py
"""
import json
from pathlib import Path

import numpy as np
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data-raw'
OUT = ROOT / 'public' / 'data' / 'terrain'
CELLS = 160
R_MOON = 1737.4


def raster(name, n, cell, dtype='<i2'):
    a = np.memmap(RAW / name, dtype=dtype, mode='r', shape=(n, n))
    off = (n - 1) / 2
    return {'a': a, 'cell': cell, 'xc0': -off * cell, 'yc0': off * cell}


LDEM80 = raster('ldem_80s_80m.img', 7600, 0.08)
SUN = raster('AVGVISIB_75S_120M_201608.IMG', 7624, 0.12)
EARTH = raster('AVGVISIB_75S_120M_201608_EARTH.IMG', 7624, 0.12)


def sample(r, xs, ys, out_cell, mode='mean', scale=1.0):
    """Value of raster r at stereographic points (xs, ys), averaged over out_cell."""
    a, cell = r['a'], r['cell']
    cols = (xs - r['xc0']) / cell
    rows = (r['yc0'] - ys) / cell
    pad = int(out_cell / cell) + 3
    c0, c1 = int(cols.min()) - pad, int(cols.max()) + pad
    r0, r1 = int(rows.min()) - pad, int(rows.max()) + pad
    win = np.asarray(a[max(r0, 0):r1, max(c0, 0):c1], dtype=np.float64) * scale
    if mode == 'zero':
        win = (win == 0).astype(np.float64)
    size = max(1, round(out_cell / cell))
    if size > 1:
        win = ndimage.uniform_filter(win, size=size, mode='nearest')
    return ndimage.map_coordinates(win, [rows - max(r0, 0), cols - max(c0, 0)], order=1, mode='nearest')


def to_stereo(lat, lon):
    rho = 2 * R_MOON * np.tan(np.pi / 4 + np.radians(lat) / 2)
    return rho * np.sin(np.radians(lon)), rho * np.cos(np.radians(lon))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    regions = json.loads((ROOT / 'public/data/regions.json').read_text('utf8'))['regions']
    tiles = json.loads((RAW / 'tiles' / 'index.json').read_text('utf8'))
    index = {'cells': CELLS, 'order': ['height int16 m', 'sun uint8 /250', 'earth uint8 /250', 'psr uint8 /250'],
             'regions': {}}

    for r in regions:
        if r['lat'] is None:
            continue
        t = tiles.get(r['id'])
        if t:
            x0, x1, y0, y1 = t['x0'], t['x1'], t['y0'], t['y1']
        else:
            cx, cy = to_stereo(r['lat'], r['lon'])
            w, h = r['size_km']
            x0, x1, y0, y1 = cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2
        # square cells: pad the shorter side (only Mons Mouton Plateau's box is not square)
        side = max(x1 - x0, y1 - y0)
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        x0, x1, y0, y1 = mx - side / 2, mx + side / 2, my - side / 2, my + side / 2
        cell = side / CELLS
        xs1 = x0 + (np.arange(CELLS) + 0.5) * (x1 - x0) / CELLS
        ys1 = y1 - (np.arange(CELLS) + 0.5) * (y1 - y0) / CELLS
        xs, ys = np.meshgrid(xs1, ys1)

        if t:
            z = np.fromfile(RAW / 'tiles' / f'{r["id"]}.f32', dtype='<f4').reshape(t['rows'], t['cols'])
            tile = {'a': z, 'cell': t['cellKm'], 'xc0': t['x0'] + t['cellKm'] / 2, 'yc0': t['y1'] - t['cellKm'] / 2}
            height = sample(tile, xs, ys, cell)
        else:
            height = sample(LDEM80, xs, ys, cell, scale=0.5)

        sun = sample(SUN, xs, ys, cell, scale=0.00004)
        earth = sample(EARTH, xs, ys, cell, scale=0.00004)
        psr = sample(SUN, xs, ys, cell, mode='zero')

        parts = [np.round(height).astype('<i2').tobytes()]
        for v in (sun, earth, psr):
            parts.append(np.clip(np.round(v * 250), 0, 250).astype(np.uint8).tobytes())
        (OUT / f'{r["id"]}.bin').write_bytes(b''.join(parts))
        index['regions'][r['id']] = {
            'x0': round(x0, 3), 'x1': round(x1, 3), 'y0': round(y0, 3), 'y1': round(y1, 3),
            'cellKm': round(cell, 4), 'heightFrom': 'LOLA 5 m tile' if t else 'LDEM_80S_80M',
            'minM': int(height.min()), 'maxM': int(height.max()),
        }
        print(f'{r["id"]:28s} {cell * 1000:5.0f} m cells  height {height.min():6.0f} .. {height.max():5.0f} m  '
              f'permanent shadow {psr.mean() * 100:4.1f} %')

    # far terrain for custom points: LDEM_75S_240M, 4 x 4 block mean -> 960 m
    big = np.memmap(RAW / 'ldem_75s_240m.img', dtype='<i2', mode='r', shape=(3812, 3812))
    n = 3812 // 4
    z = np.asarray(big[:n * 4, :n * 4], dtype=np.float64).reshape(n, 4, n, 4).mean(axis=(1, 3)) * 0.5
    (OUT / 'polar.bin').write_bytes(np.round(z).astype('<i2').tobytes())
    first = (-1905.5 + 1.5) * 0.24  # centre of the first 4 x 4 block
    index['polar'] = {'cols': n, 'rows': n, 'cellKm': 0.96, 'xc0': round(first, 3), 'yc0': round(-first, 3),
                      'from': 'LDEM_75S_240M, 4 x 4 block mean'}
    (OUT / 'index.json').write_text(json.dumps(index, indent=1) + '\n')
    print(f'polar grid {n} x {n}, 960 m')


if __name__ == '__main__':
    main()
