// Entity interpolation (Lab 05, M3): remote entities are drawn `delayMs` in the PAST, between the two
// snapshots that bracket that moment, instead of "at the latest snapshot" (which would stutter at 30 Hz).
//
// Timeline: every snapshot has a server time t = tick * tickMs. We estimate (serverTime - localTime) from
// arrival times with a slow moving average; then renderTime = localNow + offset - delayMs.
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
const lerpAngle = (a, b, t) => a + (((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI) * t;

export class Interpolator {
  constructor({ tickMs, world, delayMs = 2 * tickMs, maxSnapshots = 90 }) {
    this.tickMs = tickMs;
    this.world = world;
    this.delayMs = delayMs;
    this.maxSnapshots = maxSnapshots;
    this.snaps = []; // { tick, t, entities: Map(id -> entity) }
    this.offset = null; // serverTime - localTime, smoothed
    this.starved = 0; // frames where renderTime was past the newest snapshot (buffer ran dry)
  }

  reset() {
    this.snaps.length = 0;
    this.offset = null;
  }

  add(snap, recvAt) {
    const last = this.snaps.at(-1);
    if (last && snap.tick <= last.tick) return false; // old or duplicate
    const t = snap.tick * this.tickMs;
    const sample = t - recvAt;
    if (this.offset === null || Math.abs(sample - this.offset) > 250) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.05;
    this.snaps.push({ tick: snap.tick, t, entities: new Map(snap.entities.map((e) => [e.id, e])) });
    if (this.snaps.length > this.maxSnapshots) this.snaps.shift();
    return true;
  }

  /** Server time we are drawing right now. */
  renderTime(now) {
    return now + (this.offset ?? 0) - this.delayMs;
  }

  /** Interpolated entities at local time `now`. Returns plain objects (copies of the newer snapshot's entity). */
  sample(now) {
    const { snaps } = this;
    if (snaps.length === 0) return [];
    const rt = this.renderTime(now);
    let i = snaps.length - 1;
    while (i > 0 && snaps[i].t > rt) i--;
    const a = snaps[i];
    if (i === snaps.length - 1) {
      if (rt > a.t) this.starved++;
      return [...a.entities.values()]; // newest snapshot: nothing to interpolate towards
    }
    const b = snaps[i + 1];
    if (rt <= a.t) return [...a.entities.values()]; // before the oldest snapshot we have
    const f = (rt - a.t) / (b.t - a.t);

    const out = [];
    for (const eb of b.entities.values()) {
      const ea = a.entities.get(eb.id);
      if (!ea || ea.kind !== eb.kind) continue; // appears at b.t: not there yet at render time
      out.push({
        ...eb,
        // an axis that wrapped between the snapshots is not interpolated (it would streak across the arena)
        x: Math.abs(eb.x - ea.x) > this.world.w / 2 ? eb.x : lerp(ea.x, eb.x, f),
        y: Math.abs(eb.y - ea.y) > this.world.h / 2 ? eb.y : lerp(ea.y, eb.y, f),
        angle: lerpAngle(ea.angle, eb.angle, f),
      });
    }
    for (const ea of a.entities.values()) if (!b.entities.has(ea.id)) out.push(ea); // disappears at b.t
    return out;
  }
}
