// Hand-drawn top-down car art, shared by the race renderer and the car
// pictures in the lobby / phone car picker. Cars face +x, centred on the
// origin; `w` is the length and `h` the width (the physics footprint — wheels,
// spoilers and bumpers may poke out a little).

import { CAR_CFGS } from "./cars";
import type { CarType } from "./protocol";
import { INK, hashStr, inkShape, roughPath, rng, sampleRoundRect, type Pt } from "./sketch";

const WINDOW = "rgba(196,228,242,0.92)";

/** Subdivide a polygon's edges so the ink wobble looks hand-drawn, not faceted. */
function densify(pts: Pt[], per = 4): Pt[] {
  const out: Pt[] = [];
  pts.forEach(([x0, y0], i) => {
    const [x1, y1] = pts[(i + 1) % pts.length];
    for (let k = 0; k < per; k++) out.push([x0 + ((x1 - x0) * k) / per, y0 + ((y1 - y0) * k) / per]);
  });
  return out;
}

function bodyShape(type: CarType, w: number, h: number): Pt[] {
  switch (type) {
    case "sport": // low wedge: wide hips, tapered nose
      return densify([[-w * 0.5, -h * 0.42], [-w * 0.44, -h * 0.5], [w * 0.16, -h * 0.5], [w * 0.42, -h * 0.34], [w * 0.5, -h * 0.16],
        [w * 0.5, h * 0.16], [w * 0.42, h * 0.34], [w * 0.16, h * 0.5], [-w * 0.44, h * 0.5], [-w * 0.5, h * 0.42]]);
    case "kart": return sampleRoundRect(-w * 0.42, -h * 0.3, w * 0.84, h * 0.6, 4);
    case "truck": return sampleRoundRect(-w * 0.46, -h * 0.34, w * 0.92, h * 0.68, 5);
    case "muscle": return sampleRoundRect(-w / 2, -h / 2, w, h, 4);
    case "rc": return sampleRoundRect(-w / 2, -h / 2, w, h, 5);
    default: return sampleRoundRect(-w / 2, -h / 2, w, h, 6);
  }
}

/** [x, y, length, width] of each wheel, centred. */
function wheelBoxes(type: CarType, w: number, h: number): [number, number, number, number][] {
  switch (type) {
    case "kart": return [[w * 0.32, h * 0.46, w * 0.22, h * 0.3], [w * 0.32, -h * 0.46, w * 0.22, h * 0.3], [-w * 0.3, h * 0.46, w * 0.26, h * 0.34], [-w * 0.3, -h * 0.46, w * 0.26, h * 0.34]];
    case "truck": return [[w * 0.28, h * 0.4, w * 0.28, h * 0.34], [w * 0.28, -h * 0.4, w * 0.28, h * 0.34], [-w * 0.3, h * 0.4, w * 0.28, h * 0.34], [-w * 0.3, -h * 0.4, w * 0.28, h * 0.34]];
    case "muscle": return [[w * 0.28, h * 0.46, w * 0.2, h * 0.3], [w * 0.28, -h * 0.46, w * 0.2, h * 0.3], [-w * 0.3, h * 0.46, w * 0.22, h * 0.4], [-w * 0.3, -h * 0.46, w * 0.22, h * 0.4]];
    default: return [[w * 0.28, h * 0.46, w * 0.2, h * 0.32], [w * 0.28, -h * 0.46, w * 0.2, h * 0.32], [-w * 0.32, h * 0.46, w * 0.2, h * 0.32], [-w * 0.32, -h * 0.46, w * 0.2, h * 0.32]];
  }
}

const dot = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) => {
  ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
};
const line = (ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, lw: number, col: string) => {
  ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
};

