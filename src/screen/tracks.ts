// Track geometry. A track is a closed centerline (smooth spline through
// control points, or a parametric curve) with a half-width at every point.
// Everything else is derived from it: walls (distance from the centerline),
// ordered checkpoint gates, the start grid, and feature placement. Pure data +
// math, no DOM, so tracks can be validated headlessly.

export type TrackId = "sunny" | "junkyard" | "snake" | "frosty" | "hairpin";

export interface CenterPt {
  x: number; y: number; hw: number; // position, half-width
  s: number;                        // arc length from the start line
  tx: number; ty: number;           // unit tangent (race direction)
  nx: number; ny: number;           // unit normal (to the driver's right)
  k: number;                        // signed curvature (+ = right-hand bend)
}
export interface Gate { x1: number; y1: number; x2: number; y2: number; mx: number; my: number; nx: number; ny: number; i: number; }
export interface Circle { x: number; y: number; r: number; }
export interface Pad { x: number; y: number; a: number; len: number; w: number; }
export type DecoKind = "tree" | "tyres" | "crate" | "rock" | "cactus" | "pine" | "snowman" | "cone";

export interface Theme {
  ground: [string, string, string];  // base, dark, light
  road: string; speck: string;
  kerb: [string, string];
  deco: DecoKind[];
  label: string;
}

export interface TrackDef {
  id: TrackId; name: string; tag: string; difficulty: 1 | 2 | 3;
  pts: CenterPt[]; length: number;
  gates: Gate[];
  starts: { x: number; y: number; a: number }[];
  oil: Circle[]; sand: Circle[]; boosts: Pad[];
  grip: number;          // surface grip multiplier (ice < 1)
  theme: Theme;
}

const STEP = 8;             // centerline sample spacing (px)
const BEND_K = 1 / 450;     // a bend peaks tighter than a 450 px radius…
const BEND_TURN = 0.5;      // …and turns the car at least ~30°

// ─── curve sampling ───────────────────────────────────────────────────────────
type CP = [number, number, number]; // x, y, half-width

/** Closed centripetal Catmull-Rom through the control points, resampled every STEP px.
 *  Also returns the arc position of each control point (for placing features). */
function spline(cps: CP[]): { pts: { x: number; y: number; hw: number }[]; cpS: number[] } {
  const n = cps.length, dense: { x: number; y: number; hw: number; cp: number }[] = [];
  const SUB = 60;
  for (let i = 0; i < n; i++) {
    const p0 = cps[(i - 1 + n) % n], p1 = cps[i], p2 = cps[(i + 1) % n], p3 = cps[(i + 2) % n];
    const d = (a: CP, b: CP) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5) || 1e-4;
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    for (let k = 0; k < SUB; k++) {
      const t = t1 + ((t2 - t1) * k) / SUB;
      const lerp = (a: number[], b: number[], ta: number, tb: number) => a.map((v, j) => (v * (tb - t) + b[j] * (t - ta)) / (tb - ta));
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      const C = lerp(B1, B2, t1, t2);
      dense.push({ x: C[0], y: C[1], hw: p1[2] + (p2[2] - p1[2]) * (k / SUB), cp: k === 0 ? i : -1 });
    }
  }
  return resample(dense, n);
}

/** Closed parametric curve sampled densely, then resampled. */
function curve(f: (t: number) => [number, number], hw: number): { x: number; y: number; hw: number }[] {
  const dense = Array.from({ length: 2400 }, (_, i) => { const [x, y] = f((i / 2400) * Math.PI * 2); return { x, y, hw, cp: -1 }; });
  return resample(dense, 0).pts;
}

function resample(dense: { x: number; y: number; hw: number; cp: number }[], ncp: number) {
  const cum = [0];
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1], b = dense[i % dense.length];
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cum[dense.length], count = Math.round(total / STEP), pts: { x: number; y: number; hw: number }[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const s = (k / count) * total;
    while (cum[j + 1] < s) j++;
    const a = dense[j], b = dense[(j + 1) % dense.length], f = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, hw: a.hw + (b.hw - a.hw) * f });
  }
  const cpS = new Array<number>(ncp).fill(0);
  dense.forEach((d, i) => { if (d.cp >= 0) cpS[d.cp] = (cum[i] / total) * count * STEP; }); // in resampled arc units
  return { pts, cpS };
}

