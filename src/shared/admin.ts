import { appRoot } from "./net";
import type { AdminStatus, MapChannel, MapsDoc } from "./protocol";

/**
 * Client side of the admin login and the published maps (see
 * src/worker/admin.ts), used by the login page (/admin/) and the big screen.
 * The session is an HttpOnly cookie, so pages never see it — they only ask the
 * server whether they're logged in.
 */

/** Which maps this screen plays: /screen/?version=test is the test version. */
export function mapChannel(): MapChannel {
  return new URLSearchParams(location.search).get("version") === "test" ? "test" : "live";
}

/** The other version of this page (same path, ?version=test added or removed). */
export function versionUrl(channel: MapChannel): string {
  const u = new URL(location.href);
  if (channel === "test") u.searchParams.set("version", "test"); else u.searchParams.delete("version");
  return u.pathname + u.search;
}

const api = (path: string) => `${appRoot()}api/${path}`;

/** The login page, coming back to this page (or `next`) after logging in. */
export function adminPageUrl(next = location.pathname + location.search): string {
  return `${appRoot()}admin/?next=${encodeURIComponent(next)}`;
}

/** Log in. Returns null on success, or what went wrong. */
export async function login(password: string): Promise<string | null> {
  try {
    const res = await fetch(api("admin/login"), {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) return null;
    return res.status === 401 ? "Wrong password."
      : res.status === 429 ? "Too many wrong tries — wait 15 minutes and try again."
      : res.status === 503 ? "Admin login isn't set up on this server (no ADMIN_PASSWORD secret)."
      : `Couldn't log in (${res.status}) — try again.`;
  } catch {
    return "No connection — check your internet and try again.";
  }
}

export async function fetchMaps(channel: MapChannel): Promise<MapsDoc | null> {
  try {
    const res = await fetch(api(`maps?channel=${channel}`), { cache: "no-store" });
    return res.ok ? ((await res.json()) as MapsDoc) : null;
  } catch { return null; }
}

export async function fetchAdmin(): Promise<AdminStatus> {
  try {
    const res = await fetch(api("admin/me"), { cache: "no-store", credentials: "same-origin" });
    if (res.ok) return (await res.json()) as AdminStatus;
  } catch { /* offline, or a dev server without the API */ }
  return { admin: false, configured: false };
}

export async function logout(): Promise<void> {
  try { await fetch(api("admin/logout"), { method: "POST", credentials: "same-origin" }); } catch { /* ignore */ }
}

/** Publish track edits to a channel. Returns the stored doc, or an error message. */
export async function publishMaps(channel: MapChannel, edits: object): Promise<MapsDoc | string> {
  try {
    const res = await fetch(api(`admin/maps/${channel}`), {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits }),
    });
    if (res.ok) return (await res.json()) as MapsDoc;
    if (res.status === 401) return "You're not logged in as admin any more — log in again.";
    if (res.status === 413) return "Those edits are too big to publish.";
    return `Couldn't publish (${res.status}) — try again.`;
  } catch {
    return "No connection — check your internet and try again.";
  }
}
