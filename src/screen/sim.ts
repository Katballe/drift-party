// Race simulation — pure logic, no DOM, so it can run headless in tests.
//
// The screen steps this at a fixed rate (STEP) and renders interpolated
// positions between steps. Walls come from the track centerline (see
// tracks.ts); progress is measured by ordered checkpoint gates spanning the
// whole road width, crossed in the race direction.
//
// Competitive spice: boost pads, slipstream (tuck in behind a car for a little
// extra top speed), a gentle catch-up for players well behind the leader, and
// surfaces (oil = no grip, sand = slow, ice tracks = low grip everywhere).

import type { CarType, PlayerId } from "../shared/protocol";
import { constrain, nearestIndex, type Gate, type TrackDef } from "./tracks";

export const STEP = 1 / 120;

export interface CarCfg {
  type: CarType;
  spd: number;   // top speed (px/s)
  acc: number;   // initial acceleration (px/s²); approaches spd exponentially
  str: number;   // steering rate (rad/s at speed)
  grip: number;  // how fast velocity re-aligns with heading (1/s)
  dGrip: number; // grip while drifting (brake + steer)
  mass: number;
  w: number; h: number;
}

// Bus = slow off the line, highest top speed, lazy steering, heavy.
// RC  = instant acceleration, lowest top speed, twitchy, light.
// Normal = balanced. Tuned so all three lap within a few % of each other.
export const CAR_CFGS: Record<CarType, CarCfg> = {
  bus:    { type: "bus",    spd: 335, acc: 240, str: 2.65, grip: 8.5, dGrip: 3.2, mass: 3.0, w: 44, h: 24 },
  rc:     { type: "rc",     spd: 300, acc: 400, str: 2.95, grip: 10,  dGrip: 2.4, mass: 0.7, w: 22, h: 14 },
  normal: { type: "normal", spd: 318, acc: 310, str: 2.8,  grip: 9,   dGrip: 2.8, mass: 1.5, w: 32, h: 18 },
};

const BOOST_TIME = 1.1, BOOST_MUL = 1.32, DRAFT_MUL = 1.08, SAND_MUL = 0.6;

