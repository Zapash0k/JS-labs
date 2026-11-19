import { describe, expect, test } from "vitest";
import { Vector2 } from "../src/sim/vector.ts";

describe("Vector2", () => {
  test("defaults to the zero vector", () => {
    const v = new Vector2();
    expect([v.x, v.y]).toEqual([0, 0]);
  });

  test("add, sub, scale and dot give the textbook results", () => {
    const a = new Vector2(3, 4);
    const b = new Vector2(-1, 2);
    expect(a.add(b)).toEqual(new Vector2(2, 6));
    expect(a.sub(b)).toEqual(new Vector2(4, 2));
    expect(a.scale(2)).toEqual(new Vector2(6, 8));
    expect(a.dot(b)).toBe(5);
  });

  test("every method returns a new vector and leaves its inputs untouched", () => {
    const a = new Vector2(1, 2);
    const b = new Vector2(3, 4);
    const results = [a.add(b), a.sub(b), a.scale(3), a.normalize(), a.rotate(1), a.clone()];
    for (const r of results) expect(r).not.toBe(a);
    expect([a.x, a.y, b.x, b.y]).toEqual([1, 2, 3, 4]);
  });

  test("length is the Euclidean norm (3-4-5)", () => {
    expect(new Vector2(3, 4).length()).toBe(5);
  });

  test("normalize gives length 1, and the zero vector stays zero instead of NaN", () => {
    expect(new Vector2(10, 0).normalize()).toEqual(new Vector2(1, 0));
    expect(new Vector2(3, 4).normalize().length()).toBeCloseTo(1, 12);
    const zero = new Vector2().normalize();
    expect([zero.x, zero.y]).toEqual([0, 0]);
  });

  test("rotate turns counter-clockwise by the angle (x axis to y axis at 90 degrees)", () => {
    const r = new Vector2(1, 0).rotate(Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.y).toBeCloseTo(1, 12);
  });

  test("fromAngle points along the angle with the requested length", () => {
    const v = Vector2.fromAngle(Math.PI, 5);
    expect(v.x).toBeCloseTo(-5, 12);
    expect(v.y).toBeCloseTo(0, 12);
    expect(Vector2.fromAngle(0.7).length()).toBeCloseTo(1, 12);
  });

  test("clone is equal in value but a different object", () => {
    const a = new Vector2(7, 8);
    const c = a.clone();
    expect(c).toEqual(a);
    expect(c).not.toBe(a);
  });
});
