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
let renderer, scene, camera, controls, mesh3d, colorAttr;

function initThree() {
  const wrap = document.getElementById("damage-canvas-wrap");
  const canvas = document.getElementById("damage-canvas");
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);
  renderer.setClearColor(0x05070a, 1);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, wrap.clientWidth / wrap.clientHeight, 1, 100000);

  const { verts, faces } = state.mesh;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
  for (const [x, y, z] of verts) {
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    if (z < zmin) zmin = z; if (z > zmax) zmax = z;
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
      positions[p++] = v[0]; positions[p++] = v[1]; positions[p++] = v[2];
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

  camera.position.set(cx + diag * 0.55, cy + diag * 0.55, cz + diag * 0.4);
  camera.lookAt(cx, cy, cz);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(cx, cy, cz);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  window.addEventListener("resize", () => {
    renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    camera.aspect = wrap.clientWidth / wrap.clientHeight;
    camera.updateProjectionMatrix();
  });

  animate();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function updateDamageColors(caseIdx) {
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

// ---------- Chart.js curves ----------
let chartForce, chartP1, chartP4;

function makeChart(canvasId, yLabel, expT, expY, color) {
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
        x: { type: "linear", title: { display: true, text: "time (s)", color: "#9aa4b2" }, ticks: { color: "#9aa4b2" }, grid: { color: "#262c35" } },
        y: { title: { display: true, text: yLabel, color: "#9aa4b2" }, ticks: { color: "#9aa4b2" }, grid: { color: "#262c35" } },
      },
      plugins: { legend: { labels: { color: "#e8eaed" } } },
    },
  });
}

function initCharts() {
  chartForce = makeChart("force-chart", "force (kN)", state.expRef.force.t, state.expRef.force.y, "#4f9dff");
  chartP1 = makeChart("p1-chart", "P1 disp (mm)", state.expRef.P1.t, state.expRef.P1.y, "#4fd18b");
  chartP4 = makeChart("p4-chart", "P4 disp (mm)", state.expRef.P4.t, state.expRef.P4.y, "#ff8a4f");
}

function updateCharts(label) {
  const c = state.curves[label];
  if (!c) return;
  chartForce.data.datasets[0].data = (c.t_force || []).map((t, i) => ({ x: t, y: c.force[i] }));
  chartForce.update();
  chartP1.data.datasets[0].data = (c.t_p1 || []).map((t, i) => ({ x: t, y: c.p1[i] }));
  chartP1.update();
  chartP4.data.datasets[0].data = (c.t_p4 || []).map((t, i) => ({ x: t, y: c.p4[i] }));
  chartP4.update();
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
  initThree();
  initCharts();

  const [damageBytes, curves] = await Promise.all([
    loadBinary("data/damage_all.bin"),
    loadJSON("data/curves.json"),
  ]);
  state.damageBytes = damageBytes;
  state.curves = curves;

  onSelectionChanged();
}

main();
