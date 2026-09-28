// Race simulation — pure logic, no DOM, so it can run headless in tests.
//
// The screen steps this at a fixed rate (STEP) and renders interpolated
// positions between steps. Walls come from the track centerline (see
// tracks.ts); progress is measured by ordered checkpoint gates spanning the
// whole road width, crossed in the race direction.
//
// Competitive spice: boost pads, slipstream (tuck in behind a car for a little
// extra top speed), a gentle catch-up for players well behind the leader, and
// surfaces (oil = no grip, sand = slow, ice tracks = low grip everywhere),
// speed bumps. On an open track (walls off) the road has no walls: the
// terrain slows you and loosens grip, the scenery is solid, and the screen
// edge is the only hard wall.

import { CAR_CFGS, type CarCfg } from "../shared/cars";
import { MAX_RACERS, type CarType, type RacerId } from "../shared/protocol";
import { BOUNDS, constrain, nearestIndex, type Seg, type TrackDef } from "./tracks";

export { CAR_CFGS, type CarCfg };
export const STEP = 1 / 120;

/**
 * Bot difficulty. `pace` scales top speed and acceleration, `corner` how hard
 * they dare to take bends (fraction of the grip limit), `line` how sloppily
 * they hold their line (random drift, in fractions of the half-width).
 */
export type BotSkill = "easy" | "normal" | "hard";
export const BOT_SKILLS: Record<BotSkill, { pace: number; corner: number; line: number }> = {
  easy:   { pace: 0.86, corner: 0.72, line: 0.35 },
  normal: { pace: 0.94, corner: 0.8,  line: 0.2 },
  hard:   { pace: 1.0,  corner: 0.86, line: 0.08 },
};

const BOOST_TIME = 1.1, BOOST_MUL = 1.32, DRAFT_MUL = 1.08, SAND_MUL = 0.6;

