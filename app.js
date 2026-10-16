/* RC Pier Impact -- CSCM Explorer
 *
 * Three views over three exported datasets (see export_site_data_v2.py):
 *   ofat   one parameter moved at a time about the CSCM default
 *   mesh   nine refinement levels at the default
 *   calib  the adopted sets against the measurements
 *
 * Geometry arrives as binary rather than JSON: float32 vertices and uint32
 * faces, surface only and re-indexed. The damage field is one uint8 per face
 * per case, concatenated, which is why a case carries a slot index rather
 * than its own file.
 */

const PIER_R = 500, PIER_H = 4840, IMPACT_Z = 2000;

const SERIES = ["#0071e3", "#ff375f", "#30a46c", "#f5a524", "#8e4ec6",
                "#0ea5b7", "#e8590c", "#5b6b7c", "#b5179e"];

const DEFAULT_GREY = "#b9b9c0";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

async function getJSON(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
}

async function getBuffer(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.arrayBuffer();
}

/* ------------------------------------------------------------------ three */
let THREE, OrbitControls;

async function loadThree() {
  if (THREE) return;
  THREE = await import("three");
  ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
}

/** One self-contained 3D pier view bound to a canvas. */
class PierView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ready = false;
    this.meshKey = null;
  }

  async init() {
    await loadThree();
    const wrap = this.canvas.parentElement;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 100000);

    // Three treats Y as up; the model has Z up, so vertices are swapped on
    // load (x, z, y) rather than rotating the whole scene.
    this.camera.position.set(PIER_R * 8, PIER_H * 0.5, PIER_R * 8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // Damping is off on purpose. It only advances while update() is being
    // called, so it forces a permanent rAF loop; without it the scene can be
    // drawn on demand, which keeps the page idle when nobody is dragging it
    // (and lets a headless browser settle enough to screenshot the page).
    this.controls.enableDamping = false;
    this.controls.target.set(0, PIER_H * 0.5, 0);
    this.controls.addEventListener("change", () => this.requestRender());

    const arrowLen = PIER_R * 1.5;
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(PIER_R + arrowLen, IMPACT_Z, 0),
      arrowLen, 0xff3b30, arrowLen * 0.3, arrowLen * 0.18);
    this.scene.add(arrow);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.ready = true;
    this.requestRender();
  }

  resize() {
    const wrap = this.canvas.parentElement;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.fitted) this.fitView();
    this.requestRender();
  }

  /** Pull the camera back far enough that the whole model is in frame.
   *
   *  Fitted to the geometry's own bounding box, not to the nominal pier
   *  dimensions: the box also has to cover the impact arrow, and the mesh
   *  levels do not all end at exactly the same extent. Done from the aspect
   *  ratio too, since the panel is portrait on a desktop and nearly square
   *  on a phone.
   */
  fitView() {
    const b = this.bbox;
    if (!b) return;
    this.controls.target.set(b.cx, b.cy, b.cz);
    const halfH = b.hy * 1.14;
    const halfW = Math.max(b.hx, b.hz) * 1.3;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const dV = halfH / Math.tan(vFov / 2);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dH = halfW / Math.tan(hFov / 2);
    const d = Math.max(dV, dH);
    const t = this.controls.target;
    const dir = this.camera.position.clone().sub(t).normalize();
    this.camera.position.copy(t).add(dir.multiplyScalar(d));
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.fitted = true;
    this.requestRender();
  }

  /** Draw once on the next frame; repeated calls in a frame collapse. */
  requestRender() {
    if (!this.ready || this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** geom: {verts: Float32Array, faces: Uint32Array} already surface-only. */
  setGeometry(key, geom) {
    if (this.meshKey === key) return;
    this.meshKey = key;
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    const nF = geom.faces.length / 4;
    // Two triangles per quad face, vertices duplicated so each face can carry
    // a flat colour.
    const pos = new Float32Array(nF * 6 * 3);
    const col = new Float32Array(nF * 6 * 3);
    const tri = [0, 1, 2, 0, 2, 3];
    for (let f = 0; f < nF; f++) {
      for (let k = 0; k < 6; k++) {
        const vi = geom.faces[f * 4 + tri[k]];
        const o = (f * 6 + k) * 3;
        pos[o]     = geom.verts[vi * 3];
        pos[o + 1] = geom.verts[vi * 3 + 2];   // z -> y
        pos[o + 2] = geom.verts[vi * 3 + 1];   // y -> z
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.colorAttr = new THREE.BufferAttribute(col, 3);
    g.setAttribute("color", this.colorAttr);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
    }));
    this.scene.add(this.mesh);
    this.nFaces = nF;

    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i] < x0) x0 = pos[i];       if (pos[i] > x1) x1 = pos[i];
      if (pos[i+1] < y0) y0 = pos[i+1];   if (pos[i+1] > y1) y1 = pos[i+1];
      if (pos[i+2] < z0) z0 = pos[i+2];   if (pos[i+2] > z1) z1 = pos[i+2];
    }
    this.bbox = {
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: (z0 + z1) / 2,
      hx: (x1 - x0) / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2,
    };
    if (!this.fitted) this.fitView();
    this.requestRender();
  }

  /** damage: Uint8Array of length nFaces, 0 intact .. 255 failed. */
  setDamage(damage) {
    if (!this.mesh) return;
    const col = this.colorAttr.array;
    for (let f = 0; f < this.nFaces; f++) {
      const v = 1 - (damage[f] || 0) / 255;
      // Intact material is a light cool grey, NOT white: on a white page a
      // white pier disappears and only the cracks are left floating.
      const r = 0.085 + 0.695 * v, g = 0.094 + 0.701 * v, b = 0.110 + 0.721 * v;
      for (let k = 0; k < 6; k++) {
        const o = (f * 6 + k) * 3;
        col[o] = r; col[o + 1] = g; col[o + 2] = b;
      }
    }
    this.colorAttr.needsUpdate = true;
    this.requestRender();
  }
}

