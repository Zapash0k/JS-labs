import { Entity } from "./entity.ts";
import type { Effect } from "../constants.ts";

// Effect name -> duration in seconds. Data, not subclasses.
export const EFFECTS: Readonly<Record<Effect, number>> = { shield: 6, rapid: 8, homing: 8 };

// Stationary and collidable, but not a ship: it only extends Entity.
export class Pickup extends Entity {
  declare readonly kind: "pickup";
  effect: Effect;
  ttl: number;

  constructor(x: number, y: number, effect: Effect) {
    super(x, y, { kind: "pickup", radius: 12, edge: "none" });
    this.effect = effect;
    this.ttl = 15;
  }

  override think(dt: number): void {
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
  }
}
