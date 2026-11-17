import { Entity } from "./entity.ts";
import { Vector2 } from "./vector.ts";
import type { Rng } from "../prng.ts";

export interface Particle {
  pos: Vector2;
  vel: Vector2;
}

// Many short-lived particles in one entity (revisit in Lab 7).
export class Explosion extends Entity {
  declare readonly kind: "explosion";
  static DURATION = 0.7;
  ttl: number;
  particles: Particle[];

  constructor(x: number, y: number, rng: Rng, count = 24) {
    super(x, y, { kind: "explosion", radius: 0, edge: "none", collidable: false });
    this.ttl = Explosion.DURATION;
    this.particles = Array.from({ length: count }, () => ({
      pos: new Vector2(x, y),
      vel: Vector2.fromAngle(rng() * Math.PI * 2, 40 + rng() * 200),
    }));
  }

  override think(dt: number): void {
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
    for (const p of this.particles) p.pos = p.pos.add(p.vel.scale(dt));
  }
}
