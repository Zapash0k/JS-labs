import { describe, test } from "vitest";
import fc from "fast-check";
import { asSeq, asTick } from "../src/brand.ts";
import { CodecError, codecs } from "../src/codec/index.ts";
import { EFFECT_NAMES, PROTOCOL_VERSION, parseClientMessage } from "../src/protocol.ts";
import type { Snapshot, SnapshotEntity } from "../src/protocol.ts";
import { MAX_SPEED, createShipState, stepShipState } from "../src/sim/shipPhysics.ts";

// Property-based tests (Lab 07): instead of a handful of examples, state a rule that must hold for
// EVERY input and let fast-check try a hundred of them, shrinking any failure to a minimal case.
// If a property fails, fast-check prints the shrunk counterexample and a seed to replay it.

const { binary, json } = codecs;

// ---- building blocks ---------------------------------------------------------------------------

const u32 = fc.integer({ min: 0, max: 2 ** 32 - 1 });
const u16 = fc.integer({ min: 0, max: 0xffff });
const slot = fc.integer({ min: 0, max: 7 });
const hp = fc.integer({ min: 0, max: 100 });
const coord = fc.double({ min: -5000, max: 5000, noNaN: true });
const angle = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true });
const turn = fc.double({ min: -1, max: 1, noNaN: true });

const inputCommand = fc.record({
  seq: u32,
  tick: u32,
  thrust: fc.boolean(),
  fire: fc.boolean(),
  turn,
});

const entityBase = { id: u16, x: coord, y: coord, angle };
const entity: fc.Arbitrary<SnapshotEntity> = fc.oneof(
  fc.record({
    ...entityBase,
    kind: fc.constant("ship" as const),
    slot,
    hp,
    thrust: fc.boolean(),
    shield: fc.boolean(),
    invuln: fc.boolean(),
  }),
  fc.record({
    ...entityBase,
    kind: fc.constant("bullet" as const),
    slot,
    seq: u16,
    homing: fc.boolean(),
  }),
  fc.record({
    ...entityBase,
    kind: fc.constant("asteroid" as const),
    radius: fc.integer({ min: 0, max: 255 }),
    hunter: fc.boolean(),
  }),
  fc.record({
    ...entityBase,
    kind: fc.constant("pickup" as const),
    effect: fc.constantFrom(...EFFECT_NAMES),
  }),
);

const selfState = fc.record({
  x: coord,
  y: coord,
  vx: coord,
  vy: coord,
  angle: coord,
  cooldown: coord,
  rapid: coord,
  homingAmmo: coord,
  shield: coord,
  invuln: coord,
  thrust: fc.boolean(),
  hp,
});

const snapshot: fc.Arbitrary<Snapshot> = fc
  .record({
    tick: u32,
    ack: u32,
    self: fc.option(selfState, { nil: null }),
    entities: fc.array(entity, { maxLength: 12 }),
    events: fc.array(
      fc.record({
        type: fc.constantFrom("fired" as const, "hit" as const, "exploded" as const),
        slot,
        x: coord,
        y: coord,
      }),
      { maxLength: 6 },
    ),
  })
  .map((s) => ({ ...s, tick: asTick(s.tick), ack: asSeq(s.ack) }));

/** True if `fn` returned normally or threw a CodecError: the only two outcomes a decoder may have. */
function returnsOrCodecError(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    return e instanceof CodecError;
  }
}

// ---- the codec ---------------------------------------------------------------------------------

