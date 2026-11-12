// All configuration comes from the environment; this is the only file that reads it.
// Invalid values fail at startup with a clear message instead of misbehaving later.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const int =
  (name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) =>
  (env) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new ConfigError(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
    }
    return n;
  };
const str = (name, def) => (env) => (env[name] === undefined || env[name] === "" ? def : env[name]);
const bool = (name) => (env) => ["1", "true", "yes"].includes(String(env[name]).toLowerCase());

const here = fileURLToPath(new URL(".", import.meta.url));

const SCHEMA = {
  port: int("PORT", 3000, { max: 65535 }),
  host: str("HOST", "127.0.0.1"),
  logDir: (env) => resolve(str("LOG_DIR", "./logs")(env)),
  staticDir: (env) => resolve(str("STATIC_DIR", resolve(here, "../../client/dist"))(env)),
  demo: bool("DEMO_ENDPOINTS"),

  // protocol / abuse limits (M4)
  maxPayload: int("MAX_PAYLOAD", 4096, { min: 64 }), // bytes per WebSocket message
  maxBodyBytes: int("MAX_BODY_BYTES", 4096, { min: 64 }), // bytes per HTTP request body
  maxRooms: int("MAX_ROOMS", 50, { min: 1 }),
  maxPlayersPerRoom: int("MAX_PLAYERS_PER_ROOM", 8, { min: 1 }),
  rateBurst: int("RATE_BURST", 20, { min: 1 }), // token bucket capacity
  ratePerSec: int("RATE_PER_SEC", 10, { min: 1 }), // sustained messages per second
  slowClientBytes: int("SLOW_CLIENT_BYTES", 64 * 1024, { min: 1 }), // socket.bufferedAmount threshold

  // timing
  joinTimeoutMs: int("JOIN_TIMEOUT_MS", 5000, { min: 1 }),
  heartbeatMs: int("HEARTBEAT_MS", 15000, { min: 10 }),
  emptyRoomTtlMs: int("EMPTY_ROOM_TTL_MS", 60000, { min: 1 }),
  shutdownGraceMs: int("SHUTDOWN_GRACE_MS", 5000, { min: 1 }),
};

export function loadConfig(env = process.env) {
  return Object.fromEntries(Object.entries(SCHEMA).map(([key, read]) => [key, read(env)]));
}
