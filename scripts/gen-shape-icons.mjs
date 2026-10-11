// Shape icons. Run: node scripts/gen-shape-icons.mjs
//
// Writes src/assets/shape-icons/<ShapeType>.svg (+ group, imageAdd, text) and the
// shaded src/assets/op-icons/*.svg. Model space is 2D screen space (y down); 3D solids go
// through an orthographic projection first. Every icon is fit into a 24×24 box
// and used as a CSS mask (MaskIcon), so white + element opacity = tone.
// A new ShapeType needs an entry in `icons` below (SHAPE_ICONS is typechecked).
import { writeFileSync, mkdirSync } from "node:fs";

const ICONS = new URL("../src/assets/shape-icons/", import.meta.url);
mkdirSync(ICONS, { recursive: true });

// Tones (element opacity): lit, shade, ghost (removed / hidden parts).
const S = 1, M = 0.5, G = 0.28;
const GAP = 1.15; // px in the 24 grid
const PAD = 2;

const TAU = Math.PI * 2;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };

// ── 2D primitives (closed rings / open polylines as point arrays) ────────────
function arc(cx, cy, rx, ry, a0, a1, n = 72) {
  const steps = Math.max(6, Math.ceil((n * Math.abs(a1 - a0)) / TAU));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}
const ellipse = (cx, cy, rx, ry) => arc(cx, cy, rx, ry, 0, TAU).slice(0, -1);
const circle = (cx, cy, r) => ellipse(cx, cy, r, r);
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
function stadium(cx, cy, w, h) {
  const r = w / 2;
  return [...arc(cx, cy - h / 2 + r, r, r, Math.PI, TAU), ...arc(cx, cy + h / 2 - r, r, r, 0, Math.PI)];
}
function roundRect(x0, y0, x1, y1, r) {
  return [
    ...arc(x1 - r, y0 + r, r, r, -Math.PI / 2, 0, 64),
    ...arc(x1 - r, y1 - r, r, r, 0, Math.PI / 2, 64),
    ...arc(x0 + r, y1 - r, r, r, Math.PI / 2, Math.PI, 64),
    ...arc(x0 + r, y0 + r, r, r, Math.PI, 1.5 * Math.PI, 64),
  ];
}
/** Copy of `ring` scaled about (ox, oy) and moved by (dx, dy). */
const move = (ring, dx, dy, s = 1, ox = 0, oy = 0) =>
  ring.map(([x, y]) => [ox + (x - ox) * s + dx, oy + (y - oy) * s + dy]);

/** Round-solid shading: lit body plus a shade crescent towards the lower right. */
function volume(ring, cx, cy, shift = 0.12, shrink = 0.92, cut = []) {
  const lit = move(ring, -shift, -shift, shrink, cx, cy);
  return [
    { rings: [ring], tone: M, cut: [lit, ...cut] },
    { rings: [ring], tone: S, clip: [lit], cut },
  ];
}

// ── 3D: orthographic camera, yaw TH, pitch PH ────────────────────────────────
const TH = (30 * Math.PI) / 180;
const PH = (28 * Math.PI) / 180;
const P = ([x, y, z]) => {
  const d = x * Math.sin(TH) + z * Math.cos(TH);
  return [x * Math.cos(TH) - z * Math.sin(TH), -y * Math.cos(PH) + d * Math.sin(PH)];
};
const VIEW = [Math.sin(TH) * Math.cos(PH), Math.sin(PH), Math.cos(TH) * Math.cos(PH)];
const LIGHT = norm([-0.55, 0.85, 0.5]);

/** Visible faces with light-based tones; shared edges of visible faces become gaps. */
function polyhedron(verts, faces, { round = 0, lit = 0.25 } = {}) {
  const center = verts.reduce((a, v) => a.map((c, i) => c + v[i] / verts.length), [0, 0, 0]);
  const layers = [], gaps = [], visible = [];
  faces.forEach((f, fi) => {
    let n = norm(cross(sub(verts[f[1]], verts[f[0]]), sub(verts[f[2]], verts[f[0]])));
    const fc = f.reduce((a, i) => a.map((c, k) => c + verts[i][k] / f.length), [0, 0, 0]);
    if (dot(n, sub(fc, center)) < 0) n = n.map((v) => -v);
    visible[fi] = dot(n, VIEW) > 1e-6;
    if (visible[fi]) layers.push({ rings: [f.map((i) => P(verts[i]))], tone: dot(n, LIGHT) > lit ? S : M, round });
  });
  const seen = new Map();
  faces.forEach((f, fi) => f.forEach((a, k) => {
    const b = f[(k + 1) % f.length];
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) {
      if (visible[fi] && visible[seen.get(key)]) gaps.push([P(verts[a]), P(verts[b])]);
    } else seen.set(key, fi);
  }));
  return { layers, gaps };
}

