import { Feedback, handleFeedback } from "./feedback";
import { Room } from "./room";

export { Feedback, Room };

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  FEEDBACK: DurableObjectNamespace<Feedback>;
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

    if (url.pathname === "/api/feedback") return handleFeedback(request, env);
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });

    // Everything else is a static asset (/screen/, /controller/, JS, fonts).
    return env.ASSETS.fetch(request);
  },
};
