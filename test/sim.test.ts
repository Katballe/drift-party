// Headless checks for the tracks and race simulation. Run with `npm test`.
import { mkdirSync, writeFileSync } from "node:fs";
import { CAR_CFGS, Race, STEP, carOverlap, hull, type BotSkill, type Entrant } from "../src/screen/sim";
import { BOUNDS, TRACKS, TRACK_ORDER, applyTrackEdits, buildTrack, edgeGap, lapFraction, lineIsClean, onRoad, type TrackDef } from "../src/screen/tracks";
import { carStats } from "../src/shared/cars";
import { CAR_TYPES, MAX_RACERS, type CarType, type RacerId } from "../src/shared/protocol";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.log(`  ✗ ${msg}`); }
};

const IDS: RacerId[] = ["p1", "b1", "p2", "b2", "p3", "b3", "p4", "b4"];
const entrants = (types: CarType[], ai = true, skill?: BotSkill): Entrant[] =>
  types.map((t, i) => ({ id: IDS[i], name: IDS[i], color: "#000", carType: t, ai, skill }));
const FULL: CarType[] = [...CAR_TYPES, "normal"]; // a full 8-car grid with every car in it

/** Deepest overlap between any two solid cars right now (px). */
const deepest = (r: Race) => {
  let d = 0;
  for (let i = 0; i < r.cars.length; i++) for (let j = i + 1; j < r.cars.length; j++) {
    const a = r.cars[i], b = r.cars[j];
    if (a.finished || b.finished || a.ghost || b.ghost) continue;
    d = Math.max(d, carOverlap(a, b)?.depth ?? 0);
  }
  return d;
};
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
  ok(t.starts.length === MAX_RACERS && t.starts.every((s) => onRoad(t, s.x, s.y, 12)), `all ${MAX_RACERS} grid slots are on the road`);
  const busGap = CAR_CFGS.bus.w * 2 * 0.42;
  ok(t.starts.every((a, i) => t.starts.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) > busGap)), "grid slots don't overlap, even for buses");
  ok(t.boosts.every((b) => onRoad(t, b.x, b.y, 10)), "boost pads are on the road");
  ok([...t.oil, ...t.sand].every((o) => onRoad(t, o.x, o.y, -o.r * 0.4)), "oil/sand patches overlap the road");
  ok(t.pts.every((p) => p.x - p.hw > 20 && p.x + p.hw < 1580 && p.y - p.hw > 90 && p.y + p.hw < 880), "fits on screen");
  const sep = separation(t, id === "junkyard" ? { x: 800, y: 480, r: 190 } : undefined);
  ok(sep > 18, `separate parts of the track never touch (closest wall gap ${sep.toFixed(0)} px)`);

  const race = new Race(t, entrants(FULL), 3, fixed);
  let overlap = 0;
  const r = run(race, 400, (rc) => { overlap = Math.max(overlap, deepest(rc)); });
  ok(!r.nan, "no NaN positions");
  ok(r.offTrack === 0, `cars never leave the road (off-road samples: ${r.offTrack})`);
  ok(race.cars.length === 8 && race.cars.every((c) => c.finished), `a full 8-car field finishes 3 laps (t=${race.time.toFixed(1)}s)`);
  ok(overlap < 1.5, `cars bump instead of driving into each other (deepest overlap all race: ${overlap.toFixed(2)} px)`);
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
  ok(spread < 0.12, `all ${vals.length} car types are balanced within 12%`);

  for (const type of ["bus", "rc", "truck", "kart"] as CarType[]) {
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

console.log("\nBots");
for (const id of ["sunny", "hairpin"] as const) {
  const lap: Partial<Record<BotSkill, number>> = {};
  for (const skill of ["easy", "normal", "hard"] as BotSkill[]) {
    const tt = new Race(TRACKS[id], entrants(["normal"], true, skill), 3, fixed);
    run(tt, 400);
    lap[skill] = tt.cars[0].bestLap ?? Infinity;
  }
  console.log(`    ${id} best laps: easy ${lap.easy!.toFixed(2)}s · normal ${lap.normal!.toFixed(2)}s · hard ${lap.hard!.toFixed(2)}s`);
  ok(lap.hard! < lap.normal! && lap.normal! < lap.easy!, `${TRACKS[id].name}: hard bots lap faster than normal, normal faster than easy`);
}
for (const skill of ["easy", "normal"] as BotSkill[]) {
  const stuck: string[] = [];
  for (const id of TRACK_ORDER) {
    const race = new Race(TRACKS[id], entrants(FULL, true, skill), 3, Math.random);
    run(race, 500);
    if (!race.cars.every((c) => c.finished)) stuck.push(id);
  }
  ok(!stuck.length, `a full field of ${skill} bots finishes every track${stuck.length ? ` (not: ${stuck})` : ""}`);
}
{
  // Bots don't just queue up behind each other: someone overtakes.
  const race = new Race(TRACKS.sunny, entrants(FULL, true, "normal"), 3, () => 0.5);
  let changed = 0, last = "";
  run(race, 400, (r) => { const now = r.rankings().map((c) => c.id).join(); if (last && now !== last && r.time > 3) changed++; last = now; });
  ok(changed > 0, `bots overtake each other (${changed} position changes)`);
}

console.log("\nCars");
{
  const names = CAR_TYPES.map((t) => `${t} ${Object.values(carStats(t)).join("")}`).join(" · ");
  console.log(`    stat bars (speed/accel/handling/weight/offroad): ${names}`);
  ok(CAR_TYPES.every((t) => Object.values(carStats(t)).every((v) => v >= 1 && v <= 5)), "stat bars are 1–5");
  ok(carStats("truck").offroad === 5 && carStats("sport").speed === 5 && carStats("kart").handling === 5, "truck is the off-roader, sports car the fastest, kart the best handler");
  // Monster truck vs normal car through the same sand trap.
  const sand = TRACKS.sunny.sand[0], P = TRACKS.sunny.pts;
  const kept: Partial<Record<CarType, number>> = {};
  for (const type of ["normal", "truck"] as CarType[]) {
    const race = new Race(TRACKS.sunny, entrants([type], false), 3, fixed);
    const c = race.cars[0];
    let j = 0, bd = Infinity;
    P.forEach((p, i) => { const d = Math.hypot(p.x - sand.x, p.y - sand.y); if (d < bd) { bd = d; j = i; } });
    Object.assign(c, { x: sand.x, y: sand.y, a: Math.atan2(P[j].ty, P[j].tx), idx: j, vx: P[j].tx * 250, vy: P[j].ty * 250 });
    c.input = { throttle: true, brake: false, left: false, right: false };
    run(race, 0.35);
    kept[type] = c.speed;
  }
  ok(kept.truck! > kept.normal! + 25, `monster truck keeps its speed in sand (truck ${kept.truck!.toFixed(0)} vs normal ${kept.normal!.toFixed(0)} px/s)`);
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

console.log("\nCar-to-car contact");
{
  // Every pair of cars, nose to tail and side by side: contact happens exactly where the bodies meet.
  let wrong = 0;
  const at = (type: CarType, x: number, y: number, a: number) => ({ x, y, a, cfg: CAR_CFGS[type] });
  for (const A of CAR_TYPES) for (const B of CAR_TYPES) {
    const ha = hull({ cfg: CAR_CFGS[A] }), hb = hull({ cfg: CAR_CFGS[B] });
    for (const [dx, dy, touch] of [[1, 0, ha.hx + hb.hx], [0, 1, ha.hy + hb.hy]] as const) {
      const apart = carOverlap(at(A, 0, 0, 0), at(B, dx * (touch + 0.5), dy * (touch + 0.5), 0));
      const touching = carOverlap(at(A, 0, 0, 0), at(B, dx * (touch - 0.5), dy * (touch - 0.5), 0));
      if (apart || !touching) wrong++;
    }
  }
  ok(wrong === 0, "for every pair of cars, contact starts exactly where the bodies meet (nose-to-tail and side-by-side)");
  const tbone = carOverlap(at("normal", 0, 0, 0), at("bus", 0, CAR_CFGS.bus.w / 2 + hull({ cfg: CAR_CFGS.normal }).hy + 1, Math.PI / 2));
  ok(!tbone, "a bus nosing up to a car's side stops at the side, not at a circle around it");
}
{
  // Rear-end on a straight: the faster car bumps the slower one along instead of driving into it.
  const race = new Race(TRACKS.sunny, entrants(["normal", "bus"], false), 3, fixed);
  const [a, b] = race.cars, p = TRACKS.sunny.pts[25], h = Math.atan2(p.ty, p.tx);
  Object.assign(b, { x: p.x, y: p.y, a: h, px: p.x, py: p.y, vx: p.tx * 80, vy: p.ty * 80 });
  Object.assign(a, { x: p.x - p.tx * 60, y: p.y - p.ty * 60, a: h, px: p.x - p.tx * 60, py: p.y - p.ty * 60, vx: p.tx * 300, vy: p.ty * 300 });
  a.input = { throttle: true, brake: false, left: false, right: false };
  let overlap = 0, hit = false;
  for (let k = 0; k < 120; k++) { race.step(STEP); hit ||= race.events.some((e) => e.k === "hit"); race.events.length = 0; overlap = Math.max(overlap, deepest(race)); }
  ok(hit && overlap < 0.5 && b.speed > 120, `rear-ending: a real bump that shoves the car ahead (overlap ${overlap.toFixed(2)} px, bus pushed to ${b.speed.toFixed(0)} px/s)`);
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

console.log("\nOpen tracks (walls off)");
const inside = (c: { x: number; y: number }) => c.x > BOUNDS.x0 && c.x < BOUNDS.x1 && c.y > BOUNDS.y0 && c.y < BOUNDS.y1;
for (const id of TRACK_ORDER) {
  const t = buildTrack(id, { walls: false, clutter: 3 });
  const race = new Race(t, entrants(FULL, true, "normal"), 3, fixed);
  let out = 0, nan = false, overlap = 0;
  while (!race.isOver() && race.time < 500) {
    race.step(STEP); race.events.length = 0;
    overlap = Math.max(overlap, deepest(race));
    for (const c of race.cars) { if (!inside(c)) out++; if (!Number.isFinite(c.x + c.y)) nan = true; }
  }
  ok(!nan && out === 0 && race.cars.every((c) => c.finished), `${t.name}: a full field of bots finishes, nobody leaves the screen (${t.obstacles.length} obstacles, ${race.time.toFixed(1)}s)`);
  ok(overlap < 1.5, `…and cars never drive into each other (deepest overlap ${overlap.toFixed(2)} px)`);
  ok(t.obstacles.every((o) => edgeGap(t, o.x, o.y) > o.r), "scenery never sits on the road");
}
{
  // Full throttle, stuck steering: off the road, round the screen, into the edge — never through it.
  for (const id of TRACK_ORDER) {
    const t = buildTrack(id, { walls: false });
    const race = new Race(t, entrants(["rc"], false), 3, fixed);
    const c = race.cars[0];
    let out = 0, walls = 0, off = 0, topOff = 0, topOn = 0;
    while (race.time < 25) {
      c.input = { throttle: true, brake: false, left: race.time % 6 < 1, right: false };
      race.step(STEP);
      for (const e of race.events) if (e.k === "wall") walls++;
      race.events.length = 0;
      if (!inside(c)) out++;
      if (c.offRoad) { off++; topOff = Math.max(topOff, c.speed); } else topOn = Math.max(topOn, c.speed);
    }
    ok(out === 0 && walls > 0 && off > 0, `${t.name}: a runaway car hits the screen edge and stays on screen (${walls} wall hits)`);
  }
}
{
  // Terrain: the same car on the same straight line is slower on the grass than on the road.
  const t = buildTrack("sunny", { walls: false, clutter: 0 });
  t.obstacles.length = 0; t.boosts.length = 0; // a clear, fair run across the infield
  const speedAt = (y: number) => {
    const race = new Race(t, entrants(["normal"], false), 3, fixed);
    const c = race.cars[0];
    Object.assign(c, { x: 560, y, a: 0, vx: 0, vy: 0, px: 560, py: y });
    c.input = { throttle: true, brake: false, left: false, right: false };
    run(race, 1.6);
    return { speed: c.speed, off: c.offRoad };
  };
  const road = speedAt(185), grass = speedAt(470);
  ok(!road.off && grass.off && grass.speed < road.speed * 0.8, `terrain slows you: ${grass.speed.toFixed(0)} px/s on grass vs ${road.speed.toFixed(0)} on the road`);
  const truck = new Race(t, entrants(["truck"], false), 3, fixed), tc = truck.cars[0];
  Object.assign(tc, { x: 560, y: 470, a: 0, vx: 0, vy: 0, px: 560, py: 470 });
  tc.input = { throttle: true, brake: false, left: false, right: false };
  run(truck, 1.6);
  ok(tc.speed > grass.speed + 30, `the monster truck is the off-roader (${tc.speed.toFixed(0)} px/s on grass)`);
  const soft = buildTrack("sunny", { walls: false, clutter: 0, roughness: 0 });
  soft.obstacles.length = 0; soft.boosts.length = 0;
  const sr = new Race(soft, entrants(["normal"], false), 3, fixed), sc = sr.cars[0];
  Object.assign(sc, { x: 560, y: 470, a: 0, vx: 0, vy: 0, px: 560, py: 470 });
  sc.input = { throttle: true, brake: false, left: false, right: false };
  run(sr, 1.6);
  ok(Math.abs(sc.speed - road.speed) < 5, "off-road penalty 0 = no penalty");
}
{
  // Scenery is solid on an open track.
  const t = buildTrack("hairpin", { walls: false, clutter: 2 });
  const o = t.obstacles.find((k) => k.x > 400 && k.x < 1200)!;
  t.obstacles.splice(0, t.obstacles.length, o); // just this one in the way
  const race = new Race(t, entrants(["bus"], false), 3, fixed), c = race.cars[0];
  Object.assign(c, { x: o.x - 120, y: o.y, a: 0, vx: 250, vy: 0, px: o.x - 120, py: o.y });
  c.input = { throttle: true, brake: false, left: false, right: false };
  let closest = Infinity;
  run(race, 1.5, () => { closest = Math.min(closest, Math.hypot(c.x - o.x, c.y - o.y)); });
  const touch = o.r + (c.cfg.w + c.cfg.h) * 0.25;
  ok(closest >= touch - 1 && closest < touch + 6, `cars bounce off scenery instead of driving through it (a ${o.kind})`);
}
{
  // Cutting past a checkpoint: flagged, and it doesn't count.
  const t = buildTrack("sunny", { walls: false });
  const race = new Race(t, entrants(["normal"], false), 3, fixed), c = race.cars[0];
  c.gatesPassed = 1; // crossed the start line
  const g = t.gates[1], p = t.pts[(g.i + 20) % t.pts.length];
  Object.assign(c, { x: p.x, y: p.y, px: p.x, py: p.y, idx: (g.i + 20) % t.pts.length });
  race.step(STEP);
  ok(c.missed && c.gatesPassed === 1, "driving past a checkpoint without crossing it is flagged and doesn't count");
  const back = t.pts[(g.i - 20 + t.pts.length) % t.pts.length];
  Object.assign(c, { x: back.x, y: back.y, px: back.x, py: back.y, idx: (g.i - 20 + t.pts.length) % t.pts.length, vx: 0, vy: 0 });
  race.step(STEP);
  ok(!c.missed, "going back clears the warning");
}

console.log("\nSpeed bumps");
{
  const lossFor = (type: CarType, edit = {}) => {
    const t = buildTrack("sunny", { bumps: [0.05], ...edit });
    const b = t.bumps[0], p = t.pts[(b.i - 12 + t.pts.length) % t.pts.length];
    const race = new Race(t, entrants([type], false), 3, fixed), c = race.cars[0];
    Object.assign(c, { x: p.x, y: p.y, px: p.x, py: p.y, a: Math.atan2(p.ty, p.tx), vx: p.tx * 300, vy: p.ty * 300, idx: (b.i - 12 + t.pts.length) % t.pts.length });
    let before = 0, after = 0, bumped = false;
    for (let k = 0; k < 72 && !bumped; k++) {
      const sp = c.speed;
      race.step(STEP);
      if (race.events.some((e) => e.k === "bump")) { bumped = true; before = sp; after = c.speed; }
      race.events.length = 0;
    }
    return { bumped, loss: bumped ? 1 - after / before : 0 };
  };
  const normal = lossFor("normal"), truck = lossFor("truck"), none = lossFor("normal", { bumpLoss: 0 });
  const ownSoft = lossFor("normal", { bumps: [{ at: 0.05, loss: 0.1 }] }), ownHard = lossFor("normal", { bumps: [{ at: 0.05, loss: 0.6 }], bumpLoss: 0.1 });
  ok(ownSoft.loss < normal.loss * 0.5 && ownHard.loss > normal.loss * 1.4, `a bump's own strength overrides the track's (soft −${(ownSoft.loss * 100).toFixed(0)}%, hard −${(ownHard.loss * 100).toFixed(0)}%)`);
  ok(normal.bumped && normal.loss > 0.25, `hitting a bump at speed costs speed (normal car −${(normal.loss * 100).toFixed(0)}%)`);
  ok(truck.loss < normal.loss * 0.7, `the monster truck rides bumps better (−${(truck.loss * 100).toFixed(0)}%)`);
  ok(Math.abs(none.loss) < 0.02, "bump strength 0 = harmless");
  const t = buildTrack("sunny", { bumps: [0.3, 0.7] });
  const race = new Race(t, entrants(["normal"], true), 3, fixed);
  run(race, 400);
  ok(race.cars[0].finished, "bots brake for bumps and still finish");
}

console.log("\nTrack edits");
{
  const sunny = TRACKS.sunny;
  const manual = buildTrack("sunny", { checkpoints: [0.3, 0.6] });
  ok(manual.gates.length === 3 && !manual.autoGates && sunny.autoGates, "hand-placed checkpoints replace the automatic ones");
  const j = TRACKS.junkyard, bad = j.pts.findIndex((_, i) => !lineIsClean(j, i));
  ok(bad >= 0 && buildTrack("junkyard", { checkpoints: [lapFraction(j, bad)] }).gates.length === 1, "a checkpoint on the figure-8 crossing is refused");
  ok(buildTrack("frosty", { grip: 0.3 }).grip === 0.3 && buildTrack("frosty", { grip: 99 }).grip === 1.5 && TRACKS.frosty.grip === 0.5, "ice grip is editable (and clamped)");
  ok(TRACKS.sunny.walls && !buildTrack("sunny", { walls: false }).walls, "walls default on, can be turned off");
  const changed = applyTrackEdits({ frosty: { grip: 0.35 } });
  ok(changed.join() === "frosty" && TRACKS.frosty.grip === 0.35 && applyTrackEdits({ frosty: { grip: 0.35 } }).length === 0, "applying edits rebuilds only the tracks that changed");
  applyTrackEdits({});
  ok(TRACKS.frosty.grip === 0.5, "clearing edits restores the track");
}
{
  // Every checkpoint gets two flags, both on open ground — incl. the inside of Hairpin Heights' hairpins.
  const bad: string[] = [];
  for (const id of TRACK_ORDER) for (const t of [TRACKS[id], buildTrack(id, { checkpoints: [0.2, 0.4, 0.6, 0.8] })]) {
    t.gates.slice(1).forEach((g, k) => {
      if (g.flags.length !== 2 || g.flags.some((f) => edgeGap(t, f.x, f.y) < 4)) bad.push(`${id} CP${k + 1}`);
    });
  }
  ok(!bad.length, `every checkpoint has two flags, both off the tarmac${bad.length ? ` (not: ${bad.join(", ")})` : ""}`);
  // Checkpoint lines only span the road, on open tracks too.
  const open = buildTrack("sunny", { walls: false });
  ok(open.gates.every((g) => Math.abs(Math.hypot(g.x2 - g.x1, g.y2 - g.y1) - 2 * (open.pts[g.i].hw + 12)) < 0.01), "checkpoint lines stay on the road on open tracks");
  ok(buildTrack("snake", { checkpointLines: true }).checkpointLines && !TRACKS.snake.checkpointLines, "red/white checkpoint lines are an option (off by default)");
  ok(buildTrack("snake", { checkerLines: true } as never).checkpointLines, "…and drafts saved under the old name still work");
}
{
  // Every feature can be placed / removed individually.
  const t = buildTrack("sunny", {
    sand: [{ x: 700, y: 500, r: 40 }], oil: [], boosts: [{ at: 0.5, off: 0.3 }, { at: 0.9, off: 5 }],
    scenery: [{ x: 800, y: 480, kind: "rock", s: 1.2 }, { x: 1, y: 1, kind: "rock", s: 1 }, { x: 900, y: 480, kind: "nope" as any, s: 1 }],
  });
  ok(t.sand.length === 1 && t.sand[0].x === 700 && t.oil.length === 0, "hand-placed sand / oil replace the track's own");
  ok(t.boosts.length === 2 && t.boosts[0].off === 0.3 && t.boosts[1].off === 0.6 && t.boosts.every((b) => onRoad(t, b.x, b.y, 5)), "hand-placed boost pads sit on the road (offset clamped)");
  ok(t.manualScenery && t.obstacles.length === 1 && t.obstacles[0].kind === "rock", "hand-placed scenery replaces the automatic scenery (off-screen / unknown pieces dropped)");
  const pads = new Race(buildTrack("sunny", { boosts: [{ at: 0.1, off: 0 }] }), entrants(["normal"]), 3, fixed);
  let boosts = 0;
  run(pads, 20, (r) => { boosts += r.cars[0].boostT >= 1.09 ? 1 : 0; });
  ok(boosts > 0, "a hand-placed boost pad works");
}

console.log("\nPer-item attributes");
{
  // Boost pad power: a stronger pad kicks harder and lasts longer; size is kept.
  const kick = (power: number) => {
    const t = buildTrack("sunny", { boosts: [{ at: 0.1, off: 0, len: 90, w: 40, power }] });
    const race = new Race(t, entrants(["normal"], false), 3, fixed), c = race.cars[0], p = t.boosts[0];
    const q = t.pts[(p.i - 8 + t.pts.length) % t.pts.length];
    Object.assign(c, { x: q.x, y: q.y, px: q.x, py: q.y, a: p.a, vx: Math.cos(p.a) * 150, vy: Math.sin(p.a) * 150, idx: (p.i - 8 + t.pts.length) % t.pts.length });
    let t0 = 0, peak = 0;
    for (let k = 0; k < 90; k++) { race.step(STEP); if (c.boostT > 0 && !t0) t0 = c.boostT; peak = Math.max(peak, c.speed); }
    return { dur: t0, peak, len: p.len, w: p.w };
  };
  const weak = kick(0.5), strong = kick(2);
  ok(strong.dur > weak.dur * 3 && strong.peak > weak.peak + 40 && weak.len === 90 && weak.w === 40, `boost pad power and size (boost ${weak.dur.toFixed(2)}s → ${strong.dur.toFixed(2)}s)`);
  // Sand / oil strength.
  const through = (edit: object, key: "sand" | "oil") => {
    const t = buildTrack("sunny", edit);
    t.obstacles.length = 0;
    const race = new Race(t, entrants(["normal"], false), 3, fixed), c = race.cars[0], o = t[key][0];
    Object.assign(c, { x: o.x - 30, y: o.y, px: o.x - 30, py: o.y, a: 0, vx: 220, vy: 0 });
    c.input = { throttle: true, brake: false, left: false, right: key === "oil", };
    run(race, 0.3);
    return { speed: c.speed, drift: Math.abs(Math.atan2(c.vy, c.vx) - c.a) };
  };
  const mild = through({ sand: [{ x: 780, y: 185, r: 60, k: 0.3 }] }, "sand"), deep = through({ sand: [{ x: 780, y: 185, r: 60, k: 2 }] }, "sand");
  ok(deep.speed < mild.speed - 30, `sand strength: deep sand (${deep.speed.toFixed(0)} px/s) slows more than light sand (${mild.speed.toFixed(0)})`);
  const grippy = through({ oil: [{ x: 780, y: 185, r: 60, k: 0.2 }] }, "oil"), slick = through({ oil: [{ x: 780, y: 185, r: 60, k: 2 }] }, "oil");
  ok(slick.drift > grippy.drift * 1.5, "oil strength: a slicker patch slides you more");
  // Checkpoint line override, and old plain-number lists still work.
  const t = buildTrack("sunny", { checkpoints: [0.2, { at: 0.5, line: true }, { at: 0.8, line: false }], checkpointLines: true });
  ok(t.gates[1].line === undefined && t.gates[2].line === true && t.gates[3].line === false, "a checkpoint can override the track's red/white line");
  ok(buildTrack("sunny", { bumps: [0.3, { at: 0.6 }] }).bumps.length === 2, "plain lap fractions and { at } objects both load");
  const snake = TRACKS.snake;
  ok(snake.sand.every((c, k) => c.orig === k) && snake.gates.slice(1).every((g, k) => g.orig === k) && snake.obstacles.every((o, k) => o.orig === k),
    "every original item knows which original it is (so the editor can reset it)");
  ok(buildTrack("snake", { sand: [{ x: 700, y: 500, r: 50, orig: 2 }, { x: 800, y: 500, r: 50 }] }).sand.map((c) => c.orig).join() === "2,",
    "edited items keep that link; added ones have none");
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