/* ------------------------------------------------------------------ charts */
Chart.defaults.font.family =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.color = "#6e6e73";

function makeChart(canvas, xLabel, xMax) {
  return new Chart(canvas, {
    type: "line",
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      elements: { point: { radius: 0 }, line: { borderWidth: 1.6, tension: 0.18 } },
      scales: {
        x: {
          type: "linear", min: 0, max: xMax,
          title: { display: true, text: xLabel, color: "#86868b" },
          grid: { color: "#f0f0f4" },
          border: { color: "#d2d2d7" },
          ticks: { maxTicksLimit: 7 },
        },
        y: {
          grid: { color: "#f0f0f4" },
          border: { color: "#d2d2d7" },
          ticks: { maxTicksLimit: 6 },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(29,29,31,.92)",
          padding: 9, cornerRadius: 8, displayColors: true, boxWidth: 8,
          callbacks: {
            title: (it) => `t = ${(+it[0].parsed.x).toFixed(1)} ms`,
            label: (it) => `${it.dataset.label}: ${(+it.parsed.y).toFixed(1)}`,
          },
        },
      },
    },
  });
}

/** Curve payloads store t in seconds; charts want milliseconds. */
function points(t, y, zeroBase) {
  if (!t || !y) return [];
  const y0 = zeroBase ? y[0] : 0;
  const out = new Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = { x: t[i] * 1e3, y: y[i] - y0 };
  return out;
}

function setSeries(chart, series) {
  chart.data.datasets = series;
  chart.update("none");
}

/* ------------------------------------------------------------------ state */
const groups = {};        // key -> {meta, curves, layout, meshes:{}, damage:{}}
const views = {};         // key -> PierView
let expRef = null;        // measured reference curves, both tests

/** Measured curve as chart points, or [] when that channel was not digitised. */
function expPoints(testNum, channel) {
  const rec = expRef?.[`test${testNum}`]?.[channel];
  if (!rec) return [];
  return rec.t.map((t, i) => ({ x: t * 1e3, y: rec.y[i] }));
}

function expDataset(testNum, channel) {
  const data = expPoints(testNum, channel);
  if (!data.length) return null;
  return { label: "measured", data, borderColor: "#1d1d1f", borderWidth: 1.5,
           borderDash: [5, 4], order: 99 };
}

async function loadGroup(key, extra = []) {
  if (groups[key]) return groups[key];
  const base = `data/${key}`;
  const [meta, curves, ...rest] = await Promise.all([
    getJSON(`${base}/meta.json`),
    getJSON(`${base}/curves.json`),
    ...extra.map((f) => getJSON(`${base}/${f}`)),
  ]);
  const g = { meta, curves, meshes: {}, damage: {}, base };
  if (extra.length) g.layout = rest[0];
  groups[key] = g;
  return g;
}

async function ensureMesh(g, meshKey) {
  if (g.meshes[meshKey]) return g.meshes[meshKey];
  const buf = await getBuffer(`${g.base}/mesh_${meshKey}.bin`);
  const head = new Uint32Array(buf, 0, 2);
  const nV = head[0], nF = head[1];
  const verts = new Float32Array(buf, 8, nV * 3);
  const faces = new Uint32Array(buf, 8 + nV * 12, nF * 4);
  g.meshes[meshKey] = { verts, faces, nF };
  return g.meshes[meshKey];
}

