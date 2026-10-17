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

// Measured off the model, not assumed: the impactor nose (solid part 4)
// spans z = 1365..1635 mm with its face at x = +505, so the strike is at
// z = 1500 on the +x side, on the y = 0 centreline. An earlier value of 2000
// here drew the arrow half a metre above where the pier is actually hit.
const PIER_R = 500, PIER_H = 4840;
const IMPACT_Z = 1500, IMPACT_FACE_X = 505;

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

    // Starts clear of the pier and ends on the impactor's contact face, so
    // the head lands where the strike happens rather than inside the column.
    const arrowLen = PIER_R * 1.6;
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(IMPACT_FACE_X + arrowLen, IMPACT_Z, 0),
      arrowLen, 0xff3b30, arrowLen * 0.26, arrowLen * 0.15);
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

function makeChart(canvas, xLabel, xMax, xMin = 0) {
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
          type: "linear", min: xMin, max: xMax,
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
            title: (it) => `${xLabel.split(" ")[0]} = ${(+it[0].parsed.x).toFixed(1)}`,
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

/** The value this row's parameter actually takes at this multiple.
 *
 *  Computed from the row's own default rather than read off the case, because
 *  the default column is one shared solve: its stored value belongs to
 *  whichever row happened to export it, not to the row being drawn.
 */
function ofatValue(layout, param, mult) {
  const base = layout.defaults?.[param];
  if (base === undefined) return "";
  const u = layout.units?.[param] ?? { scale: 1, dp: 3, unit: "" };
  return (base * mult * u.scale).toFixed(u.dp) + u.unit;
}

let ofatParam = null, ofatMult = null;

async function initOfat() {
  const g = await loadGroup("ofat", ["layout.json"]);

  // Two stacked pickers rather than a 6x5 matrix: the matrix does not fit a
  // narrow rail, and splitting it this way puts the parameter and the value
  // it takes on separate, readable lines.
  const plist = $("#ofat-params");
  plist.innerHTML = "";
  for (const p of g.layout.rows) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt";
    b.dataset.param = p;
    b.innerHTML = `<span class="lead">${PARAM_LABEL[p] || p}</span>` +
                  `<span class="trail">${ofatValue(g.layout, p, 1)}</span>`;
    b.addEventListener("click", () => pickOfatParam(p));
    plist.appendChild(b);
  }

  ofat.charts.force = makeChart($("#ofat-force"), "time (ms)", 20);
  ofat.charts.p1 = makeChart($("#ofat-p1"), "time (ms)", 150);
  ofat.charts.p4 = makeChart($("#ofat-p4"), "time (ms)", 150);
  ofat.charts.yield = makeChart($("#ofat-yield"), "J₁ (MPa)", undefined, undefined);
  ofat.charts.yield.options.scales.y.title = {
    display: true, text: "√J₂ (MPa)", color: "#86868b" };

  pickOfatParam(g.layout.rows[1] ?? g.layout.rows[0]);   // theta reads well first
}

function pickOfatParam(p) {
  ofatParam = p;
  const g = groups.ofat;
  $$("#ofat-params .opt").forEach((b) =>
    b.classList.toggle("selected", b.dataset.param === p));

  const vlist = $("#ofat-values");
  vlist.innerHTML = "";
  let fallback = null;
  for (const c of g.layout.cols) {
    const label = g.layout.cells[`${p}|${c}`];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt";
    b.dataset.mult = c;
    if (!label) {
      b.disabled = true;
      b.innerHTML = `<span class="lead">${ofatValue(g.layout, p, c)}</span>` +
                    `<span class="trail">inadmissible</span>`;
      b.title = "CSCM requires alpha > lamda; the solver rejects this deck";
    } else {
      b.dataset.label = label;
      b.innerHTML = `<span class="lead">${ofatValue(g.layout, p, c)}</span>` +
                    `<span class="trail">${c === 1 ? "default" : `×${c}`}</span>`;
      b.addEventListener("click", () => selectOfat(p, c));
      if (fallback === null || c === 1) fallback = c;
    }
    vlist.appendChild(b);
  }
  selectOfat(p, fallback);
}

async function selectOfat(p, mult) {
  if (mult === null || mult === undefined) return;
  ofatParam = p; ofatMult = mult;
  const g = groups.ofat;
  $$("#ofat-values .opt").forEach((b) =>
    b.classList.toggle("selected", +b.dataset.mult === mult));

  const label = g.layout.cells[`${p}|${mult}`];
  const row = g.meta.cases.find((c) => c.label === label);
  const cur = g.curves[label], base = g.curves.anchor;

  const shownVal = ofatValue(g.layout, p, mult);
  const baseVal = ofatValue(g.layout, p, 1);
  $("#ofat-note").textContent = mult === 1
    ? `All five parameters at their auto-generated CSCM default.`
    : `${PARAM_LABEL[p] || p} = ${shownVal}, i.e. ${mult}× its default of ${baseVal}; every other parameter unchanged.`;

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
  drawYieldSurface(p, mult);
  await showDamage("ofat", g, row);
}

