import { Entity } from "./entity.ts";
import type { Ship } from "./ship.ts";
import type { Vector2 } from "./vector.ts";

export class Bullet extends Entity {
  declare readonly kind: "bullet";
  owner: Ship | null;
  damage: number;
  ttl: number;
  fireSeq: number;

  constructor(x: number, y: number, vel: Vector2, owner: Ship | null = null) {
    super(x, y, { kind: "bullet", radius: 3 });
    this.vel = vel;
    this.owner = owner;
    this.damage = 10;
    this.ttl = 2;
    this.fireSeq = 0; // sequence number of the input that fired it (matches predicted bullets)
  }

  override think(dt: number): void {
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
  }
}