async function ensureDamage(g, meshKey) {
  if (g.damage[meshKey]) return g.damage[meshKey];
  g.damage[meshKey] = new Uint8Array(await getBuffer(`${g.base}/damage_${meshKey}.bin`));
  return g.damage[meshKey];
}

async function showDamage(viewKey, g, caseRow) {
  const wrap = $(`#${viewKey}-damage-wrap`);
  const nodata = $(".nodata", wrap);
  if (!caseRow) { nodata.hidden = false; return; }
  nodata.hidden = true;
  const view = views[viewKey];
  if (!view.ready) await view.init();
  const mk = caseRow.mesh;
  const geom = await ensureMesh(g, mk);
  const dmg = await ensureDamage(g, mk);
  view.setGeometry(mk, geom);
  view.setDamage(dmg.subarray(caseRow.dmg_slot * geom.nF, (caseRow.dmg_slot + 1) * geom.nF));
}

/* ======================================================= view: sensitivity */
const PARAM_LABEL = { alpha: "α", theta: "θ", lamda: "λ",
                      E: "E", GFC: "GFC", GFT: "GFT" };

const ofat = { sel: null, charts: {} };

async function initOfat() {
  const g = await loadGroup("ofat", ["layout.json"]);
  const { rows, cols, cells } = g.layout;
  const grid = $("#ofat-grid");
  grid.style.gridTemplateColumns = `auto repeat(${cols.length}, 1fr)`;
  grid.innerHTML = "";

  grid.appendChild(Object.assign(document.createElement("div"), { className: "gm-head" }));
  for (const c of cols) {
    grid.appendChild(Object.assign(document.createElement("div"), {
      className: "gm-head", textContent: c === 1 ? "default" : `×${c}`,
    }));
  }

  for (const p of rows) {
    grid.appendChild(Object.assign(document.createElement("div"), {
      className: "gm-row-label", innerHTML: PARAM_LABEL[p] || p,
    }));
    for (const c of cols) {
      const label = cells[`${p}|${c}`];
      const b = document.createElement("button");
      b.className = "gm-cell" + (c === 1 ? " is-default" : "");
      b.type = "button";
      if (!label) {
        b.disabled = true;
        b.textContent = "—";
        b.title = "Inadmissible: CSCM requires alpha > lamda";
      } else {
        b.textContent = c === 1 ? "default" : `×${c}`;
        b.dataset.label = label;
        b.dataset.param = p;
        b.dataset.mult = c;
        b.addEventListener("click", () => selectOfat(b));
      }
      grid.appendChild(b);
    }
  }

  ofat.charts.force = makeChart($("#ofat-force"), "time (ms)", 20);
  ofat.charts.p1 = makeChart($("#ofat-p1"), "time (ms)", 150);
  ofat.charts.p4 = makeChart($("#ofat-p4"), "time (ms)", 150);

  const first = $(".gm-cell:not(:disabled)", grid);
  if (first) selectOfat(first);
}

async function selectOfat(btn) {
  $$("#ofat-grid .gm-cell.selected").forEach((e) => e.classList.remove("selected"));
  btn.classList.add("selected");
  const g = groups.ofat;
  const label = btn.dataset.label;
  const row = g.meta.cases.find((c) => c.label === label);
  const cur = g.curves[label], base = g.curves.anchor;

  const mult = +btn.dataset.mult;
  const p = btn.dataset.param;
  $("#ofat-note").textContent = mult === 1
    ? "All five parameters at their auto-generated CSCM default."
    : `${PARAM_LABEL[p] || p} at ${mult}× its default; every other parameter unchanged.`;

  const spec = [["force", "force", "t_force", false],
                ["p1", "p1", "t_p1", true],
                ["p4", "p4", "t_p4", true]];
  for (const [chartKey, yKey, tKey, zero] of spec) {
    const ds = [];
    if (base && mult !== 1) {
      ds.push({ label: "default", data: points(base[tKey], base[yKey], zero),
                borderColor: DEFAULT_GREY, borderWidth: 1.4, borderDash: [4, 3] });
    }
    if (cur) {
      ds.push({ label: mult === 1 ? "default" : `${PARAM_LABEL[p] || p} ×${mult}`,
                data: points(cur[tKey], cur[yKey], zero),
                borderColor: SERIES[0], borderWidth: 2 });
    }
    setSeries(ofat.charts[chartKey], ds);
  }
  await showDamage("ofat", g, row);
}

