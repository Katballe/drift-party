// Integration test for admin login + published maps. Needs the dev server running
// with ADMIN_PASSWORD set (put `ADMIN_PASSWORD=...` in .dev.vars):
//   npm run dev        (then, in another terminal)
//   ADMIN_PASSWORD=... node test/admin.test.mjs [http://127.0.0.1:8787]
// It publishes to the local dev server's maps (never the deployed game).
const BASE = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!PASSWORD) { console.error("Set ADMIN_PASSWORD to the one in .dev.vars"); process.exit(2); }
let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures++; };
const json = { "Content-Type": "application/json" };
const req = (path, init = {}) => fetch(BASE + path, { redirect: "manual", ...init });

console.log(`Admin + maps test · ${BASE}`);

let r = await req("/api/admin/me");
let me = await r.json();
ok(r.ok && me.admin === false && me.configured === true, "not logged in by default; login is set up");

r = await req("/api/admin/maps/test", { method: "PUT", headers: json, body: JSON.stringify({ edits: {} }) });
ok(r.status === 401, `publishing without logging in is refused (${r.status})`);

r = await req("/api/admin/login", { method: "POST", headers: json, body: JSON.stringify({ password: "wrong" + PASSWORD }) });
ok(r.status === 401, `a wrong password is refused (${r.status})`);

r = await req("/api/admin/login", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ password: PASSWORD }) });
ok(r.status === 415, `a non-JSON login (e.g. a cross-site form) is refused (${r.status})`);

r = await req("/api/admin/login", { method: "POST", headers: json, body: JSON.stringify({ password: PASSWORD }) });
const setCookie = r.headers.get("set-cookie") ?? "";
ok(r.status === 204 && /dp_admin=\d+\.[\w-]+/.test(setCookie), "the right password logs in");
ok(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), "the session cookie is HttpOnly + SameSite=Strict");
const cookie = setCookie.split(";")[0];
const auth = { ...json, Cookie: cookie };

r = await req("/api/admin/me", { headers: { Cookie: cookie } });
me = await r.json();
ok(me.admin === true && me.maps && "live" in me.maps && "test" in me.maps, "logged in: /me says admin and lists the map versions");

const forged = cookie.replace(/\.[\w-]+$/, ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
r = await req("/api/admin/maps/test", { method: "PUT", headers: { ...json, Cookie: forged }, body: JSON.stringify({ edits: {} }) });
ok(r.status === 401, `a forged session cookie is refused (${r.status})`);

const live0 = await (await req("/api/maps?channel=live")).json();
const mark = Math.round(Math.random() * 1000) / 1000;
const testEdits = { sunny: { grip: 0.5 + mark / 10 } };

r = await req("/api/admin/maps/test", { method: "PUT", headers: auth, body: JSON.stringify({ edits: "nope" }) });
ok(r.status === 400, `malformed edits are refused (${r.status})`);

r = await req("/api/admin/maps/test", { method: "PUT", headers: auth, body: JSON.stringify({ edits: testEdits }) });
const pushed = await r.json();
ok(r.ok && pushed.channel === "test" && pushed.version >= 1, `push to test → v${pushed.version}`);

let test = await (await req("/api/maps?channel=test")).json();
ok(JSON.stringify(test.edits) === JSON.stringify(testEdits) && !test.sameAsLive, "the test version serves what was pushed");
let live = await (await req("/api/maps?channel=live")).json();
ok(JSON.stringify(live) === JSON.stringify(live0), "production is untouched by a push to test");

r = await req("/api/admin/maps/live", { method: "PUT", headers: auth, body: JSON.stringify({ edits: testEdits }) });
const promoted = await r.json();
ok(r.ok && promoted.version === live0.version + 1, `push to production → v${promoted.version}`);
live = await (await req("/api/maps?channel=live")).json();
ok(JSON.stringify(live.edits) === JSON.stringify(testEdits), "production now serves the new maps");

r = await req("/api/admin/maps/staging", { method: "PUT", headers: auth, body: JSON.stringify({ edits: {} }) });
ok(r.status === 404, `unknown channels are refused (${r.status})`);

r = await req("/api/admin/logout", { method: "POST" });
ok(r.status === 204 && /Max-Age=0/.test(r.headers.get("set-cookie") ?? ""), "log out clears the cookie");

// Put production back the way it was.
await req("/api/admin/maps/live", { method: "PUT", headers: auth, body: JSON.stringify({ edits: live0.edits ?? {} }) });

console.log(failures ? `\n${failures} check(s) failed` : "\nAll admin checks passed");
process.exit(failures ? 1 : 0);
