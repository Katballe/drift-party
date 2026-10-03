// Integration test for POST /api/feedback. Needs the dev server running:
//   npm run dev        (then, in another terminal)
//   node test/feedback.test.mjs [http://127.0.0.1:8787]
// Each run saves a few rows to the local dev feedback box, and the rate limit
// (5 per sender per 10 min) means a second run within 10 minutes of the first
// needs `npm run dev` restarted.
const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures++; };
const post = (body, headers = { "Content-Type": "application/json" }) =>
  fetch(`${BASE}/api/feedback`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }).then((r) => r.status);
const good = { source: "controller", message: "Snake Canyon is great — more oil please!", contact: "test@example.com" };

console.log("Feedback test");
ok(await post(good) === 204, "valid feedback is saved (204)");
ok(await post({ source: "home", message: "  ok  " }) === 204, "contact is optional; the front page is a valid source");
ok(await post({ ...good, message: "   " }) === 400, "an empty message is refused");
ok(await post({ ...good, message: "x".repeat(2001) }) === 400, "a message over 2000 characters is refused");
ok(await post({ ...good, message: "🏁".repeat(2000) }) === 204, "2000 emoji fit (limits count characters, not UTF-16 units)");
ok(await post({ ...good, source: "admin" }) === 400, "an unknown source is refused");
ok(await post("{not json") === 400, "malformed JSON is refused");
ok(await post(good, { "Content-Type": "text/plain" }) === 415, "non-JSON content types are refused (no CORS-free cross-site posts)");
ok(await post({ ...good, website: "http://spam.example" }) === 204, "a filled-in honeypot looks accepted (and isn't saved)");
// Three saved so far (refused and honeypot posts never reach the box).
ok(await post(good) === 204 && await post(good) === 204, "a sender's fourth and fifth are still fine");
ok(await post(good) === 429, "the sixth within 10 minutes is rate-limited (429)");

const get = await fetch(`${BASE}/api/feedback`);
ok(get.status === 405, `reading feedback back over HTTP is impossible (GET → ${get.status})`);
ok((await fetch(`${BASE}/api/anything`)).status === 404, "other /api/ paths are 404, not the SPA page");

process.exit(failures ? 1 : 0);
