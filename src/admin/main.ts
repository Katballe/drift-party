import { fetchAdmin, login, logout } from "../shared/admin";
import { appRoot } from "../shared/net";

// The admin page (/admin/): log in, then jump to the map editor on the live game
// or the test version. ?next=<path> (from the big screen's 🔑 Admin button)
// sends you straight back there after logging in.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const views = ["loading", "login", "signedIn", "off"] as const;
const show = (v: (typeof views)[number]) => { for (const id of views) $(id).hidden = id !== v; };

/** Only paths inside this app — never another site. */
function nextUrl(): string | null {
  const n = new URLSearchParams(location.search).get("next");
  if (!n || !n.startsWith(appRoot()) || n.startsWith("//") || n.includes("\\")) return null;
  return n;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

async function refresh() {
  const me = await fetchAdmin();
  if (!me.configured) { show("off"); return; }
  if (!me.admin) { show("login"); $("password").focus(); return; }
  const v = me.maps;
  const line = (label: string, x?: { version: number; updatedAt: string | null }) =>
    `${label}: ${x && x.version ? `v${x.version} · ${when(x.updatedAt)}` : "nothing pushed yet"}`;
  $("versions").innerHTML = v ? `${line("🚀 Production", v.live)}<br>${line("🧪 Test", v.test)}` : "";
  show("signedIn");
}

const status = (text: string, err = false) => { const el = $("status"); el.textContent = text; el.className = `status${err ? " err" : ""}`; };

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("password"), btn = $<HTMLButtonElement>("submit");
  if (!input.value) { status("Type the password first.", true); input.focus(); return; }
  btn.disabled = true;
  status("Checking…");
  const err = await login(input.value);
  btn.disabled = false;
  if (err) { status(err, true); input.select(); return; }
  input.value = "";
  status("");
  const next = nextUrl();
  if (next) { location.href = next; return; }
  await refresh();
});

$("logout").addEventListener("click", async () => {
  await logout();
  status("Logged out.");
  show("login");
});

void refresh();
