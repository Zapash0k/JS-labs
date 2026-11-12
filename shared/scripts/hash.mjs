// npm run hash -w shared  ->  the determinism hash of the scripted match. Open /?hashcheck=1 in the
// browser and compare the console line: equal hashes = bit-identical simulation.
import { runScenario } from "../src/sim/scenario.js";

const seed = Number(process.argv[2] ?? 42);
const ticks = Number(process.argv[3] ?? 1000);
console.log(`[hashcheck] seed=${seed} ticks=${ticks} -> ${runScenario({ seed, ticks })}`);
