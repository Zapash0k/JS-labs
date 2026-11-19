import { describe, expect, test } from "vitest";
import { TokenBucket } from "../src/ratelimit.js";

// The clock is injected, so these tests never wait.
function bucket(opts) {
  let t = 0;
  const b = new TokenBucket({ ...opts, now: () => t });
  return { b, advance: (ms) => (t += ms) };
}

describe("TokenBucket", () => {
  test("starts full: exactly `capacity` takes succeed at one instant", () => {
    const { b } = bucket({ capacity: 5, perSec: 1 });
    const results = Array.from({ length: 7 }, () => b.take());
    expect(results).toEqual([true, true, true, true, true, false, false]);
  });

  test("refills at perSec tokens per second", () => {
    const { b, advance } = bucket({ capacity: 3, perSec: 2 });
    for (let i = 0; i < 3; i++) b.take();
    expect(b.take()).toBe(false);
    advance(500); // +1 token
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  test("never holds more than `capacity`, however long it idles", () => {
    const { b, advance } = bucket({ capacity: 4, perSec: 10 });
    advance(3_600_000); // an hour
    const results = Array.from({ length: 6 }, () => b.take());
    expect(results.filter(Boolean)).toHaveLength(4);
  });

  test("a refused take does not spend tokens", () => {
    const { b, advance } = bucket({ capacity: 2, perSec: 1 });
    expect(b.take(3)).toBe(false); // costs more than the bucket can hold
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    advance(1000);
    expect(b.take()).toBe(true);
  });

  test("cost > 1 spends several tokens at once", () => {
    const { b } = bucket({ capacity: 5, perSec: 0 });
    expect(b.take(3)).toBe(true);
    expect(b.take(3)).toBe(false);
    expect(b.take(2)).toBe(true);
  });

  test("the sustained rate over a long run matches perSec", () => {
    const { b, advance } = bucket({ capacity: 30, perSec: 30 });
    let ok = 0;
    for (let i = 0; i < 3000; i++) {
      advance(10); // 100 attempts per second for 30 s, but only 30 tokens per second come back
      if (b.take()) ok++;
    }
    // everything the bucket ever had: the 30 it started with + 30 s * 30/s
    expect(ok).toBeGreaterThanOrEqual(30 + 30 * 30 - 2);
    expect(ok).toBeLessThanOrEqual(30 + 30 * 30);
  });
});