function annotate(raw: { x: number; y: number; hw: number }[]): CenterPt[] {
  const n = raw.length;
  const pts = raw.map((p, i) => {
    const a = raw[(i - 1 + n) % n], b = raw[(i + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, tx = (b.x - a.x) / L, ty = (b.y - a.y) / L;
    return { ...p, s: i * STEP, tx, ty, nx: -ty, ny: tx, k: 0 };
  });
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 2 + n) % n], b = pts[(i + 2) % n];
    let d = Math.atan2(b.ty, b.tx) - Math.atan2(a.ty, a.tx);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    pts[i].k = d / (4 * STEP);
  }
  return pts;
}

// ─── queries ──────────────────────────────────────────────────────────────────
/** Arc distance between two centerline indices (shortest way round). */
function arcGap(t: { pts: CenterPt[] }, i: number, j: number) {
  const n = t.pts.length, d = Math.abs(i - j) % n;
  return Math.min(d, n - d) * STEP;
}

/** Is (x,y) on a part of the road that isn't the stretch around index `i`? */
function onOtherPart(t: { pts: CenterPt[] }, x: number, y: number, i: number, pad: number) {
  return t.pts.some((p, j) => arcGap(t, i, j) > 260 && Math.hypot(p.x - x, p.y - y) < p.hw + pad);
}

export interface WallHit { ok: boolean; x: number; y: number; nx: number; ny: number; }

/**
 * Keep a circle of radius `margin` on the road. The road is the union of
 * capsules around every centerline segment, so crossings just work: we pick
 * the segment with the most room and only push if even that one is exceeded.
 */
export function constrain(t: TrackDef, x: number, y: number, margin: number): WallHit {
  const P = t.pts, n = P.length;
  let best = -Infinity, bx = 0, by = 0, bd = 0, allowed = 0;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey || 1;
    const u = Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / L2));
    const qx = a.x + ex * u, qy = a.y + ey * u, d = Math.hypot(x - qx, y - qy);
    const al = a.hw + (b.hw - a.hw) * u - margin, slack = al - d;
    if (slack > best) { best = slack; bx = qx; by = qy; bd = d; allowed = al; }
  }
  if (best >= 0) return { ok: true, x, y, nx: 0, ny: 0 };
  const ux = (x - bx) / (bd || 1), uy = (y - by) / (bd || 1);
  return { ok: false, x: bx + ux * allowed, y: by + uy * allowed, nx: -ux, ny: -uy };
}

export function onRoad(t: TrackDef, x: number, y: number, margin = 0) {
  return constrain(t, x, y, margin).ok;
}

/** Nearest centerline index, searching near `hint` first (keeps the right branch at crossings). */
export function nearestIndex(t: TrackDef, x: number, y: number, hint: number): number {
  const P = t.pts, n = P.length;
  let best = hint, bd = Infinity;
  for (let k = -12; k <= 12; k++) {
    const j = (hint + k + n) % n, d = (P[j].x - x) ** 2 + (P[j].y - y) ** 2;
    if (d < bd) { bd = d; best = j; }
  }
  if (Math.sqrt(bd) <= P[best].hw + 50) return best;
  for (let j = 0; j < n; j++) { const d = (P[j].x - x) ** 2 + (P[j].y - y) ** 2; if (d < bd) { bd = d; best = j; } }
  return best;
}

// ─── checkpoints ──────────────────────────────────────────────────────────────
/**
 * Checkpoints go at the key points of the lap — the apex of every real bend —
 * rather than at a fixed spacing, so a twisty track gets more of them than a
 * simple one. Walls already stop shortcuts; the gates make sure every bend is
 * driven, in order, in the right direction (and that figure-8s do both loops).
 */
export function keyPoints(pts: CenterPt[], clean: (i: number) => boolean): number[] {
  return findCorners(pts, clean).map((c) => c.i);
}

export interface Corner { i: number; turn: number; sharp: number; }

/**
 * Corners = peaks of (smoothed) curvature. Two same-direction peaks are one
 * corner unless the road clearly straightens between them, so a long sweep
 * that eases slightly mid-way is one corner, while a sweep followed by a
 * chicane is two. A corner must turn the car at least BEND_TURN.
 */
