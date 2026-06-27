import { Net } from "../shared/net";
import type { AnyMessage, CarType, PlayerId } from "../shared/protocol";

type GameState = "LOBBY" | "RACING" | "FINISHED";
type ConnStatus = "idle" | "connecting" | "connected" | "error";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/**
 * Phone gamepad. Connects to the Room relay by code (typed or from the QR deep
 * link), is assigned a player slot, and streams gas/brake/steer inputs to the
 * screen. Replaces the PeerJS guest with the owned WebSocket transport.
 */
class DriftController {
  state = {
    gameState: "LOBBY" as GameState,
    selectedCar: "rc" as CarType,
    isReady: false,
    position: 1, lap: 1, totalLaps: 3,
    driftCombo: 0, driftScore: 0,
    showPortrait: false,
    connStatus: "idle" as ConnStatus,
  };

  // Live button state (independent of re-render).
  bL = false; bR = false; bT = false; bB = false;
  roomInput = "";
  myPlayerId: PlayerId | null = null;
  net: Net | null = null;
  inputInt = 0;
  root!: HTMLElement;

  mount() {
    this.root = document.getElementById("root")!;
    this.inputInt = window.setInterval(() => this.sendInput(), 33);

    document.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
    this.checkOri();
    window.addEventListener("resize", () => this.checkOri());

    // Press / release handlers (document-level so re-renders don't drop them).
    const down = (e: Event) => {
      const el = (e.target as HTMLElement)?.closest?.('[id^="btn-"]') as HTMLElement | null;
      if (!el) return;
      if ((e as any).cancelable) e.preventDefault();
      this.setBtn(el.id.replace("btn-", ""), true);
    };
    const up = (e: Event) => {
      const el = (e.target as HTMLElement)?.closest?.('[id^="btn-"]') as HTMLElement | null;
      if (!el) return;
      this.setBtn(el.id.replace("btn-", ""), false);
    };
    const allUp = () => { this.bL = this.bR = this.bT = this.bB = false; this.refreshBtns(); };
    document.addEventListener("touchstart", down, { passive: false });
    document.addEventListener("touchend", up);
    document.addEventListener("touchcancel", allUp);
    document.addEventListener("mousedown", down);
    document.addEventListener("mouseup", allUp);

    // Delegated taps for lobby buttons (car picker, ready, join).
    this.root.addEventListener("click", (e) => this.onClick(e));

    // Auto-connect from ?room= or #CODE deep link.
    const params = new URLSearchParams(location.search);
    const room = (params.get("room") || location.hash.replace(/^#/, "")).trim().toUpperCase();
    if (room.length >= 4) { this.roomInput = room; this.connect(room); }

    this.render();
  }

  setState(patch: Partial<DriftController["state"]>) {
    Object.assign(this.state, patch);
    this.render();
  }

  setBtn(n: string, v: boolean) {
    if (n === "left") this.bL = v;
    else if (n === "right") this.bR = v;
    else if (n === "throttle") this.bT = v;
    else if (n === "brake") this.bB = v;
    this.refreshBtns();
  }

  checkOri() {
    this.setState({ showPortrait: window.innerWidth < window.innerHeight && window.innerWidth < 600 });
  }

  // ─── Networking ───────────────────────────────────────────────────────────
  connect(code: string) {
    if (!code || code.length < 4) return;
    this.setState({ connStatus: "connecting" });
    this.net?.close();
    this.net = new Net("controller", code, {
      onMessage: (m) => this.onMsg(m),
      onClose: () => { if (this.state.connStatus === "connected") this.setState({ connStatus: "connecting" }); },
    });
  }

  send(msg: AnyMessage) { this.net?.send(msg); }

  sendInput() {
    if (this.state.gameState !== "RACING") return;
    this.send({ type: "input", throttle: this.bT, brake: this.bB, left: this.bL, right: this.bR });
  }

  onMsg(msg: AnyMessage) {
    switch (msg.type) {
      case "assigned":
        this.myPlayerId = msg.playerId;
        this.setState({ connStatus: "connected" });
        this.send({ type: "join", name: `Player ${["p1", "p2", "p3", "p4"].indexOf(msg.playerId) + 1}`, carType: this.state.selectedCar });
        break;
      case "lobbyState":
        if (this.state.connStatus !== "connected") this.setState({ connStatus: "connected" });
        if (this.state.gameState !== "RACING") this.setState({ gameState: "LOBBY" });
        break;
      case "raceStarting":
        this.setState({ gameState: "RACING", driftCombo: 0 });
        break;
      case "playerStatus":
        if (msg.playerId === this.myPlayerId) {
          this.setState({ position: msg.rank, lap: msg.lap, totalLaps: msg.totalLaps, driftCombo: msg.driftCombo, driftScore: msg.driftScore });
        }
        break;
      case "playerFinished":
        if (msg.playerId === this.myPlayerId) this.setState({ gameState: "FINISHED" });
        break;
      case "raceResults":
        if (this.state.gameState === "RACING") this.setState({ gameState: "FINISHED" });
        break;
      case "returnedToLobby":
        this.setState({ gameState: "LOBBY", isReady: false, driftCombo: 0, driftScore: 0 });
        break;
      case "roomFull":
        this.setState({ connStatus: "error" });
        break;
      case "screenLeft":
        this.setState({ connStatus: "connecting" });
        break;
    }
  }

  // ─── Lobby actions ────────────────────────────────────────────────────────
  onClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!el) return;
    const a = el.dataset.action!;
    if (a === "selectCar") this.selCar(el.dataset.car as CarType);
    else if (a === "toggleReady") this.toggleReady();
    else if (a === "join") {
      const input = this.root.querySelector("#roomInput") as HTMLInputElement | null;
      const code = (input?.value || this.roomInput || "").trim().toUpperCase();
      if (code.length >= 4) { this.roomInput = code; this.connect(code); }
    }
  }