/* ==================================================== view: mesh convergence */
const meshView = { on: new Set(), active: null, charts: {} };
const UNSOUND = 0.40;

async function initMesh() {
  const g = await loadGroup("mesh");
  const list = $("#mesh-list");
  list.innerHTML = "";
  g.meta.cases.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (c.energy_ratio < UNSOUND ? " unsound" : "");
    b.innerHTML = `<span class="swatch" style="color:${SERIES[i % SERIES.length]}"></span>
                   h = ${c.h_mm} mm`;
    b.title = `${c.n_solid.toLocaleString()} concrete elements, energy ratio ${c.energy_ratio}`;
    b.dataset.label = c.label;
    b.addEventListener("click", () => toggleMesh(c.label));
    list.appendChild(b);
  });
  meshView.charts.force = makeChart($("#mesh-force"), "time (ms)", 20);
  meshView.charts.p1 = makeChart($("#mesh-p1"), "time (ms)", 150);
  meshView.charts.p4 = makeChart($("#mesh-p4"), "time (ms)", 150);

  // Start with the coarsest, mesh1x and the finest: enough to show the trend
  // without nine curves on top of each other.
  const picks = [g.meta.cases[0], g.meta.cases[4], g.meta.cases.at(-1)].filter(Boolean);
  picks.forEach((c) => meshView.on.add(c.label));
  meshView.active = picks.at(-1).label;
  await refreshMesh();
}

async function toggleMesh(label) {
  if (meshView.on.has(label) && meshView.active !== label) {
    meshView.active = label;                       // second click: draw it in 3D
  } else if (meshView.on.has(label)) {
    meshView.on.delete(label);
    if (meshView.active === label) meshView.active = [...meshView.on].at(-1) || null;
  } else {
    meshView.on.add(label);
    meshView.active = label;
  }
  await refreshMesh();
}

async function refreshMesh() {
  const g = groups.mesh;
  $$("#mesh-list .chip").forEach((b) => {
    b.classList.toggle("on", meshView.on.has(b.dataset.label));
    b.classList.toggle("active-3d", meshView.active === b.dataset.label);
  });
  const spec = [["force", "force", "t_force", false],
                ["p1", "p1", "t_p1", true],
                ["p4", "p4", "t_p4", true]];
  for (const [chartKey, yKey, tKey, zero] of spec) {
    const ds = [];
    g.meta.cases.forEach((c, i) => {
      if (!meshView.on.has(c.label)) return;
      const cu = g.curves[c.label];
      if (!cu) return;
      ds.push({ label: `h = ${c.h_mm} mm`, data: points(cu[tKey], cu[yKey], zero),
                borderColor: SERIES[i % SERIES.length],
                borderWidth: c.label === meshView.active ? 2.4 : 1.5,
                borderDash: c.energy_ratio < UNSOUND ? [5, 3] : [] });
    });
    setSeries(meshView.charts[chartKey], ds);
  }
  const row = g.meta.cases.find((c) => c.label === meshView.active);
  $("#mesh-active-label").textContent = row
    ? `h = ${row.h_mm} mm · ${row.n_solid.toLocaleString()} elements · energy ratio ${row.energy_ratio}`
    : "";
  await showDamage("mesh", g, row);
}

/* ======================================================== view: calibrated */
const calib = { on: new Set(), active: null, charts: {} };

const CALIB_SCORES = [
  ["mesh1x adopted", "118.1 ± 1.4", "49.4 ± 1.3", "68.7 ± 0.9", "9"],
  ["mesh2x adopted", "127.7 ± 5.0", "41.2 ± 2.4", "86.4 ± 4.6", "11"],
  ["CSCM default (mesh1x)", "262.3 ± 21.7", "139.8 ± 3.9", "122.5 ± 23.4", "5"],
];

