// Pure simulation: no DOM, no canvas.
import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";
import { Bullet } from "./bullet.js";
import { homing } from "./behaviors.js";
import { EFFECTS } from "./pickup.js";
import {
  SHIP_RADIUS,
  BULLET_SPEED,
  TURN_RATE,
  ACCEL,
  DRAG,
  MAX_SPEED,
  commandFromInput,
  stepShipState,
  tryFire,
} from "./shipPhysics.js";

export { TURN_RATE, ACCEL, DRAG, MAX_SPEED, BULLET_SPEED };
export const MAX_HP = 100;

const PICKUP_FIELD = { shield: "shield", rapid: "rapid", homing: "homingAmmo" };

export class Ship extends Entity {
  #hp = MAX_HP;

  constructor(x = 0, y = 0) {
    super(x, y, { kind: "ship", radius: SHIP_RADIUS });
    this.thrust = false;
    this.cooldown = 0; // seconds until the next shot
    this.invuln = 0; // brief invulnerability after a hit
    this.shield = 0;
    this.rapid = 0;
    this.homingAmmo = 0;
    // Networked play: a remote ship is driven by `controls` (the command the server dequeued for
    // this tick, or null = no input arrived, so the ship does not advance). Local play reads the keyboard.
    this.remote = false;
    this.controls = null;
    this.playerId = null;
    this.slot = null;
  }

  get hp() {
    return this.#hp;
  }

  // Returns true if the hit counted (damage taken or absorbed by the shield).
  takeDamage(amount) {
    if (!this.alive || this.invuln > 0) return false;
    if (this.shield > 0) return true;
    this.#hp = Math.max(0, this.#hp - amount);
    this.invuln = 1;
    if (this.#hp === 0) this.alive = false;
    return true;
  }

  applyPickup(effect) {
    this[PICKUP_FIELD[effect]] = EFFECTS[effect];
  }

  /** Plain-number copy of the movement state (what prediction and snapshots work with). */
  toState() {
    return {
      x: this.pos.x,
      y: this.pos.y,
      vx: this.vel.x,
      vy: this.vel.y,
      angle: this.angle,
      thrust: this.thrust,
      cooldown: this.cooldown,
      invuln: this.invuln,
      shield: this.shield,
      rapid: this.rapid,
      homingAmmo: this.homingAmmo,
    };
  }

  #applyState(s) {
    this.pos = new Vector2(s.x, s.y);
    this.vel = new Vector2(s.vx, s.vy);
    this.angle = s.angle;
    this.thrust = s.thrust;
    this.cooldown = s.cooldown;
    this.invuln = s.invuln;
    this.shield = s.shield;
    this.rapid = s.rapid;
    this.homingAmmo = s.homingAmmo;
  }

  // One step = shipPhysics.stepShipState on this ship's numbers (including movement and wrapping).
  update(dt, world = this.world, input = null) {
    let cmd;
    if (this.remote) {
      if (!this.controls) return; // no input this tick: stall (the client replays only inputs the server acked)
      cmd = this.controls;
    } else {
      cmd = commandFromInput(input);
    }
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
    const s = this.toState();
    const spec = stepShipState(s, cmd, dt, world ? world.size.w : 0, world ? world.size.h : 0);
    this.#applyState(s);
    if (spec && world) this.#spawnBullet(spec, cmd.seq);
  }

  #spawnBullet(spec, seq) {
    const bullet = new Bullet(spec.x, spec.y, new Vector2(spec.vx, spec.vy), this);
    bullet.angle = spec.angle;
    bullet.fireSeq = seq ?? 0;
    if (spec.homing) bullet.behaviors.push(homing({ seek: "asteroid", turnRate: 4 }));
    this.world.emit("fired", { owner: this, pos: new Vector2(spec.x, spec.y) });
    return this.world.spawn(bullet);
  }

  // NOTE: relies on `this`. Passing `ship.fire` as a callback loses it (see README).
  fire() {
    if (!(this instanceof Ship)) throw new TypeError("fire() called with the wrong `this`");
    if (!this.world || !this.alive || this.cooldown > 0) return null;
    const s = this.toState();
    const spec = tryFire(s);
    this.cooldown = s.cooldown;
    return this.#spawnBullet(spec, 0);
  }

  onDeath(world) {
    world.spawnExplosion(this.pos);
  }
}

export const createShip = (x = 0, y = 0) => new Ship(x, y);

// Kept for scripts/determinism.mjs: controls + movement for one step, no world needed.
export function integrate(ship, input, dt) {
  ship.update(dt, null, input);
}
