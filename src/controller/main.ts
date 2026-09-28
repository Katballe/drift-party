import { carIcon } from "../shared/carArt";
import { CARS, carStats, type CarStats } from "../shared/cars";
import { Net } from "../shared/net";
import {
  CAR_TYPES,
  CLOSE_NO_ROOM,
  CLOSE_REPLACED,
  CLOSE_ROOM_FULL,
  IN_BRAKE,
  IN_LEFT,
  IN_RIGHT,
  IN_THROTTLE,
  NAME_MAX,
  PLAYER_COLORS,
  PLAYER_COLOR_NAMES,
  ST_BOOST,
  ST_DRAFT,
  ST_FINISHED,
  ST_MISSED,
  ST_OFFROAD,
  ST_WRONG_WAY,
  isRoomCode,
  makeClientId,
  normalizeRoomCode,
  slotNumber,
  type AnyMessage,
  type CarType,
  type CupInfo,
  type Phase,
  type PlayerId,
  type PlayerStatus,
  type ResultRow,
  type Standing,
} from "../shared/protocol";

type Conn = "idle" | "connecting" | "connected" | "noHost";
type View = "join" | "lobby" | "race" | "spectate" | "finished" | "results";
type Btn = "left" | "right" | "throttle" | "brake";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const ordinal = (n: number) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${Math.floor((s % 1) * 10)}`;
const ls = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
};
const RACE_PHASES: Phase[] = ["COUNTDOWN", "RACING", "PAUSED"];
const BTNS: Btn[] = ["left", "right", "throttle", "brake"];
const KEYS: Record<string, Btn> = {
  ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
  ArrowUp: "throttle", KeyW: "throttle", ArrowDown: "brake", KeyS: "brake", Space: "brake",
};
const STAT_LABELS: [keyof CarStats, string][] = [["speed", "Top speed"], ["accel", "Acceleration"], ["handling", "Handling"], ["weight", "Weight"], ["offroad", "Off-road"]];

function clientId(): string {
  try {
    let id = sessionStorage.getItem("driftparty.cid");
    if (!id) { id = makeClientId(); sessionStorage.setItem("driftparty.cid", id); }
    return id;
  } catch { return makeClientId(); }
}

/**
 * Phone gamepad. Connects to the Room relay by code (typed or from the QR deep
 * link), is assigned a player slot, and streams gas/brake/steer to the screen.
 */
class DriftController {
  conn: Conn = "idle";
  error = "";
  code = "";
  myId: PlayerId | null = null;
  phase: Phase = "LOBBY";
  totalLaps = 3;
  racers: PlayerId[] = [];
  field = 0;
  track = "";
  cup: CupInfo | null = null;
  name = (ls.get("driftparty.name") ?? "").slice(0, NAME_MAX);
  carType: CarType = CAR_TYPES.includes(ls.get("driftparty.car") as CarType) ? (ls.get("driftparty.car") as CarType) : "normal";
  ready = false;
  st: PlayerStatus | null = null;
  results: ResultRow[] = [];
  standings: Standing[] = [];

  btn: Record<Btn, boolean> = { left: false, right: false, throttle: false, brake: false };
  fingers = new Set<Btn>();    // zones under fingers currently on the screen
  keys = new Set<string>();    // held keyboard codes (desktop testing)
  mouseBtn: Btn | null = null;
  lastK = -1;
  keepalive = 0;
  net: Net | null = null;
  cid = clientId();
  view: View | "" = "";
  viewKey = "";
  portrait = false;
  touch = false; // a phone/tablet (coarse pointer) — the only thing that needs turning sideways
  wakeLock: any = null;
  nameTimer = 0;
  root!: HTMLElement;

  mount() {
    this.root = document.getElementById("root")!;
    this.checkOrientation();
    window.addEventListener("resize", () => this.checkOrientation());
    window.addEventListener("orientationchange", () => setTimeout(() => this.checkOrientation(), 200));
    screen.orientation?.addEventListener?.("change", () => this.checkOrientation());
    document.addEventListener("focusout", () => setTimeout(() => this.checkOrientation(), 350)); // keyboard closed
    this.bindTouch();
    this.bindKeys();
    this.root.addEventListener("click", (e) => this.onClick(e));
    this.root.addEventListener("input", (e) => this.onInput(e));
    this.root.addEventListener("submit", (e) => { e.preventDefault(); this.join(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.net) this.requestWakeLock();
      if (document.visibilityState === "hidden") this.releaseAll();
    });

    // Auto-connect from ?room= or #CODE deep link (QR code).
    const params = new URLSearchParams(location.search);
    const room = normalizeRoomCode(params.get("room") || location.hash.replace(/^#/, ""));
    if (isRoomCode(room)) { this.code = room; this.connect(); }
    this.render();
  }

  // ── networking ────────────────────────────────────────────────────────────
  join() {
    const input = this.root.querySelector<HTMLInputElement>("#roomInput");
    const code = normalizeRoomCode(input?.value ?? this.code);
    if (!isRoomCode(code)) { this.error = "Enter the room code shown on the big screen."; this.render(true); return; }
    this.code = code;
    this.requestWakeLock();
    this.connect();
  }

  connect() {
    this.net?.close();
    this.error = "";
    this.conn = "connecting";
    this.myId = null;
    this.net = new Net("controller", this.code, this.cid, {
      onMessage: (m) => this.onMsg(m),
      onClose: (code, terminal) => {
        if (!terminal) { if (this.conn !== "idle") { this.conn = "connecting"; this.render(); } return; }
        this.net = null;
        this.conn = "idle";
        this.myId = null;
        this.phase = "LOBBY";
        this.error = code === CLOSE_ROOM_FULL ? "That game is full — 8 phones max."
          : code === CLOSE_NO_ROOM ? `No game with code ${this.code}. Check the code on the big screen.`
          : code === CLOSE_REPLACED ? "You joined this game from another tab." : "Couldn't join that game.";
        this.releaseAll();
        this.render(true);
      },
    });
    this.render(true);
  }

  leave() {
    this.net?.close();
    this.net = null;
    this.conn = "idle";
    this.myId = null;
    this.phase = "LOBBY";
    this.ready = false;
    this.st = null;
    this.releaseAll();
    history.replaceState(null, "", location.pathname);
    try { void this.wakeLock?.release(); } catch { /* noop */ }
    this.wakeLock = null;
    this.render(true);
  }

  send(msg: AnyMessage) { this.net?.send(msg); }
  sendProfile() { this.send({ type: "profile", name: this.name, carType: this.carType, ready: this.ready }); }

  onMsg(msg: AnyMessage) {
    switch (msg.type) {
      case "assigned":
        this.myId = msg.playerId;
        this.conn = msg.screen ? "connected" : "noHost";
        this.requestWakeLock();
        history.replaceState(null, "", `${location.pathname}?room=${encodeURIComponent(this.code)}`);
        this.sendProfile();
        this.render(true);
        break;
      case "screenJoined":
        this.conn = "connected";
        this.sendProfile();
        this.render();
        break;
      case "screenLeft":
        this.conn = "noHost";
        this.releaseAll();
        this.render();
        break;
      case "phase": {
        const prev = this.phase;
        Object.assign(this, { phase: msg.phase, totalLaps: msg.totalLaps, racers: msg.racers ?? [], field: msg.field ?? 0, track: msg.track ?? "", cup: msg.cup ?? null });
        if (this.conn === "noHost" || this.conn === "connecting") this.conn = "connected";
        if (msg.phase === "LOBBY" && prev !== "LOBBY") { this.ready = false; this.st = null; this.standings = []; this.sendProfile(); }
        if (msg.phase === "COUNTDOWN" && prev !== "COUNTDOWN" && prev !== "PAUSED") { this.st = null; this.results = []; }
        if (msg.phase === "RACING" && prev === "COUNTDOWN") this.buzz(90);
        if (!RACE_PHASES.includes(msg.phase)) this.releaseAll();
        this.render();
        break;
      }
      case "status": {
        if (!this.myId) break;
        const s = msg.p[this.myId];
        if (!s) break;
        const prev = this.st;
        this.st = s;
        this.totalLaps = msg.totalLaps;
        if (prev) {
          if (s[2] & ST_FINISHED && !(prev[2] & ST_FINISHED)) this.buzz([100, 60, 180]);
          else if (s[1] > prev[1]) this.buzz([40, 50, 40]);
          else if (s[2] & ST_BOOST && !(prev[2] & ST_BOOST)) this.buzz(35);
          else if (s[3] > prev[3]) this.buzz(30);
        }
        this.render();
        break;
      }
      case "results":
        this.results = Array.isArray(msg.results) ? msg.results : [];
        this.standings = msg.cup?.standings ?? [];
        this.render();
        break;
    }
  }

  // ── input ─────────────────────────────────────────────────────────────────
  get racing() { return this.view === "race"; }

  /** Which control is at this screen point? The pad is split into gap-free
   *  zones matching the drawn buttons, so a thumb can never land "between" them. */
  zoneAt(x: number, y: number): Btn | null {
    const pad = document.getElementById("pad");
    if (!pad) return null;
    const r = pad.getBoundingClientRect();
    const u = (x - r.left) / r.width, v = (Math.max(r.top, y) - r.top) / r.height;
    if (u < 0 || u > 1 || v > 1) return null;
    if (u < 0.23) return "left";
    if (u < 0.46) return "right";
    return v < 0.6 ? "throttle" : "brake";
  }

  bindTouch() {
    // Rebuild the held set from *all* fingers currently down on every touch event,
    // so a missed/cancelled event can never leave a button stuck or dropped.
    const sync = (e: TouchEvent) => {
      if (!this.racing) { if (this.fingers.size) { this.fingers.clear(); this.recompute(); } return; }
      if (e.cancelable) e.preventDefault();
      this.fingers = new Set();
      for (const t of Array.from(e.touches)) { const z = this.zoneAt(t.clientX, t.clientY); if (z) this.fingers.add(z); }
      this.recompute();
    };
    for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
      document.addEventListener(ev, sync, { passive: false });
    }
    document.addEventListener("contextmenu", (e) => { if (this.racing) e.preventDefault(); });
    document.addEventListener("gesturestart", (e) => { if (this.racing) e.preventDefault(); });

    // Mouse fallback for desktop testing.
    document.addEventListener("mousedown", (e) => {
      if (!this.racing || e.button !== 0) return;
      const z = this.zoneAt(e.clientX, e.clientY);
      if (z) { this.mouseBtn = z; this.recompute(); }
    });
    document.addEventListener("mouseup", () => { if (this.mouseBtn) { this.mouseBtn = null; this.recompute(); } });
  }

  bindKeys() {
    const on = (e: KeyboardEvent, down: boolean) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || !KEYS[e.code]) return;
      if (this.racing) e.preventDefault();
      if (down) this.keys.add(e.code); else this.keys.delete(e.code);
      this.recompute();
    };
    window.addEventListener("keydown", (e) => on(e, true));
    window.addEventListener("keyup", (e) => on(e, false));
    window.addEventListener("blur", () => this.releaseAll());
  }

  /** Merge fingers, keys and mouse into the button state and send it. */
  recompute() {
    const held = new Set<Btn>([...this.fingers, ...[...this.keys].map((k) => KEYS[k])]);
    if (this.mouseBtn) held.add(this.mouseBtn);
    for (const b of BTNS) this.btn[b] = held.has(b);
    this.pushInput();
  }

  releaseAll() {
    this.fingers.clear();
    this.keys.clear();
    this.mouseBtn = null;
    this.btn = { left: false, right: false, throttle: false, brake: false };
    this.pushInput(true);
  }

  /** Send the button state now if it changed; a slow keepalive covers screen reloads. */
  pushInput(force = false) {
    this.paintButtons();
    const k = (this.btn.throttle ? IN_THROTTLE : 0) | (this.btn.brake ? IN_BRAKE : 0) | (this.btn.left ? IN_LEFT : 0) | (this.btn.right ? IN_RIGHT : 0);
    const live = RACE_PHASES.includes(this.phase) && this.conn === "connected" && !!this.myId && this.racers.includes(this.myId);
    if (!live) { this.lastK = -1; return; }
    if (k === this.lastK && !force) return;
    this.lastK = k;
    this.send({ type: "input", k });
  }

  startKeepalive() {
    clearInterval(this.keepalive);
    this.keepalive = window.setInterval(() => {
      if (!this.racing) return;
      this.lastK = -1;
      this.pushInput();
    }, 500);
  }

  // ── platform niceties ─────────────────────────────────────────────────────
  buzz(p: number | number[]) { try { navigator.vibrate?.(p); } catch { /* unsupported */ } }

  async requestWakeLock() {
    try {
      if (!("wakeLock" in navigator) || (this.wakeLock && !this.wakeLock.released)) return;
      this.wakeLock = await (navigator as any).wakeLock.request("screen");
    } catch { /* denied or unsupported */ }
  }

  goFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: "hide" })
      .then(() => (screen.orientation as any)?.lock?.("landscape"))
      .catch(() => {});
  }

  checkOrientation() {
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    // While typing, the on-screen keyboard shrinks the viewport and could make a
    // portrait phone look sideways — keep the last answer until it closes.
    if (coarse && document.activeElement?.tagName === "INPUT") return;
    const p = coarse && window.innerHeight > window.innerWidth;
    if (p === this.portrait && coarse === this.touch) return;
    this.portrait = p;
    this.touch = coarse;
    this.render(); // rebuilds the race view; elsewhere just patches the rotate prompt
  }

  // ── lobby actions ─────────────────────────────────────────────────────────
  onClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!el) return;
    switch (el.dataset.action) {
      case "leave": this.leave(); break;
      case "car":
        this.carType = el.dataset.car as CarType;
        ls.set("driftparty.car", this.carType);
        this.sendProfile();
        this.render(true);
        break;
      case "ready":
        this.ready = !this.ready;
        this.sendProfile();
        if (this.ready) { this.goFullscreen(); this.requestWakeLock(); this.buzz(20); }
        this.render(true);
        break;
    }
  }

  onInput(e: Event) {
    const el = e.target as HTMLInputElement;
    if (el.id === "roomInput") {
      const v = normalizeRoomCode(el.value);
      if (v !== el.value) el.value = v;
    } else if (el.id === "nameInput") {
      this.name = el.value.slice(0, NAME_MAX);
      ls.set("driftparty.name", this.name.trim());
      clearTimeout(this.nameTimer);
      this.nameTimer = window.setTimeout(() => this.sendProfile(), 300);
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  currentView(): View {
    if (this.conn === "idle" || !this.myId) return "join";
    if (RACE_PHASES.includes(this.phase)) {
      if (!this.racers.includes(this.myId)) return "spectate";
      return this.st && this.st[2] & ST_FINISHED ? "finished" : "race";
    }
    if (this.phase === "FINISHED") return this.racers.includes(this.myId) ? "results" : "spectate";
    return "lobby";
  }

  /** Rebuild the DOM only when the view changes; otherwise patch text in place so
   *  the race controls are never replaced while a finger is on them. */
  render(force = false) {
    const v = this.currentView();
    const key = v + (this.portrait && v === "race" ? ":portrait" : "");
    if (force || key !== this.viewKey) {
      const prevFocus = document.activeElement?.id;
      this.view = v;
      this.viewKey = key;
      if (v !== "race") this.releaseAll();
      this.root.style.touchAction = v === "race" ? "none" : "manipulation";
      this.root.innerHTML = v === "race" ? (this.portrait ? this.portraitHTML() : this.raceHTML())
        : v === "lobby" ? this.lobbyHTML() : v === "spectate" ? this.spectateHTML() : v === "finished" ? this.finishedHTML()
        : v === "results" ? this.resultsHTML() : this.joinHTML();
      if (v === "race") this.startKeepalive(); else clearInterval(this.keepalive);
      if (prevFocus) (document.getElementById(prevFocus) as HTMLInputElement | null)?.focus();
    }
    this.patch();
  }

  patch() {
    const $ = (id: string) => document.getElementById(id);
    const set = (id: string, text: string) => { const el = $(id); if (el && el.textContent !== text) el.textContent = text; };
    const s = this.st;
    if (this.view === "race") {
      set("hud-pos", s ? `${ordinal(s[0])}${this.field > 1 ? ` / ${this.field}` : " place"}` : "—");
      set("hud-lap", `Lap ${s ? Math.min(s[1], this.totalLaps) : 1}/${this.totalLaps}`);
      const f = s ? s[2] : 0;
      const [label, bg] = this.conn !== "connected" ? ["Reconnecting…", "rgba(0,0,0,0.75)"]
        : this.phase === "COUNTDOWN" ? ["GET READY — hold GAS!", "rgba(0,0,0,0.75)"]
        : this.phase === "PAUSED" ? ["PAUSED", "rgba(0,0,0,0.75)"]
        : f & ST_WRONG_WAY ? ["WRONG WAY! Turn around", "#E63946"]
        : f & ST_MISSED ? ["↩ Missed a checkpoint — go back!", "#6A1B9A"]
        : f & ST_BOOST ? ["⚡ BOOST!", "#FF8F00"]
        : f & ST_DRAFT ? ["💨 Slipstream", "#1565C0"]
        : f & ST_OFFROAD ? ["Off the road — slow going!", "#795548"] : ["", ""];
      const el = $("hud-label");
      if (el) { el.textContent = label; el.style.display = label ? "block" : "none"; el.style.background = bg; }
    }
    const o = $("orient");
    if (o) {
      const k = !this.touch ? "" : this.portrait ? "turn" : "ok";
      if (o.dataset.k !== k) { o.dataset.k = k; o.innerHTML = this.orientHTML(k); o.style.display = k ? "block" : "none"; }
    }
    if (this.view === "lobby") {
      const [dot, text] = this.conn === "connected" ? ["#4CAF50", "Connected"] : this.conn === "noHost" ? ["#FFB300", "Waiting for the big screen…"] : ["#FFB300", "Reconnecting…"];
      const d = $("conn-dot"); if (d) d.style.background = dot;
      set("conn-text", text);
    } else if (this.view === "finished" || this.view === "results") {
      const mine = this.results.find((r) => r.id === this.myId);
      set("res-pos", mine ? `${ordinal(mine.rank)} place` : s ? `${ordinal(s[0])} place` : "");
      set("res-sub", mine ? (mine.time !== null ? fmtT(mine.time) : "Did not finish") + (this.cup ? ` · +${mine.pts} pts` : "") : "");
      const si = this.standings.findIndex((x) => x.id === this.myId);
      set("res-cup", this.cup && si >= 0 ? `🏆 Cup: ${ordinal(si + 1)} with ${this.standings[si].points} pts (race ${this.cup.race} of ${this.cup.of})` : "");
    }
    this.paintButtons();
  }

  paintButtons() {
    if (this.view !== "race") return;
    const color = this.myId ? PLAYER_COLORS[this.myId] : "#E63946";
    const style = (b: Btn, on: string) => {
      const el = document.querySelector<HTMLElement>(`[data-btn="${b}"]`);
      if (!el) return;
      const active = this.btn[b];
      el.style.background = active ? on : "rgba(255,255,255,0.07)";
      el.style.borderColor = active ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.14)";
      (el.firstElementChild as HTMLElement | null)?.style.setProperty("color", active ? "#fff" : "rgba(255,255,255,0.35)");
    };
    style("left", color); style("right", color); style("throttle", "#2E7D32"); style("brake", "#B71C1C");
  }

  header() {
    const id = this.myId;
    const chip = id ? `<div style="display:inline-flex;align-items:center;gap:7px;background:${PLAYER_COLORS[id]};color:#fff;padding:4px 12px 4px 6px;border-radius:20px;font-size:18px;font-weight:700;flex-shrink:0">
        <span style="width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,0.3);display:inline-flex;align-items:center;justify-content:center;font-size:15px">${slotNumber(id)}</span>${PLAYER_COLOR_NAMES[id]} car</div>` : "";
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;max-width:520px">
      <div style="font-size:34px;font-weight:700;color:#1a2a0a;line-height:1">DRIFT PARTY</div>${chip}</div>`;
  }

  joinHTML() {
    const busy = this.conn === "connecting";
    return `<form style="min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:22px;background:#f0ede4">
      <div style="font-size:52px;font-weight:700;color:#1a2a0a;line-height:1">DRIFT PARTY</div>
      <div style="font-size:18px;color:#7a7460;text-align:center;max-width:320px;line-height:1.3">Your phone is the steering wheel. Enter the code shown on the big screen.</div>
      <div style="background:#fff;border-radius:14px;padding:16px;width:100%;max-width:340px;box-shadow:0 2px 10px rgba(0,0,0,0.08)">
        <div style="display:flex;gap:8px">
          <input id="roomInput" value="${esc(this.code)}" placeholder="ROOM CODE" maxlength="8" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false"
            style="flex:1;min-width:0;padding:10px 12px;border:2px solid #ddd;border-radius:9px;font-size:26px;font-weight:700;font-family:'Caveat',cursive;letter-spacing:4px;text-align:center;color:#333;background:#f8f8f8;outline:none;text-transform:uppercase" />
          <button type="submit" ${busy ? "disabled" : ""} style="padding:10px 20px;background:${busy ? "#bbb" : "#E63946"};color:#fff;border:none;border-radius:9px;font-size:22px;font-weight:700;font-family:'Caveat',cursive;cursor:pointer;flex-shrink:0">${busy ? "…" : "Join"}</button>
        </div>
        <div style="margin-top:10px;font-size:15px;color:${this.error ? "#E63946" : "#999"};line-height:1.35;min-height:20px">${esc(this.error || (busy ? "Connecting…" : "Tip: scanning the QR code on the big screen fills this in."))}</div>
      </div>
    </form>`;
  }

  /** "Turn your phone sideways" prompt for the pre-race screens (patched in place as the phone turns). */
  orientHTML(k: string) {
    if (k === "ok") {
      return `<div style="display:flex;align-items:center;gap:8px;background:#e5f3e6;color:#2E7D32;border-radius:12px;padding:7px 12px;font-size:18px;font-weight:700">
        <span style="font-size:20px">✓</span> Phone is sideways — you're set for the race</div>`;
    }
    if (k !== "turn") return "";
    return `<div style="display:flex;align-items:center;gap:14px;background:#FFF3C4;border:3px solid #FFB300;border-radius:14px;padding:10px 14px;text-align:left">
      <div style="width:44px;height:44px;flex-shrink:0;display:flex;align-items:center;justify-content:center">
        <div style="width:24px;height:40px;border:3px solid #1a2a0a;border-radius:6px;position:relative;animation:tilt 2.4s ease-in-out infinite">
          <div style="position:absolute;bottom:3px;left:50%;width:5px;height:5px;margin-left:-2.5px;border-radius:50%;background:#1a2a0a"></div></div></div>
      <div style="line-height:1.15">
        <div style="font-size:22px;font-weight:700;color:#1a2a0a">Turn your phone sideways</div>
        <div style="font-size:15px;color:#7a6420">Do it before the race starts — the controls only work in landscape. Screen won't turn? Switch off rotation lock.</div>
      </div></div>`;
  }

  lobbyHTML() {
    const id = this.myId!, color = PLAYER_COLORS[id];
    const cars = CAR_TYPES.map((t) => {
      const on = this.carType === t;
      return `<button data-action="car" data-car="${t}" aria-pressed="${on}" style="min-width:0;padding:5px 4px 6px;border:3px solid ${on ? color : "#e2ddcc"};background:${on ? "#fff" : "rgba(255,255,255,0.55)"};border-radius:12px;cursor:pointer;box-shadow:${on ? `0 0 0 2px ${color}33` : "none"}">
        <img src="${carIcon(t, color, 96)}" alt="" style="width:100%;max-width:80px;aspect-ratio:5/3;display:block;margin:0 auto;opacity:${on ? 1 : 0.8}" />
        <div style="font-size:16px;font-weight:700;font-family:'Caveat',cursive;color:${on ? "#1a2a0a" : "#6b6450"};line-height:.95">${CARS[t].label}</div></button>`;
    }).join("");
    const st = carStats(this.carType);
    const bars = STAT_LABELS.map(([k, label]) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:15px;color:#6b6450">${label}
        <span style="display:flex;gap:3px">${[1, 2, 3, 4, 5].map((n) => `<span style="width:13px;height:8px;border-radius:2px;background:${n <= st[k] ? color : "#e2ddcc"}"></span>`).join("")}</span></div>`).join("");
    return `<div style="min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;background:#f0ede4">
      ${this.header()}
      <div style="display:flex;align-items:center;gap:8px;font-size:16px;color:#777;width:100%;max-width:520px">
        <span id="conn-dot" style="width:10px;height:10px;border-radius:50%;background:#4CAF50;display:inline-block"></span>
        <span id="conn-text">Connected</span><span style="color:#bbb">· room ${esc(this.code)}</span>
        <button data-action="leave" style="margin-left:auto;background:none;border:1px solid #ccc;color:#888;border-radius:8px;padding:3px 10px;font-family:'Caveat',cursive;font-size:15px;cursor:pointer">Leave</button>
      </div>
      <label style="width:100%;max-width:520px;display:flex;align-items:center;gap:10px;background:#fff;border-radius:12px;padding:8px 12px;box-shadow:0 1px 5px rgba(0,0,0,0.06)">
        <span style="font-size:17px;color:#888;flex-shrink:0">Name</span>
        <input id="nameInput" value="${esc(this.name)}" placeholder="Player ${slotNumber(id)}" maxlength="${NAME_MAX}" autocomplete="nickname" enterkeyhint="done"
          style="flex:1;min-width:0;border:none;outline:none;font-size:22px;font-weight:700;font-family:'Caveat',cursive;color:#222;background:transparent" />
      </label>
      <div style="width:100%;max-width:520px">
        <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px">${cars}</div>
        <div style="margin-top:8px;background:#fff;border-radius:12px;padding:8px 12px;box-shadow:0 1px 5px rgba(0,0,0,0.06)">
          <div style="font-size:19px;color:#1a2a0a;line-height:1.1"><b>${CARS[this.carType].label}</b> <span style="color:#8a836c">— ${CARS[this.carType].blurb}</span></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;column-gap:16px;row-gap:1px;margin-top:4px">${bars}</div>
        </div>
      </div>
      <div id="orient" style="width:100%;max-width:520px;display:none"></div>
      <button data-action="ready" style="width:100%;max-width:520px;padding:14px;background:${this.ready ? "#2E7D32" : "#E63946"};color:#fff;border:none;border-radius:14px;font-size:28px;font-weight:700;font-family:'Caveat',cursive;cursor:pointer;box-shadow:0 4px 0 ${this.ready ? "#1B5E20" : "#B71C1C"}">
        ${this.ready ? "✓ Ready! Waiting for the host…" : "Ready up"}</button>
      <div style="font-size:14px;color:#9a937c;text-align:center;line-height:1.35">Left thumb steers · right thumb GAS / BRAKE · brake + steer = drift<br>⚡ pads boost · tuck in behind a car to slipstream</div>
    </div>`;
  }

  spectateHTML() {
    const what = this.phase === "FINISHED" ? "The race just finished." : `A race is on${this.track ? ` at ${esc(this.track)}` : ""}.`;
    return `<div style="position:absolute;inset:0;background:#f0ede4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;text-align:center">
      <div style="font-size:60px;line-height:1">👀</div>
      <div style="font-size:34px;font-weight:700;color:#1a2a0a">${what}</div>
      <div style="font-size:19px;color:#888;line-height:1.35">You're in — you'll race from the next one.<br>Watch the big screen!</div>
      <div id="orient" style="width:100%;max-width:440px;display:none;margin-top:6px"></div>
      <button data-action="leave" style="margin-top:6px;background:none;border:1px solid #ccc;color:#888;border-radius:8px;padding:3px 12px;font-family:'Caveat',cursive;font-size:16px;cursor:pointer">Leave</button>
    </div>`;
  }

  portraitHTML() {
    return `<div style="position:absolute;inset:0;background:#1a2a0a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px;text-align:center">
      <div style="font-size:72px;color:rgba(255,255,255,0.35);line-height:1">⟳</div>
      <div style="font-size:30px;font-weight:700;color:#fff">Turn your phone sideways</div>
      <div style="font-size:17px;color:rgba(255,255,255,0.45)">The race controls need landscape.</div>
    </div>`;
  }

  raceHTML() {
    const id = this.myId!;
    const pad = (b: Btn, label: string, sub = "", size = 56) => `<div data-btn="${b}" style="flex:1;border-radius:16px;border:3px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:center;pointer-events:none">
        <div style="text-align:center;color:rgba(255,255,255,0.35)"><div style="font-size:${size}px;font-weight:700;line-height:1">${label}</div>${sub ? `<div style="font-size:14px;opacity:0.7">${sub}</div>` : ""}</div></div>`;
    return `<div style="position:absolute;inset:0;display:flex;flex-direction:column;background:#1a2a0a;touch-action:none">
      <div style="height:48px;background:rgba(0,0,0,0.9);padding:0 14px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;border-bottom:3px solid ${PLAYER_COLORS[id]}">
        <div style="display:flex;align-items:center;gap:9px">
          <div style="width:14px;height:14px;border-radius:50%;background:${PLAYER_COLORS[id]}"></div>
          <div id="hud-pos" style="font-size:26px;font-weight:700;color:#fff">—</div>
        </div>
        <div id="hud-lap" style="font-size:24px;color:rgba(255,255,255,0.7)">Lap 1/${this.totalLaps}</div>
      </div>
      <div id="pad" style="flex:1;position:relative;display:flex;padding:8px;gap:8px;min-height:0">
        <div id="hud-label" style="display:none;position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:4px 16px;border-radius:20px;color:#fff;font-size:22px;font-weight:700;pointer-events:none;z-index:2;white-space:nowrap"></div>
        <div style="width:46%;display:flex;gap:8px;min-width:0">${pad("left", "◀")}${pad("right", "▶")}</div>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px;min-width:0">
          <div style="flex:6;display:flex">${pad("throttle", "GAS", "hold to accelerate", 40)}</div>
          <div style="flex:4;display:flex">${pad("brake", "BRAKE", "+ steer = drift · hold = reverse", 30)}</div>
        </div>
      </div>
    </div>`;
  }

  finishedHTML() {
    return `<div style="position:absolute;inset:0;background:#f0ede4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;text-align:center">
      <div style="font-size:64px;line-height:1">🏁</div>
      <div style="font-size:40px;font-weight:700;color:#1a2a0a">You finished!</div>
      <div id="res-pos" style="font-size:34px;font-weight:700;color:${this.myId ? PLAYER_COLORS[this.myId] : "#E63946"}"></div>
      <div style="font-size:16px;color:#aaa">Watch the others finish on the big screen.</div>
    </div>`;
  }

  resultsHTML() {
    return `<div style="position:absolute;inset:0;background:#f0ede4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:20px;text-align:center">
      <div style="font-size:44px;font-weight:700;color:#1a2a0a">Race over!</div>
      <div id="res-pos" style="font-size:38px;font-weight:700;color:${this.myId ? PLAYER_COLORS[this.myId] : "#E63946"}"></div>
      <div id="res-sub" style="font-size:19px;color:#888"></div>
      <div id="res-cup" style="font-size:21px;color:#2E7D32;font-weight:700"></div>
      <div style="font-size:16px;color:#aaa;line-height:1.4">Full results are on the big screen.<br>Waiting for the host…</div>
      <div id="orient" style="width:100%;max-width:440px;display:none;margin-top:6px"></div>
    </div>`;
  }
}

new DriftController().mount();
