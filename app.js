/* Test1 5^5 factorial explorer -- static site, no backend.
 * Data layout (data/):
 *   params.json   -- {levels: {theta:[...], alpha:[...], ...}, param_names: [...],
 *                      cases: [{theta, alpha, E_MPA, GFC, GFT, label, dmg_ok,
 *                               curve_ok, force_rmse_pct?, P1_rmse_pct?, ...}, ...],
 *                      n_faces: int}
 *   mesh.json     -- {verts: [[x,y,z],...], faces: [[v0,v1,v2,v3],...]}  (shared, identical every case)
 *   damage_all.bin-- Uint8, n_cases * n_faces bytes, one n_faces block per case in manifest order
 *   curves.json   -- {case_label: {t_force, force, t_p1, p1, t_p4, p4}}
 *   exp_ref.json  -- {force: {t,y}, P1: {t,y}, P4: {t,y}}  (digitized experimental reference)
 */

const PARAM_UNITS = {
  theta: { label: "theta", fmt: v => v.toFixed(3) },
  alpha: { label: "alpha", fmt: v => v.toFixed(1) },
  E_MPA: { label: "E (GPa)", fmt: v => (v / 1000).toFixed(2) },
  GFC: { label: "GFC (MPa)", fmt: v => v.toFixed(2) },
  GFT: { label: "GFT (MPa)", fmt: v => v.toFixed(4) },
};

let state = {
  params: null,
  mesh: null,
  damageBytes: null,
  curves: null,
  expRef: null,
  selected: {}, // param -> level index
};

async function loadJSON(path) {
  const r = await fetch(path);
  return r.json();
}

async function loadBinary(path) {
  const r = await fetch(path);
  const buf = await r.arrayBuffer();
  return new Uint8Array(buf);
}

function caseIndexFromSelection() {
  const names = state.params.param_names;
  let idx = 0;
  for (const name of names) {
    const nLevels = state.params.levels[name].length;
    idx = idx * nLevels + state.selected[name];
  }
  return idx;
}

function caseLabel(idx) {
  return "case_" + String(idx).padStart(4, "0");
}

function paramSummary(row) {
  if (!row) return "";
  return `θ${row.theta.toFixed(3)} α${row.alpha.toFixed(1)} E${(row.E_MPA / 1000).toFixed(1)} GFC${row.GFC.toFixed(1)} GFT${row.GFT.toFixed(3)}`;
}

// Onset-sync alignment (additive shift only, never a scale factor -- see
// project convention in sweep_plotting.find_onset/shift): each curve is
// independently shifted so the instant it first crosses `frac` of its own
// peak lands at t=0. Applied to P1/P4 only (not force), per user request.
function findOnset(t, v, frac = 0.03) {
  const peak = Math.max(...v);
  if (!(peak > 0)) return t[0] || 0;
  const thresh = frac * peak;
  for (let i = 0; i < t.length; i++) {
    if (v[i] >= thresh) return t[i];
  }
  return t[0] || 0;
}

// Baseline (zero-point) correction, additive-only, matches
// report_best_vs_exp_cases.py's scheme (2026-08-31):
//   sim: subtract v[0] -- the curve starts at t=0 already sitting at its
//        real post-gravity static-sag rest position, so the first sample
//        IS the correct physical zero.
//   exp: subtract (max+min)/2 -- the digitized experimental curve has NO
//        usable pre-impact sample at all (first digitized point is
//        already mid-rise), so x[0] isn't available; for a symmetric
//        damped oscillation about its rest position, the peak/trough
//        midpoint recovers that rest position without needing a flat
//        pre-event region.
function onsetShiftedPoints(t, v, baselineMode) {
  if (!t || !t.length) return [];
  const onset = findOnset(t, v);
  let baseline = 0;
  if (baselineMode === "sim") {
    baseline = v[0];
  } else if (baselineMode === "exp") {
    baseline = (Math.max(...v) + Math.min(...v)) / 2;
  }
  return t.map((tt, i) => ({ x: tt - onset, y: v[i] - baseline }));
}

