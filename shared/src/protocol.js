// Constants and validation shared by client and server (Lab 05).
//
// Control messages (join, chat, roster, ping...) stay JSON text frames (see server/README.md).
// Game messages — inputs up, snapshots down — go through a codec: JSON for comparison, or binary
// (src/codec/binary.js, byte-level spec there).

export const PROTOCOL_VERSION = 1;
export const TICK_HZ = 30; // server simulation and snapshot rate; the networked client simulates at the same rate
export const TICK_DT = 1 / TICK_HZ;
export const WORLD_SIZE = Object.freeze({ w: 1280, h: 720 }); // authoritative world, in px

export const KIND = Object.freeze({ ship: 1, bullet: 2, asteroid: 3, pickup: 4 });
export const KIND_NAME = Object.freeze({ 1: "ship", 2: "bullet", 3: "asteroid", 4: "pickup" });
export const EFFECT_NAMES = Object.freeze(["shield", "rapid", "homing"]);
export const EVENT = Object.freeze({ fired: 1, hit: 2, exploded: 3 });
export const EVENT_NAME = Object.freeze({ 1: "fired", 2: "hit", 3: "exploded" });
export const NO_SLOT = 255; // "not a player" in slot fields

const U32_MAX = 0xffffffff;

/**
 * Validates an input command from the wire. Returns { ok: true, cmd } with a clean copy
 * { seq, tick, thrust, turn, fire }, or { ok: false, reason }. A `turn` of 1000 is a cheat, not a clamp.
 */
export function validateInput(raw) {
  if (typeof raw !== "object" || raw === null)
    return { ok: false, reason: "input must be an object" };
  const { seq, tick, thrust, turn, fire } = raw;
  if (!Number.isInteger(seq) || seq < 0 || seq > U32_MAX) return { ok: false, reason: "bad seq" };
  if (!Number.isInteger(tick) || tick < 0 || tick > U32_MAX)
    return { ok: false, reason: "bad tick" };
  if (typeof thrust !== "boolean") return { ok: false, reason: "thrust must be a boolean" };
  if (typeof fire !== "boolean") return { ok: false, reason: "fire must be a boolean" };
  if (typeof turn !== "number" || !Number.isFinite(turn) || turn < -1 || turn > 1) {
    return { ok: false, reason: "turn must be a number in [-1, 1]" };
  }
  return { ok: true, cmd: { seq, tick, thrust, turn, fire } };
}

/** Snapshot entity ids are u16 on the wire (both codecs), so the builder masks them. */
export const netId = (id) => id & 0xffff;
