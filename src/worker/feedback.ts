import { DurableObject } from "cloudflare:workers";
import { FEEDBACK_CONTACT_MAX, FEEDBACK_MAX, type FeedbackBody, type FeedbackSource } from "../shared/protocol";
import type { Env } from "./worker";

export interface FeedbackRow {
  source: FeedbackSource;
  message: string;
  contact: string;
  country: string;
  userAgent: string;
}
export type FeedbackResult = "saved" | "slowDown" | "full";

const OBJECT_NAME = "feedback";  // the one instance every submission goes to
const MAX_BODY = 16 * 1024;
const MAX_ROWS = 5000;           // a spam flood can't grow storage without bound
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 5;              // submissions per sender per window

/**
 * The feedback box: a single instance with one SQLite table that feedback is
 * appended to. It is write-only from the internet: nothing in this Worker reads
 * the table back, so the only way to see it is the Cloudflare dashboard
 * (Durable Objects → drift-party_Feedback → Data Studio, object name
 * "feedback"), which needs the Cloudflare account's login.
 *
 * The per-sender rate limit is kept in memory only (best effort — it resets
 * when the object is evicted), so IP addresses are never stored.
 */
export class Feedback extends DurableObject<Env> {
  private sent = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS feedback (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      source     TEXT NOT NULL,
      message    TEXT NOT NULL,
      contact    TEXT NOT NULL DEFAULT '',
      country    TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT ''
    )`);
  }

  add(row: FeedbackRow, sender: string): FeedbackResult {
    const now = Date.now();
    const recent = (this.sent.get(sender) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) return "slowDown";
    const sql = this.ctx.storage.sql;
    if (sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM feedback").one().n >= MAX_ROWS) return "full";
    sql.exec(
      "INSERT INTO feedback (created_at, source, message, contact, country, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
      new Date(now).toISOString(), row.source, row.message, row.contact, row.country, row.userAgent,
    );
    recent.push(now);
    this.sent.set(sender, recent);
    if (this.sent.size > 1000) {
      for (const [k, ts] of this.sent) if (now - ts[ts.length - 1] >= RATE_WINDOW_MS) this.sent.delete(k);
    }
    return "saved";
  }
}

const reply = (status: number, text = "", headers: Record<string, string> = {}) =>
  new Response(text || null, { status, headers: { "Cache-Control": "no-store", ...(text ? { "Content-Type": "text/plain; charset=utf-8" } : {}), ...headers } });

/** Trim, drop control characters (keeping newlines and tabs). null = too long. */
function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return "";
  const s = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return Array.from(s).length > max ? null : s;
}

/** POST /api/feedback — validate, then hand the row to the Feedback object. */
export async function handleFeedback(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return reply(405, "Method not allowed", { Allow: "POST" });
  // JSON-only means a cross-site browser request needs a CORS preflight, which we never grant.
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return reply(415, "Expected JSON");
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return reply(413, "Too long");
  const raw = await request.text();
  if (raw.length > MAX_BODY) return reply(413, "Too long");

  let body: Partial<FeedbackBody>;
  try { body = JSON.parse(raw); } catch { return reply(400, "Bad JSON"); }
  if (!body || typeof body !== "object") return reply(400, "Bad JSON");
  if (body.source !== "screen" && body.source !== "controller") return reply(400, "Bad source");
  const message = clean(body.message, FEEDBACK_MAX), contact = clean(body.contact, FEEDBACK_CONTACT_MAX);
  if (message === null || contact === null) return reply(400, "Too long");
  if (!message) return reply(400, "Empty message");
  if (body.website) return reply(204); // honeypot filled in: a bot — pretend it worked

  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const row: FeedbackRow = {
    source: body.source, message, contact,
    country: typeof cf?.country === "string" ? cf.country : "",
    userAgent: (request.headers.get("User-Agent") ?? "").slice(0, 300),
  };
  const sender = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const result = await env.FEEDBACK.get(env.FEEDBACK.idFromName(OBJECT_NAME)).add(row, sender);
  return result === "saved" ? reply(204)
    : result === "slowDown" ? reply(429, "Too many — try again later", { "Retry-After": String(RATE_WINDOW_MS / 1000) })
    : reply(503, "The feedback box is full");
}