export function findCorners(pts: CenterPt[], clean: (i: number) => boolean): Corner[] {
  const n = pts.length, W = 5;
  const ks = pts.map((_, i) => { let a = 0; for (let d = -W; d <= W; d++) a += pts[(i + d + n) % n].k; return a / (2 * W + 1); });
  const at = (i: number) => ks[((i % n) + n) % n];
  const mag = (i: number) => Math.abs(at(i));
  // Local maxima of |curvature| above the bend threshold (±6 samples ≈ ±48 px).
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    if (mag(i) < BEND_K) continue;
    let top = true;
    for (let d = 1; d <= 6 && top; d++) top = mag(i) > mag(i - d) && mag(i) >= mag(i + d);
    if (top) peaks.push(i);
  }
  if (!peaks.length) return [];
  // Group consecutive same-sign peaks the road doesn't straighten between.
  const groups: number[][] = [];
  for (const p of peaks) {
    const g = groups[groups.length - 1], q = g?.[g.length - 1];
    let same = false;
    if (q !== undefined && Math.sign(at(q)) === Math.sign(at(p))) {
      let lo = Infinity;
      for (let j = q; j <= p; j++) lo = Math.min(lo, Math.sign(at(p)) * at(j));
      same = lo >= 0.5 * Math.min(mag(q), mag(p));
    }
    if (same) g.push(p); else groups.push([p]);
  }
  // The loop wraps: the last group may continue into the first.
  if (groups.length > 1) {
    const first = groups[0], last = groups[groups.length - 1], q = last[last.length - 1], p = first[0] + n;
    if (Math.sign(at(q)) === Math.sign(at(p))) {
      let lo = Infinity;
      for (let j = q; j <= p; j++) lo = Math.min(lo, Math.sign(at(p)) * at(j));
      if (lo >= 0.5 * Math.min(mag(q), mag(p))) { groups[0] = [...last, ...first]; groups.pop(); }
    }
  }
  const corners: (Corner & { lo: number; hi: number })[] = [];
  for (const g of groups) {
    const sign = Math.sign(at(g[0]));
    const apex = g.reduce((a, b) => (mag(b) > mag(a) ? b : a));
    let lo = g[0], hi = g[g.length - 1] < g[0] ? g[g.length - 1] + n : g[g.length - 1];
    const edge = 0.3 * mag(apex);
    while (sign * at(lo - 1) >= edge && hi - lo < n) lo--;
    while (sign * at(hi + 1) >= edge && hi - lo < n) hi++;
    let turn = 0;
    for (let j = lo; j <= hi; j++) turn += at(j) * STEP;
    if (Math.abs(turn) < BEND_TURN) continue;
    // The key point of a corner is halfway round it, not its tightest spot
    // (on a long sweep that can sit right at the entry or exit). A corner that
    // keeps turning well past 180° gets one key point per half-turn.
    const parts = Math.max(1, Math.round(Math.abs(turn) / Math.PI));
    let j = lo, acc = 0;
    for (let k = 0; k < parts; k++) {
      const target = (Math.abs(turn) * (k + 0.5)) / parts;
      while (j < hi && Math.abs(acc + at(j) * STEP) < target) { acc += at(j) * STEP; j++; }
      corners.push({ i: ((j % n) + n) % n, turn: turn / parts, sharp: mag(apex), lo, hi });
    }
  }
  // Move an apex that sits in a crossing to the nearest clean spot of its corner.
  const picks: Corner[] = [];
  for (const c of corners) {
    for (let d = 0; d <= c.hi - c.lo; d++) {
      const j = [c.i + d, c.i - d].map((x) => ((x % n) + n) % n).find((x) => clean(x));
      if (j !== undefined) { picks.push({ i: j, turn: c.turn, sharp: c.sharp }); break; }
    }
  }
  // Not right on top of the start line, and never two checkpoints in one spot.
  const gap = (a: number, b: number) => { const d = Math.abs(a - b) % n; return Math.min(d, n - d) * STEP; };
  const kept: Corner[] = [];
  for (const p of picks.sort((a, b) => b.sharp - a.sharp)) {
    if (gap(p.i, 0) < 140 || kept.some((k) => gap(k.i, p.i) < 130)) continue;
    kept.push(p);
  }
  return kept.sort((a, b) => a.i - b.i);
}

// ─── building a track ─────────────────────────────────────────────────────────
interface Place { cp?: number; at?: number; ds?: number; off?: number; outside?: boolean; }
interface Spec {
  id: TrackId; name: string; tag: string; difficulty: 1 | 2 | 3; grip?: number; theme: Theme;
  cps?: CP[]; curve?: { f: (t: number) => [number, number]; hw: number };
  oil?: (Place & { r: number })[]; sand?: (Place & { r: number })[]; boosts?: (Place & { len?: number; w?: number })[];
}

