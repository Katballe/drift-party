import type { AnyMessage, Role } from "./protocol";

export interface NetHandlers {
  onOpen?: () => void;
  onClose?: () => void;
  onMessage: (msg: AnyMessage) => void;
}

/**
 * Thin WebSocket client to the Room relay. Auto-reconnects with backoff so a
 * dropped phone (screen lock, tab switch, flaky cellular) rejoins its room.
 * Replaces the PeerJS data channel — same JSON messages, owned transport.
 */
export class Net {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff = 500;

  constructor(
    private role: Role,
    private code: string,
    private handlers: NetHandlers,
  ) {
    this.connect();
  }

  private url(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws?room=${encodeURIComponent(this.code)}&role=${this.role}`;
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.handlers.onOpen?.();
    };
    ws.onmessage = (e) => {
      try {
        this.handlers.onMessage(JSON.parse(e.data) as AnyMessage);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      this.handlers.onClose?.();
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 1.6, 8000);
      }
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* noop */ }
    };
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
    try { this.ws?.close(); } catch { /* noop */ }
  }
}
