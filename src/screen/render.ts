// Canvas rendering for the race: prebaked hand-drawn tracks, persistent skid
// marks, particles, and interpolated cars. Logical space is always 1600×900;
// the backing store is scaled to the display (up to 2×) so TVs and hi-DPI
// screens stay crisp.

import { drawCarArt } from "../shared/carArt";
import { INK, hashStr, inkShape, makePaper, paintGrass, rng, sampleEllipse, sampleRoundRect } from "../shared/sketch";
import { normA, type Race, type SimCar } from "./sim";
import { BOUNDS, type DecoKind, type Gate, type TrackDef } from "./tracks";

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number; color: string; grow: number; }
interface Wheels { lx: number; ly: number; rx: number; ry: number; }

export const W = 1600, H = 900;

/** Distance past the edge of the road (negative = on the road), ignoring the stretch around `skip`. */
function roadGap(t: TrackDef, x: number, y: number, skip = -1): number {
  const n = t.pts.length;
  let best = Infinity;
  for (let j = 0; j < n; j += 2) {
    if (skip >= 0) { const d = Math.abs(j - skip) % n; if (Math.min(d, n - d) * 8 < 220) continue; }
    const p = t.pts[j];
    best = Math.min(best, Math.hypot(p.x - x, p.y - y) - p.hw);
  }
  return best;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private scale = 0;
  private bg: HTMLCanvasElement | null = null;
  private paper: HTMLCanvasElement | null = null;
  private skid: HTMLCanvasElement | null = null;
  private skidCtx: CanvasRenderingContext2D | null = null;
  private skidFade = 0;
  private track: TrackDef | null = null;
  private particles: Particle[] = [];
  private wheels = new Map<string, Wheels>();

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Fit the canvas to the window (letterboxed 16:9) and pick a backing scale. */
  resize() {
    const asp = W / H;
    let w = window.innerWidth, h = w / asp;
    if (h > window.innerHeight) { h = window.innerHeight; w = h * asp; }
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    // Round the backing scale *up* to a quarter step so we never upscale (blur).
    const s = Math.min(2, Math.max(0.5, Math.ceil(((w * (window.devicePixelRatio || 1)) / W) * 4 - 0.01) / 4));
    if (s === this.scale) return;
    this.scale = s;
    this.canvas.width = Math.round(W * s);
    this.canvas.height = Math.round(H * s);
    this.paper = makePaper(this.canvas.width, this.canvas.height);
    this.skid = document.createElement("canvas");
    this.skid.width = this.canvas.width; this.skid.height = this.canvas.height;
    this.skidCtx = this.skid.getContext("2d")!;
    this.skidCtx.setTransform(s, 0, 0, s, 0, 0);
    if (this.track) this.bake(this.track);
  }

  setTrack(track: TrackDef) {
    if (this.track !== track) { this.track = track; this.bake(track); }
    this.clearEffects();
  }

  /** Re-draw the static art (e.g. once web fonts have loaded). */
  rebake() { if (this.track) this.bake(this.track); }

  clearEffects() {
    this.particles = [];
    this.wheels.clear();
    if (this.skidCtx) { this.skidCtx.save(); this.skidCtx.setTransform(1, 0, 0, 1, 0, 0); this.skidCtx.clearRect(0, 0, this.skid!.width, this.skid!.height); this.skidCtx.restore(); }
  }

  // ── effects fed by sim events ─────────────────────────────────────────────
  sparks(x: number, y: number, impact: number) {
    const n = Math.min(14, 4 + Math.floor(impact / 25));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 60 + Math.random() * 160;
      this.emit({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.25 + Math.random() * 0.2, r: 2, color: Math.random() < 0.5 ? "#FFD600" : "#FF8A00", grow: 0 });
    }
  }

  dust(x: number, y: number, impact: number) {
    const n = Math.min(10, 3 + Math.floor(impact / 40));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 20 + Math.random() * 60;
      this.emit({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.5 + Math.random() * 0.4, r: 4 + Math.random() * 4, color: "rgba(214,196,150,", grow: 14 });
    }
  }

  private emit(p: Particle) {
    if (this.particles.length > 320) this.particles.shift();
    this.particles.push(p);
  }

  // ── frame ─────────────────────────────────────────────────────────────────
  /** Draw a frame. `overlay` (dev tools) draws in logical 1600×900 space on top. */
  frame(race: Race | null, alpha: number, dt: number, overlay?: (ctx: CanvasRenderingContext2D) => void) {
    const ctx = this.ctx, s = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.bg) ctx.drawImage(this.bg, 0, 0);
    else { ctx.fillStyle = "#1a2a0a"; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); }

    if (race) {
      this.updateSkids(race, alpha, dt);
      if (this.skid) ctx.drawImage(this.skid, 0, 0);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      this.updateParticles(dt, false);
      // A car that skipped a checkpoint sees that checkpoint light up in its colour.
      for (const c of race.cars) if (c.missed) drawGateLine(ctx, race.track.gates[c.gatesPassed % race.track.gates.length], c.color, race.time);
      const cars = race.cars.map((c) => ({ c, ...this.lerp(c, alpha) })).sort((a, b) => a.y - b.y);
      for (const k of cars) this.drawCar(k.c, k.x, k.y, k.a, race.time);
      this.updateParticles(0, true);
      for (const k of cars) this.drawLabels(race, k.c, k.x, k.y);
    }
    if (overlay) { ctx.setTransform(s, 0, 0, s, 0, 0); overlay(ctx); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.paper) ctx.drawImage(this.paper, 0, 0);
  }

  /** Canvas point (client px) → logical track coordinates. */
  toLogical(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H };
  }

  private lerp(c: SimCar, t: number) {
    return { x: c.px + (c.x - c.px) * t, y: c.py + (c.y - c.py) * t, a: c.pa + normA(c.a - c.pa) * t };
  }

  private updateSkids(race: Race, alpha: number, dt: number) {
    const k = this.skidCtx;
    if (!k) return;
    this.skidFade += dt;
    if (this.skidFade > 0.25) {
      // Slowly erase old marks so the track doesn't turn black over a long race.
      this.skidFade = 0;
      k.save(); k.setTransform(1, 0, 0, 1, 0, 0);
      k.globalCompositeOperation = "destination-out";
      k.fillStyle = "rgba(0,0,0,0.03)"; k.fillRect(0, 0, this.skid!.width, this.skid!.height);
      k.restore();
    }
    k.strokeStyle = race.track.grip < 1 ? "rgba(255,255,255,0.55)" : "rgba(38,32,26,0.3)"; k.lineCap = "round";
    for (const c of race.cars) {
      const { x, y, a } = this.lerp(c, alpha);
      const cs = Math.cos(a), sn = Math.sin(a), bx = -c.cfg.w * 0.32, by = c.cfg.h * 0.42;
      const w: Wheels = { lx: x + cs * bx + sn * by, ly: y + sn * bx - cs * by, rx: x + cs * bx - sn * by, ry: y + sn * bx + cs * by };
      const prev = this.wheels.get(c.id);
      const marking = !c.ghost && (c.drifting || (c.input.brake && c.fwd > 90) || c.onOil) && c.speed > 45;
      if (prev && marking) {
        k.lineWidth = c.cfg.h >= 24 ? 4 : 3;
        k.beginPath(); k.moveTo(prev.lx, prev.ly); k.lineTo(w.lx, w.ly); k.moveTo(prev.rx, prev.ry); k.lineTo(w.rx, w.ry); k.stroke();
        if (c.drifting && Math.random() < 0.5) {
          this.emit({ x: w.lx, y: w.ly, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30, life: 0, max: 0.6, r: 4, color: "rgba(236,236,236,", grow: 18 });
        }
      }
      if (c.onSand && c.speed > 60 && Math.random() < 0.35) {
        this.emit({ x: w.rx, y: w.ry, vx: -cs * 40 + (Math.random() - 0.5) * 30, vy: -sn * 40 + (Math.random() - 0.5) * 30, life: 0, max: 0.5, r: 3, color: "rgba(214,190,130,", grow: 12 });
      }
      this.wheels.set(c.id, w);
    }
  }

  private updateParticles(dt: number, draw: boolean) {
    const ctx = this.ctx;
    if (!draw) {
      for (const p of this.particles) { p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; }
      this.particles = this.particles.filter((p) => p.life < p.max);
      return;
    }
    for (const p of this.particles) {
      const f = 1 - p.life / p.max, r = p.r + p.grow * (1 - f);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      const soft = p.color.endsWith(",");
      ctx.fillStyle = soft ? p.color + (0.35 * f).toFixed(3) + ")" : p.color;
      ctx.globalAlpha = soft ? 1 : f;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  private drawCar(car: SimCar, x: number, y: number, angle: number, time: number) {
    const ctx = this.ctx;
    const { w, h } = car.cfg, type = car.cfg.type, seed = hashStr(car.id);
    ctx.save();
    if (car.finished) ctx.globalAlpha = 0.28; // finished cars are ghosts: others drive through them
    if (car.ghost) ctx.globalAlpha = 0.3 + 0.1 * Math.sin(time * 6);
    ctx.translate(x, y); ctx.rotate(angle);
    // slipstream: wind lines streaming past
    if (car.drafting && !car.ghost) {
      ctx.save(); ctx.strokeStyle = "rgba(255,255,255,0.65)"; ctx.lineWidth = 2; ctx.lineCap = "round";
      const ph = (time * 9) % 1;
      for (const sy of [-h * 0.75, h * 0.75]) { ctx.beginPath(); ctx.moveTo(w * 0.2 - ph * 30, sy); ctx.lineTo(-w * 0.6 - ph * 30, sy); ctx.stroke(); }
      ctx.restore();
    }
    // boost flame
    if (car.boostT > 0 && !car.ghost) {
      const fl = 10 + Math.random() * 10 + car.boostT * 8;
      ctx.fillStyle = "#FFB300";
      ctx.beginPath(); ctx.moveTo(-w / 2, -h * 0.3); ctx.lineTo(-w / 2 - fl, 0); ctx.lineTo(-w / 2, h * 0.3); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#FF5722";
      ctx.beginPath(); ctx.moveTo(-w / 2, -h * 0.16); ctx.lineTo(-w / 2 - fl * 0.55, 0); ctx.lineTo(-w / 2, h * 0.16); ctx.closePath(); ctx.fill();
    }
    drawCarArt(ctx, type, car.color, w, h, seed, car.input.brake && !car.finished && !car.ghost);
    ctx.restore();
  }

  private drawLabels(race: Race, car: SimCar, x: number, y: number) {
    const ctx = this.ctx, h = car.cfg.h;
    ctx.textAlign = "center"; ctx.lineJoin = "round";
    ctx.font = "700 17px 'Caveat',cursive";
    ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.lineWidth = 3;
    const label = car.ghost ? `📵 ${car.name}` : car.finished ? `${car.name} · ${ordinal(car.finishRank)}` : car.name;
    ctx.globalAlpha = car.finished || car.ghost ? 0.7 : 1;
    ctx.strokeText(label, x, y - h / 2 - 10);
    ctx.fillStyle = "#fff"; ctx.fillText(label, x, y - h / 2 - 10);
    ctx.globalAlpha = 1;
    const warn = car.wrongWay ? "WRONG WAY!" : car.missed ? "MISSED CHECKPOINT ↩" : "";
    if (warn && Math.floor(race.time * 3) % 2 === 0) {
      ctx.font = "700 22px 'Caveat',cursive";
      ctx.strokeText(warn, x, y + h / 2 + 24); ctx.fillStyle = car.wrongWay ? "#ff4d4d" : "#FFD600"; ctx.fillText(warn, x, y + h / 2 + 24);
    }
  }

  // ── static art ────────────────────────────────────────────────────────────
  private bake(track: TrackDef) {
    if (!this.scale) return;
    const c = document.createElement("canvas");
    c.width = this.canvas.width; c.height = this.canvas.height;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    drawTrack(ctx, track, false);
    this.bg = c;
  }

  /** Small preview image of a track for the lobby. */
  static thumbnail(track: TrackDef, width: number): string {
    const c = document.createElement("canvas");
    c.width = width; c.height = Math.round((width * H) / W);
    const ctx = c.getContext("2d")!;
    ctx.scale(width / W, width / W);
    drawTrack(ctx, track, true);
    return c.toDataURL("image/png");
  }
}

/** Draw a whole track. `quick` skips texture and decorations (thumbnails). */
export function drawTrack(ctx: CanvasRenderingContext2D, t: TrackDef, quick: boolean) {
  const th = t.theme, P = t.pts, n = P.length, seed = hashStr(t.id);
  const r = rng(seed);
  if (quick) { ctx.fillStyle = th.ground[0]; ctx.fillRect(0, 0, W, H); }
  else paintGrass(ctx, W, H, th.ground[0], th.ground[1], th.ground[2]);
  if (!quick) for (const o of t.obstacles) drawDeco(ctx, o.kind, o.x, o.y, o.seed, o.s);
  if (!t.walls) drawBarrier(ctx, quick);

  // Road = overlapping discs along the centerline: ink border first, then the
  // surface. Where the road crosses itself the union stays clean. An open
  // track gets a soft, low verge instead of an inked wall.
  const wob = (i: number, k: number) => 1.6 * Math.sin(i * 0.11 + k) + 1.1 * Math.sin(i * 0.037 + 2 * k);
  ctx.fillStyle = t.walls ? INK : "rgba(38,32,26,0.28)";
  const rim = t.walls ? 7 : 4;
  for (let i = 0; i < n; i++) { const p = P[i]; ctx.beginPath(); ctx.arc(p.x, p.y, p.hw + rim + wob(i, seed % 7), 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = th.road;
  for (let i = 0; i < n; i++) { const p = P[i]; ctx.beginPath(); ctx.arc(p.x, p.y, p.hw + wob(i, 3) * 0.4, 0, Math.PI * 2); ctx.fill(); }

  if (!quick) {
    // surface texture
    ctx.fillStyle = th.speck;
    for (let k = 0; k < 1400; k++) {
      const p = P[Math.floor(r() * n)], a = r() * Math.PI * 2, d = r() * (p.hw - 4);
      const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
      if (t.grip < 1) { // ice: skate scratches
        ctx.strokeStyle = th.speck; ctx.lineWidth = 1.2;
        const la = r() * Math.PI; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(la) * 12, y + Math.sin(la) * 12); ctx.stroke();
      } else { ctx.beginPath(); ctx.arc(x, y, 0.8 + r() * 1.8, 0, Math.PI * 2); ctx.fill(); }
    }
    // kerbs on the bends (not where another part of the road passes)
    for (let i = 0; i < n; i += 2) {
      const p = P[i];
      if (Math.abs(p.k) < 0.0055) continue;
      for (const side of [-1, 1]) {
        // The inside edge of a bend tighter than the road folds over itself — no kerb there.
        if (side === Math.sign(p.k) && 1 / Math.abs(p.k) < p.hw + 14) continue;
        const x = p.x + p.nx * side * (p.hw - 5), y = p.y + p.ny * side * (p.hw - 5);
        if (roadGap(t, x, y, i) < 4) continue;
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(p.ty, p.tx));
        ctx.fillStyle = th.kerb[(i / 2) % 2]; ctx.fillRect(-8, -4, 16, 8);
        ctx.restore();
      }
    }
  }
  // sand / snow drifts
  for (const s of t.sand) {
    const col = t.grip < 1 ? "#f7fbff" : t.id === "snake" ? "#f3e1b3" : "#e6cf98";
    inkShape(ctx, sampleEllipse(s.x, s.y, s.r, s.r * 0.86, 18), 3, hashStr(`s${s.x}`), col, "rgba(38,32,26,0.55)", 1.5);
    if (!quick) {
      ctx.fillStyle = t.grip < 1 ? "rgba(150,180,210,0.5)" : "rgba(150,110,60,0.35)";
      for (let k = 0; k < 18; k++) { const a = r() * Math.PI * 2, d = r() * s.r * 0.8; ctx.beginPath(); ctx.arc(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d * 0.86, 1.4, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  for (const o of t.oil) drawOil(ctx, o.x, o.y, o.r);
  // direction chevrons down the middle
  ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 3.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (let i = 6; i < n; i += 15) {
    const p = P[i];
    if (roadGap(t, p.x, p.y, i) < -10 && !quick) continue; // skip inside crossings
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.atan2(p.ty, p.tx));
    ctx.beginPath(); ctx.moveTo(-6, -9); ctx.lineTo(4, 0); ctx.lineTo(-6, 9); ctx.stroke();
    ctx.restore();
  }
  for (const b of t.boosts) drawBoost(ctx, b.x, b.y, b.a, b.len, b.w);
  for (const b of t.bumps) drawBump(ctx, b.x1, b.y1, b.x2, b.y2);
  if (!quick) for (const g of t.gates.slice(1)) {
    if (t.checkerLines) drawChecker(ctx, t.pts[g.i], 7, g.i);
    drawCheckpoint(ctx, t, g);
  }
  drawChecker(ctx, t.pts[0], 11, 42); // start / finish line
}

/** Open tracks: a tyre-and-plank barrier along the screen edge — the one wall left. */
function drawBarrier(ctx: CanvasRenderingContext2D, quick: boolean) {
  const { x0, y0, x1, y1 } = BOUNDS;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK; ctx.lineWidth = quick ? 8 : 7;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  if (!quick) {
    ctx.setLineDash([22, 22]); ctx.strokeStyle = "#d8453b"; ctx.lineWidth = 4;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
  ctx.restore();
}

/** A dashed chalk line along a checkpoint gate (open tracks, missed checkpoints, dev overlay). */
export function drawGateLine(ctx: CanvasRenderingContext2D, g: Gate, color: string, time = 0) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = "round";
  ctx.setLineDash([10, 9]); ctx.lineDashOffset = -time * 30;
  ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); ctx.stroke();
  ctx.restore();
}

/** Speed bump: a yellow-and-black ridge across the road. */
function drawBump(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  const len = Math.hypot(x2 - x1, y2 - y1), a = Math.atan2(y2 - y1, x2 - x1);
  ctx.save(); ctx.translate((x1 + x2) / 2, (y1 + y2) / 2); ctx.rotate(a);
  ctx.fillStyle = "rgba(0,0,0,0.22)"; ctx.fillRect(-len / 2, 2, len, 10);
  inkShape(ctx, sampleRoundRect(-len / 2, -6, len, 12, 5, 12), 0.6, hashStr(`bump${x1}`), "#FFD600", INK, 2);
  ctx.fillStyle = INK;
  for (let x = -len / 2 + 6; x < len / 2 - 8; x += 16) {
    ctx.beginPath(); ctx.moveTo(x, -5); ctx.lineTo(x + 7, -5); ctx.lineTo(x + 2, 5); ctx.lineTo(x - 5, 5); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawDeco(ctx: CanvasRenderingContext2D, kind: DecoKind, x: number, y: number, seed: number, s: number) {
  const r = rng(seed);
  const shadow = (rx: number, ry: number) => { ctx.fillStyle = "rgba(0,0,0,0.15)"; ctx.beginPath(); ctx.ellipse(x + 4, y + 5, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); };
  switch (kind) {
    case "tree":
      shadow(20 * s, 12 * s);
      inkShape(ctx, sampleEllipse(x, y, 20 * s, 18 * s, 14), 3, seed, "#3f7d2c", INK, 2);
      inkShape(ctx, sampleEllipse(x - 5 * s, y - 5 * s, 9 * s, 7 * s, 10), 1.5, seed + 1, "#5a9c3c", INK, 0);
      break;
    case "pine":
      shadow(14 * s, 9 * s);
      for (const [dy, rr, col] of [[4, 16, "#2f5d3a"], [-4, 11, "#3d7349"], [-11, 6, "#4d8a5a"]] as [number, number, string][]) {
        ctx.fillStyle = col; ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, y + dy * s - rr * s); ctx.lineTo(x + rr * s, y + dy * s + rr * 0.6 * s); ctx.lineTo(x - rr * s, y + dy * s + rr * 0.6 * s); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.beginPath(); ctx.arc(x, y - 16 * s, 3 * s, 0, Math.PI * 2); ctx.fill();
      break;
    case "rock":
      shadow(16 * s, 10 * s);
      inkShape(ctx, sampleEllipse(x, y, 16 * s, 11 * s, 9), 3.5, seed, "#8d8579", INK, 2);
      ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 8 * s, y - 5 * s); ctx.lineTo(x + 2 * s, y - 7 * s); ctx.stroke();
      break;
    case "cactus":
      shadow(10 * s, 6 * s);
      inkShape(ctx, sampleRoundRect(x - 5 * s, y - 22 * s, 10 * s, 26 * s, 5 * s), 1, seed, "#4f8a43", INK, 2);
      inkShape(ctx, sampleRoundRect(x + 4 * s, y - 14 * s, 9 * s, 6 * s, 3 * s), 0.6, seed + 1, "#4f8a43", INK, 1.5);
      inkShape(ctx, sampleRoundRect(x - 13 * s, y - 10 * s, 9 * s, 6 * s, 3 * s), 0.6, seed + 2, "#4f8a43", INK, 1.5);
      break;
    case "snowman":
      shadow(12 * s, 7 * s);
      inkShape(ctx, sampleEllipse(x, y, 11 * s, 10 * s, 12), 1, seed, "#ffffff", INK, 1.8);
      inkShape(ctx, sampleEllipse(x, y - 14 * s, 7 * s, 7 * s, 10), 1, seed + 1, "#ffffff", INK, 1.8);
      ctx.fillStyle = "#ff7a1a"; ctx.beginPath(); ctx.moveTo(x, y - 14 * s); ctx.lineTo(x + 7 * s, y - 13 * s); ctx.lineTo(x, y - 12 * s); ctx.fill();
      break;
    case "tyres":
      shadow(16 * s, 10 * s);
      for (const [dx, dy] of [[-8, 2], [8, 2], [0, -8]]) {
        inkShape(ctx, sampleEllipse(x + dx * s, y + dy * s, 9 * s, 9 * s, 12), 0.8, seed + dx, "#2f2a2a", INK, 1.5);
        ctx.fillStyle = "#6d6a4a"; ctx.beginPath(); ctx.arc(x + dx * s, y + dy * s, 3.5 * s, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case "crate":
      shadow(14 * s, 9 * s);
      ctx.save(); ctx.translate(x, y); ctx.rotate((r() - 0.5) * 0.7);
      inkShape(ctx, sampleRoundRect(-13 * s, -12 * s, 26 * s, 24 * s, 3), 1, seed, "#a8742f", INK, 2.2);
      ctx.strokeStyle = INK; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(-11 * s, -10 * s); ctx.lineTo(11 * s, 10 * s); ctx.moveTo(11 * s, -10 * s); ctx.lineTo(-11 * s, 10 * s); ctx.stroke();
      ctx.restore();
      break;
    case "cone":
      shadow(8 * s, 5 * s);
      ctx.fillStyle = "#ff7a1a"; ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y - 13 * s); ctx.lineTo(x + 7 * s, y + 5 * s); ctx.lineTo(x - 7 * s, y + 5 * s); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.fillRect(x - 4 * s, y - 4 * s, 8 * s, 3 * s);
      break;
  }
}

function drawOil(ctx: CanvasRenderingContext2D, x: number, y: number, rad: number) {
  inkShape(ctx, sampleEllipse(x, y, rad, rad * 0.78, 20), 3.5, hashStr(`oil${x}`), "#221d26", INK, 2);
  ctx.save(); ctx.globalAlpha = 0.35; ctx.lineWidth = 3; ctx.lineCap = "round";
  ["#7b61ff", "#2ec4b6", "#ffd166"].forEach((col, i) => {
    ctx.strokeStyle = col; ctx.beginPath();
    ctx.ellipse(x - rad * 0.15 + i * 4, y - rad * 0.12 + i * 3, rad * (0.55 - i * 0.12), rad * (0.3 - i * 0.06), -0.4, Math.PI * 1.1, Math.PI * 1.8);
    ctx.stroke();
  });
  ctx.restore();
}

function drawBoost(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, len: number, w: number) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(a);
  inkShape(ctx, sampleRoundRect(-len / 2, -w / 2, len, w, 6), 1, hashStr(`b${x}`), "#FFB300", INK, 2.5);
  ctx.strokeStyle = "#fff8e1"; ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const dx of [-12, 8]) { ctx.beginPath(); ctx.moveTo(dx - 7, -w * 0.28); ctx.lineTo(dx + 7, 0); ctx.lineTo(dx - 7, w * 0.28); ctx.stroke(); }
  ctx.restore();
}

/** A checkpoint: a little flag on each side of the road (spots chosen off the tarmac in tracks.ts). */
function drawCheckpoint(ctx: CanvasRenderingContext2D, t: TrackDef, g: Gate) {
  const p = t.pts[g.i], fwd = Math.atan2(p.ty, p.tx);
  for (const { x, y } of g.flags) {
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.beginPath(); ctx.ellipse(3, 3, 5, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(0, -20); ctx.stroke();
    const dir = Math.cos(fwd) >= 0 ? 1 : -1; // pennant streams the way the race goes
    ctx.fillStyle = t.theme.kerb[0]; ctx.strokeStyle = INK; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(13 * dir, -15); ctx.lineTo(0, -10); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}

/** Inked two-row checker strip across the road at a centerline point (start line, and checkpoints if enabled). */
function drawChecker(ctx: CanvasRenderingContext2D, p: TrackDef["pts"][number], bz: number, seed: number) {
  const rows = Math.floor((p.hw * 2 - 4) / bz);
  ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.atan2(p.ty, p.tx) + Math.PI / 2);
  const r = rng(seed), x0 = -(rows * bz) / 2;
  for (let row = 0; row < rows; row++) for (let col = 0; col < 2; col++) {
    ctx.fillStyle = (row + col) % 2 === 0 ? "#f4efe2" : INK;
    ctx.fillRect(x0 + row * bz + (r() - 0.5), -bz + col * bz + (r() - 0.5), bz, bz);
  }
  inkShape(ctx, sampleRoundRect(x0 - 1, -bz - 1, rows * bz + 2, bz * 2 + 2, 1, 6), 0.8, seed + 35, null, INK, 1.5);
  ctx.restore();
}

export function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
