"""Unpack the team's 5 m LOLA tiles into raw grids the Node build scripts can read.

Writes data-raw/tiles/<region>.f32 (float32 little-endian, row 0 = top, metres above
1737.4 km) and data-raw/tiles/index.json with each grid's size and extent in polar
stereographic km. Nothing here goes into git.

usage: python scripts/export_tiles.py
"""
import json
import zipfile

import numpy as np

from prepare_regions import DEM_ZIP, ROOT, TILES, read_tiff

OUT = ROOT / 'data-raw' / 'tiles'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    zf = zipfile.ZipFile(DEM_ZIP)
    index = {}
    for folder, (region, _) in TILES.items():
        name = next(n for n in zf.namelist()
                    if n.split('/')[-2:-1] == [folder] and '_DEM_' in n and n.endswith('.tif'))
        z, (xa, xb, ya, yb) = read_tiff(zf.read(name))
        z.astype('<f4').tofile(OUT / f'{region}.f32')
        index[region] = {'cols': z.shape[1], 'rows': z.shape[0], 'cellKm': (xb - xa) / z.shape[1],
                         'x0': xa, 'x1': xb, 'y0': ya, 'y1': yb, 'from': name.split('/')[-1]}
        print(f'{region:28s} {z.shape[1]} x {z.shape[0]}')
    (OUT / 'index.json').write_text(json.dumps(index, indent=1) + '\n')


if __name__ == '__main__':
    main()
