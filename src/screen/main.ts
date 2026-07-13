import QRCode from "qrcode";
import { Net } from "../shared/net";
import { INK, hashStr, inkShape, makePaper, paintGrass, roughPath, rng, sampleEllipse, sampleRoundRect, type Pt } from "./sketch";
import {
  ALL_SLOTS,
  makeRoomCode,
  type AnyMessage,
  type CarType,
  type PlayerId,
} from "../shared/protocol";

// ─── Types ────────────────────────────────────────────────────────────────
type Mode = "ai" | "controller";

interface Player {
  id: PlayerId;
  name: string;
  carType: CarType;
  color: string;
  ready: boolean;
  mode: Mode;
}

interface CarCfg {
  type: CarType; spd: number; acc: number; str: number;
  grip: number; dGrip: number; mass: number; w: number; h: number;
}

interface Input { left: boolean; right: boolean; throttle: boolean; brake: boolean; }
interface TrailDot { x: number; y: number; alpha: number; }

interface Car {
  id: PlayerId; name: string; color: string; cfg: CarCfg;
  isHuman: boolean; isAI: boolean;
  x: number; y: number; angle: number; vx: number; vy: number; speed: number;
  isDrifting: boolean; isFinished: boolean; finishTime: number | null;
  lap: number; nextCP: number; driftScore: number; activeDrift: number;
  input: Input; aiWP: number; trail: TrailDot[]; finishRank?: number;
}

type GameState = "LOBBY" | "COUNTDOWN" | "RACING" | "FINISHED";

interface ResultRow {
  rank: number; id: PlayerId; name: string; color: string;
  carType: CarType; isFinished: boolean; finishTime: number | null; driftScore: number;
}