function prism(poly, h, opts) {
  const n = poly.length;
  const verts = [...poly.map(([x, z]) => [x, h / 2, z]), ...poly.map(([x, z]) => [x, -h / 2, z])];
  const faces = [
    [...Array(n).keys()],
    [...Array(n).keys()].map((i) => n + i).reverse(),
    ...[...Array(n).keys()].map((i) => [i, (i + 1) % n, n + ((i + 1) % n), n + i]),
  ];
  return polyhedron(verts, faces, opts);
}
const ngon = (k, r, a0 = 0) => [...Array(k).keys()].map((i) => [r * Math.cos(a0 + (i * TAU) / k), r * Math.sin(a0 + (i * TAU) / k)]);
const CUBE_V = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
const CUBE_F = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 3, 7, 4], [1, 2, 6, 5]];

// ── Icons ────────────────────────────────────────────────────────────────────
const icons = {};

icons.sphere = () => ({ layers: volume(circle(0, 0, 1), 0, 0) });

icons.box = () => polyhedron(CUBE_V, CUBE_F);

icons.roundedBox = () => polyhedron(CUBE_V.map((v) => v.map((c) => c * 0.86)), CUBE_F, { round: 4.4 });

icons.boxFrame = () => {
  const center = [0, 0, 0];
  const vis = CUBE_F.map((f) => {
    let n = norm(cross(sub(CUBE_V[f[1]], CUBE_V[f[0]]), sub(CUBE_V[f[2]], CUBE_V[f[0]])));
    const fc = f.reduce((a, i) => a.map((c, k) => c + CUBE_V[i][k] / 4), [0, 0, 0]);
    if (dot(n, sub(fc, center)) < 0) n = n.map((v) => -v);
    return dot(n, VIEW) > 0;
  });
  const edges = new Map();
  CUBE_F.forEach((f, fi) => f.forEach((a, k) => {
    const b = f[(k + 1) % 4];
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    edges.set(key, (edges.get(key) ?? false) || vis[fi]);
  }));
  const hidden = [], shown = [];
  for (const [key, v] of edges) {
    const [a, b] = key.split("-").map(Number);
    (v ? shown : hidden).push({ line: [P(CUBE_V[a]), P(CUBE_V[b])], tone: v ? S : G, width: v ? 2.1 : 1.6 });
  }
  return { layers: [...hidden, ...shown] };
};

function cylinderParts(r, h, capInset = 0) {
  const ry = r * Math.sin(PH);
  const top = -h / 2, bot = h / 2;
  const body = [[-r, top], [-r, bot], ...arc(0, bot, r, ry, Math.PI, 0), [r, bot], [r, top], ...arc(0, top, r, ry, 0, Math.PI)];
  const cap = ellipse(0, top, r, ry);
  const split = rect(-5, -5, 0.28 * r, 5);
  const layers = [
    { rings: [body], tone: S, clip: [split] },
    { rings: [body], tone: M, cut: [split] },
  ];
  if (capInset) {
    const inner = ellipse(0, top, r - capInset, ry - capInset * 0.5);
    layers.push({ rings: [cap, inner], tone: M }, { rings: [inner], tone: S });
  } else layers.push({ rings: [cap], tone: S });
  return { layers, gaps: [arc(0, top, r, ry, 0, Math.PI)] };
}
icons.cylinder = () => cylinderParts(1, 1.7);
icons.roundedCylinder = () => cylinderParts(1, 1.05, 0.22);

icons.capsule = () => ({ layers: volume(stadium(0, 0, 1.25, 2.5), 0, 0, 0.1, 0.92) });

icons.cone = () => {
  const apex = [0, -1.25], cy = 0.75, ry = Math.sin(PH);
  const t = Math.asin(-ry / (cy - apex[1])); // tangent from apex to the base ellipse
  const ring = [apex, ...arc(0, cy, 1, ry, t, Math.PI - t)];
  const split = [[-5, -5], [apex[0] - 0.22, -5], [0.62, 5], [-5, 5]];
  return { layers: [{ rings: [ring], tone: S, clip: [split] }, { rings: [ring], tone: M, cut: [split] }] };
};

icons.roundCone = () => {
  const c1 = [0, 0.55], r1 = 0.85, c2 = [0, -0.95], r2 = 0.36;
  const b = Math.asin((r1 - r2) / Math.hypot(c1[0] - c2[0], c1[1] - c2[1]));
  const ring = [...arc(c2[0], c2[1], r2, r2, -b, -Math.PI + b), ...arc(c1[0], c1[1], r1, r1, Math.PI + b, -b)];
  return { layers: volume(ring, 0, 0.1, 0.09, 0.93) };
};

