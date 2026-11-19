// Server-side AI players (Lab 07, M4).
//
// A Bot is a *player*, exactly like a WebSocket client: the Match hands it every snapshot through
// player.send(), and it answers with ONE input per snapshot through match.receiveInput(). The input
// takes the same road as a human's 12 bytes (codec.encodeInput -> codec.decodeInput), so the Match
// cannot tell a bot from a person, and the bots exercise the real code path (queue, ack, prediction
// inputs, snapshot encoding) instead of poking at the World.
//
//   decide(snapshot, slot, options)   pure: what the bot wants to do this tick
//   class Bot                         a player that listens and answers
//   class BotManager                  adds / removes bots per room (used by POST /api/rooms/:id/bots)
//
// The bot's thinking runs in setImmediate, not inside Match.tick(): the tick's own timing
// (/api/stats tickMs) then measures the simulation, not the bots. The bots still run in this process,
// so they cost event-loop time like any other work; for a clean capacity number use the load test.
import { getCodec } from "@dogfight/shared/codec/index.js";
import { NO_SLOT, WORLD_SIZE } from "@dogfight/shared/protocol.js";
import { RoomFullError, newPlayerId } from "./rooms.js";

const TAU = Math.PI * 2;
const wrapAngle = (a) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
/** Shortest signed distance on a wrap-around axis. */
const wrapDelta = (d, size) => (Math.abs(d) > size / 2 ? d - Math.sign(d) * size : d);
const clamp1 = (x) => Math.max(-1, Math.min(1, x));
const SHIP_RADIUS = 12;

export const IDLE = Object.freeze({ thrust: false, turn: 0, fire: false });

export const DEFAULT_BRAIN = Object.freeze({
  fireArc: 0.12, // rad: shoot when the target is this close to dead ahead
  fireRange: 450, // px
  standOff: 140, // px: stop thrusting this close to a target (no ramming)
  dangerMargin: 70, // px of clearance from an asteroid's edge that starts an evasion
});

/**
 * What a bot wants to do this tick. Pure: the same snapshot, slot and options always give the same
 * command, which is what makes bots testable. `phase` only shapes the wandering path.
 *
 * Priorities: 1. dodge an asteroid that is close; 2. chase and shoot the nearest other ship;
 * 3. shoot a nearby asteroid for points; 4. wander.
 * `snap` is a decoded snapshot: { tick, self, entities } (self is null while the bot is dead).
 */
export function decide(snap, slot, { phase = 0, ...brain } = {}) {
  const { fireArc, fireRange, standOff, dangerMargin } = { ...DEFAULT_BRAIN, ...brain };
  const me = snap.self;
  if (!me) return IDLE; // dead: the world respawns us after a couple of seconds

  const { w, h } = WORLD_SIZE;
  let shipD = Infinity;
  let shipDx = 0;
  let shipDy = 0;
  let rockGap = Infinity; // distance between the two edges, not the centres
  let rockDx = 0;
  let rockDy = 0;
  for (const e of snap.entities) {
    if (e.kind === "ship") {
      if (e.slot === slot) continue; // that is us
      const dx = wrapDelta(e.x - me.x, w);
      const dy = wrapDelta(e.y - me.y, h);
      const d = Math.hypot(dx, dy);
      if (d < shipD) [shipD, shipDx, shipDy] = [d, dx, dy];
    } else if (e.kind === "asteroid") {
      const dx = wrapDelta(e.x - me.x, w);
      const dy = wrapDelta(e.y - me.y, h);
      const gap = Math.hypot(dx, dy) - e.radius - SHIP_RADIUS;
      if (gap < rockGap) [rockGap, rockDx, rockDy] = [gap, dx, dy];
    }
  }

  /** Turn towards (dx, dy); returns the angle error so callers can decide about thrust and fire. */
  const aim = (dx, dy) => wrapAngle(Math.atan2(dy, dx) - me.angle);
  // Proportional turn: a gain of 3 closes a 0.1 rad error without overshooting (one tick turns at most 0.117 rad).
  const steer = (err) => clamp1(err * 3);

  if (rockGap < dangerMargin) {
    const err = aim(-rockDx, -rockDy); // face directly away from the rock
    return { thrust: Math.abs(err) < 0.7, turn: steer(err), fire: false };
  }

  if (shipD < Infinity) {
    const err = aim(shipDx, shipDy);
    return {
      thrust: Math.abs(err) < 0.9 && shipD > standOff,
      turn: steer(err),
      fire: Math.abs(err) < fireArc && shipD < fireRange,
    };
  }

  if (rockGap < fireRange) {
    const err = aim(rockDx, rockDy);
    return { thrust: false, turn: steer(err), fire: Math.abs(err) < fireArc };
  }

  // Nobody in sight: drift along a slow sine-shaped turn, different for every bot.
  return { thrust: true, turn: Math.sin(snap.tick * 0.05 + phase) * 0.6, fire: false };
}

