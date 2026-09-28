// Track geometry. A track is a closed centerline (smooth spline through
// control points, or a parametric curve) with a half-width at every point.
// Everything else is derived from it: walls (distance from the centerline),
// ordered checkpoint gates, the start grid, feature placement and the scenery
// (which is solid on open tracks). Pure data + math, no DOM, so tracks can be
// validated headlessly.
//
// Tracks can be tuned without touching the specs below: a TrackEdit per track
// (grip, walls on/off, speed bumps, hand-placed checkpoints, off-road
// penalties) comes from track-edits.json, and the dev build's track editor
// layers its own draft edits on top (applyTrackEdits).

import { hashStr, rng } from "../shared/sketch";
import COMMITTED_EDITS from "./track-edits.json";

export type TrackId = "sunny" | "junkyard" | "snake" | "frosty" | "hairpin";

export interface CenterPt {
  x: number; y: number; hw: number; // position, half-width
  s: number;                        // arc length from the start line
  tx: number; ty: number;           // unit tangent (race direction)
  nx: number; ny: number;           // unit normal (to the driver's right)
  k: number;                        // signed curvature (+ = right-hand bend)
}
/** A line segment (gates and speed bumps are lines across the road). */
export interface Seg { x1: number; y1: number; x2: number; y2: number; }
export interface Gate extends Seg {
  mx: number; my: number; nx: number; ny: number; i: number;
  flags: { x: number; y: number }[]; // one flag on each side of the road, always off the tarmac
}
export interface Bump extends Seg { i: number; }
export interface Circle { x: number; y: number; r: number; }
export interface Pad { x: number; y: number; a: number; len: number; w: number; i: number; off: number; }
export type DecoKind = "tree" | "tyres" | "crate" | "rock" | "cactus" | "pine" | "snowman" | "cone";
/** Scenery. Just decoration behind walls; solid on an open track. */
export interface Obstacle { x: number; y: number; r: number; s: number; kind: DecoKind; seed: number; }
/** What's off the road: how much it slows you (top-speed factor) and how grippy it is. */
export interface Terrain { name: string; slow: number; grip: number; }

export interface Theme {
  ground: [string, string, string];  // base, dark, light
  road: string; speck: string;
  kerb: [string, string];
  deco: DecoKind[];
  label: string;
  terrain: Terrain;
}

/** Tunables layered over a track's spec (track-edits.json + the dev editor). */
export interface TrackEdit {
  grip?: number;          // road grip (1 = tarmac, ice tracks ~0.5)
  walls?: boolean;        // false = open track: leave the road onto the terrain; only the screen edge is a wall
  roughness?: number;     // open tracks: how hard the terrain punishes you (1 = default)
  clutter?: number;       // open tracks: how much extra scenery near the road (1 = default, 0 = none)
  bumps?: number[];       // speed bumps, as lap fractions (0–1 from the start line)
  bumpLoss?: number;      // fraction of speed a bump takes at full speed
  checkpoints?: number[]; // hand-placed checkpoints (lap fractions); omit for automatic (key corners)
  checkpointLines?: boolean; // draw a red/white line across the road between each checkpoint's flags
  // Hand-placed features — each list, when present, replaces the track's own:
  boosts?: { at: number; off: number }[];                            // lap fraction + sideways offset (−1…1 of the half-width)
  sand?: { x: number; y: number; r: number }[];                      // sand / snow patches
  oil?: { x: number; y: number; r: number }[];                       // oil slicks
  scenery?: { x: number; y: number; kind: DecoKind; s: number }[];   // trees, rocks… (solid on open tracks)
}
export type TrackEdits = Partial<Record<TrackId, TrackEdit>>;

export interface TrackDef {
  id: TrackId; name: string; tag: string; difficulty: 1 | 2 | 3;
  pts: CenterPt[]; length: number;
  gates: Gate[];
  autoGates: boolean;    // checkpoints were found automatically (not hand-placed)
  starts: { x: number; y: number; a: number }[];
  oil: Circle[]; sand: Circle[]; boosts: Pad[];
  bumps: Bump[]; bumpLoss: number;
  obstacles: Obstacle[];
  manualScenery: boolean; // scenery was hand-placed (so the clutter setting doesn't apply)
  checkpointLines: boolean;
  grip: number;          // surface grip multiplier (ice < 1)
  baseGrip: number;      // the grip the spec ships with (before edits)
  walls: boolean;
  roughness: number; clutter: number;
  theme: Theme;
}

