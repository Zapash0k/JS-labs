import { beforeEach, describe, expect, test } from "vitest";
import { TICK_DT, WORLD_SIZE } from "@dogfight/shared/protocol.js";
import { createShipState, stepShipState } from "@dogfight/shared/sim/shipPhysics.js";
import { NetGame } from "../src/net/netgame.js";

// Client-side prediction and reconciliation, with no network and no clock: we hand NetGame the
// snapshots ourselves. The rule under test: local = server state at `ack` + replay of every input the
// server has not seen yet. If prediction and server agree, the correction is zero.

const { w, h } = WORLD_SIZE;
const keys = (...down) => ({ isDown: (code) => down.includes(code) });
const FLY = keys("ArrowUp", "ArrowRight");

const self = (over = {}) => ({ ...createShipState(400, 300), hp: 100, ...over });
const snapshot = (tick, ack, selfState) => ({ tick, ack, self: selfState, entities: [], events: [] });

let conn;
let game;
beforeEach(() => {
  conn = Object.assign(new EventTarget(), { bytesIn: 0, bytesOut: 0, send() {}, sendRaw() {} });
  game = new NetGame({ conn, slot: 0, now: () => 0 });
});

/** Joins, flies `n` steps, and returns what the server would say after acking the first `acked` of them. */
function flyAndAck(n, acked, options) {
  if (options) game = new NetGame({ conn, slot: 0, now: () => 0, options });
  const start = self();
  game.onSnapshot(snapshot(1, 0, start), 0);
  for (let i = 0; i < n; i++) game.step(TICK_DT, FLY);
  const server = { ...start };
  for (const cmd of game.pending.slice(0, acked)) stepShipState(server, cmd, TICK_DT, w, h);
  return { server: { ...server, hp: 100 }, ack: game.pending[acked - 1].seq };
}

describe("reconciliation", () => {
  test("the first snapshot just adopts the server's state", () => {
    game.onSnapshot(snapshot(1, 0, self({ x: 123, y: 45 })), 0);
    expect(game.local).toMatchObject({ x: 123, y: 45 });
    expect(game.stats.correction).toBe(0);
  });

  test("prediction that matches the server gives a correction of zero", () => {
    const { server, ack } = flyAndAck(5, 3);
    const predicted = { ...game.local };
    game.onSnapshot(snapshot(2, ack, server), 33);
    expect(game.stats.correction).toBeCloseTo(0, 9);
    expect(game.local.x).toBeCloseTo(predicted.x, 9);
    expect(game.local.y).toBeCloseTo(predicted.y, 9);
    expect(game.offset.x).toBeCloseTo(0, 9);
  });

  test("acknowledged inputs leave the pending list; the rest stay for replay", () => {
    const { server, ack } = flyAndAck(5, 3);
    expect(game.pending).toHaveLength(5);
    game.onSnapshot(snapshot(2, ack, server), 33);
    expect(game.pending).toHaveLength(2);
    expect(game.pending.every((c) => c.seq > ack)).toBe(true);
  });

  test("when the server disagrees, the ship is corrected and the jump is hidden in the smoothing offset", () => {
    const { server, ack } = flyAndAck(5, 3);
    const before = { ...game.local };
    game.onSnapshot(snapshot(2, ack, { ...server, x: server.x + 10 }), 33);
    expect(game.stats.correction).toBeCloseTo(10, 6);
    expect(game.local.x).toBeCloseTo(before.x + 10, 6); // the truth wins ...
    expect(game.offset.x).toBeCloseTo(-10, 6); // ... but is drawn where the ship WAS, then melts away
  });

  test("a huge disagreement (respawn, teleport) snaps instead of smoothing", () => {
    const { server, ack } = flyAndAck(5, 3);
    game.onSnapshot(snapshot(2, ack, { ...server, x: server.x + 300 }), 33);
    expect(game.stats.correction).toBeGreaterThanOrEqual(100);
    expect(game.offset).toEqual({ x: 0, y: 0 });
  });

  test("the correction takes the shortest way around the wrap-around arena", () => {
    const { server, ack } = flyAndAck(5, 3);
    const wrapped = { ...server, x: server.x + w - 5 }; // 5 px to the left, written the long way round
    game.onSnapshot(snapshot(2, ack, wrapped), 33);
    expect(game.stats.correction).toBeLessThan(10);
  });

  test("reconcile: false keeps the prediction and only measures the disagreement", () => {
    const { server, ack } = flyAndAck(5, 3, { reconcile: false });
    const before = { ...game.local };
    game.onSnapshot(snapshot(2, ack, { ...server, x: server.x + 10 }), 33);
    expect(game.local).toEqual(before);
    expect(game.stats.correction).toBeCloseTo(10, 6);
  });

  test("predict: false (the dumb client) shows exactly what the server said", () => {
    const { server, ack } = flyAndAck(5, 3, { predict: false });
    game.onSnapshot(snapshot(2, ack, server), 33);
    expect(game.local).toMatchObject({ x: server.x, y: server.y });
  });

  test("no `self` in the snapshot (dead): nothing to predict, pending inputs dropped", () => {
    flyAndAck(5, 3);
    game.onSnapshot(snapshot(2, 3, null), 33);
    expect(game.local).toBeNull();
    expect(game.pending).toEqual([]);
  });

  test("an old or duplicate snapshot is ignored", () => {
    const { server, ack } = flyAndAck(5, 3);
    game.onSnapshot(snapshot(5, ack, server), 33);
    const count = game.stats.snapshots;
    game.onSnapshot(snapshot(4, ack, { ...server, x: 999 }), 40); // older tick
    game.onSnapshot(snapshot(5, ack, { ...server, x: 999 }), 41); // same tick
    expect(game.stats.snapshots).toBe(count);
    expect(game.serverSelf.x).not.toBe(999);
  });
});
