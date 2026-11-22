import { DurableObject } from "cloudflare:workers";
import { MAP_CHANNELS, MAPS_MAX_BYTES, type AdminStatus, type MapChannel, type MapsDoc } from "../shared/protocol";
import type { Env } from "./worker";

/**
 * Admin login and the published maps.
 *
 * Login: one password, the Worker secret ADMIN_PASSWORD
 * (`npx wrangler secret put ADMIN_PASSWORD`, and `--env dev` for the dev Worker;
 * locally it comes from .dev.vars). A correct password gets an HttpOnly,
 * SameSite=Strict session cookie signed with a key derived from the password,
 * so changing the password logs every session out.
 *
 * Maps: the map editor publishes the full track-edits object to a channel —
 * "test" (the test version of the game) or "live" (production). Both are rows in
 * the Maps Durable Object's SQLite table. Anyone can read them (the game needs
 * them); only an admin can write.
 */

const OBJECT_NAME = "maps";          // the one instance
const COOKIE = "dp_admin";
const SESSION_S = 7 * 24 * 3600;     // a login lasts a week
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILS = 8;           // wrong passwords per sender per window

export class Maps extends DurableObject<Env> {
  private fails = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS maps (
      channel    TEXT PRIMARY KEY,
      edits      TEXT NOT NULL,
      version    INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  private row(channel: MapChannel): MapsDoc | null {
    const r = this.ctx.storage.sql.exec<{ edits: string; version: number; updated_at: string }>(
      "SELECT edits, version, updated_at FROM maps WHERE channel = ?", channel).toArray()[0];
    return r ? { channel, edits: JSON.parse(r.edits), version: r.version, updatedAt: r.updated_at } : null;
  }

  get(channel: MapChannel): MapsDoc {
    const own = this.row(channel);
    if (own) return own;
    if (channel === "test") {
      const live = this.row("live");
      return { channel, edits: live?.edits ?? null, version: 0, updatedAt: null, sameAsLive: true };
    }
    return { channel, edits: null, version: 0, updatedAt: null };
  }

  put(channel: MapChannel, edits: Record<string, unknown>): MapsDoc {
    const version = (this.row(channel)?.version ?? 0) + 1, now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO maps (channel, edits, version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(channel) DO UPDATE SET edits = excluded.edits, version = excluded.version, updated_at = excluded.updated_at",
      channel, JSON.stringify(edits), version, now);
    return { channel, edits, version, updatedAt: now };
  }

  versions(): AdminStatus["maps"] {
    const out = {} as NonNullable<AdminStatus["maps"]>;
    for (const c of MAP_CHANNELS) { const d = this.row(c); out[c] = { version: d?.version ?? 0, updatedAt: d?.updatedAt ?? null }; }
    return out;
  }

  /** Best-effort brute-force brake, kept in memory only (no IPs are stored). */
  loginBlocked(sender: string): boolean {
    const now = Date.now();
    const recent = (this.fails.get(sender) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    this.fails.set(sender, recent);
    return recent.length >= LOGIN_MAX_FAILS;
  }

  loginFailed(sender: string) {
    const now = Date.now();
    this.fails.set(sender, [...(this.fails.get(sender) ?? []), now]);
    if (this.fails.size > 1000) for (const [k, ts] of this.fails) if (now - ts[ts.length - 1] >= LOGIN_WINDOW_MS) this.fails.delete(k);
  }
}

// ── session cookie ────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function signingKey(password: string) {
  return crypto.subtle.importKey("raw", enc.encode(`drift-party-admin:${password}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeSession(password: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_S;
  const sig = await crypto.subtle.sign("HMAC", await signingKey(password), enc.encode(`admin:${exp}`));
  return `${exp}.${b64url(sig)}`;
}

/** Is this request from a logged-in admin? */
export async function isAdmin(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([A-Za-z0-9_-]+)`).exec(request.headers.get("Cookie") ?? "");
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  try {
    return await crypto.subtle.verify("HMAC", await signingKey(env.ADMIN_PASSWORD), unb64url(m[2]), enc.encode(`admin:${m[1]}`));
  } catch { return false; }
}

async function passwordMatches(given: string, real: string): Promise<boolean> {
  const [a, b] = await Promise.all([given, real].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]; // same-length digests, constant time
  return diff === 0;
}

function cookie(request: Request, value: string, maxAge: number) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const reply = (status: number, text = "", headers: Record<string, string> = {}) =>
  new Response(text || null, { status, headers: { "Cache-Control": "no-store", ...(text ? { "Content-Type": "text/plain; charset=utf-8" } : {}), ...headers } });

/** JSON-only bodies: a cross-site browser request then needs a CORS preflight, which is never granted. */
async function readJson(request: Request, max: number): Promise<{ ok: true; body: any } | { ok: false; res: Response }> {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return { ok: false, res: reply(415, "Expected JSON") };
  if (Number(request.headers.get("Content-Length") ?? 0) > max) return { ok: false, res: reply(413, "Too large") };
  const raw = await request.text();
  if (raw.length > max) return { ok: false, res: reply(413, "Too large") };
  try { return { ok: true, body: JSON.parse(raw) }; } catch { return { ok: false, res: reply(400, "Bad JSON") }; }
}

/** A plausible TrackEdits object: track id → object of settings. The client builds tracks from it. */
function validEdits(e: unknown): e is Record<string, Record<string, unknown>> {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  return Object.entries(e).every(([k, v]) => /^[a-z0-9_-]{1,32}$/i.test(k) && !!v && typeof v === "object" && !Array.isArray(v));
}

const stub = (env: Env) => env.MAPS.get(env.MAPS.idFromName(OBJECT_NAME));

/** /api/maps and /api/admin/* — returns null if the path isn't one of ours. */
export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname, method = request.method;

  if (path === "/api/maps") {
    if (method !== "GET") return reply(405, "Method not allowed", { Allow: "GET" });
    const channel = (url.searchParams.get("channel") ?? "live") as MapChannel;
    if (!MAP_CHANNELS.includes(channel)) return reply(400, "Unknown channel");
    return json(200, await stub(env).get(channel));
  }

  if (path === "/api/admin/me") {
    if (method !== "GET") return reply(405, "Method not allowed", { Allow: "GET" });
    const admin = await isAdmin(request, env);
    const body: AdminStatus = { admin, configured: !!env.ADMIN_PASSWORD };
    if (admin) body.maps = await stub(env).versions();
    return json(200, body);
  }

  if (path === "/api/admin/login") {
    if (method !== "POST") return reply(405, "Method not allowed", { Allow: "POST" });
    if (!env.ADMIN_PASSWORD) return reply(503, "Admin login isn't set up (no ADMIN_PASSWORD secret)");
    const r = await readJson(request, 4096);
    if (!r.ok) return r.res;
    const sender = request.headers.get("CF-Connecting-IP") ?? "unknown", maps = stub(env);
    if (await maps.loginBlocked(sender)) return reply(429, "Too many wrong passwords — try again later", { "Retry-After": String(LOGIN_WINDOW_MS / 1000) });
    const password = typeof r.body?.password === "string" ? r.body.password : "";
    if (!password || !(await passwordMatches(password, env.ADMIN_PASSWORD))) {
      await maps.loginFailed(sender);
      return reply(401, "Wrong password");
    }
    return reply(204, "", { "Set-Cookie": cookie(request, await makeSession(env.ADMIN_PASSWORD), SESSION_S) });
  }

  if (path === "/api/admin/logout") {
    if (method !== "POST") return reply(405, "Method not allowed", { Allow: "POST" });
    return reply(204, "", { "Set-Cookie": cookie(request, "", 0) });
  }

  const m = /^\/api\/admin\/maps\/([a-z]+)$/.exec(path);
  if (m) {
    const channel = m[1] as MapChannel;
    if (!MAP_CHANNELS.includes(channel)) return reply(404, "Unknown channel");
    if (method !== "PUT") return reply(405, "Method not allowed", { Allow: "PUT" });
    if (!(await isAdmin(request, env))) return reply(401, "Log in as admin first");
    const r = await readJson(request, MAPS_MAX_BYTES);
    if (!r.ok) return r.res;
    if (!validEdits(r.body?.edits)) return reply(400, "Expected { edits: { trackId: { … } } }");
    return json(200, await stub(env).put(channel, r.body.edits));
  }

  return null;
}
