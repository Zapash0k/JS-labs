/**
 * Fixed-timestep game loop (Fiedler, "Fix Your Timestep!").
 *
 * Options beyond the lab spec exist only for the M4 experiments:
 *   mode:  "raf" (default) | "interval"  -> experiment 2
 *   fixed: true (default)  | false       -> experiment 3 (variable timestep)
 */
export function createLoop({ step = 1 / 60, simulate, render, mode = "raf", fixed = true }) {
  const stats = {
    stepsPerSec: 0,
    fps: 0,
    frameMs: 0,
    jitterMs: 0,
    simTime: 0,
    mode,
    fixed,
  };

  let accumulator = 0;
  let last = null;
  let running = false;
  let handle = 0;
  let steps = 0;
  let frames = 0;
  let windowStart = 0;
  let samples = [];

  function frame(now) {
    if (!running) return;
    if (last === null) {
      last = now;
      windowStart = now;
    }
    const deltaMs = now - last;
    last = now;
    stats.frameMs = deltaMs;
    samples.push(deltaMs);

    let alpha = 1;
    if (fixed) {
      accumulator += Math.min(deltaMs / 1000, 0.25); // clamp: no spiral of death
      while (accumulator >= step) {
        simulate(step);
        stats.simTime += step;
        accumulator -= step;
        steps++;
      }
      alpha = accumulator / step;
    } else {
      const dt = deltaMs / 1000; // variable timestep, deliberately naive
      simulate(dt);
      stats.simTime += dt;
      steps++;
    }

    frames++;
    render(alpha, stats);

    if (now - windowStart >= 1000) {
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
      stats.stepsPerSec = steps;
      stats.fps = frames;
      stats.jitterMs = Math.sqrt(variance);
      steps = 0;
      frames = 0;
      samples = [];
      windowStart = now;
    }

    if (mode === "raf") handle = requestAnimationFrame(frame);
  }

  return {
    stats,
    start() {
      running = true;
      last = null;
      if (mode === "interval") {
        handle = setInterval(() => frame(performance.now()), 16);
      } else {
        handle = requestAnimationFrame(frame);
      }
    },
    stop() {
      running = false;
      if (mode === "interval") clearInterval(handle);
      else cancelAnimationFrame(handle);
    },
  };
}