function build(spec: Spec): TrackDef {
  let raw: { x: number; y: number; hw: number }[], cpS: number[] = [];
  if (spec.cps) ({ pts: raw, cpS } = spline(spec.cps));
  else raw = curve(spec.curve!.f, spec.curve!.hw);
  const pts = annotate(raw), n = pts.length, length = n * STEP;
  const t = { pts } as TrackDef;

  const at = (p: Place) => {
    const s = (p.cp !== undefined ? cpS[p.cp] : (p.at ?? 0) * length) + (p.ds ?? 0);
    const i = ((Math.round(s / STEP) % n) + n) % n, c = pts[i];
    let off = p.off ?? 0;
    if (p.outside) off = Math.abs(off || 0.55) * (c.k > 0 ? -1 : 1); // outside of the bend
    return { i, c, x: c.x + c.nx * off * c.hw, y: c.y + c.ny * off * c.hw };
  };

  const makeGate = (i: number): Gate => {
    const c = pts[i], r = c.hw + 12;
    return { x1: c.x - c.nx * r, y1: c.y - c.ny * r, x2: c.x + c.nx * r, y2: c.y + c.ny * r, mx: c.x, my: c.y, nx: c.tx, ny: c.ty, i };
  };
  const clean = (i: number) => {
    const g = makeGate(i);
    for (let k = 0; k <= 6; k++) {
      const f = k / 6, x = g.x1 + (g.x2 - g.x1) * f, y = g.y1 + (g.y2 - g.y1) * f;
      if (onOtherPart(t, x, y, i, 10)) return false;
    }
    return true;
  };
  if (!clean(0)) throw new Error(`${spec.id}: start line is not on a clean stretch`);
  const gates = [0, ...keyPoints(pts, clean)].map(makeGate);

  // 2×2 grid behind the start line.
  const starts = [[36, -0.3], [36, 0.3], [82, -0.3], [82, 0.3]].map(([back, side]) => {
    const i = (n - Math.round(back / STEP)) % n, c = pts[i];
    return { x: c.x + c.nx * side * c.hw, y: c.y + c.ny * side * c.hw, a: Math.atan2(c.ty, c.tx) };
  });

  return {
    id: spec.id, name: spec.name, tag: spec.tag, difficulty: spec.difficulty,
    pts, length, gates, starts,
    oil: (spec.oil ?? []).map((o) => { const p = at(o); return { x: p.x, y: p.y, r: o.r }; }),
    sand: (spec.sand ?? []).map((o) => { const p = at(o); return { x: p.x, y: p.y, r: o.r }; }),
    boosts: (spec.boosts ?? []).map((b) => { const p = at(b); return { x: p.x, y: p.y, a: Math.atan2(p.c.ty, p.c.tx), len: b.len ?? 56, w: b.w ?? Math.min(70, p.c.hw * 1.1) }; }),
    grip: spec.grip ?? 1,
    theme: spec.theme,
  };
}

