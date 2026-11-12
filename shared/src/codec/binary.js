// Binary codec, format version 1. ALL multi-byte numbers are LITTLE-ENDIAN (DataView flag `true`).
// The layout below is the spec; the code just follows it.
//
// INPUT  (client -> server), 12 bytes
//   0  u8   type = 1
//   1  u8   version = 1
//   2  u32  seq
//   6  u32  tick          last server tick the client had seen
//   10 u8   flags         bit0 thrust, bit1 fire
//   11 i8   turn          round(turn * 127), -127..127
//
// SNAPSHOT (server -> client), 14 + (hasSelf ? 41 : 0) + 18*entityCount + 10*eventCount bytes
//   0  u8   type = 2
//   1  u8   version = 1
//   2  u32  tick
//   6  u32  ack           last input seq the server applied for THIS client
//   10 u8   flags         bit0 hasSelf, bit1 self.thrust
//   11 u16  entityCount
//   13 u8   eventCount
//   -- if hasSelf (41 bytes): the receiving client's own ship, exact (f32, not quantized)
//      f32 x, y, vx, vy, angle, cooldown, rapid, homingAmmo, shield, invuln  (10 x 4 = 40)
//      u8  hp
//   -- entityCount x 18 bytes
//      u16 id            world id & 0xFFFF
//      u8  kind          1 ship, 2 bullet, 3 asteroid, 4 pickup
//      u8  flags         ship: bit0 thrust, bit1 shield, bit2 invulnerable
//                        bullet: bit0 homing     asteroid: bit0 hunter
//      f32 x, f32 y
//      i16 angle         milliradians, wrapped to [-PI, PI] (error <= 0.0005 rad = 0.03 deg)
//      u8  p1            ship: hp          bullet: owner slot   asteroid: radius (px)  pickup: effect (0 shield, 1 rapid, 2 homing)
//      u8  p2            ship: slot
//      u16 p3            bullet: fire seq & 0xFFFF
//   -- eventCount x 10 bytes
//      u8 type (1 fired, 2 hit, 3 exploded), u8 slot (255 = none), f32 x, f32 y
import { EFFECT_NAMES, EVENT, EVENT_NAME, KIND, KIND_NAME, PROTOCOL_VERSION } from "../protocol.js";

export const name = "binary";
export const isBinary = true;

export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;
const INPUT_BYTES = 12;
const HEADER_BYTES = 14;
const SELF_BYTES = 41;
const ENTITY_BYTES = 18;
const EVENT_BYTES = 10;
const LE = true;

export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodecError";
  }
}

const view = (data) =>
  data instanceof ArrayBuffer
    ? new DataView(data)
    : new DataView(data.buffer, data.byteOffset, data.byteLength); // Uint8Array / Node Buffer

const TAU = Math.PI * 2;
export const wrapAngle = (a) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const encodeAngle = (a) => Math.round(wrapAngle(a) * 1000);
const decodeAngle = (q) => q / 1000;
const u8 = (n) => Math.max(0, Math.min(255, Math.round(n)));

/** The value the server will actually see for a command (turn is stored as an i8). Clients predict with this. */
export const quantizeCommand = (cmd) => ({ ...cmd, turn: Math.round(cmd.turn * 127) / 127 + 0 }); // + 0 turns -0 into 0

export function peekType(data) {
  const v = view(data);
  if (v.byteLength < 2) throw new CodecError("message too short");
  if (v.getUint8(1) !== PROTOCOL_VERSION) throw new CodecError("unsupported binary version");
  return v.getUint8(0);
}

export function encodeInput(cmd) {
  const out = new Uint8Array(INPUT_BYTES);
  const v = new DataView(out.buffer);
  v.setUint8(0, MSG_INPUT);
  v.setUint8(1, PROTOCOL_VERSION);
  v.setUint32(2, cmd.seq, LE);
  v.setUint32(6, cmd.tick, LE);
  v.setUint8(10, (cmd.thrust ? 1 : 0) | (cmd.fire ? 2 : 0));
  v.setInt8(11, Math.round(cmd.turn * 127));
  return out;
}

export function decodeInput(data) {
  const v = view(data);
  if (v.byteLength !== INPUT_BYTES) throw new CodecError(`input must be ${INPUT_BYTES} bytes`);
  if (peekType(data) !== MSG_INPUT) throw new CodecError("not an input message");
  const flags = v.getUint8(10);
  const turn = v.getInt8(11);
  if (turn < -127) throw new CodecError("bad turn"); // -128 is not a valid encoding
  return {
    seq: v.getUint32(2, LE),
    tick: v.getUint32(6, LE),
    thrust: (flags & 1) !== 0,
    fire: (flags & 2) !== 0,
    turn: turn / 127,
  };
}

const SELF_FIELDS = [
  "x",
  "y",
  "vx",
  "vy",
  "angle",
  "cooldown",
  "rapid",
  "homingAmmo",
  "shield",
  "invuln",
];

