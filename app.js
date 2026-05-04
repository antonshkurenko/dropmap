'use strict';
//
// Dropmap — Fortnite drop calculator.
// Single-file vanilla JS app. Sections (top → bottom):
//   1. Constants & state
//   2. Storage (persist / restore)
//   3. Asset loading (map, heightmap, locations)
//   4. Coordinate / unit conversion
//   5. Math (bearing, compass)
//   6. Physics & trajectory (reachable hull, manual deploy, optimizer)
//   7. Rendering (canvas draws, popup)
//   8. Hit-testing
//   9. Pin operations
//  10. UI state (mode, hint, bus draw)
//  11. Pin list panel
//  12. Input handlers (mouse, keyboard)
//  13. Wire-up & init

// --- Constants ---
const HEIGHTMAP_URL = 'data/heightmap.png';
const LOCATIONS_URL = 'data/locations.json';
const STORAGE_KEY = 'dropmap.v2';
const PIN_R = 8;
const HANDLE_R = 10;
const HIT_PX = 12;
const DRAG_THRESHOLD = 5;
const PIN_COLORS = ['#e35a5a','#5aa6e3','#6cd66c','#e3c95a','#c97ae3','#5ae3c9'];
// Max search radius for the ring-mode auto-deploy hull (meters).
// Internal cap; the hull boundary itself is determined by terrain physics.
const RING_SEARCH_MAX_M = 800;
const state = {
  mode: 'ring',
  pins: [],
  busStart: null,
  busEnd: null,
  selectedPinId: null,
  // Constants per technik-consulting.eu engineering analysis of Fortnite physics:
  // bus 830 m altitude at 100 m/s, freefall total speed 32 m/s (angle search picks split),
  // glider auto-deploys 100 m above ground, glide ratio 3:1 → 100 m altitude → 300 m horizontal.
  settings: {
    mapMeters: 3000,
    busSpeed: 100,
    fallH: 13, fallV: 29,    // magnitude ≈ 32; angle search optimizes split
    glideH: 24, glideV: 8,   // ratio 3.0 — 100m altitude → 300m glide
    busAlt: 830, deployAlt: 100,
  },
  view: { x: 0, y: 0, scale: 1 },
};
const runtime = {
  mapImage: null,
  heightmap: null,    // { w, h, data: Uint8ClampedArray RGBA }
  embencoPois: null,
  drawBusMode: false,
  drawBusFirst: null,
  drag: null,         // { kind: 'pan'|'pin'|'busStart'|'busEnd'|'maybeGhost', ... }
  mouseDown: null,    // { sx, sy, moved }
  suggestions: [],    // up to MAX_SUGGESTIONS [{x,y,total,savings}] for current target
};
// --- DOM ---
const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id);
// --- Storage ---
function persist() {
  const { mode, pins, busStart, busEnd, selectedPinId,
    settings, view } = state;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    mode, pins, busStart, busEnd, selectedPinId,
    settings, view,
  }));
}
function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    const defaultSettings = { ...state.settings };
    Object.assign(state, saved);
    // merge settings to fill in any missing keys from older saves
    state.settings = { ...defaultSettings, ...(saved.settings || {}) };
  } catch (e) { console.warn('restore failed', e); }
}
// --- Asset loading ---
// Use the locally-stitched embenco map (data/map.png) so the displayed map
// and the heightmap share the same coordinate system / framing. The
// fortnite-api.com map looked similar but had different padding and caused
// a noticeable misalignment (water reading 20 m, etc.).
async function loadMap() {
  showHint('Loading map…');
  runtime.mapImage = await loadImage('data/map.png');
  hideHint();
  fitMap();
  render();
}
function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}
async function loadHeightmap() {
  try {
    const img = await loadImage(HEIGHTMAP_URL);
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const c = cv.getContext('2d');
    c.drawImage(img, 0, 0);
    const data = c.getImageData(0, 0, img.width, img.height).data;
    runtime.heightmap = { w: img.width, h: img.height, data };
  } catch (e) {
    console.warn('heightmap failed to load', e);
  }
}
async function loadLocations() {
  try {
    const r = await fetch(LOCATIONS_URL);
    runtime.embencoPois = await r.json();
  } catch (e) {
    console.warn('locations failed', e);
  }
}
// Bilinear-sample heightmap and convert to meters above sea level.
// Heightmap encoding: R = (val - min) >> 8, G = (val - min) & 0xFF, units of cm.
function terrainAltAt(mapX, mapY) {
  const hm = runtime.heightmap;
  const map = runtime.mapImage;
  if (!hm || !map) return 0;
  const fx = Math.max(0, Math.min(1, mapX / map.width));
  const fy = Math.max(0, Math.min(1, mapY / map.height));
  const hx = fx * (hm.w - 1);
  const hy = fy * (hm.h - 1);
  const x0 = Math.floor(hx), x1 = Math.min(hm.w - 1, x0 + 1);
  const y0 = Math.floor(hy), y1 = Math.min(hm.h - 1, y0 + 1);
  const tx = hx - x0, ty = hy - y0;
  const at = (x, y) => {
    const i = (y * hm.w + x) * 4;
    return (hm.data[i] << 8) | hm.data[i + 1];
  };
  const v00 = at(x0, y0), v10 = at(x1, y0), v01 = at(x0, y1), v11 = at(x1, y1);
  const v0 = v00 + (v10 - v00) * tx;
  const v1 = v01 + (v11 - v01) * tx;
  return (v0 + (v1 - v0) * ty) / 100; // cm → m, anchored at sea level = 0
}
// --- Coords ---
function metersPerPx() {
  const img = runtime.mapImage;
  if (!img) return 1;
  return state.settings.mapMeters / img.width;
}
function pxToM(px) { return px * metersPerPx(); }
function mToPx(m) { return m / metersPerPx(); }
function distMap(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function distM(a, b) { return pxToM(distMap(a, b)); }
function screenToMap(sx, sy) {
  return {
    x: (sx - state.view.x) / state.view.scale,
    y: (sy - state.view.y) / state.view.scale,
  };
}
function mapToScreen(mx, my) {
  return {
    x: mx * state.view.scale + state.view.x,
    y: my * state.view.scale + state.view.y,
  };
}
function fitMap() {
  const img = runtime.mapImage;
  if (!img) return;
  resizeCanvas();
  const w = canvas._cssW, h = canvas._cssH;
  const s = Math.min(w / img.width, h / img.height) * 0.95;
  state.view.scale = s;
  state.view.x = (w - img.width * s) / 2;
  state.view.y = (h - img.height * s) / 2;
}
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  canvas._cssW = r.width;
  canvas._cssH = r.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
// --- Math ---
function bearingDeg(from, to) {
  // 0 = north (negative y), clockwise
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let a = Math.atan2(dx, -dy) * 180 / Math.PI;
  if (a < 0) a += 360;
  return a;
}
function compass(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

// --- Physics & trajectory ---
// Compute the auto-deploy reachable area around `center`:
// for each direction, walk outward until a hypothetical player at
// (local_terrain + deployAlt) can no longer glide to `center`.
function computeReachableHull(center) {
  const s = state.settings;
  const centerGround = terrainAltAt(center.x, center.y) + (center.z || 0);
  const maxR = mToPx(RING_SEARCH_MAX_M);
  const stepM = 8;
  const step = mToPx(stepM);
  const glideRatio = s.glideH / s.glideV;
  const N = 96;
  const points = [];
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * Math.PI * 2;
    const dx = Math.cos(theta), dy = Math.sin(theta);
    let edge = 0;
    for (let r = step; r <= maxR; r += step) {
      const x = center.x + dx * r;
      const y = center.y + dy * r;
      const local = terrainAltAt(x, y);
      const vBudget = local + s.deployAlt - centerGround;
      if (vBudget <= 0) break;
      const hBudget = vBudget * glideRatio;
      if (hBudget >= pxToM(r)) edge = r;
      else break;
    }
    points.push({ x: center.x + dx * edge, y: center.y + dy * edge, r: edge });
  }
  return points;
}

// Manual deploy fallback: analytical solve assuming flat path.
// Used when auto-deploy can't reach the target — player must voluntarily
// deploy higher up to gain glide budget. Returns the altitude at which to deploy.
function manualDeploy(J, target, TG) {
  const s = state.settings;
  const distJT_px = Math.hypot(target.x - J.x, target.y - J.y);
  if (distJT_px < 1) return null;
  const distJT_m = pxToM(distJT_px);
  const H = s.busAlt - TG;
  if (H <= 0) return null;
  const ratio = s.glideH / s.glideV;
  // H = fallV*tF + glideV*tG;  D = fallH*tF + glideH*tG
  const denom = s.fallH - s.fallV * ratio;
  if (Math.abs(denom) < 1e-6) return null;
  const tF = (distJT_m - ratio * H) / denom;
  const tG = (H - s.fallV * tF) / s.glideV;
  if (tF < 0 || tG < 0) return null;
  const dirX = (target.x - J.x) / distJT_px;
  const dirY = (target.y - J.y) / distJT_px;
  const dF_m = s.fallH * tF;
  const G_x = J.x + dirX * mToPx(dF_m);
  const G_y = J.y + dirY * mToPx(dF_m);
  const G_alt = s.busAlt - s.fallV * tF;
  // Sanity: deploy must be above terrain+deployAlt at G
  const terrG = terrainAltAt(G_x, G_y);
  if (G_alt < terrG + s.deployAlt) return null;
  // Sanity: path must not be blocked by terrain rising above current altitude
  // (auto-deploy would fire mid-path). Sample.
  let terrainPeak = terrainAltAt(J.x, J.y);
  const STEPS = 30;
  for (let i = 1; i <= STEPS; i++) {
    const f = i / STEPS;
    const x = J.x + dirX * mToPx(dF_m * f);
    const y = J.y + dirY * mToPx(dF_m * f);
    const altAt = s.busAlt - s.fallV * tF * f;
    const ter = terrainAltAt(x, y);
    if (ter > terrainPeak) terrainPeak = ter;
    if (altAt < ter + s.deployAlt) return null; // would force auto-deploy earlier
  }
  return {
    tFall: tF, tGlide: tG,
    dFall: dF_m, dGlide: pxToM(Math.hypot(target.x - G_x, target.y - G_y)),
    G: { x: G_x, y: G_y }, deployAlt: G_alt, deployMode: 'manual', terrainPeak,
  };
}
let _optimalCache = null;
function computeOptimal(busStart, busEnd, target, targetZ = 0) {
  const key = `${busStart?.x},${busStart?.y}|${busEnd?.x},${busEnd?.y}|${target?.x},${target?.y}|${targetZ}`;
  if (_optimalCache && _optimalCache.key === key) return _optimalCache.value;
  const value = _computeOptimal(busStart, busEnd, target, targetZ);
  _optimalCache = { key, value };
  return value;
}
// Search a grid around the target for landing spots that beat the current
// total time by ≥1s. Returns up to MAX_SUGGESTIONS entries (sorted best-first,
// deduplicated within DEDUP_M meters). Cached per (target, bus) tuple.
const MAX_SUGGESTIONS = 5;
const DEDUP_M = 30;
let _suggestionCache = null;
function findBetterSpotsNearby(busStart, busEnd, target, currentTotal) {
  const key = `${target.x.toFixed(1)},${target.y.toFixed(1)}|${busStart.x.toFixed(1)},${busStart.y.toFixed(1)}|${busEnd.x.toFixed(1)},${busEnd.y.toFixed(1)}`;
  if (_suggestionCache && _suggestionCache.key === key) return _suggestionCache.value;
  const candidates = [];
  const radii_m = [10, 25, 50, 100];
  const N_DIR = 12;
  for (const rm of radii_m) {
    const r = mToPx(rm);
    for (let d = 0; d < N_DIR; d++) {
      const theta = (d / N_DIR) * Math.PI * 2;
      const T2 = {
        x: target.x + Math.cos(theta) * r,
        y: target.y + Math.sin(theta) * r,
        z: target.z || 0,
      };
      const res = _computeOptimal(busStart, busEnd, T2, T2.z);
      if (res.reachable && res.total + 1.0 < currentTotal) {
        candidates.push({ x: T2.x, y: T2.y, total: res.total, savings: currentTotal - res.total });
      }
    }
  }
  candidates.sort((a, b) => b.savings - a.savings);
  // Greedy dedup: keep best, skip later ones within DEDUP_M of any kept one.
  const kept = [];
  const dedupPx = mToPx(DEDUP_M);
  for (const c of candidates) {
    if (kept.length >= MAX_SUGGESTIONS) break;
    if (kept.some(k => Math.hypot(k.x - c.x, k.y - c.y) < dedupPx)) continue;
    kept.push(c);
  }
  _suggestionCache = { key, value: kept };
  return kept;
}
// "Reverse" algorithm: search over auto-deploy points G in the ring/disk
// around the target where (terrain(G) + 100) gives enough altitude to glide to T.
// For each (J on bus, G in disk), compute freefall J→G and glide G→T using
// constant-magnitude path-length formulas. Pick min total time.
function _computeOptimal(busStart, busEnd, target, targetZ = 0) {
  const s = state.settings;
  const TG = terrainAltAt(target.x, target.y) + targetZ;
  if (s.busAlt - TG <= s.deployAlt) return { reachable: false, groundAlt: TG };
  const SG = Math.hypot(s.glideH, s.glideV); // glide total speed (~25.3 m/s)
  const GR_MAX = s.glideH / s.glideV;        // max glide ratio (3.0)
  // Continuous freefall envelope: V_v as a function of trajectory ratio H/A.
  // Anchor points along the body-angle envelope (ratio, V_v):
  //   (0,    55) head-down dive        — target directly below
  //   (0.2,  50) steep dive            — small horizontal needed
  //   (0.41, 32) skydive (normal pose)
  //   (1.5,  18) forward dive          — body angled, max horizontal
  // Linearly interpolated between anchors. Above 1.5 → infeasible.
  function fallSpeedForRatio(r) {
    if (r < 0) r = 0;
    if (r <= 0.2)  return 55 + (50 - 55) * (r / 0.2);
    if (r <= 0.41) return 50 + (32 - 50) * (r - 0.2) / 0.21;
    if (r <= 1.5)  return 32 + (18 - 32) * (r - 0.41) / 1.09;
    return 0;
  }
  // Label thresholds in trajectory angle from vertical (atan(ratio)):
  //   <5°    Head-down dive (straight down)
  //   5–15°  Steep dive
  //   15–30° Skydive
  //   >30°   Forward dive
  function fallModeForRatio(r) {
    if (r < 0.087) return { name: 'Head-down dive', label: 'straight down' };
    if (r < 0.268) return { name: 'Steep dive',     label: 'head-first' };
    if (r < 0.577) return { name: 'Skydive',        label: 'normal pose' };
    return         { name: 'Forward dive',          label: 'body angled' };
  }
  const N_J = 160, N_DIR = 32, N_R = 6;
  const stepM = 10;
  const stepPx = mToPx(stepM);
  // Cap search at the physical maximum auto-deploy reach so bus mode is
  // independent of the ring-mode slider. Max glide horizontal = busAlt * GR_MAX
  // is a safe upper bound; auto-deploy disk can't exceed that.
  const ringMaxPx = mToPx(s.busAlt * GR_MAX);
  // Precompute the auto-deploy ring boundary for each direction.
  const ringEdges = new Array(N_DIR);
  for (let d = 0; d < N_DIR; d++) {
    const theta = (d / N_DIR) * Math.PI * 2;
    const dx = Math.cos(theta), dy = Math.sin(theta);
    let edge = 0;
    for (let r = stepPx; r <= ringMaxPx; r += stepPx) {
      const local = terrainAltAt(target.x + dx * r, target.y + dy * r);
      const vBudget = local + s.deployAlt - TG;
      if (vBudget <= 0) break;
      if (vBudget * GR_MAX >= pxToM(r)) edge = r;
      else break;
    }
    ringEdges[d] = { dx, dy, edge };
  }
  let best = null;
  // Evaluate a single auto-deploy candidate G for a given jump-out point J.
  function tryCandidate(J, tBus, Gx, Gy) {
    const Gterrain = terrainAltAt(Gx, Gy);
    const Galt = Gterrain + s.deployAlt;
    if (Galt >= s.busAlt) return;
    const altDrop = s.busAlt - Galt;
    if (altDrop <= 0) return;
    const horizF_m = pxToM(Math.hypot(Gx - J.x, Gy - J.y));
    const ratio = horizF_m / altDrop;
    const Vv = fallSpeedForRatio(ratio);
    if (Vv <= 0) return; // ratio > 1.5 — can't cover this horizontal in freefall
    const tF = altDrop / Vv;
    const mode = fallModeForRatio(ratio);
    const angleF = Math.atan(ratio);
    // Verify freefall path doesn't hit terrain mid-air.
    let peak = Gterrain;
    const STEPS = 12;
    for (let p = 1; p < STEPS; p++) {
      const f = p / STEPS;
      const tx = J.x + (Gx - J.x) * f;
      const ty = J.y + (Gy - J.y) * f;
      const tAlt = s.busAlt - altDrop * f;
      const tTerr = terrainAltAt(tx, ty);
      if (tTerr > peak) peak = tTerr;
      if (tAlt < tTerr + s.deployAlt) return; // would force earlier auto-deploy
    }
    const horizG_m = pxToM(Math.hypot(target.x - Gx, target.y - Gy));
    const altRem = Galt - TG;
    if (altRem <= 0) return;
    if (horizG_m > altRem * GR_MAX + 0.5) return;
    const tG = altRem / s.glideV;
    const total = tBus + tF + tG;
    if (!best || total < best.total) {
      best = {
        reachable: true, total, tBus,
        tFall: tF, tGlide: tG,
        dFall: horizF_m, dGlide: horizG_m,
        J, G: { x: Gx, y: Gy },
        deployAlt: Galt, deployMode: 'auto',
        fallAngle: angleF, fallMode: mode.name, fallModeLabel: mode.label,
        terrainPeak: peak, groundAlt: TG,
      };
    }
  }
  // Always evaluate the bus point closest to the target (foot of perpendicular).
  // This is the J where head-down dive can apply when the target lies under the
  // bus path — uniform sampling almost always misses this exact point.
  {
    const bdx = busEnd.x - busStart.x;
    const bdy = busEnd.y - busStart.y;
    const blen2 = bdx * bdx + bdy * bdy;
    if (blen2 > 1) {
      let up = ((target.x - busStart.x) * bdx + (target.y - busStart.y) * bdy) / blen2;
      up = Math.max(0, Math.min(1, up));
      const J = { x: busStart.x + up * bdx, y: busStart.y + up * bdy };
      const tBus = pxToM(Math.hypot(J.x - busStart.x, J.y - busStart.y)) / s.busSpeed;
      tryCandidate(J, tBus, target.x, target.y);
    }
  }
  for (let i = 0; i <= N_J; i++) {
    const u = i / N_J;
    const J = {
      x: busStart.x + u * (busEnd.x - busStart.x),
      y: busStart.y + u * (busEnd.y - busStart.y),
    };
    const tBus = pxToM(Math.hypot(J.x - busStart.x, J.y - busStart.y)) / s.busSpeed;
    // r = 0: deploy directly at the target. This is the only candidate where
    // head-down dive applies (J→G ratio = 0 only when J is directly above T).
    tryCandidate(J, tBus, target.x, target.y);
    for (let d = 0; d < N_DIR; d++) {
      const { dx, dy, edge } = ringEdges[d];
      if (edge <= 0) continue;
      for (let k = 1; k <= N_R; k++) {
        const r = (k / N_R) * edge;
        tryCandidate(J, tBus, target.x + dx * r, target.y + dy * r);
      }
    }
  }
  // Manual-deploy fallback if no auto-deploy solution exists.
  if (!best) {
    for (let i = 0; i <= N_J; i++) {
      const u = i / N_J;
      const J = {
        x: busStart.x + u * (busEnd.x - busStart.x),
        y: busStart.y + u * (busEnd.y - busStart.y),
      };
      const r = manualDeploy(J, target, TG);
      if (!r) continue;
      const tBus = pxToM(Math.hypot(J.x - busStart.x, J.y - busStart.y)) / s.busSpeed;
      const total = tBus + r.tFall + r.tGlide;
      if (!best || total < best.total) {
        best = { reachable: true, total, tBus, groundAlt: TG, J, ...r };
      }
    }
  }
  return best || { reachable: false, groundAlt: TG };
}
// --- Hit-test ---
function hitTest(sx, sy) {
  // Returns { kind, ... } in priority order: bus handles → pins → suggestion ghosts
  const m = screenToMap(sx, sy);
  const tol = HIT_PX / state.view.scale;
  if (state.busStart) {
    if (distMap(m, state.busStart) < (HANDLE_R + 2) / state.view.scale)
      return { kind: 'busStart' };
  }
  if (state.busEnd) {
    if (distMap(m, state.busEnd) < (HANDLE_R + 2) / state.view.scale)
      return { kind: 'busEnd' };
  }
  for (let i = state.pins.length - 1; i >= 0; i--) {
    const p = state.pins[i];
    if (distMap(m, p) < tol) return { kind: 'pin', id: p.id };
  }
  for (const sug of runtime.suggestions) {
    if (distMap(m, sug) < tol) return { kind: 'ghost', sug };
  }
  return null;
}
// --- Render ---
function render() {
  const w = canvas._cssW || canvas.width;
  const h = canvas._cssH || canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!runtime.mapImage) return;
  // Map image (transformed)
  ctx.save();
  ctx.translate(state.view.x, state.view.y);
  ctx.scale(state.view.scale, state.view.scale);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(runtime.mapImage, 0, 0);
  ctx.restore();
  // Compute the local-search suggestions up-front so both the ghost markers
  // and the popup banner can use the same set without re-running.
  runtime.suggestions = computeCurrentSuggestions();
  // Overlays in screen space
  drawBus();
  drawRing();
  drawTrajectory();
  drawPins();
  drawSuggestionGhosts();
  updatePinPopup();
}