/** Draw one car (shadow, wheels, body, details) at the origin facing +x. */
/** `ink` scales the outline weight and wobble (pictures drawn large use a finer pen). */
export function drawCarArt(ctx: CanvasRenderingContext2D, type: CarType, color: string, w: number, h: number, seed: number, brake = false, ink = 1) {
  const body = bodyShape(type, w, h);
  const lift = type === "truck" ? 7 : 4; // monster trucks sit high: longer shadow

  // soft drop shadow
  ctx.save(); ctx.translate(lift - 1, lift); ctx.globalAlpha *= 0.2;
  inkShape(ctx, type === "kart" || type === "truck" ? sampleRoundRect(-w / 2, -h / 2, w, h, 6) : body, 1, seed + 8, "#000", INK, 0);
  ctx.restore();

  // wheels
  for (const [wx, wy, wl, ww] of wheelBoxes(type, w, h)) {
    inkShape(ctx, sampleRoundRect(wx - wl / 2, wy - ww / 2, wl, ww, 2), 0.7, seed + 3, INK, INK, 0);
    if (type === "truck") for (const f of [-0.25, 0, 0.25]) line(ctx, wx + wl * f, wy - ww * 0.4, wx + wl * f, wy + ww * 0.4, 1.2, "rgba(255,255,255,0.25)");
  }
  if (type === "kart") { // axles
    line(ctx, w * 0.32, -h * 0.46, w * 0.32, h * 0.46, 2.2, INK);
    line(ctx, -w * 0.3, -h * 0.46, -w * 0.3, h * 0.46, 2.2, INK);
  }

  // body + cel shadow on the lower half + top highlight
  inkShape(ctx, body, 1.3 * ink, seed + 1, color, INK, Math.max(2.2, w * 0.09) * ink);
  ctx.save();
  roughPath(ctx, body, 0, rng(0)); ctx.clip();
  ctx.globalAlpha *= 0.16; ctx.fillStyle = "#000"; ctx.fillRect(-w, h * 0.04, w * 2, h);
  ctx.restore();
  if (type !== "kart") line(ctx, -w * 0.32, -h * (type === "truck" ? 0.24 : 0.32), w * 0.26, -h * (type === "truck" ? 0.24 : 0.32), Math.max(1.5, w * 0.05), "rgba(255,255,255,0.5)");

  switch (type) {
    case "bus":
      for (const wx of [w * 0.2, -w * 0.02, -w * 0.24]) inkShape(ctx, sampleRoundRect(wx - w * 0.07, -h * 0.3, w * 0.14, h * 0.6, 2), 0.5, seed + 5, WINDOW, INK, 1.2);
      break;
    case "sport":
      for (const sy of [-h * 0.1, h * 0.1]) line(ctx, -w * 0.46, sy, w * 0.46, sy, Math.max(1.6, h * 0.08), "rgba(255,255,255,0.85)");
      inkShape(ctx, sampleRoundRect(-w * 0.1, -h * 0.3, w * 0.24, h * 0.6, 3), 0.5, seed + 5, WINDOW, INK, 1.2);
      // rear wing, a touch wider than the body
      inkShape(ctx, sampleRoundRect(-w * 0.53, -h * 0.56, w * 0.1, h * 1.12, 2), 0.5, seed + 6, INK, INK, 0);
      break;
    case "muscle":
      for (const sy of [-h * 0.13, h * 0.13]) line(ctx, -w * 0.48, sy, w * 0.48, sy, Math.max(2, h * 0.13), "rgba(255,255,255,0.85)");
      inkShape(ctx, sampleRoundRect(-w * 0.16, -h * 0.32, w * 0.24, h * 0.64, 2), 0.5, seed + 5, WINDOW, INK, 1.2);
      inkShape(ctx, sampleRoundRect(w * 0.2, -h * 0.13, w * 0.14, h * 0.26, 2), 0.4, seed + 6, "#3a3a3a", INK, 1.2); // hood scoop
      break;
    case "kart": {
      line(ctx, w * 0.5, -h * 0.4, w * 0.5, h * 0.4, 2.6, INK);                       // front bumper
      inkShape(ctx, sampleRoundRect(-w * 0.44, -h * 0.2, w * 0.16, h * 0.4, 2), 0.4, seed + 7, "#6d6a66", INK, 1.2); // engine
      line(ctx, w * 0.16, -h * 0.16, w * 0.16, h * 0.16, 2.2, INK);                   // steering wheel
      // driver's helmet with a visor facing forward
      inkShape(ctx, sampleRoundRect(-w * 0.2, -h * 0.24, h * 0.48, h * 0.48, h * 0.24), 0.5, seed + 5, "#fafafa", INK, 1.5);
      ctx.fillStyle = "#26323a"; ctx.beginPath(); ctx.arc(-w * 0.2 + h * 0.24, 0, h * 0.2, -1.0, 1.0); ctx.closePath(); ctx.fill();
      line(ctx, -w * 0.2 + h * 0.06, 0, -w * 0.2 + h * 0.22, 0, 1.6, color);          // helmet stripe
      break;
    }
    case "truck":
      inkShape(ctx, sampleRoundRect(-w * 0.12, -h * 0.26, w * 0.36, h * 0.52, 3), 0.5, seed + 6, "rgba(255,255,255,0.18)", INK, 1.4); // cab
      inkShape(ctx, sampleRoundRect(w * 0.14, -h * 0.24, w * 0.08, h * 0.48, 2), 0.4, seed + 5, WINDOW, INK, 1.1);                 // windshield
      for (const ly of [-h * 0.14, 0, h * 0.14]) dot(ctx, -w * 0.02, ly, Math.max(1.3, h * 0.05), "#FFD600");                        // roof lights
      for (const bx of [-w * 0.26, -w * 0.36]) line(ctx, bx, -h * 0.26, bx, h * 0.26, 1.2, "rgba(0,0,0,0.3)");                       // bed slats
      break;
    default:
      inkShape(ctx, sampleRoundRect(w * 0.03, -h * 0.32, w * 0.27, h * 0.64, 2), 0.6, seed + 5, WINDOW, INK, 1.2);
  }

  // headlights (front = +x) and brake lights
  if (type !== "kart") {
    const fx = type === "truck" ? w * 0.42 : w * 0.46, ly = type === "sport" ? h * 0.2 : type === "truck" ? h * 0.22 : h * 0.28;
    for (const wy of [ly, -ly]) dot(ctx, fx, wy, Math.max(1.4, w * 0.05), "#ffe9a8");
  }
  if (brake) {
    const bx = type === "truck" ? -w * 0.44 : type === "kart" ? -w * 0.4 : -w * 0.47;
    for (const wy of [h * 0.28, -h * 0.28]) dot(ctx, bx, wy * (type === "kart" ? 0.6 : 1), Math.max(1.4, w * 0.05), "#ff3b30");
  }
  if (type === "rc") { // antenna
    line(ctx, -w * 0.5, 0, -w * 0.78, -h * 0.6, 1.2, INK);
    dot(ctx, -w * 0.78, -h * 0.6, 2, "#FFD600");
  }
}

const icons = new Map<string, string>();

/**
 * Car picture for the lobby / picker, as a data URL (cached). Cars keep a hint
 * of their relative size — the RC car looks small next to the bus.
 */
export function carIcon(type: CarType, color: string, width = 120): string {
  const key = `${type}|${color}|${width}`;
  const hit = icons.get(key);
  if (hit) return hit;
  const cfg = CAR_CFGS[type], dpr = 2, height = Math.round(width * 0.6);
  const c = document.createElement("canvas");
  c.width = width * dpr; c.height = height * dpr;
  const ctx = c.getContext("2d")!;
  const s = (width * 0.78) / (22 + cfg.w * 0.5);
  ctx.setTransform(dpr * s, 0, 0, dpr * s, (width * dpr) / 2, (height * dpr) / 2);
  ctx.rotate(-0.22);
  drawCarArt(ctx, type, color, cfg.w, cfg.h, hashStr(type), false, Math.min(1, 0.9 / s));
  const url = c.toDataURL("image/png");
  icons.set(key, url);
  return url;
}
