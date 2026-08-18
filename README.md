# Test1 CSCM Factorial Explorer

Interactive explorer for a 5<sup>5</sup> = 3125-case full factorial grid
(theta &times; alpha &times; E &times; GFC &times; GFT) calibrating an
LS-DYNA MAT_CSCM concrete model against Chen et al. (2022) Test1
(RC pier vehicle impact).

Pick a level for each of the 5 parameters and instantly see:
- the impactor-pier contact force curve
- P1 (top) and P4 (base) lateral displacement curves
- a 3D damage isometric view of the pier (grayscale, per-face damage 0-1)

each vs. the digitized experimental reference.

Static site, no backend -- data pre-computed from real LS-DYNA solves and
shipped as JSON/binary under `data/`.

## Local preview

Static sites can't `fetch()` local files without a server:

```
python -m http.server 8000
```

then open `http://localhost:8000/`.
