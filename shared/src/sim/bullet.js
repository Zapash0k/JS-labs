import { Entity } from "./entity.js";

export class Bullet extends Entity {
  constructor(x, y, vel, owner = null) {
    super(x, y, { kind: "bullet", radius: 3 });
    this.vel = vel;
    this.owner = owner;
    this.damage = 10;
    this.ttl = 2;
    this.fireSeq = 0; // sequence number of the input that fired it (matches predicted bullets)
  }

  think(dt) {
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
  }
}
