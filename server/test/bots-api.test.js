import { afterAll, beforeAll, test } from "vitest";
import assert from "node:assert/strict";
import { codecs } from "@dogfight/shared/codec/index.js";
import { joinRoom, sleep, startServer } from "./helpers.js";

// The bots endpoint and bots as seen by a real WebSocket player: the server cannot tell them from people.

let s;
beforeAll(async () => (s = await startServer({ MAX_PLAYERS_PER_ROOM: "6" })));
afterAll(() => s.close());

const json = { "Content-Type": "application/json" };
const send = (method, path, body, headers = json) =>
  fetch(s.url + path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
let n = 0;
async function newRoom(extra = {}) {
  const name = `bots-${++n}-${Date.now().toString(36)}`;
  const res = await send("POST", "/api/rooms", { name, ...extra });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}
const listRoom = async (id) =>
  (await (await send("GET", "/api/rooms")).json()).find((r) => r.id === id);

test("POST adds bots to a room: they take slots, count as players, and show in the lobby list", async () => {
  const id = await newRoom();
  const res = await send("POST", `/api/rooms/${id}/bots`, { count: 3 });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.bots, 3);
  assert.deepEqual(
    body.added.map((b) => b.slot),
    [0, 1, 2],
  );
  assert.equal(new Set(body.added.map((b) => b.name)).size, 3);
  assert.equal((await listRoom(id)).players, 3);
  await send("DELETE", `/api/rooms/${id}/bots`);
});

test("without a count, one bot is added", async () => {
  const id = await newRoom();
  const body = await (await send("POST", `/api/rooms/${id}/bots`, {})).json();
  assert.equal(body.added.length, 1);
  await send("DELETE", `/api/rooms/${id}/bots`);
});

test("bad requests: unknown room 404, bad count 422, not enough space 409, no JSON 415, wrong method 405", async () => {
  const id = await newRoom({ maxPlayers: 4 });
  assert.equal((await send("POST", "/api/rooms/nope/bots", {})).status, 404);
  for (const count of [0, -1, 1.5, "2", null, 7])
    // 7 > MAX_PLAYERS_PER_ROOM (6)
    assert.equal(
      (await send("POST", `/api/rooms/${id}/bots`, { count })).status,
      422,
      String(count),
    );
  for (const body of ["5", "null", "[]", '"x"'])
    // valid JSON, but not an object
    assert.equal((await send("POST", `/api/rooms/${id}/bots`, body)).status, 422, body);
  assert.equal((await send("POST", `/api/rooms/${id}/bots`, "{nope")).status, 400);
  assert.equal((await send("POST", `/api/rooms/${id}/bots`, { count: 5 })).status, 409); // room holds 4
  assert.equal(
    (await send("POST", `/api/rooms/${id}/bots`, "{}", { "Content-Type": "text/plain" })).status,
    415,
  );
  const get = await send("GET", `/api/rooms/${id}/bots`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, DELETE");
  assert.equal((await listRoom(id)).players, 0, "a refused request adds nothing");
});

test("DELETE removes the bots, and an empty non-persistent room then goes away", async () => {
  const id = await newRoom();
  await send("POST", `/api/rooms/${id}/bots`, { count: 2 });
  const res = await send("DELETE", `/api/rooms/${id}/bots`);
  assert.deepEqual(await res.json(), { removed: 2, bots: 0 });
  assert.equal(await listRoom(id), undefined);
  assert.equal((await send("DELETE", `/api/rooms/${id}/bots`)).status, 404);
});

test("BOTS=0 switches the endpoint off", async () => {
  const off = await startServer({ BOTS: "0" });
  try {
    const res = await fetch(`${off.url}/api/rooms/open-space/bots`, {
      method: "POST",
      headers: json,
      body: "{}",
    });
    assert.equal(res.status, 404);
  } finally {
    await off.close();
  }
});

test("a human sees the bots: roster entries, their ships in the snapshots, and they move", async () => {
  const id = await newRoom();
  await send("POST", `/api/rooms/${id}/bots`, { count: 2 });
  const human = await joinRoom(s.wsUrl, id, "Human");
  try {
    const roster = await human.waitFor((m) => m.type === "roster" && m.players.length === 3);
    assert.equal(roster.players.filter((p) => p.name.startsWith("Bot")).length, 2);
    // our own ship sends no input in this test, so it stays put: look only at the bots' slots
    const mySlot = (await human.waitFor((m) => m.type === "joined")).you.slot;

    const decode = (buf) => codecs.binary.decodeSnapshot(buf);
    const shipsOf = (snap) => snap.entities.filter((e) => e.kind === "ship");
    const until = async (pred, ms = 3000) => {
      for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(20)) {
        const hit = human.snapshots.map(decode).find(pred);
        if (hit) return hit;
      }
      throw new Error("timed out waiting for a snapshot");
    };
    const first = await until((snap) => shipsOf(snap).length === 3);
    await sleep(800);
    const later = decode(human.snapshots.at(-1));
    const botShips = shipsOf(first).filter((e) => e.slot !== mySlot);
    assert.equal(botShips.length, 2);
    let moved = 0;
    for (const before of botShips) {
      const after = shipsOf(later).find((e) => e.slot === before.slot);
      if (!after) continue; // shot down and waiting to respawn
      if (Math.hypot(after.x - before.x, after.y - before.y) > 5 || after.angle !== before.angle)
        moved++;
    }
    assert.ok(moved >= 1, "the bots fly by themselves");
  } finally {
    human.close();
    await send("DELETE", `/api/rooms/${id}/bots`);
  }
});

test("when the last bot goes, the human is told through the roster", async () => {
  const id = await newRoom();
  await send("POST", `/api/rooms/${id}/bots`, { count: 2 });
  const human = await joinRoom(s.wsUrl, id, "Human");
  try {
    await human.waitFor((m) => m.type === "roster" && m.players.length === 3);
    await send("DELETE", `/api/rooms/${id}/bots`);
    await human.waitFor((m) => m.type === "roster" && m.players.length === 1);
  } finally {
    human.close();
  }
});
