// M4: what /api/stats says about the 30 Hz loop with N bots in one room.
//   node scripts/tick-stats-demo.mjs [bots=4] [seconds=10]
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { TICK_DT } from "@dogfight/shared/protocol.js";
import { Connection } from "../../client/src/net/connection.js";
import { NetGame } from "../../client/src/net/netgame.js";
import { once } from "../../client/src/events.js";

const bots = Number(process.argv[2]) || 4;
const seconds = Number(process.argv[3]) || 10;
const port = 3600 + Math.floor(Math.random() * 300);
const here = fileURLToPath(new URL(".", import.meta.url));
const server = spawn(process.execPath, [join(here, "../src/index.js")], { env: { ...process.env, PORT: String(port), LOG_DIR: "/tmp/tick-demo-logs" }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => server.stdout.once("data", r));

const keys = (t, i) => ({ isDown: (c) => c === "ArrowUp" || c === (t % 90 < 45 ? "ArrowRight" : "ArrowLeft") || (c === "Space" && (t + i) % 20 < 3) });
const clients = [];
for (let i = 0; i < bots; i++) {
  const conn = new Connection({ url: `ws://127.0.0.1:${port}/ws?rtt=60&jitter=20`, hello: () => ({ type: "join", room: "open-space", name: `Bot${i}`, codec: "binary" }) });
  const joined = once(conn, "message:joined");
  conn.open();
  const { detail } = await joined;
  clients.push({ conn, net: new NetGame({ conn, slot: detail.you.slot }) });
}
for (let t = 0; t < seconds * 30; t++) {
  clients.forEach(({ net }, i) => (net.step(TICK_DT, keys(t, i)), net.update(TICK_DT)));
  await sleep(33);
}
const stats = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
console.log(JSON.stringify(stats.matches[0], null, 2));
console.log(`server RSS ${(stats.rss / 1048576).toFixed(0)} MB`);
clients.forEach(({ conn }) => conn.close());
server.kill("SIGTERM");
