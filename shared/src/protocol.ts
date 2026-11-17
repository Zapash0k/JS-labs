// The protocol: ONE schema per message, the TypeScript type inferred from it, and a parser at every
// boundary (Lab 06). Types are erased at runtime, so what stops `{ type: "input", turn: 1e9 }` is the
// zod schema below, not the `ClientMessage` type.
//
// Control messages (join, chat, roster, ping...) stay JSON text frames (see server/README.md).
// Game messages — inputs up, snapshots down — go through a codec: JSON for comparison, or binary
// (src/codec/binary.ts, byte-level spec there).
//
// client -> server
//   { v:1, type:"join",  room, name, codec? }
//   { v:1, type:"chat",  text }
//   { v:1, type:"leave" }
//   { v:1, type:"ping", t }                               RTT probe, echoed back as "pong"
//   { v:1, type:"netsim", rtt, jitter, drop }             live latency injector (ms, ms, %)
//   { v:1, type:"input", seq, tick, thrust, turn, fire }  (or 12 binary bytes, see the binary codec)
// server -> client
//   { v:1, type:"joined", room, you:{ id, name, slot }, tickRate, seed, world:{w,h}, codec }
//   { v:1, type:"pong",   t }
//   { v:1, type:"roster", room, players:[{ id, name }] }
//   { v:1, type:"chat",   from:{ id, name }, text, t }
//   { v:1, type:"error",  code, message }
//   { v:1, type:"snapshot", ... }                         JSON codec only
import { z } from "zod";
import { asSeq, asTick } from "./brand.ts";
import { EFFECT_NAMES, EVENT_TYPES, PROTOCOL_VERSION } from "./constants.ts";

export * from "./constants.ts";

const U32_MAX = 0xffffffff;

export const LIMITS = Object.freeze({ nameMax: 16, roomIdMax: 24, textMax: 280 });

const ROOM_ID = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

export const isRoomId = (s: unknown): s is string =>
  typeof s === "string" && s.length <= LIMITS.roomIdMax && ROOM_ID.test(s);
export const isPlayerName = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 1 && s.length <= LIMITS.nameMax && NAME.test(s);

// ---- building blocks ----------------------------------------------------------------------------

const u32 = (what: string) =>
  z.int(`bad ${what}`).min(0, `bad ${what}`).max(U32_MAX, `bad ${what}`);
const u16 = z.int().min(0).max(0xffff);
const u8 = z.int().min(0).max(0xff);

/** { v: 1, type: <literal> } — the first two fields of every JSON message. */
const header = <T extends string>(type: T) => ({
  v: z.literal(PROTOCOL_VERSION, `unsupported protocol version (expected ${PROTOCOL_VERSION})`),
  type: z.literal(type),
});

export const CodecNameSchema = z.enum(["json", "binary"], "codec must be json or binary");
export type CodecName = z.infer<typeof CodecNameSchema>;

// ---- input command (shared by the JSON message and by both codecs) ------------------------------

const TURN_MSG = "turn must be a number in [-1, 1]";

/** A cheat is rejected, not clamped: `turn: 1000` fails here. `seq` and `tick` come out branded. */
export const InputCommandSchema = z.object({
  seq: u32("seq").transform(asSeq),
  tick: u32("tick").transform(asTick),
  thrust: z.boolean("thrust must be a boolean"),
  turn: z.number(TURN_MSG).min(-1, TURN_MSG).max(1, TURN_MSG),
  fire: z.boolean("fire must be a boolean"),
});
export type InputCommand = z.infer<typeof InputCommandSchema>;

// ---- client -> server ---------------------------------------------------------------------------

const rate = (max: number) => z.number().min(0).max(max);

const JoinMessage = z.object({
  ...header("join"),
  room: z
    .string("room must be a string")
    .refine(isRoomId, "room must be 1-24 chars: a-z, 0-9, '-'"),
  name: z
    .string("name must be a string")
    .trim()
    .refine(isPlayerName, "name must be 1-16 letters, digits, space, '_' or '-'"),
  codec: CodecNameSchema.default("binary"),
});
const ChatMessage = z.object({
  ...header("chat"),
  text: z
    .string("text must be a string")
    .trim()
    .min(1, `text must be 1-${LIMITS.textMax} chars`)
    .max(LIMITS.textMax, `text must be 1-${LIMITS.textMax} chars`),
});
const LeaveMessage = z.object({ ...header("leave") });
const PingMessage = z.object({ ...header("ping"), t: z.number("t must be a number") });
const NetsimMessage = z.object({
  ...header("netsim"),
  rtt: rate(2000),
  jitter: rate(1000),
  drop: rate(100),
});
const InputMessage = z.object({ ...header("input"), ...InputCommandSchema.shape });

