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
import { asSeq, asTick } from "../brand.ts";
import {
  EFFECT_NAMES,
  EVENT,
  EVENT_NAME,
  KIND,
  KIND_NAME,
  PROTOCOL_VERSION,
} from "../constants.ts";
import { CodecError } from "./types.ts";
import type {
  InputCommand,
  SelfState,
  Snapshot,
  SnapshotEntity,
  SnapshotEvent,
} from "../protocol.ts";
import type { BinaryCodec } from "./types.ts";

export { CodecError } from "./types.ts";

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

type Bytes = Uint8Array | ArrayBuffer;

const view = (data: Bytes): DataView =>
  data instanceof ArrayBuffer
    ? new DataView(data)
    : new DataView(data.buffer, data.byteOffset, data.byteLength); // Uint8Array / Node Buffer

const TAU = Math.PI * 2;
export const wrapAngle = (a: number): number => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const encodeAngle = (a: number): number => Math.round(wrapAngle(a) * 1000);
const decodeAngle = (q: number): number => q / 1000;
const u8 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** The value the server will actually see for a command (turn is stored as an i8). Clients predict with this. */
export const quantizeCommand = <T extends { readonly turn: number }>(cmd: T): T => ({
  ...cmd,
  turn: Math.round(cmd.turn * 127) / 127 + 0, // + 0 turns -0 into 0
});

export function peekType(data: Bytes): number {
  const v = view(data);
  if (v.byteLength < 2) throw new CodecError("message too short");
  if (v.getUint8(1) !== PROTOCOL_VERSION) throw new CodecError("unsupported binary version");
  return v.getUint8(0);
}

export function encodeInput(cmd: InputCommand): Uint8Array {
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

export function decodeInput(data: Bytes): InputCommand {
  const v = view(data);
  if (v.byteLength !== INPUT_BYTES) throw new CodecError(`input must be ${INPUT_BYTES} bytes`);
  if (peekType(data) !== MSG_INPUT) throw new CodecError("not an input message");
  const flags = v.getUint8(10);
  const turn = v.getInt8(11);
  if (turn < -127) throw new CodecError("bad turn"); // -128 is not a valid encoding
  return {
    seq: asSeq(v.getUint32(2, LE)),
    tick: asTick(v.getUint32(6, LE)),
    thrust: (flags & 1) !== 0,
    fire: (flags & 2) !== 0,
    turn: turn / 127,
  };
}

// The order of the ten f32 fields of `self` on the wire.
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
] as const satisfies readonly (keyof SelfState)[];

export function encodeSnapshot(snap: Snapshot): Uint8Array {
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
    let p1: number; // set in every case below (the default case returns)
    let p2 = 0;
    let p3 = 0;
    switch (e.kind) {
      case "ship":
        flags = (e.thrust ? 1 : 0) | (e.shield ? 2 : 0) | (e.invuln ? 4 : 0);
        p1 = u8(e.hp);
        p2 = e.slot;
        break;
      case "bullet":
        flags = e.homing ? 1 : 0;
        p1 = e.slot;
        p3 = e.seq & 0xffff;
        break;
      case "asteroid":
        flags = e.hunter ? 1 : 0;
        p1 = u8(e.radius);
        break;
      case "pickup":
        p1 = EFFECT_NAMES.indexOf(e.effect);
        break;
      default: {
        // A new entity kind without a wire layout stops compiling here, not in production.
        const _exhaustive: never = e;
        return _exhaustive;
      }
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

export function decodeSnapshot(data: Bytes): Snapshot {
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

  // Range check: a float that is NaN or infinite never comes from a healthy server.
  const f32 = (at: number): number => {
    const n = v.getFloat32(at, LE);
    if (!Number.isFinite(n)) throw new CodecError("non-finite number");
    return n;
  };
  let o = HEADER_BYTES;

  let self: SelfState | null = null;
  if (hasSelf) {
    // Same order as SELF_FIELDS / encodeSnapshot (the round-trip test pins it).
    self = {
      x: f32(o),
      y: f32(o + 4),
      vx: f32(o + 8),
      vy: f32(o + 12),
      angle: f32(o + 16),
      cooldown: f32(o + 20),
      rapid: f32(o + 24),
      homingAmmo: f32(o + 28),
      shield: f32(o + 32),
      invuln: f32(o + 36),
      thrust: (flags & 2) !== 0,
      hp: v.getUint8(o + 40),
    };
    o += SELF_BYTES;
  }

  const entities: SnapshotEntity[] = [];
  for (let i = 0; i < entityCount; i++, o += ENTITY_BYTES) {
    const kind = KIND_NAME[v.getUint8(o + 2)];
    if (!kind) throw new CodecError("unknown entity kind");
    const f = v.getUint8(o + 3);
    const p1 = v.getUint8(o + 14);
    const p2 = v.getUint8(o + 15);
    const id = v.getUint16(o, LE);
    const x = f32(o + 4);
    const y = f32(o + 8);
    const angle = decodeAngle(v.getInt16(o + 12, LE));
    switch (kind) {
      case "ship":
        entities.push({
          id,
          kind,
          x,
          y,
          angle,
          slot: p2,
          hp: p1,
          thrust: !!(f & 1),
          shield: !!(f & 2),
          invuln: !!(f & 4),
        });
        break;
      case "bullet":
        entities.push({
          id,
          kind,
          x,
          y,
          angle,
          slot: p1,
          seq: v.getUint16(o + 16, LE),
          homing: !!(f & 1),
        });
        break;
      case "asteroid":
        entities.push({ id, kind, x, y, angle, radius: p1, hunter: !!(f & 1) });
        break;
      case "pickup": {
        const effect = EFFECT_NAMES[p1];
        if (effect === undefined) throw new CodecError("unknown pickup effect");
        entities.push({ id, kind, x, y, angle, effect });
        break;
      }
      default: {
        const _exhaustive: never = kind;
        throw new CodecError(`unhandled entity kind ${String(_exhaustive)}`);
      }
    }
  }

  const events: SnapshotEvent[] = [];
  for (let i = 0; i < eventCount; i++, o += EVENT_BYTES) {
    const type = EVENT_NAME[v.getUint8(o)];
    if (!type) throw new CodecError("unknown event type");
    events.push({ type, slot: v.getUint8(o + 1), x: f32(o + 2), y: f32(o + 6) });
  }
  return {
    tick: asTick(v.getUint32(2, LE)),
    ack: asSeq(v.getUint32(6, LE)),
    self,
    entities,
    events,
  };
}

export const binaryCodec: BinaryCodec = {
  name,
  isBinary,
  quantizeCommand,
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
};
