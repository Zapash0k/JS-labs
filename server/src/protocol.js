// Protocol v1: JSON text messages, every one has { v: 1, type, ... }.
// The messages themselves (zod schemas, inferred types, parseClientMessage) live in
// shared/src/protocol.ts (Lab 06). This file keeps what only the server needs: close codes,
// slugify and the tiny encode() helper.
//
// client -> server
//   { v:1, type:"join",  room, name, codec? }
//   { v:1, type:"chat",  text }
//   { v:1, type:"leave" }
//   { v:1, type:"ping", t }                               RTT probe, echoed back as "pong"
//   { v:1, type:"netsim", rtt, jitter, drop }             live latency injector (ms, ms, %)
//   input  -> see shared/src/codec (JSON text or 12 binary bytes)
// server -> client
//   { v:1, type:"joined", room, you:{ id, name, slot }, tickRate, seed, world:{w,h}, codec }
//   { v:1, type:"pong",   t }
//   snapshot -> see shared/src/codec
//   { v:1, type:"roster", room, players:[{ id, name }] }
//   { v:1, type:"chat",   from:{ id, name }, text, t }
//   { v:1, type:"error",  code, message }

import { LIMITS, PROTOCOL_VERSION, isPlayerName, isRoomId } from "@dogfight/shared/protocol.js";

export { LIMITS, PROTOCOL_VERSION, isPlayerName, isRoomId };

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

export const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.roomIdMax)
    .replace(/-+$/, "");

export const encode = (type, fields = {}) =>
  JSON.stringify({ v: PROTOCOL_VERSION, type, ...fields });
