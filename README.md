# RC Pier Impact — CSCM Explorer

Interactive companion to the CSCM calibration report for RC pier impact under
lateral impactor loading (LS-DYNA, `*MAT_CSCM`, Chen et al. 2022 tests).

**https://brianpark93.github.io/pier-impact-cscm-explorer/**

The report keeps its figures readable by leaving the dense ones out. They live
here instead, where they can be stepped through rather than squinted at.

## What is in it

| View | What it shows |
|---|---|
| **Parameter sensitivity** | One parameter moved at a time about the CSCM default (×0.25 … ×4), on Test 1 at mesh1x. 21 solves. Four cells are empty because CSCM requires α > λ and the solver rejects the rest at initialisation. |
| **Mesh convergence** | Nine refinement levels at the default, *h* = 174 → 13 mm, each on its own mesh. Two levels are flagged `unsound`: their energy balance falls below 0.40, so they are numerical failures rather than data points. |
| **Calibrated model** | The adopted sets — mesh1x, mesh2x, and the default for contrast — against the measurements, both tests. |

Every view gives the contact force, the P1 (top) and P4 (base) lateral
displacements, and a 3D per-face damage view of the pier.

**Parameter sensitivity** additionally shows the material response: the CSCM
failure envelope in the J1-sqrt(J2) plane, and the uniaxial stress-strain and
damage curves of a single element under prescribed straining, in tension and
in compression.

The envelope is computed in the browser from the documented CSCM formula
(ported from the project's `cscm_yield_surface.py` and checked against it to
0.0 MPa). The stress-strain and damage curves are *not* a re-derivation of
the CSCM equations: they come from 42 single-element LS-DYNA solves on a
40 mm element -- the representative element length of mesh1x, since CSCM
regularises softening on element size. Asking the solver to evaluate its own
material model avoids transcribing a damage formulation that is not published
in this repository.

Each tab is linkable: append `#ofat`, `#mesh` or `#calib`.

## Headline numbers

| Parameter set | *J* | C<sub>Test1</sub> | C<sub>Test2</sub> | repeats |
|---|---|---|---|---|
| mesh1x adopted | 118.1 ± 1.4 | 49.4 ± 1.3 | 68.7 ± 0.9 | 9 |
| mesh2x adopted | 127.7 ± 5.0 | 41.2 ± 2.4 | 86.4 ± 4.6 | 11 |
| CSCM default (mesh1x) | 262.3 ± 21.7 | 139.8 ± 3.9 | 122.5 ± 23.4 | 5 |

Scores are repeat means with standard deviations, not single solves. LS-DYNA's
SMP reduction order is not deterministic here — byte-identical decks run to the
same cycle count return different results — so a single solve understates a
parameter set's score, and by a different amount each time.

## Data

Static site, no backend. Everything under `data/` is pre-computed from real
LS-DYNA solves by `export_site_data_v2.py` in the solver repository:

- `meta.json` — cases, their parameters and metrics
- `curves.json` — downsampled force and displacement histories
- `mesh_*.bin` — surface geometry, `uint32` header then `float32` vertices and
  `uint32` quad indices, surface-only and re-indexed
- `damage_*.bin` — one `uint8` per surface face per case, concatenated
- `exp_ref.json` — the digitised measurements
- `element/` — single-element stress-strain and damage curves, per parameter
  and load direction

About 5 MB in total.

> **Note on provenance.** The bundle served before October 2026 was a 5<sup>5</sup>
> factorial grid from a model that predates the rebar-to-concrete mesh
> synchronisation. The parameter set it was built around moves from *J* = 113.6
> to 155.6 once the rebar follows the concrete, so that data describes a
> different model and has been replaced rather than extended.

## Local preview

A static site cannot `fetch()` local files without a server:

```
python -m http.server 8000
```

then open `http://localhost:8000/`.
