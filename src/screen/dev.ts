// Dev-build-only track editor + debug overlays (compiled in by `vite build
// --mode devtools`; the production build never includes this module).
//
// Edits are drafts kept in this browser (localStorage) and layered over the
// shipped track-edits.json, so you can try things — checkpoints, speed bumps,
// boost pads, sand, oil, scenery, ice grip, open tracks with no walls — in
// real races with real phones, then export the JSON and commit it.

import type { Renderer } from "./render";
import { drawGateLine } from "./render";
import type { Race } from "./sim";
import {
  BOUNDS, BUMP_LOSS, TRACKS, TRACK_EDITS, TRACK_ORDER, applyTrackEdits, edgeGap, lapFraction, lapIndex, lineIsClean, obstacleRadius,
  type Seg, type TrackDef, type TrackEdit, type TrackEdits, type TrackId,
} from "./tracks";

/** The parts of the big-screen app the editor drives. */
export interface DevHost {
  phase: string;
  trackId: TrackId;
  settings: { track: TrackId; mode: "single" | "cup" };
  stage: HTMLElement;
  renderer: Renderer;
  canStart(): boolean;
  addBot(save?: boolean): void;
  startRace(force?: boolean): void;
  saveSettings(): void;
  onTracksChanged(ids: TrackId[]): void;
  renderUI(): void;
}

/** Things you can place on a track, one tool each. */
type Kind = "checkpoint" | "bump" | "boost" | "sand" | "oil" | "scenery";
type Tool = Kind | "erase";
interface ToolInfo { id: Tool; key: string; icon: string; label: string; }
const TOOLS: ToolInfo[] = [
  { id: "checkpoint", key: "C", icon: "🚩", label: "Checkpoint" },
  { id: "bump", key: "B", icon: "▰", label: "Speed bump" },
  { id: "boost", key: "P", icon: "⚡", label: "Boost pad" },
  { id: "sand", key: "S", icon: "▒", label: "Sand / snow" },
  { id: "oil", key: "O", icon: "●", label: "Oil slick" },
  { id: "scenery", key: "T", icon: "🌲", label: "Scenery" },
  { id: "erase", key: "X", icon: "⌫", label: "Eraser" },
];
/** Which TrackEdit list holds each kind. */
const FIELD: Record<Kind, keyof TrackEdit> = { checkpoint: "checkpoints", bump: "bumps", boost: "boosts", sand: "sand", oil: "oil", scenery: "scenery" };
const NAMES: Record<Kind, [string, string]> = {
  checkpoint: ["Checkpoint", "Checkpoints"], bump: ["Speed bump", "Speed bumps"], boost: ["Boost pad", "Boost pads"],
  sand: ["Sand patch", "Sand / snow"], oil: ["Oil slick", "Oil slicks"], scenery: ["Scenery", "Scenery"],
};

interface Hit { kind: Kind; index: number; }
/** A draft field set to null means "back to the spec default", even if the shipped file sets it. */
type Draft = { [K in keyof TrackEdit]?: TrackEdit[K] | null };
type Drafts = Partial<Record<TrackId, Draft>>;

const DRAFT_KEY = "driftparty.dev.edits.v1";
const UI_KEY = "driftparty.dev.ui.v1";
const PANEL_W = 330;
const load = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100;
const inside = (x: number, y: number) => x > BOUNDS.x0 && x < BOUNDS.x1 && y > BOUNDS.y0 && y < BOUNDS.y1;
function segDist(px: number, py: number, g: Seg) {
  const ex = g.x2 - g.x1, ey = g.y2 - g.y1, u = Math.max(0, Math.min(1, ((px - g.x1) * ex + (py - g.y1) * ey) / (ex * ex + ey * ey || 1)));
  return Math.hypot(px - (g.x1 + ex * u), py - (g.y1 + ey * u));
}