// ─── the tracks ───────────────────────────────────────────────────────────────
// Canvas is 1600×900. Tracks stay clear of the top-right corner (rankings panel).
const SPECS: Spec[] = [
  {
    id: "sunny", name: "Sunny Speedway", difficulty: 1,
    tag: "Wide and fast. Draft on the straights, boost past.",
    theme: { ground: ["#6aa845", "#4b8531", "#86c25a"], road: "#b3aa9b", speck: "rgba(70,60,50,0.18)", kerb: ["#d8453b", "#f4efe2"], deco: ["tree", "tree", "cone"], label: "rgba(30,50,20,0.28)" },
    cps: [[560, 185, 72], [930, 185, 72], [1170, 212, 68], [1318, 335, 64], [1352, 520, 62], [1262, 690, 62], [1060, 758, 58], [895, 700, 50], [735, 765, 54], [480, 772, 62], [272, 690, 66], [206, 478, 68], [292, 272, 70]],
    boosts: [{ cp: 0, ds: 200 }, { cp: 9, ds: 10 }],
    sand: [{ cp: 3, ds: 20, outside: true, off: 0.62, r: 40 }, { cp: 11, outside: true, off: 0.62, r: 40 }],
  },
  {
    id: "junkyard", name: "Junkyard 8", difficulty: 2,
    tag: "A figure-8. Everyone meets at the crossing…",
    theme: { ground: ["#7a8a3a", "#56632a", "#9aa84e"], road: "#b9a27a", speck: "rgba(80,64,40,0.22)", kerb: ["#e0772a", "#2b2621"], deco: ["tyres", "crate", "tyres"], label: "rgba(40,30,10,0.32)" },
    // Gerono lemniscate: two lobes crossing at ~90° in the middle. Starts at the bottom of the right lobe.
    curve: { f: (t) => { const u = t + Math.PI / 4; return [800 + 585 * Math.sin(u), 480 + 285 * Math.sin(2 * u)]; }, hw: 58 },
    oil: [{ at: 0.125, outside: true, off: 0.45, r: 34 }, { at: 0.625, outside: true, off: 0.45, r: 34 }, { at: 0.375, off: 0, r: 26 }],
    boosts: [{ at: 0.79 }, { at: 0.29 }], // on the diagonals, launching you into the crossing
  },
  {
    id: "snake", name: "Snake Canyon", difficulty: 2,
    tag: "Tight S-bends. Take the inside line — sand is slow.",
    theme: { ground: ["#e3c690", "#c9a46a", "#f0dcae"], road: "#a8714a", speck: "rgba(70,40,20,0.22)", kerb: ["#c0392b", "#f4efe2"], deco: ["rock", "cactus", "rock"], label: "rgba(90,55,20,0.3)" },
    cps: [[1000, 745, 56], [700, 745, 56], [565, 705, 48], [430, 752, 50], [268, 735, 54], [168, 590, 52], [190, 425, 50], [300, 330, 48],
      [430, 218, 46], [630, 440, 46], [830, 218, 46], [1030, 440, 46], [1210, 238, 48], [1335, 390, 50], [1360, 575, 52], [1250, 705, 54]],
    sand: [{ cp: 9, outside: true, off: 0.6, r: 36 }, { cp: 10, outside: true, off: 0.6, r: 36 }, { cp: 11, outside: true, off: 0.6, r: 36 }],
    boosts: [{ cp: 0, ds: 150 }, { cp: 13, ds: 40 }],
  },
  {
    id: "frosty", name: "Frosty Fjord", difficulty: 2, grip: 0.5,
    tag: "Sheet ice. Everything slides — brake early.",
    theme: { ground: ["#e8eff5", "#cfdbe5", "#ffffff"], road: "#a9cfe6", speck: "rgba(255,255,255,0.55)", kerb: ["#2f6fb3", "#f4f8fb"], deco: ["pine", "snowman", "pine"], label: "rgba(40,70,100,0.3)" },
    // Loops round a fjord inlet: a deep U-bend dips into the middle from the top edge.
    cps: [[520, 768, 70], [900, 772, 72], [1195, 730, 70], [1350, 560, 68], [1318, 330, 66], [1165, 205, 64], [985, 235, 62], [905, 385, 60],
      [800, 468, 62], [695, 385, 60], [615, 235, 62], [435, 200, 64], [262, 300, 66], [205, 505, 68], [298, 695, 70]],
    boosts: [{ cp: 0, ds: 150 }, { cp: 11, ds: -40 }],
    sand: [{ cp: 4, outside: true, off: 0.6, r: 42 }, { cp: 8, outside: true, off: 0.55, r: 38 }, { cp: 13, outside: true, off: 0.6, r: 42 }],
  },
  {
    id: "hairpin", name: "Hairpin Heights", difficulty: 3,
    tag: "Three hairpins. Brake late, boost out.",
    theme: { ground: ["#8fa36b", "#6d8350", "#a9bb85"], road: "#9a9790", speck: "rgba(40,40,40,0.18)", kerb: ["#d8453b", "#f4efe2"], deco: ["rock", "pine", "rock"], label: "rgba(30,40,20,0.3)" },
    cps: [[330, 190, 56], [760, 190, 56], [1115, 192, 54], [1248, 272, 48], [1118, 360, 50], [760, 360, 52], [522, 362, 50], [408, 452, 46], [522, 542, 50],
      [900, 542, 52], [1128, 546, 50], [1256, 628, 46], [1122, 712, 52], [700, 716, 56], [330, 716, 58], [204, 602, 58], [194, 380, 58], [236, 244, 58]],
    boosts: [{ cp: 4, ds: 70 }, { cp: 12, ds: 70 }, { cp: 8, ds: 60 }],
  },
];

export const TRACKS: Record<TrackId, TrackDef> = Object.fromEntries(SPECS.map((s) => [s.id, build(s)])) as Record<TrackId, TrackDef>;
export const TRACK_ORDER: TrackId[] = SPECS.map((s) => s.id);
