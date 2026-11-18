import { describe, expect, test } from "vitest";
import { mulberry32 } from "../src/prng.ts";
import { Bullet } from "../src/sim/bullet.ts";
import { findCollisions } from "../src/sim/collision.ts";
import { Explosion } from "../src/sim/explosion.ts";
import { SHIP_RADIUS } from "../src/sim/shipPhysics.ts";
import { Vector2 } from "../src/sim/vector.ts";
import { World } from "../src/sim/world.ts";

const DT = 1 / 30;
const BULLET_RADIUS = 3;
const REACH = SHIP_RADIUS + BULLET_RADIUS; // distance at which a bullet touches a ship

const arena = () => new World({ w: 1280, h: 720 }, { hazards: false, rng: mulberry32(1) });
const shipAt = (world: World, x: number, y: number) =>
  world.addPlayer("target", { remote: true, slot: 0, at: { x, y } });
const bulletAt = (world: World, x: number, y: number, vx = 0, vy = 0) =>
  world.spawn(new Bullet(x, y, new Vector2(vx, vy)));

describe("findCollisions", () => {
  test("overlapping circles collide", () => {
    const w = arena();
    shipAt(w, 100, 100);
    bulletAt(w, 105, 100);
    expect(findCollisions(w)).toHaveLength(1);
  });

  test("circles exactly touching count as a hit (<=), a hair further apart do not", () => {
    const touching = arena();
    shipAt(touching, 100, 100);
    bulletAt(touching, 100 + REACH, 100);
    expect(findCollisions(touching)).toHaveLength(1);

    const apart = arena();
    shipAt(apart, 100, 100);
    bulletAt(apart, 100 + REACH + 0.001, 100);
    expect(findCollisions(apart)).toHaveLength(0);
  });

  test("distant entities never collide", () => {
    const w = arena();
    shipAt(w, 100, 100);
    bulletAt(w, 900, 600);
    expect(findCollisions(w)).toEqual([]);
  });

  test("dead entities and non-collidable ones (explosions) are skipped", () => {
    const w = arena();
    shipAt(w, 100, 100);
    const dead = bulletAt(w, 102, 100);
    dead.alive = false;
    w.spawn(new Explosion(100, 100, mulberry32(3)));
    expect(findCollisions(w)).toEqual([]);
  });

  test("an empty world has no collisions", () => {
    expect(findCollisions(arena())).toEqual([]);
  });

  test("each colliding pair is reported once", () => {
    const w = arena();
    shipAt(w, 100, 100);
    bulletAt(w, 104, 100);
    bulletAt(w, 96, 100);
    expect(findCollisions(w)).toHaveLength(2);
  });
});

describe("fast bullets and tunneling (collisions are checked once per step)", () => {
  // A ship is 2 * (12 + 3) = 30 px "thick" to a bullet. At 30 Hz the sim only looks at positions at the
  // end of each step, so a bullet that moves more than 30 px in one step can jump over a ship.
  const crossShip = (speed: number): { hit: boolean; passedShip: boolean } => {
    const w = arena();
    const ship = shipAt(w, 400, 300);
    // Start at x = 325 so the 50 px steps land at 375 and 425: 25 px either side of the ship, outside the
    // 15 px reach. (Run only a few steps: after ~900 px the bullet would wrap around the arena.)
    const bullet = bulletAt(w, 325, 300, speed, 0);
    for (let i = 0; i < 8 && bullet.alive; i++) w.step(DT);
    return { hit: !bullet.alive, passedShip: bullet.pos.x > ship.pos.x };
  };

  test("a normal bullet (600 px/s = 20 px per step) cannot skip a ship", () => {
    expect(crossShip(600).hit).toBe(true);
  });

  test("a bullet faster than one ship-thickness per step tunnels straight through (known limitation)", () => {
    // 1500 px/s = 50 px per step > 30 px. If you ever add swept collision, this test should flip.
    const r = crossShip(1500);
    expect(r.hit).toBe(false);
    expect(r.passedShip).toBe(true);
  });
});
