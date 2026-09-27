// Wire protocol shared by the screen (host), the phone controllers, and the
// Durable Object relay. All messages are JSON objects with a `type` discriminator.
//
// Transport: each client opens a WebSocket to
//   /ws?room=CODE&role=screen|controller&cid=CLIENT_ID
// The relay (Room DO) assigns each controller a player slot (sticky per `cid`,
// so a reconnecting phone gets its own car back), tags inbound controller
// messages with that slot's `playerId`, and routes screen→controller messages
// either to one slot (`playerId` present) or to everyone (broadcast).
// Only the message types listed in CONTROLLER_TYPES / SCREEN_TYPES are relayed.

export type PlayerId = "p1" | "p2" | "p3" | "p4";
export type CarType = "bus" | "rc" | "normal";
export type Role = "screen" | "controller";
export type Phase = "LOBBY" | "COUNTDOWN" | "RACING" | "PAUSED" | "FINISHED";

/** Phone slots are handed out in this order. Only phones are players. */
export const SLOT_ORDER: PlayerId[] = ["p1", "p2", "p3", "p4"];
export const ALL_SLOTS: PlayerId[] = ["p1", "p2", "p3", "p4"];
export const CAR_TYPES: CarType[] = ["bus", "rc", "normal"];
export const PLAYER_COLORS: Record<PlayerId, string> = { p1: "#E63946", p2: "#2196F3", p3: "#4CAF50", p4: "#FF9800" };
export const PLAYER_COLOR_NAMES: Record<PlayerId, string> = { p1: "Red", p2: "Blue", p3: "Green", p4: "Orange" };
export const CAR_LABELS: Record<CarType, string> = { bus: "Heavy Bus", rc: "RC Car", normal: "Normal Car" };
export const slotNumber = (id: PlayerId) => ALL_SLOTS.indexOf(id) + 1;
export const NAME_MAX = 12;

// Input bitmask carried by InputMsg.k
export const IN_THROTTLE = 1, IN_BRAKE = 2, IN_LEFT = 4, IN_RIGHT = 8;

// Status flag bits carried in PlayerStatus[2]
export const ST_FINISHED = 1, ST_WRONG_WAY = 2, ST_BOOST = 4, ST_DRAFT = 8, ST_OFFLINE = 16;

// WebSocket close codes. These are terminal: clients must not auto-reconnect.
export const CLOSE_ROOM_TAKEN = 4001; // a different screen already owns this code
export const CLOSE_ROOM_FULL = 4002;  // all 4 slots occupied
export const CLOSE_NO_ROOM = 4003;    // no game screen with this code
export const CLOSE_REPLACED = 4004;   // same client connected again elsewhere
export const TERMINAL_CLOSE_CODES = [CLOSE_ROOM_TAKEN, CLOSE_ROOM_FULL, CLOSE_NO_ROOM, CLOSE_REPLACED];

// ── Controller → Screen (relay tags each with the sender's playerId) ─────────
/** Full lobby profile; sent on (re)connect and whenever any field changes. */
export interface ProfileMsg { type: "profile"; playerId?: PlayerId; name: string; carType: CarType; ready: boolean; }
/** Current button state as a bitmask (IN_*). Sent on change + slow keepalive. */
export interface InputMsg { type: "input"; playerId?: PlayerId; k: number; }

// ── Screen → Controller(s) (relay unicasts if playerId matches a slot) ───────
export interface CupInfo { race: number; of: number; }
/** Game phase. Broadcast on every change; unicast to a phone when it joins.
 *  `racers` = slots in the current race (a phone that joined mid-race watches). */
export interface PhaseMsg { type: "phase"; playerId?: PlayerId; phase: Phase; totalLaps: number; racers: PlayerId[]; track: string; cup: CupInfo | null; }
/** [rank, lap, flags(ST_*), hits] */
export type PlayerStatus = [number, number, number, number];
/** Batched per-player race status, broadcast ~10 Hz only when it changed. */
export interface StatusMsg { type: "status"; totalLaps: number; p: Partial<Record<PlayerId, PlayerStatus>>; }
export interface ResultRow { id: PlayerId; rank: number; name: string; time: number | null; best: number | null; pts: number; }
export interface Standing { id: PlayerId; name: string; points: number; }
export interface ResultsMsg { type: "results"; results: ResultRow[]; cup: (CupInfo & { standings: Standing[] }) | null; }

// ── Relay → client (connection/room lifecycle) ───────────────────────────────
export interface AssignedMsg { type: "assigned"; playerId: PlayerId; roomCode: string; screen: boolean; }
export interface ControllerJoinedMsg { type: "controllerJoined"; playerId: PlayerId; }
export interface ControllerLeftMsg { type: "controllerLeft"; playerId: PlayerId; }
export interface ScreenJoinedMsg { type: "screenJoined"; }
export interface ScreenLeftMsg { type: "screenLeft"; }

export type ControllerMessage = ProfileMsg | InputMsg;
export type ScreenMessage = PhaseMsg | StatusMsg | ResultsMsg;
export type RelayMessage = AssignedMsg | ControllerJoinedMsg | ControllerLeftMsg | ScreenJoinedMsg | ScreenLeftMsg;
export type AnyMessage = ControllerMessage | ScreenMessage | RelayMessage;

/** Message types the relay accepts from each role; anything else is dropped. */
export const CONTROLLER_TYPES = new Set<string>(["profile", "input"]);
export const SCREEN_TYPES = new Set<string>(["phase", "status", "results"]);

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I,O,0,1

/** 6-char room code (no ambiguous chars). */
export function makeRoomCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

/** Normalise user-typed codes: uppercase, drop spaces/punctuation. */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

export const isRoomCode = (s: string) => /^[A-Z0-9]{4,8}$/.test(s);

/** Random client id (sticky per browser tab via sessionStorage). */
export function makeClientId(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