/** Lit ring with a shade crescent outside and the far inner wall showing through the hole. */
function shadedRing(outer, hole, wall, lit) {
  return [
    { rings: [outer, hole], tone: M, cut: [lit] },
    { rings: [outer, hole], tone: S, clip: [lit] },
    { rings: [hole], tone: M, cut: [wall] },
  ];
}

icons.torus = () => {
  const outer = ellipse(0, 0, 1, 0.56);
  const hole = ellipse(0, -0.04, 0.44, 0.2);
  return { layers: shadedRing(outer, hole, ellipse(0, 0.05, 0.42, 0.19), move(outer, -0.09, -0.07, 0.95)) };
};

function thickArc(R, h, a0, a1) {
  return [
    ...arc(0, 0, R + h, R + h, a0, a1),
    ...arc(R * Math.cos(a1), R * Math.sin(a1), h, h, a1, a1 + Math.PI, 48),
    ...arc(0, 0, R - h, R - h, a1, a0),
    ...arc(R * Math.cos(a0), R * Math.sin(a0), h, h, a0 + Math.PI, a0 + TAU, 48),
  ];
}
icons.cappedTorus = () => {
  const half = (125 * Math.PI) / 180, c = -Math.PI / 2;
  return {
    layers: [
      { rings: [thickArc(1, 0.25, c + half, c + TAU - half)], tone: G },
      ...volume(thickArc(1, 0.25, c - half, c + half), 0, 0, 0.07, 1),
    ],
  };
};

icons.link = () => {
  const rot = (r, a = (-38 * Math.PI) / 180) => r.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
  const outer = rot(stadium(0, 0, 1.3, 2.5)), hole = rot(stadium(0, 0, 0.56, 1.76));
  const wall = rot(stadium(0.1, 0.08, 0.56, 1.76));
  return { layers: shadedRing(outer, hole, wall, move(outer, -0.09, -0.09, 0.96)) };
};

icons.hexPrism = () => prism(ngon(6, 1, Math.PI / 6 - TH), 0.75);
icons.triPrism = () => {
  const tri = [[-1.1, -0.65], [1.1, -0.65], [0, 1.05]], z = 0.85;
  const verts = [...tri.map(([x, y]) => [x, y, z]), ...tri.map(([x, y]) => [x, y, -z])];
  const faces = [[0, 1, 2], [5, 4, 3], [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]];
  return polyhedron(verts, faces, { lit: 0.05 });
};
icons.rhombus = () => prism([[1.25, 0], [0, 0.7], [-1.25, 0], [0, -0.7]], 0.35, { round: 1.4 });

icons.octahedron = () => {
  const v = [[1, 0, 0], [-1, 0, 0], [0, 1.35, 0], [0, -1.35, 0], [0, 0, 1], [0, 0, -1]];
  const f = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [0, 3, 4], [4, 3, 1], [1, 3, 5], [5, 3, 0]];
  return polyhedron(v, f, { lit: 0.05 });
};

icons.pyramid = () => {
  const v = [[-1, -0.6, -1], [1, -0.6, -1], [1, -0.6, 1], [-1, -0.6, 1], [0, 1.0, 0]];
  const f = [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]];
  return polyhedron(v, f, { lit: 0.05 });
};

icons.solidAngle = () => {
  const half = (38 * Math.PI) / 180, c = -Math.PI / 2;
  const sector = [[0, 0], ...arc(0, 0, 1, 1, c - half, c + half)];
  return { layers: [{ rings: [circle(0, 0, 1)], tone: G * 0.8, cut: [sector] }, ...volume(sector, 0, -0.5, 0.07, 0.94)] };
};

function cutSphereParts(hollow) {
  const yc = -0.32, w = Math.sqrt(1 - yc * yc), a = Math.asin(yc);
  const body = arc(0, 0, 1, 1, a, Math.PI - a); // below the cut plane
  const face = ellipse(0, yc, w, w * Math.sin(PH));
  const lit = move(circle(0, 0, 1), -0.12, -0.12, 0.92);
  const layers = [
    { rings: [circle(0, 0, 1)], tone: G, cut: [body, face] },
    { rings: [body], tone: M, cut: [lit, face] },
    { rings: [body], tone: S, clip: [lit], cut: [face] },
  ];
  if (hollow) {
    const inner = ellipse(0, yc + 0.02, w - 0.17, (w - 0.17) * Math.sin(PH));
    layers.push({ rings: [face, inner], tone: S }, { rings: [inner], tone: M });
  } else layers.push({ rings: [face], tone: S });
  return { layers, gaps: [arc(0, yc, w, w * Math.sin(PH), 0, Math.PI)] };
}
icons.cutSphere = () => cutSphereParts(false);
icons.cutHollowSphere = () => cutSphereParts(true);