/** Hard screen boundary for cars (logical 1600×900; the top strip is under the HUD). */
export const BOUNDS = { x0: 8, y0: 70, x1: 1592, y1: 892 };
export const BUMP_LOSS = 0.35;

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

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
/** Centerline index ↔ lap fraction (what edits store, so they survive resampling). */
export const lapFraction = (t: { pts: CenterPt[] }, i: number) => round4(i / t.pts.length);
export const lapIndex = (t: { pts: CenterPt[] }, f: number) => { const n = t.pts.length; return ((Math.round(f * n) % n) + n) % n; };

/** Distance from (x,y) to the nearest road edge (negative = on the road). */
export function edgeGap(t: { pts: CenterPt[] }, x: number, y: number): number {
  let best = Infinity;
  for (let j = 0; j < t.pts.length; j += 2) { const p = t.pts[j]; best = Math.min(best, Math.hypot(p.x - x, p.y - y) - p.hw); }
  return best;
}

/** Could a line across the road at index i be a checkpoint / bump? (Not where the road crosses itself.) */
export function lineIsClean(t: { pts: CenterPt[] }, i: number): boolean {
  const c = t.pts[i], r = c.hw + 12;
  for (let k = 0; k <= 6; k++) {
    const f = k / 6 * 2 - 1, x = c.x + c.nx * r * f, y = c.y + c.ny * r * f;
    if (onOtherPart(t, x, y, i, 10)) return false;
  }
  return true;
}

const inBounds = (x: number, y: number) => x > BOUNDS.x0 && x < BOUNDS.x1 && y > BOUNDS.y0 && y < BOUNDS.y1;
const DECO_R: Record<DecoKind, number> = { tree: 19, pine: 15, rock: 15, cactus: 9, snowman: 11, tyres: 16, crate: 14, cone: 7 };
/** Collision radius of a piece of scenery. */
export const obstacleRadius = (kind: DecoKind, s: number) => (DECO_R[kind] ?? 14) * s * 0.85;

/**
 * Where a checkpoint's two flags go: just off the road on each side. On the
 * inside of a tight bend the usual spot is still road (the road folds over
 * itself), so search outwards — straight out first, then fanning up to 60°
 * either way — for the nearest open ground.
 */
function flagSpots(t: { pts: CenterPt[] }, i: number): { x: number; y: number }[] {
  const c = t.pts[i], fan = [0, 15, -15, 30, -30, 45, -45, 60, -60].map((d) => (d * Math.PI) / 180);
  return [-1, 1].map((side) => {
    for (let off = c.hw + 10; off <= c.hw + 160; off += 4) {
      for (const ang of fan) {
        const ux = c.nx * side * Math.cos(ang) - c.ny * side * Math.sin(ang), uy = c.nx * side * Math.sin(ang) + c.ny * side * Math.cos(ang);
        const x = c.x + ux * off, y = c.y + uy * off;
        if (inBounds(x, y) && edgeGap(t, x, y) >= 5) return { x, y };
      }
    }
    return { x: c.x + c.nx * side * (c.hw + 6), y: c.y + c.ny * side * (c.hw + 6) }; // nowhere free: on the verge
  });
}

/** Scenery, placed deterministically. Open tracks get extra near the road to make leaving it costly. */
function placeObstacles(id: TrackId, t: { pts: CenterPt[] }, kinds: DecoKind[], open: boolean, clutter: number): Obstacle[] {
  const r = rng(hashStr(`${id}:scenery`)), out: Obstacle[] = [];
  const pass = (count: number, maxGap: number, spacing: number, tries: number) => {
    for (let k = 0, placed = 0; k < tries && placed < count; k++) {
      const x = BOUNDS.x0 + 30 + r() * (BOUNDS.x1 - BOUNDS.x0 - 60), y = BOUNDS.y0 + 22 + r() * (BOUNDS.y1 - BOUNDS.y0 - 44);
      const kind = kinds[out.length % kinds.length], s = 0.8 + r() * 0.5, rad = DECO_R[kind] * s;
      const gap = edgeGap(t, x, y);
      if (gap < rad + 12 || gap > maxGap || out.some((o) => Math.hypot(o.x - x, o.y - y) < spacing)) continue;
      out.push({ x, y, r: obstacleRadius(kind, s), s, kind, seed: hashStr(`${id}${out.length}`) });
      placed++;
    }
  };
  pass(30, Infinity, 70, 400);
  if (open && clutter > 0) pass(Math.round(22 * clutter), 120, 50, 1500);
  return out;
}

