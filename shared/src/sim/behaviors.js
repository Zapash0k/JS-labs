import { Vector2 } from "./vector.js";

const TAU = Math.PI * 2;
const angleDiff = (a, b) => ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

// Composition: a behavior is a small object attached to any entity.
// homing() works on a bullet or an asteroid without a shared subclass.
export function homing({ seek, turnRate = 2 }) {
  return {
    name: "homing",
    update(e, dt, world) {
      const speed = e.vel.length();
      if (!world || speed === 0) return;
      let best = null;
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