/* --------------------------------------------------- CSCM yield surface --
 *
 * Ported from reference/ref_code/cscm_yield_surface.py, which the project
 * documents in cscm_yield_surface.md. Compression is positive in J1 here,
 * which is the convention the CSCM literature uses and the opposite of
 * LS-DYNA's own stress output.
 *
 *   shear failure surface   Ff(J1) = alpha - lamda*exp(-beta*J1) + theta*J1
 *   cap position            X(L)   = L + R*Ff(L)
 *   cap                     Fc     = 1 for J1 <= L, else
 *                                    1 - (J1-L)^2 / (X-L)^2
 *   combined                Fcont  = Ff * Fc
 *
 * beta, R and the initial cap position are not swept, so they are held at
 * the deck's values (card 3 field 6, and cscm_yield_surface_report.py).
 */
const CSCM_BETA = 1.929e-2, CSCM_R = 5.0, CSCM_KAPPA0 = 88.99;

function yieldCurve({ alpha, theta, lamda }) {
  const Ff = (J1) => alpha - lamda * Math.exp(-CSCM_BETA * J1) + theta * J1;
  // kappa0 is taken as L directly, which is the static approximation the
  // reference report uses (cscm_yield_surface.md, Limitations #2). The cap
  // does not harden here because these are envelopes, not solve states.
  const L = CSCM_KAPPA0;
  const X = L + CSCM_R * Ff(L);
  const pts = [];
  const J1min = -20, J1max = X;
  for (let i = 0; i <= 320; i++) {
    const J1 = J1min + (J1max - J1min) * (i / 320);
    const fc = J1 >= L ? 1 - ((J1 - L) / (X - L)) ** 2 : 1;
    if (fc < 0) continue;
    const v = Ff(J1) * Math.sqrt(fc);
    if (!Number.isFinite(v) || v < 0) continue;
    pts.push({ x: J1, y: v });
  }
  return pts;
}

function drawYieldSurface(p, mult) {
  const g = groups.ofat;
  const d = g.layout.defaults;
  const at = (m) => ({
    alpha: d.alpha * (p === "alpha" ? m : 1),
    theta: d.theta * (p === "theta" ? m : 1),
    lamda: d.lamda * (p === "lamda" ? m : 1),
  });
  // Only these three enter the envelope; E, GFC and GFT act on stiffness and
  // on softening, which the surface does not describe.
  const moves = ["alpha", "theta", "lamda"].includes(p);
  const ds = [];
  if (moves) {
    // The whole family faint, the chosen one solid: the point of the panel
    // is how far this parameter moves the envelope, not one curve alone.
    for (const m of g.layout.cols) {
      if (!g.layout.cells[`${p}|${m}`] || m === mult) continue;
      ds.push({ label: `×${m}`, data: yieldCurve(at(m)),
                borderColor: "#d7d7dc", borderWidth: 1.1 });
    }
  }
  ds.push({ label: moves && mult !== 1 ? `${PARAM_LABEL[p]} ×${mult}` : "default",
            data: yieldCurve(at(mult)), borderColor: SERIES[0], borderWidth: 2.2 });
  setSeries(ofat.charts.yield, ds);
  $("#ofat-yield-note").textContent = moves
    ? `The failure envelope: inside it the material is elastic. The other multiples of ${PARAM_LABEL[p]} are drawn faint for scale.`
    : `${PARAM_LABEL[p] || p} does not enter the yield surface — it acts on stiffness and softening, which this envelope does not describe. The curve shown is the default.`;
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
    b.className = "opt";
    b.innerHTML = `<span class="swatch" style="color:${SERIES[i % SERIES.length]}"></span>` +
                  `<span class="lead">h = ${c.h_mm} mm</span>` +
                  (c.energy_ratio < UNSOUND ? `<span class="badge">unsound</span>`
                                            : `<span class="trail">${c.energy_ratio}</span>`);
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
  $$("#mesh-list .opt").forEach((b) => {
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
    b.className = "opt";
    b.innerHTML = `<span class="swatch" style="color:${SERIES[i % SERIES.length]}"></span>` +
                  `<span class="lead">${c.title}</span>`;
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
  $$("#calib-list .opt").forEach((b) => {
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