function build(spec: Spec, edit: TrackEdit = {}): TrackDef {
  let raw: { x: number; y: number; hw: number }[], cpS: number[] = [];
  if (spec.cps) ({ pts: raw, cpS } = spline(spec.cps));
  else raw = curve(spec.curve!.f, spec.curve!.hw);
  const pts = annotate(raw), n = pts.length, length = n * STEP;
  const t = { pts } as TrackDef;
  const open = edit.walls === false;

  const at = (p: Place) => {
    const s = (p.cp !== undefined ? cpS[p.cp] : (p.at ?? 0) * length) + (p.ds ?? 0);
    const i = ((Math.round(s / STEP) % n) + n) % n, c = pts[i];
    let off = p.off ?? 0;
    if (p.outside) off = Math.abs(off || 0.55) * (c.k > 0 ? -1 : 1); // outside of the bend
    return { i, c, off, x: c.x + c.nx * off * c.hw, y: c.y + c.ny * off * c.hw };
  };

  // A checkpoint is a line across the road (a little past each edge so a car
  // hugging the verge still counts) — on open tracks too: cutting across the
  // grass past it is caught as a missed checkpoint instead.
  const makeGate = (i: number): Gate => {
    const c = pts[i], r = c.hw + 12;
    return { x1: c.x - c.nx * r, y1: c.y - c.ny * r, x2: c.x + c.nx * r, y2: c.y + c.ny * r, mx: c.x, my: c.y, nx: c.tx, ny: c.ty, i, flags: flagSpots(t, i) };
  };
  const clean = (i: number) => lineIsClean(t, i);
  if (!clean(0)) throw new Error(`${spec.id}: start line is not on a clean stretch`);
  // Hand-placed checkpoints (from edits) replace the automatic key corners.
  // Anything unusable (a crossing, on top of the start line) is skipped.
  const manual = Array.isArray(edit.checkpoints);
  const picks = manual
    ? [...new Set(edit.checkpoints!.map((f) => lapIndex(t, f)))].filter((i) => clean(i) && Math.min(i, n - i) * STEP >= 40).sort((a, b) => a - b)
    : keyPoints(pts, clean);
  const gates = [0, ...picks].map(makeGate);
  const bumps: Bump[] = [...new Set((edit.bumps ?? []).map((f) => lapIndex(t, f)))].filter(clean).sort((a, b) => a - b).map((i) => {
    const c = pts[i], r = c.hw + 2;
    return { x1: c.x - c.nx * r, y1: c.y - c.ny * r, x2: c.x + c.nx * r, y2: c.y + c.ny * r, i };
  });
  const clamp = (v: number | undefined, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const clutter = clamp(edit.clutter, 0, 3, 1);
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const circles = (list: { x: number; y: number; r: number }[] | undefined, fallback: Circle[]) =>
    Array.isArray(list) ? list.filter((o) => num(o?.x) && num(o?.y) && inBounds(o.x, o.y)).map((o) => ({ x: o.x, y: o.y, r: clamp(o.r, 10, 90, 36) })) : fallback;
  const pad = (i: number, off: number, len = 56, w?: number): Pad => {
    const c = pts[i];
    return { x: c.x + c.nx * off * c.hw, y: c.y + c.ny * off * c.hw, a: Math.atan2(c.ty, c.tx), len, w: w ?? Math.min(70, c.hw * 1.1), i, off };
  };
  const boosts = Array.isArray(edit.boosts)
    ? edit.boosts.filter((b) => num(b?.at)).map((b) => pad(lapIndex(t, b.at), clamp(b.off, -0.6, 0.6, 0)))
    : (spec.boosts ?? []).map((b) => { const p = at(b); return pad(p.i, p.off, b.len, b.w); });
  const manualScenery = Array.isArray(edit.scenery);
  const obstacles: Obstacle[] = manualScenery
    ? edit.scenery!.filter((o) => num(o?.x) && num(o?.y) && o.kind in DECO_R && inBounds(o.x, o.y)).map((o, k) => {
      const sc = clamp(o.s, 0.5, 2, 1);
      return { x: o.x, y: o.y, s: sc, kind: o.kind, r: obstacleRadius(o.kind, sc), seed: hashStr(`${spec.id}${k}`) };
    })
    : placeObstacles(spec.id, t, spec.theme.deco, open, clutter);

  // Staggered 8-car grid behind the start line, alternating sides (pole on the left).
  const starts = Array.from({ length: 8 }, (_, k) => [30 + k * 26, k % 2 ? 0.32 : -0.32]).map(([back, side]) => {
    const i = (n - Math.round(back / STEP)) % n, c = pts[i];
    return { x: c.x + c.nx * side * c.hw, y: c.y + c.ny * side * c.hw, a: Math.atan2(c.ty, c.tx) };
  });

  return {
    id: spec.id, name: spec.name, tag: spec.tag, difficulty: spec.difficulty,
    pts, length, gates, autoGates: !manual, starts,
    oil: circles(edit.oil, (spec.oil ?? []).map((o) => { const p = at(o); return { x: p.x, y: p.y, r: o.r }; })),
    sand: circles(edit.sand, (spec.sand ?? []).map((o) => { const p = at(o); return { x: p.x, y: p.y, r: o.r }; })),
    boosts,
    bumps, bumpLoss: clamp(edit.bumpLoss, 0, 0.8, BUMP_LOSS),
    obstacles, manualScenery, checkpointLines: (edit.checkpointLines ?? (edit as { checkerLines?: boolean }).checkerLines) === true, // (old drafts said checkerLines)
    grip: clamp(edit.grip, 0.1, 1.5, spec.grip ?? 1), baseGrip: spec.grip ?? 1,
    walls: !open,
    roughness: clamp(edit.roughness, 0, 2, 1), clutter,
    theme: spec.theme,
  };
}

// ─── the tracks ───────────────────────────────────────────────────────────────
// Canvas is 1600×900. Tracks stay clear of the top-right corner (rankings panel).
const SPECS: Spec[] = [
  {
    id: "sunny", name: "Sunny Speedway", difficulty: 1,
    tag: "Wide and fast. Draft on the straights, boost past.",
    theme: { ground: ["#6aa845", "#4b8531", "#86c25a"], road: "#b3aa9b", speck: "rgba(70,60,50,0.18)", kerb: ["#d8453b", "#f4efe2"], deco: ["tree", "tree", "cone"], label: "rgba(30,50,20,0.28)", terrain: { name: "Grass", slow: 0.62, grip: 0.7 } },
    cps: [[560, 185, 72], [930, 185, 72], [1170, 212, 68], [1318, 335, 64], [1352, 520, 62], [1262, 690, 62], [1060, 758, 58], [895, 700, 50], [735, 765, 54], [480, 772, 62], [272, 690, 66], [206, 478, 68], [292, 272, 70]],
    boosts: [{ cp: 0, ds: 200 }, { cp: 9, ds: 10 }],
    sand: [{ cp: 3, ds: 20, outside: true, off: 0.62, r: 40 }, { cp: 11, outside: true, off: 0.62, r: 40 }],
  },
  {
    id: "junkyard", name: "Junkyard 8", difficulty: 2,
    tag: "A figure-8. Everyone meets at the crossing…",
    theme: { ground: ["#7a8a3a", "#56632a", "#9aa84e"], road: "#b9a27a", speck: "rgba(80,64,40,0.22)", kerb: ["#e0772a", "#2b2621"], deco: ["tyres", "crate", "tyres"], label: "rgba(40,30,10,0.32)", terrain: { name: "Dirt & scrap", slow: 0.66, grip: 0.6 } },
    // Gerono lemniscate: two lobes crossing at ~90° in the middle. Starts at the bottom of the right lobe.
    curve: { f: (t) => { const u = t + Math.PI / 4; return [800 + 585 * Math.sin(u), 480 + 285 * Math.sin(2 * u)]; }, hw: 58 },
    oil: [{ at: 0.125, outside: true, off: 0.45, r: 34 }, { at: 0.625, outside: true, off: 0.45, r: 34 }, { at: 0.375, off: 0, r: 26 }],
    boosts: [{ at: 0.79 }, { at: 0.29 }], // on the diagonals, launching you into the crossing
  },
  {
    id: "snake", name: "Snake Canyon", difficulty: 2,
    tag: "Tight S-bends. Take the inside line — sand is slow.",
    theme: { ground: ["#e3c690", "#c9a46a", "#f0dcae"], road: "#a8714a", speck: "rgba(70,40,20,0.22)", kerb: ["#c0392b", "#f4efe2"], deco: ["rock", "cactus", "rock"], label: "rgba(90,55,20,0.3)", terrain: { name: "Deep sand", slow: 0.5, grip: 0.6 } },
    cps: [[1000, 745, 56], [700, 745, 56], [565, 705, 48], [430, 752, 50], [268, 735, 54], [168, 590, 52], [190, 425, 50], [300, 330, 48],
      [430, 218, 46], [630, 440, 46], [830, 218, 46], [1030, 440, 46], [1210, 238, 48], [1335, 390, 50], [1360, 575, 52], [1250, 705, 54]],
    sand: [{ cp: 9, outside: true, off: 0.6, r: 36 }, { cp: 10, outside: true, off: 0.6, r: 36 }, { cp: 11, outside: true, off: 0.6, r: 36 }],
    boosts: [{ cp: 0, ds: 150 }, { cp: 13, ds: 40 }],
  },
  {
    id: "frosty", name: "Frosty Fjord", difficulty: 2, grip: 0.5,
    tag: "Sheet ice. Everything slides — brake early.",
    theme: { ground: ["#e8eff5", "#cfdbe5", "#ffffff"], road: "#a9cfe6", speck: "rgba(255,255,255,0.55)", kerb: ["#2f6fb3", "#f4f8fb"], deco: ["pine", "snowman", "pine"], label: "rgba(40,70,100,0.3)", terrain: { name: "Deep snow", slow: 0.55, grip: 0.45 } },
    // Loops round a fjord inlet: a deep U-bend dips into the middle from the top edge.
    cps: [[520, 768, 70], [900, 772, 72], [1195, 730, 70], [1350, 560, 68], [1318, 330, 66], [1165, 205, 64], [985, 235, 62], [905, 385, 60],
      [800, 468, 62], [695, 385, 60], [615, 235, 62], [435, 200, 64], [262, 300, 66], [205, 505, 68], [298, 695, 70]],
    boosts: [{ cp: 0, ds: 150 }, { cp: 11, ds: -40 }],
    sand: [{ cp: 4, outside: true, off: 0.6, r: 42 }, { cp: 8, outside: true, off: 0.55, r: 38 }, { cp: 13, outside: true, off: 0.6, r: 42 }],
  },
  {
    id: "hairpin", name: "Hairpin Heights", difficulty: 3,
    tag: "Three hairpins. Brake late, boost out.",
    theme: { ground: ["#8fa36b", "#6d8350", "#a9bb85"], road: "#9a9790", speck: "rgba(40,40,40,0.18)", kerb: ["#d8453b", "#f4efe2"], deco: ["rock", "pine", "rock"], label: "rgba(30,40,20,0.3)", terrain: { name: "Rough grass", slow: 0.6, grip: 0.65 } },
    cps: [[330, 190, 56], [760, 190, 56], [1115, 192, 54], [1248, 272, 48], [1118, 360, 50], [760, 360, 52], [522, 362, 50], [408, 452, 46], [522, 542, 50],
      [900, 542, 52], [1128, 546, 50], [1256, 628, 46], [1122, 712, 52], [700, 716, 56], [330, 716, 58], [204, 602, 58], [194, 380, 58], [236, 244, 58]],
    boosts: [{ cp: 4, ds: 70 }, { cp: 12, ds: 70 }, { cp: 8, ds: 60 }],
  },
];

export const TRACK_ORDER: TrackId[] = SPECS.map((s) => s.id);
/** The edits that ship (see track-edits.json). */
export const TRACK_EDITS: TrackEdits = COMMITTED_EDITS as TrackEdits;
/** Live track table. Entries are rebuilt in place by applyTrackEdits. */
export const TRACKS = {} as Record<TrackId, TrackDef>;

/** (Re)build every track with these edits. Returns the ids whose definition changed. */
export function applyTrackEdits(edits: TrackEdits): TrackId[] {
  const changed: TrackId[] = [];
  for (const spec of SPECS) {
    const key = JSON.stringify(edits[spec.id] ?? {});
    if (TRACKS[spec.id] && BUILT_WITH.get(spec.id) === key) continue;
    TRACKS[spec.id] = build(spec, edits[spec.id] ?? {});
    BUILT_WITH.set(spec.id, key);
    changed.push(spec.id);
  }
  return changed;
}
const BUILT_WITH = new Map<TrackId, string>();

/** A track built with specific edits, without touching the live table (tests, previews). */
export function buildTrack(id: TrackId, edit: TrackEdit = {}): TrackDef {
  return build(SPECS.find((s) => s.id === id)!, edit);
}

applyTrackEdits(TRACK_EDITS);
