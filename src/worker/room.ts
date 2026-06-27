import { DurableObject } from "cloudflare:workers";
import {
  SLOT_ORDER,
  type PlayerId,
  type AnyMessage,
} from "../shared/protocol";

interface Attachment {
  role: "screen" | "controller";
  playerId?: PlayerId;
}

/**
 * One Room = one game screen (host) + up to four phone controllers.
 *
 * The room is addressed by its 6-char code via `idFromName(code)`, so every
 * client that knows the code lands on the same Durable Object instance. The DO
 * is a dumb-but-authoritative relay:
 *   - assigns each controller a player slot (p1..p4),
 *   - tags inbound controller messages with that slot's playerId,
 *   - routes screen→controller messages (unicast if playerId matches a slot,
 *     else broadcast).
 *
 * Uses the WebSocket Hibernation API so idle rooms evict from memory and cost
 * nothing; tags + attachments survive hibernation.
 */
export class Room extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (role !== "screen" && role !== "controller") {
      return new Response("Bad role", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (role === "screen") {
      if (this.screen()) {
        // A screen already owns this code — tell the newcomer to pick another.
        server.accept();
        this.sendRaw(server, { type: "roomTaken" });
        server.close(4001, "room taken");
        return new Response(null, { status: 101, webSocket: client });
      }
      this.ctx.acceptWebSocket(server, ["screen"]);
      this.attach(server, { role: "screen" });
      // Replay current controllers so a late-opened screen still sees them.
      for (const c of this.controllers()) {
        const pid = this.playerIdOf(c);
        if (pid) this.sendRaw(server, { type: "controllerJoined", playerId: pid });
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // role === "controller"
    const slot = this.freeSlot();
    if (!slot) {
      server.accept();
      this.sendRaw(server, { type: "roomFull" });
      server.close(4002, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server, ["controller", slot]);
    this.attach(server, { role: "controller", playerId: slot });
    this.sendRaw(server, { type: "assigned", playerId: slot, roomCode: url.searchParams.get("room") ?? "" });
    const screen = this.screen();
    if (screen) this.sendRaw(screen, { type: "controllerJoined", playerId: slot });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let msg: AnyMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const att = this.attachmentOf(ws);
    if (!att) return;

    if (att.role === "controller") {
      // Force the playerId to this connection's slot (no spoofing), forward to screen.
      (msg as { playerId?: PlayerId }).playerId = att.playerId;
      const screen = this.screen();
      if (screen) this.sendRaw(screen, msg);
      return;
    }

    // From the screen: unicast if it targets a connected slot, else broadcast.
    const target = (msg as { playerId?: PlayerId }).playerId;
    if (target) {
      const c = this.controllerForSlot(target);
      if (c) this.sendRaw(c, msg);
      // a playerId that maps to no controller (e.g. keyboard p1) → drop
      return;
    }
    for (const c of this.controllers()) this.sendRaw(c, msg);
  }

  webSocketClose(ws: WebSocket): void {
    const att = this.attachmentOf(ws);
    if (!att) return;
    if (att.role === "screen") {
      for (const c of this.controllers()) this.sendRaw(c, { type: "screenLeft" });
      return;
    }
    const screen = this.screen();
    if (screen && att.playerId) {
      this.sendRaw(screen, { type: "controllerLeft", playerId: att.playerId });
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private screen(): WebSocket | undefined {
    return this.ctx.getWebSockets("screen")[0];
  }
  private controllers(): WebSocket[] {
    return this.ctx.getWebSockets("controller");
  }
  private controllerForSlot(slot: PlayerId): WebSocket | undefined {
    return this.ctx.getWebSockets(slot).find((w) => this.attachmentOf(w)?.role === "controller");
  }
  private playerIdOf(ws: WebSocket): PlayerId | undefined {
    return this.attachmentOf(ws)?.playerId;
  }
  private freeSlot(): PlayerId | undefined {
    const taken = new Set(this.controllers().map((w) => this.playerIdOf(w)));
    return SLOT_ORDER.find((s) => !taken.has(s));
  }
  private attach(ws: WebSocket, att: Attachment): void {
    ws.serializeAttachment(att);
  }
  private attachmentOf(ws: WebSocket): Attachment | null {
    try {
      return ws.deserializeAttachment() as Attachment | null;
    } catch {
      return null;
    }
  }
  private sendRaw(ws: WebSocket, msg: AnyMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }
}