export class DevTools {
  open: boolean;
  debug: boolean;
  tool: Tool;
  patchR: number;
  drafts: Drafts = load<Drafts>(DRAFT_KEY, {});
  hover: { x: number; y: number } | null = null;
  msg = "";
  panel: HTMLElement;
  private html = "";
  private pending: Draft | null = null;

  constructor(private host: DevHost) {
    const ui = load(UI_KEY, { open: false, debug: false, tool: "checkpoint" as Tool, patchR: 38 });
    this.open = ui.open; this.debug = ui.debug;
    this.tool = TOOLS.some((t) => t.id === ui.tool) ? ui.tool : "checkpoint";
    this.patchR = Math.min(70, Math.max(16, Number(ui.patchR) || 38));
    this.panel = document.createElement("div");
    this.panel.id = "dev";
    this.panel.style.cssText = `position:absolute;top:0;right:0;bottom:0;width:${PANEL_W}px;background:#f0ede4;border-left:3px solid #1a2a0a;overflow-y:auto;z-index:16;display:none;font-family:Caveat,cursive;color:#1a2a0a;padding:12px 14px 20px;box-shadow:-6px 0 24px rgba(0,0,0,0.35)`;
    document.getElementById("root")!.appendChild(this.panel);
    this.panel.addEventListener("click", (e) => this.onPanelClick(e));
    this.panel.addEventListener("input", (e) => this.onSlider(e, false));
    this.panel.addEventListener("change", (e) => this.onSlider(e, true));
    const canvas = document.getElementById("raceCanvas")!;
    canvas.addEventListener("mousemove", (e) => { if (this.editing) this.hover = this.host.renderer.toLogical(e.clientX, e.clientY); });
    canvas.addEventListener("mouseleave", () => { this.hover = null; });
    canvas.addEventListener("click", (e) => this.onCanvasClick(e));
    window.addEventListener("resize", () => this.fitStage());
    this.apply();
  }

  get editing() { return this.open && this.host.phase === "LOBBY"; }
  get id(): TrackId { return this.host.trackId; }
  get track(): TrackDef { return TRACKS[this.id]; }

  // ── edits ────────────────────────────────────────────────────────────────
  /** Shipped edits with this browser's drafts on top. */
  effective(): TrackEdits {
    const out: TrackEdits = {};
    for (const id of TRACK_ORDER) {
      const e: Record<string, unknown> = { ...(TRACK_EDITS[id] ?? {}) };
      for (const [k, v] of Object.entries(this.drafts[id] ?? {})) { if (v === null) delete e[k]; else e[k] = v; }
      if (Object.keys(e).length) out[id] = e as TrackEdit;
    }
    return out;
  }

  /** Rebuild tracks from the current edits and tell the screen what changed. */
  apply() {
    const changed = applyTrackEdits(this.effective());
    if (changed.length) this.host.onTracksChanged(changed);
  }

  set(patch: Draft, final = true) {
    this.drafts[this.id] = { ...(this.drafts[this.id] ?? {}), ...patch };
    save(DRAFT_KEY, this.drafts);
    this.apply();
    if (final) this.render(true);
  }

  saveUI() { save(UI_KEY, { open: this.open, debug: this.debug, tool: this.tool, patchR: this.patchR }); }

  /** The current list for a kind, in the form its TrackEdit field stores. */
  private list(kind: Kind): unknown[] {
    const t = this.track;
    switch (kind) {
      case "checkpoint": return t.gates.slice(1).map((g) => lapFraction(t, g.i));
      case "bump": return t.bumps.map((b) => lapFraction(t, b.i));
      case "boost": return t.boosts.map((p) => ({ at: lapFraction(t, p.i), off: r2(p.off) }));
      case "sand": return t.sand.map((c) => ({ x: r1(c.x), y: r1(c.y), r: c.r }));
      case "oil": return t.oil.map((c) => ({ x: r1(c.x), y: r1(c.y), r: c.r }));
      case "scenery": return t.obstacles.map((o) => ({ x: r1(o.x), y: r1(o.y), kind: o.kind, s: r2(o.s) }));
    }
  }
  private count(kind: Kind) { return this.list(kind).length; }
  /** Is this kind's list edited (by a draft or the shipped file)? */
  private edited(kind: Kind) { return (this.effective()[this.id] as Record<string, unknown> | undefined)?.[FIELD[kind]] !== undefined; }

