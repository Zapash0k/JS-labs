// Headless checks for the Lab 03 asset pipeline, event decoupling and lobby. Run: npm run smoke
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HttpError,
  JsonError,
  LoadError,
  fetchJson,
  loadAll,
  withRetry,
} from "../src/assets/loader.js";
import { injectFailure } from "../src/assets/failures.js";
import { Lobby } from "../src/lobby/lobby.js";
import { once } from "../src/events.js";
import { World } from "@dogfight/shared/sim/world.js";
import { Asteroid } from "@dogfight/shared/sim/asteroid.js";
import { Vector2 } from "@dogfight/shared/sim/vector.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noWait = () => Promise.resolve();

// ---- withRetry: backoff + jitter, 5xx/network retried, 4xx/JSON/abort never ----
{
  let calls = 0;
  const delays = [];
  const value = await withRetry(
    async () => {
      if (++calls < 3) throw new HttpError(503, "/x");
      return "ok";
    },
    { attempts: 3, baseMs: 100, random: () => 1, wait: async (ms) => delays.push(ms) },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200], "exponential: base * 2^(n-1), jitter factor 1");

  for (const err of [
    new HttpError(404, "/x"),
    new HttpError(400, "/x"),
    new JsonError("/x", null),
  ]) {
    calls = 0;
    await assert.rejects(
      withRetry(async () => (calls++, Promise.reject(err)), { wait: noWait }),
      err.constructor,
    );
    assert.equal(calls, 1, `${err.name} ${err.status ?? ""} must not be retried`);
  }

  calls = 0;
  await assert.rejects(
    withRetry(async () => (calls++, Promise.reject(new TypeError("network"))), {
      attempts: 4,
      wait: noWait,
    }),
    TypeError,
  );
  assert.equal(calls, 4, "network errors use all attempts");

  const c = new AbortController();
  calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        c.abort();
        throw new HttpError(503, "/x");
      },
      { signal: c.signal, wait: noWait },
    ),
  );
  assert.equal(calls, 1, "aborted -> no further attempts");

  const jitter = [];
  await withRetry(async (n) => (n < 3 ? Promise.reject(new TypeError("n")) : 1), {
    baseMs: 100,
    wait: async (ms) => jitter.push(ms),
  });
  assert.ok(jitter[0] >= 0 && jitter[0] <= 100 && jitter[1] >= 0 && jitter[1] <= 200);
}

