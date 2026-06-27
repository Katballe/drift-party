# Drift Party

Local + online multiplayer arcade racing. The big screen shows the race; each
phone is a wireless gamepad. Up to **4 racers**: the host plays on the keyboard
(Player 1) and up to three friends join from their phones by scanning a QR code
or typing a 6-character room code. Empty slots are filled by AI.

Deployed as a single **Cloudflare Worker** with realtime rooms backed by a
**Durable Object** WebSocket relay — no third-party broker, works across any
network.

## How it works

```
 Phone (controller)  ─┐
 Phone (controller)  ─┤  WebSocket   ┌──────────────┐  WebSocket   ┌────────────┐
 Phone (controller)  ─┼────────────► │ Room (DO)    │ ◄────────────│ Screen     │
 Phone (controller)  ─┘   /ws        │ relay + slot │   /ws        │ canvas race│
                                     │ assignment   │              └────────────┘
                                     └──────────────┘
```

- `screen/` → the host page: canvas race, lobby, QR/room code. URL `/screen/`.
- `controller/` → the phone gamepad: gas/brake/steer + lobby. URL `/controller/`.
- `src/worker/` → the Worker: routes `/ws` to the `Room` Durable Object, serves
  the built client as static assets for everything else.
- `src/shared/protocol.ts` → the JSON message protocol shared by all three.
- `src/shared/net.ts` → auto-reconnecting WebSocket client.

The `Room` Durable Object assigns each phone a player slot (p2→p4, then p1),
tags inbound controller messages with that slot, and routes screen→controller
messages (unicast for per-player status, broadcast for race events). It uses the
WebSocket Hibernation API, so idle rooms cost nothing.

## Develop

```sh
npm install
npm run dev        # vite build + wrangler dev at http://127.0.0.1:8787
```

Open `/screen/` on a computer and `/controller/?room=CODE` on a phone (or a
second window). Arrow keys drive Player 1 on the screen.

- `npm run build` — build the client to `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm run deploy` — build + `wrangler deploy`

## Stack

Vite + TypeScript (no framework — the screen is a tight canvas loop), Cloudflare
Workers, Durable Objects, WebSockets. Fonts: Caveat (Google Fonts). QR via
`qrcode`.

> Reference: `.reference/` holds the decoded original single-file bundles this
> was ported from (kept out of git).
