import type { SimEntity, World } from "./world.ts";

// Collision *system*: takes the world, returns (a, b) pairs. Naive O(n^2) for now,
// swappable for a spatial hash later without touching World.
export function findCollisions(world: World): [SimEntity, SimEntity][] {
  const list: SimEntity[] = [];
  for (const e of world) if (e.alive && e.collidable) list.push(e);

  const pairs: [SimEntity, SimEntity][] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!a || !b) continue; // noUncheckedIndexedAccess: both always exist here
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      const r = a.radius + b.radius;
      if (dx * dx + dy * dy <= r * r) pairs.push([a, b]);
    }
  }
  return pairs;
}
