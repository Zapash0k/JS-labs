import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";
import { codecs } from "@dogfight/shared/codec/index.js";
import { mulberry32 } from "@dogfight/shared/prng.js";
import { WORLD_SIZE } from "@dogfight/shared/protocol.js";
import { Bot, BotManager, DEFAULT_BRAIN, IDLE, decide } from "../src/bot.js";
import { Match } from "../src/match.js";
import { RoomFullError, RoomManager } from "../src/rooms.js";

// ---- the brain: decide() is a pure function of (snapshot, slot) -----------------------------------

const me = (x, y, angle = 0) => ({
  x,
  y,
  vx: 0,
  vy: 0,
  angle,
  cooldown: 0,
  rapid: 0,
  homingAmmo: 0,
  shield: 0,
  invuln: 0,
  thrust: false,
  hp: 100,
});
const ship = (slot, x, y) => ({
  kind: "ship",
  id: slot,
  slot,
  x,
  y,
  angle: 0,
  hp: 100,
  thrust: false,
  shield: false,
  invuln: false,
});
const rock = (x, y, radius = 28) => ({
  kind: "asteroid",
  id: 100,
  x,
  y,
  angle: 0,
  radius,
  hunter: false,
});
const snap = (self, entities = [], tick = 0) => ({ tick, ack: 0, self, entities, events: [] });
const SLOT = 0; // the bot under test is slot 0; enemies are slot 1
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("a dead bot does nothing (the world respawns it)", () => {
  assert.deepEqual(decide(snap(null, [ship(1, 300, 300)]), SLOT), IDLE);
});

test("an enemy dead ahead and in range: fire, no turn, close in", () => {
  const c = decide(snap(me(100, 360), [ship(1, 400, 360)]), SLOT);
  assert.equal(c.fire, true);
  assert.ok(near(c.turn, 0), `turn ${c.turn}`);
  assert.equal(c.thrust, true);
});

test("an enemy beside the bot: turn towards it, do not fire yet, do not thrust sideways", () => {
  // angle 0 points right (+x); +y is down on screen, so an enemy below needs a positive turn
  const below = decide(snap(me(100, 100), [ship(1, 100, 300)]), SLOT);
  assert.equal(below.turn, 1);
  assert.equal(below.fire, false);
  assert.equal(below.thrust, false);
  const above = decide(snap(me(100, 500), [ship(1, 100, 300)]), SLOT);
  assert.equal(above.turn, -1);
});

test("a small aiming error gives a small, proportional turn (no bang-bang)", () => {
  const c = decide(snap(me(100, 360), [ship(1, 400, 380)]), SLOT); // about 0.067 rad off
  assert.ok(c.turn > 0 && c.turn < 0.5, `turn ${c.turn}`);
});

test("an enemy out of range is chased but not shot at; one too close is shot at but not rammed", () => {
  // 500 px away: beyond the 450 px fire range, and nearer than going the other way round the arena
  const far = decide(snap(me(100, 360), [ship(1, 600, 360)]), SLOT);
  assert.deepEqual([far.thrust, far.fire], [true, false]);
  const close = decide(snap(me(100, 360), [ship(1, 200, 360)]), SLOT);
  assert.deepEqual([close.thrust, close.fire], [false, true]);
});

test("it goes for the NEAREST enemy", () => {
  const c = decide(snap(me(100, 360), [ship(2, 100, 700), ship(1, 400, 360)]), SLOT);
  assert.equal(c.fire, true); // slot 1 is dead ahead and nearest; slot 2 is far below
});

test("the arena wraps: an enemy across the seam is reached the short way", () => {
  // Enemy at x = 1250, bot at x = 10: 40 px to the LEFT (through the wall), not 1240 px to the right.
  const c = decide(snap(me(10, 360), [ship(1, 1250, 300)]), SLOT);
  assert.equal(c.turn, -1); // a bot that ignored the wrap would turn by only about -0.14
  assert.equal(c.thrust, false);
  // and facing left it shoots at the enemy that is 30 px away through the wall
  const shoots = decide(snap(me(10, 360, Math.PI), [ship(1, 1260, 360)]), SLOT);
  assert.equal(shoots.fire, true);
});

test("it never targets itself, bullets or pickups", () => {
  const entities = [
    ship(SLOT, 300, 360), // our own ship is in the snapshot
    { kind: "bullet", id: 7, slot: 1, seq: 1, homing: false, x: 250, y: 360, angle: 0 },
    { kind: "pickup", id: 8, effect: "shield", x: 200, y: 360, angle: 0 },
  ];
  const c = decide(snap(me(100, 360), entities), SLOT);
  assert.equal(c.fire, false);
});

