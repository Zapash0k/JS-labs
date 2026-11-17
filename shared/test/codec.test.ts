import { test } from "node:test";
import assert from "node:assert/strict";
import { asSeq, asTick } from "../src/brand.ts";
import { mulberry32 } from "../src/prng.ts";
import { CodecError, codecs } from "../src/codec/index.ts";
import { quantizeCommand, wrapAngle } from "../src/codec/binary.ts";
import { EFFECT_NAMES, parseClientMessage, parseInputCommand } from "../src/protocol.ts";
import type { InputCommand, Snapshot, SnapshotEntity } from "../src/protocol.ts";

const { json, binary } = codecs;
const rnd = mulberry32(2026);
const between = (a: number, b: number): number => a + rnd() * (b - a);
function pick<T>(xs: readonly T[]): T {
  const x = xs[Math.floor(rnd() * xs.length)];
  if (x === undefined) throw new Error("pick from an empty list");
  return x;
}

/** Plain numbers in, branded command out (the tests build commands from raw numbers). */
const command = (o: {
  seq: number;
  tick: number;
  thrust: boolean;
  fire: boolean;
  turn: number;
}): InputCommand => ({ ...o, seq: asSeq(o.seq), tick: asTick(o.tick) });

function randomEntity(i: number): SnapshotEntity {
  const base = {
    id: (i * 37) & 0xffff,
    x: between(0, 1280),
    y: between(0, 720),
    angle: between(-Math.PI, Math.PI),
  };
  switch (pick(["ship", "bullet", "asteroid", "pickup"] as const)) {
    case "ship":
      return {
        ...base,
        kind: "ship",
        slot: Math.floor(rnd() * 8),
        hp: Math.floor(rnd() * 101),
        thrust: rnd() < 0.5,
        shield: rnd() < 0.3,
        invuln: rnd() < 0.3,
      };
    case "bullet":
      return {
        ...base,
        kind: "bullet",
        slot: Math.floor(rnd() * 8),
        seq: Math.floor(rnd() * 65536),
        homing: rnd() < 0.2,
      };
    case "asteroid":
      return { ...base, kind: "asteroid", radius: 28, hunter: rnd() < 0.3 };
    case "pickup":
      return { ...base, kind: "pickup", effect: pick(EFFECT_NAMES) };
  }
}

const randomSnapshot = (): Snapshot => ({
  tick: asTick(Math.floor(rnd() * 1e6)),
  ack: asSeq(Math.floor(rnd() * 1e6)),
  self:
    rnd() < 0.8
      ? {
          x: between(0, 1280),
          y: between(0, 720),
          vx: between(-420, 420),
          vy: between(-420, 420),
          angle: between(-10, 10),
          cooldown: between(0, 0.25),
          rapid: between(0, 8),
          homingAmmo: between(0, 8),
          shield: between(0, 6),
          invuln: between(0, 1),
          thrust: rnd() < 0.5,
          hp: Math.floor(rnd() * 101),
        }
      : null,
  entities: Array.from({ length: Math.floor(rnd() * 20) }, (_, i) => randomEntity(i)),
  events: Array.from({ length: Math.floor(rnd() * 5) }, () => ({
    type: pick(["fired", "hit", "exploded"] as const),
    slot: Math.floor(rnd() * 8),
    x: between(0, 1280),
    y: between(0, 720),
  })),
});

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
] as const;

const close = (a: number, b: number, tol: number, label: string): void =>
  assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);

test("binary input: round trip, 12 bytes, turn quantized to 1/127", () => {
  for (let i = 0; i < 500; i++) {
    const cmd = command({
      seq: Math.floor(rnd() * 2 ** 32),
      tick: Math.floor(rnd() * 2 ** 32),
      thrust: rnd() < 0.5,
      fire: rnd() < 0.5,
      turn: between(-1, 1),
    });
    const bytes = binary.encodeInput(cmd);
    assert.equal(bytes.byteLength, 12);
    const back = binary.decodeInput(bytes);
    assert.deepEqual({ ...back, turn: 0 }, { ...cmd, turn: 0 });
    close(back.turn, cmd.turn, 1 / 254 + 1e-12, "turn");
    assert.deepEqual(
      back,
      quantizeCommand(cmd),
      "the client can predict with exactly what the server will decode",
    );
  }
  for (const turn of [-1, 0, 1])
    assert.equal(
      binary.decodeInput(
        binary.encodeInput(command({ seq: 1, tick: 1, thrust: false, fire: false, turn })),
      ).turn,
      turn,
    );
});