icons.deathStar = () => {
  const body = circle(0, 0, 1), bite = circle(0.68, -0.6, 0.62);
  return {
    layers: [
      ...volume(body, 0, 0, 0.12, 0.92, [bite]),
      { rings: [body], tone: M, clip: [bite] },
    ],
    gaps: [],
  };
};

icons.vesica = () => {
  const ring = [...arc(0.75, 0, 1.25, 1.25, 2.2143, 4.0689), ...arc(-0.75, 0, 1.25, 1.25, -0.9273, 0.9273)];
  return { layers: volume(ring, 0, 0, 0.08, 0.93) };
};

/** Terrain: a mountain range on a block, lit from the left. */
icons.terrain = () => {
  const ridge = [[-1.2, 0.25], [-0.75, -0.35], [-0.45, -0.1], [0.05, -0.85], [0.45, -0.25], [0.7, -0.45], [1.2, 0.25]];
  const block = [[-1.2, 0.25], [1.2, 0.25], [1.2, 0.75], [-1.2, 0.75]];
  const shade = [[0.05, -0.85], [0.45, -0.25], [0.7, -0.45], [1.2, 0.25], [0.2, 0.25]];
  return {
    layers: [
      { rings: [block], tone: M },
      { rings: [[...ridge]], tone: S, cut: [shade] },
      { rings: [shade], tone: 0.62, clip: [[...ridge]] },
    ],
    gaps: [[[-1.2, 0.25], [1.2, 0.25]]],
  };
};

/** Gyroid: a cube pierced by a lattice of round holes. */
icons.gyroid = () => {
  const cube = polyhedron(CUBE_V, CUBE_F);
  const holes = [];
  for (const [x, y] of [[-0.42, -0.2], [0.2, -0.42], [0.05, 0.25], [-0.55, 0.45], [0.62, 0.15]]) holes.push(circle(x, y, 0.2));
  return {
    layers: cube.layers.map((l) => ({ ...l, cut: [...(l.cut ?? []), ...holes] })),
    gaps: cube.gaps,
  };
};

/** Formula: a function curve over a shaded plate, f(x) as a solid. */
icons.formula = () => {
  const plate = roundRect(-1.1, -0.95, 1.1, 0.95, 0.22);
  const curve = [];
  for (let i = 0; i <= 40; i++) {
    const x = -0.85 + (1.7 * i) / 40;
    curve.push([x, 0.1 - 0.42 * Math.sin(x * 3.2) * Math.exp(-x * x * 0.6)]);
  }
  return {
    layers: [
      { rings: [plate], tone: G },
      { line: [[-0.85, 0.62], [0.85, 0.62]], width: 1.4, tone: M },
      { line: [[-0.85, -0.7], [-0.85, 0.62]], width: 1.4, tone: M },
      { line: curve, width: 2.6, tone: S },
    ],
  };
};

/** Convex hull (monotone chain) — the sweep of a convex face along its extrusion. */
function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts) => {
    const h = [];
    for (const q of pts) { while (h.length >= 2 && turn(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop(); h.push(q); }
    return h.slice(0, -1);
  };
  return [...half(p), ...half([...p].reverse())];
}

/** A picture plate extruded towards the lower right: front face, shaded side, ghost picture. */
function imagePlate(dx = 0, dy = 0, s = 1) {
  const T = (r) => r.map(([x, y]) => [x * s + dx, y * s + dy]);
  const front = T(roundRect(-1.1, -0.85, 1.0, 0.75, 0.26));
  const side = hull([...front, ...move(front, 0.17 * s, 0.17 * s)]);
  const hills = T([[-1.2, 0.9], [-0.38, -0.1], [0.06, 0.34], [0.42, 0.0], [1.1, 0.9]]);
  const sun = T(circle(0.4, -0.42, 0.19));
  return [
    { rings: [side], tone: M, cut: [front] },
    { rings: [front], tone: S, cut: [hills, sun] },
    { rings: [hills], tone: G, clip: [front] },
    { rings: [sun], tone: G },
  ];
}
icons.image = () => ({ layers: imagePlate() });

/** Sculpt stroke: a tapered tube swinging across, lit along its top edge. */
icons.stroke = () => {
  const spine = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    spine.push([-1.05 + 2.1 * t, 0.45 * Math.sin(t * Math.PI * 1.6 - 0.4), 0.12 + 0.22 * Math.sin(t * Math.PI)]);
  }
  const side = (sign) => spine.map(([x, y, r], i) => {
    const [x2, y2] = spine[Math.min(i + 1, spine.length - 1)];
    const [x0, y0] = spine[Math.max(i - 1, 0)];
    const dx = x2 - x0, dy = y2 - y0, l = Math.hypot(dx, dy) || 1;
    return [x - (dy / l) * r * sign, y + (dx / l) * r * sign];
  });
  const tube = [...side(1), ...side(-1).reverse()];
  const lit = [...side(1), ...spine.map(([x, y], i) => [x, y + 0.02]).reverse()];
  return {
    layers: [
      { rings: [tube], tone: M },
      { rings: [lit], tone: S, clip: [tube] },
    ],
  };
};