export function encodeSnapshot(snap) {
  const { self, entities, events } = snap;
  const size =
    HEADER_BYTES +
    (self ? SELF_BYTES : 0) +
    ENTITY_BYTES * entities.length +
    EVENT_BYTES * events.length;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint8(0, MSG_SNAPSHOT);
  v.setUint8(1, PROTOCOL_VERSION);
  v.setUint32(2, snap.tick, LE);
  v.setUint32(6, snap.ack, LE);
  v.setUint8(10, (self ? 1 : 0) | (self?.thrust ? 2 : 0));
  v.setUint16(11, entities.length, LE);
  v.setUint8(13, events.length);
  let o = HEADER_BYTES;

  if (self) {
    for (const f of SELF_FIELDS) {
      v.setFloat32(o, self[f], LE);
      o += 4;
    }
    v.setUint8(o++, u8(self.hp));
  }

  for (const e of entities) {
    v.setUint16(o, e.id, LE);
    v.setUint8(o + 2, KIND[e.kind]);
    let flags = 0;
    let p1 = 0;
    let p2 = 0;
    let p3 = 0;
    if (e.kind === "ship") {
      flags = (e.thrust ? 1 : 0) | (e.shield ? 2 : 0) | (e.invuln ? 4 : 0);
      p1 = u8(e.hp);
      p2 = e.slot;
    } else if (e.kind === "bullet") {
      flags = e.homing ? 1 : 0;
      p1 = e.slot;
      p3 = e.seq & 0xffff;
    } else if (e.kind === "asteroid") {
      flags = e.hunter ? 1 : 0;
      p1 = u8(e.radius);
    } else if (e.kind === "pickup") {
      p1 = EFFECT_NAMES.indexOf(e.effect);
    }
    v.setUint8(o + 3, flags);
    v.setFloat32(o + 4, e.x, LE);
    v.setFloat32(o + 8, e.y, LE);
    v.setInt16(o + 12, encodeAngle(e.angle), LE);
    v.setUint8(o + 14, p1);
    v.setUint8(o + 15, p2);
    v.setUint16(o + 16, p3, LE);
    o += ENTITY_BYTES;
  }

  for (const ev of events) {
    v.setUint8(o, EVENT[ev.type]);
    v.setUint8(o + 1, ev.slot);
    v.setFloat32(o + 2, ev.x, LE);
    v.setFloat32(o + 6, ev.y, LE);
    o += EVENT_BYTES;
  }
  return out;
}

export function decodeSnapshot(data) {
  const v = view(data);
  if (v.byteLength < HEADER_BYTES) throw new CodecError("snapshot too short");
  if (peekType(data) !== MSG_SNAPSHOT) throw new CodecError("not a snapshot");
  const flags = v.getUint8(10);
  const entityCount = v.getUint16(11, LE);
  const eventCount = v.getUint8(13);
  const hasSelf = (flags & 1) !== 0;
  const expected =
    HEADER_BYTES +
    (hasSelf ? SELF_BYTES : 0) +
    ENTITY_BYTES * entityCount +
    EVENT_BYTES * eventCount;
  if (v.byteLength !== expected)
    throw new CodecError(`snapshot length ${v.byteLength}, expected ${expected}`);
  let o = HEADER_BYTES;

  let self = null;
  if (hasSelf) {
    self = {};
    for (const f of SELF_FIELDS) {
      self[f] = v.getFloat32(o, LE);
      o += 4;
    }
    self.thrust = (flags & 2) !== 0;
    self.hp = v.getUint8(o++);
  }

  const entities = [];
  for (let i = 0; i < entityCount; i++, o += ENTITY_BYTES) {
    const kind = KIND_NAME[v.getUint8(o + 2)];
    if (!kind) throw new CodecError("unknown entity kind");
    const f = v.getUint8(o + 3);
    const p1 = v.getUint8(o + 14);
    const p2 = v.getUint8(o + 15);
    const e = {
      id: v.getUint16(o, LE),
      kind,
      x: v.getFloat32(o + 4, LE),
      y: v.getFloat32(o + 8, LE),
      angle: decodeAngle(v.getInt16(o + 12, LE)),
    };
    if (kind === "ship")
      Object.assign(e, {
        slot: p2,
        hp: p1,
        thrust: !!(f & 1),
        shield: !!(f & 2),
        invuln: !!(f & 4),
      });
    else if (kind === "bullet")
      Object.assign(e, { slot: p1, seq: v.getUint16(o + 16, LE), homing: !!(f & 1) });
    else if (kind === "asteroid") Object.assign(e, { radius: p1, hunter: !!(f & 1) });
    else {
      if (p1 >= EFFECT_NAMES.length) throw new CodecError("unknown pickup effect");
      e.effect = EFFECT_NAMES[p1];
    }
    entities.push(e);
  }

  const events = [];
  for (let i = 0; i < eventCount; i++, o += EVENT_BYTES) {
    const type = EVENT_NAME[v.getUint8(o)];
    if (!type) throw new CodecError("unknown event type");
    events.push({
      type,
      slot: v.getUint8(o + 1),
      x: v.getFloat32(o + 2, LE),
      y: v.getFloat32(o + 6, LE),
    });
  }
  return { tick: v.getUint32(2, LE), ack: v.getUint32(6, LE), self, entities, events };
}
