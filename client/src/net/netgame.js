// Client side of the authoritative-server model (Lab 05). No DOM here, so it also runs in Node tests.
//   step(dt, input)   every simulation step (30 Hz): send the input, predict the local ship
//   handle snapshots  reconcile the local ship with the server, buffer the others for interpolation
//   drawables(...)    what to draw this frame
import { NO_SLOT, TICK_DT, TICK_HZ, WORLD_SIZE } from "@dogfight/shared/protocol.js";
import { getCodec } from "@dogfight/shared/codec/index.js";
import { mulberry32 } from "@dogfight/shared/prng.js";
import { Explosion } from "@dogfight/shared/sim/explosion.js";
import { commandFromInput, stepShipState } from "@dogfight/shared/sim/shipPhysics.js";
import { Interpolator } from "./interpolation.js";

const HISTORY = 120;
const MAX_PENDING = 120;
const SNAP_THRESHOLD = 100; // px: a bigger disagreement (respawn, teleport) is not smoothed

const push = (xs, v) => {
  xs.push(v);
  if (xs.length > HISTORY) xs.shift();
};
const wrapDelta = (a, b, size) => {
  const d = a - b;
  return Math.abs(d) > size / 2 ? d - Math.sign(d) * size : d;
};
const shapeCache = new Map();
const asteroidShape = (id) => {
  if (!shapeCache.has(id)) {
    const rng = mulberry32(id + 1);
    shapeCache.set(
      id,
      Array.from({ length: 10 }, () => 0.75 + rng() * 0.35),
    );
  }
  return shapeCache.get(id);
};