test("binary snapshot: decode(encode(x)) equals x within quantization", () => {
  for (let n = 0; n < 300; n++) {
    const snap = randomSnapshot();
    const bytes = binary.encodeSnapshot(snap);
    const back = binary.decodeSnapshot(bytes);
    assert.equal(back.tick, snap.tick);
    assert.equal(back.ack, snap.ack);
    assert.equal(back.entities.length, snap.entities.length);
    assert.equal(back.events.length, snap.events.length);
    assert.equal(
      bytes.byteLength,
      14 + (snap.self ? 41 : 0) + 18 * snap.entities.length + 10 * snap.events.length,
    );
    if (snap.self) {
      const want = snap.self;
      const got = back.self;
      assert.ok(got, "self survives the round trip");
      for (const f of SELF_FIELDS)
        close(got[f], want[f], Math.abs(want[f]) * 1.2e-7 + 1e-30, `self.${f}`);
      assert.equal(got.hp, want.hp);
      assert.equal(got.thrust, want.thrust);
    } else assert.equal(back.self, null);
    snap.entities.forEach((e, i) => {
      const d = back.entities[i];
      assert.ok(d, `entity ${i} decoded`);
      assert.equal(d.kind, e.kind);
      assert.equal(d.id, e.id);
      close(d.x, e.x, 1.3e-4, "x");
      close(d.y, e.y, 1.3e-4, "y");
      close(d.angle, wrapAngle(e.angle), 0.0005 + 1e-9, "angle"); // quantization: 1 milliradian steps
      const got: Record<string, unknown> = d;
      const want: Record<string, unknown> = e;
      for (const key of Object.keys(want))
        if (!["x", "y", "angle"].includes(key))
          assert.deepEqual(got[key], want[key], `${e.kind}.${key}`);
    });
    snap.events.forEach((ev, i) => {
      const d = back.events[i];
      assert.ok(d, `event ${i} decoded`);
      assert.equal(d.type, ev.type);
      assert.equal(d.slot, ev.slot);
      close(d.x, ev.x, 1.3e-4, "event x");
    });
  }
});

test("angle quantization: 1 milliradian steps (0.057 degrees), worst error 0.0005 rad", () => {
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const a = between(-Math.PI, Math.PI);
    const back = binary.decodeSnapshot(
      binary.encodeSnapshot({
        tick: asTick(0),
        ack: asSeq(0),
        self: null,
        events: [],
        entities: [{ id: 1, kind: "asteroid", x: 0, y: 0, angle: a, radius: 28, hunter: false }],
      }),
    ).entities[0]?.angle;
    assert.ok(back !== undefined);
    worst = Math.max(worst, Math.abs(back - a));
  }
  assert.ok(worst <= 0.0005 + 1e-9, `worst error ${worst}`);
});

test("JSON codec: exact round trip, same model", () => {
  const snap = randomSnapshot();
  assert.deepEqual(
    json.decodeSnapshot(json.encodeSnapshot(snap)),
    JSON.parse(JSON.stringify(snap)),
  );
  const cmd = command({ seq: 5, tick: 9, thrust: true, fire: false, turn: -1 });
  assert.deepEqual(json.decodeInput(json.encodeInput(cmd)), cmd);
});

test("decoders reject garbage with CodecError and never crash (untrusted input)", () => {
  const good = binary.encodeInput(command({ seq: 1, tick: 1, thrust: true, fire: false, turn: 0 }));
  for (const bad of [
    new Uint8Array(0),
    new Uint8Array(1),
    good.slice(0, 11),
    new Uint8Array(13),
    Uint8Array.from(good, (b, i) => (i === 0 ? 9 : b)),
    Uint8Array.from(good, (b, i) => (i === 1 ? 2 : b)),
    Uint8Array.from(good, (b, i) => (i === 11 ? 0x80 : b)),
  ]) {
    assert.throws(() => binary.decodeInput(bad), CodecError);
  }
  const snap = binary.encodeSnapshot(randomSnapshot());
  assert.throws(() => binary.decodeSnapshot(snap.slice(0, snap.length - 1)), CodecError);
  assert.throws(() => binary.decodeSnapshot(new Uint8Array(5)), CodecError);
  // fuzz: random bytes must either decode or throw CodecError, nothing else
  for (let i = 0; i < 2000; i++) {
    const junk = Uint8Array.from({ length: Math.floor(rnd() * 80) }, () => Math.floor(rnd() * 256));
    for (const decode of [binary.decodeInput, binary.decodeSnapshot]) {
      try {
        decode(junk);
      } catch (e) {
        assert.ok(e instanceof CodecError, String(e));
      }
    }
  }
  for (const bad of ["nope", "{}", '{"v":1,"type":"input","seq":-1}'])
    assert.throws(() => json.decodeInput(bad), CodecError);
});

test("a binary snapshot with a NaN or infinite float is rejected (range check)", () => {
  const snap = randomSnapshot();
  snap.entities.push({ id: 1, kind: "asteroid", x: 1, y: 2, angle: 0, radius: 28, hunter: false });
  const bytes = binary.encodeSnapshot({ ...snap, self: null });
  // the last entity sits right before the events: poison its x
  const at = 14 + 18 * (snap.entities.length - 1) + 4;
  new DataView(bytes.buffer).setFloat32(at, Number.POSITIVE_INFINITY, true);
  assert.throws(() => binary.decodeSnapshot(bytes), CodecError);
});

test("parseInputCommand: a turn of 1000 is rejected, not clamped", () => {
  const ok = { seq: 1, tick: 0, thrust: true, turn: 1, fire: false };
  assert.equal(parseInputCommand(ok).ok, true);
  const bad: unknown[] = [
    { ...ok, turn: 1000 },
    { ...ok, turn: NaN },
    { ...ok, turn: "1" },
    { ...ok, seq: -1 },
    { ...ok, seq: 1.5 },
    { ...ok, thrust: 1 },
    { ...ok, fire: "yes" },
    null,
    5,
  ];
  for (const b of bad) assert.equal(parseInputCommand(b).ok, false, JSON.stringify(b));
});

test("what stops a client sending { type: 'input', turn: 1e9 }? The schema, at the boundary", () => {
  const msg = { v: 1, type: "input", seq: 1, tick: 0, thrust: true, turn: 1e9, fire: false };
  const r = parseClientMessage(msg);
  assert.equal(r.ok, false);
  assert.equal(parseClientMessage({ ...msg, turn: 1 }).ok, true);
});
