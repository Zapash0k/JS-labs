import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";

// Many short-lived particles in one entity (revisit in Lab 7).
export class Explosion extends Entity {
  static DURATION = 0.7;

  constructor(x, y, rng, count = 24) {
    super(x, y, { kind: "explosion", radius: 0, edge: "none", collidable: false });
    this.ttl = Explosion.DURATION;
    this.particles = Array.from({ length: count }, () => ({
      pos: new Vector2(x, y),
      vel: Vector2.fromAngle(rng() * Math.PI * 2, 40 + rng() * 200),
    }));
  }

  think(dt) {
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
    for (const p of this.particles) p.pos = p.pos.add(p.vel.scale(dt));
  }
}