/** Text layer: a solid "T" extruded towards the lower right, like the image plate. */
icons.text = () => {
  const front = [[-1.05, -0.95], [0.95, -0.95], [0.95, -0.5], [0.2, -0.5], [0.2, 0.95], [-0.3, 0.95], [-0.3, -0.5], [-1.05, -0.5]];
  const steps = [0.04, 0.08, 0.12, 0.17].map((k) => move(front, k, k));
  return {
    layers: [
      { rings: steps, tone: M, cut: [front] },
      { rings: [front], tone: S },
    ],
  };
};

/** "Add image" action: the plate plus a round plus badge, split by a gap. */
icons.imageAdd = () => {
  const badge = circle(0.98, -0.78, 0.5);
  const bar = 0.075, len = 0.27;
  const plus = [rect(0.98 - len, -0.78 - bar, 0.98 + len, -0.78 + bar), rect(0.98 - bar, -0.78 - len, 0.98 + bar, -0.78 + len)];
  return {
    layers: [...imagePlate(-0.12, 0.12, 0.92), ...volume(badge, 0.98, -0.78, 0.06, 0.94, plus)],
    gaps: [[...circle(0.98, -0.78, 0.5 + 0.07), circle(0.98, -0.78, 0.57)[0]]],
  };
};

// ── Gizmo mode icons: the gizmo itself, in the same tones ───────────────────
// 2D axis directions (y up, x right-front, z left-front), front axes lit.
const GIZMO_AXES = [
  { d: [-0.76, 0.6], tone: M },
  { d: [0.88, 0.42], tone: S },
  { d: [0, -1], tone: S },
].map(({ d, tone }) => { const l = Math.hypot(...d); return { d: [d[0] / l, d[1] / l], tone }; });
const along = (d, t) => [d[0] * t, d[1] * t];
const perp = (d) => [-d[1], d[0]];

function arrowHead(tip, dir, length, half) {
  const base = [tip[0] - dir[0] * length, tip[1] - dir[1] * length], n = perp(dir);
  return [tip, [base[0] + n[0] * half, base[1] + n[1] * half], [base[0] - n[0] * half, base[1] - n[1] * half]];
}

function gizmoAxes(head) {
  const layers = [];
  for (const { d, tone } of GIZMO_AXES) {
    layers.push({ line: [[0, 0], along(d, 0.7)], width: 2.6, tone });
    layers.push({ rings: [head(d)], tone });
  }
  const hub = circle(0, 0, 0.17);
  return { layers: [...layers, { rings: [hub], tone: S }], gaps: [[...circle(0, 0, 0.25), circle(0, 0, 0.25)[0]]] };
}
icons.gizmoMove = () => gizmoAxes((d) => arrowHead(along(d, 1), d, 0.38, 0.21));
icons.gizmoScale = () =>
  gizmoAxes((d) => {
    const c = along(d, 0.86), n = perp(d), h = 0.15;
    return [[c[0] + (d[0] + n[0]) * h, c[1] + (d[1] + n[1]) * h], [c[0] + (d[0] - n[0]) * h, c[1] + (d[1] - n[1]) * h],
      [c[0] - (d[0] + n[0]) * h, c[1] - (d[1] + n[1]) * h], [c[0] - (d[0] - n[0]) * h, c[1] - (d[1] - n[1]) * h]];
  });
/** A ring tilted into the scene: far half shaded, near half lit and ending in an arrow. */
icons.gizmoRotate = () => {
  const rx = 1, ry = 0.44, end = 0.42;
  const at = (t) => [rx * Math.cos(t), ry * Math.sin(t)];
  const tip = at(end - 0.12);
  const dir = (() => { const a = at(end), b = at(end - 0.01); const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; })();
  return {
    layers: [
      { line: [[0, -0.95], [0, 0.95]], width: 1.6, tone: G },
      { line: arc(0, 0, rx, ry, Math.PI + 0.14, TAU - 0.14), width: 2.7, tone: M },
      { line: arc(0, 0, rx, ry, Math.PI, end), width: 2.7, tone: S },
      { rings: [arrowHead(along(dir, 0.16).map((v, i) => v + tip[i]), dir, 0.36, 0.24)], tone: S },
    ],
  };
};

