// Latency injector (Lab 05). Per socket and per direction it delays messages and can drop game messages.
//   rttMs     round-trip time to add; each direction gets half
//   jitterMs  +- jitter on the RTT; each direction gets half
//   dropPct   % of game messages (inputs, snapshots) silently dropped
// Delivery stays in order (like TCP: a late message holds back the ones behind it). WebSocket is
// reliable, so "drop" is simulated at the application level to see what UDP-style loss would do.
export class NetSim {
  #last = { in: 0, out: 0 }; // earliest delivery time allowed for the next message, per direction
  #queue = { in: [], out: [] }; // messages waiting for their delivery time, in order
  #timer = { in: null, out: null }; // ONE timer per direction, always for the head of the queue

  constructor({
    rttMs = 0,
    jitterMs = 0,
    dropPct = 0,
    random = Math.random,
    now = () => performance.now(),
  } = {}) {
    this.random = random;
    this.now = now;
    this.set({ rttMs, jitterMs, dropPct });
  }

  set({ rttMs, jitterMs, dropPct }) {
    this.rttMs = rttMs;
    this.jitterMs = jitterMs;
    this.dropPct = dropPct;
  }

  get active() {
    return this.rttMs > 0 || this.jitterMs > 0 || this.dropPct > 0;
  }

  shouldDrop() {
    return this.dropPct > 0 && this.random() * 100 < this.dropPct;
  }

  /** Runs fn after the simulated delay for direction "in" (received) or "out" (about to be sent). */
  schedule(direction, fn) {
    const queue = this.#queue[direction];
    if (!this.active && queue.length === 0) return fn();
    const now = this.now();
    const delay = Math.max(0, this.rttMs / 2 + (this.random() * 2 - 1) * (this.jitterMs / 2));
    const at = Math.max(now + delay, this.#last[direction]);
    this.#last[direction] = at;
    queue.push({ at, fn });
    this.#arm(direction);
  }

  // Separate setTimeout calls with nearly equal deadlines can fire out of order in Node (timers are
  // grouped by duration), so only the head of the queue has a timer and it re-arms after each delivery.
  #arm(direction) {
    const queue = this.#queue[direction];
    if (this.#timer[direction] || queue.length === 0) return;
    this.#timer[direction] = setTimeout(
      () => {
        this.#timer[direction] = null;
        queue.shift().fn();
        this.#arm(direction);
      },
      Math.max(0, queue[0].at - this.now()),
    );
  }

  in(fn) {
    this.schedule("in", fn);
  }
  out(fn) {
    this.schedule("out", fn);
  }

  dispose() {
    for (const d of ["in", "out"]) {
      clearTimeout(this.#timer[d]);
      this.#timer[d] = null;
      this.#queue[d].length = 0;
    }
  }
}