  selCar(t: CarType) { this.setState({ selectedCar: t }); this.send({ type: "selectCar", carType: t }); }

  toggleReady() {
    const nr = !this.state.isReady;
    this.setState({ isReady: nr });
    this.send({ type: nr ? "ready" : "unready" });
  }

  // ─── Rendering ────────────────────────────────────────────────────────────
  refreshBtns() {
    // Update only the four control buttons' styles (no full re-render → no input lag).
    if (this.state.gameState !== "RACING" || this.state.showPortrait) return;
    this.styleBtn("btn-left", this.bL, "#1565C0", "#42A5F5");
    this.styleBtn("btn-right", this.bR, "#1565C0", "#42A5F5");
    this.styleBtn("btn-throttle", this.bT, "#2E7D32", "#4CAF50");
    this.styleBtn("btn-brake", this.bB, "#B71C1C", "#EF5350");
  }
  styleBtn(id: string, on: boolean, bg: string, bd: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.background = on ? bg : "rgba(255,255,255,0.08)";
    el.style.borderColor = on ? bd : "rgba(255,255,255,0.14)";
    const inner = el.firstElementChild as HTMLElement | null;
    if (inner) inner.style.color = on ? "#fff" : "rgba(255,255,255,0.28)";
  }

  render() {
    const s = this.state;
    let html: string;
    if (s.showPortrait) html = this.portraitHTML();
    else if (s.gameState === "RACING") html = this.raceHTML();
    else if (s.gameState === "FINISHED") html = this.finishedHTML();
    else html = this.lobbyHTML();
    // Preserve room-code input value/focus across status re-renders.
    const prev = this.root.querySelector("#roomInput") as HTMLInputElement | null;
    const hadFocus = prev && document.activeElement === prev;
    const caret = prev?.selectionStart ?? null;
    this.root.innerHTML = html;
    if (s.gameState === "RACING" && !s.showPortrait) this.refreshBtns();
    const next = this.root.querySelector("#roomInput") as HTMLInputElement | null;
    if (next) {
      next.value = this.roomInput;
      next.addEventListener("input", () => { this.roomInput = next.value.toUpperCase(); next.value = this.roomInput; });
      if (hadFocus) { next.focus(); if (caret != null) next.setSelectionRange(caret, caret); }
    }
  }

