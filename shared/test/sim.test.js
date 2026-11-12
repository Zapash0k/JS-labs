import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32 } from "../src/prng.js";
import { runScenario } from "../src/sim/scenario.js";
import { Ship } from "../src/sim/ship.js";
import { World } from "../src/sim/world.js";
import { createShipState, stepShipState } from "../src/sim/shipPhysics.js";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const sourceFiles = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".js") ? [p] : [];
  });

test("the shared code imports in plain Node: no DOM, no Node built-ins, no randomness, no clocks", async () => {
  for (const file of sourceFiles(root)) {
    const src = readFileSync(file, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(
      src,
      /\b(document|window|canvas|localStorage|requestAnimationFrame|navigator)\b/,
      file,
    );
    assert.doesNotMatch(src, /from\s+["']node:/, file);
    assert.doesNotMatch(
      src,
      /\bMath\.random\b|\bDate\.now\b|\bperformance\.now\b|\brequire\(/,
      file,
    );
    await import(file); // would throw on a DOM global at import time
  }
});

test("mulberry32: same seed, same sequence; different seed, different", () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const seqA = Array.from({ length: 5 }, a);
  assert.deepEqual(seqA, Array.from({ length: 5 }, b));
  assert.notDeepEqual(seqA, Array.from({ length: 5 }, mulberry32(8)));
  assert.ok(seqA.every((x) => x >= 0 && x < 1));
});

test("determinism: the same scripted match gives the same hash every time, and it matches the golden value", () => {
  const h1 = runScenario({ seed: 42, ticks: 1000 });
  const h2 = runScenario({ seed: 42, ticks: 1000 });
  assert.equal(h1, h2);
  assert.notEqual(runScenario({ seed: 43, ticks: 1000 }), h1);
  // Golden value: compare it with the browser (/?hashcheck=1). If you change the sim on purpose, update it.
  assert.equal(h1, GOLDEN);
});

test("a single Math.random() in the step breaks determinism", () => {
  const a = runScenario({ seed: 42, ticks: 300, noise: Math.random });
  const b = runScenario({ seed: 42, ticks: 300, noise: Math.random });
  assert.notEqual(a, b);
});

test("shipPhysics.stepShipState is exactly what the server's Ship does (prediction depends on this)", () => {
  const size = { w: 1280, h: 720 };
  const world = new World(size, { hazards: false, rng: mulberry32(1) });
  const ship = world.addPlayer("a", { remote: true, slot: 0, at: { x: 300, y: 200 } });
  const state = createShipState(300, 200);
  const rnd = mulberry32(99);
  for (let i = 1; i <= 2000; i++) {
    const cmd = { seq: i, thrust: rnd() < 0.6, turn: Math.floor(rnd() * 3) - 1, fire: rnd() < 0.2 };
    world.setCommand("a", cmd);
    world.step(1 / 30);
    stepShipState(state, cmd, 1 / 30, size.w, size.h);
    assert.deepEqual(ship.toState(), state, `diverged at step ${i}`);
  }
  assert.ok(ship instanceof Ship);
});

test("a remote ship with no command does not advance (stall), the rest of the world does", () => {
  const world = new World({ w: 800, h: 600 }, { hazards: false, rng: mulberry32(1) });
  const a = world.addPlayer("a", { remote: true, slot: 0, at: { x: 100, y: 100 } });
  const b = world.addPlayer("b", { remote: true, slot: 1, at: { x: 500, y: 300 } });
  world.setCommand("a", { seq: 1, thrust: true, turn: 0, fire: false });
  world.setCommand("b", null);
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.ok(a.pos.x > 100);
  assert.deepEqual([b.pos.x, b.pos.y], [500, 300]);
});

test("a player that dies respawns after 2 s, and the kill is scored for the shooter", () => {
  const world = new World({ w: 800, h: 600 }, { hazards: false, rng: mulberry32(5) });
  const a = world.addPlayer("a", { remote: true, slot: 0, at: { x: 100, y: 300 } });
  const b = world.addPlayer("b", { remote: true, slot: 1, at: { x: 300, y: 300 } });
  a.angle = 0; // faces b
  const fire = { seq: 0, thrust: false, turn: 0, fire: true };
  for (let i = 0; i < 300 && b.alive; i++) {
    world.setCommand("a", { ...fire, seq: i });
    world.setCommand("b", { seq: i, thrust: false, turn: 0, fire: false });
    world.step(1 / 30);
  }
  assert.equal(b.alive, false);
  assert.ok(world.players.get("a").score >= 100);
  for (let i = 0; i < 70; i++) world.step(1 / 30); // > 2 s
  assert.equal(world.players.get("b").ship.alive, true);
});

const GOLDEN = "18cf1134";