function computeCurrentSuggestions() {
  if (state.mode !== 'bus') return [];
  if (!state.busStart || !state.busEnd) return [];
  if (runtime.drag !== null) return [];
  const target = selectedPin();
  if (!target) return [];
  const res = computeOptimal(state.busStart, state.busEnd, target, target.z || 0);
  if (!res.reachable) return [];
  return findBetterSpotsNearby(state.busStart, state.busEnd, target, res.total);
}

function drawSuggestionGhosts() {
  if (!runtime.suggestions.length) return;
  const target = selectedPin();
  if (!target) return;
  const t = mapToScreen(target.x, target.y);
  for (const sug of runtime.suggestions) {
    const g = mapToScreen(sug.x, sug.y);
    // Dashed connector from current pin to suggested spot
    ctx.strokeStyle = 'rgba(255,216,74,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(t.x, t.y);
    ctx.lineTo(g.x, g.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // Ghost pin: translucent, with a yellow outline
    ctx.fillStyle = 'rgba(217,107,26,0.4)';
    ctx.strokeStyle = '#ffd84a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(g.x, g.y, PIN_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Savings label
    const txt = `−${sug.savings.toFixed(1)}s`;
    ctx.font = 'bold 11px ui-monospace, monospace';
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(g.x + 12, g.y - 8, tw + 8, 16);
    ctx.fillStyle = '#ffd84a';
    ctx.fillText(txt, g.x + 16, g.y + 4);
  }
}
// Pin the popup to the top-left corner of the map area. Avoids overlapping
// the toolbar, hint banner, cursor altitude readout, pins panel, or the
// trajectory visualization itself.
function positionPopup(popup) {
  popup.style.left = '12px';
  popup.style.top = '12px';
}

function updatePinPopup() {
  const popup = $('pin-popup');
  const target = selectedPin();
  if (!target) { popup.classList.add('hidden'); return; }
  popup.classList.remove('hidden');
  if (state.mode === 'bus') {
    if (!state.busStart || !state.busEnd) { popup.classList.add('hidden'); return; }
    const res = computeOptimal(state.busStart, state.busEnd, target, target.z || 0);
    if (!res.reachable) {
      popup.innerHTML = `
        <div class="title">${escapeHtml(target.name)}</div>
        <div class="row"><span class="k">Ground</span><span class="v">${res.groundAlt.toFixed(0)} m</span></div>
        <div class="row"><span class="v bad">UNREACHABLE</span></div>`;
      positionPopup(popup);
      return;
    }
    const D = distM(res.J, target);
    const peak = res.terrainPeak != null ? res.terrainPeak.toFixed(0) : '?';
    const s = state.settings;
    const isManual = res.deployMode === 'manual';
    const deployLabel = isManual ? 'Manual deploy' : 'Auto deploy';
    const deployValClass = isManual ? 'v good' : 'v';
    const angleDeg = res.fallAngle != null ? (res.fallAngle * 180 / Math.PI).toFixed(0) : '?';
    const modeName = res.fallMode || 'Skydive';
    const modeLabel = res.fallModeLabel || '';
    let suggestionHtml = '';
    const sugCount = runtime.suggestions.length;
    if (sugCount > 0) {
      const bestSavings = runtime.suggestions[0].savings.toFixed(1);
      suggestionHtml = `<div class="suggest">
        💡 ${sugCount} better spot${sugCount === 1 ? '' : 's'} (best: −${bestSavings}s) — click any ghost on the map</div>`;
    }
    popup.innerHTML = `
      <div class="title">${escapeHtml(target.name)}</div>
      <div class="row"><span class="k">Ground</span><span class="v">${res.groundAlt.toFixed(0)} m</span></div>
      <div class="row"><span class="k">Pose</span><span class="v">${modeName}${modeLabel ? ' ('+modeLabel+')' : ''}</span></div>
      <div class="row"><span class="k">Dive angle</span><span class="v">${angleDeg}° from vertical</span></div>
      <div class="row"><span class="k">${deployLabel}</span><span class="${deployValClass}">${res.deployAlt.toFixed(0)} m</span></div>
      <div class="row"><span class="k">Slant from bus</span><span class="v">${Math.hypot(D, s.busAlt - res.groundAlt).toFixed(0)} m</span></div>
      <div class="row"><span class="k">Slant from deploy</span><span class="v">${Math.hypot(res.dGlide, res.deployAlt - res.groundAlt).toFixed(0)} m</span></div>
      <div class="row"><span class="k">Bus</span><span class="v">${res.tBus.toFixed(1)}s</span></div>
      <div class="row"><span class="k">Falling</span><span class="v">${res.tFall.toFixed(1)}s</span></div>
      <div class="row"><span class="k">Gliding</span><span class="v">${res.tGlide.toFixed(1)}s</span></div>
      <div class="row"><span class="k">Total</span><span class="v good">${res.total.toFixed(1)}s</span></div>
      <details class="extra">
        <summary>Extra</summary>
        <div class="row"><span class="k">Path peak</span><span class="v">${peak} m</span></div>
        <div class="row"><span class="k">Distance</span><span class="v">${D.toFixed(0)} m</span></div>
        <div class="row"><span class="k">Freefall ⇣</span><span class="v">${res.dFall.toFixed(0)} m</span></div>
        <div class="row"><span class="k">Glide →</span><span class="v">${res.dGlide.toFixed(0)} m</span></div>
      </details>
      ${suggestionHtml}`;
  } else {
    // Ring mode: show terrain at center + auto-deploy reachable area.
    // Auto-deploy fires at (local terrain + 100 m) above the deploy point's
    // ground — there's no absolute altitude limit. The hull is empty only
    // when surrounding terrain is too low to deploy above the target's
    // altitude (vBudget ≤ 0 in every direction).
    const ground = terrainAltAt(target.x, target.y) + (target.z || 0);
    const hull = computeReachableHull(target);
    const maxR = pxToM(hull.reduce((m, p) => Math.max(m, p.r), 0));
    if (maxR < 1) {
      popup.innerHTML = `
        <div class="title">${escapeHtml(target.name)}</div>
        <div class="row"><span class="k">Ground</span><span class="v">${ground.toFixed(0)} m</span></div>
        <div class="row"><span class="v bad">No surrounding terrain high enough to glide here</span></div>`;
    } else {
      popup.innerHTML = `
        <div class="title">${escapeHtml(target.name)}</div>
        <div class="row"><span class="k">Ground</span><span class="v">${ground.toFixed(0)} m</span></div>
        <div class="row"><span class="k">Reach</span><span class="v">${maxR.toFixed(0)} m</span></div>`;
    }
  }
  positionPopup(popup);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function drawBus() {
  if (!state.busStart || !state.busEnd) return;
  const a = mapToScreen(state.busStart.x, state.busStart.y);
  const b = mapToScreen(state.busEnd.x, state.busEnd.y);
  // Line
  ctx.strokeStyle = '#ffd84a';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  // Endpoints
  ctx.fillStyle = '#ffd84a';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  for (const p of [a, b]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  // Arrow at end
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  ctx.fillStyle = '#ffd84a';
  ctx.beginPath();
  ctx.moveTo(b.x + Math.cos(ang) * 14, b.y + Math.sin(ang) * 14);
  ctx.lineTo(b.x + Math.cos(ang + 2.5) * 14, b.y + Math.sin(ang + 2.5) * 14);
  ctx.lineTo(b.x + Math.cos(ang - 2.5) * 14, b.y + Math.sin(ang - 2.5) * 14);
  ctx.closePath();
  ctx.fill();
}
function drawRing() {
  if (state.mode !== 'ring') return;
  const center = selectedPin();
  if (!center) return;
  const hull = computeReachableHull(center);
  const maxR = hull.reduce((m, p) => Math.max(m, p.r), 0);
  const cs = mapToScreen(center.x, center.y);
  if (maxR > 0) {
    ctx.beginPath();
    hull.forEach((p, i) => {
      const s = mapToScreen(p.x, p.y);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(108,214,108,0.18)';
    ctx.strokeStyle = '#6cd66c';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }
  // Center marker
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cs.x - 8, cs.y); ctx.lineTo(cs.x + 8, cs.y);
  ctx.moveTo(cs.x, cs.y - 8); ctx.lineTo(cs.x, cs.y + 8);
  ctx.stroke();
  // Search-radius circle for reference (faint)
  const rPx = mToPx(RING_SEARCH_MAX_M) * state.view.scale;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(cs.x, cs.y, rPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}
function drawTrajectory() {
  if (state.mode !== 'bus') return;
  if (!state.busStart || !state.busEnd) return;
  const target = selectedPin();
  if (!target) return;
  const res = computeOptimal(state.busStart, state.busEnd, target, target.z || 0);
  if (!res.reachable) return;
  const J = mapToScreen(res.J.x, res.J.y);
  const G = mapToScreen(res.G.x, res.G.y);
  const T = mapToScreen(target.x, target.y);
  // Freefall: J → G (red dashed)
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(J.x, J.y);
  ctx.lineTo(G.x, G.y);
  ctx.stroke();
  ctx.setLineDash([]);
  // Glide: G → T (green solid)
  ctx.strokeStyle = '#4ade80';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(G.x, G.y);
  ctx.lineTo(T.x, T.y);
  ctx.stroke();
  // Jump point (J)
  drawLabel(J, 'J', '#6cd66c');
  // Glider deploy (G)
  drawLabel(G, 'G', '#4ade80');
}
function drawLabel(p, txt, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#000';
  ctx.font = 'bold 11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(txt, p.x, p.y + 1);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}
function drawPins() {
  for (const p of state.pins) {
    const s = mapToScreen(p.x, p.y);
    const isSelected = p.id === state.selectedPinId;
    ctx.fillStyle = p.color || PIN_COLORS[0];
    ctx.strokeStyle = isSelected ? '#fff' : '#000';
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, PIN_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (p.name) {
      ctx.font = '12px ui-monospace, monospace';
      const tw = ctx.measureText(p.name).width;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(s.x + 12, s.y - 8, tw + 8, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(p.name, s.x + 16, s.y + 4);
    }
  }
}
// --- Selection helpers ---
function selectedPin() {
  return state.pins.find(p => p.id === state.selectedPinId) || null;
}
function newPinId() {
  return Math.random().toString(36).slice(2, 9);
}
function addPin(mp) {
  const idx = state.pins.length;
  state.pins.push({
    id: newPinId(),
    x: mp.x, y: mp.y, z: 0,
    name: 'Pin ' + (idx + 1),
    color: PIN_COLORS[idx % PIN_COLORS.length],
  });
}
function deletePin(id) {
  state.pins = state.pins.filter(p => p.id !== id);
  if (state.selectedPinId === id) state.selectedPinId = null;
}
// --- Input ---
canvas.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const sx = e.offsetX, sy = e.offsetY;
  runtime.mouseDown = { sx, sy, moved: false };
  // Drawing bus: clicks set endpoints, no drag
  if (runtime.drawBusMode) return;
  const hit = hitTest(sx, sy);
  if (hit?.kind === 'busStart') {
    runtime.drag = { kind: 'busStart' };
  } else if (hit?.kind === 'busEnd') {
    runtime.drag = { kind: 'busEnd' };
  } else if (hit?.kind === 'pin') {
    // pin click handled on mouseup
    runtime.drag = { kind: 'maybePin', id: hit.id, shift: e.shiftKey };
  } else if (hit?.kind === 'ghost') {
    // ghost click handled on mouseup — snap target there
    runtime.drag = { kind: 'maybeGhost', sug: hit.sug };
  } else {
    runtime.drag = { kind: 'pan', startView: { ...state.view }, startScreen: { x: sx, y: sy } };
  }
});
canvas.addEventListener('mousemove', e => {
  const sx = e.offsetX, sy = e.offsetY;
  // Cursor-altitude readout (debug aid)
  if (runtime.heightmap && runtime.mapImage) {
    const m = screenToMap(sx, sy);
    if (m.x >= 0 && m.x < runtime.mapImage.width &&
        m.y >= 0 && m.y < runtime.mapImage.height) {
      const alt = terrainAltAt(m.x, m.y);
      const el = $('cursor-alt');
      el.textContent = `terrain: ${alt.toFixed(1)} m`;
      el.classList.remove('hidden');
    }
  }
  updateTrajectoryTip(sx, sy);
  if (runtime.mouseDown) {
    const dx = sx - runtime.mouseDown.sx, dy = sy - runtime.mouseDown.sy;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD) runtime.mouseDown.moved = true;
  }
  if (!runtime.drag) return;
  const d = runtime.drag;
  if (d.kind === 'pan') {
    if (!runtime.mouseDown.moved) return;
    canvas.classList.add('panning');
    state.view.x = d.startView.x + (sx - d.startScreen.x);
    state.view.y = d.startView.y + (sy - d.startScreen.y);
    render();
  } else if (d.kind === 'busStart' || d.kind === 'busEnd') {
    if (!runtime.mouseDown.moved) return;
    const m = screenToMap(sx, sy);
    if (d.kind === 'busStart') state.busStart = m;
    else state.busEnd = m;
    render();
  } else if (d.kind === 'maybePin') {
    if (!runtime.mouseDown.moved) return;
    d.kind = 'pin';
    state.selectedPinId = d.id;
    const pin = state.pins.find(p => p.id === d.id);
    if (pin) {
      const m = screenToMap(sx, sy);
      pin.x = m.x; pin.y = m.y;
      render();
    }
  } else if (d.kind === 'pin') {
    const pin = state.pins.find(p => p.id === d.id);
    if (pin) {
      const m = screenToMap(sx, sy);
      pin.x = m.x; pin.y = m.y;
      render();
    }
  }
});
canvas.addEventListener('mouseup', e => {
  if (e.button !== 0) return;
  const sx = e.offsetX, sy = e.offsetY;
  const md = runtime.mouseDown;
  const drag = runtime.drag;
  runtime.mouseDown = null;
  runtime.drag = null;
  canvas.classList.remove('panning');
  // Bus draw mode: clicks set endpoints
  if (runtime.drawBusMode && (!md || !md.moved)) {
    const m = screenToMap(sx, sy);
    if (!runtime.drawBusFirst) {
      runtime.drawBusFirst = m;
      updateHint();
    } else {
      state.busStart = runtime.drawBusFirst;
      state.busEnd = m;
      runtime.drawBusFirst = null;
      runtime.drawBusMode = false;
      canvas.classList.remove('draw-bus');
      updateHint();
      persist();
    }
    render();
    return;
  }
  if (!drag || !md) return;
  // Click (no significant movement)
  if (!md.moved) {
    if (drag.kind === 'maybePin') {
      if (drag.shift) deletePin(drag.id);
      else state.selectedPinId = drag.id;
      renderPinList();
    } else if (drag.kind === 'maybeGhost') {
      // Snap selected target to the chosen ghost suggestion
      const target = selectedPin();
      if (target) {
        target.x = drag.sug.x;
        target.y = drag.sug.y;
        _suggestionCache = null;
      }
    }
    // Empty-area single click is intentionally a no-op (use double-click to
    // add a pin) so accidental clicks don't drop random points.
  }
  persist();
  render();
  updateHint();
});
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && runtime.drawBusMode) cancelBusDraw();
});
// Double-click on empty map to add a pin. Single-click is a no-op so that
// stray clicks don't litter the map.
canvas.addEventListener('dblclick', e => {
  const sx = e.offsetX, sy = e.offsetY;
  // Don't add a pin on top of an existing pin / bus handle / ghost.
  if (hitTest(sx, sy)) return;
  const map = runtime.mapImage;
  if (!map) return;
  const m = screenToMap(sx, sy);
  // Only allow drops within the actual map image bounds.
  if (m.x < 0 || m.y < 0 || m.x >= map.width || m.y >= map.height) return;
  addPin(m);
  state.selectedPinId = state.pins[state.pins.length - 1].id;
  renderPinList();
  render();
  persist();
  updateHint();
});

canvas.addEventListener('mouseleave', () => {
  $('cursor-alt').classList.add('hidden');
  $('trajectory-tip').classList.add('hidden');
});

// While the cursor is near the freefall (J→G) or glide (G→T) segment, show
// the slant distance from that point to the target — i.e., what the in-game
// marker should read at this point during the drop. Lets you calibrate
// mid-air against the trajectory the optimizer chose.
function updateTrajectoryTip(sx, sy) {
  const tip = $('trajectory-tip');
  if (state.mode !== 'bus' || !state.busStart || !state.busEnd) {
    tip.classList.add('hidden'); return;
  }
  const target = selectedPin();
  if (!target) { tip.classList.add('hidden'); return; }
  const res = computeOptimal(state.busStart, state.busEnd, target, target.z || 0);
  if (!res.reachable) { tip.classList.add('hidden'); return; }

  const Jp = mapToScreen(res.J.x, res.J.y);
  const Gp = mapToScreen(res.G.x, res.G.y);
  const Tp = mapToScreen(target.x, target.y);
  const fall = projectOntoSegment(sx, sy, Jp, Gp);
  const glide = projectOntoSegment(sx, sy, Gp, Tp);
  const HOVER_PX = 10;
  const onFall  = fall.dist  <= HOVER_PX;
  const onGlide = glide.dist <= HOVER_PX;
  if (!onFall && !onGlide) { tip.classList.add('hidden'); return; }

  // Pick the closer line.
  const useFall = onFall && (!onGlide || fall.dist <= glide.dist);
  const seg = useFall ? fall : glide;
  // Interpolate altitude along the chosen segment.
  const startAlt = useFall ? state.settings.busAlt : res.deployAlt;
  const endAlt   = useFall ? res.deployAlt        : res.groundAlt;
  const alt = startAlt + seg.t * (endAlt - startAlt);
  // Position on the segment in map coords.
  const sa = useFall ? res.J : res.G;
  const sb = useFall ? res.G : target;
  const px = sa.x + seg.t * (sb.x - sa.x);
  const py = sa.y + seg.t * (sb.y - sa.y);
  const horiz_m = pxToM(Math.hypot(target.x - px, target.y - py));
  const slant = Math.hypot(horiz_m, alt - res.groundAlt);

  tip.textContent = `to marker: ${slant.toFixed(0)} m  (alt ${alt.toFixed(0)} m)`;
  tip.style.left = sx + 'px';
  tip.style.top  = sy + 'px';
  tip.classList.remove('hidden');
}

// Project screen point p onto screen segment a-b, return distance from p to
// the projected point and the parameter t ∈ [0, 1] along the segment.
function projectOntoSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return { dist: Math.hypot(px - a.x, py - a.y), t: 0 };
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const sx = e.offsetX, sy = e.offsetY;
  const m = screenToMap(sx, sy);
  state.view.scale *= factor;
  state.view.scale = Math.max(0.1, Math.min(10, state.view.scale));
  state.view.x = sx - m.x * state.view.scale;
  state.view.y = sy - m.y * state.view.scale;
  render();
  persist();
}, { passive: false });
window.addEventListener('resize', () => {
  resizeCanvas();
  render();
});
// --- UI ---
function setMode(m) {
  state.mode = m;
  document.body.classList.toggle('mode-bus', m === 'bus');
  document.body.classList.toggle('mode-ring', m === 'ring');
  $('mode-bus').classList.toggle('active', m === 'bus');
  $('mode-ring').classList.toggle('active', m === 'ring');
  if (m === 'bus' && (!state.busStart || !state.busEnd) && runtime.mapImage) {
    startBusDraw();
  } else if (m !== 'bus' && runtime.drawBusMode) {
    cancelBusDraw();
  }
  render();
  updateHint();
  persist();
}
function showHint(msg) { const h = $('hint'); h.textContent = msg; h.classList.add('show'); }
function hideHint() { $('hint').classList.remove('show'); }
function updateHint() {
  if (runtime.drawBusMode) {
    showHint(runtime.drawBusFirst
      ? 'Click to set BUS END (Esc to cancel)'
      : 'Click to set BUS START (Esc to cancel)');
    return;
  }
  if (state.mode === 'bus') {
    if (!state.busStart || !state.busEnd) {
      showHint('Click "Redraw bus" to draw the bus path');
      return;
    }
    if (!state.selectedPinId) {
      showHint('Double-click the map to drop a pin, then click it to set as drop target');
      return;
    }
  } else if (state.mode === 'ring') {
    if (!state.selectedPinId) {
      showHint('Double-click the map to drop a pin, then click it to set as ring center');
      return;
    }
  }
  hideHint();
}
function startBusDraw() {
  runtime.drawBusMode = true;
  runtime.drawBusFirst = null;
  canvas.classList.add('draw-bus');
  updateHint();
}
function cancelBusDraw() {
  runtime.drawBusMode = false;
  runtime.drawBusFirst = null;
  canvas.classList.remove('draw-bus');
  updateHint();
}
function renderPinList() {
  const ul = $('pin-list');
  ul.innerHTML = '';
  state.pins.forEach(p => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    const input = document.createElement('input');
    input.value = p.name;
    input.addEventListener('change', () => { p.name = input.value; persist(); render(); });
    const alt = document.createElement('input');
    alt.type = 'number';
    alt.className = 'alt';
    alt.title = 'Target altitude (m above ground)';
    alt.value = p.z || 0;
    alt.step = 5;
    alt.addEventListener('input', () => {
      p.z = +alt.value || 0;
      persist(); render();
    });
    const sel = document.createElement('button');
    sel.textContent = state.selectedPinId === p.id ? '●' : '○';
    sel.title = 'Select';
    sel.addEventListener('click', () => {
      state.selectedPinId = p.id;
      renderPinList(); render(); persist();
    });
    const del = document.createElement('button');
    del.textContent = '×';
    del.className = 'del';
    del.addEventListener('click', () => {
      deletePin(p.id);
      renderPinList(); render(); persist();
    });
    li.append(dot, input, alt, sel, del);
    ul.append(li);
  });
}
// --- Wire up ---
$('mode-bus').addEventListener('click', () => setMode('bus'));
$('mode-ring').addEventListener('click', () => setMode('ring'));
$('redraw-bus').addEventListener('click', startBusDraw);
$('reverse-bus').addEventListener('click', () => {
  if (!state.busStart || !state.busEnd) return;
  const tmp = state.busStart;
  state.busStart = state.busEnd;
  state.busEnd = tmp;
  _optimalCache = null;
  _suggestionCache = null;
  render(); persist();
});
$('clear-bus').addEventListener('click', () => {
  state.busStart = null;
  state.busEnd = null;
  if (state.mode === 'bus') startBusDraw();
  render(); persist(); updateHint();
});
$('toggle-pins').addEventListener('click', () => {
  $('pin-panel').classList.toggle('hidden');
});
$('fit-map').addEventListener('click', () => { fitMap(); render(); persist(); });
$('reset-all').addEventListener('click', () => {
  state.pins = [];
  state.busStart = null;
  state.busEnd = null;
  state.selectedPinId = null;
  runtime.drawBusMode = false;
  runtime.drawBusFirst = null;
  canvas.classList.remove('draw-bus');
  localStorage.removeItem(STORAGE_KEY);
  renderPinList();
  fitMap();
  if (state.mode === 'bus') startBusDraw();
  render();
  updateHint();
});
$('import-pois').addEventListener('click', importPois);
function importPois() {
  if (!runtime.embencoPois || !runtime.mapImage) return;
  const map = runtime.mapImage;
  let added = 0;
  runtime.embencoPois.forEach((p, i) => {
    const x = p.coord[0] * map.width;
    const y = p.coord[1] * map.height;
    // Skip if a pin with same name already exists
    if (state.pins.some(q => q.name === p.name)) return;
    state.pins.push({
      id: newPinId(),
      x, y, z: 0,
      name: p.name,
      color: PIN_COLORS[(state.pins.length + i) % PIN_COLORS.length],
    });
    added++;
  });
  renderPinList();
  render();
  persist();
  showHint(`Imported ${added} POI${added === 1 ? '' : 's'}`);
  setTimeout(() => updateHint(), 1500);
}
// --- Init ---
restore();
setMode(state.mode);
renderPinList();
resizeCanvas();
Promise.all([loadMap(), loadHeightmap(), loadLocations()]).then(() => {
  if (state.view.scale === 1 && state.view.x === 0 && state.view.y === 0) {
    fitMap();
  }
  if (state.mode === 'bus' && (!state.busStart || !state.busEnd)) {
    startBusDraw();
  }
  render();
  updateHint();
});
