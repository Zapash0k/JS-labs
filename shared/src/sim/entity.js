import { Vector2 } from "./vector.js";

// Base class for everything in the world. Inheritance stops at one level:
// Ship / Bullet / Asteroid / Pickup / Explosion extend Entity, nothing extends them.
// Extra behavior is attached as composition via `behaviors` (see behaviors.js).
export class Entity {
  constructor(
    x = 0,
    y = 0,
    { kind = "entity", radius = 10, edge = "wrap", collidable = true } = {},
  ) {
    this.id = null; // assigned by World.spawn (deterministic per world, same on server and client)
    this.kind = kind;
    this.radius = radius;
    this.edge = edge; // "wrap" | "bounce" | "none" — how the arena treats this entity
    this.collidable = collidable;
    this.pos = new Vector2(x, y);
    this.vel = new Vector2();
    this.angle = 0;
    this.prevPos = this.pos; // safe: positions are replaced, never mutated in place
    this.prevAngle = 0;
    this.alive = true;
    this.world = null; // set by World.spawn
    this.behaviors = []; // composed behaviors: { update(entity, dt, world) }
  }

  update(dt, world = this.world, input = null) {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
    for (const b of this.behaviors) b.update(this, dt, world);
    this.think(dt, world, input);
    this.pos = this.pos.add(this.vel.scale(dt));
  }

  think() {} // subclass hook: runs after behaviors, before movement
  onDeath() {} // subclass hook: called once when the world sweeps this entity
}
