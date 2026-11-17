import { Vector2 } from "./vector.ts";
import { Ship } from "./ship.ts";
import { Asteroid } from "./asteroid.ts";
import { Pickup } from "./pickup.ts";
import { Explosion } from "./explosion.ts";
import { homing } from "./behaviors.ts";
import { contain } from "./arena.ts";
import { findCollisions } from "./collision.ts";
import { mulberry32 } from "../prng.ts";
import { EFFECT_NAMES } from "../constants.ts";
import { asEntityId } from "../brand.ts";
import type { EntityId } from "../brand.ts";
import type { Bullet } from "./bullet.ts";
import type { KeyInput, ShipCommand } from "./shipPhysics.ts";
import type { Rng } from "../prng.ts";

const RESPAWN_DELAY = 2; // s
const DEFAULT_ASTEROIDS = 6;
const SAFE_DISTANCE = 160;

/** Everything that can live in a World. Discriminated by `kind`: switch on it and the compiler narrows. */
export type SimEntity = Ship | Bullet | Asteroid | Pickup | Explosion;
export type SimKind = SimEntity["kind"];

export interface WorldSize {
  w: number;
  h: number;
}

/** What the sim reports (Lab 03): audio and the HUD subscribe, the sim imports neither. */
export interface WorldEventMap {
  fired: { owner: Ship; pos: Vector2 };
  hit: { target: Ship | Asteroid; pos: Vector2 };
  exploded: { pos: Vector2 };
  scoreChanged: { delta: number; total: number; pos: Vector2; playerId: string };
}

export interface WorldOptions {
  hazards?: boolean;
  rng?: Rng;
  asteroidTarget?: number;
  pickups?: boolean;
}

export interface PlayerRecord {
  ship: Ship;
  respawnIn: number | null;
  remote: boolean;
  slot: number | null;
  score: number;
}

export interface AddPlayerOptions {
  remote?: boolean;
  slot?: number | null;
  at?: { x: number; y: number } | null;
}

function isKind<K extends SimKind>(e: SimEntity, kind: K): e is Extract<SimEntity, { kind: K }> {
  return e.kind === kind;
}

// Collision rules. The two entities arrive sorted by kind, alphabetically: (x, y) with x.kind <= y.kind.
// The old version looked handlers up in a table keyed by "asteroid|bullet" strings; a switch on the
// discriminant gives the same dispatch, narrows both entities, and the `never` default turns
// "I added a new entity kind and forgot its collisions" into a compile error.
function resolveCollision(world: World, x: SimEntity, y: SimEntity): void {
  switch (x.kind) {
    case "asteroid":
      if (y.kind === "bullet") {
        y.alive = false;
        x.takeDamage(y.damage);
        world.emit("hit", { target: x, pos: x.pos });
        if (!x.alive) world.addScore(100, x.pos);
      } else if (y.kind === "ship") {
        if (y.takeDamage(25)) {
          x.takeDamage(30);
          world.emit("hit", { target: y, pos: y.pos });
        }
      }
      return;
    case "bullet":
      if (y.kind === "ship") {
        if (x.owner === y) return;
        x.alive = false;
        if (y.takeDamage(x.damage)) {
          world.emit("hit", { target: y, pos: y.pos });
          if (!y.alive && x.owner?.playerId != null) world.addScore(100, y.pos, x.owner.playerId);
        }
      }
      return;
    case "pickup":
      if (y.kind === "ship") {
        x.alive = false;
        y.applyPickup(x.effect);
      }
      return;
    case "explosion": // never collidable
    case "ship": // sorts last: no rule starts with a ship
      return;
    default: {
      const _exhaustive: never = x;
      return _exhaustive;
    }
  }
}

export class World {
  #entities = new Map<EntityId, SimEntity>();
  #pending: SimEntity[] = [];
  #stepping = false;
  #nextId = 1; // ids are assigned by the world, so server and client agree on them
  #asteroidIn = 0;
  #pickupIn = 8;

  size: WorldSize; // { w, h }, read live so window resizes work
  hazards: boolean;
  asteroidTarget: number;
  pickups: boolean;
  events: EventTarget;
  rng: Rng;
  score: number;
  player: Ship | null; // the local (keyboard) player's ship, single-player only
  respawnIn: number | null; // for the HUD
  players: Map<string, PlayerRecord>; // playerId -> { ship, respawnIn, remote, slot, score }

