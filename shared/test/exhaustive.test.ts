import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClientMessage } from "../src/protocol.ts";
import type { ClientMessage } from "../src/protocol.ts";

// Canary for M2: every client message type is classified here, and the `never` default means a new
// message type added to the schema stops `npm run typecheck` until it is classified. The server's
// handle() switch gets the same treatment when server/ moves to TypeScript (M3).
function lane(msg: ClientMessage): "game" | "control" {
  switch (msg.type) {
    case "input":
      return "game";
    case "join":
    case "chat":
    case "leave":
    case "ping":
    case "netsim":
      return "control";
    default: {
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}

test("every client message type lands in exactly one lane (and the compiler checks the list)", () => {
  const input = { v: 1, type: "input", seq: 1, tick: 0, thrust: true, turn: 0, fire: false };
  const ping = { v: 1, type: "ping", t: 5 };
  for (const [raw, want] of [
    [input, "game"],
    [ping, "control"],
  ] as const) {
    const r = parseClientMessage(raw);
    assert.ok(r.ok);
    assert.equal(lane(r.value), want);
  }
});
