import json, sys, random
sys.path.insert(0, '.')
import numpy as np
from pipeline.index.headers import wcs_from_facts, cutout

facts = json.load(open('data/scratch/barnard_facts.json'))
random.seed(1)
picked = []
for det in range(1, 7):
    c = [f for f in facts if f['detector'] == det and f['key'].startswith('dr1')]
    picked.append(random.choice(c))
for det in (2, 5):
    c = [f for f in facts if f['detector'] == det and f['key'].startswith('qr3')]
    picked.append(random.choice(c))
grid = [10, 300, 700, 1020, 1400, 1800, 2030]
out = []
for f in picked:
    w = wcs_from_facts(f)
    pts = [(10, 10), (2030, 10), (10, 2030), (2030, 2030)]
    while len(pts) < 20:
        pts.append((random.choice(grid) + random.random() * 5, random.choice(grid) + random.random() * 5))
    px = np.array([p[0] for p in pts], float)
    py = np.array([p[1] for p in pts], float)
    ra, dec = w.all_pix2world(px, py, 0)
    bx, by = w.all_world2pix(ra, dec, 0)
    out.append({'key': f['key'], 'detector': f['detector'], 'pts': [
        {'x': float(a), 'y': float(b), 'ra': float(r), 'dec': float(d), 'bx': float(c), 'by': float(e)}
        for a, b, r, d, c, e in zip(px, py, ra, dec, bx, by)]})
cases = []
for f in picked[:3]:
    w = wcs_from_facts(f)
    for (x, y) in [(1000.3, 1200.6), (5.2, 2035.7)]:
        ra, dec = (float(v[0]) for v in w.all_pix2world([x], [y], 0))
        r = cutout(f['key'], f, ra, dec)
        cases.append({'key': f['key'], 'ra': ra, 'dec': dec, 'x0': r[1][0], 'y0': r[1][1],
                      'shape': list(r[0].shape),
                      'data': [None if np.isnan(v) else float(v) for v in r[0].ravel()]})
tk = [f['key'] for f in facts[:32]]
tpts = []
for f in facts[:32]:
    w = wcs_from_facts(f)
    ra, dec = w.all_pix2world([1020.3], [1020.3], 0)
    tpts.append([float(ra[0]), float(dec[0])])
json.dump({'wcs': out, 'cutouts': cases, 'timing': {'keys': tk, 'pts': tpts}},
          open('data/scratch/js/fixture.json', 'w'))
print('ok', len(out), len(cases), [f['detector'] for f in picked])
