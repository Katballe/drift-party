// Integration test for the Room relay. Needs the dev server running:
//   npm run dev        (then, in another terminal)
//   node test/relay.test.mjs [http://127.0.0.1:8787]
const BASE = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/^http/, "ws");
const room = "T" + Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z0-9]/g, "X");
let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(role, cid) {
  const ws = new WebSocket(`${BASE}/ws?room=${room}&role=${role}&cid=${cid}`);
  const c = { ws, msgs: [], closed: null };
  ws.onmessage = (e) => c.msgs.push(e.data === "pong" ? "pong" : JSON.parse(e.data));
  ws.onclose = (e) => { c.closed = e.code; };
  c.open = new Promise((res) => { ws.onopen = () => res(true); setTimeout(() => res(false), 3000); });
  c.send = (m) => ws.send(typeof m === "string" ? m : JSON.stringify(m));
  c.of = (type) => c.msgs.filter((m) => m.type === type);
  return c;
}

console.log(`Relay test · room ${room}`);
const screen = client("screen", "hosttokenAAAA");
ok(await screen.open, "screen connects");

const phones = [];
for (let i = 1; i <= 4; i++) { const p = client("controller", `phone000${i}`); phones.push(p); await p.open; await sleep(80); }
await sleep(200);
ok(phones.map((p) => p.of("assigned")[0]?.playerId).join() === "p1,p2,p3,p4", "4 phones get slots p1..p4");
ok(screen.of("controllerJoined").length === 4, "screen is told about each phone");

const fifth = client("controller", "phone0005");
await sleep(400);
ok(fifth.closed === 4002, `5th phone is refused as full (close ${fifth.closed})`);

// Phone 2 (slot p2) drops: its slot is held, a newcomer can't take it, and it gets it back.
phones[1].ws.close();
await sleep(300);
ok(screen.of("controllerLeft").some((m) => m.playerId === "p2"), "screen hears that p2 left");
const intruder = client("controller", "phone0006");
await sleep(400);
ok(intruder.closed === 4002, "a newcomer cannot take a held slot");
const back = client("controller", "phone0002");
await sleep(400);
ok(back.of("assigned")[0]?.playerId === "p2", "the dropped phone reclaims its own slot");

// Spoofing and routing
screen.msgs.length = 0;
phones[0].send({ type: "controllerJoined", playerId: "p4" });
phones[0].send({ type: "input", k: 5, playerId: "p4" });
await sleep(250);
ok(!screen.msgs.some((m) => m.type === "controllerJoined"), "relay drops non-whitelisted phone messages");
ok(screen.of("input")[0]?.playerId === "p1", "phone input arrives tagged with the sender's own slot");

phones.forEach((p) => (p.msgs.length = 0)); back.msgs.length = 0;
screen.send({ type: "phase", playerId: "p1", phase: "RACING", totalLaps: 3 });
screen.send({ type: "phase", phase: "PAUSED", totalLaps: 3 });
await sleep(250);
ok(phones[0].of("phase").length === 2 && phones[2].of("phase").length === 1, "unicast reaches one phone, broadcast reaches all");

phones[0].send("ping");
await sleep(200);
ok(phones[0].msgs.includes("pong"), "heartbeat ping is answered");

// Another screen can't hijack the code; the same host (refresh) can take over.
const thief = client("screen", "hosttokenBBBB");
await sleep(400);
ok(thief.closed === 4001, "a different screen is refused");
const refreshed = client("screen", "hosttokenAAAA");
await sleep(400);
ok(screen.closed === 4004, "the host's old tab is replaced on refresh");
ok(refreshed.of("controllerJoined").length === 4, "the refreshed screen sees all 4 phones");
ok(phones[0].of("screenJoined").length === 1, "phones are told the host is back");

const lost = new WebSocket(`${BASE}/ws?room=NOPE99&role=controller&cid=phone0099`);
const lostCode = await new Promise((r) => { lost.onclose = (e) => r(e.code); setTimeout(() => r(null), 3000); });
ok(lostCode === 4003, `joining an unknown room is refused (close ${lostCode})`);

for (const c of [refreshed, back, ...phones]) try { c.ws.close(); } catch {}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll relay checks passed");
process.exit(failures ? 1 : 0);
