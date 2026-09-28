// Dev-build-only track editor + debug overlays (compiled in by `vite build
// --mode devtools`; the production build never includes this module).
//
// Edits are drafts kept in this browser (localStorage) and layered over the
// shipped track-edits.json, so you can try things — checkpoints, speed bumps,
// boost pads, sand, oil, scenery, ice grip, open tracks with no walls — in
// real races with real phones, then export the JSON and commit it.
//
// Click an item to select it: drag it to move it, and edit everything about
// it (size, strength, position…) in the panel. Click empty ground with a
// placement tool to add one; the eraser, Delete or the Remove button removes.

import type { Renderer } from "./render";
import { drawGateLine } from "./render";
import type { Race } from "./sim";
import {
  BOUNDS, BUMP_LOSS, TRACKS, TRACK_EDITS, TRACK_ORDER, applyTrackEdits, buildTrack, edgeGap, lapFraction, lapIndex, lineIsClean, obstacleRadius,
  type DecoKind, type Seg, type TrackDef, type TrackEdit, type TrackEdits, type TrackId,
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
const ALONG_LAP: Kind[] = ["checkpoint", "bump", "boost"]; // these slide along the road; the rest move freely
const DECO_KINDS: DecoKind[] = ["tree", "pine", "rock", "cactus", "snowman", "tyres", "crate", "cone"];

interface Hit { kind: Kind; index: number; }
/** An item as its TrackEdit list stores it (lap fraction, or an object). */
type Item = number | Record<string, unknown>;
/** A draft field set to null means "back to the spec default", even if the shipped file sets it. */
type Draft = { [K in keyof TrackEdit]?: TrackEdit[K] | null };
type Drafts = Partial<Record<TrackId, Draft>>;

const DRAFT_KEY = "driftparty.dev.edits.v1";
const UI_KEY = "driftparty.dev.ui.v1";
const PANEL_W = 340;
const SEL = "#1565C0"; // selection colour (steady — nothing in the editor blinks)
const load = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100;
const inside = (x: number, y: number) => x > BOUNDS.x0 && x < BOUNDS.x1 && y > BOUNDS.y0 && y < BOUNDS.y1;
const atOf = (it: Item) => (typeof it === "number" ? it : (it.at as number));
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
  sel: Hit | null = null;
  drag: { hit: Hit; sx: number; sy: number; x: number; y: number; moved: boolean } | null = null;
  msg = "";
  panel: HTMLElement;
  private html = "";
  private pending: (() => void) | null = null;
  private skipClick = false;
  private wasSelected = false; // the press landed on the already-selected item
  private sliding = false; // a panel slider is being dragged: don't rebuild the panel under it

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
    canvas.addEventListener("mousedown", (e) => this.onDown(e));
    window.addEventListener("mousemove", (e) => this.onMove(e));
    window.addEventListener("mouseup", () => this.onUp());
    canvas.addEventListener("mouseleave", () => { if (!this.drag) this.hover = null; });
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

  /** The current list for a kind, in the form its TrackEdit field stores (with every attribute). */
  private list(kind: Kind): Item[] { return listOf(this.track, kind); }

  /** The track's own list for a kind — as it is with no edits to that kind (the "original"). */
  private originalList(kind: Kind): Item[] {
    const e: Record<string, unknown> = { ...(this.effective()[this.id] ?? {}) };
    delete e[FIELD[kind]];
    return listOf(buildTrack(this.id, e as TrackEdit), kind);
  }
  private count(kind: Kind) { return this.list(kind).length; }
  /** Is this kind's list edited (by a draft or the shipped file)? */
  private edited(kind: Kind) { return (this.effective()[this.id] as Record<string, unknown> | undefined)?.[FIELD[kind]] !== undefined; }

  /** Replace a kind's list; if `keep` is given, keep that item selected wherever it ends up. */
  private setList(kind: Kind, next: Item[], final = true, keep?: Item) {
    if (kind === "checkpoint" || kind === "bump") next = [...next].sort((a, b) => atOf(a) - atOf(b));
    this.set({ [FIELD[kind]]: next } as Draft, false);
    if (keep !== undefined) this.reselect(kind, keep);
    if (final) this.render(true);
  }

  /** Find an item again after a rebuild (lists along the lap re-sort by position). */
  private reselect(kind: Kind, item: Item) {
    const t = this.track, list = this.list(kind);
    let j = -1;
    if (ALONG_LAP.includes(kind)) { const i = lapIndex(t, atOf(item)); j = list.findIndex((it) => lapIndex(t, atOf(it)) === i); }
    else { const o = item as { x: number; y: number }; j = list.findIndex((it) => Math.abs((it as any).x - o.x) < 0.06 && Math.abs((it as any).y - o.y) < 0.06); }
    this.sel = j >= 0 ? { kind, index: j } : null;
  }

  // ── open / close / test ──────────────────────────────────────────────────
  toggle(open = !this.open) {
    this.open = open;
    this.hover = null; this.drag = null;
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
    this.msg = ""; this.sel = null;
    this.render(true);
  }

  setTool(tool: Tool) { this.tool = tool; this.msg = ""; this.saveUI(); this.render(true); }

  /** Race this track now with whoever is in the lobby (adds bots if nobody is). */
  testDrive() {
    this.sel = null;
    this.selectTrack(this.id);
    if (!this.host.canStart()) for (let i = 0; i < 3; i++) this.host.addBot(false);
    this.host.startRace(true);
  }

  // ── keys ─────────────────────────────────────────────────────────────────
  /** Returns true when the key was a dev shortcut. */
  onKey(e: KeyboardEvent): boolean {
    if (e.code === "KeyG" && !e.repeat) { this.toggleDebug(); return true; }
    if (e.code === "KeyE" && !e.repeat && this.host.phase === "LOBBY") { this.toggle(); return true; }
    if (!this.editing) return false;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.code] && this.sel) { e.preventDefault(); this.nudge(...arrows[e.code], e.shiftKey); return true; }
    if (e.repeat) return false;
    if ((e.code === "Delete" || e.code === "Backspace") && this.sel) { this.removeSel(); return true; }
    if (e.code === "Escape") { if (this.sel) { this.sel = null; this.render(true); } else this.toggle(false); return true; }
    const tool = TOOLS.find((t) => `Key${t.key}` === e.code);
    if (tool) { this.setTool(tool.id); return true; }
    if (e.code === "Enter" || e.code === "NumpadEnter") { this.testDrive(); return true; }
    return false;
  }

  // ── placement rules ──────────────────────────────────────────────────────
  /** Nearest centerline index to a point (null if it's further than `reach` px off the road). */
  private roadAt(x: number, y: number, reach = 18): number | null {
    const P = this.track.pts;
    let best = -1, bd = Infinity;
    for (let j = 0; j < P.length; j++) { const d = Math.hypot(P[j].x - x, P[j].y - y) - P[j].hw; if (d < bd) { bd = d; best = j; } }
    return bd <= reach ? best : null;
  }

  private arcGap(a: number, b: number) { const n = this.track.pts.length, d = Math.abs(a - b) % n; return Math.min(d, n - d) * 8; }

  /** Why a checkpoint / bump / boost pad can't sit at centerline index i ("" = it can). `self` = the one being moved. */
  private whyNot(kind: Kind, i: number, self = -1): string {
    const t = this.track;
    if (!lineIsClean(t, i)) return "Not where the road crosses itself — pick a clean stretch.";
    if (kind === "checkpoint" && this.arcGap(i, 0) < 60) return "Too close to the start line.";
    if (kind === "bump" && this.arcGap(i, 0) < 40) return "Too close to the start line.";
    if (kind === "checkpoint" && t.gates.slice(1).some((g, k) => k !== self && this.arcGap(g.i, i) < 50)) return "Too close to another checkpoint.";
    if (kind === "bump" && t.bumps.some((b, k) => k !== self && b.i === i)) return "There's already a bump there.";
    return "";
  }

  /** The closest spot to index i where this item may go. */
  private nearestOk(kind: Kind, i: number, self: number): number | null {
    const n = this.track.pts.length;
    for (let d = 0; d < n / 2; d++) for (const j of [i + d, i - d]) { const k = ((j % n) + n) % n; if (!this.whyNot(kind, k, self)) return k; }
    return null;
  }

  /**
   * Everything under a point, best match first: each hit is scored by how
   * central the point is on it (0 = dead centre, 1 = its edge), so clicking the
   * middle of a sand patch picks the patch, not a checkpoint line crossing it.
   */
  private hitsAt(x: number, y: number): Hit[] {
    const t = this.track, out: (Hit & { score: number })[] = [];
    const add = (kind: Kind, index: number, score: number) => { if (score < 1) out.push({ kind, index, score }); };
    t.gates.slice(1).forEach((g, k) => add("checkpoint", k, Math.min(segDist(x, y, g) / 14, ...g.flags.map((f) => Math.hypot(f.x - x, f.y - 10 - y) / 16))));
    t.bumps.forEach((b, k) => add("bump", k, segDist(x, y, b) / 12));
    t.boosts.forEach((p, k) => {
      const dx = x - p.x, dy = y - p.y, ca = Math.cos(p.a), sa = Math.sin(p.a);
      add("boost", k, Math.max(Math.abs(dx * ca + dy * sa) / (p.len / 2 + 6), Math.abs(-dx * sa + dy * ca) / (p.w / 2 + 6)));
    });
    t.oil.forEach((c, k) => add("oil", k, Math.hypot(c.x - x, c.y - y) / c.r));
    t.sand.forEach((c, k) => add("sand", k, Math.hypot(c.x - x, c.y - y) / c.r));
    t.obstacles.forEach((o, k) => add("scenery", k, Math.hypot(o.x - x, o.y - y) / (o.r + 6)));
    return out.sort((a, b) => a.score - b.score).map(({ kind, index }) => ({ kind, index }));
  }

  private same(a: Hit | null, b: Hit | null) { return !!a && !!b && a.kind === b.kind && a.index === b.index; }

  /** What's under the pointer — the selected item wins if it's one of them (so you can drag it). */
  private pick(x: number, y: number): Hit | null {
    const hits = this.hitsAt(x, y);
    return hits.find((h) => this.same(h, this.sel)) ?? hits[0] ?? null;
  }

  /** A new item of the current tool's kind at (x,y), or why not. */
  private newItem(x: number, y: number): { add: Item } | { error: string } {
    const t = this.track, kind = this.tool as Kind;
    if (ALONG_LAP.includes(kind)) {
      const i = this.roadAt(x, y);
      if (i === null) return { error: "Click on the road." };
      const why = kind === "boost" ? (lineIsClean(t, i) ? "" : "Not where the road crosses itself — pick a clean stretch.") : this.whyNot(kind, i);
      if (why) return { error: why };
      if (kind === "boost") {
        const c = t.pts[i], off = Math.max(-0.55, Math.min(0.55, ((x - c.x) * c.nx + (y - c.y) * c.ny) / c.hw));
        return { add: { at: lapFraction(t, i), off: r2(off), len: 56, w: Math.round(Math.min(70, c.hw * 1.1)), power: 1 } };
      }
      return { add: lapFraction(t, i) };
    }
    if (!inside(x, y)) return { error: "Keep it inside the screen." };
    if (kind === "sand" || kind === "oil") return { add: { x: r1(x), y: r1(y), r: this.patchR } };
    const deco = t.theme.deco[this.count("scenery") % t.theme.deco.length];
    if (edgeGap(t, x, y) < obstacleRadius(deco, 1) + 4) return { error: "Scenery goes off the road." };
    return { add: { x: r1(x), y: r1(y), kind: deco, s: 1 } };
  }

  // ── pointer ──────────────────────────────────────────────────────────────
  private onDown(e: MouseEvent) {
    this.skipClick = false;
    if (!this.editing || e.button !== 0 || this.tool === "erase") return;
    const p = this.host.renderer.toLogical(e.clientX, e.clientY), hit = this.pick(p.x, p.y);
    if (!hit) return;
    e.preventDefault();
    this.wasSelected = this.same(hit, this.sel);
    this.sel = hit;
    this.drag = { hit, sx: p.x, sy: p.y, x: p.x, y: p.y, moved: false };
    this.msg = "";
    this.render(true);
  }

  private onMove(e: MouseEvent) {
    if (!this.editing) return;
    const p = this.host.renderer.toLogical(e.clientX, e.clientY);
    this.hover = p;
    const d = this.drag;
    if (!d) return;
    d.x = p.x; d.y = p.y;
    if (Math.hypot(p.x - d.sx, p.y - d.sy) > 4) d.moved = true;
  }

  private onUp() {
    const d = this.drag;
    this.drag = null;
    if (!d || !d.moved) return;
    this.skipClick = true; // the click that ends a drag isn't a click
    this.moveTo(d.hit, d.x, d.y);
  }

  private onCanvasClick(e: MouseEvent) {
    if (!this.editing) return;
    if (this.skipClick) { this.skipClick = false; return; }
    const p = this.host.renderer.toLogical(e.clientX, e.clientY), hit = this.pick(p.x, p.y);
    if (this.tool === "erase") {
      if (!hit) { this.msg = "Nothing to remove here."; this.render(true); return; }
      this.remove(hit);
      return;
    }
    if (hit) {
      // Clicking the selected item again cycles through anything overlapping it.
      const hits = this.hitsAt(p.x, p.y);
      if (this.wasSelected && hits.length > 1) {
        const k = hits.findIndex((h) => this.same(h, this.sel));
        this.sel = hits[(k + 1) % hits.length];
        this.msg = `Selected the ${NAMES[this.sel.kind][0].toLowerCase()} underneath (click again to cycle).`;
        this.render(true);
      }
      return; // otherwise it was selected on mousedown
    }
    const it = this.newItem(p.x, p.y);
    if ("error" in it) { this.msg = it.error; this.sel = null; this.render(true); return; }
    const kind = this.tool as Kind;
    this.msg = `${NAMES[kind][0]} added.`;
    this.setList(kind, [...this.list(kind), it.add], true, it.add);
  }

  // ── changing the selected item ──────────────────────────────────────────
  private selItem(): Item | null { return this.sel ? this.list(this.sel.kind)[this.sel.index] ?? null : null; }

  /** Merge attributes into the selected item (undefined = drop that attribute). */
  private updateSel(patch: Record<string, unknown>, final = true) {
    const s = this.sel, cur = this.selItem();
    if (!s || cur === null) return;
    const obj: Record<string, unknown> = { ...(typeof cur === "number" ? { at: cur } : cur), ...patch };
    this.replaceSel(obj, final);
  }

  /** Put an item in place of the selected one. */
  private replaceSel(obj: Record<string, unknown>, final = true) {
    const s = this.sel;
    if (!s) return;
    obj = { ...obj };
    for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
    // A checkpoint / bump with nothing but a position is stored as a plain number.
    const next: Item = (s.kind === "checkpoint" || s.kind === "bump") && Object.keys(obj).length === 1 ? (obj.at as number) : obj;
    const list = this.list(s.kind);
    list[s.index] = next;
    this.setList(s.kind, list, final, next);
  }

  /**
   * Reset the selected item: one that came from the track's own layout goes back
   * to exactly how it was (position and every attribute); one you added keeps
   * its place and gets the default attributes.
   */
  private resetSel() {
    const s = this.sel, cur = this.selItem();
    if (!s || cur === null) return;
    const obj: Record<string, unknown> = typeof cur === "number" ? { at: cur } : { ...cur };
    const origin = this.originalList(s.kind)[obj.orig as number];
    if (typeof obj.orig === "number" && origin !== undefined) {
      const o: Record<string, unknown> = typeof origin === "number" ? { at: origin } : { ...origin };
      if (ALONG_LAP.includes(s.kind) && s.kind !== "boost") {
        // Its original spot might be taken now (e.g. another checkpoint moved there).
        const i = this.nearestOk(s.kind, lapIndex(this.track, o.at as number), s.index);
        if (i !== null) o.at = lapFraction(this.track, i);
      }
      this.msg = `${NAMES[s.kind][0]} reset to the original.`;
      this.replaceSel(o);
      return;
    }
    const keep = ALONG_LAP.includes(s.kind) ? { at: obj.at, ...(s.kind === "boost" ? { off: 0 } : {}) } : { x: obj.x, y: obj.y };
    const defaults: Record<Kind, Record<string, unknown>> = {
      checkpoint: {}, bump: {}, boost: { len: 56, power: 1 },
      sand: { r: 38 }, oil: { r: 30 }, scenery: { kind: obj.kind, s: 1 },
    };
    this.msg = `${NAMES[s.kind][0]} reset to the defaults (it isn't part of the original layout).`;
    this.replaceSel({ ...keep, ...defaults[s.kind] });
  }

  /** Move the selected (or given) item to a point: along the road for lap items, freely for the rest. */
  private moveTo(hit: Hit, x: number, y: number, final = true) {
    this.sel = hit;
    const t = this.track;
    if (ALONG_LAP.includes(hit.kind)) {
      const i0 = this.roadAt(x, y, 400);
      if (i0 === null) return;
      const i = hit.kind === "boost" ? i0 : this.nearestOk(hit.kind, i0, hit.index);
      if (i === null) { this.msg = "No free spot there."; if (final) this.render(true); return; }
      const patch: Record<string, unknown> = { at: lapFraction(t, i) };
      if (hit.kind === "boost") { const c = t.pts[i]; patch.off = r2(Math.max(-0.55, Math.min(0.55, ((x - c.x) * c.nx + (y - c.y) * c.ny) / c.hw))); }
      this.updateSel(patch, final);
      return;
    }
    x = Math.max(BOUNDS.x0 + 4, Math.min(BOUNDS.x1 - 4, x)); y = Math.max(BOUNDS.y0 + 4, Math.min(BOUNDS.y1 - 4, y));
    if (hit.kind === "scenery") {
      const o = t.obstacles[hit.index];
      if (edgeGap(t, x, y) < o.r + 2) { this.msg = "Scenery can't go on the road."; if (final) this.render(true); return; }
    }
    this.updateSel({ x: r1(x), y: r1(y) }, final);
  }

  /** Arrow keys: free items move on screen; lap items slide along the road (↑/↓ shifts a boost pad sideways). */
  private nudge(dx: number, dy: number, big: boolean) {
    const s = this.sel, cur = this.selItem();
    if (!s || cur === null) return;
    const t = this.track, step = big ? 10 : 2;
    if (ALONG_LAP.includes(s.kind)) {
      if (dx) {
        const n = t.pts.length, from = lapIndex(t, atOf(cur)), want = (from + dx * (big ? 5 : 1) + n) % n;
        const i = s.kind === "boost" ? want : this.nearestOkDir(s.kind, want, s.index, dx);
        if (i !== null) this.updateSel({ at: lapFraction(t, i) });
      } else if (s.kind === "boost") {
        const off = (cur as { off: number }).off;
        this.updateSel({ off: r2(Math.max(-0.6, Math.min(0.6, off + dy * (big ? 0.1 : 0.03)))) });
      }
      return;
    }
    const o = cur as { x: number; y: number };
    this.moveTo(s, o.x + dx * step, o.y + dy * step);
  }

  /** Like nearestOk, but only searching in one direction (so arrow keys hop over blocked spots). */
  private nearestOkDir(kind: Kind, i: number, self: number, dir: number): number | null {
    const n = this.track.pts.length;
    for (let d = 0; d < n; d++) { const k = (((i + dir * d) % n) + n) % n; if (!this.whyNot(kind, k, self)) return k; }
    return null;
  }

  private remove(hit: Hit) {
    this.msg = `${NAMES[hit.kind][0]} removed.`;
    this.sel = null;
    this.setList(hit.kind, this.list(hit.kind).filter((_, j) => j !== hit.index));
  }
  private removeSel() { if (this.sel) this.remove(this.sel); }

  /** Copy the selected item next to itself. */
  private duplicateSel() {
    const s = this.sel, cur = this.selItem();
    if (!s || cur === null) return;
    const t = this.track;
    let copy: Item;
    if (ALONG_LAP.includes(s.kind)) {
      const from = lapIndex(t, atOf(cur)), i = s.kind === "boost" ? (from + 10) % t.pts.length : this.nearestOkDir(s.kind, from + 10, -1, 1);
      if (i === null) { this.msg = "No free spot for a copy."; this.render(true); return; }
      copy = typeof cur === "number" ? lapFraction(t, i) : { ...cur, at: lapFraction(t, i) };
    } else {
      const o = cur as { x: number; y: number };
      copy = { ...(cur as object), x: r1(Math.min(BOUNDS.x1 - 10, o.x + 40)), y: r1(o.y) };
    }
    if (typeof copy === "object") delete copy.orig; // a copy isn't part of the original layout
    this.msg = `${NAMES[s.kind][0]} duplicated.`;
    this.setList(s.kind, [...this.list(s.kind), copy], true, copy);
  }

  // ── overlays ─────────────────────────────────────────────────────────────
  /** Editor view: numbered checkpoints and bumps, the selection, drag previews and what a click would do. */
  editorOverlay = (ctx: CanvasRenderingContext2D) => {
    const t = this.track, time = performance.now() / 1000;
    this.drawGates(ctx, t, time);
    t.bumps.forEach((b, k) => this.tag(ctx, (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2 - 16, `B${k + 1}`, "#1a2a0a", "#FFD600"));
    if (this.sel && this.selItem() !== null) {
      ctx.save(); ctx.strokeStyle = SEL; ctx.lineWidth = 4;
      this.outline(ctx, this.sel);
      ctx.restore();
    }
    const d = this.drag;
    if (d?.moved) { this.ghost(ctx, d.hit, d.x, d.y); return; }
    const h = this.hover;
    if (!h) return;
    const hit = this.pick(h.x, h.y);
    if (this.tool === "erase") {
      if (hit) {
        ctx.save(); ctx.strokeStyle = "#E63946"; ctx.lineWidth = 4; ctx.setLineDash([8, 6]); this.outline(ctx, hit); ctx.restore();
        this.tag(ctx, h.x, h.y - 26, `✕ remove ${NAMES[hit.kind][0].toLowerCase()}`, "#fff", "#E63946");
      }
      return;
    }
    if (hit) {
      const selected = this.sel && hit.kind === this.sel.kind && hit.index === this.sel.index;
      if (!selected) { ctx.save(); ctx.strokeStyle = SEL; ctx.globalAlpha = 0.5; ctx.lineWidth = 3; ctx.setLineDash([6, 6]); this.outline(ctx, hit); ctx.restore(); }
      this.tag(ctx, h.x, h.y - 26, selected ? "drag to move" : `select ${NAMES[hit.kind][0].toLowerCase()}`, "#fff", SEL);
      return;
    }
    const it = this.newItem(h.x, h.y);
    if ("error" in it) { this.tag(ctx, h.x, h.y - 26, it.error, "#fff", "rgba(0,0,0,0.75)"); return; }
    ctx.save(); ctx.strokeStyle = "#2E7D32"; ctx.lineWidth = 4; ctx.setLineDash([8, 6]);
    this.shape(ctx, this.tool as Kind, it.add);
    ctx.restore();
    const a = it.add as { kind?: string };
    this.tag(ctx, h.x, h.y - 26, `+ ${this.tool === "scenery" ? a.kind : NAMES[this.tool as Kind][0].toLowerCase()}`, "#fff", "#2E7D32");
  };

  /** Where a drag would put the item. */
  private ghost(ctx: CanvasRenderingContext2D, hit: Hit, x: number, y: number) {
    const t = this.track, cur = this.list(hit.kind)[hit.index];
    if (cur === undefined) return;
    let item: Item = cur;
    if (ALONG_LAP.includes(hit.kind)) {
      const i0 = this.roadAt(x, y, 400);
      const i = i0 === null ? null : hit.kind === "boost" ? i0 : this.nearestOk(hit.kind, i0, hit.index);
      if (i === null) return;
      item = typeof cur === "number" ? lapFraction(t, i) : { ...cur, at: lapFraction(t, i) };
      if (hit.kind === "boost") { const c = t.pts[i]; (item as any).off = Math.max(-0.55, Math.min(0.55, ((x - c.x) * c.nx + (y - c.y) * c.ny) / c.hw)); }
    } else item = { ...(cur as object), x, y };
    ctx.save(); ctx.strokeStyle = SEL; ctx.lineWidth = 4; ctx.setLineDash([8, 6]);
    this.shape(ctx, hit.kind, item);
    ctx.restore();
  }

  /** Outline of an item described by its edit form (previews and ghosts). */
  private shape(ctx: CanvasRenderingContext2D, kind: Kind, item: Item) {
    const t = this.track;
    if (kind === "checkpoint" || kind === "bump") {
      const c = t.pts[lapIndex(t, atOf(item))], r = c.hw + 12;
      ctx.setLineDash([]); ctx.lineWidth = 6; ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.moveTo(c.x - c.nx * r, c.y - c.ny * r); ctx.lineTo(c.x + c.nx * r, c.y + c.ny * r); ctx.stroke();
    } else if (kind === "boost") {
      const b = item as { at: number; off: number; len?: number; w?: number }, c = t.pts[lapIndex(t, b.at)];
      const len = b.len ?? 56, w = b.w ?? Math.min(70, c.hw * 1.1);
      ctx.translate(c.x + c.nx * b.off * c.hw, c.y + c.ny * b.off * c.hw); ctx.rotate(Math.atan2(c.ty, c.tx));
      ctx.strokeRect(-len / 2, -w / 2, len, w);
    } else {
      const o = item as { x: number; y: number; r?: number; kind?: DecoKind; s?: number };
      const r = kind === "scenery" ? obstacleRadius(o.kind!, o.s ?? 1) : o.r!;
      ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /** Outline one placed item. */
  private outline(ctx: CanvasRenderingContext2D, hit: Hit) {
    const t = this.track;
    const line = (g: Seg) => { ctx.setLineDash([]); ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); ctx.stroke(); };
    const ring = (x: number, y: number, r: number) => { ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.stroke(); };
    switch (hit.kind) {
      case "checkpoint": { const g = t.gates[hit.index + 1]; if (g) line(g); break; }
      case "bump": { const b = t.bumps[hit.index]; if (b) line(b); break; }
      case "boost": { const p = t.boosts[hit.index]; if (!p) break; ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.strokeRect(-p.len / 2 - 3, -p.w / 2 - 3, p.len + 6, p.w + 6); break; }
      case "sand": { const c = t.sand[hit.index]; if (c) ring(c.x, c.y, c.r); break; }
      case "oil": { const c = t.oil[hit.index]; if (c) ring(c.x, c.y, c.r); break; }
      case "scenery": { const o = t.obstacles[hit.index]; if (o) ring(o.x, o.y, o.r); break; }
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
    if (!this.editing || (this.sliding && !force)) return;
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
      case "prop": {
        const v = el.dataset.val!;
        this.updateSel({ [el.dataset.prop!]: v === "default" ? undefined : v === "on" ? true : v === "off" ? false : v });
        return;
      }
      case "removeSel": this.removeSel(); return;
      case "resetSel": this.resetSel(); return;
      case "resetField": this.set({ [el.dataset.field!]: null } as Draft); this.msg = "Back to the default."; break;
      case "resetTrack": {
        this.sel = null;
        // Null every field the shipped file sets too, so this really is the original track.
        this.drafts[this.id] = Object.fromEntries(Object.keys(TRACK_EDITS[this.id] ?? {}).map((k) => [k, null])) as Draft;
        if (!Object.keys(this.drafts[this.id]!).length) delete this.drafts[this.id];
        save(DRAFT_KEY, this.drafts); this.apply();
        this.msg = `${t.name} is back to its original design.`;
        break;
      }
      case "dupSel": this.duplicateSel(); return;
      case "deselect": this.sel = null; break;
      case "reset": if (kind) { this.sel = null; this.set({ [FIELD[kind]]: null } as Draft); this.msg = `${NAMES[kind][1]} back to the track's own.`; } break;
      case "clear": if (kind) { this.sel = null; this.set({ [FIELD[kind]]: [] } as Draft); this.msg = `All ${NAMES[kind][1].toLowerCase()} removed.`; } break;
      case "checker": this.set({ checkpointLines: el.dataset.on === "1" ? true : null }); break;
      case "walls": this.set({ walls: el.dataset.on === "1" ? null : false }); this.msg = el.dataset.on === "1" ? "Walls are back." : "Open track: drive anywhere — the screen edge is the wall."; break;
      case "discardTrack": this.sel = null; delete this.drafts[this.id]; save(DRAFT_KEY, this.drafts); this.apply(); this.msg = `Draft edits for ${t.name} discarded.`; break;
      case "discardAll": this.sel = null; this.drafts = {}; save(DRAFT_KEY, this.drafts); this.apply(); this.msg = "All draft edits discarded."; break;
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
    this.sliding = !final;
    const show = (key: string, text: string) => { const out = this.panel.querySelector<HTMLElement>(`[data-out="${key}"]`); if (out) out.textContent = text; };
    if (el.dataset.ui === "patchR") { this.patchR = v; show("patchR", String(v)); if (final) this.saveUI(); return; }
    let run: (() => void) | null = null;
    if (el.dataset.prop) {
      const prop = el.dataset.prop, s = this.sel;
      if (!s) return;
      show(`p-${prop}`, fmtProp(prop, v));
      if (prop === "at") {
        const t = this.track, i0 = lapIndex(t, v);
        const i = s.kind === "boost" ? i0 : this.nearestOk(s.kind, i0, s.index);
        if (i === null) return;
        run = () => this.updateSel({ at: lapFraction(t, i) }, final);
      } else if ((prop === "x" || prop === "y") && s.kind === "scenery") {
        const o = this.selItem() as { x: number; y: number };
        run = () => this.moveTo(s, prop === "x" ? v : o.x, prop === "y" ? v : o.y, final);
      } else run = () => this.updateSel({ [prop]: v }, final);
    } else if (el.dataset.edit) {
      const key = el.dataset.edit;
      show(key, v.toFixed(2));
      run = () => this.set({ [key]: v } as Draft, final);
    }
    if (!run) return;
    if (final) { this.pending = null; run(); return; }
    if (!this.pending) requestAnimationFrame(() => { const p = this.pending; this.pending = null; p?.(); });
    this.pending = run;
  }

  exportJSON(): string { return JSON.stringify(this.effective(), null, 2) + "\n"; }

  /** The "Selected" card: every attribute of the selected item. */
  private selectedHTML(): string {
    const s = this.sel, t = this.track;
    if (!s) return "";
    const cur = this.selItem();
    if (cur === null) { this.sel = null; return ""; }
    const hint = (text: string) => `<div style="font-size:14px;color:#7a7460;line-height:1.15;margin-top:1px">${text}</div>`;
    const range = (prop: string, label: string, min: number, max: number, step: number, value: number, note = "") => `
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:17px;margin-top:6px">${label}<b data-out="p-${prop}" style="font-family:sans-serif;font-size:13px">${fmtProp(prop, value)}</b></div>
      <input type="range" data-prop="${prop}" min="${min}" max="${max}" step="${step}" value="${value}" style="width:100%;accent-color:${SEL}" />${note ? hint(note) : ""}`;
    const choice = (prop: string, opts: [string, string][], val: string) =>
      `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${opts.map(([v, label]) =>
        `<button data-dev="prop" data-prop="${prop}" data-val="${v}" style="border:2px solid ${v === val ? SEL : "#d8d2bd"};background:${v === val ? SEL : "#fff"};color:${v === val ? "#fff" : "#333"};border-radius:8px;padding:2px 8px;font:700 15px Caveat,cursive;cursor:pointer">${label}</button>`).join("")}</div>`;
    let body = "", title = NAMES[s.kind][0];
    const pos = (at: number) => range("at", "Position around the lap", 0, 0.9999, 0.0005, at, "Or drag it along the road · ← → nudge (Shift = bigger steps)");
    switch (s.kind) {
      case "checkpoint": {
        const g = t.gates[s.index + 1];
        title = `Checkpoint ${s.index + 1}`;
        body = pos(atOf(cur)) + `<div style="font-size:17px;margin-top:8px">Red/white line</div>`
          + choice("line", [["default", `Track default (${t.checkpointLines ? "on" : "off"})`], ["on", "On"], ["off", "Off"]], g.line === undefined ? "default" : g.line ? "on" : "off");
        break;
      }
      case "bump": {
        const b = t.bumps[s.index];
        title = `Speed bump B${s.index + 1}`;
        body = pos(atOf(cur)) + range("loss", "Strength (speed lost at full speed)", 0, 0.8, 0.05, b.loss ?? t.bumpLoss,
          b.loss === undefined ? `Using the track's ${t.bumpLoss.toFixed(2)}.` : "Its own strength.")
          + (b.loss !== undefined ? choice("loss", [["default", "Use the track's strength"]], "") : "");
        break;
      }
      case "boost": {
        const p = t.boosts[s.index];
        body = pos(atOf(cur)) + range("off", "Sideways (left ↔ right)", -0.6, 0.6, 0.01, p.off, "↑ ↓ nudge")
          + range("len", "Length", 24, 140, 2, p.len) + range("w", "Width", 16, 100, 2, p.w)
          + range("power", "Power", 0.3, 2.5, 0.05, p.power, "Scales the kick and how long the boost lasts. 1 = normal.");
        break;
      }
      case "sand": case "oil": {
        const c = (s.kind === "sand" ? t.sand : t.oil)[s.index];
        body = range("r", "Size (radius)", 10, 90, 1, c.r)
          + range("k", s.kind === "sand" ? "How much it slows you" : "How slippery", 0.2, 2, 0.05, c.k ?? 1, "1 = normal.")
          + range("x", "Left ↔ right", BOUNDS.x0, BOUNDS.x1, 1, c.x) + range("y", "Up ↕ down", BOUNDS.y0, BOUNDS.y1, 1, c.y, "Or drag it · arrow keys nudge (Shift = bigger steps)");
        break;
      }
      case "scenery": {
        const o = t.obstacles[s.index];
        title = `Scenery · ${o.kind}`;
        body = `<div style="font-size:17px">Type</div>` + choice("kind", DECO_KINDS.map((k) => [k, k]), o.kind)
          + range("s", "Size", 0.5, 2, 0.05, o.s, t.walls ? "Decoration on this walled track — solid if you make it an open track." : "Solid: cars bounce off it.")
          + range("x", "Left ↔ right", BOUNDS.x0, BOUNDS.x1, 1, o.x) + range("y", "Up ↕ down", BOUNDS.y0, BOUNDS.y1, 1, o.y, "Or drag it · arrow keys nudge (Shift = bigger steps)");
        break;
      }
    }
    const small = (dev: string, label: string, color = "#333") =>
      `<button data-dev="${dev}" style="border:1px solid #d8d2bd;background:#fff;color:${color};border-radius:8px;padding:2px 9px;font:700 16px Caveat,cursive;cursor:pointer">${label}</button>`;
    return `<div style="margin-top:12px;background:#fff;border:3px solid ${SEL};border-radius:12px;padding:8px 10px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
        <div style="font-size:21px;font-weight:700;color:${SEL}">Selected: ${esc(title)}</div>
        ${small("deselect", "✕")}
      </div>
      ${body}
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
        ${small("resetSel", typeof cur === "object" && typeof cur.orig === "number" ? "↺ Reset to original" : "↺ Reset to defaults")}
        ${small("dupSel", "Duplicate")} ${small("removeSel", "Remove (Del)", "#E63946")}</div>
    </div>`;
  }

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
    const own = (this.effective()[id] ?? {}) as Record<string, unknown>;
    const slider = (key: string, label: string, min: number, max: number, step: number, value: number, note: string, attr = "data-edit") => `
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:18px;margin-top:8px;gap:6px"><span style="flex:1">${label}</span>
        ${attr === "data-edit" && own[key] !== undefined ? mini("resetField", "↺ default", `data-field="${key}"`) : ""}
        <b data-out="${key}" style="font-family:sans-serif;font-size:14px">${attr === "data-edit" ? value.toFixed(2) : value}</b></div>
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
        ${edited ? mini("reset", "↺ original", `data-kind="${k}"`) : ""}${n ? mini("clear", "clear", `data-kind="${k}"`) : ""}</div>`;
    }).join("");
    const toolHint = this.tool === "erase" ? "Click anything placed to remove it."
      : `Click empty road/ground to add a ${NAMES[this.tool][0].toLowerCase()} · click anything placed to select it.`;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="font-size:28px;font-weight:700;line-height:1">🛠 Track editor</div>
        ${btn("close", "✕ Close")}
      </div>
      ${hint("Dev build only. Changes are drafts in this browser until you export them.")}
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px">${tracks}</div>

      ${h("Place, select & edit")}
      <div style="display:flex;flex-wrap:wrap;gap:5px">${tools}</div>
      ${hint(toolHint)}
      ${this.tool === "sand" || this.tool === "oil" ? slider("patchR", "New patch size", 16, 70, 2, this.patchR, "", "data-ui") : ""}
      ${this.msg ? `<div style="margin-top:6px;background:#fff;border-left:4px solid #FFB300;padding:4px 8px;font-size:16px;border-radius:6px">${esc(this.msg)}</div>` : ""}
      ${this.selectedHTML()}

      ${h("On this track")}
      ${rows}
      ${hint("↺ original = back to the track's own layout · clear = remove them all")}
      <div style="font-size:18px;margin-top:8px">Checkpoint look (track default)</div>
      <div style="display:flex;gap:6px;margin-top:3px">${btn("checker", "🚩 Flags", !t.checkpointLines, 'data-on="0"')} ${btn("checker", "🚩 Flags + red/white line", t.checkpointLines, 'data-on="1"')}</div>
      ${hint("Select a checkpoint to override its own line. Checkpoints must be crossed in order, on the road; skip one and the lap doesn't count until you go back.")}
      ${slider("bumpLoss", "Speed bumps: default strength", 0.05, 0.7, 0.05, t.bumpLoss, `Default ${BUMP_LOSS}. A selected bump can have its own. Slower cars lose less; the Monster Truck barely notices.`)}

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
        ${Object.keys(own).length ? btn("resetTrack", `↺ Reset ${t.name.split(" ")[0]} to original`) : ""}
        ${anyDirty ? btn("discardAll", "Discard all drafts") : ""}
      </div>
      ${hint("To ship: the exported JSON replaces <code>src/screen/track-edits.json</code>; commit it and it goes out with the next deploy.")}
      ${hint("Keys: E editor · C B P S O T X tools · Del remove · arrows nudge · Enter test drive · G checkpoint lines · Esc deselect / close")}`;
  }
}

/** A track's list for a kind, in the form its TrackEdit field stores (every attribute, and `orig`). */
function listOf(t: TrackDef, kind: Kind): Item[] {
  const o = (v: number | undefined) => (v !== undefined ? { orig: v } : {});
  switch (kind) {
    case "checkpoint": return t.gates.slice(1).map((g) => (g.line === undefined && g.orig === undefined ? lapFraction(t, g.i)
      : { at: lapFraction(t, g.i), ...(g.line !== undefined ? { line: g.line } : {}), ...o(g.orig) }));
    case "bump": return t.bumps.map((b) => (b.loss === undefined ? lapFraction(t, b.i) : { at: lapFraction(t, b.i), loss: b.loss }));
    case "boost": return t.boosts.map((p) => ({ at: lapFraction(t, p.i), off: r2(p.off), len: Math.round(p.len), w: Math.round(p.w), power: r2(p.power), ...o(p.orig) }));
    case "sand": return t.sand.map((c) => ({ x: r1(c.x), y: r1(c.y), r: c.r, ...(c.k !== undefined ? { k: c.k } : {}), ...o(c.orig) }));
    case "oil": return t.oil.map((c) => ({ x: r1(c.x), y: r1(c.y), r: c.r, ...(c.k !== undefined ? { k: c.k } : {}), ...o(c.orig) }));
    case "scenery": return t.obstacles.map((ob) => ({ x: r1(ob.x), y: r1(ob.y), kind: ob.kind, s: r2(ob.s), ...o(ob.orig) }));
  }
}

/** How a property's value reads in the panel. */
function fmtProp(prop: string, v: number): string {
  if (prop === "at") return `${(v * 100).toFixed(1)}%`;
  if (prop === "x" || prop === "y" || prop === "r" || prop === "len" || prop === "w") return String(Math.round(v));
  return v.toFixed(2);
}
