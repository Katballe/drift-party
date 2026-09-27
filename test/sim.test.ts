// Headless checks for the tracks and race simulation. Run with `npm test`.
import { mkdirSync, writeFileSync } from "node:fs";
import { CAR_CFGS, Race, STEP, type Entrant } from "../src/screen/sim";
import { TRACKS, TRACK_ORDER, onRoad, type TrackDef } from "../src/screen/tracks";
import type { CarType, PlayerId } from "../src/shared/protocol";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.log(`  ✗ ${msg}`); }
};

const IDS: PlayerId[] = ["p1", "p2", "p3", "p4"];
const entrants = (types: CarType[], ai = true): Entrant[] =>
  types.map((t, i) => ({ id: IDS[i], name: IDS[i], color: "#000", carType: t, ai }));
const fixed = () => 0.999; // bots at full skill, deterministic

function run(race: Race, maxT: number, onStep?: (r: Race) => void) {
  let offTrack = 0, nan = false, boosts = 0, drafted = 0;
  while (!race.isOver() && race.time < maxT) {
    onStep?.(race);
    race.step(STEP);
    for (const e of race.events) if (e.k === "boost") boosts++;
    race.events.length = 0;
    for (const c of race.cars) {
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) nan = true;
      if (!onRoad(race.track, c.x, c.y, -1)) offTrack++;
      if (c.drafting) drafted++;
    }
  }
  return { offTrack, nan, boosts, drafted };
}

/** Parts of the road that are far apart along the lap must not touch (walls between them). */
function separation(t: TrackDef, crossing?: { x: number; y: number; r: number }) {
  const P = t.pts, n = P.length;
  let worst = Infinity;
  for (let i = 0; i < n; i += 2) for (let j = i + 2; j < n; j += 2) {
    const gap = Math.min(j - i, n - (j - i)) * 8;
    if (gap < 380) continue;
    const a = P[i], b = P[j];
    if (crossing && Math.hypot(a.x - crossing.x, a.y - crossing.y) < crossing.r && Math.hypot(b.x - crossing.x, b.y - crossing.y) < crossing.r) continue;
    worst = Math.min(worst, Math.hypot(a.x - b.x, a.y - b.y) - a.hw - b.hw);
  }
  return worst;
}

mkdirSync(".test-out", { recursive: true });
writeFileSync(".test-out/tracks.json", JSON.stringify(TRACK_ORDER.map((id) => {
  const t = TRACKS[id];
  return { id, name: t.name, pts: t.pts.map((p) => [p.x, p.y, p.hw]), gates: t.gates.map((g) => [g.x1, g.y1, g.x2, g.y2]), starts: t.starts, oil: t.oil, sand: t.sand, boosts: t.boosts };
})));

