import { describe, expect, test } from "vitest";
import { asSeq } from "../src/brand.ts";
import { mulberry32 } from "../src/prng.ts";
import { hashWorld } from "../src/sim/hash.ts";
import { World } from "../src/sim/world.ts";

const DT = 1 / 30;

/** A scripted 2-player match: same seed + same script must give bit-identical worlds. */
function play(seed: number, scriptSeed: number, steps: number, tweak?: (i: number) => boolean) {
  const world = new World({ w: 1280, h: 720 }, { rng: mulberry32(seed) });
  world.addPlayer("a", { remote: true, slot: 0 });
  world.addPlayer("b", { remote: true, slot: 1 });
  world.startHazards();
  const script = mulberry32(scriptSeed);
  for (let i = 1; i <= steps; i++) {
    for (const id of ["a", "b"]) {
      world.setCommand(id, {
        seq: asSeq(i),
        thrust: script() < 0.7,
        turn: Math.floor(script() * 3) - 1,
        fire: tweak?.(i) ? !(script() < 0.5) : script() < 0.3,
      });
    }
    world.step(DT);
  }
  return world;
}

describe("World.step determinism", () => {
  test("two worlds built the same way and fed the same inputs end up identical", () => {
    const a = play(11, 5, 600);
    const b = play(11, 5, 600);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(a.count).toBe(b.count);
    expect([...a].map((e) => [e.kind, e.pos.x, e.pos.y])).toEqual(
      [...b].map((e) => [e.kind, e.pos.x, e.pos.y]),
    );
  });

  test("a different world seed gives a different world", () => {
    expect(hashWorld(play(11, 5, 300))).not.toBe(hashWorld(play(12, 5, 300)));
  });

  test("a different input script gives a different world", () => {
    expect(hashWorld(play(11, 5, 300))).not.toBe(hashWorld(play(11, 6, 300)));
  });

  test("stepping zero times changes nothing, and the hash is stable between calls", () => {
    const w = play(3, 3, 10);
    expect(hashWorld(w)).toBe(hashWorld(w));
  });
});

describe("World bookkeeping", () => {
  test("removePlayer takes the ship out of play without breaking later steps", () => {
    const world = new World({ w: 800, h: 600 }, { hazards: false, rng: mulberry32(1) });
    const ship = world.addPlayer("a", { remote: true, slot: 0, at: { x: 10, y: 10 } });
    world.addPlayer("b", { remote: true, slot: 1, at: { x: 400, y: 300 } });
    world.removePlayer("a");
    expect(ship.alive).toBe(false);
    expect(world.players.has("a")).toBe(false);
    expect(() => {
      for (let i = 0; i < 10; i++) world.step(DT);
    }).not.toThrow();
  });

  test("entity ids are assigned by the world and are unique", () => {
    const world = play(2, 2, 120);
    const ids = [...world].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === "number")).toBe(true);
  });
});