  posStr() { const p = this.state.position || 1; const sfx = ["st", "nd", "rd", "th"]; return p + (sfx[Math.min(p, 4) - 1] || "th") + " Place"; }

  portraitHTML() {
    return `<div style="position:absolute;inset:0;background:#1a2a0a;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:100;gap:14px">
      <div style="font-size:64px;color:rgba(255,255,255,0.22);line-height:1">↺</div>
      <div style="font-size:26px;font-weight:700;color:#fff">Rotate to landscape</div>
      <div style="font-size:16px;color:rgba(255,255,255,0.38)">Hold phone sideways for controls</div>
    </div>`;
  }

  lobbyHTML() {
    const s = this.state;
    const connLabels: Record<ConnStatus, string> = {
      idle: "Not connected", connecting: "Connecting…", connected: "Connected ✓", error: "Connection failed — check room code / room full",
    };
    const connDots: Record<ConnStatus, string> = { idle: "#888", connecting: "#FFD600", connected: "#4CAF50", error: "#E63946" };
    const cars = (["bus", "rc", "normal"] as CarType[]).map((t) => {
      const on = s.selectedCar === t;
      const label = t === "bus" ? "Heavy Bus" : t === "rc" ? "RC Car" : "Normal";
      const stats = t === "bus" ? "Slow · Heavy" : t === "rc" ? "Fast · Light" : "Balanced";
      return `<button data-action="selectCar" data-car="${t}" style="padding:10px 16px;border:3px solid ${on ? "#E63946" : "#ddd"};background:${on ? "#E63946" : "#fff"};color:${on ? "#fff" : "#333"};border-radius:12px;font-size:17px;font-weight:700;font-family:'Caveat',cursive;cursor:pointer;min-width:96px;text-align:center">
        <div style="font-size:12px;color:${on ? "rgba(255,255,255,0.65)" : "#bbb"};margin-bottom:2px">${stats}</div>
        <div>${label}</div></button>`;
    }).join("");
    const rdyLabel = s.isReady ? "✓ Ready!" : "Ready Up";
    const rdyBg = s.isReady ? "#2E7D32" : "#E63946";
    const rdyShadow = s.isReady ? "#1B5E20" : "#B71C1C";
    return `<div style="position:absolute;inset:0;background:#f0ede4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px;overflow-y:auto">
      <div style="font-size:44px;font-weight:700;color:#1a2a0a;line-height:1">DRIFT PARTY</div>
      <div style="background:#fff;border-radius:14px;padding:14px 16px;width:100%;max-width:320px;box-shadow:0 2px 8px rgba(0,0,0,0.07)">
        <div style="font-size:15px;font-weight:700;color:#333;margin-bottom:10px">Connect to Game Screen</div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input id="roomInput" placeholder="ROOM CODE" maxlength="6" autocapitalize="characters" autocomplete="off" style="flex:1;padding:10px 12px;border:2px solid #ddd;border-radius:9px;font-size:22px;font-weight:700;font-family:'Caveat',cursive;letter-spacing:4px;text-align:center;color:#333;background:#f8f8f8;outline:none;text-transform:uppercase;width:0" />
          <button data-action="join" style="padding:10px 18px;background:#E63946;color:#fff;border:none;border-radius:9px;font-size:18px;font-weight:700;font-family:'Caveat',cursive;cursor:pointer;flex-shrink:0">Join</button>
        </div>
        <div style="display:flex;align-items:center;gap:7px">
          <div style="width:9px;height:9px;border-radius:50%;background:${connDots[s.connStatus]};flex-shrink:0"></div>
          <div style="font-size:14px;color:#888">${connLabels[s.connStatus]}</div>
        </div>
        <div style="margin-top:8px;font-size:11px;color:#bbb;line-height:1.5">Type the room code shown on the game screen, or scan its QR code.</div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">${cars}</div>
      <button data-action="toggleReady" style="padding:14px 44px;background:${rdyBg};color:#fff;border:none;border-radius:13px;font-size:24px;font-weight:700;font-family:'Caveat',cursive;cursor:pointer;box-shadow:0 4px 0 ${rdyShadow};min-width:200px;text-align:center">${rdyLabel}</button>
    </div>`;
  }

