import { Vector2 } from "./vector.ts";
import type { Entity } from "./entity.ts";

// Values already inside [0, max) are returned untouched: ((v % max) + max) % max re-rounds them,
// which makes the result depend on how many times it is applied (and breaks exact prediction).
export const wrapCoord = (v: number, max: number): number =>
  v >= 0 && v < max ? v : ((v % max) + max) % max;

// Wrap-around arena. Returns true if the entity crossed an edge this call.
export function wrap(e: Entity, width: number, height: number): boolean {
  const x = wrapCoord(e.pos.x, width);
  const y = wrapCoord(e.pos.y, height);
  const wrapped = x !== e.pos.x || y !== e.pos.y;
  if (wrapped) e.pos = new Vector2(x, y);
  return wrapped;
}

// Bounce off the arena walls (asteroids).
export function bounce(e: Entity, width: number, height: number): void {
  const r = e.radius;
  let { x, y } = e.vel;
  if ((e.pos.x < r && x < 0) || (e.pos.x > width - r && x > 0)) x = -x;
  if ((e.pos.y < r && y < 0) || (e.pos.y > height - r && y > 0)) y = -y;
  if (x !== e.vel.x || y !== e.vel.y) e.vel = new Vector2(x, y);
}

export function contain(e: Entity, width: number, height: number): void {
  if (e.edge === "wrap") wrap(e, width, height);
  else if (e.edge === "bounce") bounce(e, width, height);
}
