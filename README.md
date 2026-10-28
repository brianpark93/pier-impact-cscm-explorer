# RC Pier Impact — CSCM Explorer

Interactive companion to the CSCM calibration report for RC pier impact under
lateral impactor loading (LS-DYNA, `*MAT_CSCM`, Chen et al. 2022 tests).

**https://brianpark93.github.io/pier-impact-cscm-explorer/**

The report keeps its figures readable by leaving the dense ones out. They live
here instead, where they can be stepped through rather than squinted at.

## What is in it

| View | What it shows |
|---|---|
| **Parameter sensitivity** | One parameter moved at a time about the CSCM default (×0.25 … ×4), on Test 1. 21 solves. A screening study, so it runs on a coarse mesh (*h* = 40 mm) rather than the adopted one — read it for which parameters matter and in which direction, not for absolute scores. Four cells are empty because CSCM requires α > λ and the solver rejects the rest at initialisation. |
| **Mesh convergence** | Nine refinement levels at the default, *h* = 174 → 13 mm, each on its own mesh. This is where *h* = 20 mm is adopted. Two levels are flagged `unsound`: their energy balance falls below 0.40, so they are numerical failures rather than data points. |
| **Calibrated model** | The adopted parameter set against the auto-generated default, both on the adopted mesh, both tests. |

Every view gives the contact force, the P1 and P4 lateral
displacements, and a 3D per-face damage view of the pier. P1 sits near the
pier top (4800 mm) and P4 at the impact height (1500 mm) on a 4840 mm pier,
so the two move in opposite directions early in the response: the strike is
low, and the pier above it swings back before the whole column follows.

**Parameter sensitivity** additionally shows the material response: the CSCM
failure envelope in the J1-sqrt(J2) plane, and the uniaxial stress-strain and
damage curves of a single element under prescribed straining, in tension and
in compression.

The envelope is computed in the browser from the documented CSCM formula
(ported from the project's `cscm_yield_surface.py` and checked against it to
0.0 MPa). The stress-strain and damage curves are *not* a re-derivation of
the CSCM equations: they come from 42 single-element LS-DYNA solves on a
40 mm element -- the representative element length of the coarse screening
mesh that study runs on, since CSCM regularises softening on element size. Asking the solver to evaluate its own
material model avoids transcribing a damage formulation that is not published
in this repository.

Each tab is linkable: append `#ofat`, `#mesh` or `#calib`.

## Headline numbers

| Parameter set | *J* | C<sub>Test1</sub> | C<sub>Test2</sub> | repeats |
|---|---|---|---|---|
| Calibrated | 96.6 ± 2.4 | 60.1 ± 1.1 | 36.5 ± 2.1 | 5 |
| CSCM auto default | 319.3 ± 18.4 | 218.1 ± 11.8 | 101.1 ± 14.2 | 5 |

| Parameter | default | calibrated | change |
|---|---|---|---|
| θ | 0.2851 | 0.1909 | −33% |
| α | 13.96 | 14.815 | +6% |
| *E* (GPa) | 25.23 | 18.36 | −27% |
| GFC (MPa) | 4.515 | 8.525 | +89% |
| GFT (MPa) | 0.04515 | 0.12694 | +181% |

Scores are repeat means with standard deviations, not single solves. LS-DYNA's
SMP reduction order is not deterministic here — byte-identical decks run to the
same cycle count return different results — so a single solve understates a
parameter set's score, and by a different amount each time. The curves served
for each case are the repeat *nearest the mean* of five, not the best of them.

Calibration buys repeatability as well as accuracy: the default set's Test 2
score scatters over 82.3 … 114.6 across five identical decks, the calibrated
set's over 34.3 … 39.7.

The coarser *h* = 40 mm mesh reaches a better *J* (75.7 ± 3.3) when calibrated
on itself, and is rejected anyway: it gets there by driving the uniaxial
compressive strength to 76.7 MPa against the 26.3 MPa concrete the specimens
were cast from. That is a property of the parameter card, not of the element
size — probed at a common 40 mm element it stays at 292% of the real strength.

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