  raceHTML() {
    const s = this.state;
    const lapStr = Math.min(s.lap, s.totalLaps) + "/" + s.totalLaps;
    const driftStr = s.driftCombo > 0 ? "+" + s.driftCombo : "—";
    const off = "rgba(255,255,255,0.08)", offBd = "rgba(255,255,255,0.14)", offTc = "rgba(255,255,255,0.28)";
    return `<div style="position:absolute;inset:0;display:flex;flex-direction:column">
      <div style="height:50px;background:rgba(0,0,0,0.95);padding:0 14px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.07)">
        <div style="display:flex;align-items:center;gap:9px">
          <div style="width:13px;height:13px;border-radius:50%;background:#E63946;flex-shrink:0"></div>
          <div style="font-size:26px;font-weight:700;color:#fff;font-family:'Caveat',cursive">${this.posStr()}</div>
        </div>
        <div style="font-size:20px;color:rgba(255,255,255,0.5);font-family:'Caveat',cursive">Lap ${lapStr}</div>
        <div style="display:flex;align-items:center;gap:5px">
          <div style="font-size:10px;color:rgba(255,255,255,0.3);letter-spacing:.5px;font-family:sans-serif">DRIFT</div>
          <div style="font-size:22px;font-weight:700;color:#FFD600;font-family:'Caveat',cursive">${driftStr}</div>
        </div>
      </div>
      <div style="flex:1;display:flex;padding:7px;gap:7px;min-height:0">
        <div style="width:46%;display:flex;gap:6px;min-width:0">
          <div id="btn-left" style="flex:1;background:${off};border-radius:14px;border:3px solid ${offBd};display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:none">
            <div style="font-size:58px;color:${offTc};font-weight:700;pointer-events:none;line-height:1">◀</div>
          </div>
          <div id="btn-right" style="flex:1;background:${off};border-radius:14px;border:3px solid ${offBd};display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:none">
            <div style="font-size:58px;color:${offTc};font-weight:700;pointer-events:none;line-height:1">▶</div>
          </div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0">
          <div id="btn-throttle" style="flex:6;background:${off};border-radius:14px;border:3px solid ${offBd};display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:none">
            <div style="text-align:center;pointer-events:none;color:${offTc}">
              <div style="font-size:36px;font-weight:700;font-family:'Caveat',cursive">GAS</div>
              <div style="font-size:14px;opacity:0.6;font-family:'Caveat',cursive">hold to accelerate</div>
            </div>
          </div>
          <div id="btn-brake" style="flex:4;background:${off};border-radius:14px;border:3px solid ${offBd};display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:none">
            <div style="text-align:center;pointer-events:none;color:${offTc}">
              <div style="font-size:30px;font-weight:700;font-family:'Caveat',cursive">BRAKE</div>
              <div style="font-size:13px;opacity:0.6;font-family:'Caveat',cursive">+ steer = drift</div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  finishedHTML() {
    const s = this.state;
    return `<div style="position:absolute;inset:0;background:#f0ede4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px">
      <div style="font-size:42px;font-weight:700;color:#1a2a0a">Race Over!</div>
      <div style="font-size:30px;font-weight:700;color:#E63946">${this.posStr()}</div>
      <div style="font-size:18px;color:#888">Drift score: ${s.driftScore || 0}</div>
      <div style="font-size:15px;color:#aaa;text-align:center;line-height:1.5">Check the big screen for results.<br>Waiting for next race…</div>
    </div>`;
  }
}

new DriftController().mount();