const wireBytes = (data) => (typeof data === "string" ? Buffer.byteLength(data) : data.byteLength);

/** A player that plays by itself. It has the same shape as the player object ws.js builds for a socket. */
export class Bot {
  isBot = true;
  bytesIn = 0;
  bytesOut = 0;
  slot = NO_SLOT;

  #codec;
  #phase;
  #brain;
  #defer;
  #onError;
  #match = null;
  #room = null;
  #closed = false;
  #scheduled = false;
  #latest = null;
  #seq = 0;

  constructor({
    name,
    codec = "binary",
    rng = Math.random,
    defer = setImmediate,
    brain = {},
    onError = (err) => console.error("[bot]", err),
  }) {
    this.id = newPlayerId();
    this.name = name;
    this.codec = codec; // the name; the match looks it up to encode this bot's snapshots
    this.#codec = getCodec(codec);
    this.#phase = rng() * TAU;
    this.#brain = brain;
    this.#defer = defer;
    this.#onError = onError;
  }

  /** Same order as a human join in ws.js: the match first (that assigns the slot), then the room. */
  join(room) {
    if (room.size >= room.maxPlayers) throw new RoomFullError(room);
    if (!room.match) throw new Error(`room ${room.id} has no match`);
    this.#match = room.match;
    this.#room = room;
    this.slot = room.match.addPlayer(this);
    room.once("closed", () => (this.#closed = true)); // nothing to answer once the room is gone
    room.join(this);
  }

  leave() {
    if (this.#closed) return;
    this.#closed = true;
    this.#room?.leave(this); // emits "leave": the match drops our ship, the roster updates
  }

  /** What `send` is for a human socket: everything the server says to this player lands here. */
  send(data, { game = false } = {}) {
    if (!game || this.#closed) return; // roster / chat / joined: nothing a bot needs
    this.bytesOut += wireBytes(data);
    this.#latest = data; // if two arrive before we think, answer only the newest
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#defer(this.#think);
  }

  #think = () => {
    this.#scheduled = false;
    if (this.#closed || this.#latest === null) return;
    try {
      const snap = this.#codec.decodeSnapshot(this.#latest);
      const want = decide(snap, this.slot, { ...this.#brain, phase: this.#phase });
      const wire = this.#codec.encodeInput({ seq: ++this.#seq, tick: snap.tick, ...want });
      this.bytesIn += wireBytes(wire);
      this.#match.receiveInput(this.id, this.#codec.decodeInput(wire));
    } catch (err) {
      // A bug in a bot must never take the server down: report it and take the bot out of the room.
      this.#onError(err);
      this.leave();
    }
  };
}

/** Adds and removes the bots of each room. */
export class BotManager {
  #byRoom = new Map(); // room.id -> Set<Bot>
  #count = 0;

  constructor({ rng = Math.random, defer, log = console, codec = "binary", brain = {} } = {}) {
    this.options = { rng, defer, codec, brain };
    this.log = log;
  }

  count(room) {
    return this.#byRoom.get(room.id)?.size ?? 0;
  }

  /** Adds `n` bots, or throws RoomFullError and adds none. */
  add(room, n) {
    if (room.size + n > room.maxPlayers) throw new RoomFullError(room);
    const bots = this.#byRoom.get(room.id) ?? new Set();
    if (!this.#byRoom.has(room.id)) {
      this.#byRoom.set(room.id, bots);
      room.once("closed", () => this.#byRoom.delete(room.id));
    }
    const added = [];
    try {
      for (let i = 0; i < n; i++) {
        const bot = new Bot({
          ...this.options,
          name: `Bot ${++this.#count}`,
          onError: (err) => this.log.error("[bot]", err),
        });
        bot.join(room);
        bots.add(bot);
        added.push(bot);
      }
    } catch (err) {
      for (const bot of added) (bot.leave(), bots.delete(bot)); // all or nothing
      throw err;
    }
    return added;
  }

  /** Takes every bot out of the room; returns how many left. */
  removeAll(room) {
    const bots = this.#byRoom.get(room.id);
    if (!bots) return 0;
    const n = bots.size;
    for (const bot of bots) bot.leave();
    bots.clear();
    return n;
  }
}
