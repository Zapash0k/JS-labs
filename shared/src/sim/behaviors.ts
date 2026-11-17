import { Vector2 } from "./vector.ts";
import type { Behavior, Entity } from "./entity.ts";
import type { SimEntity, SimKind, World } from "./world.ts";

const TAU = Math.PI * 2;
const angleDiff = (a: number, b: number): number =>
  ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

export interface HomingOptions {
  seek: SimKind;
  turnRate?: number;
}

// Composition: a behavior is a small object attached to any entity.
// homing() works on a bullet or an asteroid without a shared subclass.
export function homing({ seek, turnRate = 2 }: HomingOptions): Behavior {
  return {
    name: "homing",
    update(e: Entity, dt: number, world: World | null): void {
      const speed = e.vel.length();
      if (!world || speed === 0) return;
      let best: SimEntity | null = null;
      let bestD = Infinity;
      for (const t of world.ofKind(seek)) {
        const d = t.pos.sub(e.pos).dot(t.pos.sub(e.pos));
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      if (!best) return;
      const cur = Math.atan2(e.vel.y, e.vel.x);
      const want = Math.atan2(best.pos.y - e.pos.y, best.pos.x - e.pos.x);
      const max = turnRate * dt;
      const turn = Math.max(-max, Math.min(max, angleDiff(cur, want)));
      e.vel = Vector2.fromAngle(cur + turn, speed);
    },
  };
}