const DEFAULTS: Record<PlayerId, Player> = {
  p1: { id: "p1", name: "Player 1", carType: "rc",     color: "#E63946", ready: true,  mode: "ai" },
  p2: { id: "p2", name: "Blue Bus", carType: "bus",    color: "#2196F3", ready: true,  mode: "ai" },
  p3: { id: "p3", name: "Green RC", carType: "rc",     color: "#4CAF50", ready: true,  mode: "ai" },
  p4: { id: "p4", name: "Orange",   carType: "normal", color: "#FF9800", ready: true,  mode: "ai" },
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// ─── Screen component ───────────────────────────────────────────────────────
class DriftScreen {
  readonly CW = 1600; readonly CH = 900;
  readonly T = { cx: 800, cy: 450, oRX: 600, oRY: 330, iRX: 400, iRY: 150 };
  readonly F8 = {
    L: { cx: 480,  cy: 450, oRX: 370, oRY: 220, iRX: 155, iRY: 85 },
    R: { cx: 1120, cy: 450, oRX: 370, oRY: 220, iRX: 155, iRY: 85 },
  };
  readonly CFGS: Record<CarType, CarCfg> = {
    bus:    { type: "bus",    spd: 245, acc: 165, str: 1.5, grip: 9, dGrip: 3.2, mass: 3.0, w: 44, h: 24 },
    rc:     { type: "rc",     spd: 315, acc: 385, str: 3.0, grip: 9, dGrip: 2.5, mass: 0.7, w: 22, h: 14 },
    normal: { type: "normal", spd: 285, acc: 255, str: 2.2, grip: 9, dGrip: 3.0, mass: 1.5, w: 32, h: 18 },
  };

  state = {
    gameState: "LOBBY" as GameState,
    countdownVal: 3,
    selectedTrack: "oval" as "oval" | "f8",
    selectedLaps: 3,
    players: ALL_SLOTS.map((id) => ({ ...DEFAULTS[id] })) as Player[],
    results: [] as ResultRow[],
    roomCode: "…",
    // HUD
    hudRankings: [] as { rank: number; id: PlayerId; name: string; color: string; lapStr: string; rowBg: string }[],
    raceTimeStr: "0:00.0", playerRankStr: "1st", playerLapStr: "1/3",
  };

  cars: Car[] = [];
  raceTime = 0; totalLaps = 3;
  ts = 0; raf = 0;
  net: Net | null = null;
  CPs: { x: number; y: number; r: number }[] = [];
  WPs: { x: number; y: number }[] = [];
  offscr: HTMLCanvasElement | null = null;
  paper: HTMLCanvasElement | null = null;
  finCount = 0; lastStT = 0; lastHUDT = 0;
  qrDataUrl = "";

  canvas!: HTMLCanvasElement;
  ctx!: CanvasRenderingContext2D;
  els!: { lobby: HTMLElement; countdown: HTMLElement; hud: HTMLElement; results: HTMLElement };

  // Audio
  sndCtx: AudioContext | null = null;
  musicGain: GainNode | null = null;
  driftGain: GainNode | null = null;
  driftNoise: AudioBufferSourceNode | null = null;
  snareNoiseBuf: AudioBuffer | null = null;
  hatNoiseBuf: AudioBuffer | null = null;
  nextBeatTime = 0;
  musicPlaying = false;
  musicTimeout: number | null = null;

  mount() {
    this.canvas = document.getElementById("raceCanvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.canvas.width = this.CW; this.canvas.height = this.CH;
    this.els = {
      lobby: document.getElementById("lobby")!,
      countdown: document.getElementById("countdown")!,
      hud: document.getElementById("hud")!,
      results: document.getElementById("results")!,
    };
    if (!(CanvasRenderingContext2D.prototype as any).roundRect) {
      (CanvasRenderingContext2D.prototype as any).roundRect = function (this: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
        this.beginPath(); this.moveTo(x + r, y); this.lineTo(x + w - r, y);
        this.arcTo(x + w, y, x + w, y + r, r); this.lineTo(x + w, y + h - r);
        this.arcTo(x + w, y + h, x + w - r, y + h, r); this.lineTo(x + r, y + h);
        this.arcTo(x, y + h, x, y + h - r, r); this.lineTo(x, y + r);
        this.arcTo(x, y, x + r, y, r); this.closePath();
      };
    }
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.paper = makePaper(this.CW, this.CH);
    this.buildCPs(); this.buildWPs(); this.prebake();
    this.initNet();
    document.getElementById("root")!.addEventListener("click", (e) => this.onClick(e));
    this.ts = performance.now();
    this.raf = requestAnimationFrame((t) => this.loop(t));
    const unlock = () => { this.initAudio(); document.removeEventListener("click", unlock); document.removeEventListener("touchstart", unlock); };
    document.addEventListener("click", unlock);
    document.addEventListener("touchstart", unlock);
    this.renderUI();
  }

  setState(patch: Partial<DriftScreen["state"]>) {
    Object.assign(this.state, patch);
    this.renderUI();
  }

  resize() {
    const asp = this.CW / this.CH;
    let w = window.innerWidth, h = w / asp;
    if (h > window.innerHeight) { h = window.innerHeight; w = h * asp; }
    this.canvas.style.width = w + "px"; this.canvas.style.height = h + "px";
  }

  playerById(id: PlayerId) { return this.state.players.find((p) => p.id === id)!; }

  // ─── Track geometry ───────────────────────────────────────────────────────
  buildCPs() {
    if (this.state.selectedTrack === "f8") { this.buildF8CPs(); return; }
    this.CPs = Array.from({ length: 6 }, (_, i) => {
      const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
      return { x: 800 + 500 * Math.cos(a), y: 450 + 240 * Math.sin(a), r: 90 };
    });
  }
  buildWPs() {
    if (this.state.selectedTrack === "f8") { this.buildF8WPs(); return; }
    this.WPs = Array.from({ length: 24 }, (_, i) => {
      const a = -Math.PI / 2 + (i / 24) * Math.PI * 2;
      return { x: 800 + 490 * Math.cos(a), y: 450 + 225 * Math.sin(a) };
    });
  }
  buildF8CPs() {
    const { L, R } = this.F8; const pts: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < 3; i++) { const a = Math.PI + (i / 3) * Math.PI * 2; pts.push({ x: R.cx + R.oRX * 0.72 * Math.cos(a), y: R.cy + R.oRY * 0.72 * Math.sin(a), r: 110 }); }
    for (let i = 0; i < 3; i++) { const a = -(i / 3) * Math.PI * 2; pts.push({ x: L.cx + L.oRX * 0.72 * Math.cos(a), y: L.cy + L.oRY * 0.72 * Math.sin(a), r: 110 }); }
    this.CPs = pts;
  }
  buildF8WPs() {
    const { L, R } = this.F8; const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < 20; i++) { const a = Math.PI + (i / 20) * Math.PI * 2; pts.push({ x: R.cx + R.oRX * 0.74 * Math.cos(a), y: R.cy + R.oRY * 0.74 * Math.sin(a) }); }
    for (let i = 0; i < 20; i++) { const a = -(i / 20) * Math.PI * 2; pts.push({ x: L.cx + L.oRX * 0.74 * Math.cos(a), y: L.cy + L.oRY * 0.74 * Math.sin(a) }); }
    this.WPs = pts;
  }
  prebake() {
    this.offscr = document.createElement("canvas");
    this.offscr.width = this.CW; this.offscr.height = this.CH;
    const ctx = this.offscr.getContext("2d")!;
    if (this.state.selectedTrack === "f8") this.drawTrackF8(ctx); else this.drawTrack(ctx);
  }
  inOval(x: number, y: number, cx: number, cy: number, rx: number, ry: number) {
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  }

  // ─── Networking (Room relay) ──────────────────────────────────────────────
  initNet() {
    const code = makeRoomCode();
    this.state.roomCode = code;
    this.refreshQR(code);
    this.net = new Net("screen", code, {
      onMessage: (m) => this.onMsg(m),
    });
  }

  async refreshQR(code: string) {
    const url = this.controllerUrl(code);
    try {
      this.qrDataUrl = await QRCode.toDataURL(url, { width: 140, margin: 1, errorCorrectionLevel: "L" });
    } catch { this.qrDataUrl = ""; }
    if (this.state.gameState === "LOBBY") this.renderUI();
  }

  controllerUrl(code: string) {
    return `${location.origin}/controller/?room=${encodeURIComponent(code)}`;
  }

  send(msg: AnyMessage) { this.net?.send(msg); }

  onMsg(msg: AnyMessage) {
    switch (msg.type) {
      case "controllerJoined": {
        const p = this.playerById(msg.playerId);
        const slot = ALL_SLOTS.indexOf(msg.playerId) + 1;
        Object.assign(p, { mode: "controller", ready: false, name: `Player ${slot}` });
        this.send({ type: "lobbyState", playerId: msg.playerId, state: this.state.gameState });
        this.renderUI();
        break;
      }
      case "controllerLeft": {
        const p = this.playerById(msg.playerId);
        Object.assign(p, { ...DEFAULTS[msg.playerId] });
        this.renderUI();
        break;
      }
      case "join": {
        const p = this.playerById(msg.playerId!);
        Object.assign(p, { name: (msg.name || p.name).slice(0, 14), carType: msg.carType || p.carType, mode: "controller" });
        this.send({ type: "lobbyState", playerId: msg.playerId, state: this.state.gameState });
        this.renderUI();
        break;
      }
      case "ready": case "unready": {
        const p = this.playerById(msg.playerId!);
        p.ready = msg.type === "ready";
        this.renderUI();
        break;
      }
      case "selectCar": {
        const p = this.playerById(msg.playerId!);
        p.carType = msg.carType;
        this.renderUI();
        break;
      }
      case "input": {
        const car = this.cars.find((c) => c.id === msg.playerId);
        if (car) car.input = { left: !!msg.left, right: !!msg.right, throttle: !!msg.throttle, brake: !!msg.brake };
        break;
      }
      case "roomTaken": {
        // Collision: pick a fresh code and reconnect.
        this.net?.close();
        this.initNet();
        break;
      }
    }
  }

  // ─── Game flow ────────────────────────────────────────────────────────────
  startCountdown() {
    this.buildCPs(); this.buildWPs(); this.prebake();
    this.initCars(); this.finCount = 0; this.raceTime = 0;
    this.setState({ gameState: "COUNTDOWN", countdownVal: 3 });
    this.send({ type: "raceStarting" });
    let c = 3;
    const tick = () => {
      if (c > 0) { this.setState({ countdownVal: c }); this.playCountdownBeep(c); c--; setTimeout(tick, 1000); }
      else { this.setState({ countdownVal: 0 }); this.playCountdownBeep(0); setTimeout(() => this.setState({ gameState: "RACING" }), 900); }
    };
    setTimeout(tick, 300);
  }

  endRace() {
    if (this.state.gameState !== "RACING") return;
    const rnk = this.getRankings();
    const results: ResultRow[] = rnk.map((car, i) => ({
      rank: i + 1, id: car.id, name: car.name, color: car.color,
      carType: car.cfg.type, isFinished: car.isFinished,
      finishTime: car.isFinished ? car.finishTime : null,
      driftScore: Math.round(car.driftScore),
    }));
    this.setState({ gameState: "FINISHED", results });
    this.send({ type: "raceResults", results });
    this.playFinishFanfare();
  }

  returnToLobby() {
    this.cars = []; this.raceTime = 0; this.finCount = 0;
    this.setState({
      gameState: "LOBBY",
      players: this.state.players.map((p) => ({ ...p, ready: p.mode === "ai" })),
      results: [], hudRankings: [], raceTimeStr: "0:00.0",
      playerRankStr: "1st", playerLapStr: "1/3",
    });
    this.send({ type: "returnedToLobby" });
  }

  // ─── Car init ─────────────────────────────────────────────────────────────
  initCars() {
    this.totalLaps = this.state.selectedLaps;
    const isF8 = this.state.selectedTrack === "f8";
    const SPs = isF8
      ? [{ x: 820, y: 430, a: 0 }, { x: 820, y: 458, a: 0 }, { x: 780, y: 430, a: 0 }, { x: 780, y: 458, a: 0 }]
      : [{ x: 818, y: 171, a: 0 }, { x: 818, y: 199, a: 0 }, { x: 778, y: 171, a: 0 }, { x: 778, y: 199, a: 0 }];
    this.cars = this.state.players.slice(0, 4).map((p, i) => {
      const sp = SPs[i];
      const isAI = p.mode === "ai";
      const cfg = { ...(this.CFGS[p.carType] || this.CFGS.normal) };
      if (isAI) { const v = 0.86 + Math.random() * 0.28; cfg.spd *= v; cfg.acc *= v; }
      return {
        id: p.id, name: p.name.substring(0, 9), color: p.color, cfg,
        isHuman: !isAI, isAI,
        x: sp.x, y: sp.y, angle: sp.a, vx: 0, vy: 0, speed: 0,
        isDrifting: false, isFinished: false, finishTime: null,
        lap: 1, nextCP: 1, driftScore: 0, activeDrift: 0,
        input: { left: false, right: false, throttle: false, brake: false },
        aiWP: 2 + i, trail: [],
      } as Car;
    });
  }

  // ─── Loop ─────────────────────────────────────────────────────────────────
  loop(t: number) {
    const dt = Math.min((t - this.ts) / 1000, 0.05); this.ts = t;
    if (this.state.gameState === "RACING") {
      this.raceTime += dt;
      this.cars.forEach((car) => { if (car.isAI && !car.isFinished) this.aiUpd(car); });
      this.cars.forEach((car) => {
        if (!car.isFinished) this.physUpd(car, dt);
        else {
          const fr = Math.pow(0.94, dt * 60);
          car.vx *= fr; car.vy *= fr; car.x += car.vx * dt; car.y += car.vy * dt;
        }
      });
      this.resolveColls();
      this.cars.forEach((car) => this.checkCP(car));
      this.updTrails(dt);
      if (this.finCount > 0) {
        const ff = Math.min(...this.cars.filter((c) => c.isFinished).map((c) => c.finishTime!));
        if (this.raceTime - ff > 25 || this.finCount >= this.cars.length) this.endRace();
      }
      if (t - this.lastStT > 100) { this.bcastStatus(); this.lastStT = t; }
      if (t - this.lastHUDT > 160) { this.updHUD(); this.lastHUDT = t; }
    }
    this.updateSound();
    this.doRender();
    this.raf = requestAnimationFrame((tt) => this.loop(tt));
  }

  bcastStatus() {
    if (!this.cars.length) return;
    const rnk = this.getRankings();
    this.cars.filter((c) => c.isHuman).forEach((car) => {
      const rank = rnk.findIndex((r) => r.id === car.id) + 1;
      this.send({
        type: "playerStatus", playerId: car.id, rank,
        lap: car.lap, totalLaps: this.totalLaps,
        nextCP: car.nextCP, totalCPs: this.CPs.length,
        driftCombo: Math.floor(car.activeDrift), driftScore: car.driftScore,
        isDrifting: car.isDrifting, finished: car.isFinished,
      });
    });
  }

  updHUD() {
    const rnk = this.getRankings();
    const p1 = this.cars.find((c) => c.id === "p1");
    const p1r = rnk.findIndex((c) => c.id === "p1") + 1;
    const sfx = ["st", "nd", "rd", "th"];
    const p1rs = (p1r || 1) + (sfx[Math.min(p1r, 4) - 1] || "th");
    const p1l = p1 ? Math.min(p1.lap, this.totalLaps) : 1;
    this.setState({
      hudRankings: rnk.map((c, i) => ({
        rank: i + 1, id: c.id, name: c.name, color: c.color,
        lapStr: "L" + Math.min(c.lap, this.totalLaps),
        rowBg: c.id === "p1" ? "rgba(230,57,70,0.15)" : "rgba(255,255,255,0.05)",
      })),
      raceTimeStr: this.fmtT(this.raceTime),
      playerRankStr: p1rs,
      playerLapStr: p1l + "/" + this.totalLaps,
    });
  }

  // ─── Physics ──────────────────────────────────────────────────────────────
  physUpd(car: Car, dt: number) {
    const { input: i, cfg } = car;
    const spd = Math.hypot(car.vx, car.vy);
    const sf = Math.min(spd / 120, 1.2);
    if (i.left)  car.angle -= cfg.str * (0.3 + 0.7 * sf) * dt;
    if (i.right) car.angle += cfg.str * (0.3 + 0.7 * sf) * dt;
    if (i.throttle) { car.vx += Math.cos(car.angle) * cfg.acc * dt; car.vy += Math.sin(car.angle) * cfg.acc * dt; }
    const wasDrift = car.isDrifting;
    car.isDrifting = i.brake && (i.left || i.right) && spd > 60;
    const gr = car.isDrifting ? cfg.dGrip : cfg.grip;
    car.vx += (Math.cos(car.angle) * spd - car.vx) * gr * dt;
    car.vy += (Math.sin(car.angle) * spd - car.vy) * gr * dt;
    if (i.brake && !car.isDrifting) { const b = Math.pow(0.87, dt * 60); car.vx *= b; car.vy *= b; }
    const fr = Math.pow(0.984, dt * 60); car.vx *= fr; car.vy *= fr;
    const ns = Math.hypot(car.vx, car.vy);
    if (ns > cfg.spd) { car.vx *= cfg.spd / ns; car.vy *= cfg.spd / ns; }
    car.speed = Math.hypot(car.vx, car.vy);
    car.x += car.vx * dt; car.y += car.vy * dt;
    if (car.isDrifting && car.speed > 40) {
      const da = Math.abs(this.normA(car.angle - Math.atan2(car.vy, car.vx)));
      car.activeDrift += da * car.speed * 0.0009 * dt;
      car.trail.push({ x: car.x, y: car.y, alpha: 0.62 });
    } else if (wasDrift && !car.isDrifting && car.activeDrift > 1) {
      car.driftScore += Math.round(car.activeDrift); car.activeDrift = 0;
    }
  }

  clamp(car: Car) {
    if (this.state.selectedTrack === "f8") { this.clampF8(car); return; }
    const { cx, cy, oRX, oRY, iRX, iRY } = this.T;
    const dx = car.x - cx, dy = car.y - cy;
    if ((dx / oRX) ** 2 + (dy / oRY) ** 2 > 1) {
      const a = Math.atan2(dy, dx);
      car.x = car.x * 0.35 + (cx + oRX * Math.cos(a) * 0.97) * 0.65;
      car.y = car.y * 0.35 + (cy + oRY * Math.sin(a) * 0.97) * 0.65;
      car.vx *= 0.38; car.vy *= 0.38;
      if (car.isDrifting) { car.activeDrift = 0; car.isDrifting = false; }
    }
    if ((dx / iRX) ** 2 + (dy / iRY) ** 2 < 1) {
      const a = Math.atan2(dy, dx);
      car.x = car.x * 0.35 + (cx + iRX * Math.cos(a) * 1.03) * 0.65;
      car.y = car.y * 0.35 + (cy + iRY * Math.sin(a) * 1.03) * 0.65;
      car.vx *= 0.38; car.vy *= 0.38;
      if (car.isDrifting) { car.activeDrift = 0; car.isDrifting = false; }
    }
  }

  clampF8(car: Car) {
    const { L, R } = this.F8;
    const inLO = this.inOval(car.x, car.y, L.cx, L.cy, L.oRX, L.oRY);
    const inRO = this.inOval(car.x, car.y, R.cx, R.cy, R.oRX, R.oRY);
    const inLI = this.inOval(car.x, car.y, L.cx, L.cy, L.iRX, L.iRY);
    const inRI = this.inOval(car.x, car.y, R.cx, R.cy, R.iRX, R.iRY);
    const bounce = () => { car.vx *= 0.38; car.vy *= 0.38; if (car.isDrifting) { car.activeDrift = 0; car.isDrifting = false; } };
    if (!inLO && !inRO) {
      const dL = Math.hypot(car.x - L.cx, car.y - L.cy);
      const dR = Math.hypot(car.x - R.cx, car.y - R.cy);
      const near = dL < dR ? L : R;
      const a = Math.atan2(car.y - near.cy, car.x - near.cx);
      car.x = car.x * 0.3 + (near.cx + near.oRX * Math.cos(a) * 0.95) * 0.7;
      car.y = car.y * 0.3 + (near.cy + near.oRY * Math.sin(a) * 0.95) * 0.7;
      bounce();
    }
    if (inLI && !inRI) {
      const a = Math.atan2(car.y - L.cy, car.x - L.cx);
      car.x = car.x * 0.3 + (L.cx + L.iRX * Math.cos(a) * 1.06) * 0.7;
      car.y = car.y * 0.3 + (L.cy + L.iRY * Math.sin(a) * 1.06) * 0.7;
      bounce();
    }
    if (inRI && !inLI) {
      const a = Math.atan2(car.y - R.cy, car.x - R.cx);
      car.x = car.x * 0.3 + (R.cx + R.iRX * Math.cos(a) * 1.06) * 0.7;
      car.y = car.y * 0.3 + (R.cy + R.iRY * Math.sin(a) * 1.06) * 0.7;
      bounce();
    }
  }

  aiUpd(car: Car) {
    const wp = this.WPs[car.aiWP % this.WPs.length];
    const dx = wp.x - car.x, dy = wp.y - car.y;
    if (Math.hypot(dx, dy) < 55) car.aiWP = (car.aiWP + 1) % this.WPs.length;
    const diff = this.normA(Math.atan2(wp.y - car.y, wp.x - car.x) - car.angle);
    car.input.throttle = true;
    car.input.left = diff < -0.07;
    car.input.right = diff > 0.07;
    car.input.brake = Math.abs(diff) > 0.5 && car.speed > 90;
  }

  resolveColls() {
    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i], b = this.cars[j];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
        const mn = (a.cfg.w + b.cfg.w) * 0.45;
        if (d < mn && d > 0.01) {
          const ov = mn - d, nx = dx / d, ny = dy / d, tm = a.cfg.mass + b.cfg.mass;
          a.x -= nx * ov * (b.cfg.mass / tm); a.y -= ny * ov * (b.cfg.mass / tm);
          b.x += nx * ov * (a.cfg.mass / tm); b.y += ny * ov * (a.cfg.mass / tm);
          const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rvn < 0) {
            const imp = 1.5 * rvn / tm;
            a.vx += imp * b.cfg.mass * nx; a.vy += imp * b.cfg.mass * ny;
            b.vx -= imp * a.cfg.mass * nx; b.vy -= imp * a.cfg.mass * ny;
          }
        }
      }
    }
  }

  checkCP(car: Car) {
    if (car.isFinished) return;
    const cp = this.CPs[car.nextCP]; if (!cp) return;
    const dx = car.x - cp.x, dy = car.y - cp.y;
    if (dx * dx + dy * dy < cp.r * cp.r) {
      const was0 = car.nextCP === 0;
      car.nextCP = (car.nextCP + 1) % this.CPs.length;
      if (was0) {
        if (car.lap >= this.totalLaps) {
          car.isFinished = true; car.finishTime = this.raceTime;
          if (car.activeDrift > 0) { car.driftScore += Math.round(car.activeDrift); car.activeDrift = 0; }
          car.finishRank = ++this.finCount;
          if (car.isHuman) this.send({ type: "playerFinished", playerId: car.id });
        } else { car.lap++; }
      }
    }
  }

  getRankings(): Car[] {
    const N = this.CPs.length;
    return [...this.cars].sort((a, b) => {
      if (a.isFinished && b.isFinished) return a.finishTime! - b.finishTime!;
      if (a.isFinished) return -1; if (b.isFinished) return 1;
      const aP = (a.lap - 1) * N + a.nextCP, bP = (b.lap - 1) * N + b.nextCP;
      if (aP !== bP) return bP - aP;
      const aC = this.CPs[a.nextCP], bC = this.CPs[b.nextCP];
      return Math.hypot(a.x - aC.x, a.y - aC.y) - Math.hypot(b.x - bC.x, b.y - bC.y);
    });
  }

  updTrails(dt: number) {
    this.cars.forEach((car) => {
      car.trail = car.trail.filter((t) => t.alpha > 0.02).map((t) => ({ ...t, alpha: t.alpha * Math.pow(0.96, dt * 60) }));
      if (car.trail.length > 240) car.trail.splice(0, car.trail.length - 240);
    });
  }

  // ─── Rendering (canvas) ───────────────────────────────────────────────────
  doRender() {
    const ctx = this.ctx;
    if (this.offscr) ctx.drawImage(this.offscr, 0, 0);
    else { ctx.fillStyle = "#1a2a0a"; ctx.fillRect(0, 0, this.CW, this.CH); }
    if (this.state.gameState !== "LOBBY" && this.cars.length) {
      this.cars.forEach((car) => {
        car.trail.forEach((t) => {
          ctx.beginPath(); ctx.arc(t.x, t.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = car.color + Math.round(t.alpha * 160).toString(16).padStart(2, "0");
          ctx.fill();
        });
      });
      [...this.cars].sort((a, b) => a.y - b.y).forEach((c) => this.drawCar(ctx, c));
      this.cars.forEach((car) => {
        if (car.isDrifting && car.activeDrift > 3) {
          const sc = "+" + Math.floor(car.activeDrift);
          const sz = Math.min(18 + car.activeDrift * 0.5, 30);
          ctx.font = `700 ${sz}px 'Caveat',cursive`; ctx.textAlign = "center";
          ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = 3;
          ctx.strokeText(sc, car.x, car.y - car.cfg.h / 2 - 22);
          ctx.fillStyle = "#FFD600"; ctx.fillText(sc, car.x, car.y - car.cfg.h / 2 - 22);
        }
      });
    }
    if (this.paper) ctx.drawImage(this.paper, 0, 0);
  }

  drawTrackF8(ctx: CanvasRenderingContext2D) {
    const { L, R } = this.F8;
    ctx.fillStyle = "#3d6b28"; ctx.fillRect(0, 0, this.CW, this.CH);
    for (let i = 0; i < 18; i++) {
      const x = 100 + (i * 193) % 1400, y = 80 + (i * 137) % 740;
      ctx.fillStyle = "rgba(100,80,40,0.18)";
      ctx.beginPath(); ctx.ellipse(x, y, 40 + (i * 17) % 40, 20 + (i * 11) % 20, (i * 0.4), 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#5a5040";
    ctx.beginPath(); ctx.ellipse(L.cx, L.cy, L.oRX, L.oRY, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(R.cx, R.cy, R.oRX, R.oRY, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#3d6b28";
    ctx.beginPath(); ctx.ellipse(L.cx, L.cy, L.iRX, L.iRY, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(R.cx, R.cy, R.iRX, R.iRY, 0, 0, Math.PI * 2); ctx.fill();
    const junks: [number, number, number][] = [[L.cx - 30, L.cy - 20, 22], [L.cx + 40, L.cy + 15, 18], [L.cx - 15, L.cy + 30, 14], [R.cx + 25, R.cy - 25, 20], [R.cx - 35, R.cy + 20, 16], [R.cx + 10, R.cy + 28, 12]];
    junks.forEach(([jx, jy, jr]) => {
      ctx.fillStyle = "#8B6914"; ctx.beginPath(); ctx.arc(jx, jy, jr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#5a4010"; ctx.beginPath(); ctx.arc(jx - 4, jy - 3, jr * 0.5, 0, Math.PI * 2); ctx.fill();
    });
    ctx.save(); ctx.setLineDash([14, 10]);
    ctx.beginPath(); ctx.ellipse(L.cx, L.cy, (L.oRX + L.iRX) / 2, (L.oRY + L.iRY) / 2, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,200,0,0.25)"; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(R.cx, R.cy, (R.oRX + R.iRX) / 2, (R.oRY + R.iRY) / 2, 0, 0, Math.PI * 2);
    ctx.stroke(); ctx.restore();
    ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.ellipse(L.cx, L.cy, L.oRX, L.oRY, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(R.cx, R.cy, R.oRX, R.oRY, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(L.cx, L.cy, L.iRX, L.iRY, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(R.cx, R.cy, R.iRX, R.iRY, 0, 0, Math.PI * 2); ctx.stroke();
    const strip = (cx: number, cy: number, rx: number, ry: number, n: number, r: number) => {
      for (let i = 0; i < n; i++) if (i % 2 === 0) { const a = (i + 0.5) / n * Math.PI * 2; ctx.beginPath(); ctx.arc(cx + rx * Math.cos(a), cy + ry * Math.sin(a), r, 0, Math.PI * 2); ctx.fillStyle = "#E65100"; ctx.fill(); }
    };
    strip(L.cx, L.cy, L.oRX - 10, L.oRY - 10, 28, 7); strip(R.cx, R.cy, R.oRX - 10, R.oRY - 10, 28, 7);
    strip(L.cx, L.cy, L.iRX + 8, L.iRY + 8, 20, 5); strip(R.cx, R.cy, R.iRX + 8, R.iRY + 8, 20, 5);
    const sfX = 800, sfY1 = 430, bz = 10;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? "#fff" : "#111";
      ctx.fillRect(sfX - bz + c * bz, sfY1 + r * bz, bz, bz);
    }
    ctx.font = "bold 18px Caveat,cursive"; ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.fillText("JUNKYARD 8", this.CW / 2, 48);
  }

  drawTrack(ctx: CanvasRenderingContext2D) {
    const { cx, cy, oRX, oRY, iRX, iRY } = this.T;
    paintGrass(ctx, this.CW, this.CH, "#5e9a39", "#3f6f26", "#7cb84a");
    const outer = sampleEllipse(cx, cy, oRX, oRY, 84);
    const inner = sampleEllipse(cx, cy, iRX, iRY, 64);
    // sand surface, then re-cut the infield back to grass
    inkShape(ctx, outer, 5, 7001, "#d7c393", INK, 0);
    inkShape(ctx, inner, 4, 7002, "#5e9a39", INK, 0);
    // sand speckle within the band
    const r = rng(53); ctx.fillStyle = "rgba(120,96,54,0.18)";
    for (let i = 0; i < 260; i++) {
      const a = r() * Math.PI * 2, t = 0.1 + r() * 0.8;
      const x = cx + (iRX + (oRX - iRX) * t) * Math.cos(a), y = cy + (iRY + (oRY - iRY) * t) * Math.sin(a);
      ctx.beginPath(); ctx.arc(x, y, 1 + r() * 2, 0, Math.PI * 2); ctx.fill();
    }
    // racing line — wobbly dashed mid ellipse
    ctx.save(); ctx.setLineDash([18, 16]);
    roughPath(ctx, sampleEllipse(cx, cy, (oRX + iRX) / 2, (oRY + iRY) / 2, 72), 3, rng(7100));
    ctx.strokeStyle = "rgba(255,248,214,0.5)"; ctx.lineWidth = 3; ctx.stroke(); ctx.restore();
    // rumble strips — hand-inked blocks along outer & inner edges
    this.rumble(ctx, cx, cy, oRX - 12, oRY - 12, 34);
    this.rumble(ctx, cx, cy, iRX + 12, iRY + 12, 26);
    // ink the track edges
    inkShape(ctx, outer, 5, 7001, null, INK, 7);
    inkShape(ctx, inner, 4, 7002, null, INK, 6);
    // start/finish — inked checker across the top straight
    this.checker(ctx, cx, cy - oRY + 6, cy - iRY - 6, 18);
    ctx.font = "700 30px 'Caveat',cursive"; ctx.textAlign = "center";
    ctx.fillStyle = "rgba(30,40,15,0.30)"; ctx.fillText("Oval Circuit", cx, cy + 12);
  }

  rumble(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, n: number) {
    for (let i = 0; i < n; i += 2) {
      const a = (i + 0.5) / n * Math.PI * 2;
      const x = cx + rx * Math.cos(a), y = cy + ry * Math.sin(a);
      inkShape(ctx, sampleRoundRect(x - 7, y - 6, 14, 12, 3, 5), 1.2, 800 + i, "#cf3b34", INK, 1.5);
    }
  }

  checker(ctx: CanvasRenderingContext2D, x: number, y1: number, y2: number, bz: number) {
    const nr = Math.max(1, Math.floor((y2 - y1) / bz));
    const r = rng(42);
    for (let row = 0; row < nr; row++) for (let col = 0; col < 2; col++) {
      const jx = (r() * 2 - 1) * 1.5, jy = (r() * 2 - 1) * 1.5;
      ctx.fillStyle = (row + col) % 2 === 0 ? "#f4efe2" : INK;
      ctx.fillRect(x - bz + col * bz + jx, y1 + row * bz + jy, bz, bz);
    }
    inkShape(ctx, sampleRoundRect(x - bz - 1, y1 - 1, bz * 2 + 2, nr * bz + 2, 1, 6), 0.8, 77, null, INK, 1.5);
  }

  drawCar(ctx: CanvasRenderingContext2D, car: Car) {
    const { w, h } = car.cfg; const type = car.cfg.type;
    const seed = hashStr(car.id);
    const r = type === "rc" ? 5 : 6;
    ctx.save(); ctx.translate(car.x, car.y); ctx.rotate(car.angle);
    // soft drop shadow
    ctx.save(); ctx.translate(3, 4); ctx.globalAlpha = 0.2;
    inkShape(ctx, sampleRoundRect(-w / 2, -h / 2, w, h, Math.min(6, h * 0.4)), 1, seed + 8, "#000", INK, 0);
    ctx.globalAlpha = 1; ctx.restore();
    // wheels
    const wheels: Pt[] = [[w * 0.28, h * 0.46], [w * 0.28, -h * 0.46], [-w * 0.32, h * 0.46], [-w * 0.32, -h * 0.46]];
    for (const [wx, wy] of wheels) inkShape(ctx, sampleRoundRect(wx - w * 0.1, wy - h * 0.16, w * 0.2, h * 0.32, 2), 0.7, seed + 3, INK, INK, 0);
    // body
    inkShape(ctx, sampleRoundRect(-w / 2, -h / 2, w, h, r), 1.3, seed + 1, car.color, INK, Math.max(2.2, w * 0.1));
    // cel shadow on the lower half
    ctx.save(); ctx.globalAlpha = 0.16; ctx.fillStyle = "#000";
    roughPath(ctx, sampleRoundRect(-w / 2 + 1, h * 0.02, w - 2, h * 0.46, r * 0.6), 0.8, rng(seed + 4)); ctx.fill();
    ctx.restore();
    // top highlight
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = Math.max(1.5, w * 0.05); ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-w * 0.34, -h * 0.32); ctx.lineTo(w * 0.28, -h * 0.32); ctx.stroke();
    // windows
    const win = "rgba(196,228,242,0.92)";
    if (type === "bus") {
      for (const wx of [w * 0.2, -w * 0.02, -w * 0.24]) inkShape(ctx, sampleRoundRect(wx - w * 0.07, -h * 0.3, w * 0.14, h * 0.6, 2), 0.5, seed + 5, win, INK, 1.2);
    } else {
      inkShape(ctx, sampleRoundRect(w * 0.03, -h * 0.32, w * 0.27, h * 0.64, 2), 0.6, seed + 5, win, INK, 1.2);
    }
    // headlights (front = +x)
    ctx.fillStyle = "#ffe9a8";
    for (const wy of [h * 0.28, -h * 0.28]) { ctx.beginPath(); ctx.arc(w * 0.46, wy, Math.max(1.4, w * 0.05), 0, Math.PI * 2); ctx.fill(); }
    // RC antenna
    if (type === "rc") {
      ctx.strokeStyle = INK; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-w * 0.5, 0); ctx.lineTo(-w * 0.78, -h * 0.6); ctx.stroke();
      ctx.fillStyle = "#FFD600"; ctx.beginPath(); ctx.arc(-w * 0.78, -h * 0.6, 2, 0, Math.PI * 2); ctx.fill();
    }
    // drift smoke
    if (car.isDrifting && car.speed > 50) {
      ctx.globalAlpha = 0.22 + Math.random() * 0.1; ctx.fillStyle = "#e8e8e8";
      for (const wy of [h * 0.42, -h * 0.42]) { ctx.beginPath(); ctx.arc(-w * 0.4 + (Math.random() - 0.5) * 8, wy, 3 + Math.random() * 4, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    // name
    ctx.font = "700 15px 'Caveat',cursive"; ctx.textAlign = "center";
    ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.lineWidth = 3;
    ctx.strokeText(car.name, car.x, car.y - h / 2 - 9);
    ctx.fillStyle = "#fff"; ctx.fillText(car.name, car.x, car.y - h / 2 - 9);
  }

  // ─── Audio ────────────────────────────────────────────────────────────────
  initAudio() {
    if (this.sndCtx) return;
    try {
      this.sndCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const ctx = this.sndCtx;

      // Music bus: oscillators → musicGain → compressor → output
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.ratio.value = 4;
      comp.attack.value = 0.003; comp.release.value = 0.1;
      comp.connect(ctx.destination);
      this.musicGain = ctx.createGain(); this.musicGain.gain.value = 0;
      this.musicGain.connect(comp);

      // Pre-bake small noise buffers reused by every snare / hi-hat hit
      const makeBuf = (dur: number) => {
        const sz = Math.floor(ctx.sampleRate * dur);
        const b = ctx.createBuffer(1, sz, ctx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < sz; i++) d[i] = Math.random() * 2 - 1;
        return b;
      };
      this.snareNoiseBuf = makeBuf(0.15);
      this.hatNoiseBuf   = makeBuf(0.05);

      // Drift squeal: bandpassed noise gated by drift state (separate from music bus)
      const driftBuf = makeBuf(2.0);
      this.driftNoise = ctx.createBufferSource();
      this.driftNoise.buffer = driftBuf; this.driftNoise.loop = true;
      const bpf = ctx.createBiquadFilter(); bpf.type = "bandpass"; bpf.frequency.value = 1600; bpf.Q.value = 3;
      this.driftGain = ctx.createGain(); this.driftGain.gain.value = 0;
      this.driftNoise.connect(bpf); bpf.connect(this.driftGain); this.driftGain.connect(ctx.destination);
      this.driftNoise.start();
    } catch (e) { console.warn("Audio init failed", e); }
  }

  // Lookahead chiptune scheduler — schedules 16-step (2-bar) chunks ~0.5 s ahead.
  // Melody: square wave, C major. Bass: triangle. Kick: sine sweep. Snare+hat: noise.
  scheduleMusicChunk() {
    const ctx = this.sndCtx!; const mg = this.musicGain!;
    // semitones from C4 (261.63 Hz); -1 = rest
    const MELODY  = [7,4,7,9,12,9,7,4,  2,5,9,5,4,2,4,7];
    const BASS_ST = [0,-1,-1,-1, 7,-1,-1,-1, 5,-1,-1,-1, 7,-1,-1,-1];
    const KICK_ST = [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0];
    const SNARE_ST= [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0];
    const HAT_ST  = [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0];
    const S = 60 / 130 / 2; // 8th-note duration at 130 BPM

    for (let i = 0; i < 16; i++) {
      const t = this.nextBeatTime + i * S;

      // Melody — square wave, short envelope
      { const osc = ctx.createOscillator(); const g = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = 261.63 * Math.pow(2, MELODY[i] / 12);
        g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + S * 0.72);
        osc.connect(g); g.connect(mg); osc.start(t); osc.stop(t + S); }

      // Bass — triangle, long sustain, fires every 4 steps
      if (BASS_ST[i] >= 0) {
        const osc = ctx.createOscillator(); const g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = 130.81 * Math.pow(2, BASS_ST[i] / 12);
        g.gain.setValueAtTime(0.13, t); g.gain.exponentialRampToValueAtTime(0.001, t + S * 3.6);
        osc.connect(g); g.connect(mg); osc.start(t); osc.stop(t + S * 4);
      }

      // Kick — sine freq sweep 110 → 35 Hz
      if (KICK_ST[i]) {
        const osc = ctx.createOscillator(); const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(110, t); osc.frequency.exponentialRampToValueAtTime(35, t + 0.15);
        g.gain.setValueAtTime(0.45, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        osc.connect(g); g.connect(mg); osc.start(t); osc.stop(t + 0.26);
      }

      // Snare — high-passed pre-baked noise burst
      if (SNARE_ST[i] && this.snareNoiseBuf) {
        const src = ctx.createBufferSource(); src.buffer = this.snareNoiseBuf;
        const hpf = ctx.createBiquadFilter(); hpf.type = "highpass"; hpf.frequency.value = 1200;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        src.connect(hpf); hpf.connect(g); g.connect(mg); src.start(t); src.stop(t + 0.12);
      }

      // Hi-hat — ultra-high-passed noise, very quiet
      if (HAT_ST[i] && this.hatNoiseBuf) {
        const src = ctx.createBufferSource(); src.buffer = this.hatNoiseBuf;
        const hpf = ctx.createBiquadFilter(); hpf.type = "highpass"; hpf.frequency.value = 7000;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.032, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
        src.connect(hpf); hpf.connect(g); g.connect(mg); src.start(t); src.stop(t + 0.05);
      }
    }
    this.nextBeatTime += 16 * S;
  }

  schedulerTick() {
    if (!this.sndCtx || !this.musicPlaying) return;
    while (this.nextBeatTime < this.sndCtx.currentTime + 0.5) this.scheduleMusicChunk();
    this.musicTimeout = window.setTimeout(() => this.schedulerTick(), 100);
  }

  startMusic() {
    if (this.musicPlaying || !this.sndCtx || !this.musicGain) return;
    this.musicPlaying = true;
    this.musicGain.gain.setTargetAtTime(0.8, this.sndCtx.currentTime, 0.3);
    this.nextBeatTime = this.sndCtx.currentTime + 0.1;
    this.schedulerTick();
  }

  stopMusic() {
    this.musicPlaying = false;
    if (this.musicTimeout !== null) { clearTimeout(this.musicTimeout); this.musicTimeout = null; }
    if (this.sndCtx && this.musicGain) this.musicGain.gain.setTargetAtTime(0, this.sndCtx.currentTime, 0.25);
  }

  updateSound() {
    if (!this.sndCtx) return;
    if (this.state.gameState === "RACING") {
      if (!this.musicPlaying) this.startMusic();
      const anyDrift = this.cars.some((c) => c.isDrifting && c.speed > 50);
      if (this.driftGain) this.driftGain.gain.setTargetAtTime(anyDrift ? 0.14 : 0, this.sndCtx.currentTime, 0.07);
    } else {
      if (this.musicPlaying) this.stopMusic();
      if (this.driftGain) this.driftGain.gain.setTargetAtTime(0, this.sndCtx.currentTime, 0.1);
    }
  }

  // Beeps go direct to destination so stopMusic() doesn't mute them
  beep(freq: number, dur: number, vol?: number, delay?: number) {
    if (!this.sndCtx) return;
    const t = this.sndCtx.currentTime + (delay || 0);
    const osc = this.sndCtx.createOscillator(); const gain = this.sndCtx.createGain();
    osc.frequency.value = freq; osc.type = "sine";
    gain.gain.setValueAtTime(vol || 0.3, t); gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain); gain.connect(this.sndCtx.destination); osc.start(t); osc.stop(t + dur + 0.05);
  }
  playCountdownBeep(n: number) {
    if (!this.sndCtx) return;
    if (n > 0) this.beep(440, 0.12, 0.35);
    else { this.beep(660, 0.08, 0.4); this.beep(880, 0.08, 0.4, 0.09); this.beep(1100, 0.22, 0.4, 0.18); }
  }
  playFinishFanfare() {
    if (!this.sndCtx) return;
    [523, 659, 784, 1047].forEach((f, i) => this.beep(f, 0.18, 0.3, i * 0.12));
  }

  // ─── Utils ────────────────────────────────────────────────────────────────
  normA(a: number) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
  fmtT(s: number) { const m = Math.floor(s / 60), ss = Math.floor(s % 60), ms = Math.floor((s % 1) * 10); return m + ":" + ss.toString().padStart(2, "0") + "." + ms; }
  carLbl(t: CarType) { return t === "bus" ? "Heavy Bus" : t === "rc" ? "RC Car" : "Normal Car"; }

  // ─── DOM rendering (overlay) ──────────────────────────────────────────────
  onClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!el) return;
    const a = el.dataset.action!;
    if (a === "setLaps") this.setState({ selectedLaps: Number(el.dataset.laps) });
    else if (a === "setTrack") this.setState({ selectedTrack: el.dataset.track as "oval" | "f8" });
    else if (a === "start") { if (this.canStart()) this.startCountdown(); }
    else if (a === "openController") window.open(this.controllerUrl(this.state.roomCode), "_blank");
    else if (a === "lobby") this.returnToLobby();
    else if (a === "again") this.startCountdown();
  }

  canStart() { return this.state.players.every((p) => p.ready || p.mode === "ai"); }

  renderUI() {
    const gs = this.state.gameState;
    this.els.lobby.style.display = gs === "LOBBY" ? "block" : "none";
    this.els.countdown.style.display = gs === "COUNTDOWN" ? "block" : "none";
    this.els.hud.style.display = gs === "RACING" ? "block" : "none";
    this.els.results.style.display = gs === "FINISHED" ? "block" : "none";
    if (gs === "LOBBY") this.els.lobby.innerHTML = this.lobbyHTML();
    else if (gs === "COUNTDOWN") this.els.countdown.innerHTML = this.countdownHTML();
    else if (gs === "RACING") this.els.hud.innerHTML = this.hudHTML();
    else if (gs === "FINISHED") this.els.results.innerHTML = this.resultsHTML();
  }

  lobbyHTML() {
    const s = this.state;
    const rdyCnt = s.players.filter((p) => p.ready).length;
    const readyStatus = `${rdyCnt}/${s.players.length} ready`;
    const lapBtns = [3, 4, 5].map((n) => {
      const on = n === s.selectedLaps;
      return `<button data-action="setLaps" data-laps="${n}" style="flex:1;padding:8px 0;border:2px solid ${on ? "#E63946" : "#ddd"};background:${on ? "#E63946" : "#fff"};color:${on ? "#fff" : "#333"};border-radius:7px;font-size:19px;font-weight:700;font-family:Caveat,cursive;cursor:pointer">${n}</button>`;
    }).join("");
    const tracks = [{ id: "oval", label: "🏁 Oval Circuit" }, { id: "f8", label: "🔧 Junkyard 8" }];
    const trackBtns = tracks.map((tr) => {
      const on = s.selectedTrack === tr.id;
      return `<button data-action="setTrack" data-track="${tr.id}" style="flex:1;padding:7px 6px;border:2px solid ${on ? "#1a2a0a" : "#ddd"};background:${on ? "#1a2a0a" : "#fff"};color:${on ? "#FFD600" : "#555"};border-radius:7px;font-size:13px;font-weight:700;font-family:Caveat,cursive;cursor:pointer;line-height:1.3;text-align:center">${tr.label}</button>`;
    }).join("");
    const players = s.players.map((p, i) => {
      const cars = (["bus", "rc", "normal"] as CarType[]).map((t) => {
        const on = p.carType === t;
        const lbl = t === "bus" ? "Bus" : t === "rc" ? "RC" : "Normal";
        return `<button style="padding:3px 9px;border:2px solid ${on ? p.color : "#ddd"};background:${on ? p.color : "#fff"};color:${on ? "#fff" : "#888"};border-radius:12px;font-size:12px;font-weight:600;font-family:Caveat,cursive;cursor:default;pointer-events:none">${lbl}</button>`;
      }).join("");
      const rdyLabel = p.ready ? "✓ Ready" : (p.mode === "ai" ? "AI Bot" : "Not Ready");
      const rdyBg = p.ready ? "#4CAF50" : (p.mode === "ai" ? "#7B1FA2" : "#eee");
      const rdyTc = (p.ready || p.mode === "ai") ? "#fff" : "#999";
      const badge = p.mode === "controller" ? "📱" : "🤖";
      return `<div style="background:#fff;border-radius:12px;padding:12px 15px;box-shadow:0 2px 7px rgba(0,0,0,0.05);border-left:5px solid ${p.color};display:flex;align-items:center;gap:12px">
        <div style="width:40px;height:40px;border-radius:50%;background:${p.color};display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff;flex-shrink:0">${i + 1}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:18px;font-weight:700;color:#222">${badge} ${esc(p.name)}</div>
          <div style="display:flex;gap:5px;margin-top:3px;flex-wrap:wrap">${cars}</div>
        </div>
        <div style="padding:4px 12px;border-radius:18px;background:${rdyBg};color:${rdyTc};font-size:13px;font-weight:600;flex-shrink:0">${rdyLabel}</div>
      </div>`;
    }).join("");
    const qr = this.qrDataUrl
      ? `<img src="${this.qrDataUrl}" alt="QR" style="width:140px;height:140px;image-rendering:pixelated" />`
      : `<div style="color:#999;font-size:13px">…</div>`;

    return `<div style="position:absolute;inset:0;background:#f0ede4;display:flex;flex-direction:column;z-index:10">
      <div style="background:#1a2a0a;padding:14px 28px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
        <div>
          <div style="font-size:44px;font-weight:700;color:#FFD600;line-height:1">DRIFT PARTY</div>
          <div style="font-size:16px;color:#8BC34A;margin-top:2px">Online multiplayer arcade racing</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <div style="font-size:13px;color:rgba(255,255,255,0.38);text-align:right;line-height:1.5">Phones scan the QR to join</div>
          <button data-action="openController" style="padding:9px 16px;background:#E63946;color:#fff;border:none;border-radius:9px;font-size:15px;font-weight:700;font-family:Caveat,cursive;cursor:pointer;white-space:nowrap">Open Controller ↗</button>
        </div>
      </div>
      <div style="flex:1;display:flex;gap:20px;padding:20px 28px;overflow:hidden;min-height:0">
        <div style="width:240px;display:flex;flex-direction:column;gap:14px;flex-shrink:0">
          <div style="background:#fff;border-radius:14px;padding:14px;box-shadow:0 2px 8px rgba(0,0,0,0.06);text-align:center">
            <div style="font-size:14px;font-weight:700;color:#333;margin-bottom:8px">Phone Controller</div>
            <div style="width:140px;height:140px;margin:0 auto;border:1px solid #eee;border-radius:3px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#fff">${qr}</div>
            <div style="margin-top:8px">
              <div style="font-size:11px;color:#aaa;letter-spacing:1px">ROOM CODE</div>
              <div style="font-size:32px;font-weight:700;color:#222;letter-spacing:5px;line-height:1.1">${esc(s.roomCode)}</div>
            </div>
            <div style="margin-top:3px;font-size:11px;color:#bbb;line-height:1.45">Scan on phone or enter room code</div>
          </div>
          <div style="background:#fff;border-radius:14px;padding:14px;box-shadow:0 2px 8px rgba(0,0,0,0.06)">
            <div style="font-size:16px;font-weight:700;color:#333;margin-bottom:11px">Settings</div>
            <div style="font-size:13px;color:#888;margin-bottom:6px">Laps</div>
            <div style="display:flex;gap:7px;margin-bottom:11px">${lapBtns}</div>
            <div style="font-size:13px;color:#888;margin-bottom:6px">Track</div>
            <div style="display:flex;gap:7px">${trackBtns}</div>
          </div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;gap:10px;overflow-y:auto;min-width:0">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
            <div style="font-size:19px;font-weight:700;color:#333">Players (${s.players.length}/4)</div>
            <div style="font-size:14px;color:#999">${readyStatus}</div>
          </div>
          ${players}
        </div>
      </div>
      <div style="background:#1a2a0a;padding:12px 28px;display:flex;align-items:center;justify-content:flex-end;gap:16px;flex-shrink:0">
        <div style="font-size:15px;color:rgba(255,255,255,0.4)">${readyStatus}</div>
        <button data-action="start" style="padding:12px 40px;background:#FFD600;color:#1a2a0a;border:none;border-radius:11px;font-size:24px;font-weight:700;font-family:Caveat,cursive;cursor:pointer;box-shadow:0 4px 0 #b8920a;transform:translateY(-2px)">START RACE ▶</button>
      </div>
    </div>`;
  }

  countdownHTML() {
    const v = this.state.countdownVal;
    const cdDisplay = v === 0 ? "GO!" : String(v);
    const cdColor = v === 0 ? "#4CAF50" : "#FFD600";
    const cdSub = v === 0 ? "Engines on!" : "Get ready...";
    return `<div style="position:absolute;inset:0;background:rgba(0,0,0,0.52);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:20;pointer-events:none">
      <div style="font-size:210px;font-weight:700;color:${cdColor};text-shadow:0 0 80px ${cdColor};line-height:1;animation:popIn 0.55s ease;font-family:'Caveat',cursive">${cdDisplay}</div>
      <div style="font-size:24px;color:rgba(255,255,255,0.5);margin-top:8px;font-family:'Caveat',cursive">${cdSub}</div>
    </div>`;
  }

  hudHTML() {
    const s = this.state;
    const rows = s.hudRankings.map((hr) => `<div style="display:flex;align-items:center;gap:7px;padding:4px 7px;border-radius:7px;background:${hr.rowBg};margin-bottom:4px">
      <div style="font-size:16px;font-weight:700;color:rgba(255,255,255,0.38);width:19px;text-align:center;flex-shrink:0;font-family:'Caveat',cursive">${hr.rank}</div>
      <div style="width:9px;height:9px;border-radius:50%;background:${hr.color};flex-shrink:0"></div>
      <div style="flex:1;font-size:15px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:'Caveat',cursive">${esc(hr.name)}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.38);font-family:sans-serif">${hr.lapStr}</div>
    </div>`).join("");
    return `<div style="position:absolute;top:12px;right:12px;background:rgba(0,0,0,0.78);border-radius:13px;padding:12px;min-width:196px;z-index:10">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:7px;border-bottom:1px solid rgba(255,255,255,0.1)">
        <div style="font-size:11px;color:rgba(255,255,255,0.35);letter-spacing:1px;font-family:sans-serif">RANKINGS</div>
        <div style="font-size:18px;color:#FFD600;font-weight:700;font-family:'Caveat',cursive">${s.raceTimeStr}</div>
      </div>${rows}</div>
      <div style="position:absolute;top:12px;left:12px;background:rgba(0,0,0,0.78);border-radius:13px;padding:8px 14px;z-index:10">
        <div style="font-size:11px;color:rgba(255,255,255,0.35);letter-spacing:1px;font-family:sans-serif">POSITION</div>
        <div style="font-size:40px;font-weight:700;color:#FFD600;line-height:1;font-family:'Caveat',cursive">${s.playerRankStr}</div>
      </div>
      <div style="position:absolute;top:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.78);border-radius:13px;padding:8px 16px;z-index:10;text-align:center">
        <div style="font-size:11px;color:rgba(255,255,255,0.35);letter-spacing:1px;font-family:sans-serif">LAP</div>
        <div style="font-size:32px;font-weight:700;color:#fff;line-height:1;font-family:'Caveat',cursive">${s.playerLapStr}</div>
      </div>
      `;
  }

  resultsHTML() {
    const trackName = this.state.selectedTrack === "f8" ? "Junkyard 8" : "Oval Circuit";
    const rows = this.state.results.map((r, i) => {
      const timeStr = r.isFinished ? this.fmtT(r.finishTime!) : "DNF";
      return `<div style="display:flex;align-items:center;gap:15px;margin-bottom:11px;padding:12px 15px;background:#fff;border-radius:12px;border-left:6px solid ${r.color};box-shadow:0 2px 5px rgba(0,0,0,0.04)">
        <div style="font-size:30px;font-weight:700;color:#ccc;width:38px;text-align:center;flex-shrink:0;font-family:'Caveat',cursive">${i + 1}</div>
        <div style="width:28px;height:28px;border-radius:50%;background:${r.color};flex-shrink:0"></div>
        <div style="flex:1">
          <div style="font-size:20px;font-weight:700;color:#222;font-family:'Caveat',cursive">${esc(r.name)}</div>
          <div style="font-size:13px;color:#aaa">${this.carLbl(r.carType)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:20px;font-weight:700;color:#333;font-family:'Caveat',cursive">${timeStr}</div>
          <div style="font-size:12px;color:#aaa">Drift: ${r.driftScore}</div>
        </div>
      </div>`;
    }).join("");
    return `<div style="position:absolute;inset:0;background:rgba(0,0,0,0.84);display:flex;align-items:center;justify-content:center;z-index:20">
      <div style="background:#f0ede4;border-radius:20px;padding:38px 50px;min-width:540px;max-width:720px;box-shadow:0 10px 50px rgba(0,0,0,0.55)">
        <div style="font-size:48px;font-weight:700;color:#1a2a0a;text-align:center;margin-bottom:4px;font-family:'Caveat',cursive">RACE OVER!</div>
        <div style="font-size:16px;color:#aaa;text-align:center;margin-bottom:28px">Final Results · ${trackName}</div>
        ${rows}
        <div style="display:flex;gap:11px;margin-top:24px;justify-content:center">
          <button data-action="lobby" style="padding:12px 32px;background:#666;color:#fff;border:none;border-radius:12px;font-size:20px;font-weight:700;font-family:Caveat,cursive;cursor:pointer;box-shadow:0 4px 0 #444">Lobby</button>
          <button data-action="again" style="padding:12px 32px;background:#FFD600;color:#1a2a0a;border:none;border-radius:12px;font-size:20px;font-weight:700;font-family:Caveat,cursive;cursor:pointer;box-shadow:0 4px 0 #b8920a">Race Again ▶</button>
        </div>
      </div>
    </div>`;
  }
}

new DriftScreen().mount();