// ── Render mode icons: the same sphere in two materials ─────────────────────
/** Matte: soft three-step falloff from the lit side to the shade side. */
icons.renderClassic = () => {
  const ball = circle(0, 0, 1);
  const core = move(ball, -0.2, -0.2, 0.8), mid = move(ball, -0.1, -0.1, 0.93);
  return {
    layers: [
      { rings: [ball], tone: 0.42, cut: [mid] },
      { rings: [mid], tone: 0.72, clip: [ball], cut: [core] },
      { rings: [core], tone: S },
    ],
  };
};

/** Neon: a dark ball with a burning rim and a faint halo around it. */
icons.renderNeon = () => {
  const halo = circle(0, 0, 1.2), ball = circle(0, 0, 0.98), inner = circle(-0.05, -0.05, 0.8);
  return {
    layers: [
      { rings: [halo], tone: G, cut: [ball] },
      { rings: [ball], tone: S, cut: [inner] },
      { rings: [inner], tone: 0.14 },
    ],
  };
};

/** Volume: a cloud of three puffs, lit from the upper left. */
icons.renderVolume = () => {
  const puffs = [circle(-0.5, 0.2, 0.5), circle(0.08, -0.18, 0.66), circle(0.6, 0.22, 0.46), roundRect(-1.0, 0.1, 1.06, 0.68, 0.28)];
  const lit = [move(puffs[0], -0.08, -0.1, 0.8, -0.5, 0.2), move(puffs[1], -0.1, -0.12, 0.8, 0.08, -0.18), move(puffs[2], -0.06, -0.08, 0.78, 0.6, 0.22)];
  return {
    layers: [
      { rings: puffs, tone: M, cut: lit },
      { rings: lit, tone: S, clip: puffs },
    ],
  };
};

/** Field: a solid core inside its distance isolines. */
icons.renderField = () => {
  const ringAt = (r, w) => [circle(0, 0, r + w), circle(0, 0, r - w)];
  const [a1, a0] = ringAt(0.68, 0.07), [b1, b0] = ringAt(0.95, 0.06), [c1, c0] = ringAt(1.2, 0.05);
  return {
    layers: [
      { rings: [circle(0, 0, 0.42)], tone: S },
      { rings: [a1], tone: 0.72, cut: [a0] },
      { rings: [b1], tone: M, cut: [b0] },
      { rings: [c1], tone: G, cut: [c0] },
    ],
  };
};

/** Cost: three bars, cheap to expensive. */
icons.renderCost = () => ({
  layers: [
    { rings: [roundRect(-1.0, 0.2, -0.45, 1.0, 0.12)], tone: G },
    { rings: [roundRect(-0.28, -0.3, 0.28, 1.0, 0.12)], tone: M },
    { rings: [roundRect(0.45, -1.0, 1.0, 1.0, 0.12)], tone: S },
  ],
});

/** Normals: a ball in three facing tones. */
icons.renderNormals = () => {
  const ball = circle(0, 0, 1);
  const top = [[-1.2, -1.2], [1.2, -1.2], [1.2, -0.1], [0, 0.1], [-1.2, -0.1]];
  const left = [[-1.2, -0.1], [0, 0.1], [0, 1.2], [-1.2, 1.2]];
  return {
    layers: [
      { rings: [ball], tone: S, clip: [top] },
      { rings: [ball], tone: 0.62, clip: [left] },
      { rings: [ball], tone: 0.34, cut: [top, left] },
    ],
  };
};

/** Mirror ball: sky above a bright horizon, dark ground below, a softbox highlight. */
icons.renderChrome = () => {
  const ball = circle(0, 0, 1);
  const curve = (dy) => arc(0, -0.55 + dy, 1.6, 0.8, Math.PI * 0.95, Math.PI * 0.05); // horizon bows down
  const sky = [[-1.6, -1.6], [1.6, -1.6], ...curve(0).reverse()].reverse();
  const below = [...curve(0.09), [1.6, 1.6], [-1.6, 1.6]];
  const softbox = roundRect(-0.62, -0.68, -0.12, -0.32, 0.12);
  const rim = move(ball, 0, -0.1, 0.95); // inside the ball below the horizon
  return {
    layers: [
      // Ground: dark, with reflected light along the bottom rim.
      { rings: [rim], tone: G, clip: [below] },
      { rings: [ball], tone: M, clip: [below], cut: [rim] },
      { rings: [ball], tone: S, cut: [sky, below] },
      { rings: [ball], tone: M, clip: [sky], cut: [softbox] },
      { rings: [softbox], tone: S },
    ],
  };
};

