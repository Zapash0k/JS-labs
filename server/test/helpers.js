import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const quiet = { log() {}, warn() {}, error() {}, info() {} };

/** Starts the real app on a random port with a temp log dir and a tiny fake client build. */
export async function startServer(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dogfight-test-"));
  const staticDir = join(dir, "dist");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  await writeFile(join(staticDir, "assets", "a.js"), "export {}");
  await writeFile(join(dir, "secret.txt"), "top secret"); // outside staticDir: must never be served
  const config = loadConfig({
    PORT: "0",
    LOG_DIR: join(dir, "logs"),
    STATIC_DIR: staticDir,
    ...env,
  });
  const app = createApp(config, { log: quiet });
  const { port } = await app.listen();
  return {
    app,
    config,
    dir,
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: () => app.close(),
  };
}

/** WebSocket client that records messages and lets a test wait for a specific one. */
export function connect(url, opts) {
  const ws = new WebSocket(url, opts);
  ws.inbox = [];
  const waiters = [];
  ws.snapshots = []; // binary frames (game snapshots) are kept apart from the JSON control messages
  ws.on("message", (data, isBinary) => {
    if (isBinary) return ws.snapshots.push(data);
    const msg = JSON.parse(data.toString());
    ws.inbox.push(msg);
    for (const w of [...waiters])
      if (w.test(msg)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(msg));
  });
  ws.on("error", () => {});
  ws.opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.closed = new Promise((resolve) =>
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  ws.waitFor = (predicate, ms = 2000) => {
    const hit = ws.inbox.find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
      waiters.push({ test: predicate, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  };
  ws.sendJson = (obj) => ws.send(JSON.stringify({ v: 1, ...obj }));
  return ws;
}

export async function joinRoom(wsUrl, room, name) {
  const ws = connect(wsUrl);
  await ws.opened;
  ws.sendJson({ type: "join", room, name });
  await ws.waitFor((m) => m.type === "joined");
  return ws;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
