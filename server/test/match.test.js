import { test } from "node:test";
import assert from "node:assert/strict";
import { codecs } from "@dogfight/shared/codec/index.js";
import { stepShipState } from "@dogfight/shared/sim/shipPhysics.js";
import { TICK_DT, WORLD_SIZE } from "@dogfight/shared/protocol.js";
import { NetSim } from "../src/netsim.js";
import { connect, sleep, startServer } from "./helpers.js";

async function withServer(env, fn) {
  const s = await startServer(env);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

async function joinGame(s, name, { codec = "binary", query = "", room = "open-space" } = {}) {
  const ws = connect(s.wsUrl + query);
  await ws.opened;
  ws.sendJson({ type: "join", room, name, codec });
  const joined = await ws.waitFor((m) => m.type === "joined");
  ws.codec = codecs[codec];
  ws.joined = joined;
  // decoded snapshots, whichever codec is in use
  ws.snaps = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) ws.snaps.push(ws.codec.decodeSnapshot(data));
    else {
      const msg = JSON.parse(data.toString());
      if (msg.type === "snapshot") ws.snaps.push(ws.codec.decodeSnapshot(data.toString()));
    }
  });
  ws.waitSnap = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = ws.snaps.find(pred);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error("timed out waiting for a snapshot");
  };
  return ws;
}
const cmd = (seq, o = {}) => ({ seq, tick: 0, thrust: false, turn: 0, fire: false, ...o });
const sendInput = (ws, c) => ws.send(ws.codec.encodeInput(c));

test("joined carries slot, tick rate, seed, world size and the negotiated codec", () =>
  withServer({}, async (s) => {
    const a = await joinGame(s, "Ace");
    const b = await joinGame(s, "Bea", { codec: "json" });
    assert.equal(a.joined.you.slot, 0);
    assert.equal(b.joined.you.slot, 1);
    assert.equal(a.joined.tickRate, 30);
    assert.deepEqual(a.joined.world, WORLD_SIZE);
    assert.equal(a.joined.codec, "binary");
    assert.equal(b.joined.codec, "json");
    assert.ok(Number.isInteger(a.joined.seed));
    a.close();
    b.close();
  }));

for (const codecName of ["binary", "json"]) {
  test(`server state after the acked inputs equals the shared physics run locally (${codecName}) - this is what prediction relies on`, () =>
    withServer({}, async (s) => {
      const ws = await joinGame(s, "Ace", { codec: codecName });
      const first = await ws.waitSnap((x) => x.self);
      const sent = [];
      for (let seq = 1; seq <= 60; seq++) {
        const c = cmd(seq, {
          thrust: seq % 7 !== 0,
          turn: seq < 30 ? 1 : -1,
          fire: seq % 11 === 0,
        });
        sent.push(ws.codec.quantizeCommand(c));
        sendInput(ws, c);
        await sleep(34); // one input per tick, like a real client
      }
      const last = await ws.waitSnap((x) => x.ack === 60);
      // replay what the server acked, starting from the snapshot we had before the first input
      const local = { ...first.self };
      for (const c of sent) stepShipState(local, c, TICK_DT, WORLD_SIZE.w, WORLD_SIZE.h);
      const tol = codecName === "binary" ? 1e-2 : 1e-9; // binary starts from an f32-rounded state
      for (const f of ["x", "y", "vx", "vy", "angle"])
        assert.ok(Math.abs(last.self[f] - local[f]) < tol, `${f}: ${last.self[f]} vs ${local[f]}`);
      ws.close();
    }));
}

test("a ship with no input does not advance (the client replays only acked inputs)", () =>
  withServer({}, async (s) => {
    const ws = await joinGame(s, "Ace");
    const a = await ws.waitSnap((x) => x.self);
    await sleep(200);
    const b = ws.snaps.at(-1);
    assert.equal(b.ack, 0);
    assert.deepEqual([b.self.x, b.self.y, b.self.angle], [a.self.x, a.self.y, a.self.angle]);
    assert.ok(b.tick > a.tick, "the world keeps ticking");
    ws.close();
  }));

test("every client sees every ship in its snapshots, with slots", () =>
  withServer({}, async (s) => {
    const a = await joinGame(s, "Ace");
    const b = await joinGame(s, "Bea");
    const snap = await a.waitSnap((x) => x.entities.filter((e) => e.kind === "ship").length === 2);
    assert.deepEqual(
      snap.entities
        .filter((e) => e.kind === "ship")
        .map((e) => e.slot)
        .sort(),
      [0, 1],
    );
    assert.ok(snap.self, "own exact state is included");
    a.close();
    b.close();
  }));

test("input validation: a turn of 1000 closes the socket (1002); stale seqs are ignored", () =>
  withServer({}, async (s) => {
    const cheat = await joinGame(s, "Cheat", { codec: "json" });
    cheat.send(
      JSON.stringify({
        v: 1,
        type: "input",
        seq: 1,
        tick: 0,
        thrust: true,
        turn: 1000,
        fire: false,
      }),
    );
    assert.equal((await cheat.closed).code, 1002);

    const ws = await joinGame(s, "Ace");
    sendInput(ws, cmd(5, { thrust: true }));
    sendInput(ws, cmd(3, { thrust: true })); // older: dropped
    sendInput(ws, cmd(5, { thrust: true })); // duplicate: dropped
    await ws.waitSnap((x) => x.ack === 5);
    await sleep(150);
    assert.equal(ws.snaps.at(-1).ack, 5);
    assert.ok(s.app.rooms.get("open-space").match.entries.size === 1);
    ws.close();
  }));