describe("binary codec", () => {
  test("input: decode(encode(cmd)) keeps every field, and turn is off by at most 1/254", () => {
    fc.assert(
      fc.property(inputCommand, (c) => {
        const back = binary.decodeInput(
          binary.encodeInput({ ...c, seq: asSeq(c.seq), tick: asTick(c.tick) }),
        );
        return (
          back.seq === c.seq &&
          back.tick === c.tick &&
          back.thrust === c.thrust &&
          back.fire === c.fire &&
          Math.abs(back.turn - c.turn) <= 0.5 / 127 + 1e-12
        );
      }),
    );
  });

  test("input: always exactly 12 bytes, whatever the values", () => {
    fc.assert(
      fc.property(inputCommand, (c) => {
        const bytes = binary.encodeInput({ ...c, seq: asSeq(c.seq), tick: asTick(c.tick) });
        return bytes.length === 12;
      }),
    );
  });

  test("snapshot: length is 14 + 41 (if self) + 18 per entity + 10 per event, as the spec says", () => {
    fc.assert(
      fc.property(snapshot, (s) => {
        const expected = 14 + (s.self ? 41 : 0) + 18 * s.entities.length + 10 * s.events.length;
        return binary.encodeSnapshot(s).length === expected;
      }),
    );
  });

  test("snapshot: decoding gives back the same entities (ids and kinds) and events, in order", () => {
    fc.assert(
      fc.property(snapshot, (s) => {
        const back = binary.decodeSnapshot(binary.encodeSnapshot(s));
        return (
          back.tick === s.tick &&
          back.ack === s.ack &&
          (back.self === null) === (s.self === null) &&
          back.entities.map((e) => `${e.kind}:${e.id}`).join() ===
            s.entities.map((e) => `${e.kind}:${e.id}`).join() &&
          back.events.map((e) => e.type).join() === s.events.map((e) => e.type).join()
        );
      }),
    );
  });

  test("garbage: random bytes only ever give a value or a CodecError, never another crash", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        return (
          returnsOrCodecError(() => binary.decodeInput(bytes)) &&
          returnsOrCodecError(() => binary.decodeSnapshot(bytes))
        );
      }),
      { numRuns: 500 },
    );
  });

  test("garbage: a VALID snapshot with flipped bytes or cut short is still safe to decode", () => {
    // Random bytes almost never get past the header, so damage a good message to reach the deep checks.
    const damage = fc.record({
      flips: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 6 }),
      cut: fc.option(fc.nat(), { nil: null }),
    });
    fc.assert(
      fc.property(snapshot, damage, (s, { flips, cut }) => {
        let bytes = binary.encodeSnapshot(s);
        for (const [at, value] of flips) bytes[at % bytes.length] = value;
        if (cut !== null) bytes = bytes.slice(0, cut % (bytes.length + 1));
        return returnsOrCodecError(() => binary.decodeSnapshot(bytes));
      }),
      { numRuns: 500 },
    );
  });
});

describe("JSON codec", () => {
  test("input: exact round trip (no quantization)", () => {
    fc.assert(
      fc.property(inputCommand, (c) => {
        const cmd = { ...c, seq: asSeq(c.seq), tick: asTick(c.tick) };
        const back = json.decodeInput(json.encodeInput(cmd));
        return (
          JSON.stringify(back) === JSON.stringify(cmd) ||
          (back.turn === c.turn && back.seq === c.seq)
        );
      }),
    );
  });

  test("garbage: any text only ever gives a value or a CodecError", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        return (
          returnsOrCodecError(() => json.decodeInput(text)) &&
          returnsOrCodecError(() => json.decodeSnapshot(text))
        );
      }),
      { numRuns: 500 },
    );
  });
});

// ---- the simulation ----------------------------------------------------------------------------

describe("ship physics", () => {
  const W = 1280;
  const H = 720;

  test("a ship stays inside the arena and under MAX_SPEED over up to 1000 random steps", () => {
    const command = fc.record({ thrust: fc.boolean(), turn, fire: fc.boolean() });
    const inside = (max: number) => fc.double({ min: 0, max, maxExcluded: true, noNaN: true });
    fc.assert(
      fc.property(
        inside(W),
        inside(H),
        fc.array(command, { minLength: 1, maxLength: 1000 }),
        (x, y, commands) => {
          const s = createShipState(x, y);
          for (const c of commands) {
            stepShipState(s, c, 1 / 30, W, H);
            if (!(s.x >= 0 && s.x < W && s.y >= 0 && s.y < H)) return false;
            if (Math.hypot(s.vx, s.vy) > MAX_SPEED + 1e-6) return false;
          }
          return true;
        },
      ),
    );
  });

  test("stepping is deterministic: the same start and commands always end in the same state", () => {
    const command = fc.record({ thrust: fc.boolean(), turn, fire: fc.boolean() });
    fc.assert(
      fc.property(fc.array(command, { maxLength: 300 }), (commands) => {
        const a = createShipState(100, 100);
        const b = createShipState(100, 100);
        for (const c of commands) {
          stepShipState(a, c, 1 / 30, W, H);
          stepShipState(b, c, 1 / 30, W, H);
        }
        return JSON.stringify(a) === JSON.stringify(b);
      }),
    );
  });
});

