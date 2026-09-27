# Drift Party

Free online party racing. The big screen shows the race; every player uses
their phone as the controller. Up to **4 racers** join by scanning a QR code or
typing a 6-character room code. The big screen is never a player — only
connected phones race (a solo phone gets a time trial).

Deployed as a single **Cloudflare Worker** with realtime rooms backed by a
**Durable Object** WebSocket relay — no third-party broker, works across any
network (Wi-Fi, cellular, different houses).

## Playing

- Open `/` and pick **Start a game** on a TV/laptop, or go straight to `/screen/`.
- Phones scan the QR code (or open `/controller/` and type the code), pick a
  car, and tap **Ready up** (which also goes fullscreen/landscape where supported).
- Pick a track for a **single race**, or play the **🏆 Cup**: all five tracks in
  a row, 10 / 7 / 5 / 3 points per race, most points wins.
- Controls: left thumb steers, right thumb **GAS** / **BRAKE**. Brake while
  steering at speed = **drift**. Hold brake when stopped = **reverse**.
- Host keyboard: Enter start / next race · Esc/P pause · F fullscreen · L lobby.
- A phone that joins mid-race watches and races from the next one. A phone that
  drops mid-race becomes a ghost car until it reconnects (its slot is held).

### Tracks

| Track | Character |
|---|---|
| **Sunny Speedway** ●○○ | Wide and fast; boost pads on both straights, sand on the outside of the big bends |
| **Junkyard 8** ●●○ | Figure-8 — boost pads launch you into the crossing; oil slicks on the tips and just past the crossing |
| **Snake Canyon** ●●○ | Tight S-bends in the desert; sand traps on the outside of every bend |
| **Frosty Fjord** ●●○ | Sheet ice (half grip) around a fjord inlet; snowdrifts slow you |
| **Hairpin Heights** ●●● | Three hairpins linked by long straights; boost out of each hairpin |

### Racing mechanics

- **Boost pads** ⚡: +32 % top speed and a kick for ~1 s.
- **Slipstream** 💨: sit 25–125 px behind another car for +8 % top speed.
- **Catch-up**: players well behind the leader get up to +7 % top speed.
- **Surfaces**: oil (almost no grip), sand/snow (slow), ice tracks (half grip).
- **Cars**: Heavy Bus (highest top speed, shoves others), RC Car (quickest off
  the line, gets knocked around), Normal Car (balanced) — tuned to lap within a
  few % of each other on every track (see `npm test`).
- **Checkpoints** sit only at the key corners of each track (found from the
  track's curvature — the middle of every real bend), marked with little flags:
  Sunny Speedway has 3, Snake Canyon 7. They span the whole road and only count
  in the race direction; positions between them come from distance driven.
  Driving the wrong way shows a warning. There is no sound — phones vibrate on
  laps, boosts, hits and the finish.

## How it works

```
 Phone (controller)  ─┐
 Phone (controller)  ─┤  WebSocket   ┌──────────────┐  WebSocket   ┌────────────┐
 Phone (controller)  ─┼────────────► │ Room (DO)    │ ◄────────────│ Screen     │
 Phone (controller)  ─┘   /ws        │ relay + slot │   /ws        │ sim + draw │
                                     │ assignment   │              └────────────┘
                                     └──────────────┘
```

The screen is authoritative: it runs the simulation at a fixed 120 Hz and
renders interpolated frames. Phones only send button state
(a 4-bit mask, on change + a 500 ms keepalive) and receive a batched status
message (~10 Hz, only when something changed) — cheap enough for the Workers
free tier.

| Path | What |
|---|---|
| `index.html` | Landing page (host / join) |
| `screen/`, `src/screen/main.ts` | Host page: lobby, HUD, results, keyboard, networking |
| `src/screen/tracks.ts` | Track definitions: spline centerlines + widths → walls, gates, grid, pads, surfaces |
| `src/screen/sim.ts` | Pure race simulation (physics, walls, gates, boost/slipstream/catch-up) — no DOM |
| `src/screen/render.ts` | Canvas renderer: hand-drawn tracks & scenery, skid marks, particles, cars, lobby thumbnails |
| `controller/`, `src/controller/main.ts` | Phone gamepad |
| `src/shared/protocol.ts` | Message protocol + close codes shared by all three |
| `src/shared/net.ts` | Reconnecting WebSocket client with heartbeat |
| `src/worker/` | Worker entry + `Room` Durable Object |

The `Room` Durable Object:
- assigns phones a slot (p1→p4), **sticky per client id** — a phone that
  drops (screen lock, network switch) gets its own car back; its slot is held
  for 60 s;
- lets the host's own tab **reclaim the room after a refresh**, but refuses a
  different screen trying to take the code;
- tags phone messages with the sender's slot and **only relays whitelisted
  message types** (rate- and size-limited);
- rejects with clear close codes: `4001` room taken, `4002` full, `4003` no such
  room, `4004` replaced by a newer connection;
- uses the WebSocket Hibernation API with an auto-answered `ping`/`pong`
  heartbeat, prunes dead sockets, and wipes room storage 2 h after it empties.

## Develop

```sh
npm install
npm run dev        # vite build + wrangler dev at http://127.0.0.1:8787
```

Open `/screen/` on a computer and `/controller/?room=CODE` on a phone (or the
**Test controller ↗** button for a second window — arrow keys work there too).
The phone pad uses gap-free touch zones and re-reads every finger on each touch
event, so holding GAS while steering can never drop out.
Add `?debug` to the screen URL to expose the game as `window.drift`.

- `npm test` — headless checks for every track: geometry (no touching sections),
  gates, grid, a full race that never leaves the road, car balance, walls,
  wrong-way, boost pads, slipstream, reverse
- `npm run typecheck` — `tsc --noEmit`
- `npm run check` — both of the above
- `node test/relay.test.mjs` — relay integration test (needs `npm run dev` running)
- `npm run deploy` — check + build + `wrangler deploy`

`.github/workflows/deploy.yml` deploys on every push to `main` once the repo has
a `CLOUDFLARE_API_TOKEN` secret.

## Stack

Vite + TypeScript (no framework), Cloudflare Workers, Durable Objects,
WebSockets. Fonts: Caveat (Google Fonts). QR via `qrcode`.

> Reference: `.reference/` holds the decoded original single-file bundles this
> was ported from (kept out of git). `docs/` has the original MVP spec and
> technical plan.
