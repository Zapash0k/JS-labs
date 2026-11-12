// M4 experiment: what a 300 ms synchronous handler does to every other client.
//   node scripts/block-demo.mjs [blockMs=300] [rounds=6]
// Two chat clients in one room; one sends a message every 150 ms and measures how long it takes
// to arrive at the other. Meanwhile (phase 2) a third client calls /api/slow?ms=300 repeatedly.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const blockMs = Number(process.argv[2]) || 300;
const rounds = Number(process.argv[3]) || 6;
const here = fileURLToPath(new URL(".", import.meta.url));
const port = 3900 + Math.floor(Math.random() * 90);
const dir = await mkdtemp(join(tmpdir(), "block-"));
const server = spawn(process.execPath, [join(here, "../src/index.js")], {
  env: { ...process.env, PORT: String(port), LOG_DIR: dir, DEMO_ENDPOINTS: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.once("data", resolve));

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on("error", () => {});
  return new Promise((resolve) =>
    ws.once("open", () => {
      ws.send(JSON.stringify({ v: 1, type: "join", room: "open-space", name }));
      ws.once("message", () => resolve(ws)); // "joined"
    }),
  );
}
const sender = await client("Sender");
const receiver = await client("Receiver");

const sentAt = new Map();
const latencies = []; // [phase, ms]
let phase = "idle";
receiver.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.type === "chat" && sentAt.has(msg.text))
    latencies.push([phase, performance.now() - sentAt.get(msg.text)]);
});
let n = 0;
const chatTimer = setInterval(() => {
  const text = `m${n++}`;
  sentAt.set(text, performance.now());
  sender.send(JSON.stringify({ v: 1, type: "chat", text }));
}, 150);

await sleep(1500); // phase 1: idle server
phase = "blocked";
for (let i = 0; i < rounds; i++) {
  await fetch(`http://127.0.0.1:${port}/api/slow?ms=${blockMs}`); // event loop is busy for blockMs
  await sleep(100);
}
phase = "idle-again";
await sleep(800);
clearInterval(chatTimer);

const stat = (p) => {
  const xs = latencies
    .filter(([q]) => q === p)
    .map(([, ms]) => ms)
    .sort((a, b) => a - b);
  return `${p.padEnd(10)} n=${String(xs.length).padStart(2)}  median ${xs[Math.floor(xs.length / 2)].toFixed(1)} ms  max ${xs.at(-1).toFixed(1)} ms`;
};
console.log(
  `chat latency Sender -> Receiver, /api/slow blocks the event loop for ${blockMs} ms x ${rounds}`,
);
for (const p of ["idle", "blocked", "idle-again"]) console.log(stat(p));
for (const ws of [sender, receiver]) ws.close();
server.kill("SIGTERM");
await new Promise((resolve) => server.once("exit", resolve));
await rm(dir, { recursive: true, force: true });
