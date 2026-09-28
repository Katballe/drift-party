// The car roster: physics numbers (used by the screen's sim) plus the name,
// blurb and derived stat bars the phones show in the car picker. Shared so the
// picker's bars always match what the car actually does.

import { CAR_TYPES, type CarType } from "./protocol";

export interface CarCfg {
  type: CarType;
  spd: number;   // top speed (px/s)
  acc: number;   // initial acceleration (px/s²); approaches spd exponentially
  str: number;   // steering rate (rad/s at speed)
  grip: number;  // how fast velocity re-aligns with heading (1/s)
  dGrip: number; // grip while drifting (brake + steer)
  mass: number;
  w: number; h: number;
  rough: number; // how much sand/snow bogs it down (1 = normal, lower = shrugs it off)
}

export interface CarInfo { label: string; blurb: string; }

// Every car is tuned to lap within a few % of the others on every track
// (see `npm test`) — they differ in *how* they're fast, not whether.
export const CAR_CFGS: Record<CarType, CarCfg> = {
  normal: { type: "normal", spd: 318, acc: 310, str: 2.8,  grip: 9,    dGrip: 2.8, mass: 1.5, w: 32, h: 18, rough: 1 },
  sport:  { type: "sport",  spd: 340, acc: 285, str: 2.74, grip: 7.6,  dGrip: 2.4, mass: 1.3, w: 34, h: 17, rough: 1.1 },
  muscle: { type: "muscle", spd: 322, acc: 390, str: 2.78, grip: 7.4,  dGrip: 2.1, mass: 1.9, w: 36, h: 20, rough: 1 },
  kart:   { type: "kart",   spd: 296, acc: 360, str: 2.95, grip: 11.5, dGrip: 3.2, mass: 0.8, w: 24, h: 17, rough: 1.15 },
  rc:     { type: "rc",     spd: 300, acc: 400, str: 2.95, grip: 10,   dGrip: 2.4, mass: 0.7, w: 22, h: 14, rough: 1 },
  truck:  { type: "truck",  spd: 314, acc: 270, str: 2.76, grip: 9.5,  dGrip: 3.4, mass: 2.6, w: 36, h: 26, rough: 0.3 },
  bus:    { type: "bus",    spd: 335, acc: 240, str: 2.65, grip: 8.5,  dGrip: 3.2, mass: 3.0, w: 44, h: 24, rough: 1 },
};

export const CARS: Record<CarType, CarInfo> = {
  normal: { label: "Normal Car",    blurb: "Balanced — good at everything" },
  sport:  { label: "Sports Car",    blurb: "Top speed, but it likes to slide" },
  muscle: { label: "Muscle Car",    blurb: "Monster launch, big lazy drifts" },
  kart:   { label: "Go-Kart",       blurb: "Glued to the road, low top speed" },
  rc:     { label: "RC Car",        blurb: "Quickest off the line, featherweight" },
  truck:  { label: "Monster Truck", blurb: "Ploughs through sand and snow" },
  bus:    { label: "Heavy Bus",     blurb: "Slow to start, shoves everyone" },
};

export const carLabel = (t: CarType) => CARS[t]?.label ?? t;

export interface CarStats { speed: number; accel: number; handling: number; weight: number; offroad: number; }

/** 1–5 bars per stat, scaled across the roster so the picker compares like with like. */
export function carStats(t: CarType): CarStats {
  const raw = (c: CarCfg): CarStats => ({
    speed: c.spd, accel: c.acc, handling: c.str * Math.sqrt(c.grip), weight: c.mass, offroad: -c.rough,
  });
  const all = CAR_TYPES.map((k) => raw(CAR_CFGS[k])), me = raw(CAR_CFGS[t]);
  const out = {} as CarStats;
  for (const k of Object.keys(me) as (keyof CarStats)[]) {
    const lo = Math.min(...all.map((s) => s[k])), hi = Math.max(...all.map((s) => s[k]));
    out[k] = hi > lo ? 1 + Math.round(((me[k] - lo) / (hi - lo)) * 4) : 3;
  }
  return out;
}
