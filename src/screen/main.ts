import QRCode from "qrcode";
import { Net } from "../shared/net";
import {
  ALL_SLOTS,
  CAR_LABELS,
  CAR_TYPES,
  CLOSE_REPLACED,
  IN_BRAKE,
  IN_LEFT,
  IN_RIGHT,
  IN_THROTTLE,
  NAME_MAX,
  PLAYER_COLORS,
  ST_BOOST,
  ST_DRAFT,
  ST_FINISHED,
  ST_OFFLINE,
  ST_WRONG_WAY,
  makeClientId,
  makeRoomCode,
  slotNumber,
  type AnyMessage,
  type CarType,
  type Phase,
  type PlayerId,
  type PlayerStatus,
  type ResultRow,
  type Standing,
} from "../shared/protocol";
import { Renderer, ordinal } from "./render";
import { Race, STEP, type SimCar } from "./sim";
import { TRACKS, TRACK_ORDER, type TrackId } from "./tracks";

/** A player is a connected phone. The big screen is never a player. */
interface Player {
  id: PlayerId; name: string; carType: CarType; color: string;
  ready: boolean;
  connected: boolean; // false while a racing phone is reconnecting
}
interface Cup { tracks: TrackId[]; index: number; points: Partial<Record<PlayerId, number>>; names: Partial<Record<PlayerId, string>>; }

