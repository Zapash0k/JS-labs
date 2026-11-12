// The ONE implementation of how a ship moves and fires, on plain numbers.
// Ship (class, used by the server's World and by single-player) delegates here, and the client's
// prediction calls the same function with the same dt, which is what makes prediction exact.
//
// A ship state is { x, y, vx, vy, angle, thrust, cooldown, invuln, shield, rapid, homingAmmo }.
// A command is    { thrust: boolean, turn: -1..1, fire: boolean }.

import { wrapCoord } from "./arena.js";

export const TURN_RATE = 3.5; // rad/s
export const ACCEL = 320; // px/s^2
export const DRAG = 0.7; // 1/s
export const MAX_SPEED = 420; // px/s
export const BULLET_SPEED = 600; // px/s, relative to the ship
export const SHIP_RADIUS = 12;

export const createShipState = (x = 0, y = 0) => ({
  x,
  y,
  vx: 0,
  vy: 0,
  angle: 0,
  thrust: false,
  cooldown: 0,
  invuln: 0,
  shield: 0,
  rapid: 0,
  homingAmmo: 0,
});

export const NO_COMMAND = Object.freeze({ thrust: false, turn: 0, fire: false });

/** Keyboard (input.isDown) -> command. */
export function commandFromInput(input) {
  const left = input.isDown("ArrowLeft") || input.isDown("KeyA");
  const right = input.isDown("ArrowRight") || input.isDown("KeyD");
  return {
    thrust: input.isDown("ArrowUp") || input.isDown("KeyW"),
    turn: (right ? 1 : 0) - (left ? 1 : 0),
    fire: input.isDown("Space"),
  };
}

/** Fires if the cooldown allows. Mutates the cooldown, returns a bullet description or null. */
export function tryFire(s) {
  if (s.cooldown > 0) return null;
  s.cooldown = s.rapid > 0 ? 0.08 : 0.25;
  const dx = Math.cos(s.angle);
  const dy = Math.sin(s.angle);
  return {
    x: s.x + dx * (SHIP_RADIUS + 4),
    y: s.y + dy * (SHIP_RADIUS + 4),
    vx: s.vx + dx * BULLET_SPEED,
    vy: s.vy + dy * BULLET_SPEED,
    angle: s.angle,
    homing: s.homingAmmo > 0,
  };
}

/**
 * Advances a ship by one fixed step. Order matters and is the same everywhere:
 * timers -> turn -> thrust -> drag -> speed cap -> fire -> move -> wrap.
 * Pass w/h = 0 to skip wrapping. Returns a bullet description if the ship fired, else null.
 */
export function stepShipState(s, cmd, dt, w = 0, h = 0) {
  s.cooldown = Math.max(0, s.cooldown - dt);
  s.invuln = Math.max(0, s.invuln - dt);
  s.shield = Math.max(0, s.shield - dt);
  s.rapid = Math.max(0, s.rapid - dt);
  s.homingAmmo = Math.max(0, s.homingAmmo - dt);

  if (cmd.turn !== 0) s.angle += TURN_RATE * dt * cmd.turn;

  s.thrust = cmd.thrust;
  if (s.thrust) {
    s.vx += Math.cos(s.angle) * (ACCEL * dt);
    s.vy += Math.sin(s.angle) * (ACCEL * dt);
  }

  const drag = Math.max(0, 1 - DRAG * dt);
  s.vx *= drag;
  s.vy *= drag;
  const speed = Math.hypot(s.vx, s.vy);
  if (speed > MAX_SPEED) {
    const k = MAX_SPEED / speed;
    s.vx *= k;
    s.vy *= k;
  }

  const bullet = cmd.fire ? tryFire(s) : null;

  s.x += s.vx * dt;
  s.y += s.vy * dt;
  if (w > 0) s.x = wrapCoord(s.x, w);
  if (h > 0) s.y = wrapCoord(s.y, h);
  return bullet;
}