/** Studio: a lit ball resting on a floor with its soft shadow. */
icons.renderStudio = () => {
  const ball = circle(0, -0.25, 0.82);
  const core = move(ball, -0.18, -0.2, 0.78, 0, -0.25), mid = move(ball, -0.09, -0.1, 0.92, 0, -0.25);
  const shadow = ellipse(0.12, 0.78, 1.05, 0.22);
  const glint = circle(-0.32, -0.58, 0.16);
  return {
    layers: [
      { rings: [shadow], tone: G, cut: [ball] },
      { rings: [ball], tone: 0.42, cut: [mid] },
      { rings: [mid], tone: 0.72, clip: [ball], cut: [core] },
      { rings: [core], tone: S, cut: [glint] },
      { rings: [glint], tone: M },
    ],
  };
};

icons.group = () => {
  const cube = polyhedron(CUBE_V.map((v) => v.map((c) => c * 0.62)), CUBE_F);
  const shift = (r) => r.map(([x, y]) => [x + 0.62, y - 0.55]);
  const ball = circle(-0.42, 0.42, 0.78);
  return {
    layers: [
      ...cube.layers.map((l) => ({ ...l, tone: l.tone === S ? M : G, rings: l.rings.map(shift) })),
      ...volume(ball, -0.42, 0.42),
    ],
    gaps: [...cube.gaps.map(shift), [...ball, ball[0]]],
  };
};

// ── Emit ─────────────────────────────────────────────────────────────────────
const f2 = (v) => (Math.round(v * 100) / 100).toString();
const dRing = (r) => `M${r.map(([x, y]) => `${f2(x)} ${f2(y)}`).join("L")}Z`;
const dLine = (r) => `M${r.map(([x, y]) => `${f2(x)} ${f2(y)}`).join("L")}`;

