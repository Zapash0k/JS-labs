// M4: JSON vs binary on REAL snapshots. Runs the server's Match (real World, real snapshot builder)
// with N scripted players for 20 simulated seconds and counts the bytes each client would receive.
//   node scripts/codec-bench.mjs
import { codecs } from "@dogfight/shared/codec/index.js";
import { mulberry32 } from "@dogfight/shared/prng.js";
import { TICK_HZ } from "@dogfight/shared/protocol.js";
import { Match } from "../src/match.js";
import { Room } from "../src/rooms.js";

const SECONDS = 20;

function run(codecName, players, asteroids) {
  const room = new Room({ id: "bench", maxPlayers: 8, arena: { asteroids, pickups: true } });
  const match = new Match({ room, now: () => 0, log: console });
  const codec = codecs[codecName];
  const script = mulberry32(7);
  const sent = { bytes: 0, snapshots: 0, entities: 0, decodeMs: 0 };
  const ps = [];
  for (let i = 0; i < players; i++) {
    const p = {
      id: `p${i}`,
      codec: codecName,
      send(data) {
        sent.bytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        sent.snapshots++;
        if (i === 0) {
          const a = performance.now(); // what the client pays to read it
          const snap = codec.decodeSnapshot(data);
          sent.decodeMs += performance.now() - a;
          sent.entities += snap.entities.length;
        }
      },
    };
    match.addPlayer(p);
    ps.push(p);
  }
  match.stop(); // we drive tick() ourselves
  let tickMs = 0;
  for (let tick = 1; tick <= SECONDS * TICK_HZ; tick++) {
    for (const p of ps)
      match.receiveInput(p.id, {
        seq: tick,
        tick: 0,
        thrust: script() < 0.7,
        turn: Math.floor(script() * 3) - 1,
        fire: script() < 0.35,
      });
    const a = performance.now();
    match.tick();
    tickMs += performance.now() - a;
  }
  const ticks = SECONDS * TICK_HZ;
  return {
    perSnapshot: sent.bytes / sent.snapshots,
    perClientPerSec: sent.bytes / players / SECONDS,
    avgEntities: sent.entities / ticks,
    decodeUs: (sent.decodeMs / ticks) * 1000,
    tickMs: tickMs / ticks,
  };
}

const row = (label, r) =>
  `| ${label.padEnd(24)} | ${r.avgEntities.toFixed(1).padStart(8)} | ${r.perSnapshot.toFixed(0).padStart(10)} | ${(r.perClientPerSec / 1024).toFixed(2).padStart(11)} | ${r.decodeUs.toFixed(1).padStart(9)} | ${r.tickMs.toFixed(3).padStart(7)} |`;
console.log(
  "| codec / scenario         | entities | B/snapshot | KB/s/client | decode us | tick ms |",
);
console.log(
  "| ------------------------ | -------- | ---------- | ----------- | --------- | ------- |",
);
for (const [players, asteroids] of [
  [2, 0],
  [4, 6],
  [8, 12],
]) {
  const j = run("json", players, asteroids);
  const b = run("binary", players, asteroids);
  console.log(row(`json,   ${players} players, ${asteroids} ast`, j));
  console.log(row(`binary, ${players} players, ${asteroids} ast`, b));
  console.log(`(binary is ${(j.perSnapshot / b.perSnapshot).toFixed(1)}x smaller per snapshot)`);
}
const up = {
  json: JSON.stringify({
    v: 1,
    type: "input",
    seq: 123456,
    tick: 98765,
    thrust: true,
    turn: -1,
    fire: false,
  }),
  binary: new Uint8Array(12),
};
console.log(
  `\nclient -> server input: json ${Buffer.byteLength(up.json)} bytes, binary ${up.binary.byteLength} bytes (x ${TICK_HZ}/s)`,
);
