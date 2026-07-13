// Hand-drawn ("inky storybook") rendering helpers for the canvas: deterministic
// wobble so outlines look pen-drawn without shimmering, plus prebaked paper and
// grass textures. Kept framework-free so the game loop can call them cheaply.

/** Deterministic PRNG (mulberry32) — seed by car id / shape so wobble is stable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export type Pt = [number, number];

export function sampleEllipse(cx: number, cy: number, rx: number, ry: number, n: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  return pts;
}

export function sampleRoundRect(x: number, y: number, w: number, h: number, r: number, per = 7): Pt[] {
  r = Math.min(r, w / 2, h / 2);
  const pts: Pt[] = [];
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    const steps = Math.max(2, Math.round(per / 2));
    for (let i = 0; i <= steps; i++) { const a = a0 + (a1 - a0) * (i / steps); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  };
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    for (let i = 1; i < per; i++) pts.push([x0 + (x1 - x0) * (i / per), y0 + (y1 - y0) * (i / per)]);
  };
  arc(x + w - r, y + r, -Math.PI / 2, 0); edge(x + w, y + r, x + w, y + h - r);
  arc(x + w - r, y + h - r, 0, Math.PI / 2); edge(x + w - r, y + h, x + r, y + h);
  arc(x + r, y + h - r, Math.PI / 2, Math.PI); edge(x, y + h - r, x, y + r);
  arc(x + r, y + r, Math.PI, Math.PI * 1.5); edge(x + r, y, x + w - r, y);
  return pts;
}

/** Trace a closed path, jittering each point by ±wob (seeded). Caller fills/strokes. */
export function roughPath(ctx: CanvasRenderingContext2D, pts: Pt[], wob: number, r: () => number) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pts[i];
    const x = px + (r() * 2 - 1) * wob, y = py + (r() * 2 - 1) * wob;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Fill + ink a wobbly shape in one go. */
export function inkShape(
  ctx: CanvasRenderingContext2D, pts: Pt[], wob: number, seed: number,
  fill: string | null, ink: string, lw: number,
) {
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  if (fill) { roughPath(ctx, pts, wob, rng(seed)); ctx.fillStyle = fill; ctx.fill(); }
  if (lw > 0) { roughPath(ctx, pts, wob, rng(seed + 1)); ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.stroke(); }
}

export const INK = "#26201a";

/** Subtle paper grain on a transparent canvas, drawn over the frame at low alpha. */
export function makePaper(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const r = rng(1234);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = r();
    if (n < 0.5) { img.data[i + 3] = 0; continue; }
    const dark = n < 0.75;
    img.data[i] = dark ? 60 : 255; img.data[i + 1] = dark ? 50 : 252; img.data[i + 2] = dark ? 40 : 240;
    img.data[i + 3] = Math.floor((n - 0.5) * (dark ? 26 : 16));
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Prebaked organic grass: base wash + seeded mottling + ink tufts. */
export function paintGrass(ctx: CanvasRenderingContext2D, w: number, h: number, base: string, dark: string, light: string) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  const r = rng(99);
  for (let i = 0; i < 240; i++) {
    const x = r() * w, y = r() * h, rad = 18 + r() * 60;
    ctx.globalAlpha = 0.05 + r() * 0.06;
    ctx.fillStyle = r() < 0.5 ? dark : light;
    ctx.beginPath(); ctx.ellipse(x, y, rad, rad * (0.5 + r() * 0.5), r() * Math.PI, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 0.5; ctx.strokeStyle = dark; ctx.lineCap = "round";
  for (let i = 0; i < 520; i++) {
    const x = r() * w, y = r() * h, len = 4 + r() * 6, lean = (r() * 2 - 1) * 3;
    ctx.lineWidth = 1 + r();
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + lean, y - len); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
