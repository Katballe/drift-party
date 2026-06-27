// Wire protocol shared by the screen (host), the phone controllers, and the
// Durable Object relay. All messages are JSON objects with a `type` discriminator.
//
// Transport: each client opens a WebSocket to `/ws?room=CODE&role=screen|controller`.
// The relay (Room DO) assigns each controller a player slot, tags inbound
// controller messages with that slot's `playerId`, and routes screen→controller
// messages either to one slot (`playerId` present) or to everyone (broadcast).

export type PlayerId = "p1" | "p2" | "p3" | "p4";
export type CarType = "bus" | "rc" | "normal";
export type Role = "screen" | "controller";

/** Phone slots are handed out in this order, so the keyboard host keeps p1
 *  until a 4th phone joins. */
export const SLOT_ORDER: PlayerId[] = ["p2", "p3", "p4", "p1"];
export const ALL_SLOTS: PlayerId[] = ["p1", "p2", "p3", "p4"];

// ── Controller → Screen (relay tags each with the sender's playerId) ─────────
export interface JoinMsg { type: "join"; playerId?: PlayerId; name: string; carType: CarType; }
export interface ReadyMsg { type: "ready" | "unready"; playerId?: PlayerId; }
export interface SelectCarMsg { type: "selectCar"; playerId?: PlayerId; carType: CarType; }
export interface InputMsg {
  type: "input"; playerId?: PlayerId;
  throttle: boolean; brake: boolean; left: boolean; right: boolean;
}

// ── Screen → Controller(s) (relay unicasts if playerId matches a slot) ───────
export interface LobbyStateMsg { type: "lobbyState"; playerId?: PlayerId; state: string; }
export interface RaceStartingMsg { type: "raceStarting"; }
export interface PlayerStatusMsg {
  type: "playerStatus"; playerId: PlayerId;
  rank: number; lap: number; totalLaps: number;
  nextCP: number; totalCPs: number;
  driftCombo: number; driftScore: number;
  isDrifting: boolean; finished: boolean;
}
export interface PlayerFinishedMsg { type: "playerFinished"; playerId: PlayerId; }
export interface RaceResultsMsg { type: "raceResults"; results: unknown[]; }
export interface ReturnedToLobbyMsg { type: "returnedToLobby"; }

// ── Relay → client (connection/room lifecycle) ───────────────────────────────
export interface AssignedMsg { type: "assigned"; playerId: PlayerId; roomCode: string; }
export interface ControllerJoinedMsg { type: "controllerJoined"; playerId: PlayerId; }
export interface ControllerLeftMsg { type: "controllerLeft"; playerId: PlayerId; }
export interface ScreenLeftMsg { type: "screenLeft"; }
export interface RoomTakenMsg { type: "roomTaken"; } // a screen already owns this code
export interface RoomFullMsg { type: "roomFull"; }   // all 4 slots occupied

export type ClientMessage = JoinMsg | ReadyMsg | SelectCarMsg | InputMsg
  | LobbyStateMsg | RaceStartingMsg | PlayerStatusMsg | PlayerFinishedMsg
  | RaceResultsMsg | ReturnedToLobbyMsg;

export type RelayMessage = AssignedMsg | ControllerJoinedMsg | ControllerLeftMsg
  | ScreenLeftMsg | RoomTakenMsg | RoomFullMsg;

export type AnyMessage = ClientMessage | RelayMessage;

/** 6-char room code (no ambiguous chars). */
export function makeRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I,O,0,1
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
