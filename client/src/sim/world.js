import { Vector2 } from "./vector.js";
import { Ship } from "./ship.js";
import { Asteroid } from "./asteroid.js";
import { Pickup, EFFECTS } from "./pickup.js";
import { Explosion } from "./explosion.js";
import { homing } from "./behaviors.js";
import { contain } from "./arena.js";
import { findCollisions } from "./collision.js";

const RESPAWN_DELAY = 2; // s
const DEFAULT_ASTEROIDS = 6;
const SAFE_DISTANCE = 160;

// Collision rules keyed by the two kinds in alphabetical order; handlers get (first, second).
const RULES = {
  "asteroid|bullet"(world, asteroid, bullet) {
    bullet.alive = false;
    asteroid.takeDamage(bullet.damage);
    world.emit("hit", { target: asteroid, pos: asteroid.pos });
    if (!asteroid.alive) world.addScore(100, asteroid.pos);
  },
  "asteroid|ship"(world, asteroid, ship) {
    if (ship.takeDamage(25)) {
      asteroid.takeDamage(30);
      world.emit("hit", { target: ship, pos: ship.pos });
    }
  },
  "bullet|ship"(world, bullet, ship) {
    if (bullet.owner === ship) return;
    bullet.alive = false;
    if (ship.takeDamage(bullet.damage)) world.emit("hit", { target: ship, pos: ship.pos });
  },
  "pickup|ship"(world, pickup, ship) {
    pickup.alive = false;
    ship.applyPickup(pickup.effect);
  },
};

export class World {
  #entities = new Map();
  #pending = [];
  #stepping = false;
  #respawnIn = null;
  #asteroidIn = 0;
  #pickupIn = 8;

  constructor(
    size,
    { hazards = true, rng = Math.random, asteroidTarget = DEFAULT_ASTEROIDS, pickups = true } = {},
  ) {
    this.size = size; // { w, h }, read live so window resizes work
    this.hazards = hazards;
    this.asteroidTarget = asteroidTarget;
    this.pickups = pickups;
    // Lab 03: the sim reports what happened ("fired", "hit", "exploded", "scoreChanged");
    // audio.js and hud.js subscribe. The sim imports neither.
    this.events = new EventTarget();
    this.rng = rng;
    this.score = 0;
    this.player = null;
    this.respawnIn = null; // for the HUD
  }

  start() {
    this.player = this.spawn(new Ship(this.size.w / 2, this.size.h / 2));
    if (this.hazards) for (let i = 0; i < this.asteroidTarget - 1; i++) this.#spawnAsteroid();
  }

  spawn(entity) {
    entity.world = this;
    // During step() new entities wait in a queue so the Map is not mutated mid-iteration.
    if (this.#stepping) this.#pending.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  // Deferred: mark dead now, the sweep at the end of step() removes it.
  despawn(id) {
    const e = this.#entities.get(id);
    if (e) e.alive = false;
  }

  get(id) {
    return this.#entities.get(id);
  }

  get count() {
    return this.#entities.size;
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  *ofKind(kind) {
    for (const e of this) if (e.alive && e.kind === kind) yield e;
  }

  emit(type, detail) {
    this.events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  addScore(delta, pos) {
    this.score += delta;
    this.emit("scoreChanged", { delta, total: this.score, pos });
  }

  spawnExplosion(pos) {
    this.emit("exploded", { pos });
    return this.spawn(new Explosion(pos.x, pos.y, this.rng));
  }

  step(dt, input) {
    this.#stepping = true;
    for (const e of this) {
      if (!e.alive) continue;
      e.update(dt, this, input);
      contain(e, this.size.w, this.size.h);
    }
    for (const [a, b] of findCollisions(this)) {
      if (!a.alive || !b.alive) continue; // an earlier pair may have consumed one of them
      const [x, y] = a.kind <= b.kind ? [a, b] : [b, a];
      RULES[`${x.kind}|${y.kind}`]?.(this, x, y);
    }
    this.#stepping = false;

    this.#sweep();
    this.#respawn(dt);
    if (this.hazards) this.#populate(dt);
  }

  #sweep() {
    const dead = [];
    for (const [id, e] of this.#entities) {
      if (!e.alive) dead.push([id, e]);
    }
    for (const [id] of dead) this.#entities.delete(id);
    for (const [, e] of dead) e.onDeath(this); // may spawn (explosions)
    for (const e of this.#pending.splice(0)) this.#entities.set(e.id, e);
  }

  #respawn(dt) {
    if (!this.player || this.player.alive) {
      this.respawnIn = this.#respawnIn = null;
      return;
    }
    this.#respawnIn ??= RESPAWN_DELAY;
    this.#respawnIn -= dt;
    this.respawnIn = Math.max(0, this.#respawnIn);
    if (this.#respawnIn > 0) return;
    const spot = this.#safeSpot();
    this.player = this.spawn(new Ship(spot.x, spot.y));
  }

  #safeSpot() {
    const asteroids = [...this.ofKind("asteroid")];
    let best = null;
    let bestD = -1;
    for (let i = 0; i < 30; i++) {
      const p = new Vector2(this.rng() * this.size.w, this.rng() * this.size.h);
      const d = Math.min(Infinity, ...asteroids.map((a) => a.pos.sub(p).length()));
      if (d > bestD) {
        best = p;
        bestD = d;
      }
      if (d >= SAFE_DISTANCE) break;
    }
    return best;
  }

  #populate(dt) {
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
        const names = Object.keys(EFFECTS);
        const effect = names[Math.floor(this.rng() * names.length)];
        this.spawn(new Pickup(this.rng() * this.size.w, this.rng() * this.size.h, effect));
      }
    }
  }

  #spawnAsteroid() {
    const { w, h } = this.size;
    let x;
    let y;
    for (let i = 0; i < 10; i++) {
      [x, y] =
        this.rng() < 0.5
          ? [this.rng() * w, this.rng() < 0.5 ? 0 : h]
          : [this.rng() < 0.5 ? 0 : w, this.rng() * h];
      if (!this.player || this.player.pos.sub(new Vector2(x, y)).length() > 250) break;
    }
    const vel = Vector2.fromAngle(this.rng() * Math.PI * 2, 40 + this.rng() * 70);
    const a = new Asteroid(x, y, vel, this.rng);
    // Same behavior, different host: homing asteroids hunt the ship slowly.
    if (this.rng() < 0.35) a.behaviors.push(homing({ seek: "ship", turnRate: 0.5 }));
    this.spawn(a);
  }
}