  constructor(
    size: WorldSize,
    {
      hazards = true,
      rng = mulberry32(1),
      asteroidTarget = DEFAULT_ASTEROIDS,
      pickups = true,
    }: WorldOptions = {},
  ) {
    this.size = size;
    this.hazards = hazards;
    this.asteroidTarget = asteroidTarget;
    this.pickups = pickups;
    // Lab 03: the sim reports what happened ("fired", "hit", "exploded", "scoreChanged");
    // audio.js and hud.js subscribe. The sim imports neither.
    this.events = new EventTarget();
    this.rng = rng;
    this.score = 0;
    this.player = null;
    this.respawnIn = null;
    this.players = new Map();
  }

  /** Single-player: one keyboard-driven ship in the middle, plus hazards. */
  start(): void {
    this.addPlayer("local");
    this.startHazards(this.asteroidTarget - 1);
  }

  startHazards(count: number = this.asteroidTarget): void {
    if (this.hazards) for (let i = 0; i < count; i++) this.#spawnAsteroid();
  }

  /** Adds a ship for `playerId`. Remote ships are driven by setCommand(), local ones by the keyboard. */
  addPlayer(
    playerId: string,
    { remote = false, slot = null, at = null }: AddPlayerOptions = {},
  ): Ship {
    const spot = at ?? (remote ? this.#safeSpot() : { x: this.size.w / 2, y: this.size.h / 2 });
    const ship = this.#spawnShip(playerId, remote, slot, spot);
    this.players.set(playerId, { ship, respawnIn: null, remote, slot, score: 0 });
    return ship;
  }

  removePlayer(playerId: string): void {
    const rec = this.players.get(playerId);
    if (!rec) return;
    this.players.delete(playerId);
    if (rec.ship.alive) {
      rec.ship.alive = false;
      rec.ship.onDeath = () => {}; // leaving is not an explosion
    }
    if (this.player === rec.ship) this.player = null;
  }

  /** The command the ship will use for the next step; null means "no input arrived: do not advance". */
  setCommand(playerId: string, cmd: ShipCommand | null): void {
    const rec = this.players.get(playerId);
    if (rec) rec.ship.controls = cmd;
  }

  #spawnShip(
    playerId: string,
    remote: boolean,
    slot: number | null,
    spot: { x: number; y: number },
  ): Ship {
    const ship = new Ship(spot.x, spot.y);
    ship.remote = remote;
    ship.playerId = playerId;
    ship.slot = slot;
    this.spawn(ship);
    if (!remote) this.player = ship;
    return ship;
  }

