import { DurableObject } from "cloudflare:workers";
import {
  CLOSE_NO_ROOM,
  CLOSE_REPLACED,
  CLOSE_ROOM_FULL,
  CLOSE_ROOM_TAKEN,
  CONTROLLER_TYPES,
  SCREEN_TYPES,
  SLOT_ORDER,
  type AnyMessage,
  type PlayerId,
  type Role,
} from "../shared/protocol";
import type { Env } from "./worker";

interface Attachment {
  role: Role;
  playerId?: PlayerId;
  cid: string;       // controller: client id · screen: host token
  at: number;        // connect time (ms)
  gone?: boolean;    // replaced / pruned — its close event must be ignored
}

interface Hold { cid: string; until: number; }
interface Host { token: string; leftAt?: number; }

const HOLD_MS = 60_000;          // a dropped phone keeps its slot this long
const STALE_MS = 25_000;         // no heartbeat for this long → socket is dead
const IDLE_CLEANUP_MS = 2 * 3600_000;
const MAX_CONTROLLER_MSG = 512;
const MAX_SCREEN_MSG = 8192;
const CONTROLLER_RATE = 60;      // msgs/second per phone before we start dropping

/**
 * One Room = one game screen (host) + up to eight phone controllers. (Bots are
 * simulated on the screen; the relay never sees them.)
 *
 * The room is addressed by its code via `idFromName(code)`, so every client that
 * knows the code lands on the same Durable Object instance. The DO is a small
 * but authoritative relay:
 *   - assigns each controller a player slot, sticky per client id so a phone
 *     that reconnects (screen lock, network switch) gets its own car back;
 *     a dropped phone's slot is held for HOLD_MS before anyone else can take it,
 *   - lets the host's own screen reclaim the room after a page refresh (host
 *     token), while refusing a different screen that tries to take the code,
 *   - tags inbound controller messages with that slot's playerId (no spoofing)
 *     and only relays whitelisted message types in each direction,
 *   - routes screen→controller messages (unicast if playerId set, else broadcast).
 *
 * Uses the WebSocket Hibernation API so idle rooms cost nothing; clients ping
 * every 5 s and the runtime answers "pong" without waking the object. Room
 * storage is wiped a couple of hours after the last client leaves.
 */
export class Room extends DurableObject<Env> {
  private rate = new Map<WebSocket, { t: number; n: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const role = url.searchParams.get("role");
    if (role !== "screen" && role !== "controller") return new Response("Bad role", { status: 400 });
    const cid = url.searchParams.get("cid") ?? "";
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(cid)) return new Response("Bad client id", { status: 400 });
    const code = url.searchParams.get("room") ?? "";

