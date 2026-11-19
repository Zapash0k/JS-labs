import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLoop } from "../src/loop.js";

const STEP = 1 / 60;

describe("createLoop (fixed timestep, driven by hand-fed frame times)", () => {
  let queue;
  beforeEach(() => {
    queue = [];
    vi.stubGlobal("requestAnimationFrame", (cb) => queue.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => (queue.length = 0));
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Runs one animation frame at timestamp `t` (ms). */
  const frame = (t) => queue.splice(0).forEach((cb) => cb(t));
  const setup = (opts = {}) => {
    const simulate = vi.fn();
    const render = vi.fn();
    const loop = createLoop({ step: STEP, simulate, render, ...opts });
    loop.start();
    frame(1000); // the first frame only sets the clock
    return { loop, simulate, render };
  };

  test("the first frame renders but simulates nothing (it only starts the clock)", () => {
    const { simulate, render } = setup();
    expect(simulate).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
  });

  test("simulates in whole fixed steps and passes the left-over to render as alpha", () => {
    const { simulate, render } = setup();
    frame(1040); // 40 ms = 2 steps of 16.67 ms + 6.67 ms left over
    expect(simulate).toHaveBeenCalledTimes(2);
    for (const [dt] of simulate.mock.calls) expect(dt).toBe(STEP);
    const [alpha] = render.mock.lastCall;
    expect(alpha).toBeCloseTo(0.4, 5);
  });

  test("a frame shorter than one step simulates nothing, and the time is not lost", () => {
    const { simulate } = setup();
    frame(1010); // 10 ms
    expect(simulate).not.toHaveBeenCalled();
    frame(1020); // another 10 ms: 20 ms total, one step
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  test("a long stall is clamped to 0.25 s: no spiral of death", () => {
    const { simulate } = setup();
    frame(1000 + 5000); // a 5 s hiccup (tab in the background)
    expect(simulate.mock.calls.length).toBeLessThanOrEqual(15);
    expect(simulate.mock.calls.length).toBeGreaterThanOrEqual(14);
  });

  test("simTime advances by exactly the simulated steps", () => {
    const { loop } = setup();
    frame(1100);
    frame(1200);
    expect(loop.stats.simTime).toBeCloseTo(STEP * Math.round(loop.stats.simTime / STEP), 9);
  });

  test("fixed: false is the naive variable timestep: one simulate per frame, dt = frame time", () => {
    const { simulate } = setup({ fixed: false });
    simulate.mockClear(); // the very first frame also calls simulate (with dt = 0)
    frame(1033);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(simulate.mock.lastCall[0]).toBeCloseTo(0.033, 9);
  });

  test("stop() ends the loop: queued frames do nothing", () => {
    const { loop, simulate } = setup();
    loop.stop();
    frame(2000);
    expect(simulate).not.toHaveBeenCalled();
  });

  test("stats: after a second of 60 Hz frames, fps and steps per second are about 60", () => {
    const { loop } = setup();
    for (let i = 1; i <= 61; i++) frame(1000 + (i * 1000) / 60);
    expect(loop.stats.fps).toBeGreaterThanOrEqual(59);
    expect(loop.stats.fps).toBeLessThanOrEqual(61);
    expect(loop.stats.stepsPerSec).toBeGreaterThanOrEqual(59);
    expect(loop.stats.stepsPerSec).toBeLessThanOrEqual(61);
  });
});

describe("createLoop in interval mode (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a 16 ms interval drives about 60 simulation steps per second", () => {
    const simulate = vi.fn();
    const loop = createLoop({ step: STEP, simulate, render: () => {}, mode: "interval" });
    loop.start();
    vi.advanceTimersByTime(2000);
    loop.stop();
    expect(simulate.mock.calls.length).toBeGreaterThanOrEqual(115);
    expect(simulate.mock.calls.length).toBeLessThanOrEqual(125);
  });

  test("stop() clears the interval for good", () => {
    const simulate = vi.fn();
    const loop = createLoop({ step: STEP, simulate, render: () => {}, mode: "interval" });
    loop.start();
    vi.advanceTimersByTime(100);
    loop.stop();
    const before = simulate.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(simulate.mock.calls.length).toBe(before);
  });
});
