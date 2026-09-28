// Dev-build-only track editor + debug overlays (compiled in by `vite build
// --mode devtools`; the production build never includes this module).
//
// Edits are drafts kept in this browser (localStorage) and layered over the
// shipped track-edits.json, so you can try things — speed bumps, hand-placed
// checkpoints, ice grip, open tracks with no walls — in real races with real
// phones, then export the JSON and commit it when you're happy.

import type { Renderer } from "./render";
import { drawGateLine } from "./render";
import type { Race } from "./sim";
import {
  BUMP_LOSS, TRACKS, TRACK_EDITS, TRACK_ORDER, applyTrackEdits, lapFraction, lineIsClean,
  type TrackDef, type TrackEdit, type TrackEdits, type TrackId,
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

type Tool = "checkpoint" | "bump";
/** A draft field set to null means "back to the spec default", even if the shipped file sets it. */
type Draft = { [K in keyof TrackEdit]?: TrackEdit[K] | null };
type Drafts = Partial<Record<TrackId, Draft>>;

const DRAFT_KEY = "driftparty.dev.edits.v1";
const UI_KEY = "driftparty.dev.ui.v1";
const PANEL_W = 330;
const load = <T>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export class DevTools {
  open: boolean;
  debug: boolean;
  tool: Tool;
  drafts: Drafts = load<Drafts>(DRAFT_KEY, {});
  hover: { i: number; remove: boolean; ok: boolean } | null = null;
  msg = "";
  panel: HTMLElement;
  private html = "";
  private pending: Draft | null = null;

  constructor(private host: DevHost) {
    const ui = load(UI_KEY, { open: false, debug: false, tool: "checkpoint" as Tool });
    this.open = ui.open; this.debug = ui.debug; this.tool = ui.tool === "bump" ? "bump" : "checkpoint";
    this.panel = document.createElement("div");
    this.panel.id = "dev";
    this.panel.style.cssText = `position:absolute;top:0;right:0;bottom:0;width:${PANEL_W}px;background:#f0ede4;border-left:3px solid #1a2a0a;overflow-y:auto;z-index:16;display:none;font-family:Caveat,cursive;color:#1a2a0a;padding:12px 14px 20px;box-shadow:-6px 0 24px rgba(0,0,0,0.35)`;
    document.getElementById("root")!.appendChild(this.panel);
    this.panel.addEventListener("click", (e) => this.onPanelClick(e));
    this.panel.addEventListener("input", (e) => this.onSlider(e, false));
    this.panel.addEventListener("change", (e) => this.onSlider(e, true));
    const canvas = document.getElementById("raceCanvas")!;
    canvas.addEventListener("mousemove", (e) => this.onMove(e));
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

  saveUI() { save(UI_KEY, { open: this.open, debug: this.debug, tool: this.tool }); }

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

  /** Race this track now with whoever is in the lobby (adds bots if nobody is). */
  testDrive() {
    this.selectTrack(this.id);
    if (!this.host.canStart()) for (let i = 0; i < 3; i++) this.host.addBot(false);
    this.host.startRace(true);
  }

  // ── keys ─────────────────────────────────────────────────────────────────
  /** Returns true when the key was a dev shortcut. */
  onKey(e: KeyboardEvent): boolean {
    switch (e.code) {
      case "KeyG": this.toggleDebug(); return true;
      case "KeyE": if (this.host.phase === "LOBBY") { this.toggle(); return true; } return false;
      case "KeyC": if (this.editing) { this.tool = "checkpoint"; this.saveUI(); this.render(true); return true; } return false;
      case "KeyB": if (this.editing) { this.tool = "bump"; this.saveUI(); this.render(true); return true; } return false;
      case "Escape": if (this.editing) { this.toggle(false); return true; } return false;
      case "Enter": case "NumpadEnter": if (this.editing) { this.testDrive(); return true; } return false;
    }
    return false;
  }

  // ── canvas editing ───────────────────────────────────────────────────────
  /** Nearest centerline index to a logical point, if the point is on (or right next to) the road. */
  private roadAt(x: number, y: number): number | null {
    const P = this.track.pts;
    let best = -1, bd = Infinity;
    for (let j = 0; j < P.length; j++) { const d = Math.hypot(P[j].x - x, P[j].y - y) - P[j].hw; if (d < bd) { bd = d; best = j; } }
    return bd <= 18 ? best : null;
  }

  private arcGap(a: number, b: number) { const n = this.track.pts.length, d = Math.abs(a - b) % n; return Math.min(d, n - d) * 8; }
  private markers(): number[] { return this.tool === "checkpoint" ? this.track.gates.slice(1).map((g) => g.i) : this.track.bumps.map((b) => b.i); }

  private onMove(e: MouseEvent) {
    if (!this.editing) return;
    const p = this.host.renderer.toLogical(e.clientX, e.clientY), i = this.roadAt(p.x, p.y);
    if (i === null) { this.hover = null; return; }
    const remove = this.markers().some((m) => this.arcGap(m, i) < 45);
    this.hover = { i, remove, ok: remove || this.placeable(i) === "" };
  }

  /** Why a marker can't go here ("" = it can). */
  private placeable(i: number): string {
    if (!lineIsClean(this.track, i)) return "Not where the road crosses itself — pick a clean stretch.";
    if (this.arcGap(i, 0) < (this.tool === "checkpoint" ? 60 : 40)) return "Too close to the start line.";
    return "";
  }

  private onCanvasClick(e: MouseEvent) {
    if (!this.editing) return;
    const p = this.host.renderer.toLogical(e.clientX, e.clientY), i = this.roadAt(p.x, p.y);
    if (i === null) { this.msg = "Click on the road."; this.render(true); return; }
    const t = this.track, current = this.markers(), hit = current.find((m) => this.arcGap(m, i) < 45);
    let next: number[];
    if (hit !== undefined) {
      next = current.filter((m) => m !== hit);
      this.msg = this.tool === "checkpoint" ? "Checkpoint removed." : "Speed bump removed.";
    } else {
      const why = this.placeable(i);
      if (why) { this.msg = why; this.render(true); return; }
      next = [...current, i];
      this.msg = this.tool === "checkpoint" ? "Checkpoint added." : "Speed bump added.";
    }
    const fr = next.map((m) => lapFraction(t, m)).sort((a, b) => a - b);
    this.set(this.tool === "checkpoint" ? { checkpoints: fr } : { bumps: fr });
    this.onMove(e);
  }

  // ── overlays ─────────────────────────────────────────────────────────────
  /** Editor view: numbered checkpoint lines + what a click would do. */
  editorOverlay = (ctx: CanvasRenderingContext2D) => {
    const t = this.track, time = performance.now() / 1000;
    this.drawGates(ctx, t, time);
    t.bumps.forEach((b, k) => this.tag(ctx, (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2 - 16, `B${k + 1}`, "#1a2a0a", "#FFD600"));
    const h = this.hover;
    if (!h) return;
    const c = t.pts[h.i], r = c.hw + 14;
    ctx.save();
    ctx.strokeStyle = h.remove ? "#E63946" : h.ok ? (this.tool === "checkpoint" ? "#2E7D32" : "#FF8F00") : "rgba(120,120,120,0.8)";
    ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(c.x - c.nx * r, c.y - c.ny * r); ctx.lineTo(c.x + c.nx * r, c.y + c.ny * r); ctx.stroke();
    ctx.restore();
    const label = h.remove ? "✕ remove" : !h.ok ? "can't place here" : this.tool === "checkpoint" ? "+ checkpoint" : "+ speed bump";
    this.tag(ctx, c.x + c.nx * (r + 20), c.y + c.ny * (r + 20), label, "#fff", "rgba(0,0,0,0.75)");
  };

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
    const t = this.track;
    switch (el.dataset.dev) {
      case "close": this.toggle(false); return;
      case "track": this.selectTrack(el.dataset.track as TrackId); return;
      case "tool": this.tool = el.dataset.tool as Tool; this.saveUI(); break;
      case "walls": this.set({ walls: el.dataset.on === "1" ? null : false }); this.msg = el.dataset.on === "1" ? "Walls are back." : "Open track: drive anywhere — the screen edge is the wall."; break;
      case "autoCheckpoints": this.set({ checkpoints: null }); this.msg = "Checkpoints back to automatic (key corners)."; break;
      case "clearCheckpoints": this.set({ checkpoints: [] }); this.msg = "Only the start line counts now — add your own."; break;
      case "clearBumps": this.set({ bumps: [] }); this.msg = "Speed bumps cleared."; break;
      case "discardTrack": delete this.drafts[this.id]; save(DRAFT_KEY, this.drafts); this.apply(); this.msg = `Draft edits for ${t.name} discarded.`; break;
      case "discardAll": this.drafts = {}; save(DRAFT_KEY, this.drafts); this.apply(); this.msg = "All draft edits discarded."; break;
      case "debug": this.toggleDebug(); return;
      case "test": this.testDrive(); return;
      case "copy": {
        const json = this.exportJSON();
        navigator.clipboard?.writeText(json).then(() => { this.msg = "Copied — paste it over src/screen/track-edits.json."; this.render(true); })
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
    const key = el.dataset.edit as keyof TrackEdit | undefined;
    if (!key) return;
    const v = Number(el.value);
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
      `<button data-dev="${dev}" ${extra} style="border:2px solid ${on ? "#1a2a0a" : "#d8d2bd"};background:${on ? "#1a2a0a" : "#fff"};color:${on ? "#FFD600" : "#333"};border-radius:9px;padding:4px 10px;font:700 17px Caveat,cursive;cursor:pointer">${label}</button>`;
    const h = (text: string) => `<div style="margin:14px 0 5px;font-size:21px;font-weight:700;border-bottom:2px dashed #d8d2bd">${text}</div>`;
    const hint = (text: string) => `<div style="font-size:15px;color:#7a7460;line-height:1.2;margin-top:3px">${text}</div>`;
    const slider = (key: keyof TrackEdit, label: string, min: number, max: number, step: number, value: number, note: string) => `
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:18px;margin-top:8px">${label}<b data-out="${key}" style="font-family:sans-serif;font-size:14px">${value.toFixed(2)}</b></div>
      <input type="range" data-edit="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="width:100%;accent-color:#1a2a0a" />
      ${hint(note)}`;
    const tracks = TRACK_ORDER.map((k) => btn("track", TRACKS[k].name.split(" ")[0] + (this.drafts[k] && Object.keys(this.drafts[k]!).length ? " •" : ""), k === id, `data-track="${k}"`)).join(" ");
    const cps = t.gates.length - 1;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="font-size:28px;font-weight:700;line-height:1">🛠 Track editor</div>
        ${btn("close", "✕ Close")}
      </div>
      ${hint("Dev build only. Changes are drafts in this browser until you export them.")}
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px">${tracks}</div>

      ${h("Place on the road")}
      <div style="display:flex;gap:6px">${btn("tool", "🚩 Checkpoint (C)", this.tool === "checkpoint", 'data-tool="checkpoint"')} ${btn("tool", "▰ Speed bump (B)", this.tool === "bump", 'data-tool="bump"')}</div>
      ${hint("Click the road to add one · click an existing one to remove it.")}
      ${this.msg ? `<div style="margin-top:6px;background:#fff;border-left:4px solid #FFB300;padding:4px 8px;font-size:16px;border-radius:6px">${esc(this.msg)}</div>` : ""}

      ${h(`Checkpoints · ${cps} + start`)}
      <div style="font-size:17px">${t.autoGates ? "Automatic — the middle of every real bend." : "Hand-placed."}</div>
      <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap">${t.autoGates ? "" : btn("autoCheckpoints", "Back to automatic")} ${btn("clearCheckpoints", "Clear all")}</div>
      ${hint("They must be crossed in order. Skip one (e.g. by cutting across the grass) and that lap doesn't count until you go back.")}

      ${h(`Speed bumps · ${t.bumps.length}`)}
      ${slider("bumpLoss", "Speed lost at full speed", 0.05, 0.7, 0.05, t.bumpLoss, `Default ${BUMP_LOSS}. Slower cars lose less; the Monster Truck barely notices.`)}
      ${t.bumps.length ? `<div style="margin-top:5px">${btn("clearBumps", "Remove all bumps")}</div>` : ""}

      ${h("Surface")}
      ${slider("grip", "Road grip", 0.1, 1.5, 0.05, t.grip, `1 = tarmac, lower = icier (this track's default is ${t.baseGrip.toFixed(2)}). Oil and drifting still reduce it further.`)}

      ${h("Boundaries")}
      <div style="display:flex;gap:6px">${btn("walls", "🧱 Walls", t.walls, 'data-on="1"')} ${btn("walls", "🌾 Open track", !t.walls, 'data-on="0"')}</div>
      ${t.walls ? hint("The road edge is a wall.") : `
        ${hint(`Drive anywhere — <b>${t.theme.terrain.name}</b> off the road slows you and loosens grip, the scenery is solid, and the screen edge is a hard wall.`)}
        ${slider("roughness", `Off-road penalty (${t.theme.terrain.name})`, 0, 2, 0.1, t.roughness, `1 = default: top speed ×${t.theme.terrain.slow} on the terrain. 0 = no penalty.`)}
        ${slider("clutter", "Obstacles near the road", 0, 3, 0.25, t.clutter, `How much extra scenery to dodge off the road (${t.obstacles.length} obstacles now).`)}`}

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
      ${hint("Keys: E editor · C/B tools · Enter test drive · G checkpoint lines · Esc close")}`;
  }
}