test("a close asteroid is dodged: face away, no thrust into it, no shooting", () => {
  // asteroid centre 100 px ahead: edge-to-edge gap = 100 - 28 - 12 = 60 px, inside the 70 px margin
  const facing = decide(snap(me(100, 360), [rock(200, 360)]), SLOT);
  assert.equal(Math.abs(facing.turn), 1);
  assert.equal(facing.thrust, false);
  assert.equal(facing.fire, false);
  const leaving = decide(snap(me(100, 360, Math.PI), [rock(200, 360)]), SLOT);
  assert.equal(leaving.thrust, true); // already pointing away: get out of there
});

test("dodging beats shooting: with an enemy dead ahead behind an asteroid, it does not fire", () => {
  const c = decide(snap(me(100, 360), [rock(200, 360), ship(1, 400, 360)]), SLOT);
  assert.equal(c.fire, false);
});

test("with no enemy in sight it shoots a nearby asteroid, but does not fly into it", () => {
  const c = decide(snap(me(100, 360), [rock(400, 360)]), SLOT);
  assert.equal(c.fire, true);
  assert.equal(c.thrust, false);
});

test("with nothing around it wanders, differently for every bot", () => {
  const a = decide(snap(me(100, 100), [], 10), SLOT, { phase: 0.5 });
  const b = decide(snap(me(100, 100), [], 10), SLOT, { phase: 2 });
  for (const c of [a, b]) {
    assert.equal(c.thrust, true);
    assert.equal(c.fire, false);
    assert.ok(Math.abs(c.turn) <= 0.6);
  }
  assert.notEqual(a.turn, b.turn);
});

test("the brain is tunable: a wide fire arc shoots at an enemy that is not quite dead ahead", () => {
  const s = snap(me(100, 360), [ship(1, 400, 480)]); // about 0.38 rad off
  assert.equal(decide(s, SLOT).fire, false);
  assert.equal(decide(s, SLOT, { fireArc: 0.5 }).fire, true);
  assert.ok(DEFAULT_BRAIN.fireArc < 0.5);
});

test("it is pure: it does not touch the snapshot, and the same input gives the same answer", () => {
  const deepFreeze = (o) => {
    for (const v of Object.values(o)) if (typeof v === "object" && v !== null) deepFreeze(v);
    return Object.freeze(o);
  };
  const s = deepFreeze(snap(me(100, 360), [ship(1, 400, 360), rock(600, 100)], 77));
  assert.deepEqual(decide(s, SLOT, { phase: 1 }), decide(s, SLOT, { phase: 1 })); // would throw on a write
});

test("property: whatever it sees, the command is valid and survives the wire", () => {
  const x = fc.double({ min: 0, max: WORLD_SIZE.w, maxExcluded: true, noNaN: true });
  const y = fc.double({ min: 0, max: WORLD_SIZE.h, maxExcluded: true, noNaN: true });
  const slot = fc.integer({ min: 0, max: 7 });
  const entity = fc.oneof(
    fc.record({
      kind: fc.constant("ship"),
      id: fc.nat(65535),
      slot,
      x,
      y,
      angle: fc.double({ noNaN: true, min: -4, max: 4 }),
    }),
    fc.record({
      kind: fc.constant("asteroid"),
      id: fc.nat(65535),
      radius: fc.integer({ min: 0, max: 255 }),
      x,
      y,
    }),
    fc.record({ kind: fc.constant("bullet"), id: fc.nat(65535), slot, x, y }),
    fc.record({ kind: fc.constant("pickup"), id: fc.nat(65535), x, y }),
  );
  const self = fc.option(
    fc.record({ x, y, angle: fc.double({ min: -100, max: 100, noNaN: true }) }),
    { nil: null },
  );
  fc.assert(
    fc.property(
      self,
      fc.array(entity, { maxLength: 25 }),
      slot,
      fc.nat(2 ** 31),
      fc.double({ min: 0, max: 7, noNaN: true }),
      (s, entities, mySlot, tick, phase) => {
        const c = decide({ tick, ack: 0, self: s, entities, events: [] }, mySlot, { phase });
        if (typeof c.thrust !== "boolean" || typeof c.fire !== "boolean") return false;
        if (!Number.isFinite(c.turn) || c.turn < -1 || c.turn > 1) return false;
        // the binary decoder rejects turn = -128/127; a command that gets this far is always legal
        const back = codecs.binary.decodeInput(codecs.binary.encodeInput({ seq: 1, tick, ...c }));
        return (
          back.thrust === c.thrust &&
          back.fire === c.fire &&
          Math.abs(back.turn - c.turn) <= 0.5 / 127 + 1e-12
        );
      },
    ),
    { numRuns: 300 },
  );
});

