// A fixed, scripted match used to prove determinism: same seed + same commands -> same hash,
// in Node and in the browser (open /?hashcheck=1 and compare with `npm run hash -w shared`).
import { mulberry32 } from "../prng.js";
import { TICK_DT, WORLD_SIZE } from "../protocol.js";
import { hashWorld } from "./hash.js";
import { World } from "./world.js";

export function runScenario({ seed = 42, ticks = 1000, players = 2, noise = null } = {}) {
  const world = new World(WORLD_SIZE, { hazards: true, rng: mulberry32(seed), asteroidTarget: 5 });
  world.startHazards();
  for (let slot = 0; slot < players; slot++) world.addPlayer(`p${slot}`, { remote: true, slot });
  const script = mulberry32(seed + 1); // the "players": a separate seeded stream of commands
  let seq = 0;
  for (let tick = 0; tick < ticks; tick++) {
    seq++;
    for (let slot = 0; slot < players; slot++) {
      world.setCommand(`p${slot}`, {
        seq,
        thrust: script() < 0.7,
        turn: Math.floor(script() * 3) - 1,
        fire: script() < 0.3,
      });
    }
    world.step(TICK_DT);
    // The classic bug, on purpose (the caller passes Math.random): anything random inside the step
    // makes the hash differ between runs.
    if (noise) for (const e of world.ofKind("ship")) e.vel.x += noise() * 1e-9;
  }
  return hashWorld(world);
}
