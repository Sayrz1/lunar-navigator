"""Cross-check the team's 5 m LOLA tiles against an independent NASA product.

For each tile:
  1. Heights: average the 5 m grid to 80 m and compare with LOLA LDEM_80S_80M (PDS
     Geosciences Node). Also search for the shift between the two that fits best: a
     tile placed in the wrong spot would show up as a large shift or a large RMS.
  2. Slopes: recompute slope from the 5 m heights and compare with the SLOPE tile.

Inputs (not in git):
  DATA/01_Real_Elevation_DEMs_and_Slopes.zip
  data-raw/ldem_80s_80m.img   https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_80s_80m.img

Writes public/data/tile_check.json.
usage: python scripts/check_tiles.py
"""
import json
import zipfile
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

from prepare_regions import DEM_ZIP, TILES, read_tiff

ROOT = Path(__file__).resolve().parents[1]
LDEM = ROOT / 'data-raw' / 'ldem_80s_80m.img'
OUT = ROOT / 'public' / 'data' / 'tile_check.json'

# From ldem_80s_80m.lbl: 7600 x 7600, LSB int16, height = DN * 0.5 m above 1737.4 km,
# polar stereographic, 80 m/px, projection offset 3799.5 px (line and sample).
N, SCALE_M, OFF = 7600, 80.0, 3799.5


def load_ldem():
    dn = np.fromfile(LDEM, dtype='<i2').reshape(N, N)
    return dn.astype(np.float32) * 0.5


def sample_ldem(ldem, x_km, y_km):
    """Bilinear heights at stereographic x, y (km). +y is toward 0 deg E (top of the grid)."""
    col = x_km * 1000 / SCALE_M + OFF
    row = OFF - y_km * 1000 / SCALE_M
    return ndi.map_coordinates(ldem, [row, col], order=1)


def check(zf, folder, ldem):
    names = [n for n in zf.namelist() if n.split('/')[-2:-1] == [folder] and n.endswith('.tif')]
    z5, (xa, xb, ya, yb) = read_tiff(zf.read(next(n for n in names if '_DEM_' in n)))
    s_given, _ = read_tiff(zf.read(next(n for n in names if '_SLOPE_' in n)))

    # 1. heights, 5 m averaged to 80 m cells
    k = 16
    h, w = (z5.shape[0] // k) * k, (z5.shape[1] // k) * k
    blocks = z5[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))
    cy = yb - (np.arange(h // k) + 0.5) * 0.08
    cx = xa + (np.arange(w // k) + 0.5) * 0.08
    X, Y = np.meshgrid(cx, cy)
    ok = np.isfinite(blocks)

    best = None
    for dx in np.arange(-0.4, 0.401, 0.04):          # km
        for dy in np.arange(-0.4, 0.401, 0.04):
            d = blocks[ok] - sample_ldem(ldem, X[ok] + dx, Y[ok] + dy)
            rms = float(np.sqrt(np.mean((d - d.mean()) ** 2)))
            if best is None or rms < best[0]:
                best = (rms, dx, dy, float(d.mean()))
    d0 = blocks[ok] - sample_ldem(ldem, X[ok], Y[ok])

    # 2. slope from the 5 m heights
    gy, gx = np.gradient(z5, 5.0)
    s_ours = np.degrees(np.arctan(np.hypot(gx, gy)))
    both = np.isfinite(s_ours) & np.isfinite(s_given)
    sd = s_ours[both] - s_given[both]

    return {
        'folder': folder,
        'region': TILES[folder][0],
        'height_vs_ldem80': {
            'mean_diff_m': round(float(d0.mean()), 2),
            'rms_diff_m': round(float(np.sqrt(np.mean(d0 ** 2))), 2),
            'best_shift_m': [round(best[1] * 1000), round(best[2] * 1000)],
            'rms_at_best_shift_m': round(best[0], 2),
            'height_range_m': round(float(np.nanmax(z5) - np.nanmin(z5)), 1),
        },
        'slope_vs_team_slope_tile': {
            'mean_abs_diff_deg': round(float(np.abs(sd).mean()), 3),
            'p99_abs_diff_deg': round(float(np.percentile(np.abs(sd), 99)), 3),
        },
    }


def main():
    ldem = load_ldem()
    zf = zipfile.ZipFile(DEM_ZIP)
    results = []
    print(f'{"tile":32s} {"mean dz":>8s} {"rms dz":>7s} {"best shift (m)":>15s} {"rms@shift":>9s}  {"slope |d|":>9s} {"p99":>6s}')
    for folder in TILES:
        r = check(zf, folder, ldem)
        hv, sv = r['height_vs_ldem80'], r['slope_vs_team_slope_tile']
        print(f'{folder:32s} {hv["mean_diff_m"]:8.2f} {hv["rms_diff_m"]:7.2f} {str(hv["best_shift_m"]):>15s} '
              f'{hv["rms_at_best_shift_m"]:9.2f}  {sv["mean_abs_diff_deg"]:9.3f} {sv["p99_abs_diff_deg"]:6.2f}')
        results.append(r)
    OUT.write_text(json.dumps({
        'about': 'Team 5 m LOLA tiles vs LOLA LDEM_80S_80M (independent), and recomputed slopes vs the team slope tiles',
        'ldem_source': 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_80s_80m.img',
        'tiles': results,
    }, indent=1) + '\n')


if __name__ == '__main__':
    main()