for (const id of TRACK_ORDER) {
  const t = TRACKS[id];
  console.log(`\n${t.name}  (${Math.round(t.length)} px, ${t.gates.length} gates)`);
  ok(t.gates.length >= 3 && t.gates.length <= 12, `checkpoints only at key corners (${t.gates.length} incl. start)`);
  ok(t.gates.slice(1).every((g) => Math.abs(t.pts[g.i].k) > 1 / 900), "every checkpoint sits in a bend");
  ok(t.starts.every((s) => onRoad(t, s.x, s.y, 12)), "start grid is on the road");
  ok(t.boosts.every((b) => onRoad(t, b.x, b.y, 10)), "boost pads are on the road");
  ok([...t.oil, ...t.sand].every((o) => onRoad(t, o.x, o.y, -o.r * 0.4)), "oil/sand patches overlap the road");
  ok(t.pts.every((p) => p.x - p.hw > 20 && p.x + p.hw < 1580 && p.y - p.hw > 90 && p.y + p.hw < 880), "fits on screen");
  const sep = separation(t, id === "junkyard" ? { x: 800, y: 480, r: 190 } : undefined);
  ok(sep > 18, `separate parts of the track never touch (closest wall gap ${sep.toFixed(0)} px)`);

  const race = new Race(t, entrants(["bus", "rc", "normal", "rc"]), 3, fixed);
  const r = run(race, 400);
  ok(!r.nan, "no NaN positions");
  ok(r.offTrack === 0, `cars never leave the road (off-road samples: ${r.offTrack})`);
  ok(race.cars.every((c) => c.finished), `a full field finishes 3 laps (t=${race.time.toFixed(1)}s)`);
  if (t.boosts.length) ok(r.boosts >= 4, `boost pads get used (${r.boosts} boosts)`);
  console.log(`    finish: ${race.rankings().map((c) => `${c.cfg.type} ${c.finishTime?.toFixed(1)}s`).join(", ")} · slipstream samples ${r.drafted}`);

  const laps: Record<string, number> = {};
  for (const type of Object.keys(CAR_CFGS) as CarType[]) {
    const tt = new Race(t, entrants([type]), 3, fixed);
    run(tt, 400);
    laps[type] = tt.cars[0].bestLap ?? Infinity;
  }
  const vals = Object.values(laps), spread = Math.max(...vals) / Math.min(...vals) - 1;
  console.log(`    best laps: ${Object.entries(laps).map(([k, v]) => `${k} ${v.toFixed(2)}s`).join(" · ")} (spread ${(spread * 100).toFixed(1)}%)`);
  ok(spread < 0.12, "car types are balanced within 12%");

  for (const type of ["bus", "rc"] as CarType[]) {
    const hug = new Race(t, entrants([type], false), 3, fixed);
    hug.cars[0].input = { throttle: true, right: true, left: false, brake: false };
    const h = run(hug, 20);
    ok(h.offTrack === 0 && !h.nan, `${type}: full throttle into the walls stays on the road`);
  }

  const ww = new Race(t, entrants(["normal"], false), 3, fixed);
  const c = ww.cars[0], P = t.pts, n = P.length;
  let warned = false;
  run(ww, 40, () => {
    let j = c.idx, d = 0;
    while (d < 60) { j = (j - 1 + n) % n; d += 8; }
    const raw = Math.atan2(P[j].y - c.y, P[j].x - c.x) - c.a, df = Math.atan2(Math.sin(raw), Math.cos(raw));
    c.input = { throttle: true, brake: false, left: df < -0.05, right: df > 0.05 };
    warned ||= c.wrongWay;
  });
  ok(c.gatesPassed <= 1 && warned, `driving backwards never counts and warns (gates ${c.gatesPassed})`);
}

console.log("\nCheckpoints");
ok(TRACKS.snake.gates.length > TRACKS.sunny.gates.length, `twisty Snake Canyon has more checkpoints (${TRACKS.snake.gates.length}) than Sunny Speedway (${TRACKS.sunny.gates.length})`);
{
  // Positions come from distance driven, so they stay exact between sparse checkpoints.
  const race = new Race(TRACKS.hairpin, entrants(["normal", "normal"]), 3, fixed);
  const [a, b] = race.cars;
  b.cfg.spd *= 0.85; b.cfg.acc *= 0.85;
  let wrong = 0;
  run(race, 25, (r) => {
    const pa = r.progress(a), pb = r.progress(b), first = r.rankings()[0];
    if (Math.abs(pa - pb) > 20 && first !== (pa > pb ? a : b)) wrong++;
  });
  ok(wrong === 0 && race.progress(a) > race.progress(b), `positions follow distance driven between checkpoints (mis-ranked steps: ${wrong})`);
}

console.log("\nMechanics");
{
  const race = new Race(TRACKS.sunny, entrants(["normal"], false), 3, fixed);
  const c = race.cars[0];
  c.input = { throttle: false, brake: true, left: false, right: false };
  run(race, 1.5);
  ok(c.fwd < -20, `brake from standstill reverses (fwd=${c.fwd.toFixed(0)})`);
}
{
  // Two cars nose-to-tail on the start straight: the one behind gets a tow.
  const race = new Race(TRACKS.sunny, entrants(["normal", "normal"], false), 3, fixed);
  const [a, b] = race.cars;
  const p = TRACKS.sunny.pts[20];
  Object.assign(b, { x: p.x, y: p.y, a: Math.atan2(p.ty, p.tx) });
  Object.assign(a, { x: p.x - p.tx * 70, y: p.y - p.ty * 70, a: Math.atan2(p.ty, p.tx) });
  for (const k of race.cars) { k.vx = p.tx * 200; k.vy = p.ty * 200; k.input = { throttle: true, brake: false, left: false, right: false }; }
  let drafted = false;
  run(race, 1.2, () => { drafted ||= a.drafting; });
  ok(drafted && !b.drafting, "slipstream: the trailing car gets a tow, the leader doesn't");
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
