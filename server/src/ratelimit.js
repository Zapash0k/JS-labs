// Token bucket: holds up to `capacity` tokens, refills `perSec` per second.
// take() spends one token; false means "over the limit". Clock is injectable for tests.
export class TokenBucket {
  #tokens;
  #last;
  constructor({ capacity, perSec, now = () => performance.now() }) {
    this.capacity = capacity;
    this.perSec = perSec;
    this.now = now;
    this.#tokens = capacity;
    this.#last = now();
  }

  take(cost = 1) {
    const t = this.now();
    this.#tokens = Math.min(this.capacity, this.#tokens + ((t - this.#last) / 1000) * this.perSec);
    this.#last = t;
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }
}