export class NetGame {
  constructor({
    conn,
    codec = "binary",
    slot,
    world = WORLD_SIZE,
    tickHz = TICK_HZ,
    now = () => performance.now(),
    options = {},
  }) {
    this.conn = conn;
    this.codec = getCodec(codec);
    this.slot = slot;
    this.world = world;
    this.tickMs = 1000 / tickHz;
    this.now = now;
    this.options = {
      predict: true, // false = the "dumb client" of M1: the ship moves only when a snapshot arrives
      reconcile: true, // false = predict but never correct (watch it drift)
      smoothMs: 100, // visual smoothing of corrections
      nondeterministic: false, // inject randomness into prediction (the determinism-break experiment)
      ...options,
    };
    this.events = new EventTarget(); // "fired" | "hit" | "exploded", detail { pos: {x, y} }
    this.interp = new Interpolator({ tickMs: this.tickMs, world, delayMs: 2 * this.tickMs });
    this.explosions = [];
    this.stats = {
      rtt: 0,
      rttHistory: [],
      snapshots: 0,
      snapshotAgeMs: 0,
      snapshotIntervalMs: 0,
      bytesInPerSec: 0,
      bytesOutPerSec: 0,
      pending: 0,
      correction: 0,
      correctionHistory: [],
      correctionAvg: 0,
      tick: 0,
      hp: 0,
    };
    this.#clear();
    this.lastRecv = null;
    this.#lastBytes = { t: now(), in: conn.bytesIn, out: conn.bytesOut };
    this.#lastPing = -Infinity;

    this.#offs = [
      this.#listen("binary", (e) =>
        this.onSnapshot(this.codec.decodeSnapshot(e.detail), this.now()),
      ),
      this.#listen("message:snapshot", (e) => {
        const { v, type, ...snap } = e.detail; // JSON codec
        void v;
        void type;
        this.onSnapshot(snap, this.now());
      }),
      this.#listen("message:pong", (e) => {
        this.stats.rtt = this.now() - e.detail.t;
        push(this.stats.rttHistory, this.stats.rtt);
      }),
    ];
  }

  #offs = [];
  #lastBytes;
  #lastPing;

  #listen(type, fn) {
    this.conn.addEventListener(type, fn);
    return () => this.conn.removeEventListener(type, fn);
  }

  #clear() {
    this.seq = 0;
    this.lastTick = 0;
    this.pending = []; // inputs sent but not yet acknowledged by a snapshot
    this.local = null; // predicted own ship (plain state)
    this.prevLocal = null;
    this.offset = { x: 0, y: 0 }; // visual smoothing of corrections, decays to 0
    this.bullets = []; // predicted own bullets
    this.serverSelf = null;
    this.interp?.reset();
  }

  /** A new `joined` (after a reconnect): the server forgot us, start over. */
  reset(slot) {
    this.slot = slot;
    this.#clear();
  }

  destroy() {
    this.#offs.forEach((off) => off());
  }

  emit(type, x, y) {
    this.events.dispatchEvent(new CustomEvent(type, { detail: { pos: { x, y } } }));
  }

  // ---- sending + prediction: once per simulation step ----
  step(dt, input) {
    const cmd = this.codec.quantizeCommand({
      seq: ++this.seq,
      tick: this.lastTick,
      ...commandFromInput(input),
    });
    this.conn.sendRaw(this.codec.encodeInput(cmd));
    this.pending.push(cmd);
    if (this.pending.length > MAX_PENDING) this.pending.shift();

    const { w, h } = this.world;
    if (this.local && this.options.predict) {
      this.prevLocal = { ...this.local };
      const spec = stepShipState(this.local, cmd, dt, w, h);
      // The bug, on purpose: anything random in the prediction makes it disagree with the server.
      if (this.options.nondeterministic) {
        this.local.x += (Math.random() - 0.5) * 2; // +-1 px per step
        this.local.y += (Math.random() - 0.5) * 2;
      }
      if (spec) {
        this.emit("fired", spec.x, spec.y);
        if (!spec.homing)
          this.bullets.push({
            seq: cmd.seq,
            x: spec.x,
            y: spec.y,
            px: spec.x,
            py: spec.y,
            vx: spec.vx,
            vy: spec.vy,
            angle: spec.angle,
            ttl: 2,
          });
      }
    }
    for (const b of this.bullets) {
      b.px = b.x;
      b.py = b.y;
      b.ttl -= dt;
      b.x = (((b.x + b.vx * dt) % w) + w) % w;
      b.y = (((b.y + b.vy * dt) % h) + h) % h;
    }
    this.bullets = this.bullets.filter((b) => b.ttl > 0);
    this.stats.pending = this.pending.length;
  }

  // ---- receiving: reconciliation ----
  onSnapshot(snap, recvAt) {
    const s = this.stats;
    if (!this.interp.add(snap, recvAt)) return; // out of order
    s.snapshots++;
    if (this.lastRecv !== null)
      s.snapshotIntervalMs += (recvAt - this.lastRecv - s.snapshotIntervalMs) * 0.1;
    this.lastRecv = recvAt;
    this.lastTick = snap.tick;
    s.tick = snap.tick;

    for (const ev of snap.events) {
      if (ev.type === "fired" && ev.slot === this.slot && this.options.predict) continue; // played when predicted
      this.emit(ev.type, ev.x, ev.y);
      if (ev.type === "exploded") this.explosions.push(new Explosion(ev.x, ev.y, Math.random));
    }

    if (!snap.self) {
      // dead (or not spawned yet): nothing to predict until the server respawns us
      this.local = this.prevLocal = null;
      this.pending = [];
      this.bullets = [];
      this.serverSelf = null;
      s.hp = 0;
      return;
    }
    this.serverSelf = snap.self;
    s.hp = snap.self.hp;
    this.#reconcile(snap);

    // Predicted bullets the server has already seen but no longer has (hit something, expired): drop them.
    const alive = new Set(
      snap.entities
        .filter((e) => e.kind === "bullet" && e.slot === this.slot)
        .map((e) => e.seq & 0xffff),
    );
    this.bullets = this.bullets.filter((b) => b.seq > snap.ack || alive.has(b.seq & 0xffff));
  }

  #reconcile(snap) {
    const s = this.stats;
    const { w, h } = this.world;
    this.pending = this.pending.filter((c) => c.seq > snap.ack); // acknowledged inputs are history

    if (!this.options.predict) {
      this.local = { ...snap.self }; // dumb client: exactly what the server said, one RTT late
      this.prevLocal = { ...snap.self };
      return;
    }
    if (!this.local) {
      this.local = { ...snap.self };
      this.prevLocal = { ...snap.self };
    }

    // Server state at `ack` + replay of every input it has not seen yet = where the server WILL say we are.
    const replayed = { ...snap.self };
    for (const cmd of this.pending) stepShipState(replayed, cmd, TICK_DT, w, h);

    const dx = wrapDelta(this.local.x, replayed.x, w);
    const dy = wrapDelta(this.local.y, replayed.y, h);
    const correction = Math.hypot(dx, dy);
    s.correction = correction;
    push(s.correctionHistory, correction);
    s.correctionAvg = s.correctionHistory.reduce((a, b) => a + b, 0) / s.correctionHistory.length;

    if (!this.options.reconcile) return; // experiment: keep the prediction, ignore the server
    this.local = replayed;
    this.prevLocal = { ...replayed };
    if (correction >= SNAP_THRESHOLD) this.offset = { x: 0, y: 0 };
    else {
      // draw the ship where it WAS and let the offset melt away: the correction is hidden, not removed
      this.offset.x += dx;
      this.offset.y += dy;
    }
  }

  // ---- once per rendered frame ----
  update(frameDt) {
    const now = this.now();
    const k =
      this.options.smoothMs > 0 ? Math.exp(-frameDt / (this.options.smoothMs / 1000 / 3)) : 0;
    this.offset.x *= k;
    this.offset.y *= k;
    for (const e of this.explosions) e.update(frameDt);
    this.explosions = this.explosions.filter((e) => e.alive);

    const st = this.stats;
    st.snapshotAgeMs = this.lastRecv === null ? 0 : now - this.lastRecv;
    if (now - this.#lastBytes.t >= 1000) {
      const secs = (now - this.#lastBytes.t) / 1000;
      st.bytesInPerSec = (this.conn.bytesIn - this.#lastBytes.in) / secs;
      st.bytesOutPerSec = (this.conn.bytesOut - this.#lastBytes.out) / secs;
      this.#lastBytes = { t: now, in: this.conn.bytesIn, out: this.conn.bytesOut };
    }
    if (now - this.#lastPing >= 500) {
      this.#lastPing = now;
      this.conn.send({ type: "ping", t: now });
    }
  }

  setInterpolationDelay(ms) {
    this.interp.delayMs = ms;
  }

  /** Live latency injector (the server applies it to this socket in both directions). */
  setNetsim({ rtt, jitter, drop }) {
    this.conn.send({ type: "netsim", rtt, jitter, drop });
  }

  /** Objects shaped like sim entities, so render/draw.js can draw them unchanged. `alpha` = progress inside the current step. */
  drawables(alpha = 1) {
    const now = this.now();
    const out = [];
    const { predict } = this.options;

    for (const e of this.interp.sample(now)) {
      if (e.kind === "ship" && e.slot === this.slot) continue; // own ship: from the prediction
      if (e.kind === "bullet" && e.slot === this.slot && predict) continue; // own bullets: predicted
      out.push(this.#drawable(e, now));
    }

    const me = this.local;
    if (me) {
      const prev = this.prevLocal ?? me;
      const mix = (a, b, wrap) => (Math.abs(b - a) > wrap / 2 ? b : a + (b - a) * alpha);
      const x = mix(prev.x, me.x, this.world.w) + this.offset.x;
      const y = mix(prev.y, me.y, this.world.h) + this.offset.y;
      out.push({
        kind: "ship",
        alive: true,
        own: true,
        pos: { x, y },
        prevPos: { x, y },
        angle: me.angle,
        prevAngle: me.angle,
        radius: 12,
        thrust: me.thrust,
        shield: me.shield,
        invuln: me.invuln,
        behaviors: [],
      });
    }
    for (const b of this.bullets) {
      const x =
        b.x - b.px > this.world.w / 2 || b.px - b.x > this.world.w / 2
          ? b.x
          : b.px + (b.x - b.px) * alpha;
      const y =
        b.y - b.py > this.world.h / 2 || b.py - b.y > this.world.h / 2
          ? b.y
          : b.py + (b.y - b.py) * alpha;
      out.push({
        kind: "bullet",
        alive: true,
        pos: { x, y },
        prevPos: { x, y },
        angle: b.angle,
        prevAngle: b.angle,
        radius: 3,
        behaviors: [],
      });
    }
    for (const x of this.explosions) out.push(x);
    return out;
  }

  #drawable(e, now) {
    const base = {
      kind: e.kind,
      alive: true,
      pos: { x: e.x, y: e.y },
      prevPos: { x: e.x, y: e.y },
      angle: e.angle,
      prevAngle: e.angle,
      behaviors: [],
      slot: e.slot,
    };
    if (e.kind === "ship") {
      // `invuln` flags blink: a number that sweeps 0..1 each second drives draw.js's blink test
      return {
        ...base,
        radius: 12,
        thrust: e.thrust,
        shield: e.shield ? 1 : 0,
        invuln: e.invuln ? (now % 1000) / 1000 || 0.001 : 0,
      };
    }
    if (e.kind === "bullet")
      return { ...base, radius: 3, behaviors: e.homing ? [{ name: "homing" }] : [] };
    if (e.kind === "asteroid")
      return {
        ...base,
        radius: e.radius,
        shape: asteroidShape(e.id),
        behaviors: e.hunter ? [{ name: "homing" }] : [],
      };
    return { ...base, radius: 12, effect: e.effect };
  }
}

export { NO_SLOT };
