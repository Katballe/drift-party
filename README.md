# Drift Party

Free online party racing. The big screen shows the race; every player uses
their phone as the controller. Up to **8 racers** join by scanning a QR code or
typing a 6-character room code. The big screen is never a player — phones race,
and the host can fill empty seats with **bots** (a solo phone gets a time trial).

Deployed as a single **Cloudflare Worker** with realtime rooms backed by a
**Durable Object** WebSocket relay — no third-party broker, works across any
network (Wi-Fi, cellular, different houses).

## Playing

- Open `/` and pick **Start a game** on a TV/laptop, or go straight to `/screen/`.
- Phones scan the QR code (or open `/controller/` and type the code), pick one
  of seven cars, and tap **Ready up** (which also goes fullscreen/landscape where
  supported). The phone lobby tells you to turn the phone sideways before the race.
- **Bots**: `+ Add bot` in the lobby (Easy / Normal / Hard). Bots fill empty
  seats from the back of the grid and step aside when a phone joins a full grid.
  Click a bot's car to change it, `×` to remove it. Bots-only races work too.
- Pick a track for a **single race**, or play the **🏆 Cup**: all five tracks in
  a row, 10 / 8 / 6 / 5 / 4 / 3 / 2 / 1 points per race, most points wins.
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
- **Cars** (seven, all lapping within ~10 % of each other on every track — see
  `npm test`): Normal Car (balanced), Sports Car (top speed, slides), Muscle Car
  (huge launch, lazy drifts), Go-Kart (best handling, low top speed), RC Car
  (quickest off the line, featherweight), Monster Truck (shrugs off sand, snow,
  bumps and grass), Heavy Bus (slow start, shoves everyone). Specs and the phone's
  stat bars both come from `src/shared/cars.ts`.
- **Speed bumps** (placed with the track editor): cost speed, more the faster you
  hit them.
- **Open tracks** (a track-editor option): no walls on the road — the terrain
  (grass, dirt, sand, snow) slows you and loosens grip, the scenery is solid, and
  the screen edge is the only hard wall. Checkpoint lines reach out across the
  terrain; skip one and your lap doesn't count until you go back (the car and the
  phone both say *missed checkpoint*).
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
| `src/screen/tracks.ts` | Track definitions: spline centerlines + widths → walls, gates, grid, pads, surfaces, scenery; applies track edits |
| `src/screen/track-edits.json` | Shipped track tuning (grip, walls, bumps, checkpoints…) — export from the track editor |
| `src/screen/sim.ts` | Pure race simulation (physics, walls/terrain, gates, boost/slipstream/catch-up, bumps, bot driver) — no DOM |
| `src/screen/render.ts` | Canvas renderer: hand-drawn tracks & scenery, skid marks, particles, cars, lobby thumbnails |
| `src/screen/dev.ts` | Track editor + debug overlays — **dev build only** |
| `src/shared/cars.ts`, `carArt.ts` | Car roster (physics + picker info) and the hand-drawn car art |
| `controller/`, `src/controller/main.ts` | Phone gamepad |
| `src/shared/protocol.ts` | Message protocol + close codes shared by all three |
| `src/shared/net.ts` | Reconnecting WebSocket client with heartbeat |
| `src/worker/` | Worker entry + `Room` Durable Object |

The `Room` Durable Object:
- assigns phones a slot (p1→p8), **sticky per client id** — a phone that
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
npm run dev        # dev build (with the track editor) + wrangler dev at http://127.0.0.1:8787
npm run dev:lan    # same, reachable from phones on your Wi-Fi: open the screen via your PC's LAN IP
```

### Track editor (dev build only)

`npm run dev`, `npm run dev:lan` and `npm run deploy:dev` build the client with
`vite build --mode devtools`, which compiles in `src/screen/dev.ts`. The normal
build (`npm run build` / `npm run deploy`) leaves it out entirely.

In the lobby press **E** (or **🛠 Track editor**). Per track you can:
- place / remove **checkpoints** (click the road; C) and **speed bumps** (B), and
  set how much speed a bump takes;
- change **road grip** (how slippery the ice is — or make any track icy);
- switch **walls ↔ open track**, and tune the off-road penalty and how much
  scenery crowds the road;
- **Test drive** (Enter) with the phones and bots in the lobby (adds 3 bots if
  nobody's in) — you come back to the editor after. **G** toggles checkpoint
  lines during races.

Edits are drafts in that browser's localStorage, layered over
`src/screen/track-edits.json`. To ship them: **Copy/Download JSON**, replace
`src/screen/track-edits.json` with it, commit.

`npm run deploy:dev` deploys the dev build as a separate Worker
(`drift-party-dev`, its own rooms) so it can be tested with real phones over the
internet without touching the live game.

Open `/screen/` on a computer and `/controller/?room=CODE` on a phone (or the
**Test controller ↗** button for a second window — arrow keys work there too).
The phone pad uses gap-free touch zones and re-reads every finger on each touch
event, so holding GAS while steering can never drop out.
Add `?debug` to the screen URL to expose the game as `window.drift`.

- `npm test` — headless checks for every track: geometry (no touching sections),
  gates, an 8-car grid, a full 8-car race that never leaves the road, balance of
  all 7 cars, walls, wrong-way, boost pads, slipstream, reverse, bot skill levels
  and overtaking, open tracks (screen-edge wall, terrain, solid scenery, missed
  checkpoints), speed bumps, track edits
- `npm run typecheck` — `tsc --noEmit`
- `npm run check` — both of the above
- `node test/relay.test.mjs` — relay integration test (needs `npm run dev` running)
- `npm run deploy` — check + build + `wrangler deploy` (production; what CI runs on push to `main`)
- `npm run deploy:dev` — check + dev build + `wrangler deploy --env dev` (`drift-party-dev`)

`.github/workflows/deploy.yml` deploys on every push to `main` once the repo has
a `CLOUDFLARE_API_TOKEN` secret.

## Stack

Vite + TypeScript (no framework), Cloudflare Workers, Durable Objects,
WebSockets. Fonts: Caveat (Google Fonts). QR via `qrcode`.

> Reference: `.reference/` holds the decoded original single-file bundles this
> was ported from (kept out of git). `docs/` has the original MVP spec and
> technical plan.
