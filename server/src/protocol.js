// Protocol v1: JSON text messages, every one has { v: 1, type, ... }.
// The server validates every incoming message; nothing from the wire is trusted.
//
// client -> server
//   { v:1, type:"join",  room, name }
//   { v:1, type:"chat",  text }
//   { v:1, type:"leave" }
// server -> client
//   { v:1, type:"joined", room, you:{ id, name } }
//   { v:1, type:"roster", room, players:[{ id, name }] }
//   { v:1, type:"chat",   from:{ id, name }, text, t }
//   { v:1, type:"error",  code, message }

export const PROTOCOL_VERSION = 1;

export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // server shutting down
  PROTOCOL: 1002, // malformed / unknown / out-of-order message
  UNSUPPORTED: 1003, // binary frame
  POLICY: 1008, // rate limit
  TOO_BIG: 1009, // sent by ws itself when maxPayload is exceeded
  JOIN_TIMEOUT: 4001,
  ROOM_FULL: 4002,
  SERVER_BUSY: 4003, // too many rooms
  SLOW_CLIENT: 4004,
  INTERNAL: 1011,
});

// The client must not auto-reconnect after these: retrying cannot help.
export const NO_RECONNECT = new Set([
  CLOSE.PROTOCOL,
  CLOSE.UNSUPPORTED,
  CLOSE.POLICY,
  CLOSE.TOO_BIG,
  CLOSE.JOIN_TIMEOUT,
  CLOSE.ROOM_FULL,
  CLOSE.SERVER_BUSY,
  CLOSE.SLOW_CLIENT,
]);

export const LIMITS = Object.freeze({ nameMax: 16, roomIdMax: 24, textMax: 280 });

const ROOM_ID = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

export const isRoomId = (s) =>
  typeof s === "string" && s.length <= LIMITS.roomIdMax && ROOM_ID.test(s);
export const isPlayerName = (s) =>
  typeof s === "string" && s.length >= 1 && s.length <= LIMITS.nameMax && NAME.test(s);

export const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.roomIdMax)
    .replace(/-+$/, "");

const isObject = (x) => typeof x === "object" && x !== null && !Array.isArray(x);

const CLIENT_TYPES = {
  join(m) {
    if (!isRoomId(m.room)) return "room must be 1-24 chars: a-z, 0-9, '-'";
    if (typeof m.name !== "string") return "name must be a string";
    const name = m.name.trim();
    if (!isPlayerName(name)) return "name must be 1-16 letters, digits, space, '_' or '-'";
    return { room: m.room, name };
  },
  chat(m) {
    if (typeof m.text !== "string") return "text must be a string";
    const text = m.text.trim();
    if (text.length === 0 || text.length > LIMITS.textMax)
      return `text must be 1-${LIMITS.textMax} chars`;
    return { text };
  },
  leave() {
    return {};
  },
};

/** @returns {{ ok: true, msg: object } | { ok: false, reason: string }} a clean copy, never the raw object */
export function validate(raw) {
  if (!isObject(raw)) return { ok: false, reason: "message must be a JSON object" };
  if (raw.v !== PROTOCOL_VERSION)
    return { ok: false, reason: `unsupported protocol version (expected ${PROTOCOL_VERSION})` };
  if (typeof raw.type !== "string" || !Object.hasOwn(CLIENT_TYPES, raw.type)) {
    return { ok: false, reason: "unknown message type" };
  }
  const result = CLIENT_TYPES[raw.type](raw);
  if (typeof result === "string") return { ok: false, reason: result };
  return { ok: true, msg: { v: PROTOCOL_VERSION, type: raw.type, ...result } };
}

export const encode = (type, fields = {}) =>
  JSON.stringify({ v: PROTOCOL_VERSION, type, ...fields });
