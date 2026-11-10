// Headless checks for the Lab 02 sim (no DOM). Run: npm run smoke
import assert from "node:assert/strict";
import { Vector2 } from "../src/sim/vector.js";
import { Entity } from "../src/sim/entity.js";
import { Ship } from "../src/sim/ship.js";
import { Bullet } from "../src/sim/bullet.js";
import { Asteroid } from "../src/sim/asteroid.js";
import { Pickup } from "../src/sim/pickup.js";
import { World } from "../src/sim/world.js";
import { homing } from "../src/sim/behaviors.js";

const none = { isDown: () => false, justPressed: () => false, endStep() {} };
const fireKey = { ...none, isDown: (c) => c === "Space" };
const size = { w: 800, h: 600 };
let seed = 1;
const rng = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const mk = () => new World(size, { hazards: false, rng });

// Vector2 is pure
const a = new Vector2(1, 2);
a.add(new Vector2(5, 5));
assert.deepEqual([a.x, a.y], [1, 2]);

// one-level inheritance only
for (const C of [Ship, Bullet, Asteroid, Pickup]) {
  assert.equal(Object.getPrototypeOf(C), Entity);
}

// private #hp
const ship = new Ship(0, 0);
assert.equal(ship.hp, 100);
assert.equal(Object.keys(ship).includes("hp"), false);

// World: Map-based, iterable, ofKind generator, deferred sweep
let w = mk();
w.start();
const b = w.player.fire();
assert.ok(b instanceof Bullet);
w.step(1 / 60, none);
assert.equal([...w.ofKind("bullet")].length, 1);
w.despawn(b.id);
assert.ok(w.get(b.id)); // still there until the sweep
w.step(1 / 60, none);
assert.equal(w.get(b.id), undefined);

// `this` bug is caught
assert.throws(() => w.player.fire.call({}), TypeError);

// Shooting an asteroid: damage, explosion, score
w = mk();
w.start();
w.spawn(new Asteroid(w.player.pos.x + 80, w.player.pos.y, new Vector2(), rng));
w.player.angle = 0;
for (let i = 0; i < 90; i++) w.step(1 / 60, fireKey);
assert.equal([...w.ofKind("asteroid")].length, 0);
assert.ok(w.score >= 100);

// Ship hit -> damage + i-frames; destroyed -> explosion + respawn after 2 s
w = mk();
w.start();
w.spawn(new Asteroid(w.player.pos.x, w.player.pos.y, new Vector2(), rng));
w.step(1 / 60, none);
assert.equal(w.player.hp, 75);
w.player.takeDamage(0); // blocked by invulnerability
assert.equal(w.player.hp, 75);
const first = w.player;
for (let i = 0; i < 200; i++) {
  if (w.player.invuln <= 0)
    w.spawn(new Asteroid(w.player.pos.x, w.player.pos.y, new Vector2(), rng));
  w.step(1 / 60, none);
  if (!first.alive) break;
}
assert.ok(!first.alive);
assert.equal([...w.ofKind("explosion")].length > 0, true);
for (let i = 0; i < 130; i++) w.step(1 / 60, none);
assert.ok(w.player.alive && w.player !== first);

// Pickup grants an effect and disappears
w = mk();
w.start();
w.spawn(new Pickup(w.player.pos.x, w.player.pos.y, "shield"));
w.step(1 / 60, none);
assert.ok(w.player.shield > 0);
assert.equal([...w.ofKind("pickup")].length, 0);

// Composition: the same homing behavior on a bullet and on an asteroid
w = mk();
w.start();
const target = w.spawn(new Asteroid(500, 100, new Vector2(), rng));
const hb = new Bullet(100, 100, new Vector2(0, 100), null);
hb.behaviors.push(homing({ seek: "asteroid", turnRate: 4 }));
w.spawn(hb);
const hunter = new Asteroid(700, 500, new Vector2(0, -60), rng);
hunter.behaviors.push(homing({ seek: "ship", turnRate: 2 }));
w.spawn(hunter);
for (let i = 0; i < 30; i++) w.step(1 / 60, none);
assert.ok(hb.vel.x > 0, "homing bullet turned toward the asteroid");
assert.ok(hunter.vel.x < 0, "homing asteroid turned toward the ship");
assert.ok(target.alive);

console.log("smoke: all checks passed");