function emit({ layers, gaps = [] }, pad = PAD) {
  const pts = layers.flatMap((l) => (l.line ? l.line : l.rings.flat()));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min((24 - 2 * pad) / (maxX - minX), (24 - 2 * pad) / (maxY - minY));
  const ox = 12 - ((minX + maxX) / 2) * s, oy = 12 - ((minY + maxY) / 2) * s;
  const T = (r) => r.map(([x, y]) => [x * s + ox, y * s + oy]);
  let defs = "", body = "", k = 0;
  for (const l of layers) {
    let mask = "";
    const clip = l.clip?.[0];
    if (clip || l.cut?.length) {
      const id = `m${k++}`;
      let content = clip ? `<path d="${dRing(T(clip))}" fill="white"/>` : `<rect width="24" height="24" fill="white"/>`;
      content += (l.cut ?? []).map((r) => `<path d="${dRing(T(r))}" fill="black"/>`).join("");
      defs += `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">${content}</mask>`;
      mask = ` mask="url(#${id})"`;
    }
    const op = l.tone === 1 ? "" : ` opacity="${l.tone}"`;
    if (l.line) {
      body += `<path d="${dLine(T(l.line))}" fill="none" stroke="white" stroke-width="${l.width}" stroke-linecap="round"${op}${mask}/>`;
    } else {
      const stroke = l.round ? ` stroke="white" stroke-width="${l.round}" stroke-linejoin="round"` : "";
      body += `<path d="${l.rings.map((r) => dRing(T(r))).join("")}" fill="white" fill-rule="evenodd"${stroke}${op}${mask}/>`;
    }
  }
  if (gaps.length) {
    defs += `<mask id="gap" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="white"/>${gaps
      .map((g) => `<path d="${dLine(T(g))}" fill="none" stroke="black" stroke-width="${GAP}" stroke-linecap="round" stroke-linejoin="round"/>`)
      .join("")}</mask>`;
    body = `<g mask="url(#gap)">${body}</g>`;
  }
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>\n`;
}

// ── Op icons: original outlines (24 grid), given the same volume shading ─────
// shade = [cx, cy, shift, scale]: the lit copy is the outline scaled about
// (cx, cy) and nudged up-left; what it misses is the shade crescent.
const OP_ICONS = {
  union: [
    { d: "M3 1A10.5 10.5 0 0 1 12 6.092A10.5 10.5 0 0 1 21 1L21 22A10.5 10.5 0 0 1 12 16.908A10.5 10.5 0 0 1 3 22L3 1Z", shade: [12, 11.5, 1.1, 0.93] },
  ],
  subtract: [
    { d: "M3 1A10.5 10.5 0 0 1 12 6.092A10.5 10.5 0 0 0 10.5 11.5A10.5 10.5 0 0 0 12 16.908A10.5 10.5 0 0 1 3 22L3 1Z", shade: [7.5, 11.5, 1.0, 0.92] },
    { d: "M21 1L21 22A10.5 10.5 0 0 1 10.5 11.5A10.5 10.5 0 0 1 21 1Z", tone: 0.3 },
  ],
  intersect: [
    { d: "M12 6.092A10.5 10.5 0 0 1 13.5 11.5A10.5 10.5 0 0 1 12 16.908A10.5 10.5 0 0 1 10.5 11.5A10.5 10.5 0 0 1 12 6.092Z", shade: [12, 11.5, 0.45, 0.93] },
    { d: "M3 1A10.5 10.5 0 0 1 12 6.092A10.5 10.5 0 0 0 10.5 11.5A10.5 10.5 0 0 0 12 16.908A10.5 10.5 0 0 1 3 22L3 1Z", tone: 0.3 },
    { d: "M12 6.092A10.5 10.5 0 0 1 21 1L21 22A10.5 10.5 0 0 1 12 16.908A10.5 10.5 0 0 0 13.5 11.5A10.5 10.5 0 0 0 12 6.092Z", tone: 0.3 },
  ],
  "smooth-union": [
    { d: "M9.885 7.872A3.2 3.2 0 0 0 14.115 7.872A5.5 5.5 0 1 1 14.115 16.128A3.2 3.2 0 0 0 9.885 16.128A5.5 5.5 0 1 1 9.885 7.872Z", shade: [12, 12, 0.9, 0.93] },
  ],
  "smooth-subtract": [
    { d: "M7.469 6.138A6 6 0 0 0 7.469 17.862A2.2 2.2 0 0 0 9.9 14.716A6 6 0 0 1 9.9 9.284A2.2 2.2 0 0 0 7.469 6.138Z", shade: [7.5, 12, 0.8, 0.92] },
    { d: "M15.25 6A6 6 0 0 1 15.25 18A6 6 0 0 1 15.25 6Z", tone: 0.3 },
  ],
  "smooth-intersect": [
    { d: "M13.882 8.891A6 6 0 0 1 13.882 15.109A2.2 2.2 0 0 1 10.118 15.109A6 6 0 0 1 10.118 8.891A2.2 2.2 0 0 1 13.882 8.891Z", shade: [12, 12, 0.45, 0.93] },
    { d: "M7.469 6.138A6 6 0 0 0 7.469 17.862A2.2 2.2 0 0 0 9.9 14.716A6 6 0 0 1 9.9 9.284A2.2 2.2 0 0 0 7.469 6.138Z", tone: 0.3 },
    { d: "M16.531 6.138A6 6 0 0 1 16.531 17.862A2.2 2.2 0 0 1 14.1 14.716A6 6 0 0 0 14.1 9.284A2.2 2.2 0 0 1 16.531 6.138Z", tone: 0.3 },
  ],
};

function emitOp(parts) {
  let defs = "", body = "";
  parts.forEach(({ d, tone = 1, shade }, i) => {
    if (!shade) { body += `<path d="${d}" fill="white" opacity="${tone}"/>`; return; }
    const [cx, cy, sh, sc] = shade;
    const t = `translate(${f2(cx - sh)} ${f2(cy - sh)}) scale(${sc}) translate(${-cx} ${-cy})`;
    defs += `<mask id="lit${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><path d="${d}" transform="${t}" fill="white"/></mask>`;
    defs += `<mask id="shade${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="white"/><path d="${d}" transform="${t}" fill="black"/></mask>`;
    body += `<path d="${d}" fill="white" opacity="${M}" mask="url(#shade${i})"/><path d="${d}" fill="white" mask="url(#lit${i})"/>`;
  });
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs>${body}</svg>\n`;
}

// ── Lucide outlines given depth: same strokes, extruded back towards the lower right ──
const EXTRUDED = {
  duplicate: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  copyLink: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  copied: '<path d="M20 6 9 17l-5-5"/>',
  sculpt: '<path d="m11 10 3 3"/><path d="M6.5 21A3.5 3.5 0 1 0 3 17.5a2.62 2.62 0 0 1-.708 1.792A1 1 0 0 0 3 21z"/><path d="M9.969 17.031 21.378 5.624a1 1 0 0 0-3.002-3.002L6.967 14.031"/>',
};
function emitExtruded(el, depth = 1.4, steps = 7) {
  const back = Array.from({ length: steps }, (_, i) => `<g transform="translate(${f2((depth * (i + 1)) / steps)} ${f2((depth * (i + 1)) / steps)})">${el}</g>`).join("");
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g transform="translate(${-depth / 2} ${-depth / 2})" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g opacity="${M}">${back}</g>${el}</g></svg>\n`;
}

const OP_DIR = new URL("../src/assets/op-icons/", import.meta.url);
for (const [name, make] of Object.entries(icons)) writeFileSync(new URL(`${name}.svg`, ICONS), emit(make()));
for (const [name, parts] of Object.entries(OP_ICONS)) writeFileSync(new URL(`${name}.svg`, OP_DIR), emitOp(parts));
for (const [name, el] of Object.entries(EXTRUDED)) writeFileSync(new URL(`${name}.svg`, ICONS), emitExtruded(el));
console.log(`${Object.keys(icons).length} shape icons, ${Object.keys(OP_ICONS).length} op icons`);