  private setList(kind: Kind, next: unknown[]) {
    const sorted = kind === "checkpoint" || kind === "bump" ? (next as number[]).sort((a, b) => a - b) : next;
    this.set({ [FIELD[kind]]: sorted } as Draft);
  }

  // ── open / close / test ──────────────────────────────────────────────────
  toggle(open = !this.open) {
    this.open = open;
    this.hover = null;
    this.saveUI();
    this.host.renderUI();
  }

  toggleDebug() { this.debug = !this.debug; this.saveUI(); this.render(true); }

  selectTrack(id: TrackId) {
    this.host.settings.track = id;
    this.host.settings.mode = "single";
    this.host.saveSettings();
    this.host.trackId = id;
    this.host.renderer.setTrack(TRACKS[id]);
    this.msg = "";
    this.render(true);
  }

  setTool(tool: Tool) { this.tool = tool; this.msg = ""; this.saveUI(); this.render(true); }

  /** Race this track now with whoever is in the lobby (adds bots if nobody is). */
  testDrive() {
    this.selectTrack(this.id);
    if (!this.host.canStart()) for (let i = 0; i < 3; i++) this.host.addBot(false);
    this.host.startRace(true);
  }

  // ── keys ─────────────────────────────────────────────────────────────────
  /** Returns true when the key was a dev shortcut. */
  onKey(e: KeyboardEvent): boolean {
    if (e.code === "KeyG") { this.toggleDebug(); return true; }
    if (e.code === "KeyE" && this.host.phase === "LOBBY") { this.toggle(); return true; }
    if (!this.editing) return false;
    const tool = TOOLS.find((t) => `Key${t.key}` === e.code);
    if (tool) { this.setTool(tool.id); return true; }
    if (e.code === "Escape") { this.toggle(false); return true; }
    if (e.code === "Enter" || e.code === "NumpadEnter") { this.testDrive(); return true; }
    return false;
  }

  // ── canvas editing ───────────────────────────────────────────────────────
  /** Nearest centerline index to a point, if the point is on (or right next to) the road. */
  private roadAt(x: number, y: number): number | null {
    const P = this.track.pts;
    let best = -1, bd = Infinity;
    for (let j = 0; j < P.length; j++) { const d = Math.hypot(P[j].x - x, P[j].y - y) - P[j].hw; if (d < bd) { bd = d; best = j; } }
    return bd <= 18 ? best : null;
  }

  private arcGap(a: number, b: number) { const n = this.track.pts.length, d = Math.abs(a - b) % n; return Math.min(d, n - d) * 8; }

  /** Everything under a point, most specific first (what the eraser takes). */
  private hitsAt(x: number, y: number): Hit[] {
    const t = this.track, out: Hit[] = [];
    t.gates.slice(1).forEach((g, k) => {
      if (segDist(x, y, g) < 14 || g.flags.some((f) => Math.hypot(f.x - x, f.y - 10 - y) < 16)) out.push({ kind: "checkpoint", index: k });
    });
    t.bumps.forEach((b, k) => { if (segDist(x, y, b) < 12) out.push({ kind: "bump", index: k }); });
    t.boosts.forEach((p, k) => {
      const dx = x - p.x, dy = y - p.y, ca = Math.cos(p.a), sa = Math.sin(p.a);
      if (Math.abs(dx * ca + dy * sa) < p.len / 2 + 6 && Math.abs(-dx * sa + dy * ca) < p.w / 2 + 6) out.push({ kind: "boost", index: k });
    });
    t.oil.forEach((c, k) => { if (Math.hypot(c.x - x, c.y - y) < c.r) out.push({ kind: "oil", index: k }); });
    t.sand.forEach((c, k) => { if (Math.hypot(c.x - x, c.y - y) < c.r) out.push({ kind: "sand", index: k }); });
    t.obstacles.forEach((o, k) => { if (Math.hypot(o.x - x, o.y - y) < o.r + 6) out.push({ kind: "scenery", index: k }); });
    return out;
  }

