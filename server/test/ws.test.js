import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, joinRoom, sleep, startServer } from "./helpers.js";

async function withServer(env, fn) {
  const s = await startServer(env);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

test("two clients join one room, see each other, chat, and leave", () =>
  withServer({}, async (s) => {
    const a = await joinRoom(s.wsUrl, "open-space", "Ace");
    const b = await joinRoom(s.wsUrl, "open-space", "Bea");

    const roster = await a.waitFor((m) => m.type === "roster" && m.players.length === 2);
    assert.deepEqual(roster.players.map((p) => p.name).sort(), ["Ace", "Bea"]);

    b.sendJson({ type: "chat", text: "hello" });
    const chat = await a.waitFor((m) => m.type === "chat");
    assert.equal(chat.text, "hello");
    assert.equal(chat.from.name, "Bea");
    await b.waitFor((m) => m.type === "chat"); // the sender gets its own message too

    const closing = b.closed;
    b.sendJson({ type: "leave" });
    assert.equal((await closing).code, 1000);
    const after = await a.waitFor((m) => m.type === "roster" && m.players.length === 1);
    assert.equal(after.players[0].name, "Ace");

    a.close();
    await a.closed;
  }));

test("an empty, non-persistent room is deleted; default rooms stay", () =>
  withServer({}, async (s) => {
    const ws = await joinRoom(s.wsUrl, "temp-room", "Ace"); // auto-created by join
    assert.ok(s.app.rooms.get("temp-room"));
    ws.close();
    await ws.closed;
    await sleep(50);
    assert.equal(s.app.rooms.get("temp-room"), undefined);

    const d = await joinRoom(s.wsUrl, "open-space", "Ace");
    d.close();
    await d.closed;
    await sleep(50);
    assert.ok(s.app.rooms.get("open-space"));
  }));

test("a socket that does not join in time is closed with 4001", () =>
  withServer({ JOIN_TIMEOUT_MS: "100" }, async (s) => {
    const ws = connect(s.wsUrl);
    await ws.opened;
    const { code } = await ws.closed;
    assert.equal(code, 4001);
  }));

test("invalid messages (text or binary) close the socket with 1002", () =>
  withServer({}, async (s) => {
    const bad = [
      (ws) => ws.send("not json"),
      (ws) => ws.send(JSON.stringify({ v: 1, type: "dance" })),
      (ws) => ws.send(JSON.stringify({ v: 1, type: "chat", text: "no join yet" })),
      (ws) => ws.send(JSON.stringify({ type: "join", room: "x", name: "a" })), // missing version
      (ws) => ws.sendJson({ type: "join", room: "BAD ROOM", name: "a" }),
    ];
    for (const send of bad) {
      const ws = connect(s.wsUrl);
      await ws.opened;
      send(ws);
      assert.equal((await ws.closed).code, 1002);
      assert.equal(ws.inbox.at(-1).type, "error");
    }
    const twice = await joinRoom(s.wsUrl, "open-space", "Ace");
    twice.sendJson({ type: "join", room: "open-space", name: "Ace" });
    assert.equal((await twice.closed).code, 1002);

    // binary frames are game inputs now; garbage that is not a valid input is a protocol error
    const bin = connect(s.wsUrl);
    await bin.opened;
    bin.send(Buffer.from([1, 2, 3]));
    assert.equal((await bin.closed).code, 1002);
  }));

test("a message over maxPayload closes with 1009 and the server keeps running", () =>
  withServer({ MAX_PAYLOAD: "128" }, async (s) => {
    const ws = connect(s.wsUrl);
    await ws.opened;
    ws.send("x".repeat(500));
    assert.equal((await ws.closed).code, 1009);
    const ok = await joinRoom(s.wsUrl, "open-space", "Ace"); // still alive
    ok.close();
  }));

test("rate limit: a flood is cut off with 1008", () =>
  withServer({ RATE_BURST: "5", RATE_PER_SEC: "1" }, async (s) => {
    const ws = await joinRoom(s.wsUrl, "open-space", "Ace");
    for (let i = 0; i < 30; i++) ws.sendJson({ type: "chat", text: `m${i}` });
    assert.equal((await ws.closed).code, 1008);
  }));

test("room caps: players per room (4002) and number of rooms (4003)", () =>
  withServer({ MAX_PLAYERS_PER_ROOM: "2", MAX_ROOMS: "4" }, async (s) => {
    const a = await joinRoom(s.wsUrl, "open-space", "A");
    const b = await joinRoom(s.wsUrl, "open-space", "B");
    const c = connect(s.wsUrl);
    await c.opened;
    c.sendJson({ type: "join", room: "open-space", name: "C" });
    assert.equal((await c.closed).code, 4002);

    // 3 default rooms + 1 allowed = 4; the next new room is refused
    const x = await joinRoom(s.wsUrl, "extra-1", "X");
    const d = connect(s.wsUrl);
    await d.opened;
    d.sendJson({ type: "join", room: "extra-2", name: "D" });
    assert.equal((await d.closed).code, 4003);
    for (const ws of [a, b, x]) ws.close();
  }));

test("heartbeat: a client that never answers pings is terminated", () =>
  withServer({ HEARTBEAT_MS: "40" }, async (s) => {
    const mute = connect(s.wsUrl, { autoPong: false });
    await mute.opened;
    mute.sendJson({ type: "join", room: "open-space", name: "Mute" });
    await mute.waitFor((m) => m.type === "joined");
    const t0 = Date.now();
    await mute.closed;
    assert.ok(Date.now() - t0 < 1500);

    const alive = await joinRoom(s.wsUrl, "open-space", "Alive"); // default client answers pongs
    await sleep(300);
    assert.equal(alive.readyState, 1, "a client that answers stays connected");
    alive.close();
  }));

test("a client that vanishes abruptly does not crash the server", () =>
  withServer({}, async (s) => {
    const ws = await joinRoom(s.wsUrl, "open-space", "Gone");
    ws.terminate();
    await ws.closed;
    await sleep(50);
    assert.equal(s.app.rooms.get("open-space").size, 0);
    assert.equal((await fetch(s.url + "/health")).status, 200);
  }));

test("slow client policy: chat is dropped (or the client cut off) once bufferedAmount grows", () =>
  withServer(
    { SLOW_CLIENT_BYTES: "20000", RATE_BURST: "100000", RATE_PER_SEC: "100000" },
    async (s) => {
      const slow = await joinRoom(s.wsUrl, "open-space", "Slow");
      slow._socket.pause(); // stops reading: the server's send buffer for this client fills up
      const sender = await joinRoom(s.wsUrl, "open-space", "Fast");
      const serverSide = [...s.app.wss.clients].find((c) => c.session.player?.name === "Slow");
      const text = "x".repeat(280);
      let policyHit = false;
      for (let round = 0; round < 400 && !policyHit; round++) {
        for (let i = 0; i < 50; i++) sender.sendJson({ type: "chat", text });
        await sleep(5);
        policyHit = serverSide.session.dropped > 0 || serverSide.readyState > 1;
      }
      assert.ok(
        policyHit,
        "server should drop chat for, or disconnect, a client that does not read",
      );
      assert.equal(sender.readyState, 1, "the fast client is not affected");
      sender.close();
      slow.terminate();
    },
  ));