// ---- the message parser (the trust boundary) ---------------------------------------------------

describe("parseClientMessage", () => {
  const v = fc.constant(PROTOCOL_VERSION);
  const word = (chars: string, min: number, max: number) =>
    fc.string({ unit: fc.constantFrom(...chars), minLength: min, maxLength: max });
  const alnum = "abcdefghijklmnopqrstuvwxyz0123456789";

  const validInput = fc.record({
    v,
    type: fc.constant("input"),
    seq: u32,
    tick: u32,
    thrust: fc.boolean(),
    turn,
    fire: fc.boolean(),
  });
  const validMessage = fc.oneof(
    validInput,
    fc.record({
      v,
      type: fc.constant("ping"),
      t: fc.double({ noNaN: true, noDefaultInfinity: true }),
    }),
    fc.record({ v, type: fc.constant("chat"), text: word(alnum, 1, 280) }),
    fc.record({ v, type: fc.constant("leave") }),
    fc.record({
      v,
      type: fc.constant("join"),
      room: word(alnum, 1, 24),
      name: word(alnum, 1, 16),
      codec: fc.constantFrom("json", "binary"),
    }),
    fc.record({
      v,
      type: fc.constant("netsim"),
      rtt: fc.double({ min: 0, max: 2000, noNaN: true }),
      jitter: fc.double({ min: 0, max: 1000, noNaN: true }),
      drop: fc.double({ min: 0, max: 100, noNaN: true }),
    }),
  );

  test("accepts every well-formed message (and keeps its type)", () => {
    fc.assert(
      fc.property(validMessage, (m) => {
        const r = parseClientMessage(m);
        return r.ok && r.value.type === m.type;
      }),
    );
  });

  test("rejects any other protocol version", () => {
    fc.assert(
      fc.property(
        validMessage,
        fc.integer().filter((n) => n !== PROTOCOL_VERSION),
        (m, other) => {
          return !parseClientMessage({ ...m, v: other }).ok;
        },
      ),
    );
  });

  test("rejects an unknown message type", () => {
    const known = new Set(["input", "ping", "chat", "leave", "join", "netsim"]);
    fc.assert(
      fc.property(
        validMessage,
        fc.string().filter((s) => !known.has(s)),
        (m, type) => {
          return !parseClientMessage({ ...m, type }).ok;
        },
      ),
    );
  });

  test("rejects a message with a required field removed", () => {
    fc.assert(
      fc.property(validMessage, fc.nat(), (m, pick) => {
        const keys = Object.keys(m).filter((k) => k !== "v" && k !== "type" && k !== "codec");
        fc.pre(keys.length > 0); // `leave` has nothing to remove
        const key = keys[pick % keys.length];
        const { [key as string]: _removed, ...rest } = m as Record<string, unknown>;
        void _removed;
        return !parseClientMessage(rest).ok;
      }),
    );
  });

  test("rejects (does not clamp) an input whose turn is outside [-1, 1]", () => {
    const outOfRange = fc.oneof(
      fc.double({ min: 1.0001, max: 1e9, noNaN: true }),
      fc.double({ min: -1e9, max: -1.0001, noNaN: true }),
    );
    fc.assert(
      fc.property(validInput, outOfRange, (m, bad) => !parseClientMessage({ ...m, turn: bad }).ok),
    );
  });

  test("rejects anything that is not a JSON object", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.integer(),
          fc.string(),
          fc.boolean(),
          fc.array(fc.anything()),
        ),
        (x) => !parseClientMessage(x).ok,
      ),
    );
  });
});