  /** What clicking here would do with the current tool. */
  private intent(x: number, y: number): { remove: Hit } | { add: unknown } | { error: string } | null {
    const hits = this.hitsAt(x, y);
    if (this.tool === "erase") return hits[0] ? { remove: hits[0] } : null;
    const kind = this.tool, same = hits.find((h) => h.kind === kind);
    if (same) return { remove: same };
    const t = this.track;
    if (kind === "checkpoint" || kind === "bump" || kind === "boost") {
      const i = this.roadAt(x, y);
      if (i === null) return { error: "Click on the road." };
      if (!lineIsClean(t, i)) return { error: "Not where the road crosses itself — pick a clean stretch." };
      if (kind === "checkpoint" && this.arcGap(i, 0) < 60) return { error: "Too close to the start line." };
      if (kind === "bump" && this.arcGap(i, 0) < 40) return { error: "Too close to the start line." };
      if (kind === "checkpoint" && t.gates.slice(1).some((g) => this.arcGap(g.i, i) < 50)) return { error: "Too close to another checkpoint." };
      if (kind === "boost") {
        const c = t.pts[i], off = Math.max(-0.55, Math.min(0.55, ((x - c.x) * c.nx + (y - c.y) * c.ny) / c.hw));
        return { add: { at: lapFraction(t, i), off: r2(off) } };
      }
      return { add: lapFraction(t, i) };
    }
    if (!inside(x, y)) return { error: "Keep it inside the screen." };
    if (kind === "sand" || kind === "oil") return { add: { x: r1(x), y: r1(y), r: this.patchR } };
    const deco = t.theme.deco[this.count("scenery") % t.theme.deco.length];
    if (edgeGap(t, x, y) < obstacleRadius(deco, 1) + 4) return { error: "Scenery goes off the road." };
    return { add: { x: r1(x), y: r1(y), kind: deco, s: 1 } };
  }

  private onCanvasClick(e: MouseEvent) {
    if (!this.editing) return;
    const p = this.host.renderer.toLogical(e.clientX, e.clientY), it = this.intent(p.x, p.y);
    if (!it) { this.msg = "Nothing to remove here."; this.render(true); return; }
    if ("error" in it) { this.msg = it.error; this.render(true); return; }
    if ("remove" in it) {
      const { kind, index } = it.remove;
      this.msg = `${NAMES[kind][0]} removed.`;
      this.setList(kind, this.list(kind).filter((_, j) => j !== index));
      return;
    }
    const kind = this.tool as Kind;
    this.msg = `${NAMES[kind][0]} added.`;
    this.setList(kind, [...this.list(kind), it.add]);
  }