  spawn<T extends SimEntity>(entity: T): T {
    const id = asEntityId(this.#nextId++);
    entity.id = id;
    entity.world = this;
    // During step() new entities wait in a queue so the Map is not mutated mid-iteration.
    if (this.#stepping) this.#pending.push(entity);
    else this.#entities.set(id, entity);
    return entity;
  }

  // Deferred: mark dead now, the sweep at the end of step() removes it.
  despawn(id: EntityId): void {
    const e = this.#entities.get(id);
    if (e) e.alive = false;
  }

  get(id: EntityId): SimEntity | undefined {
    return this.#entities.get(id);
  }

  get count(): number {
    return this.#entities.size;
  }

  *[Symbol.iterator](): Generator<SimEntity> {
    yield* this.#entities.values();
  }

  /** Living entities of one kind; the element type follows the kind you pass. */
  *ofKind<K extends SimKind>(kind: K): Generator<Extract<SimEntity, { kind: K }>> {
    for (const e of this) if (e.alive && isKind(e, kind)) yield e;
  }

  emit<K extends keyof WorldEventMap>(type: K, detail: WorldEventMap[K]): void {
    this.events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  addScore(delta: number, pos: Vector2, playerId = "local"): void {
    this.score += delta;
    const rec = this.players.get(playerId);
    if (rec) rec.score += delta;
    this.emit("scoreChanged", { delta, total: this.score, pos, playerId });
  }

  spawnExplosion(pos: Vector2): Explosion {
    this.emit("exploded", { pos });
    return this.spawn(new Explosion(pos.x, pos.y, this.rng));
  }

  step(dt: number, input: KeyInput | null = null): void {
    this.#stepping = true;
    for (const e of this) {
      if (!e.alive) continue;
      e.update(dt, this, input);
      contain(e, this.size.w, this.size.h);
    }
    for (const [a, b] of findCollisions(this)) {
      if (!a.alive || !b.alive) continue; // an earlier pair may have consumed one of them
      if (a.kind <= b.kind) resolveCollision(this, a, b);
      else resolveCollision(this, b, a);
    }
    this.#stepping = false;

    this.#sweep();
    this.#respawn(dt);
    if (this.hazards) this.#populate(dt);
  }

  #sweep(): void {
    const dead: [EntityId, SimEntity][] = [];
    for (const [id, e] of this.#entities) {
      if (!e.alive) dead.push([id, e]);
    }
    for (const [id] of dead) this.#entities.delete(id);
    for (const [, e] of dead) e.onDeath(this); // may spawn (explosions)
    for (const e of this.#pending.splice(0)) {
      if (e.id !== null) this.#entities.set(e.id, e);
    }
  }

  #respawn(dt: number): void {
    for (const [playerId, rec] of this.players) {
      if (rec.ship.alive) {
        rec.respawnIn = null;
        if (!rec.remote) this.respawnIn = null;
        continue;
      }
      rec.respawnIn ??= RESPAWN_DELAY;
      rec.respawnIn -= dt;
      if (!rec.remote) this.respawnIn = Math.max(0, rec.respawnIn);
      if (rec.respawnIn > 0) continue;
      rec.ship = this.#spawnShip(playerId, rec.remote, rec.slot, this.#safeSpot());
      rec.respawnIn = null;
    }
  }

  // The spot farthest from asteroids and other living ships (up to 30 random tries).
  #safeSpot(): { x: number; y: number } {
    const obstacles = [...this.ofKind("asteroid"), ...this.ofKind("ship")];
    let best = { x: this.size.w / 2, y: this.size.h / 2 };
    let bestD = -1;
    for (let i = 0; i < 30; i++) {
      const p = new Vector2(this.rng() * this.size.w, this.rng() * this.size.h);
      const d = Math.min(Infinity, ...obstacles.map((a) => a.pos.sub(p).length()));
      if (d > bestD) {
        best = p;
        bestD = d;
      }
      if (d >= SAFE_DISTANCE) break;
    }
    return best;
  }

  #populate(dt: number): void {
    this.#asteroidIn -= dt;
    let asteroids = 0;
    let pickups = 0;
    for (const e of this) {
      if (!e.alive) continue;
      if (e.kind === "asteroid") asteroids++;
      else if (e.kind === "pickup") pickups++;
    }
    if (asteroids < this.asteroidTarget && this.#asteroidIn <= 0) {
      this.#spawnAsteroid();
      this.#asteroidIn = 1;
    }
    this.#pickupIn -= dt;
    if (this.#pickupIn <= 0) {
      this.#pickupIn = 10;
      if (this.pickups && pickups < 2) {
        // Same order of rng() calls as before: effect, then x, then y.
        const effect = EFFECT_NAMES[Math.floor(this.rng() * EFFECT_NAMES.length)];
        if (effect !== undefined)
          this.spawn(new Pickup(this.rng() * this.size.w, this.rng() * this.size.h, effect));
      }
    }
  }

  #spawnAsteroid(): void {
    const { w, h } = this.size;
    let x = 0;
    let y = 0;
    for (let i = 0; i < 10; i++) {
      // The order of rng() calls is part of the determinism contract: do not reshuffle.
      if (this.rng() < 0.5) {
        x = this.rng() * w;
        y = this.rng() < 0.5 ? 0 : h;
      } else {
        x = this.rng() < 0.5 ? 0 : w;
        y = this.rng() * h;
      }
      const spot = new Vector2(x, y);
      const ships = [...this.ofKind("ship")];
      if (ships.every((sh) => sh.pos.sub(spot).length() > 250)) break;
    }
    const vel = Vector2.fromAngle(this.rng() * Math.PI * 2, 40 + this.rng() * 70);
    const a = new Asteroid(x, y, vel, this.rng);
    // Same behavior, different host: homing asteroids hunt the ship slowly.
    if (this.rng() < 0.35) a.behaviors.push(homing({ seek: "ship", turnRate: 0.5 }));
    this.spawn(a);
  }
}
