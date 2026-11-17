import { Entity } from "./entity.ts";
import type { Rng } from "../prng.ts";
import type { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";

export class Asteroid extends Entity {
  declare readonly kind: "asteroid";
  #hp = 30;
  spin: number;
  shape: number[];

  constructor(x: number, y: number, vel: Vector2, rng: Rng) {
    super(x, y, { kind: "asteroid", radius: 28, edge: "bounce" });
    this.vel = vel;
    this.spin = (rng() - 0.5) * 1.5;
    this.shape = Array.from({ length: 10 }, () => 0.75 + rng() * 0.35);
  }

  get hp(): number {
    return this.#hp;
  }

  takeDamage(amount: number): void {
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) this.alive = false;
  }

  override think(dt: number): void {
    this.angle += this.spin * dt;
  }

  override onDeath(world: World): void {
    world.spawnExplosion(this.pos);
  }
}
