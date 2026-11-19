import { describe, expect, test } from "vitest";
import { wrapCoord } from "../src/sim/arena.ts";
import {
  ACCEL,
  MAX_SPEED,
  NO_COMMAND,
  TURN_RATE,
  createShipState,
  stepShipState,
} from "../src/sim/shipPhysics.ts";
import type { ShipCommand } from "../src/sim/shipPhysics.ts";

const DT = 1 / 30;
const cmd = (over: Partial<ShipCommand> = {}): ShipCommand => ({ ...NO_COMMAND, ...over });

describe("wrapCoord", () => {
  test("values already inside [0, max) come back untouched (exactly, not re-rounded)", () => {
    for (const v of [0, 0.1, 99.99999999999999, 12.3456789]) expect(wrapCoord(v, 100)).toBe(v);
  });

  test("wraps around both edges", () => {
    expect(wrapCoord(100, 100)).toBe(0);
    expect(wrapCoord(250, 100)).toBe(50);
    expect(wrapCoord(-1, 100)).toBe(99);
    expect(wrapCoord(-250, 100)).toBe(50);
  });
});

describe("stepShipState (the one place a ship moves)", () => {
  test("thrust accelerates along the ship's angle", () => {
    const s = createShipState(100, 100); // angle 0 = pointing right
    stepShipState(s, cmd({ thrust: true }), DT);
    expect(s.vx).toBeGreaterThan(0);
    expect(s.vy).toBe(0);
    expect(s.vx).toBeLessThanOrEqual(ACCEL * DT);
    expect(s.thrust).toBe(true);
  });

  test("turning changes the angle by TURN_RATE * dt, in the requested direction", () => {
    const s = createShipState();
    stepShipState(s, cmd({ turn: 1 }), DT);
    expect(s.angle).toBeCloseTo(TURN_RATE * DT, 12);
    stepShipState(s, cmd({ turn: -1 }), DT);
    expect(s.angle).toBeCloseTo(0, 12);
  });

  test("without thrust, drag slows the ship but never reverses it", () => {
    const s = createShipState();
    s.vx = 200;
    let last = s.vx;
    for (let i = 0; i < 300; i++) {
      stepShipState(s, NO_COMMAND, DT);
      expect(s.vx).toBeLessThanOrEqual(last);
      expect(s.vx).toBeGreaterThanOrEqual(0);
      last = s.vx;
    }
    expect(s.vx).toBeLessThan(1);
  });

  test("speed is capped at MAX_SPEED no matter how long you hold thrust", () => {
    const s = createShipState();
    for (let i = 0; i < 600; i++) stepShipState(s, cmd({ thrust: true }), DT);
    expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(MAX_SPEED + 1e-9);
  });

  test("the ship wraps at the arena edge, and w/h = 0 turns wrapping off", () => {
    const wrapped = createShipState(99, 50);
    wrapped.vx = 300;
    stepShipState(wrapped, NO_COMMAND, DT, 100, 100);
    expect(wrapped.x).toBeGreaterThanOrEqual(0);
    expect(wrapped.x).toBeLessThan(100);

    const free = createShipState(99, 50);
    free.vx = 300;
    stepShipState(free, NO_COMMAND, DT); // no arena given
    expect(free.x).toBeGreaterThan(100);
  });

  test("firing respects the cooldown: one bullet, then silence until it expires", () => {
    const s = createShipState(10, 10);
    const first = stepShipState(s, cmd({ fire: true }), DT);
    expect(first).not.toBeNull();
    expect(first?.vx).toBeGreaterThan(0);
    // 0.25 s cooldown at 30 Hz is about 7.5 steps
    for (let i = 0; i < 6; i++) expect(stepShipState(s, cmd({ fire: true }), DT)).toBeNull();
    let fired = false;
    for (let i = 0; i < 3 && !fired; i++)
      fired = stepShipState(s, cmd({ fire: true }), DT) !== null;
    expect(fired).toBe(true);
  });

  test("rapid fire shortens the cooldown", () => {
    const normal = createShipState();
    const rapid = createShipState();
    rapid.rapid = 10;
    const count = (s: typeof normal): number => {
      let n = 0;
      for (let i = 0; i < 60; i++) if (stepShipState(s, cmd({ fire: true }), DT)) n++;
      return n;
    };
    expect(count(rapid)).toBeGreaterThan(count(normal));
  });

  test("timers (invulnerability, shield) count down and stop at zero", () => {
    const s = createShipState();
    s.invuln = 0.1;
    s.shield = 0.1;
    for (let i = 0; i < 10; i++) stepShipState(s, NO_COMMAND, DT);
    expect([s.invuln, s.shield]).toEqual([0, 0]);
  });

  test("it is a pure function of (state, command): same inputs, bit-identical outputs", () => {
    const a = createShipState(5, 5);
    const b = createShipState(5, 5);
    for (let i = 0; i < 500; i++) {
      const c = cmd({ thrust: i % 3 !== 0, turn: (i % 3) - 1, fire: i % 7 === 0 });
      stepShipState(a, c, DT, 1280, 720);
      stepShipState(b, c, DT, 1280, 720);
    }
    expect(a).toEqual(b);
  });
});