// ---- a Bot inside a real Match (no sockets, no timers: we call match.tick() ourselves) -------------

const quiet = { log() {}, warn() {}, error() {}, info() {} };
const rooms = [];
afterEach(() => {
  for (const r of rooms.splice(0)) r.closeAll();
});

/** A room with a real Match. Its own 30 Hz timer is switched off once somebody joins; tests call tick(). */
function arena({ maxPlayers = 8, asteroids = 0 } = {}) {
  const manager = new RoomManager({
    maxRooms: 5,
    maxPlayersPerRoom: 8,
    emptyRoomTtlMs: 60_000,
    defaultArena: { asteroids, pickups: false },
  });
  rooms.push(manager);
  manager.on("created", (room) => {
    room.match = new Match({ room, log: quiet });
  });
  const room = manager.create("test", { maxPlayers, persistent: true });
  return { manager, room, match: room.match };
}
const sync = (fn) => fn(); // think immediately instead of in setImmediate
const newBot = (o = {}) => new Bot({ name: "Bot", rng: mulberry32(1), defer: sync, ...o });
const join = (bot, room) => {
  bot.join(room);
  room.match.stop(); // no real timer: the test drives time
};
const ticks = (match, n) => {
  for (let i = 0; i < n; i++) match.tick();
};

test("a bot joins like a player: it has a slot, a ship, a roster entry and a match entry", () => {
  const { room, match } = arena();
  const bot = newBot({ name: "Robo" });
  join(bot, room);
  assert.equal(room.size, 1);
  assert.equal(bot.slot, 0);
  assert.deepEqual(room.roster(), [{ id: bot.id, name: "Robo" }]);
  assert.ok(match.entries.has(bot.id));
  assert.equal(match.world.players.get(bot.id)?.ship.alive, true);
});

test("the match answers a bot like any client: one input per snapshot, all accepted and acknowledged", () => {
  const { room, match } = arena();
  const bot = newBot();
  join(bot, room);
  ticks(match, 60);
  const entry = match.entries.get(bot.id);
  // tick n consumes the input the bot made from snapshot n-1, so after 60 ticks the ack is 59
  assert.equal(entry.ack, 59);
  assert.equal(entry.dropped, 0);
  assert.equal(entry.stale, 0);
  assert.ok(bot.bytesOut > 60 * 14, "it was sent snapshots"); // header alone is 14 bytes
  assert.equal(bot.bytesIn, 59 * 12 + 12, "and it sent one 12-byte binary input per snapshot");
});

test("the JSON codec works too (a bot can be told to speak it)", () => {
  const { room, match } = arena();
  const bot = newBot({ codec: "json" });
  join(bot, room);
  ticks(match, 30);
  assert.equal(match.entries.get(bot.id).ack, 29);
  assert.ok(bot.bytesOut > 0 && bot.bytesIn > 0);
});

test("two bots find each other and fight: they close in, fire, and never flood or confuse the server", () => {
  const { room, match } = arena();
  const a = newBot({ rng: mulberry32(1) });
  const b = newBot({ rng: mulberry32(2) });
  join(a, room);
  join(b, room);
  let fired = 0;
  match.world.events.addEventListener("fired", () => fired++);
  const at = (bot) => match.world.players.get(bot.id).ship.pos;
  const start = [at(a), at(b)].map((p) => ({ x: p.x, y: p.y }));
  let closest = Infinity;
  for (let i = 0; i < 900; i++) {
    match.tick();
    const dx = Math.abs(at(a).x - at(b).x);
    const dy = Math.abs(at(a).y - at(b).y);
    closest = Math.min(
      closest,
      Math.hypot(Math.min(dx, WORLD_SIZE.w - dx), Math.min(dy, WORLD_SIZE.h - dy)),
    );
  }
  assert.ok(closest < 300, `closest approach ${closest.toFixed(0)} px`);
  assert.ok(fired > 0, "they shot at each other");
  for (const [i, bot] of [a, b].entries()) {
    const p = at(bot);
    assert.ok(Math.hypot(p.x - start[i].x, p.y - start[i].y) > 20, "and they moved");
    const entry = match.entries.get(bot.id);
    assert.equal(entry.dropped, 0);
    assert.equal(entry.stale, 0);
  }
});

