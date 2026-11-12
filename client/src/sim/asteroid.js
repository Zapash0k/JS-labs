import { Entity } from "./entity.js";

export class Asteroid extends Entity {
  #hp = 30;

  constructor(x, y, vel, rng = Math.random) {
    super(x, y, { kind: "asteroid", radius: 28, edge: "bounce" });
    this.vel = vel;
    this.spin = (rng() - 0.5) * 1.5;
    this.shape = Array.from({ length: 10 }, () => 0.75 + rng() * 0.35);
  }

  get hp() {
    return this.#hp;
  }

  takeDamage(amount) {
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) this.alive = false;
  }

  think(dt) {
    this.angle += this.spin * dt;
  }

  onDeath(world) {
    world.spawnExplosion(this.pos);
  }
}