export function normA(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Does segment a→b cross the line g (inclusive)? */
export function segX(ax: number, ay: number, bx: number, by: number, g: Seg): boolean {
  const rx = bx - ax, ry = by - ay, sx = g.x2 - g.x1, sy = g.y2 - g.y1;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return false;
  const qx = g.x1 - ax, qy = g.y1 - ay;
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export interface Input { left: boolean; right: boolean; throttle: boolean; brake: boolean; }
/** `ai` = a bot (driven by the built-in driver at `skill`, default hard). */
export interface Entrant { id: RacerId; name: string; color: string; carType: CarType; ai: boolean; skill?: BotSkill; }

export interface SimCar {
  id: RacerId; name: string; color: string; cfg: CarCfg;
  ai: boolean;          // driven by the built-in driver (bots, and everyone after the finish)
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
  offRoad: boolean;     // open tracks: on the terrain, not the road
  missed: boolean;      // drove past its next checkpoint without crossing it
  boostT: number; padCool: number[];
  draftT: number; drafting: boolean;
  topMul: number;
  corner: number;       // driver: fraction of the grip limit it takes bends at
  lane: number; laneTgt: number; laneBase: number; wander: number; passT: number; // driver: line across the road (−1…1 of the usable half-width)
}

export type SimEvent =
  | { k: "hit"; x: number; y: number; imp: number; a: RacerId; b: RacerId }
  | { k: "wall"; x: number; y: number; imp: number; id: RacerId }
  | { k: "lap"; id: RacerId; lap: number; time: number }
  | { k: "final"; id: RacerId }
  | { k: "finish"; id: RacerId; rank: number; time: number }
  | { k: "boost"; id: RacerId }
  | { k: "bump"; x: number; y: number; imp: number; id: RacerId };

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
    this.cars = entrants.slice(0, MAX_RACERS).map((e, i) => {
      const sp = track.starts[i];
      const cfg = { ...CAR_CFGS[e.carType] };
      const sk = BOT_SKILLS[e.skill ?? "hard"];
      const laneBase = e.ai ? (rand() - 0.5) * 2 * sk.line : 0;
      if (e.ai) { const v = sk.pace * (0.97 + rand() * 0.03); cfg.spd *= v; cfg.acc *= v; }
      return {
        id: e.id, name: e.name, color: e.color, cfg, ai: e.ai, human: !e.ai, ghost: false,
        x: sp.x, y: sp.y, a: sp.a, vx: 0, vy: 0, px: sp.x, py: sp.y, pa: sp.a, speed: 0, fwd: 0,
        input: { ...NO_INPUT }, drifting: false,
        gatesPassed: 0, finished: false, finishTime: null, finishRank: 0,
        lapStart: 0, bestLap: null,
        idx: nearestIndex(track, sp.x, sp.y, 0), stuckT: 0, reverseT: 0,
        wrongT: 0, wrongWay: false, hits: 0, wallT: 0, onOil: false, onSand: false, offRoad: false, missed: false,
        boostT: 0, padCool: track.boosts.map(() => 0), draftT: 0, drafting: false, topMul: 1,
        corner: sk.corner, lane: laneBase, laneTgt: laneBase, laneBase, wander: e.ai ? sk.line : 0, passT: 0,
      };
    });
  }

  /** Lap the car is currently on (1-based, clamped for display). */
  lapOf(c: SimCar) {
    return Math.min(this.laps, Math.max(1, Math.floor((c.gatesPassed - 1) / this.N) + 1));
  }

  /** A phone dropped (ghost) or came back. */
  setGhost(id: RacerId, ghost: boolean) {
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
    for (const c of this.cars) {
      this.pads(c, dt); this.bumps(c); this.gates(c);
      c.idx = nearestIndex(this.track, c.x, c.y, c.idx);
      this.wrongWay(c, dt); this.missedGate(c);
    }
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
    const live = this.cars.filter((c) => !c.ghost);
    const lead = live.length ? Math.max(...live.map((c) => prog.get(c)!)) : 0; // not floored at 0: nobody chases themselves
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
      const sand = c.onSand ? 1 - (1 - SAND_MUL) * c.cfg.rough : 1; // monster trucks shrug sand off
      const off = c.offRoad ? Math.max(0.25, 1 - (1 - this.track.theme.terrain.slow) * this.rough(c)) : 1;
      c.topMul = (c.boostT > 0 ? BOOST_MUL : 1) * (c.drafting ? DRAFT_MUL : 1) * (1 + catchUp) * sand * off;
    }
  }

  // ── built-in driver (bots, and cruising after the finish) ─────────────────
  private drive(c: SimCar, dt: number) {
    const P = this.track.pts, n = P.length, i = c.input;
    const ahead = (dist: number) => { let j = c.idx, d = 0; while (d < dist) { j = (j + 1) % n; d += 8; } return j; };
    if (!c.finished) this.pickLane(c, dt);
    const p = P[ahead(34 + c.speed * 0.32)];
    const off = c.finished ? 0 : c.lane * Math.max(0, p.hw - c.cfg.h * 0.6 - 10);
    const diff = normA(Math.atan2(p.y + p.ny * off - c.y, p.x + p.nx * off - c.x) - c.a);
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
    const turn = c.cfg.str * 1.1 * (this.track.grip < 1 ? 0.4 + 0.6 * this.track.grip : 1);
    let target = Math.min(c.cfg.spd * c.topMul, maxK > 1e-4 ? (turn / maxK) * c.corner : Infinity);
    // Ease off for a speed bump coming up.
    for (const b of this.track.bumps) if (((b.i - c.idx + n) % n) * 8 < 30 + c.speed * 0.55) target = Math.min(target, 170);
    i.left = diff < -0.04; i.right = diff > 0.04;
    i.throttle = c.speed < target;
    i.brake = c.speed > target * 1.2 && c.speed > 80;
  }

  /** Hold a line of its own (drifting slowly across the road — sloppier bots
   *  wander more) and swing out to go round a slower car ahead. */
  private pickLane(c: SimCar, dt: number) {
    const hx = Math.cos(c.a), hy = Math.sin(c.a), p = this.track.pts[c.idx];
    let block: SimCar | null = null, near = Infinity;
    for (const o of this.cars) {
      if (o === c || o.ghost || o.finished) continue;
      const dx = o.x - c.x, dy = o.y - c.y, along = dx * hx + dy * hy;
      if (along <= 0 || along > 40 + c.speed * 0.35 || along >= near) continue;
      if (Math.abs(-dx * hy + dy * hx) > (c.cfg.h + o.cfg.h) * 0.5 + 10) continue;
      if (o.fwd > c.fwd && along > 30) continue; // pulling away — not in the way
      block = o; near = along;
    }
    if (block) {
      // Pass on whichever side of the road the other car leaves more room.
      const theirs = ((block.x - p.x) * p.nx + (block.y - p.y) * p.ny) / p.hw;
      c.laneTgt = theirs > 0 ? -0.7 : 0.7;
      c.passT = 1;
    } else if ((c.passT -= dt) <= 0) {
      c.laneTgt = c.laneBase + c.wander * Math.sin(this.time * 0.6 + c.id.charCodeAt(1) * 1.7);
    }
    c.laneTgt = Math.max(-0.7, Math.min(0.7, c.laneTgt));
    c.lane += Math.max(-dt * 1.4, Math.min(dt * 1.4, c.laneTgt - c.lane));
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
    if (c.offRoad) gr = (c.drifting ? cfg.dGrip : cfg.grip) * Math.max(0.15, 1 - (1 - this.track.theme.terrain.grip) * this.rough(c));
    const s2 = Math.hypot(c.vx, c.vy), sgn = c.vx * fx + c.vy * fy < 0 ? -1 : 1;
    const k = Math.min(1, gr * dt);
    c.vx += (fx * s2 * sgn - c.vx) * k;
    c.vy += (fy * s2 * sgn - c.vy) * k;

    if (!i.throttle || c.drifting) { const fr = Math.pow(0.985, dt * 60); c.vx *= fr; c.vy *= fr; }
    if (c.onSand) { const fr = Math.pow(1 - 0.03 * cfg.rough, dt * 60); c.vx *= fr; c.vy *= fr; }
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

  /** How hard off-road terrain bites this car (monster trucks barely notice). */
  private rough(c: SimCar) { return Math.min(1.5, c.cfg.rough * this.track.roughness); }

  /**
   * Walled track: keep the car on the road. Open track: note whether it's on
   * the terrain and bounce it off solid scenery. Either way the screen edge is
   * a hard wall. Cars slide along walls instead of sticking to them.
   */
  private walls(c: SimCar, dt: number) {
    c.wallT = Math.max(0, c.wallT - dt);
    const t = this.track, m = c.cfg.h * 0.6 + 2;
    if (t.walls) {
      const w = constrain(t, c.x, c.y, m);
      if (!w.ok) this.bounce(c, w.x, w.y, w.nx, w.ny);
      c.offRoad = false;
    } else {
      c.offRoad = !constrain(t, c.x, c.y, -c.cfg.h * 0.25).ok; // centre a little past the edge
      const cr = (c.cfg.w + c.cfg.h) * 0.25;
      for (const o of t.obstacles) {
        const dx = c.x - o.x, dy = c.y - o.y, d = Math.hypot(dx, dy), min = o.r + cr;
        if (d >= min || d < 1e-6) continue;
        this.bounce(c, o.x + (dx / d) * min, o.y + (dy / d) * min, dx / d, dy / d);
      }
    }
    if (c.x < BOUNDS.x0 + m) this.bounce(c, BOUNDS.x0 + m, c.y, 1, 0);
    if (c.x > BOUNDS.x1 - m) this.bounce(c, BOUNDS.x1 - m, c.y, -1, 0);
    if (c.y < BOUNDS.y0 + m) this.bounce(c, c.x, BOUNDS.y0 + m, 0, 1);
    if (c.y > BOUNDS.y1 - m) this.bounce(c, c.x, BOUNDS.y1 - m, 0, -1);
  }

  /** Put the car at (x,y) against a wall whose normal (nx,ny) points back into the open. */
  private bounce(c: SimCar, x: number, y: number, nx: number, ny: number) {
    c.x = x; c.y = y;
    const vn = c.vx * nx + c.vy * ny;
    if (vn >= 0) return;
    c.vx -= 1.3 * vn * nx; c.vy -= 1.3 * vn * ny;   // restitution 0.3
    const scrape = Math.max(0.8, 1 + vn / 1200);          // head-on hits cost more speed
    c.vx *= scrape; c.vy *= scrape;
    c.speed = Math.hypot(c.vx, c.vy);
    if (-vn > 45 && c.wallT <= 0) {
      this.events.push({ k: "wall", x: c.x, y: c.y, imp: -vn, id: c.id });
      if (-vn > 90) c.hits++;
      c.wallT = 0.18;
    }
  }

  /** Driving over a speed bump costs speed — more the faster you hit it. */
  private bumps(c: SimCar) {
    if (c.ghost) return;
    for (const b of this.track.bumps) {
      if (!segX(c.px, c.py, c.x, c.y, b)) continue;
      const loss = this.track.bumpLoss * Math.min(1, c.speed / 260) * (0.35 + 0.65 * c.cfg.rough);
      this.events.push({ k: "bump", x: c.x, y: c.y, imp: c.speed, id: c.id });
      if (c.speed > 150) c.hits++;
      c.vx *= 1 - loss; c.vy *= 1 - loss;
      c.speed = Math.hypot(c.vx, c.vy);
    }
  }

  /** Past the next checkpoint without crossing it (cut a corner off-road): it must go back. */
  private missedGate(c: SimCar) {
    if (c.finished || c.ghost || c.gatesPassed === 0) { c.missed = false; return; }
    const n = this.track.pts.length, g = this.track.gates[c.gatesPassed % this.N];
    const past = ((c.idx - g.i + n) % n) * 8;
    c.missed = past > 90 && past < this.track.length * 0.5;
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
