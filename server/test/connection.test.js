// The browser-side Connection wrapper (client/src/net/connection.js) against the real server.
// Node 22 ships a global WebSocket with the same API as the browser's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection } from "../../client/src/net/connection.js";
import { once } from "../../client/src/events.js";
import { connect, sleep, startServer } from "./helpers.js";

const hello = () => ({ type: "join", room: "open-space", name: "Ace" });
const fast = { baseMs: 20, maxMs: 40 };

test("queues while connecting, dispatches by type, re-joins after a dropped connection", async () => {
  const s = await startServer();
  const conn = new Connection({ url: s.wsUrl, hello, ...fast });
  try {
    const joined = [];
    conn.on("joined", (m) => joined.push(m));
    const chats = [];
    conn.on("chat", (m) => chats.push(m.text));

    conn.send({ type: "chat", text: "queued before open" }); // socket does not exist yet
    conn.open();
    await once(conn, "message:roster");
    await sleep(50);
    assert.equal(joined.length, 1);
    assert.deepEqual(chats, ["queued before open"], "hello went first, then the queue");

    // the server side drops the connection (like a Wi-Fi switch): the wrapper reconnects and re-joins
    const reconnecting = once(conn, "reconnecting");
    for (const c of s.app.wss.clients) c.terminate();
    assert.equal((await reconnecting).detail.attempt, 1);
    await once(conn, "message:joined");
    assert.equal(joined.length, 2);

    conn.send({ type: "chat", text: "after reconnect" });
    await once(conn, "message:chat");
    assert.equal(chats.at(-1), "after reconnect");
  } finally {
    conn.close();
    await s.close();
  }
});

test("does not reconnect after a protocol/policy close code", async () => {
  const s = await startServer({ RATE_BURST: "2", RATE_PER_SEC: "1" });
  const conn = new Connection({ url: s.wsUrl, hello, ...fast });
  try {
    let reconnects = 0;
    conn.addEventListener("reconnecting", () => reconnects++);
    conn.open();
    await once(conn, "message:joined");
    const closed = once(conn, "close");
    for (let i = 0; i < 10; i++) conn.send({ type: "chat", text: `spam${i}` });
    assert.equal((await closed).detail.code, 1008);
    await sleep(150);
    assert.equal(reconnects, 0);
    assert.equal(conn.connected, false);
  } finally {
    conn.close();
    await s.close();
  }
});

test("close() stops reconnecting for good; the send queue is bounded", async () => {
  const s = await startServer();
  const conn = new Connection({ url: s.wsUrl, hello, ...fast });
  try {
    conn.open();
    await once(conn, "message:joined");
    let reconnects = 0;
    conn.addEventListener("reconnecting", () => reconnects++);
    conn.close();
    await sleep(150);
    assert.equal(reconnects, 0);

    const offline = new Connection({ url: s.wsUrl, hello });
    for (let i = 0; i < 500; i++) offline.send({ type: "chat", text: `m${i}` });
    const seen = [];
    const watcher = connect(s.wsUrl);
    await watcher.opened;
    watcher.sendJson(hello());
    watcher.on("message", (d) => seen.push(JSON.parse(d).text));
    offline.open();
    await sleep(300);
    // rate limiting (burst 20) cuts the flood, but at most 100 were ever queued
    assert.ok(seen.filter(Boolean).length <= 100);
    offline.close();
    watcher.close();
  } finally {
    await s.close();
  }
});
