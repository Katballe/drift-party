import { Room } from "./room";

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("room") ?? "").toUpperCase();
      if (!code || code.length < 4) {
        return new Response("Missing room code", { status: 400 });
      }
      // Route every client with the same code to the same Room instance.
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    // Non-asset, non-/ws requests: let the static-asset handler answer
    // (it owns /screen/, /controller/, JS, fonts, and the SPA fallback).
    return env.ASSETS.fetch(request);
  },
};