const LAP_OPTIONS = [2, 3, 5];
const POINTS = [10, 7, 5, 3];
const SETTINGS_KEY = "driftparty.settings.v2";
const ROOM_KEY = "driftparty.room";
const RACE_PHASES: Phase[] = ["COUNTDOWN", "RACING", "PAUSED"];

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const fmtT = (s: number) => {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60), t = Math.floor((s % 1) * 10);
  return `${m}:${String(ss).padStart(2, "0")}.${t}`;
};
const store = {
  get<T>(k: string, s: Storage): T | null { try { const v = s.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } },
  set(k: string, v: unknown, s: Storage) { try { s.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

class DriftScreen {
  phase: Phase = "LOBBY";
  pausedFrom: Phase = "RACING";
  settings = { track: "sunny" as TrackId, laps: 3, mode: "single" as "single" | "cup" };
  players: (Player | null)[] = [null, null, null, null];
  race: Race | null = null;
  trackId: TrackId = "sunny";
  cup: Cup | null = null;
  results: ResultRow[] = [];

  countdown = 0; countShown = -1; goT = 0;
  acc = 0; last = 0;

  net: Net | null = null;
  room = { code: "", token: "" };
  relay: "connecting" | "online" | "replaced" = "connecting";
  qr = "";
  thumbs: Partial<Record<TrackId, string>> = {};

  renderer!: Renderer;
  stage!: HTMLElement;
  toasts: { text: string; color: string; until: number }[] = [];
  bannerUntil = 0; bannerText = "";
  finalLapShown = false;
  lastStatus = ""; lastStatusT = 0; lastHudT = 0;

  els!: { lobby: HTMLElement; countdown: HTMLElement; hud: HTMLElement; results: HTMLElement };
  html = new Map<HTMLElement, string>();

  // ── setup ─────────────────────────────────────────────────────────────────
  mount() {
    const saved = store.get<typeof this.settings>(SETTINGS_KEY, localStorage);
    if (saved) {
      if (saved.track in TRACKS) this.settings.track = saved.track;
      if (LAP_OPTIONS.includes(saved.laps)) this.settings.laps = saved.laps;
      if (saved.mode === "cup" || saved.mode === "single") this.settings.mode = saved.mode;
    }
    this.trackId = this.settings.track;
    this.stage = document.getElementById("stage")!;
    this.renderer = new Renderer(document.getElementById("raceCanvas") as HTMLCanvasElement);
    this.layout();
    this.renderer.setTrack(TRACKS[this.trackId]);
    window.addEventListener("resize", () => this.layout());
    const thumbs = () => { for (const id of TRACK_ORDER) this.thumbs[id] = Renderer.thumbnail(TRACKS[id], 300); this.renderUI(); };
    document.fonts?.ready.then(() => { this.renderer.rebake(); thumbs(); }).catch(thumbs);

    this.els = {
      lobby: document.getElementById("lobby")!,
      countdown: document.getElementById("countdown")!,
      hud: document.getElementById("hud")!,
      results: document.getElementById("results")!,
    };
    document.getElementById("root")!.addEventListener("click", (e) => this.onClick(e));
    window.addEventListener("keydown", (e) => this.onKey(e));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && (this.phase === "RACING" || this.phase === "COUNTDOWN")) this.pause();
    });
    document.addEventListener("fullscreenchange", () => this.renderUI());

    this.openRoom();
    if (new URLSearchParams(location.search).has("debug")) (window as any).drift = this;
    this.last = performance.now();
    requestAnimationFrame((t) => this.loop(t));
    this.renderUI();
  }

  /** Size the HUD stage to the letterboxed canvas; 1em = 20 logical px. */
  layout() {
    this.renderer.resize();
    const c = document.getElementById("raceCanvas") as HTMLCanvasElement;
    this.stage.style.width = c.style.width;
    this.stage.style.height = c.style.height;
    this.stage.style.fontSize = (parseFloat(c.style.width) / 1600) * 20 + "px";
  }

  saveSettings() { store.set(SETTINGS_KEY, this.settings, localStorage); }
  joined(): Player[] { return this.players.filter((p): p is Player => !!p); }
  player(id: PlayerId): Player | null { return this.players[slotNumber(id) - 1]; }
  car(id: PlayerId): SimCar | undefined { return this.race?.cars.find((c) => c.id === id); }
  get inRace() { return RACE_PHASES.includes(this.phase); }
  racers(): PlayerId[] { return this.race && this.phase !== "LOBBY" ? this.race.cars.map((c) => c.id) : []; }

  // ── networking ────────────────────────────────────────────────────────────
  openRoom(fresh = false) {
    const saved = fresh ? null : store.get<{ code: string; token: string }>(ROOM_KEY, sessionStorage);
    this.room = saved?.code && saved.token ? saved : { code: makeRoomCode(), token: makeClientId() };
    store.set(ROOM_KEY, this.room, sessionStorage);
    this.relay = "connecting";
    this.refreshQR();
    this.net?.close();
    this.net = new Net("screen", this.room.code, this.room.token, {
      onOpen: () => { this.relay = "online"; this.renderUI(); },
      onClose: (code, terminal) => {
        if (!terminal) { this.relay = "connecting"; this.renderUI(); return; }
        if (code === CLOSE_REPLACED) { this.relay = "replaced"; this.renderUI(); return; }
        this.openRoom(true); // code collision → pick another
      },
      onMessage: (m) => this.onMsg(m),
    });
    this.renderUI();
  }

  controllerUrl() { return `${location.origin}/controller/?room=${encodeURIComponent(this.room.code)}`; }

  async refreshQR() {
    try { this.qr = await QRCode.toDataURL(this.controllerUrl(), { width: 280, margin: 1, errorCorrectionLevel: "M" }); }
    catch { this.qr = ""; }
    this.renderUI();
  }

  send(msg: AnyMessage) { this.net?.send(msg); }
  sendPhase(to?: PlayerId) {
    this.send({
      type: "phase", playerId: to, phase: this.phase, totalLaps: this.race?.laps ?? this.settings.laps,
      racers: this.racers(), track: TRACKS[this.trackId].name,
      cup: this.cup ? { race: this.cup.index + 1, of: this.cup.tracks.length } : null,
    });
  }

  onMsg(msg: AnyMessage) {
    switch (msg.type) {
      case "controllerJoined": {
        const id = msg.playerId;
        const prev = this.player(id);
        const racing = this.inRace && !!this.car(id);
        const p: Player = prev && !prev.connected
          ? { ...prev, connected: true }
          : { id, name: this.cup?.names[id] ?? `Player ${slotNumber(id)}`, carType: prev?.carType ?? "normal", color: PLAYER_COLORS[id], ready: false, connected: true };
        this.players[slotNumber(id) - 1] = p;
        if (racing) this.race!.setGhost(id, false);
        this.toast(prev && !prev.connected ? `${p.name} is back` : `${p.name} joined`, p.color);
        this.sendPhase(id);
        if (this.phase === "FINISHED") this.send({ type: "results", results: this.results, cup: this.cupResults() });
        this.lastStatus = "";
        this.renderUI();
        break;
      }
      case "controllerLeft": {
        const p = this.player(msg.playerId);
        if (!p) break;
        if (this.inRace && this.car(msg.playerId) && !this.car(msg.playerId)!.finished) {
          p.connected = false;
          this.race!.setGhost(msg.playerId, true);
          this.toast(`${p.name} lost connection…`, p.color);
        } else {
          this.players[slotNumber(msg.playerId) - 1] = null;
          this.toast(`${p.name} left`, p.color);
        }
        this.renderUI();
        break;
      }
      case "profile": {
        const p = this.player(msg.playerId!);
        if (!p) break;
        const name = typeof msg.name === "string" ? msg.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
        p.name = name || `Player ${slotNumber(p.id)}`;
        if (this.cup) this.cup.names[p.id] = p.name;
        if (!this.inRace && CAR_TYPES.includes(msg.carType)) p.carType = msg.carType;
        p.ready = msg.ready === true;
        const c = this.car(p.id);
        if (c) c.name = p.name;
        this.renderUI();
        break;
      }
      case "input": {
        const c = this.car(msg.playerId!);
        if (!c || c.ghost || c.finished || this.phase === "PAUSED") break;
        const k = typeof msg.k === "number" ? msg.k : 0;
        c.input = { throttle: !!(k & IN_THROTTLE), brake: !!(k & IN_BRAKE), left: !!(k & IN_LEFT), right: !!(k & IN_RIGHT) };
        break;
      }
    }
  }

  // ── game flow ─────────────────────────────────────────────────────────────
  unready() { return this.joined().filter((p) => p.connected && !p.ready); }

  canStart() { return this.joined().some((p) => p.connected); }

  /** Start a race (the next one in the cup, if a cup is running). */
  startRace(force = false) {
    if (this.inRace || !this.canStart()) return;
    if (!force && this.phase === "LOBBY" && this.unready().length) return;
    // Drop phones that never came back.
    this.players = this.players.map((p) => (p && p.connected ? p : null));
    if (this.phase === "LOBBY") this.cup = this.settings.mode === "cup" ? { tracks: [...TRACK_ORDER], index: 0, points: {}, names: {} } : null;
    this.trackId = this.cup ? this.cup.tracks[this.cup.index] : this.settings.track;
    const track = TRACKS[this.trackId];
    const field = this.joined();
    if (this.cup) for (const p of field) { this.cup.names[p.id] = p.name; this.cup.points[p.id] ??= 0; }
    this.race = new Race(track, field.map((p) => ({ id: p.id, name: p.name, color: p.color, carType: p.carType, ai: false })), this.settings.laps);
    this.renderer.setTrack(track);
    this.results = [];
    this.toasts = [];
    this.finalLapShown = false;
    this.bannerUntil = 0;
    this.countdown = 3;
    this.countShown = -1;
    this.acc = 0;
    this.lastStatus = "";
    this.phase = "COUNTDOWN";
    this.sendPhase();
    this.renderUI();
  }

  endRace() {
    const race = this.race!;
    this.results = race.rankings().map((c, i) => ({
      id: c.id, rank: i + 1, name: c.name, time: c.finished ? c.finishTime : null, best: c.bestLap,
      pts: c.finished ? POINTS[i] ?? 0 : 0,
    }));
    if (this.cup) for (const r of this.results) this.cup.points[r.id] = (this.cup.points[r.id] ?? 0) + r.pts;
    this.phase = "FINISHED";
    this.sendStatus(true);
    this.send({ type: "results", results: this.results, cup: this.cupResults() });
    this.sendPhase();
    this.renderUI();
  }

  standings(): Standing[] {
    if (!this.cup) return [];
    const cup = this.cup;
    return (Object.keys(cup.points) as PlayerId[])
      .map((id) => ({ id, name: cup.names[id] ?? id, points: cup.points[id] ?? 0 }))
      .sort((a, b) => b.points - a.points || (this.results.find((r) => r.id === a.id)?.rank ?? 9) - (this.results.find((r) => r.id === b.id)?.rank ?? 9));
  }

  cupResults() {
    return this.cup ? { race: this.cup.index + 1, of: this.cup.tracks.length, standings: this.standings() } : null;
  }

  get cupDone() { return !!this.cup && this.cup.index >= this.cup.tracks.length - 1; }

  next() {
    if (this.phase !== "FINISHED") return;
    if (this.cup) {
      if (this.cupDone) { this.returnToLobby(); return; }
      this.cup.index++;
    }
    this.startRace(true);
  }

  returnToLobby() {
    this.race = null;
    this.cup = null;
    this.players = this.players.map((p) => (p && p.connected ? { ...p, ready: false } : null));
    this.results = [];
    this.phase = "LOBBY";
    this.trackId = this.settings.track;
    this.renderer.setTrack(TRACKS[this.trackId]);
    this.sendPhase();
    this.renderUI();
  }

  pause() {
    if (this.phase !== "RACING" && this.phase !== "COUNTDOWN") return;
    this.pausedFrom = this.phase;
    this.phase = "PAUSED";
    for (const c of this.race?.cars ?? []) c.input = { throttle: false, brake: false, left: false, right: false };
    this.sendPhase();
    this.renderUI();
  }

  resume() {
    if (this.phase !== "PAUSED") return;
    this.phase = this.pausedFrom;
    this.last = performance.now();
    this.sendPhase();
    this.renderUI();
  }

  toast(text: string, color: string) {
    this.toasts.push({ text, color, until: performance.now() + 3500 });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  // ── main loop ─────────────────────────────────────────────────────────────
  loop(t: number) {
    const dt = Math.min((t - this.last) / 1000, 0.25);
    this.last = t;
    const race = this.race;
    let alpha = 1;

    if (race && this.phase === "COUNTDOWN") {
      this.countdown -= dt;
      const shown = Math.ceil(this.countdown);
      if (shown !== this.countShown && shown > 0) { this.countShown = shown; this.renderUI(); }
      if (this.countdown <= 0) {
        this.phase = "RACING";
        this.goT = 0.9;
        this.sendPhase();
        this.renderUI();
      }
    } else if (race && this.phase === "RACING") {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= STEP && steps < 40) { race.step(STEP); this.acc -= STEP; steps++; }
      alpha = this.acc / STEP;
      this.handleEvents(race);
      if (this.goT > 0) { this.goT -= dt; if (this.goT <= 0) this.renderUI(); }
      if (t - this.lastStatusT > 100) { this.sendStatus(false); this.lastStatusT = t; }
      if (race.isOver()) this.endRace();
    }

    if (this.phase !== "LOBBY") {
      this.renderer.frame(race, this.phase === "RACING" ? alpha : 1, this.phase === "RACING" ? dt : 0);
      if (t - this.lastHudT > 150) { this.lastHudT = t; this.renderUI(); }
    }
    requestAnimationFrame((tt) => this.loop(tt));
  }

  handleEvents(race: Race) {
    for (const e of race.events) {
      switch (e.k) {
        case "hit": this.renderer.sparks(e.x, e.y, e.imp); break;
        case "wall": this.renderer.dust(e.x, e.y, e.imp); break;
        case "final":
          if (!this.finalLapShown) { this.finalLapShown = true; this.bannerText = "FINAL LAP!"; this.bannerUntil = performance.now() + 2200; }
          break;
        case "finish": {
          const c = this.car(e.id);
          if (c) this.toast(`${c.name} finished ${ordinal(e.rank)}!`, c.color);
          break;
        }
      }
    }
    race.events.length = 0;
  }

  /** Batched per-phone race status; only sent when something changed. */
  sendStatus(force: boolean) {
    const race = this.race;
    if (!race) return;
    const rnk = race.rankings();
    const p: Partial<Record<PlayerId, PlayerStatus>> = {};
    for (const c of race.cars) {
      const flags = (c.finished ? ST_FINISHED : 0) | (c.wrongWay ? ST_WRONG_WAY : 0) | (c.boostT > 0 ? ST_BOOST : 0)
        | (c.drafting ? ST_DRAFT : 0) | (c.ghost ? ST_OFFLINE : 0);
      p[c.id] = [rnk.indexOf(c) + 1, race.lapOf(c), flags, c.hits];
    }
    const body = JSON.stringify(p);
    if (!force && body === this.lastStatus) return;
    this.lastStatus = body;
    this.send({ type: "status", totalLaps: race.laps, p });
  }

  // ── input ─────────────────────────────────────────────────────────────────
  onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === "INPUT" || e.repeat) return;
    switch (e.code) {
      case "Enter": case "NumpadEnter":
        if (this.phase === "LOBBY") this.startRace();
        else if (this.phase === "FINISHED") this.next();
        else if (this.phase === "PAUSED") this.resume();
        break;
      case "Escape": case "KeyP":
        if (this.phase === "PAUSED") this.resume(); else this.pause();
        break;
      case "KeyF": this.toggleFullscreen(); break;
      case "KeyL": if (this.phase === "FINISHED") this.returnToLobby(); break;
    }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }

  onClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!el) return;
    switch (el.dataset.action!) {
      case "setLaps": this.settings.laps = Number(el.dataset.laps); this.saveSettings(); break;
      case "setMode": this.settings.mode = el.dataset.mode as "single" | "cup"; this.saveSettings(); break;
      case "setTrack":
        this.settings.track = el.dataset.track as TrackId; this.settings.mode = "single"; this.saveSettings();
        this.trackId = this.settings.track;
        this.renderer.setTrack(TRACKS[this.trackId]);
        break;
      case "start": this.startRace(); break;
      case "startAnyway": this.startRace(true); break;
      case "next": this.next(); break;
      case "lobby": this.returnToLobby(); break;
      case "resume": this.resume(); break;
      case "pause": this.pause(); break;
      case "quit": this.returnToLobby(); break;
      case "fullscreen": this.toggleFullscreen(); break;
      case "newRoom": this.openRoom(true); break;
      case "openController": window.open(this.controllerUrl(), "_blank"); break;
    }
    this.renderUI();
  }

  // ── DOM overlays ──────────────────────────────────────────────────────────
  set(el: HTMLElement, html: string, show: boolean) {
    el.style.display = show ? "block" : "none";
    if (!show) return;
    if (this.html.get(el) === html) return;
    this.html.set(el, html);
    el.innerHTML = html;
  }

  renderUI() {
    if (!this.els) return;
    const ph = this.phase;
    this.set(this.els.lobby, ph === "LOBBY" ? this.lobbyHTML() : "", ph === "LOBBY");
    const showCount = ph === "COUNTDOWN" || ph === "PAUSED" || (ph === "RACING" && this.goT > 0);
    this.set(this.els.countdown, showCount ? this.overlayHTML() : "", showCount);
    this.set(this.els.hud, this.inRace ? this.hudHTML() : "", this.inRace);
    this.set(this.els.results, ph === "FINISHED" ? this.resultsHTML() : "", ph === "FINISHED");
  }

  btn(action: string, label: string, style: string, extra = "") {
    return `<button data-action="${action}" ${extra} style="border:none;border-radius:11px;font-weight:700;font-family:Caveat,cursive;cursor:pointer;white-space:nowrap;${style}">${label}</button>`;
  }

  lobbyHTML() {
    const s = this.settings, joined = this.joined(), unready = this.unready();
    const cup = s.mode === "cup";
    const slots = this.players.map((p, i) => {
      const id = ALL_SLOTS[i], col = PLAYER_COLORS[id];
      if (!p) {
        return `<div style="flex:1;min-width:0;border:3px dashed #cfc7a8;border-radius:14px;padding:10px 12px;display:flex;align-items:center;gap:10px;color:#a39c80">
          <div style="width:34px;height:34px;border-radius:50%;border:3px dashed ${col};flex-shrink:0;opacity:.6"></div>
          <div style="font-size:18px;line-height:1.1">Waiting for a phone…</div></div>`;
      }
      const pill = p.ready ? `<span style="background:#4CAF50;color:#fff;border-radius:12px;padding:2px 10px;font-size:15px">✓ Ready</span>`
        : `<span style="background:#eee;color:#999;border-radius:12px;padding:2px 10px;font-size:15px">Not ready</span>`;
      return `<div style="flex:1;min-width:0;background:#fff;border-radius:14px;padding:10px 12px;border-left:6px solid ${col};box-shadow:0 2px 7px rgba(0,0,0,0.06);display:flex;align-items:center;gap:10px;animation:fadeIn .3s">
        <div style="width:34px;height:34px;border-radius:50%;background:${col};color:#fff;font-size:18px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i + 1}</div>
        <div style="min-width:0;flex:1">
          <div style="font-size:21px;font-weight:700;color:#222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>
          <div style="display:flex;align-items:center;gap:6px;font-size:15px;color:#888">${CAR_LABELS[p.carType]} ${pill}</div>
        </div></div>`;
    }).join("");
    const tracks = TRACK_ORDER.map((id, i) => {
      const t = TRACKS[id], on = cup || s.track === id;
      const img = this.thumbs[id] ? `<img src="${this.thumbs[id]}" alt="" style="width:100%;display:block;border-radius:8px" />` : `<div style="aspect-ratio:16/9;background:#ddd;border-radius:8px"></div>`;
      return `<button data-action="setTrack" data-track="${id}" style="flex:1;min-width:0;padding:6px;border:3px solid ${on ? "#1a2a0a" : "transparent"};background:${on ? "#fff" : "rgba(255,255,255,0.55)"};border-radius:12px;cursor:pointer;text-align:left;opacity:${on ? 1 : 0.75}">
        ${img}
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:4px;font-family:Caveat,cursive">
          <span style="font-size:18px;font-weight:700;color:#222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${cup ? `${i + 1}. ` : ""}${esc(t.name)}</span>
          <span style="font-size:13px;color:#c0392b;letter-spacing:1px">${"●".repeat(t.difficulty)}<span style="color:#ddd">${"●".repeat(3 - t.difficulty)}</span></span>
        </div></button>`;
    }).join("");
    const tag = cup ? "All five tracks in a row — 10 / 7 / 5 / 3 points per race. Most points wins the cup!" : TRACKS[s.track].tag;
    const seg = (action: string, key: string, val: string | number, label: string, on: boolean) =>
      `<button data-action="${action}" data-${key}="${val}" style="padding:7px 14px;border:2px solid ${on ? "#E63946" : "#ddd"};background:${on ? "#E63946" : "#fff"};color:${on ? "#fff" : "#444"};border-radius:9px;font-size:19px;font-weight:700;font-family:Caveat,cursive;cursor:pointer">${label}</button>`;
    const relay = this.relay === "online" ? ["#4CAF50", "Online — phones can join"]
      : this.relay === "replaced" ? ["#E63946", "Open in another tab"] : ["#FFB300", "Connecting to server…"];
    const qr = this.qr ? `<img src="${this.qr}" alt="QR code to join" style="width:150px;height:150px;image-rendering:pixelated" />` : `<div style="color:#999;font-size:13px">…</div>`;
    let startLabel = "START RACE ▶", enabled = true;
    if (!joined.length) { startLabel = "Waiting for players…"; enabled = false; }
    else if (unready.length) { startLabel = `Waiting for ${unready.length} to ready up…`; enabled = false; }
    else if (cup) startLabel = "START CUP ▶";
    const startStyle = enabled ? "background:#FFD600;color:#1a2a0a;box-shadow:0 4px 0 #b8920a" : "background:#cfc7a8;color:#6b6450;box-shadow:0 4px 0 #a39c80;cursor:default";

    return `<div style="position:absolute;inset:0;background:#f0ede4;display:flex;flex-direction:column;z-index:10">
      <div style="background:#1a2a0a;padding:10px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0">
        <div>
          <div style="font-size:42px;font-weight:700;color:#FFD600;line-height:1">DRIFT PARTY</div>
          <div style="font-size:16px;color:#8BC34A;margin-top:2px">Free online party racing — your phone is the controller</div>
        </div>
        <div style="display:flex;gap:8px">
          ${this.btn("fullscreen", document.fullscreenElement ? "⤡ Exit fullscreen" : "⛶ Fullscreen", "padding:9px 14px;background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);font-size:16px")}
          ${this.btn("openController", "Test controller ↗", "padding:9px 14px;background:#E63946;color:#fff;font-size:16px")}
        </div>
      </div>
      <div style="flex:1;display:flex;gap:20px;padding:16px 24px;min-height:0">
        <div style="width:230px;flex-shrink:0;display:flex;flex-direction:column;gap:12px">
          <div style="background:#fff;border-radius:14px;padding:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);text-align:center">
            <div style="font-size:19px;font-weight:700;color:#333">Join with your phone</div>
            <div style="width:150px;height:150px;margin:6px auto 0;display:flex;align-items:center;justify-content:center">${qr}</div>
            <div style="margin-top:6px;font-size:11px;color:#aaa;letter-spacing:1px;font-family:sans-serif">ROOM CODE</div>
            <div style="font-size:36px;font-weight:700;color:#222;letter-spacing:5px;line-height:1.05">${esc(this.room.code)}</div>
            <div style="font-size:12px;color:#999;font-family:sans-serif">${esc(location.host)}/controller</div>
            <div style="margin-top:6px;display:flex;align-items:center;justify-content:center;gap:6px;font-size:15px;color:#666">
              <span style="width:9px;height:9px;border-radius:50%;background:${relay[0]};display:inline-block"></span>${relay[1]}</div>
            ${this.relay === "replaced" ? this.btn("newRoom", "Start a new room here", "margin-top:8px;padding:6px 12px;background:#E63946;color:#fff;font-size:15px") : ""}
          </div>
        </div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:14px">
          <div>
            <div style="font-size:22px;font-weight:700;color:#333;margin-bottom:6px">Racers <span style="font-size:16px;color:#999;font-weight:400">· up to 4 phones</span></div>
            <div style="display:flex;gap:10px">${slots}</div>
          </div>
          <div style="flex:1;min-height:0">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px">
              <div style="font-size:22px;font-weight:700;color:#333">${cup ? "🏆 Cup — all tracks" : "Track"}</div>
              <div style="display:flex;align-items:center;gap:6px">
                ${seg("setMode", "mode", "single", "Single race", !cup)}${seg("setMode", "mode", "cup", "🏆 Cup (5 races)", cup)}
                <span style="width:14px"></span><span style="font-size:18px;color:#888">Laps</span>
                ${LAP_OPTIONS.map((n) => seg("setLaps", "laps", n, String(n), s.laps === n)).join("")}
              </div>
            </div>
            <div style="display:flex;gap:10px">${tracks}</div>
            <div style="margin-top:8px;font-size:20px;color:#6b6450">${esc(tag)}</div>
          </div>
        </div>
      </div>
      <div style="background:#1a2a0a;padding:10px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-shrink:0">
        <div style="font-size:16px;color:rgba(255,255,255,0.55);line-height:1.35">Phones: left thumb steers · right thumb GAS / BRAKE · brake + steer = drift<br>
          <span style="color:rgba(255,255,255,0.35)">Boost pads ⚡ · tuck in behind someone for a slipstream · Enter start · Esc pause · F fullscreen</span></div>
        <div style="display:flex;align-items:center;gap:12px;flex-shrink:0">
          ${joined.length && unready.length ? this.btn("startAnyway", "Start anyway", "padding:6px 10px;background:none;color:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.25);font-size:15px") : ""}
          <button data-action="start" style="padding:12px 30px;border:none;border-radius:11px;font-size:24px;font-weight:700;font-family:Caveat,cursive;cursor:pointer;${startStyle}">${startLabel}</button>
        </div>
      </div>
    </div>`;
  }

  overlayHTML() {
    if (this.phase === "PAUSED") {
      return `<div style="position:absolute;inset:0;background:rgba(0,0,0,0.6);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;z-index:30">
        <div style="font-size:96px;font-weight:700;color:#FFD600;line-height:1">PAUSED</div>
        <div style="display:flex;gap:12px">
          ${this.btn("resume", "Resume ▶", "padding:12px 34px;background:#FFD600;color:#1a2a0a;font-size:24px;box-shadow:0 4px 0 #b8920a")}
          ${this.btn("quit", "Quit to lobby", "padding:12px 26px;background:#666;color:#fff;font-size:22px;box-shadow:0 4px 0 #444")}
        </div>
        <div style="font-size:18px;color:rgba(255,255,255,0.5)">Esc / Enter to resume</div>
      </div>`;
    }
    const go = this.phase === "RACING";
    const v = go ? "GO!" : String(Math.max(1, this.countShown));
    const col = go ? "#4CAF50" : "#FFD600";
    const t = TRACKS[this.trackId];
    const sub = this.cup ? `Race ${this.cup.index + 1} of ${this.cup.tracks.length} · ${t.name} · ${this.race?.laps} laps` : `${t.name} · ${this.race?.laps} laps`;
    return `<div style="position:absolute;inset:0;background:${go ? "transparent" : "rgba(0,0,0,0.45)"};display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:20;pointer-events:none">
      <div style="font-size:210px;font-weight:700;color:${col};text-shadow:0 0 60px ${col}, 0 6px 0 rgba(0,0,0,0.4);line-height:1;animation:popIn 0.45s ease">${v}</div>
      ${go ? "" : `<div style="font-size:30px;color:#fff;margin-top:8px">${esc(sub)}</div><div style="font-size:22px;color:rgba(255,255,255,0.65)">${esc(t.tag)}</div>`}
    </div>`;
  }

  hudHTML() {
    const race = this.race;
    if (!race) return "";
    const rnk = race.rankings(), leaderLap = race.lapOf(rnk[0]), t = TRACKS[this.trackId];
    const chips = rnk.map((c, i) => `<div style="display:flex;align-items:center;gap:.3em;background:${c.ghost ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.14)"};border-radius:.8em;padding:.1em .6em .1em .25em;opacity:${c.ghost ? 0.55 : 1};white-space:nowrap">
        <span style="width:1.3em;height:1.3em;border-radius:50%;background:${c.color};color:#fff;font-size:.85em;font-weight:700;display:inline-flex;align-items:center;justify-content:center">${i + 1}</span>
        <span style="max-width:6.5em;overflow:hidden;text-overflow:ellipsis">${c.ghost ? "📵 " : ""}${esc(c.name)}</span>${c.finished ? `<span style="color:#FFD600">🏁 ${fmtT(c.finishTime!)}</span>` : ""}</div>`).join("");
    const now = performance.now();
    this.toasts = this.toasts.filter((x) => x.until > now);
    const toasts = this.toasts.map((x) => `<div style="background:rgba(0,0,0,0.8);color:#fff;border-left:.3em solid ${x.color};padding:.25em .8em;border-radius:.5em;font-size:1.1em;animation:fadeIn .25s">${esc(x.text)}</div>`).join("");
    const banner = now < this.bannerUntil
      ? `<div style="position:absolute;top:36%;left:0;right:0;text-align:center;font-size:6em;font-weight:700;color:#FF5252;text-shadow:0 0 .4em rgba(255,82,82,0.6),0 .06em 0 rgba(0,0,0,0.45);pointer-events:none;animation:popIn .4s">${this.bannerText}</div>` : "";
    return `<div style="position:absolute;top:0;left:0;right:0;height:3.2em;background:rgba(10,16,6,0.82);display:flex;align-items:center;gap:1em;padding:0 .8em;color:#fff;font-size:1em;z-index:10">
        <div style="line-height:1;white-space:nowrap"><div style="font-size:1.25em;font-weight:700">${esc(t.name)}</div>
          <div style="font-size:.8em;color:rgba(255,255,255,0.55)">${this.cup ? `🏆 Race ${this.cup.index + 1}/${this.cup.tracks.length}` : "Single race"}</div></div>
        <div style="text-align:center;line-height:1;white-space:nowrap;padding:0 .6em;border-left:1px solid rgba(255,255,255,0.15);border-right:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:.7em;color:rgba(255,255,255,0.5);letter-spacing:.1em;font-family:sans-serif">LAP</div>
          <div style="font-size:1.6em;font-weight:700;color:${leaderLap === race.laps ? "#FF5252" : "#fff"}">${leaderLap}/${race.laps}</div></div>
        <div style="font-size:1.4em;font-weight:700;color:#FFD600;min-width:3.6em">${fmtT(race.time)}</div>
        <div style="flex:1;display:flex;gap:.5em;overflow:hidden;font-size:1.15em">${chips}</div>
        <button data-action="pause" title="Pause (Esc)" style="background:rgba(255,255,255,0.12);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:.5em;padding:.2em .7em;font-size:1em;font-family:Caveat,cursive;font-weight:700;cursor:pointer">⏸ Pause</button>
      </div>
      <div style="position:absolute;bottom:.8em;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:.3em;z-index:12;pointer-events:none">${toasts}</div>
      ${banner}`;
  }

  resultsHTML() {
    const t = TRACKS[this.trackId], bestLap = Math.min(...this.results.map((r) => r.best ?? Infinity));
    const rows = this.results.map((r) => {
      const col = PLAYER_COLORS[r.id], car = this.car(r.id);
      return `<div style="display:flex;align-items:center;gap:14px;margin-bottom:8px;padding:8px 14px;background:#fff;border-radius:12px;border-left:6px solid ${col}">
        <div style="font-size:30px;font-weight:700;color:${r.rank === 1 ? "#E6A700" : "#bbb"};width:36px;text-align:center">${r.rank === 1 ? "🏆" : r.rank}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:23px;font-weight:700;color:#222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}</div>
          <div style="font-size:14px;color:#999">${car ? CAR_LABELS[car.cfg.type] : ""}${r.best === bestLap ? ` · <span style="color:#7B1FA2">⏱ fastest lap</span>` : ""}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:23px;font-weight:700;color:#333">${r.time !== null ? fmtT(r.time) : "DNF"}</div>
          <div style="font-size:13px;color:#999;font-family:sans-serif">best ${r.best !== null ? fmtT(r.best) : "—"}</div>
        </div>
        ${this.cup ? `<div style="font-size:22px;font-weight:700;color:#2E7D32;width:52px;text-align:right">+${r.pts}</div>` : ""}
      </div>`;
    }).join("");
    let standings = "", title = "RACE OVER!", buttons: string;
    if (this.cup) {
      const st = this.standings();
      standings = `<div style="margin-top:14px;font-size:24px;font-weight:700;color:#1a2a0a">${this.cupDone ? "🏆 Final cup standings" : `Cup standings · after race ${this.cup.index + 1} of ${this.cup.tracks.length}`}</div>
        ${st.map((s, i) => `<div style="display:flex;align-items:center;gap:10px;padding:4px 10px;font-size:21px;color:#333">
          <span style="width:26px;color:#999">${i + 1}.</span><span style="width:12px;height:12px;border-radius:50%;background:${PLAYER_COLORS[s.id]}"></span>
          <span style="flex:1">${esc(s.name)}${this.cupDone && i === 0 ? " 👑" : ""}</span><b>${s.points} pts</b></div>`).join("")}`;
      if (this.cupDone) title = `${esc(st[0]?.name ?? "")} WINS THE CUP!`;
      const nextName = this.cupDone ? "" : TRACKS[this.cup.tracks[this.cup.index + 1]].name;
      buttons = this.cupDone
        ? this.btn("lobby", "Back to lobby (Enter)", "padding:12px 30px;background:#FFD600;color:#1a2a0a;font-size:22px;box-shadow:0 4px 0 #b8920a")
        : this.btn("lobby", "Quit cup", "padding:12px 24px;background:#666;color:#fff;font-size:20px;box-shadow:0 4px 0 #444")
          + this.btn("next", `Next: ${esc(nextName)} (Enter) ▶`, "padding:12px 30px;background:#FFD600;color:#1a2a0a;font-size:22px;box-shadow:0 4px 0 #b8920a");
    } else {
      buttons = this.btn("lobby", "Lobby (L)", "padding:12px 28px;background:#666;color:#fff;font-size:21px;box-shadow:0 4px 0 #444")
        + this.btn("next", "Race again (Enter) ▶", "padding:12px 30px;background:#FFD600;color:#1a2a0a;font-size:21px;box-shadow:0 4px 0 #b8920a");
    }
    return `<div style="position:absolute;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:20;padding:16px">
      <div style="background:#f0ede4;border-radius:20px;padding:26px 36px;width:min(700px,100%);max-height:100%;overflow:auto;box-shadow:0 10px 50px rgba(0,0,0,0.55)">
        <div style="font-size:48px;font-weight:700;color:#1a2a0a;text-align:center;line-height:1">${title}</div>
        <div style="font-size:17px;color:#999;text-align:center;margin:6px 0 18px">${esc(t.name)} · ${this.race?.laps} laps</div>
        ${rows}${standings}
        <div style="display:flex;gap:11px;margin-top:18px;justify-content:center">${buttons}</div>
      </div>
    </div>`;
  }
}

new DriftScreen().mount();