// Linear interpolation with out-of-range -> null (matches np.interp's
// left=np.nan, right=np.nan used by sweep_plotting.xcorr_align). Assumes
// xs is sorted ascending.
function interpNullOutside(x, xs, ys) {
  if (x < xs[0] || x > xs[xs.length - 1]) return null;
  let i = 0;
  while (i < xs.length - 1 && xs[i + 1] < x) i++;
  const x0 = xs[i], x1 = xs[i + 1], y0 = ys[i], y1 = ys[i + 1];
  if (x1 === x0) return y0;
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
}

function pearsonCorr(a, b) {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

// Port of sweep_plotting.xcorr_align (2026-07-23 project convention): the
// extra TIME-only lag (beyond onset-sync) that best matches target's SHAPE
// against ref, by grid-searching lag and maximizing Pearson correlation
// (scale-invariant, so amplitude mismatches don't bias the search). Never
// applies a scale factor -- shift only.
function xcorrAlign(tRef, vRef, tTarget, vTarget, maxLag = 0.05, nGrid = 600, nLags = 101) {
  const tMin = Math.max(tRef[0], tTarget[0] - maxLag);
  const tMax = Math.min(tRef[tRef.length - 1], tTarget[tTarget.length - 1] + maxLag);
  if (tMax <= tMin) return { lag: 0, corr: 0 };
  const grid = [];
  for (let i = 0; i < nGrid; i++) grid.push(tMin + (tMax - tMin) * i / (nGrid - 1));
  const refG = grid.map(g => interpNullOutside(g, tRef, vRef));
  let bestLag = 0, bestCorr = -Infinity;
  for (let li = 0; li < nLags; li++) {
    const lag = -maxLag + (2 * maxLag) * li / (nLags - 1);
    const shiftedT = tTarget.map(t => t + lag);
    const pairsA = [], pairsB = [];
    for (let i = 0; i < grid.length; i++) {
      const tg = interpNullOutside(grid[i], shiftedT, vTarget);
      if (refG[i] !== null && tg !== null) { pairsA.push(refG[i]); pairsB.push(tg); }
    }
    if (pairsA.length < grid.length / 4) continue;
    const corr = pearsonCorr(pairsA, pairsB);
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  return { lag: bestLag, corr: bestCorr };
}

// Full sim-curve alignment against an exp reference: onset-sync + baseline-
// zero (both sim/exp per their own scheme above) + the extra xcorr lag
// refinement on top, mirroring report_best_vs_exp_cases.py exactly. Used
// for every sim P1/P4 dataset (current selection + each pinned case).
function alignSimToExp(tSim, vSim, tExp, vExp, maxLag = 0.05) {
  if (!tSim || !tSim.length) return [];
  const onsetSim = findOnset(tSim, vSim);
  const tSimShifted = tSim.map(t => t - onsetSim);
  const vSimZeroed = vSim.map(v => v - vSim[0]);
  if (!tExp || !tExp.length) {
    return tSimShifted.map((t, i) => ({ x: t, y: vSimZeroed[i] }));
  }
  const onsetExp = findOnset(tExp, vExp);
  const tExpShifted = tExp.map(t => t - onsetExp);
  const baselineExp = (Math.max(...vExp) + Math.min(...vExp)) / 2;
  const vExpZeroed = vExp.map(v => v - baselineExp);
  const { lag } = xcorrAlign(tExpShifted, vExpZeroed, tSimShifted, vSimZeroed, maxLag);
  return tSimShifted.map((t, i) => ({ x: t + lag, y: vSimZeroed[i] }));
}

// Force gets TIME-only sync (onset + xcorr lag, matching
// metrics_v2.force_metrics_v2's FORCE_XCORR_MAX_LAG_S=0.010s) -- no
// baseline shift, since force's own offset is already negligible (user
// 2026-08-31: "force의 경우 상관없는데... disp가 중요해").
function alignForceSim(tSim, vSim) {
  // Plain onset-sync only (rise-past-3%-of-peak crossing) -- NO xcorr
  // shape-correlation refinement here. User 2026-09-02: xcorr's best-fit
  // lag tends to slide toward whatever maximizes overall shape/peak
  // overlap, which can pull the alignment away from the actual rise
  // point on this short, sharp pulse. Catching the rise itself is what
  // matters for force, so onset-sync alone (matching P1/P4's own onset
  // step, just without the extra lag search) is the right amount here.
  if (!tSim || !tSim.length) return [];
  const onsetSim = findOnset(tSim, vSim);
  return tSim.map((t, i) => ({ x: t - onsetSim, y: vSim[i] }));
}

function buildToggles() {
  const container = document.getElementById("toggle-container");
  container.innerHTML = "";
  const names = state.params.param_names;
  names.forEach(name => {
    const levels = state.params.levels[name];
    const meta = PARAM_UNITS[name] || { label: name, fmt: v => v };
    const wrap = document.createElement("div");
    wrap.className = "toggle";
    const lbl = document.createElement("label");
    lbl.textContent = meta.label;
    wrap.appendChild(lbl);
    const scroll = document.createElement("div");
    scroll.className = "toggle-scroll";
    levels.forEach((val, i) => {
      const btn = document.createElement("button");
      btn.textContent = meta.fmt(val);
      btn.dataset.param = name;
      btn.dataset.idx = i;
      if (i === state.selected[name]) btn.classList.add("active");
      btn.addEventListener("click", () => {
        state.selected[name] = i;
        [...scroll.children].forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        onSelectionChanged();
      });
      scroll.appendChild(btn);
    });
    wrap.appendChild(scroll);
    container.appendChild(wrap);
  });
}

// ---------- Three.js damage viewer ----------
let renderer, scene, camera, controls, mesh3d, colorAttr, THREE, OrbitControlsClass, threeReady = false;

async function initThree() {
  const wrap = document.getElementById("damage-canvas-wrap");
  const canvas = document.getElementById("damage-canvas");
  try {
    THREE = await import("three");
    ({ OrbitControls: OrbitControlsClass } = await import("three/addons/controls/OrbitControls.js"));
  } catch (e) {
    console.error("Three.js failed to load", e);
    wrap.innerHTML = '<p style="color:#ff8a4f;padding:16px;">3D damage viewer failed to load. Force/P1/P4 curves below still work.</p>';
    return;
  }
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, wrap.clientWidth / wrap.clientHeight, 1, 100000);

  // The pier's tall axis is Z in the source data (0..~4840mm), but
  // Three.js/OrbitControls treat Y as "up" by default -- swap Y/Z here so
  // the pier renders upright instead of lying on its side.
  const { verts, faces } = state.mesh;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
  for (const [x, y, z] of verts) {
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (z < ymin) ymin = z; if (z > ymax) ymax = z;
    if (y < zmin) zmin = y; if (y > zmax) zmax = y;
  }
  const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2, cz = (zmin + zmax) / 2;
  const diag = Math.sqrt((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2);

  // triangulate each quad face (0,1,2) + (0,2,3), non-indexed so we can
  // flat-color per triangle-pair (= per original quad face)
  const nFaces = faces.length;
  const positions = new Float32Array(nFaces * 6 * 3);
  let p = 0;
  for (const f of faces) {
    const quad = [verts[f[0]], verts[f[1]], verts[f[2]], verts[f[3]]];
    const tri = [quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]];
    for (const v of tri) {
      positions[p++] = v[0]; positions[p++] = v[2]; positions[p++] = v[1];
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const colors = new Float32Array(nFaces * 6 * 3);
  colorAttr = new THREE.BufferAttribute(colors, 3);
  geo.setAttribute("color", colorAttr);
  geo.computeVertexNormals();

  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mesh3d = new THREE.Mesh(geo, mat);
  scene.add(mesh3d);

  // Impact arrow: impactor strikes the pier's +X face (PIER_R=500mm) at
  // Y=0 (centerline), Z=1500mm (IMPACT_HEIGHT, see generate_impactor.py),
  // travelling in -X (initial_velocity vx=-3170). Kept short (~5% of the
  // model diagonal) so it marks the impact point/direction without
  // burying the pier itself.
  const IMPACT_X = 500, IMPACT_Y = 0, IMPACT_Z = 1500;
  const arrowLen = Math.max(320, diag * 0.09);
  const arrowOrigin = new THREE.Vector3(IMPACT_X + arrowLen, IMPACT_Z, IMPACT_Y); // remapped (x,z,y)
  const arrowDir = new THREE.Vector3(-1, 0, 0);
  const arrow = new THREE.ArrowHelper(arrowDir, arrowOrigin, arrowLen, 0xff2d2d, arrowLen * 0.32, arrowLen * 0.2);
  arrow.line.material.linewidth = 2;
  scene.add(arrow);

  camera.position.set(cx + diag * 0.55, cy + diag * 0.55, cz + diag * 0.4);
  camera.lookAt(cx, cy, cz);
  state.camFrame = { cx, cy, cz, diag };

  controls = new OrbitControlsClass(camera, renderer.domElement);
  controls.target.set(cx, cy, cz);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  window.addEventListener("resize", () => {
    renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    camera.aspect = wrap.clientWidth / wrap.clientHeight;
    camera.updateProjectionMatrix();
  });

  threeReady = true;
  animate();
}

// While comparing (>=1 pinned case), the big interactive canvas is hidden
// entirely and replaced by the (now enlarged) stationary comparison row --
// see renderDamageComparisons. Re-shows the interactive view once the
// comparison list is emptied.
function updateMainViewLockState() {
  if (!threeReady) return;
  const locked = state.pinned.length > 0;
  const wrap = document.getElementById("damage-canvas-wrap");
  wrap.style.display = locked ? "none" : "";
  controls.enabled = !locked;
  if (locked) {
    const { cx, cy, cz, diag } = state.camFrame;
    camera.position.set(cx + diag * 0.55, cy + diag * 0.55, cz + diag * 0.4);
    controls.target.set(cx, cy, cz);
    controls.update();
  }
  const hint = document.querySelector("#damage-canvas-wrap .mouse-hint");
  if (hint) {
    hint.textContent = locked ? "🔒 stationary view while comparing" : "🖱️ drag to rotate · scroll to zoom";
  }
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function faceColorArray(caseIdx, nFaces, out) {
  const offset = caseIdx * nFaces;
  const bytes = state.damageBytes;
  const arr = out || new Float32Array(nFaces * 6 * 3);
  let p = 0;
  for (let fi = 0; fi < nFaces; fi++) {
    const d = bytes[offset + fi] / 255; // 0=intact .. 1=failed
    const g = 1 - d; // gray_r: intact -> white, failed -> black
    for (let k = 0; k < 6; k++) {
      arr[p++] = g; arr[p++] = g; arr[p++] = g;
    }
  }
  return arr;
}

function updateDamageColors(caseIdx) {
  if (!threeReady) return;
  faceColorArray(caseIdx, state.params.n_faces, colorAttr.array);
  colorAttr.needsUpdate = true;
}

// Static (non-interactive) thumbnail render of one case's damage, reusing
// the main scene's shared vertex-position buffer -- only the per-face
// color attribute differs per case. Returns a data: URL.
function renderDamageThumbnail(caseIdx) {
  if (!threeReady || !state.damageBytes) return null;
  const size = 480;
  const off = document.createElement("canvas");
  off.width = size; off.height = size;
  const r = new THREE.WebGLRenderer({ canvas: off, antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setClearColor(0x000000, 0);
  const s = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(45, 1, 1, 100000);
  const nFaces = state.params.n_faces;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", mesh3d.geometry.getAttribute("position"));
  const colArr = faceColorArray(caseIdx, nFaces);
  geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geo, mat);
  s.add(m);
  const { cx, cy, cz, diag } = state.camFrame;
  cam.position.set(cx + diag * 0.55, cy + diag * 0.55, cz + diag * 0.4);
  cam.lookAt(cx, cy, cz);
  r.render(s, cam);
  const dataURL = off.toDataURL("image/png");
  geo.dispose();
  mat.dispose();
  r.dispose();
  return dataURL;
}

function addThumbTo(rowEl, caseIdx, label, color, big) {
  const url = renderDamageThumbnail(caseIdx);
  if (!url) return;
  const wrap = document.createElement("div");
  wrap.className = "damage-thumb" + (big ? " damage-thumb-big" : "");
  const img = document.createElement("img");
  img.src = url;
  img.style.borderColor = color;
  wrap.appendChild(img);
  const lbl = document.createElement("div");
  lbl.className = "thumb-label";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = color;
  lbl.appendChild(dot);
  const txt = document.createElement("span");
  txt.textContent = label;
  lbl.appendChild(txt);
  wrap.appendChild(lbl);
  if (big) {
    const params = document.createElement("div");
    params.className = "thumb-params";
    params.textContent = paramSummary(state.params.cases[caseIdx]);
    wrap.appendChild(params);
  }
  rowEl.appendChild(wrap);
}

// While comparing, the big interactive canvas is hidden entirely and this
// row becomes the main view: current selection (live, updates as toggles
// change) shown first and larger, followed by each pinned case at the
// same enlarged size. With nothing pinned, the row is empty and the big
// interactive canvas is shown instead (see updateMainViewLockState).
function renderDamageComparisons() {
  const row = document.getElementById("damage-compare-row");
  row.innerHTML = "";
  if (!threeReady) return;
  const comparing = state.pinned.length > 0;
  if (!comparing) return;
  const curIdx = caseIndexFromSelection();
  addThumbTo(row, curIdx, `${caseLabel(curIdx)} (current)`, "#4f9dff", true);
  state.pinned.forEach(p => addThumbTo(row, p.idx, p.label, p.color, true));
}

// ---------- CSCM yield surface (computed client-side, no data file needed) ----------
// Ff(J1) = alpha - lamda*exp(-beta*J1) + theta*J1  (shear-failure meridian)
// X(L)   = L + R*Ff(L)                              (cap position on J1 axis)
// Fc(J1) = 1 for J1<L, else 1-((J1-L)/(X-L))^2       (elliptical cap multiplier)
// Fcont(J1) = Ff(J1) * sqrt(max(Fc(J1),0))
// Fixed params match run_paper_cscm_sweep.ANCHOR / cscm_yield_surface_report.py
// (lamda/beta/R/X0 are not swept in this factorial grid).
const CSCM_FIXED = { lamda: 10.51, beta: 0.01929, R: 5.0, kappa0: 88.99 };
const J1_MIN = -10, J1_MAX = 350, J1_N = 120;
const YIELD_Y_MAX = 160; // fixed default view; Fcont stays well under this across the swept theta/alpha range -- scroll/drag to zoom in if needed

function cscmYieldCurve(alpha, theta, fixed = CSCM_FIXED) {
  const { lamda, beta, R, kappa0 } = fixed;
  const Ff = j1 => alpha - lamda * Math.exp(-beta * j1) + theta * j1;
  const L = kappa0;
  const X = L + R * Ff(L);
  const pts = [];
  for (let i = 0; i < J1_N; i++) {
    const j1 = J1_MIN + (J1_MAX - J1_MIN) * i / (J1_N - 1);
    const ff = Ff(j1);
    const fc = j1 < L ? 1 : 1 - ((j1 - L) / (X - L)) ** 2;
    const fcont = fc > 0 ? ff * Math.sqrt(fc) : 0;
    pts.push({ x: j1, y: Math.max(0, fcont) });
  }
  return pts;
}

// ---------- Comparison / pin feature ----------
const PIN_COLORS = ["#ffd166", "#06d6a0", "#ef476f", "#8338ec", "#3a86ff", "#fb5607", "#ffb4a2"];
state.pinned = []; // [{idx, label, color}]

function pinColorFor(n) {
  return PIN_COLORS[n % PIN_COLORS.length];
}

function renderPinnedList() {
  const el = document.getElementById("pinned-list");
  el.innerHTML = "";
  state.pinned.forEach(p => {
    const chip = document.createElement("div");
    chip.className = "pin-chip";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = p.color;
    chip.appendChild(dot);
    const row = state.params.cases[p.idx];
    const txt = document.createElement("span");
    const scoreTxt = row && row.combined_score !== undefined ? ` (combined ${row.combined_score.toFixed(1)})` : "";
    txt.textContent = `${p.label}${scoreTxt} -- ${paramSummary(row)}`;
    chip.appendChild(txt);
    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.addEventListener("click", () => {
      state.pinned = state.pinned.filter(x => x.idx !== p.idx);
      renderPinnedList();
      refreshAllCharts();
    });
    chip.appendChild(rm);
    el.appendChild(chip);
  });
}

function addCurrentToPinned() {
  const idx = caseIndexFromSelection();
  if (state.pinned.some(p => p.idx === idx)) return;
  if (state.pinned.length >= PIN_COLORS.length) {
    state.pinned.shift();
  }
  state.pinned.push({ idx, label: caseLabel(idx), color: pinColorFor(state.pinned.length) });
  // recolor sequentially so chip colors always match chart line colors
  state.pinned.forEach((p, i) => { p.color = pinColorFor(i); });
  renderPinnedList();
  refreshAllCharts();
}

// ---------- Chart.js curves ----------
let chartForce, chartP1, chartP4, chartYield;

// alignMode: "none" (raw, absolute time -- unused now) | "time" (onset-sync
// only, no baseline shift -- force) | "full" (onset-sync + baseline zero --
// P1/P4).
function makeChart(canvasId, yLabel, expT, expY, color, xMin, xMax, alignMode) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  const expData = alignMode === "none" ? expT.map((t, i) => ({ x: t, y: expY[i] }))
    : onsetShiftedPoints(expT, expY, alignMode === "full" ? "exp" : "none");
  return new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        { label: "simulation", data: [], borderColor: color, backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.15 },
        { label: "experiment (digitized)", data: expData, borderColor: "#8a94a3", borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, tension: 0.15 },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      scales: {
        x: { type: "linear", min: xMin, max: xMax, title: { display: true, text: alignMode !== "none" ? "time since onset (s)" : "time (s)", color: "#9aa4b2" }, ticks: { color: "#9aa4b2" }, grid: { color: "#262c35" } },
        y: { title: { display: true, text: yLabel, color: "#9aa4b2" }, ticks: { color: "#9aa4b2" }, grid: { color: "#262c35" } },
      },
      plugins: { legend: { labels: { color: "#e8eaed", filter: (item, data) => !data.datasets[item.datasetIndex].hidden } } },
    },
  });
}

function initCharts() {
  chartForce = makeChart("force-chart", "force (kN)", state.expRef.force.t, state.expRef.force.y, "#4f9dff", 0, 0.03, "time");
  chartP1 = makeChart("p1-chart", "P1 disp (mm)", state.expRef.P1.t, state.expRef.P1.y, "#4fd18b", -0.02, 0.2, "full");
  chartP4 = makeChart("p4-chart", "P4 disp (mm)", state.expRef.P4.t, state.expRef.P4.y, "#ff8a4f", -0.02, 0.2, "full");

  const yctx = document.getElementById("yield-chart").getContext("2d");
  chartYield = new Chart(yctx, {
    type: "line",
    data: { datasets: [
      { label: "current", data: [], borderColor: "#4f9dff", backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.1 },
      { label: "J1 = 0", data: [{ x: 0, y: 0 }, { x: 0, y: YIELD_Y_MAX }], borderColor: "#6b7280", borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
    ] },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false,
      scales: {
        x: { type: "linear", min: J1_MIN, max: J1_MAX, title: { display: true, text: "J1 (MPa)", color: "#9aa4b2" }, ticks: { color: "#9aa4b2" }, grid: { color: "#262c35" } },
        y: { min: 0, max: YIELD_Y_MAX, title: { display: true, text: "sqrt(J2) (MPa)", color: "#9aa4b2" }, ticks: { color: "#9aa4b2" }, grid: { color: "#262c35" } },
      },
      plugins: {
        legend: { labels: { color: "#e8eaed", filter: (item, data) => !data.datasets[item.datasetIndex].hidden } },
        zoom: {
          // y is sqrt(J2) -- never negative and always shown fixed at
          // [0, YIELD_Y_MAX], so only J1 (x) is pannable/zoomable. Locking
          // y here is what fixes the axis drifting further negative on
          // every drag.
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" },
          pan: { enabled: true, mode: "x" },
          limits: { x: { min: J1_MIN, max: J1_MAX } },
        },
      },
    },
  });
}

// Remove any extra (pinned-case) datasets beyond the fixed base ones, then
// re-add one dataset per currently pinned case, in matching colors.
function syncPinnedDatasets(chart, nBase, buildData) {
  chart.data.datasets.length = nBase;
  state.pinned.forEach(p => {
    const data = buildData(p);
    chart.data.datasets.push({
      label: p.label, data: data || [], borderColor: p.color, backgroundColor: "transparent",
      borderWidth: 1.5, pointRadius: 0, tension: 0.15, borderDash: data ? [] : [2, 2],
    });
  });
  chart.update();
}

function updateCharts(label) {
  if (!chartForce) return;
  // While comparing, hide the "current selection" curve itself -- showing
  // it alongside every pinned case was confusing (user: "헷갈려"). Only
  // the pinned cases + experiment stay visible; un-hides once the
  // comparison list is cleared.
  const comparing = state.pinned.length > 0;
  chartForce.data.datasets[0].hidden = comparing;
  chartP1.data.datasets[0].hidden = comparing;
  chartP4.data.datasets[0].hidden = comparing;

  const c = state.curves[label];
  if (c) {
    chartForce.data.datasets[0].data = alignForceSim(c.t_force, c.force);
    chartP1.data.datasets[0].data = alignSimToExp(c.t_p1, c.p1, state.expRef.P1.t, state.expRef.P1.y);
    chartP4.data.datasets[0].data = alignSimToExp(c.t_p4, c.p4, state.expRef.P4.t, state.expRef.P4.y);
  }
  syncPinnedDatasets(chartForce, 2, p => {
    const pc = state.curves[p.label];
    return pc ? alignForceSim(pc.t_force, pc.force) : null;
  });
  syncPinnedDatasets(chartP1, 2, p => {
    const pc = state.curves[p.label];
    return pc ? alignSimToExp(pc.t_p1, pc.p1, state.expRef.P1.t, state.expRef.P1.y) : null;
  });
  syncPinnedDatasets(chartP4, 2, p => {
    const pc = state.curves[p.label];
    return pc ? alignSimToExp(pc.t_p4, pc.p4, state.expRef.P4.t, state.expRef.P4.y) : null;
  });
}

function updateYieldChart() {
  if (!chartYield) return;
  const row = state.params.cases[caseIndexFromSelection()];
  chartYield.data.datasets[0].hidden = state.pinned.length > 0;
  chartYield.data.datasets[0].data = cscmYieldCurve(row.alpha, row.theta);
  chartYield.data.datasets[0].label = `current (alpha=${row.alpha}, theta=${row.theta})`;
  syncPinnedDatasets(chartYield, 2, p => {
    const r = state.params.cases[p.idx];
    return cscmYieldCurve(r.alpha, r.theta);
  });
}

function refreshAllCharts() {
  updateCharts(caseLabel(caseIndexFromSelection()));
  updateYieldChart();
  renderDamageComparisons();
  updateMainViewLockState();
}

function fmtPct(v) {
  return v === undefined || v === null ? "--" : v.toFixed(1) + "%";
}

function onSelectionChanged() {
  const idx = caseIndexFromSelection();
  const label = caseLabel(idx);
  document.getElementById("case-label").textContent = label;
  const row = state.params.cases[idx];
  const metricsEl = document.getElementById("case-metrics");
  if (row && row.force_rmse_pct !== undefined) {
    metricsEl.textContent = `force RMSE ${fmtPct(row.force_rmse_pct)} | P1 RMSE ${fmtPct(row.P1_rmse_pct)} | P4 RMSE ${fmtPct(row.P4_rmse_pct)} | combined ${row.combined_score !== undefined ? row.combined_score.toFixed(1) : "--"}`;
  } else if (row && (row.dmg_ok === false || row.curve_ok === false)) {
    metricsEl.textContent = "(this case failed / no data)";
  } else {
    metricsEl.textContent = "";
  }
  updateDamageColors(idx);
  updateCharts(label);
  updateYieldChart();
  renderDamageComparisons(); // no-op unless comparing -- keeps the live "current" thumbnail in sync with toggles
}

// The concrete mesh geometry is identical across Test1/Test2 (same shared
// mesh always) -- so switching tests only needs to swap params/curves/
// exp_ref/damage bytes and rebuild the toggles + exp-reference chart
// datasets, not the Three.js scene itself.
function setExpDataset(chart, expT, expY, alignMode) {
  chart.data.datasets[1].data = alignMode === "none" ? expT.map((t, i) => ({ x: t, y: expY[i] }))
    : onsetShiftedPoints(expT, expY, alignMode === "full" ? "exp" : "none");
}

async function loadTestData(testId) {
  const [params, expRef, damageBytes, curves] = await Promise.all([
    loadJSON(`data/${testId}/params.json`),
    loadJSON(`data/${testId}/exp_ref.json`),
    loadBinary(`data/${testId}/damage_all.bin`),
    loadJSON(`data/${testId}/curves.json`),
  ]);
  return { params, expRef, damageBytes, curves };
}

async function switchTest(testId) {
  if (state.testId === testId) return;
  document.querySelectorAll(".test-switch button").forEach(b => b.classList.toggle("active", b.dataset.test === testId));
  const { params, expRef, damageBytes, curves } = await loadTestData(testId);
  state.testId = testId;
  state.params = params;
  state.expRef = expRef;
  state.damageBytes = damageBytes;
  state.curves = curves;
  state.pinned = [];
  params.param_names.forEach(name => { state.selected[name] = 2; });

  buildToggles();
  renderPinnedList();
  if (chartForce) {
    setExpDataset(chartForce, expRef.force.t, expRef.force.y, "time");
    setExpDataset(chartP1, expRef.P1.t, expRef.P1.y, "full");
    setExpDataset(chartP4, expRef.P4.t, expRef.P4.y, "full");
  }
  onSelectionChanged();
}

async function main() {
  const mesh = await loadJSON("data/test1/mesh.json");
  state.mesh = mesh;
  const { params, expRef, damageBytes, curves } = await loadTestData("test1");
  state.testId = "test1";
  state.params = params;
  state.expRef = expRef;
  state.damageBytes = damageBytes;
  state.curves = curves;

  params.param_names.forEach(name => { state.selected[name] = 2; }); // default: middle level of each

  buildToggles();
  document.getElementById("pin-btn").addEventListener("click", addCurrentToPinned);
  document.getElementById("yield-reset-zoom").addEventListener("click", () => { if (chartYield) chartYield.resetZoom(); });
  document.querySelectorAll(".test-switch button").forEach(b => b.addEventListener("click", () => switchTest(b.dataset.test)));
  await initThree();
  try {
    initCharts();
  } catch (e) {
    console.error("Chart.js failed to load from CDN", e);
  }

  onSelectionChanged();
}

main();