// ---- fetchJson: 404 is a fulfilled fetch -> HttpError; truncated body -> JsonError ----
{
  const realFetch = globalThis.fetch;
  const reply =
    (body, status = 200) =>
    async () =>
      new Response(body, { status });
  try {
    globalThis.fetch = reply('{"a":1}');
    assert.deepEqual(await fetchJson("/ok"), { a: 1 });
    globalThis.fetch = reply("nope", 404);
    await assert.rejects(fetchJson("/missing"), (e) => e instanceof HttpError && e.status === 404);
    globalThis.fetch = reply('{"broken": [1,');
    await assert.rejects(fetchJson("/corrupt"), JsonError);
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(fetchJson("/offline"), TypeError);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- loadAll: concurrent vs sequential, progress, optional vs critical failures ----
{
  const manifest = {
    assets: Array.from({ length: 5 }, (_, i) => ({ key: `a${i}`, type: "json", url: `/a${i}` })),
  };
  const slow = async (url) => (await sleep(60), { url });
  const progress = [];
  const conc = await loadAll(manifest, {
    loaders: { json: slow },
    onProgress: (done, total) => progress.push([done, total]),
  });
  const seq = await loadAll(manifest, { loaders: { json: slow }, sequential: true });
  assert.ok(conc.ms < 180, `concurrent took ${conc.ms}`);
  assert.ok(seq.ms >= 290, `sequential took ${seq.ms}`);
  assert.deepEqual(
    progress.map((p) => p[0]),
    [1, 2, 3, 4, 5],
  );
  assert.equal(Object.keys(conc.json).length, 5);

  // a failing optional asset does not block the game
  const optional = await loadAll(injectFailure(manifest, "404"), {
    attempts: 1,
    loaders: {
      json: slow,
      image: async (url) => Promise.reject(new HttpError(404, url)),
    },
  });
  assert.equal(optional.failures.length, 1);
  assert.equal(optional.failures[0].key, "ghost");
  assert.equal(Object.keys(optional.json).length, 5);

  // a critical failure rejects and cancels the siblings that are still running
  let siblingSignal = null;
  await assert.rejects(
    loadAll(injectFailure(manifest, "404-critical"), {
      attempts: 1,
      loaders: {
        json: async (url, { signal }) => (
          (siblingSignal = signal),
          sleep(500).then(() => ({ url }))
        ),
        image: async (url) => Promise.reject(new HttpError(404, url)),
      },
    }),
    (e) => e instanceof LoadError && e.item.key === "ghost" && e.cause.status === 404,
  );
  assert.ok(siblingSignal.aborted, "siblings are aborted after a critical failure");

  // outer abort
  const c = new AbortController();
  setTimeout(() => c.abort(), 20);
  await assert.rejects(
    loadAll(manifest, {
      signal: c.signal,
      loaders: { json: (u, { signal }) => sleep(200).then(() => signal.throwIfAborted()) },
    }),
  );
}

// ---- the sim talks through events and imports neither audio nor HUD ----
{
  const dir = fileURLToPath(new URL("../../shared/src/sim/", import.meta.url));
  for (const f of readdirSync(dir)) {
    const imports = [...readFileSync(dir + f, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map(
      (m) => m[1],
    );
    for (const i of imports)
      assert.ok(!/audio|hud|lobby|render|assets/.test(i), `${f} imports ${i}`);
  }
  let seed = 3;
  const rng = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const w = new World({ w: 800, h: 600 }, { hazards: false, rng });
  w.start();
  const seen = [];
  for (const t of ["fired", "hit", "exploded", "scoreChanged"]) {
    w.events.addEventListener(t, (e) => seen.push([t, e.detail]));
  }
  w.spawn(new Asteroid(w.player.pos.x + 80, w.player.pos.y, new Vector2(), rng));
  const fire = { isDown: (c) => c === "Space", justPressed: () => false, endStep() {} };
  for (let i = 0; i < 90; i++) w.step(1 / 60, fire);
  const kinds = new Set(seen.map(([t]) => t));
  for (const t of ["fired", "hit", "exploded", "scoreChanged"])
    assert.ok(kinds.has(t), `missing event ${t}`);
  assert.equal(seen.find(([t]) => t === "scoreChanged")[1].delta, 100);
}

// ---- once(): event -> promise ----
{
  const bus = new EventTarget();
  const p = once(bus, "ping");
  bus.dispatchEvent(new CustomEvent("ping", { detail: 1 }));
  assert.equal((await p).detail, 1);
  const c = new AbortController();
  const q = once(bus, "ping", { signal: c.signal });
  c.abort();
  await assert.rejects(q);
}

// ---- Lobby: refresh, abort-on-leave, no orphaned updates, join ----
{
  const rooms = [{ id: "r1", name: "R1", players: 1, maxPlayers: 4, arena: {} }];
  let calls = 0;
  const lobby = new Lobby({
    intervalMs: 30,
    fetchRooms: async () => {
      calls++;
      await sleep(10);
      return rooms;
    },
  });
  const changed = [];
  lobby.addEventListener("roomsChanged", (e) => changed.push(e.detail));
  lobby.enter();
  await sleep(120);
  assert.ok(changed.length >= 2, "refreshes periodically");

  // slow request, then leave: the signal aborts and nothing is dispatched afterwards
  let slowSignal = null;
  const slowLobby = new Lobby({
    intervalMs: 1000,
    fetchRooms: (url, { signal }) =>
      new Promise((resolve, reject) => {
        slowSignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason));
        setTimeout(() => resolve(rooms), 100);
      }),
  });
  let events = 0;
  slowLobby.addEventListener("roomsChanged", () => events++);
  slowLobby.addEventListener("failed", () => events++);
  slowLobby.enter();
  await sleep(20);
  slowLobby.leave();
  assert.ok(slowSignal.aborted, "leave() aborts the in-flight request");
  await sleep(150);
  assert.equal(events, 0, "no update (and no error) after leaving");

  const joined = once(lobby, "joined");
  lobby.join("r1", "Ace");
  const { room, name } = (await joined).detail;
  assert.deepEqual([room.id, name], ["r1", "Ace"]);
  const before = calls;
  await sleep(100);
  assert.equal(calls, before, "join() stops the refresh timer");

  const timeoutLobby = new Lobby({
    intervalMs: 1000,
    timeoutMs: 20,
    attempts: 1,
    fetchRooms: (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  });
  const failed = once(timeoutLobby, "failed");
  timeoutLobby.enter();
  assert.equal((await failed).detail.name, "TimeoutError");
  timeoutLobby.leave();
}

console.log("smoke-assets: all checks passed");