  // ── overlays ─────────────────────────────────────────────────────────────
  /** Editor view: numbered checkpoints and bumps, plus what a click would do. */
  editorOverlay = (ctx: CanvasRenderingContext2D) => {
    const t = this.track, time = performance.now() / 1000;
    this.drawGates(ctx, t, time);
    t.bumps.forEach((b, k) => this.tag(ctx, (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2 - 16, `B${k + 1}`, "#1a2a0a", "#FFD600"));
    const h = this.hover;
    if (!h) return;
    const it = this.intent(h.x, h.y);
    ctx.save();
    ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.setLineDash([8, 6]);
    if (it && "remove" in it) {
      ctx.strokeStyle = "#E63946";
      this.outline(ctx, it.remove);
      ctx.restore();
      this.tag(ctx, h.x, h.y - 26, `✕ remove ${NAMES[it.remove.kind][0].toLowerCase()}`, "#fff", "#E63946");
      return;
    }
    if (it && "error" in it) { ctx.restore(); this.tag(ctx, h.x, h.y - 26, it.error, "#fff", "rgba(0,0,0,0.75)"); return; }
    if (it && "add" in it) {
      ctx.strokeStyle = "#2E7D32";
      const a = it.add as any, kind = this.tool as Kind;
      if (kind === "checkpoint" || kind === "bump") {
        const c = t.pts[lapIndex(t, a)], r = c.hw + 12;
        ctx.setLineDash([]); ctx.lineWidth = 6; ctx.globalAlpha = 0.8;
        ctx.beginPath(); ctx.moveTo(c.x - c.nx * r, c.y - c.ny * r); ctx.lineTo(c.x + c.nx * r, c.y + c.ny * r); ctx.stroke();
      } else if (kind === "boost") {
        const c = t.pts[lapIndex(t, a.at)];
        ctx.translate(c.x + c.nx * a.off * c.hw, c.y + c.ny * a.off * c.hw); ctx.rotate(Math.atan2(c.ty, c.tx));
        ctx.strokeRect(-28, -Math.min(70, c.hw * 1.1) / 2, 56, Math.min(70, c.hw * 1.1));
      } else {
        const r = kind === "scenery" ? obstacleRadius(a.kind, 1) : a.r;
        ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
      const what = this.tool === "scenery" ? a.kind : NAMES[this.tool as Kind][0].toLowerCase();
      this.tag(ctx, h.x, h.y - 26, `+ ${what}`, "#fff", "#2E7D32");
      return;
    }
    ctx.restore();
  };

  /** Outline one placed item (for "click to remove"). */
  private outline(ctx: CanvasRenderingContext2D, hit: Hit) {
    const t = this.track;
    const line = (g: Seg) => { ctx.setLineDash([]); ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); ctx.stroke(); };
    const ring = (x: number, y: number, r: number) => { ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.stroke(); };
    switch (hit.kind) {
      case "checkpoint": line(t.gates[hit.index + 1]); break;
      case "bump": line(t.bumps[hit.index]); break;
      case "boost": { const p = t.boosts[hit.index]; ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.strokeRect(-p.len / 2 - 3, -p.w / 2 - 3, p.len + 6, p.w + 6); break; }
      case "sand": { const c = t.sand[hit.index]; ring(c.x, c.y, c.r); break; }
      case "oil": { const c = t.oil[hit.index]; ring(c.x, c.y, c.r); break; }
      case "scenery": { const o = t.obstacles[hit.index]; ring(o.x, o.y, o.r); break; }
    }
  }

  /** Race view (G): every checkpoint line, and a thread from each car to the checkpoint it needs next. */
  raceOverlay(race: Race | null): ((ctx: CanvasRenderingContext2D) => void) | undefined {
    if (!this.debug || !race) return undefined;
    return (ctx) => {
      this.drawGates(ctx, race.track, race.time);
      for (const c of race.cars) {
        if (c.finished) continue;
        const g = race.track.gates[c.gatesPassed % race.track.gates.length];
        ctx.save(); ctx.strokeStyle = c.color; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.5; ctx.setLineDash([4, 5]);
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(g.mx, g.my); ctx.stroke(); ctx.restore();
      }
      this.tag(ctx, 800, 882, "DEV · G hides checkpoint lines", "#fff", "rgba(0,0,0,0.6)");
    };
  }

  private drawGates(ctx: CanvasRenderingContext2D, t: TrackDef, time: number) {
    t.gates.forEach((g, k) => {
      drawGateLine(ctx, g, k === 0 ? "rgba(255,255,255,0.9)" : "rgba(46,125,50,0.95)", time);
      this.tag(ctx, g.mx, g.my, k === 0 ? "S" : String(k), "#fff", k === 0 ? "#1a2a0a" : "#2E7D32");
    });
  }

  private tag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, fg: string, bg: string) {
    ctx.save();
    ctx.font = "700 16px Caveat, cursive";
    const w = ctx.measureText(text).width + 12;
    x = Math.max(w / 2 + 4, Math.min(1596 - w / 2, x));
    ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x - w / 2, y - 11, w, 22, 11); ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  // ── panel ────────────────────────────────────────────────────────────────
  private fitStage() {
    const st = this.host.stage;
    if (!this.editing) { st.style.transform = "translate(-50%,-50%)"; return; }
    const w = parseFloat(st.style.width) || 1, h = parseFloat(st.style.height) || 1;
    const k = Math.min(1, (window.innerWidth - PANEL_W - 16) / w, (window.innerHeight - 16) / h);
    st.style.transform = `translate(-50%,-50%) translateX(${-PANEL_W / 2}px) scale(${k})`;
  }

