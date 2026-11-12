import { Entity } from "./entity.js";

// Effect name -> duration in seconds. Data, not subclasses.
export const EFFECTS = { shield: 6, rapid: 8, homing: 8 };

// Stationary and collidable, but not a ship: it only extends Entity.
export class Pickup extends Entity {
  constructor(x, y, effect) {
    super(x, y, { kind: "pickup", radius: 12, edge: "none" });
    this.effect = effect;
    this.ttl = 15;
  }

  think(dt) {
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
  }
}
