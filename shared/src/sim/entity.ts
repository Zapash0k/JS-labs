import { Vector2 } from "./vector.ts";
import type { EntityId } from "../brand.ts";
import type { KeyInput } from "./shipPhysics.ts";
import type { World } from "./world.ts";

export type EntityKind = "entity" | "ship" | "bullet" | "asteroid" | "pickup" | "explosion";
export type EdgeMode = "wrap" | "bounce" | "none"; // how the arena treats an entity

/** Composed behavior: a small object attached to any entity (see behaviors.ts). */
export interface Behavior {
  readonly name?: string;
  update(entity: Entity, dt: number, world: World | null): void;
}

export interface EntityOptions {
  kind?: EntityKind;
  radius?: number;
  edge?: EdgeMode;
  collidable?: boolean;
}

// Base class for everything in the world. Inheritance stops at one level:
// Ship / Bullet / Asteroid / Pickup / Explosion extend Entity, nothing extends them.
// Extra behavior is attached as composition via `behaviors` (see behaviors.ts).
//
// Subclasses narrow `kind` with `declare readonly kind: "ship"`: `declare` emits nothing, so the value
// the base constructor stored is not overwritten (a plain field redeclaration would reset it to undefined).
export class Entity {
  id: EntityId | null;
  readonly kind: EntityKind;
  radius: number;
  edge: EdgeMode;
  collidable: boolean;
  pos: Vector2;
  vel: Vector2;
  angle: number;
  prevPos: Vector2;
  prevAngle: number;
  alive: boolean;
  world: World | null;
  behaviors: Behavior[];

  constructor(
    x = 0,
    y = 0,
    { kind = "entity", radius = 10, edge = "wrap", collidable = true }: EntityOptions = {},
  ) {
    this.id = null; // assigned by World.spawn (deterministic per world, same on server and client)
    this.kind = kind;
    this.radius = radius;
    this.edge = edge;
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

  update(dt: number, world: World | null = this.world, input: KeyInput | null = null): void {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
    for (const b of this.behaviors) b.update(this, dt, world);
    this.think(dt, world, input);
    this.pos = this.pos.add(this.vel.scale(dt));
  }

  think(_dt: number, _world: World | null, _input: KeyInput | null): void {} // subclass hook: runs after behaviors, before movement
  onDeath(_world: World): void {} // subclass hook: called once when the world sweeps this entity
}