export function normA(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Does segment a→b cross the gate (inclusive)? */
export function segX(ax: number, ay: number, bx: number, by: number, g: Gate): boolean {
  const rx = bx - ax, ry = by - ay, sx = g.x2 - g.x1, sy = g.y2 - g.y1;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return false;
  const qx = g.x1 - ax, qy = g.y1 - ay;
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export interface Input { left: boolean; right: boolean; throttle: boolean; brake: boolean; }
export interface Entrant { id: PlayerId; name: string; color: string; carType: CarType; ai: boolean; }

export interface SimCar {
  id: PlayerId; name: string; color: string; cfg: CarCfg;
  ai: boolean;          // driven by the built-in driver (tests / post-finish cruise)
  human: boolean;       // entered by a phone
  ghost: boolean;       // phone disconnected: no input, no collisions
  x: number; y: number; a: number; vx: number; vy: number;
  px: number; py: number; pa: number; // previous step, for render interpolation
  speed: number; fwd: number;
  input: Input;
  drifting: boolean;
  gatesPassed: number;
  finished: boolean; finishTime: number | null; finishRank: number;
  lapStart: number; bestLap: number | null;
  idx: number;          // nearest centerline index
  stuckT: number; reverseT: number;
  wrongT: number; wrongWay: boolean;
  hits: number; wallT: number;
  onOil: boolean; onSand: boolean;
  boostT: number; padCool: number[];
  draftT: number; drafting: boolean;
  topMul: number;
}

export type SimEvent =
  | { k: "hit"; x: number; y: number; imp: number; a: PlayerId; b: PlayerId }
  | { k: "wall"; x: number; y: number; imp: number; id: PlayerId }
  | { k: "lap"; id: PlayerId; lap: number; time: number }
  | { k: "final"; id: PlayerId }
  | { k: "finish"; id: PlayerId; rank: number; time: number }
  | { k: "boost"; id: PlayerId };

const NO_INPUT: Input = { left: false, right: false, throttle: false, brake: false };

export class Race {
  cars: SimCar[];
  time = 0;
  events: SimEvent[] = [];
  finCount = 0;
  firstFinish = Infinity;
  readonly N: number;

  constructor(public track: TrackDef, entrants: Entrant[], public laps: number, rand: () => number = Math.random) {
    this.N = track.gates.length;
    this.cars = entrants.slice(0, 4).map((e, i) => {
      const sp = track.starts[i];
      const cfg = { ...CAR_CFGS[e.carType] };
      if (e.ai) { const v = 0.9 + rand() * 0.1; cfg.spd *= v; cfg.acc *= v; }
      return {
        id: e.id, name: e.name, color: e.color, cfg, ai: e.ai, human: !e.ai, ghost: false,
        x: sp.x, y: sp.y, a: sp.a, vx: 0, vy: 0, px: sp.x, py: sp.y, pa: sp.a, speed: 0, fwd: 0,
        input: { ...NO_INPUT }, drifting: false,
        gatesPassed: 0, finished: false, finishTime: null, finishRank: 0,
        lapStart: 0, bestLap: null,
        idx: nearestIndex(track, sp.x, sp.y, 0), stuckT: 0, reverseT: 0,
        wrongT: 0, wrongWay: false, hits: 0, wallT: 0, onOil: false, onSand: false,
        boostT: 0, padCool: track.boosts.map(() => 0), draftT: 0, drafting: false, topMul: 1,
      };
    });
  }

  /** Lap the car is currently on (1-based, clamped for display). */
  lapOf(c: SimCar) {
    return Math.min(this.laps, Math.max(1, Math.floor((c.gatesPassed - 1) / this.N) + 1));
  }

  /** A phone dropped (ghost) or came back. */
  setGhost(id: PlayerId, ghost: boolean) {
    const c = this.cars.find((k) => k.id === id);
    if (!c || c.finished) return;
    c.ghost = ghost;
    c.input = { ...NO_INPUT };
  }

  step(dt: number) {
    this.time += dt;
    for (const c of this.cars) { c.px = c.x; c.py = c.y; c.pa = c.a; }
    for (const c of this.cars) {
      if (c.ghost) c.input = { ...NO_INPUT };
      else if (c.ai || c.finished) this.drive(c, dt);
    }
    this.modifiers(dt);
    for (const c of this.cars) this.physics(c, dt);
    this.collide();
    for (const c of this.cars) this.walls(c, dt);
    for (const c of this.cars) { this.pads(c, dt); this.gates(c); c.idx = nearestIndex(this.track, c.x, c.y, c.idx); this.wrongWay(c, dt); }
  }

  isOver(): boolean {
    const racing = this.cars.filter((c) => !c.ghost || c.finished);
    if (racing.length === 0) return true;
    if (racing.every((c) => c.finished)) return true;
    if (this.finCount > 0 && this.time - this.firstFinish > 25) return true;
    return this.time > 600;
  }

  /**
   * How far the car has legitimately driven (px): every lap it completed, plus
   * its distance past the last checkpoint it passed. Checkpoints are sparse
   * (only the key corners), so positions come from this, not from counting them.
   */
  progress(c: SimCar): number {
    const G = this.track.gates, n = this.track.pts.length, S = 8;
    if (c.gatesPassed === 0) return -((G[0].i - c.idx + n) % n) * S; // still on the grid
    const last = G[(c.gatesPassed - 1) % this.N], next = G[c.gatesPassed % this.N];
    const base = Math.floor((c.gatesPassed - 1) / this.N) * this.track.length + last.i * S;
    const fwd = ((c.idx - last.i + n) % n) * S, span = (((next.i - last.i + n) % n) || n) * S;
    return base + (fwd <= span ? fwd : -((last.i - c.idx + n) % n) * S); // behind the checkpoint → backwards
  }

  rankings(): SimCar[] {
    return [...this.cars].sort((a, b) => {
      if (a.finished && b.finished) return a.finishRank - b.finishRank;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return this.progress(b) - this.progress(a);
    });
  }

  // ── speed modifiers: boost, slipstream, catch-up, sand ────────────────────
  private modifiers(dt: number) {
    const prog = new Map(this.cars.map((c) => [c, this.progress(c)]));
    const lead = Math.max(...this.cars.filter((c) => !c.ghost).map((c) => prog.get(c)!), 0);
    for (const c of this.cars) {
      c.boostT = Math.max(0, c.boostT - dt);
      c.padCool = c.padCool.map((v) => Math.max(0, v - dt));
      // Slipstream: another car 25–125 px straight ahead of us.
      let behind = false;
      if (!c.ghost && !c.finished && c.speed > 140) {
        const hx = Math.cos(c.a), hy = Math.sin(c.a);
        for (const o of this.cars) {
          if (o === c || o.ghost || o.finished) continue;
          const dx = o.x - c.x, dy = o.y - c.y, along = dx * hx + dy * hy, lat = Math.abs(-dx * hy + dy * hx);
          if (along > 25 && along < 125 && lat < 24) { behind = true; break; }
        }
      }
      c.draftT = behind ? c.draftT + dt : Math.max(0, c.draftT - dt * 2);
      c.drafting = c.draftT > 0.35;
      // Catch-up: up to +7 % top speed when well behind the leader (full at ~1600 px).
      const gap = lead - prog.get(c)!;
      const catchUp = c.finished ? 0 : Math.min(0.07, Math.max(0, gap - 200) * 0.00005);
      c.onOil = this.track.oil.some((o) => (c.x - o.x) ** 2 + (c.y - o.y) ** 2 < o.r * o.r);
      c.onSand = this.track.sand.some((o) => (c.x - o.x) ** 2 + (c.y - o.y) ** 2 < o.r * o.r);
      c.topMul = (c.boostT > 0 ? BOOST_MUL : 1) * (c.drafting ? DRAFT_MUL : 1) * (1 + catchUp) * (c.onSand ? SAND_MUL : 1);
    }
  }

  // ── built-in driver (tests, and cruising after the finish) ────────────────
  private drive(c: SimCar, dt: number) {
    const P = this.track.pts, n = P.length, i = c.input;
    const ahead = (dist: number) => { let j = c.idx, d = 0; while (d < dist) { j = (j + 1) % n; d += 8; } return j; };
    const tgt = P[ahead(34 + c.speed * 0.32)];
    const diff = normA(Math.atan2(tgt.y - c.y, tgt.x - c.x) - c.a);
    if (c.finished) {
      i.left = diff < -0.06; i.right = diff > 0.06; i.brake = false;
      i.throttle = c.speed < c.cfg.spd * 0.45;
      return;
    }
    if (c.reverseT > 0) {
      c.reverseT -= dt;
      i.throttle = false; i.brake = true; i.left = diff > 0; i.right = diff < 0;
      return;
    }
    c.stuckT = c.speed < 25 && this.time > 1.5 ? c.stuckT + dt : 0;
    if (c.stuckT > 1.1) { c.stuckT = 0; c.reverseT = 0.8; }
    // Slow for the tightest bend within braking distance.
    let maxK = 0;
    for (let j = c.idx, d = 0; d < 40 + c.speed * 0.9; d += 8) { j = (j + 1) % n; maxK = Math.max(maxK, Math.abs(P[j].k)); }
    const turn = c.cfg.str * 1.1 * (this.track.grip < 1 ? 0.7 : 1);
    const target = Math.min(c.cfg.spd * c.topMul, maxK > 1e-4 ? (turn / maxK) * 0.85 : Infinity);
    i.left = diff < -0.04; i.right = diff > 0.04;
    i.throttle = c.speed < target;
    i.brake = c.speed > target * 1.2 && c.speed > 80;
  }

  // ── physics ───────────────────────────────────────────────────────────────
  private physics(c: SimCar, dt: number) {
    const i = c.input, cfg = c.cfg, top = cfg.spd * c.topMul;
    let fx = Math.cos(c.a), fy = Math.sin(c.a);
    const spd = Math.hypot(c.vx, c.vy);
    const fwd = c.vx * fx + c.vy * fy;
    const back = fwd < -8;

    // Steering: gentle at a standstill, full from ~120 px/s; inverted in reverse.
    const steer = cfg.str * (0.3 + 0.7 * Math.min(spd / 120, 1.2)) * dt * (back ? -1 : 1);
    if (i.left) c.a -= steer;
    if (i.right) c.a += steer;
    fx = Math.cos(c.a); fy = Math.sin(c.a);

    if (i.throttle && fwd < top) {
      const push = cfg.acc * (c.boostT > 0 ? 1.7 : 1) * Math.max(0, 1 - Math.max(fwd, 0) / top) * dt;
      c.vx += fx * push; c.vy += fy * push;
    }
    c.drifting = i.brake && (i.left || i.right) && fwd > 60;
    if (i.brake && !c.drifting) {
      if (fwd > 25) { const b = Math.pow(0.9, dt * 60); c.vx *= b; c.vy *= b; }
      else if (!i.throttle && fwd > -cfg.spd * 0.35) { // reverse gear
        c.vx -= fx * cfg.acc * 0.5 * dt; c.vy -= fy * cfg.acc * 0.5 * dt;
      }
    }

    // Grip pulls the velocity back in line with the heading (or tail, in reverse).
    let gr = (c.drifting ? cfg.dGrip : cfg.grip) * this.track.grip;
    if (c.onOil) gr *= 0.25;
    const s2 = Math.hypot(c.vx, c.vy), sgn = c.vx * fx + c.vy * fy < 0 ? -1 : 1;
    const k = Math.min(1, gr * dt);
    c.vx += (fx * s2 * sgn - c.vx) * k;
    c.vy += (fy * s2 * sgn - c.vy) * k;

    if (!i.throttle || c.drifting) { const fr = Math.pow(0.985, dt * 60); c.vx *= fr; c.vy *= fr; }
    if (c.onSand) { const fr = Math.pow(0.97, dt * 60); c.vx *= fr; c.vy *= fr; }
    const ns = Math.hypot(c.vx, c.vy);
    if (ns > top) { const t2 = top + (ns - top) * Math.pow(0.15, dt); c.vx *= t2 / ns; c.vy *= t2 / ns; } // overspeed bleeds off smoothly
    c.speed = Math.hypot(c.vx, c.vy);
    c.fwd = c.vx * fx + c.vy * fy;
    c.x += c.vx * dt; c.y += c.vy * dt;
  }

  private pads(c: SimCar, dt: number) {
    if (c.ghost || c.fwd <= 0) return;
    this.track.boosts.forEach((p, k) => {
      if (c.padCool[k] > 0) return;
      const dx = c.x - p.x, dy = c.y - p.y, ca = Math.cos(p.a), sa = Math.sin(p.a);
      if (Math.abs(dx * ca + dy * sa) > p.len / 2 || Math.abs(-dx * sa + dy * ca) > p.w / 2) return;
      c.boostT = BOOST_TIME;
      c.padCool[k] = 1.5;
      c.vx += Math.cos(c.a) * 110; c.vy += Math.sin(c.a) * 110;
      this.events.push({ k: "boost", id: c.id });
    });
  }

  private collide() {
    const cs = this.cars;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j];
        if (a.finished || b.finished || a.ghost || b.ghost) continue; // ghosts & finished cars pass through
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
        const mn = (a.cfg.w + b.cfg.w) * 0.42;
        if (d >= mn || d < 0.01) continue;
        const ov = mn - d, nx = dx / d, ny = dy / d, tm = a.cfg.mass + b.cfg.mass;
        a.x -= nx * ov * (b.cfg.mass / tm); a.y -= ny * ov * (b.cfg.mass / tm);
        b.x += nx * ov * (a.cfg.mass / tm); b.y += ny * ov * (a.cfg.mass / tm);
        const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rvn >= 0) continue;
        const imp = 1.5 * rvn / tm;
        a.vx += imp * b.cfg.mass * nx; a.vy += imp * b.cfg.mass * ny;
        b.vx -= imp * a.cfg.mass * nx; b.vy -= imp * a.cfg.mass * ny;
        if (-rvn > 25) {
          this.events.push({ k: "hit", x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, imp: -rvn, a: a.id, b: b.id });
          if (-rvn > 70) { a.hits++; b.hits++; }
        }
      }
    }
  }

  /** Keep the car on the road; slide along walls instead of sticking to them. */
  private walls(c: SimCar, dt: number) {
    c.wallT = Math.max(0, c.wallT - dt);
    const w = constrain(this.track, c.x, c.y, c.cfg.h * 0.6 + 2);
    if (w.ok) return;
    c.x = w.x; c.y = w.y;
    const vn = c.vx * w.nx + c.vy * w.ny;
    if (vn >= 0) return;
    c.vx -= 1.3 * vn * w.nx; c.vy -= 1.3 * vn * w.ny;   // restitution 0.3
    const scrape = Math.max(0.8, 1 + vn / 1200);          // head-on hits cost more speed
    c.vx *= scrape; c.vy *= scrape;
    c.speed = Math.hypot(c.vx, c.vy);
    if (-vn > 45 && c.wallT <= 0) {
      this.events.push({ k: "wall", x: c.x, y: c.y, imp: -vn, id: c.id });
      if (-vn > 90) c.hits++;
      c.wallT = 0.18;
    }
  }

  private gates(c: SimCar) {
    if (c.finished || c.ghost) return;
    const gi = c.gatesPassed % this.N, g = this.track.gates[gi];
    if (!segX(c.px, c.py, c.x, c.y, g)) return;
    if ((c.x - c.px) * g.nx + (c.y - c.py) * g.ny <= 0) return; // crossed backwards
    c.gatesPassed++;
    if (gi !== 0) return;
    if (c.gatesPassed > 1) {
      const lt = this.time - c.lapStart;
      c.bestLap = c.bestLap === null ? lt : Math.min(c.bestLap, lt);
      if (c.gatesPassed >= this.laps * this.N + 1) {
        c.finished = true;
        c.finishTime = this.time;
        c.finishRank = ++this.finCount;
        this.firstFinish = Math.min(this.firstFinish, this.time);
        c.ai = true; // hand the wheel to the cruise driver
        this.events.push({ k: "finish", id: c.id, rank: c.finishRank, time: this.time });
      } else {
        const lap = this.lapOf(c);
        this.events.push({ k: "lap", id: c.id, lap, time: lt });
        if (lap === this.laps) this.events.push({ k: "final", id: c.id });
      }
    }
    c.lapStart = this.time;
  }

  private wrongWay(c: SimCar, dt: number) {
    if (c.ai || c.finished || c.ghost) { c.wrongT = 0; c.wrongWay = false; return; }
    const p = this.track.pts[c.idx];
    const along = c.vx * p.tx + c.vy * p.ty;
    c.wrongT = c.speed > 50 && along < -0.5 * c.speed ? c.wrongT + dt : Math.max(0, c.wrongT - dt * 2);
    c.wrongWay = c.wrongT > 0.8;
  }
}
