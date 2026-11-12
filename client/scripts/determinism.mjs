// Offline illustration of experiment 3: variable vs fixed timestep under different frame rates.
// Uses the real sim modules (no DOM). The browser experiment (DevTools CPU 6x throttling)
// is the one to report; this script just shows the same effect reproducibly.
import { createShip, integrate } from "../src/sim/ship.js";
import { wrap } from "../src/sim/arena.js";

const W = 1920;
const H = 1080;
const held = { isDown: (c) => c === "ArrowUp", justPressed: () => false, endStep() {} };

function runVariable(frameMs, seconds = 5) {
  const ship = createShip(W / 2, H / 2);
  const dt = frameMs / 1000;
  let t = 0;
  while (t < seconds - 1e-9) {
    integrate(ship, held, dt);
    wrap(ship, W, H);
    t += dt;
  }
  return ship;
}

function runFixed(frameMs, seconds = 5) {
  const STEP = 1 / 60;
  const ship = createShip(W / 2, H / 2);
  let acc = 0;
  let simSteps = 0;
  const frames = Math.ceil((seconds * 1000) / frameMs) + 1;
  for (let f = 0; f < frames; f++) {
    acc += Math.min(frameMs / 1000, 0.25);
    while (acc >= STEP - 1e-12 && simSteps < seconds * 60) {
      integrate(ship, held, STEP);
      wrap(ship, W, H);
      acc -= STEP;
      simSteps++;
    }
  }
  return { ship, simSteps };
}

const fmt = (s) => `x=${s.pos.x.toFixed(3)} y=${s.pos.y.toFixed(3)}`;

console.log("Holding thrust for 5 s of simulated time, arena 1920x1080\n");
console.log("VARIABLE timestep (simulate(dt) once per frame):");
for (const ms of [8.33, 16.67, 50, 100]) {
  console.log(`  frame ${String(ms).padEnd(6)} ms -> ${fmt(runVariable(ms))}`);
}
console.log("\nFIXED timestep (accumulator, 1/60 s):");
for (const ms of [8.33, 16.67, 50, 100]) {
  const { ship, simSteps } = runFixed(ms);
  console.log(`  frame ${String(ms).padEnd(6)} ms -> ${fmt(ship)}  (${simSteps} steps)`);
}
