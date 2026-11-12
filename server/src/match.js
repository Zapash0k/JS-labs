// One authoritative match per room (Lab 05): the shared World stepped at TICK_HZ, inputs applied,
// a snapshot sent to every player after every tick.
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { mulberry32 } from "@dogfight/shared/prng.js";
import { NO_SLOT, TICK_DT, TICK_HZ, WORLD_SIZE, netId } from "@dogfight/shared/protocol.js";
import { World } from "@dogfight/shared/sim/world.js";
import { getCodec } from "@dogfight/shared/codec/index.js";

const MAX_QUEUE = 8; // inputs waiting per player; more than this and the oldest is dropped
const MAX_EVENTS = 40; // u8 count in the binary snapshot, and plenty for one tick
const WINDOW = TICK_HZ * 5; // stats look at the last 5 seconds

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const push = (xs, v) => {
  xs.push(v);
  if (xs.length > WINDOW) xs.shift();
};

export class Match {
  #timer = null;
  #next = 0;
  #lastStart = null;
  #running = false;
  #events = [];
  #second = { ticks: 0, out: 0, in: 0, outPerSec: 0, inPerSec: 0 };

  constructor({ room, now = () => performance.now(), log = console }) {
    this.room = room;
    this.now = now;
    this.log = log;
    this.stepMs = 1000 / TICK_HZ;
    this.seed = randomBytes(4).readUInt32LE();
    const { asteroids = 0, pickups = false } = room.arena;
    this.world = new World(WORLD_SIZE, {
      hazards: asteroids > 0,
      rng: mulberry32(this.seed),
      asteroidTarget: asteroids,
      pickups,
    });
    this.world.startHazards();
    this.tickNumber = 0;
    this.entries = new Map(); // player.id -> { player, slot, queue, lastSeqIn, ack, ... }
    this.tickMs = []; // how long each tick took
    this.jitterMs = []; // |actual interval - 33.3 ms|
    this.overruns = 0; // ticks that took longer than the interval
    this.skipped = 0; // times we gave up catching up

    for (const type of ["fired", "hit", "exploded"]) {
      this.world.events.addEventListener(type, (e) => {
        const who = e.detail.owner ?? e.detail.target;
        this.#events.push({
          type,
          slot: who?.kind === "ship" ? (who.slot ?? NO_SLOT) : NO_SLOT,
          x: e.detail.pos.x,
          y: e.detail.pos.y,
        });
      });
    }
    room.on("leave", (player) => this.removePlayer(player));
    room.once("closed", () => this.stop());
  }

  get running() {
    return this.#running;
  }

  /** Called by the WebSocket layer before it sends `joined`. Returns the player's slot. */
  addPlayer(player) {
    const taken = new Set([...this.entries.values()].map((e) => e.slot));
    let slot = 0;
    while (taken.has(slot)) slot++;
    this.world.addPlayer(player.id, { remote: true, slot });
    player.slot = slot;
    this.entries.set(player.id, {
      player,
      slot,
      queue: [],
      lastSeqIn: 0,
      ack: 0,
      dropped: 0,
      stale: 0,
      lastOut: 0,
      lastIn: 0,
    });
    this.start();
    return slot;
  }

  removePlayer(player) {
    if (!this.entries.delete(player.id)) return;
    this.world.removePlayer(player.id);
    if (this.entries.size === 0) this.stop();
  }

  /** `cmd` is already validated: { seq, tick, thrust, turn, fire }. */
  receiveInput(playerId, cmd) {
    const entry = this.entries.get(playerId);
    if (!entry) return;
    if (cmd.seq <= entry.lastSeqIn) {
      entry.stale++; // duplicate or reordered
      return;
    }
    entry.lastSeqIn = cmd.seq;
    entry.queue.push(cmd);
    if (entry.queue.length > MAX_QUEUE) {
      entry.queue.shift();
      entry.dropped++;
    }
  }

  // ---- the clock: each tick is scheduled against an ABSOLUTE target time ----
  // setInterval(tick, 33) drifts (each callback starts late and the lateness accumulates) and
  // coalesces after a stall. Here the next deadline is `previous deadline + step`, so one late tick
  // is followed by a shorter wait and the average rate stays exactly TICK_HZ.
  start() {
    if (this.#running) return;
    this.#running = true;
    this.#lastStart = null;
    this.#next = this.now() + this.stepMs;
    this.#timer = setTimeout(this.#loop, this.stepMs);
  }

  stop() {
    this.#running = false;
    clearTimeout(this.#timer);
  }

  #loop = () => {
    if (!this.#running) return;
    const start = this.now();
    if (this.#lastStart !== null)
      push(this.jitterMs, Math.abs(start - this.#lastStart - this.stepMs));
    this.#lastStart = start;

    this.tick();

    const duration = this.now() - start;
    push(this.tickMs, duration);
    if (duration > this.stepMs) this.overruns++; // CPU-bound: the tick itself is slower than the interval (Lab 07)
    this.#next += this.stepMs;
    if (this.now() - this.#next > this.stepMs * 4) {
      this.skipped++; // far behind (a long stall): do not burst through the missed ticks
      this.#next = this.now() + this.stepMs;
    }
    this.#timer = setTimeout(this.#loop, Math.max(0, this.#next - this.now()));
  };

  /** One simulation step + one snapshot per player. Public so tests can drive it without timers. */
  tick() {
    for (const [playerId, entry] of this.entries) {
      const cmd = entry.queue.shift() ?? null; // one input per tick; none = the ship stalls
      if (cmd) entry.ack = cmd.seq;
      this.world.setCommand(playerId, cmd);
    }
    this.#events.length = 0;
    this.world.step(TICK_DT);
    this.tickNumber++;

    const entities = this.#entities();
    const events = this.#events.slice(0, MAX_EVENTS);
    for (const [playerId, entry] of this.entries) {
      const rec = this.world.players.get(playerId);
      const ship = rec?.ship;
      const self = ship?.alive ? { ...ship.toState(), hp: ship.hp } : null;
      const codec = getCodec(entry.player.codec ?? "binary");
      entry.player.send(
        codec.encodeSnapshot({ tick: this.tickNumber, ack: entry.ack, self, entities, events }),
        {
          game: true,
        },
      );
    }
    this.#countSecond();
  }

  #entities() {
    const out = [];
    for (const e of this.world) {
      if (!e.alive) continue;
      const base = { id: netId(e.id), kind: e.kind, x: e.pos.x, y: e.pos.y, angle: e.angle };
      if (e.kind === "ship") {
        out.push({
          ...base,
          slot: e.slot ?? NO_SLOT,
          hp: e.hp,
          thrust: e.thrust,
          shield: e.shield > 0,
          invuln: e.invuln > 0,
        });
      } else if (e.kind === "bullet") {
        out.push({
          ...base,
          slot: e.owner?.slot ?? NO_SLOT,
          seq: e.fireSeq,
          homing: e.behaviors.length > 0,
        });
      } else if (e.kind === "asteroid") {
        out.push({
          ...base,
          radius: e.radius,
          hunter: e.behaviors.some((b) => b.name === "homing"),
        });
      } else if (e.kind === "pickup") {
        out.push({ ...base, effect: e.effect });
      }
    }
    return out;
  }

  #countSecond() {
    const s = this.#second;
    if (++s.ticks < TICK_HZ) return;
    let out = 0;
    let inn = 0;
    for (const { player } of this.entries.values()) {
      out += player.bytesOut ?? 0;
      inn += player.bytesIn ?? 0;
    }
    const n = Math.max(1, this.entries.size);
    s.outPerSec = (out - s.out) / n; // per client
    s.inPerSec = (inn - s.in) / n;
    s.out = out;
    s.in = inn;
    s.ticks = 0;
  }

  stats() {
    return {
      room: this.room.id,
      players: this.entries.size,
      tick: this.tickNumber,
      tickRate: TICK_HZ,
      tickMs: { avg: round(avg(this.tickMs)), max: round(Math.max(0, ...this.tickMs)) },
      jitterMs: { avg: round(avg(this.jitterMs)), max: round(Math.max(0, ...this.jitterMs)) },
      overruns: this.overruns,
      skipped: this.skipped,
      bytesPerSecPerClient: {
        down: Math.round(this.#second.outPerSec),
        up: Math.round(this.#second.inPerSec),
      },
      inputsDropped: [...this.entries.values()].reduce((a, e) => a + e.dropped, 0),
    };
  }
}

const round = (n) => Math.round(n * 1000) / 1000;
