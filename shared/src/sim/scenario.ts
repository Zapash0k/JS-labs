// A fixed, scripted match used to prove determinism: same seed + same commands -> same hash,
// in Node and in the browser (open /?hashcheck=1 and compare with `npm run hash -w shared`).
import { asSeq } from "../brand.ts";
import { mulberry32 } from "../prng.ts";
import { TICK_DT, WORLD_SIZE } from "../constants.ts";
import { hashWorld } from "./hash.ts";
import { Vector2 } from "./vector.ts";
import { World } from "./world.ts";

export interface ScenarioOptions {
  seed?: number;
  ticks?: number;
  players?: number;
  noise?: (() => number) | null;
}

export function runScenario({
  seed = 42,
  ticks = 1000,
  players = 2,
  noise = null,
}: ScenarioOptions = {}): string {
  const world = new World(WORLD_SIZE, { hazards: true, rng: mulberry32(seed), asteroidTarget: 5 });
  world.startHazards();
  for (let slot = 0; slot < players; slot++) world.addPlayer(`p${slot}`, { remote: true, slot });
  const script = mulberry32(seed + 1); // the "players": a separate seeded stream of commands
  let seq = 0;
  for (let tick = 0; tick < ticks; tick++) {
    seq++;
    for (let slot = 0; slot < players; slot++) {
      world.setCommand(`p${slot}`, {
        seq: asSeq(seq),
        thrust: script() < 0.7,
        turn: Math.floor(script() * 3) - 1,
        fire: script() < 0.3,
      });
    }
    world.step(TICK_DT);
    // The classic bug, on purpose (the caller passes Math.random): anything random inside the step
    // makes the hash differ between runs.
    if (noise)
      for (const e of world.ofKind("ship")) e.vel = new Vector2(e.vel.x + noise() * 1e-9, e.vel.y);
  }
  return hashWorld(world);
}