async function initCalib() {
  const g = await loadGroup("calib");
  const list = $("#calib-list");
  list.innerHTML = "";
  g.meta.cases.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.innerHTML = `<span class="swatch" style="color:${SERIES[i % SERIES.length]}"></span>${c.title}`;
    b.dataset.label = c.label;
    b.addEventListener("click", () => toggleCalib(c.label));
    list.appendChild(b);
  });

  const t = document.createElement("table");
  t.innerHTML =
    `<thead><tr><th>Parameter set</th><th>J</th><th>C<sub>Test1</sub></th>
     <th>C<sub>Test2</sub></th><th>repeats</th></tr></thead><tbody>` +
    CALIB_SCORES.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td>
     <td>${r[3]}</td><td>${r[4]}</td></tr>`).join("") + "</tbody>";
  $("#calib-table").innerHTML = "";
  $("#calib-table").appendChild(t);

  const start = g.meta.cases.filter((c) => c.test === 1);
  start.forEach((c) => calib.on.add(c.label));
  calib.active = start[0]?.label ?? null;
  calib.charts.force = makeChart($("#calib-force"), "time (ms)", 20);
  calib.charts.p1 = makeChart($("#calib-p1"), "time (ms)", 150);
  calib.charts.p4 = makeChart($("#calib-p4"), "time (ms)", 150);
  await refreshCalib();
}

async function toggleCalib(label) {
  if (calib.on.has(label) && calib.active !== label) {
    calib.active = label;
  } else if (calib.on.has(label)) {
    calib.on.delete(label);
    if (calib.active === label) calib.active = [...calib.on].at(-1) || null;
  } else {
    calib.on.add(label);
    calib.active = label;
  }
  await refreshCalib();
}

async function refreshCalib() {
  const g = groups.calib;
  $$("#calib-list .chip").forEach((b) => {
    b.classList.toggle("on", calib.on.has(b.dataset.label));
    b.classList.toggle("active-3d", calib.active === b.dataset.label);
  });
  const spec = [["force", "force", "t_force", false],
                ["p1", "p1", "t_p1", true],
                ["p4", "p4", "t_p4", true]];
  const CHANNEL = { force: "force", p1: "P1", p4: "P4" };
  // Only one measurement can be drawn per chart; use the test the highlighted
  // case belongs to, so the dashed line always matches what is in front.
  const activeRow = g.meta.cases.find((c) => c.label === calib.active);
  const shownTests = new Set(g.meta.cases.filter((c) => calib.on.has(c.label)).map((c) => c.test));
  const expTest = activeRow ? activeRow.test : [...shownTests][0];
  for (const [chartKey, yKey, tKey, zero] of spec) {
    const ds = [];
    g.meta.cases.forEach((c, i) => {
      if (!calib.on.has(c.label)) return;
      const cu = g.curves[c.label];
      if (!cu) return;
      ds.push({ label: c.title, data: points(cu[tKey], cu[yKey], zero),
                borderColor: SERIES[i % SERIES.length],
                borderWidth: c.label === calib.active ? 2.4 : 1.5 });
    });
    if (expTest) {
      const e = expDataset(expTest, CHANNEL[chartKey]);
      if (e) ds.push(e);
    }
    setSeries(calib.charts[chartKey], ds);
  }
  $(".chart-card .hint", $("#view-calib")).textContent =
    expTest ? `measurement dashed (Test ${expTest})` : "no measurement shown";
  const row = g.meta.cases.find((c) => c.label === calib.active);
  $("#calib-active-label").textContent = row ? row.title : "";
  await showDamage("calib", g, row);
}

/* -------------------------------------------------------------------- boot */
const INIT = { ofat: initOfat, mesh: initMesh, calib: initCalib };
const started = new Set();

async function loadExpRef() {
  if (expRef) return;
  try {
    expRef = await getJSON("data/exp_ref.json");
  } catch (err) {
    console.warn("no measured reference available:", err.message);
    expRef = {};
  }
}

async function showView(key, push = true) {
  if (!INIT[key]) key = "ofat";
  if (push && location.hash.slice(1) !== key) history.replaceState(null, "", `#${key}`);
  $$("#view-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === key));
  $$(".view").forEach((s) => s.classList.toggle("active", s.id === `view-${key}`));
  if (!started.has(key)) {
    started.add(key);
    try {
      await loadExpRef();
      await INIT[key]();
    } catch (err) {
      started.delete(key);
      console.error(err);
      const note = $(`#view-${key} .view-intro`);
      if (note) note.textContent = `Could not load this dataset: ${err.message}`;
    }
  }
  // A canvas sized while its section was hidden comes back as 0x0.
  const v = views[key];
  if (v?.ready) v.resize();
}

function main() {
  for (const k of Object.keys(INIT)) views[k] = new PierView($(`#${k}-damage`));
  $$("#view-tabs button").forEach((b) =>
    b.addEventListener("click", () => showView(b.dataset.view)));
  $("#build-stamp").textContent = "Data exported 2026-10-16.";
  // The view lives in the hash so a tab can be linked to directly.
  window.addEventListener("hashchange", () => showView(location.hash.slice(1), false));
  showView(location.hash.slice(1) || "ofat");
}

main();
