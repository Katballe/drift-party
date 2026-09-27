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
      if (!/^[A-Z0-9]{4,8}$/.test(code)) {
        return new Response("Missing or invalid room code", { status: 400 });
      }
      // Route every client with the same code to the same Room instance.
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    // Everything else is a static asset (/screen/, /controller/, JS, fonts).
    return env.ASSETS.fetch(request);
  },
};