test("thinking happens after the tick, not inside it (so /api/stats tickMs measures the simulation)", async () => {
  const { room, match } = arena();
  const bot = newBot({ defer: setImmediate });
  join(bot, room);
  const entry = match.entries.get(bot.id);
  match.tick();
  assert.equal(entry.queue.length, 0, "no input yet: the bot has not had a turn");
  await new Promise((r) => setImmediate(r));
  assert.equal(entry.queue.length, 1, "it answered once the event loop got to it");
});

test("if two snapshots arrive before the bot thinks, it answers only the newest", async () => {
  const { room, match } = arena();
  const bot = newBot({ defer: setImmediate });
  join(bot, room);
  match.tick();
  match.tick();
  await new Promise((r) => setImmediate(r));
  const entry = match.entries.get(bot.id);
  assert.equal(entry.lastSeqIn, 1);
  assert.equal(entry.queue.length, 1);
});

test("a bot ignores everything that is not a game snapshot (roster, chat, joined)", () => {
  const { room } = arena();
  let turns = 0;
  const bot = newBot({ defer: () => turns++ });
  join(bot, room);
  bot.send('{"v":1,"type":"roster","room":"test","players":[]}', { critical: true });
  bot.send('{"v":1,"type":"chat"}');
  assert.equal(turns, 0);
});

test("leaving takes the ship out of the world and stops the bot for good", () => {
  const { room, match } = arena();
  const bot = newBot();
  join(bot, room);
  ticks(match, 5);
  bot.leave();
  assert.equal(room.size, 0);
  assert.equal(match.entries.has(bot.id), false);
  assert.equal(match.world.players.has(bot.id), false);
  bot.leave(); // twice is fine
  assert.doesNotThrow(() => ticks(match, 5));
});

test("a full room refuses a bot and leaves nothing behind", () => {
  const { room, match } = arena({ maxPlayers: 1 });
  join(newBot(), room);
  const late = newBot();
  assert.throws(() => late.join(room), RoomFullError);
  assert.equal(match.entries.size, 1);
  assert.equal(room.size, 1);
});

test("a bug in a bot is contained: it is reported, the bot leaves, the match keeps ticking", () => {
  const { room, match } = arena();
  const errors = [];
  const brain = {
    get fireArc() {
      throw new Error("boom");
    },
  };
  const bot = newBot({ brain, onError: (e) => errors.push(e.message) });
  const other = newBot();
  join(bot, room);
  join(other, room);
  assert.doesNotThrow(() => ticks(match, 5));
  assert.deepEqual(errors, ["boom"]);
  assert.equal(match.entries.has(bot.id), false, "the broken bot is gone");
  assert.equal(match.entries.has(other.id), true, "the healthy one carries on");
});

// ---- BotManager -----------------------------------------------------------------------------------

function manager(room) {
  const m = new BotManager({ rng: mulberry32(7), defer: sync, log: quiet });
  return { m, add: (n) => m.add(room, n).map((b) => (room.match.stop(), b)) };
}

test("BotManager adds bots with distinct names and slots, and removes them all again", () => {
  const { room } = arena();
  const { m, add } = manager(room);
  const bots = add(3);
  assert.equal(m.count(room), 3);
  assert.equal(room.size, 3);
  assert.equal(new Set(bots.map((b) => b.name)).size, 3);
  assert.deepEqual(
    bots.map((b) => b.slot),
    [0, 1, 2],
  );
  assert.equal(m.removeAll(room), 3);
  assert.equal(room.size, 0);
  assert.equal(m.count(room), 0);
  assert.equal(m.removeAll(room), 0);
});

test("BotManager is all-or-nothing: asking for more bots than there is room for adds none", () => {
  const { room, match } = arena({ maxPlayers: 4 });
  const { m, add } = manager(room);
  add(2);
  assert.throws(() => m.add(room, 3), RoomFullError);
  assert.equal(room.size, 2);
  assert.equal(match.entries.size, 2);
});

test("BotManager forgets a room that closes", () => {
  const { manager: rm, room } = arena();
  const { m, add } = manager(room);
  add(2);
  rm.delete(room.id);
  assert.equal(m.count(room), 0);
});