export const ClientMessageSchema = z.discriminatedUnion(
  "type",
  [JoinMessage, ChatMessage, LeaveMessage, PingMessage, NetsimMessage, InputMessage],
  { error: "unknown message type" },
);
/** A clean, validated message: unknown keys dropped, strings trimmed, defaults filled in. */
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
/** What a client may build and send (codec optional, seq/tick plain numbers). */
export type ClientMessageInput = z.input<typeof ClientMessageSchema>;

// ---- snapshots (server -> client) ---------------------------------------------------------------

const num = z.number();

export const SelfStateSchema = z.object({
  x: num,
  y: num,
  vx: num,
  vy: num,
  angle: num,
  cooldown: num,
  rapid: num,
  homingAmmo: num,
  shield: num,
  invuln: num,
  thrust: z.boolean(),
  hp: u8,
});
export type SelfState = z.infer<typeof SelfStateSchema>;

const entityBase = { id: u16, x: num, y: num, angle: num };

/** One entity on the wire, discriminated by `kind`: switch on it and each branch sees its own fields. */
export const SnapshotEntitySchema = z.discriminatedUnion("kind", [
  z.object({
    ...entityBase,
    kind: z.literal("ship"),
    slot: u8,
    hp: u8,
    thrust: z.boolean(),
    shield: z.boolean(),
    invuln: z.boolean(),
  }),
  z.object({
    ...entityBase,
    kind: z.literal("bullet"),
    slot: u8,
    seq: u16,
    homing: z.boolean(),
  }),
  z.object({ ...entityBase, kind: z.literal("asteroid"), radius: u8, hunter: z.boolean() }),
  z.object({ ...entityBase, kind: z.literal("pickup"), effect: z.enum(EFFECT_NAMES) }),
]);
export type SnapshotEntity = z.infer<typeof SnapshotEntitySchema>;

export const SnapshotEventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  slot: u8,
  x: num,
  y: num,
});
export type SnapshotEvent = z.infer<typeof SnapshotEventSchema>;

export const SnapshotSchema = z.object({
  tick: u32("tick").transform(asTick),
  ack: u32("ack").transform(asSeq), // last input seq the server applied for THIS client
  self: SelfStateSchema.nullable(),
  entities: z.array(SnapshotEntitySchema).max(0xffff),
  events: z.array(SnapshotEventSchema).max(0xff),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const SnapshotMessageSchema = z.object({ ...header("snapshot"), ...SnapshotSchema.shape });

// ---- server -> client ---------------------------------------------------------------------------

const PlayerRef = z.object({ id: z.string(), name: z.string() });

export const ServerMessageSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      ...header("joined"),
      room: z.string(),
      you: PlayerRef.extend({ slot: u8 }),
      tickRate: z.number().positive(),
      seed: z.number(),
      world: z.object({ w: z.number().positive(), h: z.number().positive() }),
      codec: CodecNameSchema,
    }),
    z.object({ ...header("pong"), t: num }),
    z.object({ ...header("roster"), room: z.string(), players: z.array(PlayerRef) }),
    z.object({ ...header("chat"), from: PlayerRef, text: z.string(), t: num }),
    z.object({ ...header("error"), code: z.string(), message: z.string() }),
    SnapshotMessageSchema,
  ],
  { error: "unknown message type" },
);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---- parsing: unknown in, typed Result out, never throws ----------------------------------------

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function parseWith<T>(schema: z.ZodType<T>, data: unknown): Result<T> {
  if (!isRecord(data)) return { ok: false, reason: "message must be a JSON object" };
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? ` (at ${issue.path.map(String).join(".")})` : "";
  return { ok: false, reason: `${issue?.message ?? "invalid message"}${where}` };
}

/** Everything a client may send. `data` is whatever JSON.parse or a binary decode produced: unknown. */
export const parseClientMessage = (data: unknown): Result<ClientMessage> =>
  parseWith(ClientMessageSchema, data);

/** Everything the server may send as a JSON text frame. */
export const parseServerMessage = (data: unknown): Result<ServerMessage> =>
  parseWith(ServerMessageSchema, data);

export const parseInputCommand = (data: unknown): Result<InputCommand> =>
  parseWith(InputCommandSchema, data);
