import { appRoot } from "../shared/net";
import type { AdminStatus, MapChannel, MapsDoc } from "../shared/protocol";

/**
 * Big-screen side of the admin login and the published maps (see
 * src/worker/admin.ts). The session is an HttpOnly cookie, so this page never
 * sees it — it only asks the server whether it's logged in.
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

// ── login dialog ──────────────────────────────────────────────────────────────
let dialog: HTMLDialogElement | null = null;
let onDone: (() => void) | null = null;

const CSS = `
#adm { border: none; border-radius: 18px; padding: 0; margin: auto; width: min(400px, calc(100vw - 32px));
  background: #f0ede4; color: #1a2a0a; font-family: 'Caveat', cursive; box-shadow: 0 10px 50px rgba(0,0,0,0.55); }
#adm::backdrop { background: rgba(0,0,0,0.6); }
#adm form { display: flex; flex-direction: column; gap: 10px; padding: 20px 22px 18px; }
#adm h2 { font-size: 36px; line-height: 1; }
#adm p { font-size: 19px; color: #6b6450; line-height: 1.2; }
#adm input { width: 100%; padding: 10px 12px; border: 2px solid #ddd; border-radius: 10px; background: #fff; color: #222;
  font: 16px/1.4 system-ui, sans-serif; outline: none; }
#adm input:focus { border-color: #1a2a0a; }
#adm .adm-status { min-height: 20px; font: 15px/1.3 system-ui, sans-serif; color: #888; }
#adm .adm-status.err { color: #E63946; }
#adm .adm-row { display: flex; justify-content: flex-end; gap: 10px; }
#adm button { border: none; border-radius: 11px; padding: 8px 22px; font: 700 23px 'Caveat', cursive; cursor: pointer; }
#adm .adm-cancel { background: #ddd8c8; color: #444; }
#adm .adm-go { background: #FFD600; color: #1a2a0a; box-shadow: 0 4px 0 #b8920a; }
#adm .adm-go:disabled { opacity: 0.6; cursor: default; }
`;

function build(): HTMLDialogElement {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const d = document.createElement("dialog");
  d.id = "adm";
  d.setAttribute("aria-labelledby", "adm-title");
  d.innerHTML = `<form novalidate>
      <h2 id="adm-title">🔑 Admin login</h2>
      <p>For the map editor and publishing maps to the test version or the live game.</p>
      <input type="text" name="username" value="admin" autocomplete="username" hidden />
      <input type="password" name="password" placeholder="Password" aria-label="Admin password" autocomplete="current-password" />
      <div class="adm-status" role="status"></div>
      <div class="adm-row">
        <button type="button" class="adm-cancel">Cancel</button>
        <button type="submit" class="adm-go">Log in ▶</button>
      </div>
    </form>`;
  document.body.appendChild(d);
  const form = d.querySelector("form")!;
  form.addEventListener("submit", (e) => { e.preventDefault(); void submit(form); });
  d.querySelector(".adm-cancel")!.addEventListener("click", () => d.close());
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  return d;
}

function status(text: string, err = false) {
  const el = dialog?.querySelector<HTMLElement>(".adm-status");
  if (el) { el.textContent = text; el.className = `adm-status${err ? " err" : ""}`; }
}

async function submit(form: HTMLFormElement) {
  const input = form.elements.namedItem("password") as HTMLInputElement;
  const btn = form.querySelector<HTMLButtonElement>(".adm-go")!;
  if (!input.value) { status("Type the password first.", true); input.focus(); return; }
  btn.disabled = true;
  status("Checking…");
  try {
    const res = await fetch(api("admin/login"), {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: input.value }),
    });
    if (res.ok) { form.reset(); dialog?.close(); onDone?.(); return; }
    status(res.status === 401 ? "Wrong password."
      : res.status === 429 ? "Too many wrong tries — wait 15 minutes."
      : res.status === 503 ? "Admin login isn't set up on this server (no ADMIN_PASSWORD secret)."
      : "Couldn't log in — try again.", true);
    input.select();
  } catch {
    status("No connection — check your internet and try again.", true);
  } finally {
    btn.disabled = false;
  }
}

/** Open the login dialog; `done` runs after a successful login. */
export function openLogin(done: () => void) {
  dialog ??= build();
  onDone = done;
  if (dialog.open) return;
  status("");
  dialog.showModal();
  dialog.querySelector<HTMLInputElement>('input[name="password"]')!.focus();
}

export const loginOpen = () => !!dialog?.open;