    await this.ctx.storage.deleteAlarm();
    await this.pruneStale();
    return role === "screen" ? this.acceptScreen(cid) : this.acceptController(cid, code);
  }

  // ── screen ────────────────────────────────────────────────────────────────
  private async acceptScreen(token: string): Promise<Response> {
    const live = this.screen();
    if (live) {
      // Same host (page refresh / reconnect before the old socket noticed) → take over.
      if (this.att(live)?.cid !== token) return this.reject(CLOSE_ROOM_TAKEN, "room taken");
      this.retire(live, CLOSE_REPLACED, "replaced");
    } else {
      const host = await this.ctx.storage.get<Host>("host");
      const abandoned = !host || (host.leftAt !== undefined && Date.now() - host.leftAt > HOLD_MS);
      if (host && host.token !== token && !abandoned) return this.reject(CLOSE_ROOM_TAKEN, "room taken");
    }
    await this.ctx.storage.put<Host>("host", { token });

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["screen"]);
    pair[1].serializeAttachment({ role: "screen", cid: token, at: Date.now() } satisfies Attachment);
    // Replay current controllers so a (re)opened screen sees who is here, and
    // tell the phones a host is back so they resend their profiles.
    for (const c of this.controllers()) {
      const pid = this.att(c)?.playerId;
      if (pid) this.send(pair[1], { type: "controllerJoined", playerId: pid });
      this.send(c, { type: "screenJoined" });
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ── controller ────────────────────────────────────────────────────────────
  private async acceptController(cid: string, code: string): Promise<Response> {
    const now = Date.now();
    const controllers = this.controllers();
    const screen = this.screen();

    // Same phone connecting again (new socket while the old one lingers) → replace it.
    const dupe = controllers.find((w) => this.att(w)?.cid === cid);
    let slot: PlayerId | undefined = dupe ? this.att(dupe)?.playerId : undefined;
    if (dupe) this.retire(dupe, CLOSE_REPLACED, "replaced");

    const known = await this.ctx.storage.get<PlayerId>(`cid:${cid}`);
    // A brand-new phone needs a live screen; a returning one may wait for the host.
    if (!slot && !screen && !known) return this.reject(CLOSE_NO_ROOM, "no such room");

    const holds = (await this.ctx.storage.get<Partial<Record<PlayerId, Hold>>>("holds")) ?? {};
    const taken = new Set(controllers.filter((w) => w !== dupe).map((w) => this.att(w)?.playerId));
    const heldByOther = (s: PlayerId) => { const h = holds[s]; return !!h && h.cid !== cid && h.until > now; };
    if (!slot && known && !taken.has(known) && !heldByOther(known)) slot = known;
    if (!slot) slot = SLOT_ORDER.find((s) => !taken.has(s) && !heldByOther(s));
    if (!slot) return this.reject(CLOSE_ROOM_FULL, "room full");

    if (holds[slot]) { delete holds[slot]; await this.ctx.storage.put("holds", holds); }
    if (known !== slot) await this.ctx.storage.put(`cid:${cid}`, slot);

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["controller", slot]);
    pair[1].serializeAttachment({ role: "controller", playerId: slot, cid, at: now } satisfies Attachment);
    this.send(pair[1], { type: "assigned", playerId: slot, roomCode: code, screen: !!screen });
    // A replaced socket keeps its slot, so the screen never saw it leave.
    if (screen && !dupe) this.send(screen, { type: "controllerJoined", playerId: slot });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ── messages ──────────────────────────────────────────────────────────────
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    const att = this.att(ws);
    if (!att || att.gone) return;
    if (message.length > (att.role === "screen" ? MAX_SCREEN_MSG : MAX_CONTROLLER_MSG)) return;
    let msg: AnyMessage & { playerId?: PlayerId };
    try { msg = JSON.parse(message); } catch { return; }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    if (att.role === "controller") {
      if (!CONTROLLER_TYPES.has(msg.type) || this.overRate(ws)) return;
      msg.playerId = att.playerId; // force the sender's own slot
      const screen = this.screen();
      if (screen) this.sendRaw(screen, JSON.stringify(msg));
      return;
    }

    if (!SCREEN_TYPES.has(msg.type)) return;
    if (msg.playerId) {
      const c = this.controllers().find((w) => this.att(w)?.playerId === msg.playerId);
      if (c) this.sendRaw(c, message);
      return; // a playerId with no phone attached → drop
    }
    for (const c of this.controllers()) this.sendRaw(c, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(1000); } catch { /* already closed */ }
    this.rate.delete(ws);
    const att = this.att(ws);
    if (!att || att.gone) return;
    await this.onLeave(att);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) await this.ctx.storage.deleteAll();
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private async onLeave(att: Attachment) {
    const now = Date.now();
    if (att.role === "screen") {
      await this.ctx.storage.put<Host>("host", { token: att.cid, leftAt: now });
      for (const c of this.controllers()) this.send(c, { type: "screenLeft" });
    } else if (att.playerId) {
      const holds = (await this.ctx.storage.get<Partial<Record<PlayerId, Hold>>>("holds")) ?? {};
      holds[att.playerId] = { cid: att.cid, until: now + HOLD_MS };
      await this.ctx.storage.put("holds", holds);
      const screen = this.screen();
      if (screen) this.send(screen, { type: "controllerLeft", playerId: att.playerId });
    }
    if (this.live().length === 0) await this.ctx.storage.setAlarm(now + IDLE_CLEANUP_MS);
  }

  /** Close sockets whose heartbeat stopped (half-open mobile connections). */
  private async pruneStale() {
    const now = Date.now();
    for (const ws of this.live()) {
      const att = this.att(ws)!;
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? att.at;
      if (now - Math.max(last, att.at) > STALE_MS) {
        this.retire(ws, 1011, "stale");
        await this.onLeave(att);
      }
    }
  }

  /** Mark a socket as gone (so its eventual close event is ignored) and close it. */
  private retire(ws: WebSocket, code: number, reason: string) {
    const att = this.att(ws);
    if (att) ws.serializeAttachment({ ...att, gone: true });
    try { ws.close(code, reason); } catch { /* noop */ }
  }

  /** Upgrade then immediately close with a reason code — browsers can't read
   *  HTTP error statuses on a WebSocket, but they do see the close code. */
  private reject(code: number, reason: string): Response {
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept(); // plain socket (not hibernatable): it only carries one close frame
    ws.addEventListener("error", () => {});
    ws.addEventListener("close", () => {});
    ws.close(code, reason);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private overRate(ws: WebSocket): boolean {
    const now = Date.now();
    const r = this.rate.get(ws);
    if (!r || now - r.t >= 1000) { this.rate.set(ws, { t: now, n: 1 }); return false; }
    return ++r.n > CONTROLLER_RATE;
  }

  private live(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN && !this.att(w)?.gone);
  }
  private screen(): WebSocket | undefined {
    return this.live().find((w) => this.att(w)?.role === "screen");
  }
  private controllers(): WebSocket[] {
    return this.live().filter((w) => this.att(w)?.role === "controller");
  }
  private att(ws: WebSocket): Attachment | null {
    try { return ws.deserializeAttachment() as Attachment | null; } catch { return null; }
  }
  private send(ws: WebSocket, msg: AnyMessage) { this.sendRaw(ws, JSON.stringify(msg)); }
  private sendRaw(ws: WebSocket, data: string) {
    try { ws.send(data); } catch { /* socket closing */ }
  }
}
