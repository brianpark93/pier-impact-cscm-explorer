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
  const arrowLen = Math.max(200, diag * 0.05);
  const arrowOrigin = new THREE.Vector3(IMPACT_X + arrowLen, IMPACT_Z, IMPACT_Y); // remapped (x,z,y)
  const arrowDir = new THREE.Vector3(-1, 0, 0);
  const arrow = new THREE.ArrowHelper(arrowDir, arrowOrigin, arrowLen, 0xff2d2d, arrowLen * 0.32, arrowLen * 0.18);
  arrow.line.material.linewidth = 2;
  scene.add(arrow);

  camera.position.set(cx + diag * 0.55, cy + diag * 0.55, cz + diag * 0.4);
  camera.lookAt(cx, cy, cz);

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

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function updateDamageColors(caseIdx) {
  if (!threeReady) return;
  const nFaces = state.params.n_faces;
  const offset = caseIdx * nFaces;
  const bytes = state.damageBytes;
  const arr = colorAttr.array;
  let p = 0;
  for (let fi = 0; fi < nFaces; fi++) {
    const d = bytes[offset + fi] / 255; // 0=intact .. 1=failed
    const g = 1 - d; // gray_r: intact -> white, failed -> black
    for (let k = 0; k < 6; k++) {
      arr[p++] = g; arr[p++] = g; arr[p++] = g;
    }
  }
  colorAttr.needsUpdate = true;
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
    txt.textContent = `${p.label}${row && row.combined_score !== undefined ? " (combined " + row.combined_score.toFixed(1) + ")" : ""}`;
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

function makeChart(canvasId, yLabel, expT, expY, color, xMax) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  return new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        { label: "simulation", data: [], borderColor: color, backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.15 },
        { label: "experiment (digitized)", data: expT.map((t, i) => ({ x: t, y: expY[i] })), borderColor: "#8a94a3", borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, tension: 0.15 },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      scales: {
        x: { type: "linear", min: 0, max: xMax, title: { display: true, text: "time (s)", color: "#9aa4b2" }, ticks: { color: "#9aa4b2" }, grid: { color: "#262c35" } },
        y: { title: { display: true, text: yLabel, color: "#9aa4b2" }, ticks: { color: "#9aa4b2" }, grid: { color: "#262c35" } },
      },
      plugins: { legend: { labels: { color: "#e8eaed" } } },
    },
  });
}

function initCharts() {
  chartForce = makeChart("force-chart", "force (kN)", state.expRef.force.t, state.expRef.force.y, "#4f9dff", 0.03);
  chartP1 = makeChart("p1-chart", "P1 disp (mm)", state.expRef.P1.t, state.expRef.P1.y, "#4fd18b", 0.2);
  chartP4 = makeChart("p4-chart", "P4 disp (mm)", state.expRef.P4.t, state.expRef.P4.y, "#ff8a4f", 0.2);

  const yctx = document.getElementById("yield-chart").getContext("2d");
  chartYield = new Chart(yctx, {
    type: "line",
    data: { datasets: [{ label: "current", data: [], borderColor: "#4f9dff", backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.1 }] },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false,
      scales: {
        x: { type: "linear", min: J1_MIN, max: J1_MAX, title: { display: true, text: "J1 (MPa)", color: "#9aa4b2" }, ticks: { color: "#9aa4b2" }, grid: { color: "#262c35" } },
        y: { min: 0, title: { display: true, text: "sqrt(J2) (MPa)", color: "#9aa4b2" }, ticks: { color: "#9aa4b2" }, grid: { color: "#262c35" } },
      },
      plugins: { legend: { labels: { color: "#e8eaed" } } },
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
  const c = state.curves[label];
  if (c) {
    chartForce.data.datasets[0].data = (c.t_force || []).map((t, i) => ({ x: t, y: c.force[i] }));
    chartP1.data.datasets[0].data = (c.t_p1 || []).map((t, i) => ({ x: t, y: c.p1[i] }));
    chartP4.data.datasets[0].data = (c.t_p4 || []).map((t, i) => ({ x: t, y: c.p4[i] }));
  }
  syncPinnedDatasets(chartForce, 2, p => {
    const pc = state.curves[p.label];
    return pc ? (pc.t_force || []).map((t, i) => ({ x: t, y: pc.force[i] })) : null;
  });
  syncPinnedDatasets(chartP1, 2, p => {
    const pc = state.curves[p.label];
    return pc ? (pc.t_p1 || []).map((t, i) => ({ x: t, y: pc.p1[i] })) : null;
  });
  syncPinnedDatasets(chartP4, 2, p => {
    const pc = state.curves[p.label];
    return pc ? (pc.t_p4 || []).map((t, i) => ({ x: t, y: pc.p4[i] })) : null;
  });
}

function updateYieldChart() {
  if (!chartYield) return;
  const row = state.params.cases[caseIndexFromSelection()];
  chartYield.data.datasets[0].data = cscmYieldCurve(row.alpha, row.theta);
  chartYield.data.datasets[0].label = `current (alpha=${row.alpha}, theta=${row.theta})`;
  syncPinnedDatasets(chartYield, 1, p => {
    const r = state.params.cases[p.idx];
    return cscmYieldCurve(r.alpha, r.theta);
  });
}

function refreshAllCharts() {
  updateCharts(caseLabel(caseIndexFromSelection()));
  updateYieldChart();
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
}

async function main() {
  const [params, mesh, expRef] = await Promise.all([
    loadJSON("data/params.json"),
    loadJSON("data/mesh.json"),
    loadJSON("data/exp_ref.json"),
  ]);
  state.params = params;
  state.mesh = mesh;
  state.expRef = expRef;

  params.param_names.forEach(name => { state.selected[name] = 2; }); // default: middle level of each

  buildToggles();
  document.getElementById("pin-btn").addEventListener("click", addCurrentToPinned);
  await initThree();
  try {
    initCharts();
  } catch (e) {
    console.error("Chart.js failed to load from CDN", e);
  }

  const [damageBytes, curves] = await Promise.all([
    loadBinary("data/damage_all.bin"),
    loadJSON("data/curves.json"),
  ]);
  state.damageBytes = damageBytes;
  state.curves = curves;

  onSelectionChanged();
}

main();
