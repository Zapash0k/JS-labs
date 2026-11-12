// Pure simulation: no DOM, no canvas.
import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";
import { Bullet } from "./bullet.js";
import { homing } from "./behaviors.js";
import { EFFECTS } from "./pickup.js";

export const TURN_RATE = 3.5; // rad/s
export const ACCEL = 320; // px/s^2
export const DRAG = 0.7; // 1/s
export const MAX_SPEED = 420; // px/s
export const MAX_HP = 100;
export const BULLET_SPEED = 600; // px/s, relative to the ship

const PICKUP_FIELD = { shield: "shield", rapid: "rapid", homing: "homingAmmo" };

export class Ship extends Entity {
  #hp = MAX_HP;

  constructor(x = 0, y = 0) {
    super(x, y, { kind: "ship", radius: 12 });
    this.thrust = false;
    this.cooldown = 0; // seconds until the next shot
    this.invuln = 0; // brief invulnerability after a hit
    this.shield = 0;
    this.rapid = 0;
    this.homingAmmo = 0;
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

  think(dt, world, input) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.shield = Math.max(0, this.shield - dt);
    this.rapid = Math.max(0, this.rapid - dt);
    this.homingAmmo = Math.max(0, this.homingAmmo - dt);

    if (input.isDown("ArrowLeft") || input.isDown("KeyA")) this.angle -= TURN_RATE * dt;
    if (input.isDown("ArrowRight") || input.isDown("KeyD")) this.angle += TURN_RATE * dt;

    this.thrust = input.isDown("ArrowUp") || input.isDown("KeyW");
    if (this.thrust) this.vel = this.vel.add(Vector2.fromAngle(this.angle, ACCEL * dt));

    this.vel = this.vel.scale(Math.max(0, 1 - DRAG * dt));
    const speed = this.vel.length();
    if (speed > MAX_SPEED) this.vel = this.vel.scale(MAX_SPEED / speed);

    if (input.isDown("Space")) this.fire();
  }

  // NOTE: relies on `this`. Passing `ship.fire` as a callback loses it (see README).
  fire() {
    if (!(this instanceof Ship)) throw new TypeError("fire() called with the wrong `this`");
    if (!this.world || !this.alive || this.cooldown > 0) return null;
    this.cooldown = this.rapid > 0 ? 0.08 : 0.25;
    const dir = Vector2.fromAngle(this.angle);
    const nose = this.pos.add(dir.scale(this.radius + 4));
    const bullet = new Bullet(nose.x, nose.y, this.vel.add(dir.scale(BULLET_SPEED)), this);
    bullet.angle = this.angle;
    if (this.homingAmmo > 0) bullet.behaviors.push(homing({ seek: "asteroid", turnRate: 4 }));
    this.world.emit("fired", { owner: this, pos: nose });
    return this.world.spawn(bullet);
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
