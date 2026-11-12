import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, validate, isRoomId, isPlayerName } from "../src/protocol.js";
import { TokenBucket } from "../src/ratelimit.js";
import { ConfigError, loadConfig } from "../src/config.js";

test("validate accepts well-formed messages and returns a clean copy", () => {
  const raw = { v: 1, type: "join", room: "open-space", name: "  Ace ", evil: "__proto__" };
  const r = validate(raw);
  assert.equal(r.ok, true);
  assert.deepEqual(r.msg, { v: 1, type: "join", room: "open-space", name: "Ace" });
  assert.deepEqual(validate({ v: 1, type: "chat", text: " hi " }).msg, {
    v: 1,
    type: "chat",
    text: "hi",
  });
  assert.equal(validate({ v: 1, type: "leave" }).ok, true);
});

test("validate rejects bad shapes", () => {
  const bad = [
    null,
    [],
    "x",
    5,
    {},
    { type: "chat", text: "hi" }, // no version
    { v: 2, type: "chat", text: "hi" },
    { v: 1, type: "nope" },
    { v: 1, type: "constructor" }, // not an own key of the table
    { v: 1, type: "join", room: "Bad Room", name: "a" },
    { v: 1, type: "join", room: "ok", name: "" },
    { v: 1, type: "join", room: "ok", name: "x".repeat(17) },
    { v: 1, type: "join", room: "ok", name: 5 },
    { v: 1, type: "chat", text: "   " },
    { v: 1, type: "chat", text: "x".repeat(281) },
    { v: 1, type: "chat", text: { a: 1 } },
  ];
  for (const m of bad) assert.equal(validate(m).ok, false, JSON.stringify(m));
});

test("ids and names", () => {
  assert.ok(isRoomId("a") && isRoomId("rock-field") && isRoomId("a1"));
  assert.ok(
    !isRoomId("-a") && !isRoomId("a-") && !isRoomId("A") && !isRoomId("a_b") && !isRoomId(""),
  );
  assert.ok(isPlayerName("Пілот 1") && !isPlayerName("<b>") && !isPlayerName(" x"));
  assert.equal(slugify("  My Room!! "), "my-room");
  assert.equal(slugify("***"), "");
});

test("token bucket allows a burst, then the sustained rate", () => {
  let t = 0;
  const b = new TokenBucket({ capacity: 3, perSec: 2, now: () => t });
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
  t = 500; // +1 token
  assert.deepEqual([b.take(), b.take()], [true, false]);
  t = 60_000; // refill is capped at capacity
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
});

test("config: defaults, overrides and validation", () => {
  assert.equal(loadConfig({}).port, 3000);
  assert.equal(loadConfig({ PORT: "8080", DEMO_ENDPOINTS: "1" }).demo, true);
  assert.throws(() => loadConfig({ PORT: "abc" }), ConfigError);
  assert.throws(() => loadConfig({ PORT: "70000" }), /PORT/);
  assert.throws(() => loadConfig({ MAX_PAYLOAD: "1" }), ConfigError);
});