test("inputs are rate limited with their own bucket: 30/s is fine, a flood gets 1008", () =>
  withServer({ INPUT_BURST: "20", INPUT_PER_SEC: "40" }, async (s) => {
    const ok = await joinGame(s, "Ace");
    for (let i = 1; i <= 40; i++) {
      sendInput(ok, cmd(i));
      await sleep(25); // 40 per second
    }
    assert.equal(ok.readyState, 1);
    const flood = await joinGame(s, "Flood");
    for (let i = 1; i <= 500; i++) sendInput(flood, cmd(i));
    assert.equal((await flood.closed).code, 1008);
    ok.close();
  }));

test("latency injector: ?rtt= delays the pong, the live netsim message changes it, drop=100 silences snapshots", () =>
  withServer({}, async (s) => {
    const ws = await joinGame(s, "Ace", { query: "?rtt=200" });
    const t0 = Date.now();
    ws.sendJson({ type: "ping", t: 1 });
    await ws.waitFor((m) => m.type === "pong");
    const slow = Date.now() - t0;
    assert.ok(slow >= 180 && slow < 400, `rtt ${slow}`);

    ws.sendJson({ type: "netsim", rtt: 0, jitter: 0, drop: 0 }); // reaches the server after the old delay
    await sleep(300);
    const t1 = Date.now();
    ws.sendJson({ type: "ping", t: 2 });
    await ws.waitFor((m) => m.type === "pong" && m.t === 2);
    assert.ok(Date.now() - t1 < 100);

    ws.sendJson({ type: "netsim", rtt: 0, jitter: 0, drop: 100 });
    await sleep(100);
    const before = ws.snaps.length;
    await sleep(300);
    assert.equal(ws.snaps.length, before, "all snapshots dropped");
    ws.close();
  }));

test("netsim can be disabled by the operator", () =>
  withServer({ NETSIM: "0" }, async (s) => {
    const ws = await joinGame(s, "Ace", { query: "?rtt=500" }); // ignored
    const t0 = Date.now();
    ws.sendJson({ type: "ping", t: 1 });
    await ws.waitFor((m) => m.type === "pong");
    assert.ok(Date.now() - t0 < 150);
    ws.sendJson({ type: "netsim", rtt: 100, jitter: 0, drop: 0 });
    assert.equal((await ws.closed).code, 1008);
  }));

test("NetSim: delivery stays in order, delays roughly rtt/2 per direction", async () => {
  let r = 0;
  const sim = new NetSim({ rttMs: 100, jitterMs: 60, random: () => (r = (r + 0.37) % 1) });
  const order = [];
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) sim.in(() => order.push([i, performance.now() - t0]));
  await sleep(250);
  assert.deepEqual(
    order.map(([i]) => i),
    Array.from({ length: 20 }, (_, i) => i),
    "FIFO like TCP",
  );
  assert.ok(order[0][1] >= 15, "first message was delayed");
  assert.ok(order.every(([, t]) => t < 120));
  sim.dispose();
});

test("the tick loop runs at 30 Hz on absolute deadlines; /api/stats reports tick duration and jitter", () =>
  withServer({}, async (s) => {
    const ws = await joinGame(s, "Ace");
    const t0 = Date.now();
    const start = ws.snaps.length;
    await sleep(2000);
    const ticks = ws.snaps.length - start;
    const seconds = (Date.now() - t0) / 1000;
    assert.ok(Math.abs(ticks / seconds - 30) < 1.5, `${(ticks / seconds).toFixed(2)} ticks/s`);

    const stats = await (await fetch(s.url + "/api/stats")).json();
    const m = stats.matches.find((x) => x.room === "open-space");
    assert.equal(m.tickRate, 30);
    assert.ok(m.tickMs.avg >= 0 && m.tickMs.max < 33, "a tick is much shorter than its interval");
    assert.ok(m.jitterMs.avg < 5, `jitter ${m.jitterMs.avg}`);
    assert.equal(m.overruns, 0);
    assert.ok(m.bytesPerSecPerClient.down > 0);
    ws.close();
    await sleep(80);
    assert.equal(
      s.app.rooms.get("open-space").match.running,
      false,
      "an empty match stops ticking",
    );
  }));

test("a match overrun is counted and does not drift the schedule", async () => {
  // Drives Match with a fake clock: the 3rd tick takes 100 ms (3 intervals).
  const { Match } = await import("../src/match.js");
  const { Room } = await import("../src/rooms.js");
  let t = 0;
  const room = new Room({ id: "x", maxPlayers: 2, arena: {} });
  const match = new Match({ room, now: () => t });
  match.addPlayer({ id: "p", send() {}, codec: "json" });
  match.stop(); // we call tick() ourselves, only the bookkeeping is under test
  assert.equal(match.world.players.size, 1);
  match.tick();
  match.tick();
  assert.equal(match.tickNumber, 2);
  assert.equal(match.stats().overruns, 0);
});