  /** Called by the screen whenever its UI re-renders. */
  render(force = false) {
    this.fitStage();
    this.panel.style.display = this.editing ? "block" : "none";
    if (!this.editing) return;
    const html = this.panelHTML();
    if (!force && html === this.html) return;
    const scroll = this.panel.scrollTop;
    this.html = html;
    this.panel.innerHTML = html;
    this.panel.scrollTop = scroll;
  }

  private onPanelClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest("[data-dev]") as HTMLElement | null;
    if (!el) return;
    const t = this.track, kind = el.dataset.kind as Kind | undefined;
    switch (el.dataset.dev) {
      case "close": this.toggle(false); return;
      case "track": this.selectTrack(el.dataset.track as TrackId); return;
      case "tool": this.setTool(el.dataset.tool as Tool); return;
      case "reset": if (kind) { this.set({ [FIELD[kind]]: null } as Draft); this.msg = `${NAMES[kind][1]} back to the track's own.`; } break;
      case "clear": if (kind) { this.set({ [FIELD[kind]]: [] } as Draft); this.msg = `All ${NAMES[kind][1].toLowerCase()} removed.`; } break;
      case "checker": this.set({ checkpointLines: el.dataset.on === "1" ? true : null }); break;
      case "walls": this.set({ walls: el.dataset.on === "1" ? null : false }); this.msg = el.dataset.on === "1" ? "Walls are back." : "Open track: drive anywhere — the screen edge is the wall."; break;
      case "discardTrack": delete this.drafts[this.id]; save(DRAFT_KEY, this.drafts); this.apply(); this.msg = `Draft edits for ${t.name} discarded.`; break;
      case "discardAll": this.drafts = {}; save(DRAFT_KEY, this.drafts); this.apply(); this.msg = "All draft edits discarded."; break;
      case "debug": this.toggleDebug(); return;
      case "test": this.testDrive(); return;
      case "copy": {
        navigator.clipboard?.writeText(this.exportJSON()).then(() => { this.msg = "Copied — paste it over src/screen/track-edits.json."; this.render(true); })
          .catch(() => { this.msg = "Clipboard blocked — use Download instead."; this.render(true); });
        return;
      }
      case "download": {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([this.exportJSON()], { type: "application/json" }));
        a.download = "track-edits.json"; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        this.msg = "Downloaded track-edits.json — it replaces src/screen/track-edits.json.";
        break;
      }
    }
    this.render(true);
  }

  /** Sliders: live preview while dragging (once a frame), saved when released. */
  private onSlider(e: Event, final: boolean) {
    const el = e.target as HTMLInputElement;
    const v = Number(el.value);
    if (el.dataset.ui === "patchR") {
      this.patchR = v;
      const out = this.panel.querySelector<HTMLElement>('[data-out="patchR"]');
      if (out) out.textContent = String(v);
      if (final) this.saveUI();
      return;
    }
    const key = el.dataset.edit as keyof TrackEdit | undefined;
    if (!key) return;
    const out = this.panel.querySelector<HTMLElement>(`[data-out="${key}"]`);
    if (out) out.textContent = v.toFixed(2);
    const patch: Draft = { [key]: v };
    if (final) { this.pending = null; this.set(patch); return; }
    if (!this.pending) requestAnimationFrame(() => { if (this.pending) { this.set(this.pending, false); this.pending = null; } });
    this.pending = patch;
  }

  exportJSON(): string { return JSON.stringify(this.effective(), null, 2) + "\n"; }

  private panelHTML(): string {
    const t = this.track, id = this.id;
    const d = this.drafts[id] ?? {}, dirty = Object.keys(d).length > 0;
    const anyDirty = JSON.stringify(this.effective()) !== JSON.stringify(TRACK_EDITS);
    const btn = (dev: string, label: string, on = false, extra = "") =>
      `<button data-dev="${dev}" ${extra} style="border:2px solid ${on ? "#1a2a0a" : "#d8d2bd"};background:${on ? "#1a2a0a" : "#fff"};color:${on ? "#FFD600" : "#333"};border-radius:9px;padding:4px 9px;font:700 17px Caveat,cursive;cursor:pointer">${label}</button>`;
    const mini = (dev: string, label: string, extra = "") =>
      `<button data-dev="${dev}" ${extra} style="border:1px solid #d8d2bd;background:#fff;color:#555;border-radius:7px;padding:1px 7px;font:700 15px Caveat,cursive;cursor:pointer">${label}</button>`;
    const h = (text: string) => `<div style="margin:14px 0 5px;font-size:21px;font-weight:700;border-bottom:2px dashed #d8d2bd">${text}</div>`;
    const hint = (text: string) => `<div style="font-size:15px;color:#7a7460;line-height:1.2;margin-top:3px">${text}</div>`;
    const slider = (key: string, label: string, min: number, max: number, step: number, value: number, note: string, attr = "data-edit") => `
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:18px;margin-top:8px">${label}<b data-out="${key}" style="font-family:sans-serif;font-size:14px">${attr === "data-edit" ? value.toFixed(2) : value}</b></div>
      <input type="range" ${attr}="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="width:100%;accent-color:#1a2a0a" />
      ${note ? hint(note) : ""}`;
    const tracks = TRACK_ORDER.map((k) => btn("track", TRACKS[k].name.split(" ")[0] + (this.drafts[k] && Object.keys(this.drafts[k]!).length ? " •" : ""), k === id, `data-track="${k}"`)).join(" ");
    const tools = TOOLS.map((tl) => btn("tool", `${tl.icon} ${tl.label} <span style="opacity:.55;font-size:14px">${tl.key}</span>`, this.tool === tl.id, `data-tool="${tl.id}"`)).join(" ");
    const kinds: Kind[] = ["checkpoint", "bump", "boost", "sand", "oil", "scenery"];
    const rows = kinds.map((k) => {
      const edited = this.edited(k), n = this.count(k);
      const status = k === "checkpoint" ? (t.autoGates ? "automatic" : "hand-placed") : k === "scenery" ? (t.manualScenery ? "hand-placed" : "automatic") : edited ? "edited" : "original";
      return `<div style="display:flex;align-items:center;gap:6px;font-size:17px;padding:2px 0">
        <span style="flex:1">${NAMES[k][1]} <b>${n}</b> <span style="color:#9a937c;font-size:14px">${status}</span></span>
        ${edited ? mini("reset", k === "checkpoint" ? "auto" : "reset", `data-kind="${k}"`) : ""}${n ? mini("clear", "clear", `data-kind="${k}"`) : ""}</div>`;
    }).join("");
    const toolHint = this.tool === "erase" ? "Click anything placed to remove it."
      : `Click to add a ${NAMES[this.tool][0].toLowerCase()} · click an existing one to remove it.`;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="font-size:28px;font-weight:700;line-height:1">🛠 Track editor</div>
        ${btn("close", "✕ Close")}
      </div>
      ${hint("Dev build only. Changes are drafts in this browser until you export them.")}
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px">${tracks}</div>

      ${h("Place & remove")}
      <div style="display:flex;flex-wrap:wrap;gap:5px">${tools}</div>
      ${hint(toolHint)}
      ${this.tool === "sand" || this.tool === "oil" ? slider("patchR", "New patch size", 16, 70, 2, this.patchR, "", "data-ui") : ""}
      ${this.msg ? `<div style="margin-top:6px;background:#fff;border-left:4px solid #FFB300;padding:4px 8px;font-size:16px;border-radius:6px">${esc(this.msg)}</div>` : ""}

      ${h("On this track")}
      ${rows}
      ${hint("reset = back to the track's own layout · clear = remove them all")}
      <div style="font-size:18px;margin-top:8px">Checkpoint look</div>
      <div style="display:flex;gap:6px;margin-top:3px">${btn("checker", "🚩 Flags", !t.checkpointLines, 'data-on="0"')} ${btn("checker", "🚩 Flags + red/white line", t.checkpointLines, 'data-on="1"')}</div>
      ${hint("Checkpoints must be crossed in order, on the road. Skip one (e.g. by cutting across the grass) and the lap doesn't count until you go back.")}
      ${slider("bumpLoss", "Speed bump: speed lost at full speed", 0.05, 0.7, 0.05, t.bumpLoss, `Default ${BUMP_LOSS}. Slower cars lose less; the Monster Truck barely notices.`)}

      ${h("Surface")}
      ${slider("grip", "Road grip", 0.1, 1.5, 0.05, t.grip, `1 = tarmac, lower = icier (this track's default is ${t.baseGrip.toFixed(2)}). Oil and drifting still reduce it further.`)}

      ${h("Boundaries")}
      <div style="display:flex;gap:6px">${btn("walls", "🧱 Walls", t.walls, 'data-on="1"')} ${btn("walls", "🌾 Open track", !t.walls, 'data-on="0"')}</div>
      ${t.walls ? hint("The road edge is a wall.") : `
        ${hint(`Drive anywhere — <b>${t.theme.terrain.name}</b> off the road slows you and loosens grip, the scenery is solid, and the screen edge is a hard wall.`)}
        ${slider("roughness", `Off-road penalty (${t.theme.terrain.name})`, 0, 2, 0.1, t.roughness, `1 = default: top speed ×${t.theme.terrain.slow} on the terrain. 0 = no penalty.`)}
        ${t.manualScenery ? hint(`Scenery is hand-placed (${t.obstacles.length}) — reset it above to go back to automatic.`)
          : slider("clutter", "Extra scenery near the road", 0, 3, 0.25, t.clutter, `Automatic scenery (${t.obstacles.length} now). Or place/remove pieces with the 🌲 tool.`)}`}

      ${h("Try it")}
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button data-dev="test" style="border:none;background:#FFD600;color:#1a2a0a;border-radius:11px;padding:8px 16px;font:700 22px Caveat,cursive;cursor:pointer;box-shadow:0 3px 0 #b8920a">▶ Test drive (Enter)</button>
        ${btn("debug", `Checkpoint lines in races: ${this.debug ? "on" : "off"} (G)`, this.debug)}
      </div>
      ${hint("Races this track with the phones and bots in the lobby (adds 3 bots if nobody's in). You come back here after.")}

      ${h("Save")}
      <div style="font-size:17px">${anyDirty ? "● Draft differs from what ships." : "No draft changes — this is what ships."}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px">
        ${btn("copy", "Copy JSON")} ${btn("download", "Download JSON")}
        ${dirty ? btn("discardTrack", `Discard ${t.name.split(" ")[0]} draft`) : ""}
        ${anyDirty ? btn("discardAll", "Discard all drafts") : ""}
      </div>
      ${hint("To ship: the exported JSON replaces <code>src/screen/track-edits.json</code>; commit it and it goes out with the next deploy.")}
      ${hint("Keys: E editor · C B P S O T X tools · Enter test drive · G checkpoint lines · Esc close")}`;
  }
}
