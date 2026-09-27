import { TERMINAL_CLOSE_CODES, type AnyMessage, type Role } from "./protocol";

export interface NetHandlers {
  onOpen?: () => void;
  /** `terminal` = the relay refused us for good (room full/taken/missing). */
  onClose?: (code: number, terminal: boolean) => void;
  onMessage: (msg: AnyMessage) => void;
}

const PING_EVERY = 5000;   // relay auto-answers "ping" with "pong" without waking the DO
const DEAD_AFTER = 13000;  // no pong for this long → assume a half-open socket and reconnect

/**
 * WebSocket client to the Room relay. Auto-reconnects with jittered backoff so a
 * dropped phone (screen lock, tab switch, flaky cellular) rejoins its room, and
 * heartbeats so a silently dead connection (common on mobile networks) is
 * detected within seconds instead of minutes. Stops for good on the relay's
 * terminal close codes.
 */
export class Net {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff = 400;
  private lastPong = 0;
  private pingTimer = 0;
  private retryTimer = 0;

  constructor(
    private role: Role,
    private code: string,
    private clientId: string,
    private handlers: NetHandlers,
  ) {
    window.addEventListener("online", this.kick);
    document.addEventListener("visibilitychange", this.onVisible);
    this.connect();
  }

  private kick = () => {
    if (this.closed || this.isOpen) return;
    clearTimeout(this.retryTimer);
    this.backoff = 400;
    this.connect();
  };

  private onVisible = () => {
    if (document.visibilityState !== "visible" || this.closed) return;
    // Returning from a locked screen: the socket is often dead but not yet closed.
    if (this.ws && this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastPong > PING_EVERY + 1500) {
      this.ping();
      setTimeout(() => { if (Date.now() - this.lastPong > PING_EVERY + 1500) this.ws?.close(); }, 1500);
    } else this.kick();
  };

  private url(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const q = new URLSearchParams({ room: this.code, role: this.role, cid: this.clientId });
    return `${proto}//${location.host}/ws?${q}`;
  }

  private connect(): void {
    if (this.closed) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.url()); } catch { this.scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.backoff = 400;
      this.lastPong = Date.now();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.heartbeat(), PING_EVERY);
      this.handlers.onOpen?.();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastPong = Date.now(); // any traffic proves the socket is alive
      if (e.data === "pong") return;
      try { this.handlers.onMessage(JSON.parse(e.data) as AnyMessage); } catch { /* ignore malformed */ }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = null;
      const terminal = TERMINAL_CLOSE_CODES.includes(e.code);
      if (terminal) this.closed = true;
      this.handlers.onClose?.(e.code, terminal);
      if (!this.closed) this.scheduleRetry();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  }

  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    const wait = this.backoff * (0.75 + Math.random() * 0.5);
    this.backoff = Math.min(this.backoff * 1.7, 6000);
    this.retryTimer = window.setTimeout(() => this.connect(), wait);
  }

  private ping() {
    try { this.ws?.send("ping"); } catch { /* noop */ }
  }

  private heartbeat() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastPong > DEAD_AFTER) { try { this.ws.close(); } catch { /* noop */ } return; }
    this.ping();
  }

  send(msg: AnyMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(msg)); } catch { /* noop */ }
    }
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    window.removeEventListener("online", this.kick);
    document.removeEventListener("visibilitychange", this.onVisible);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000); } catch { /* noop */ }
  }
}
