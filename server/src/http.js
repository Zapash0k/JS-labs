import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream";
import { listReplays, replayPath } from "./log/replay.js";
import { slugify, isRoomId } from "./protocol.js";
import { RoomExistsError, RoomLimitError } from "./rooms.js";
import { serveStatic } from "./static.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function sendJson(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(json);
}

// Collects the body with a hard cap. On overflow we stop *storing* (memory stays bounded) and fail;
// the 413 response carries `Connection: close`, so the rest of the upload is dropped with the socket.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > limit) return reject(new HttpError(413, `body larger than ${limit} bytes`));
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, `body larger than ${limit} bytes`));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => !failed && resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limit) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const raw = await readBody(req, limit);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

function parseNewRoom(body, config) {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new HttpError(422, "body must be an object");
  const { name, maxPlayers, arena } = body;
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 32) {
    throw new HttpError(422, "name must be 1-32 characters");
  }
  const id = slugify(name);
  if (!isRoomId(id)) throw new HttpError(422, "name must contain letters or digits");
  const out = { id, name: name.trim() };
  if (maxPlayers !== undefined) {
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > config.maxPlayersPerRoom) {
      throw new HttpError(422, `maxPlayers must be an integer in 1..${config.maxPlayersPerRoom}`);
    }
    out.maxPlayers = maxPlayers;
  }
  if (arena !== undefined) {
    if (typeof arena !== "object" || arena === null || Array.isArray(arena))
      throw new HttpError(422, "arena must be an object");
    const a = {};
    if (arena.asteroids !== undefined) {
      if (!Number.isInteger(arena.asteroids) || arena.asteroids < 0 || arena.asteroids > 30) {
        throw new HttpError(422, "arena.asteroids must be an integer in 0..30");
      }
      a.asteroids = arena.asteroids;
    }
    if (arena.pickups !== undefined) {
      if (typeof arena.pickups !== "boolean")
        throw new HttpError(422, "arena.pickups must be a boolean");
      a.pickups = arena.pickups;
    }
    out.arena = a;
  }
  return out;
}

export function createHttpHandler({ config, rooms, getStats, getMatches = () => [] }) {
  async function route(req, res, url) {
    const { pathname } = url;

    if (pathname === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        uptimeSec: Math.round(process.uptime()),
        rss: process.memoryUsage().rss,
        rooms: rooms.size,
        ...getStats(),
      });
    }

    if (pathname === "/api/stats") {
      return sendJson(res, 200, {
        uptimeSec: Math.round(process.uptime()),
        rss: process.memoryUsage().rss,
        ...getStats(),
        matches: getMatches(), // tick duration and jitter per running match
      });
    }

    if (pathname === "/api/rooms") {
      if (req.method === "GET") return sendJson(res, 200, rooms.list());
      if (req.method === "POST") {
        const { id, ...opts } = parseNewRoom(await readJson(req, config.maxBodyBytes), config);
        try {
          const room = rooms.create(id, opts);
          return sendJson(res, 201, room, { Location: `/api/rooms/${room.id}` });
        } catch (err) {
          if (err instanceof RoomExistsError) throw new HttpError(409, err.message);
          if (err instanceof RoomLimitError) throw new HttpError(503, err.message);
          throw err;
        }
      }
      res.setHeader("Allow", "GET, POST");
      throw new HttpError(405, "method not allowed");
    }

    if (pathname === "/api/replays" && req.method === "GET") {
      return sendJson(res, 200, await listReplays(config.logDir));
    }

    const replay = /^\/api\/replays\/([^/]+)$/.exec(pathname);
    if (replay && req.method === "GET") {
      const file = replayPath(config.logDir, replay[1]);
      const info = file && (await stat(file).catch(() => null));
      if (!info?.isFile()) throw new HttpError(404, "no such replay");
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      });
      // The log may still be growing, so no Content-Length. pipeline(readStream, res): when the client
      // reads slowly, res.write() returns false, the file stream pauses, and memory stays flat.
      pipeline(createReadStream(file), res, () => {});
      return;
    }

    // ---- demo-only endpoints for the README experiments (DEMO_ENDPOINTS=1) ----
    if (config.demo && pathname === "/api/slow") {
      const ms = Math.min(Number(url.searchParams.get("ms")) || 300, 5000);
      const end = performance.now() + ms;
      while (performance.now() < end) {
        // deliberate synchronous busy loop: nothing else in this process runs meanwhile
      }
      return sendJson(res, 200, { blockedMs: ms });
    }
    const naive = /^\/api\/replays-naive\/([^/]+)$/.exec(pathname);
    if (config.demo && naive) {
      const file = replayPath(config.logDir, naive[1]);
      if (!file) throw new HttpError(404, "no such replay");
      const whole = await readFile(file).catch(() => null); // the anti-pattern: the whole file in RAM
      if (!whole) throw new HttpError(404, "no such replay");
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Content-Length": whole.length,
      });
      res.end(whole);
      return;
    }

    if (pathname.startsWith("/api/")) throw new HttpError(404, "no such endpoint");
    await serveStatic(req, res, pathname, config.staticDir);
  }

  return async function handler(req, res) {
    try {
      await route(req, res, new URL(req.url, "http://localhost"));
    } catch (err) {
      if (res.headersSent) return res.destroy(err);
      if (err instanceof HttpError) {
        const headers = err.status === 413 ? { Connection: "close" } : {};
        return sendJson(res, err.status, { error: err.message }, headers);
      }
      console.error("[http] unhandled error:", err);
      sendJson(res, 500, { error: "internal error" });
    }
  };
}
