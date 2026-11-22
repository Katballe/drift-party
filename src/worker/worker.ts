import { Maps, handleAdmin } from "./admin";
import { Feedback, handleFeedback } from "./feedback";
import { Room } from "./room";

export { Feedback, Maps, Room };

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  FEEDBACK: DurableObjectNamespace<Feedback>;
  MAPS: DurableObjectNamespace<Maps>;
  /** Worker secret: the admin password (map editor + publishing). Unset = no admin login. */
  ADMIN_PASSWORD?: string;
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
    if (url.pathname === "/api/maps" || url.pathname.startsWith("/api/admin/")) {
      const res = await handleAdmin(request, env, url);
      if (res) return res;
    }
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });

    // Everything else is a static asset (/screen/, /controller/, JS, fonts).
    return env.ASSETS.fetch(request);
  },
};
