import http from "node:http";
import { BotManager } from "./bot.js";
import { createHttpHandler } from "./http.js";
import { startMatchLog } from "./log/matchlog.js";
import { CLOSE } from "./protocol.js";
import { Match } from "./match.js";
import { RoomManager } from "./rooms.js";
import { attachWebSocket } from "./ws.js";

// Rooms that always exist (never reaped), shown in the lobby from the start.
const DEFAULT_ROOMS = [
  { id: "open-space", name: "Open space", arena: { asteroids: 6, pickups: true } },
  { id: "rock-field", name: "Rock field", arena: { asteroids: 12, pickups: true } },
  {
    id: "quiet-corner",
    name: "Quiet corner",
    arena: { asteroids: 2, pickups: false },
    maxPlayers: 4,
  },
];

export function createApp(config, { log = console } = {}) {
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
    emptyRoomTtlMs: config.emptyRoomTtlMs,
    defaultArena: { asteroids: 6, pickups: true },
  });

  // Every room has an authoritative Match (it only ticks while somebody is in it).
  rooms.on("created", (room) => {
    room.match = new Match({ room, log });
  });

  // One match log per room; `pending` lets shutdown wait until every file is flushed.
  const pending = new Set();
  rooms.on("created", (room) => {
    const { done } = startMatchLog(room, {
      dir: config.logDir,
      onError: (err) => log.error("[matchlog]", err),
    });
    pending.add(done);
    void done.finally(() => pending.delete(done)); // `done` never rejects (see startMatchLog)
  });

  const server = http.createServer();
  const wss = attachWebSocket({ server, rooms, config, log });
  const bots = new BotManager({ log });
  const handleRequest = createHttpHandler({
    config,
    rooms,
    bots,
    getStats: () => ({ connections: wss.clients.size }),
    getMatches: () =>
      rooms
        .list()
        .filter((r) => r.match?.running)
        .map((r) => r.match.stats()),
  });
  server.on("request", (req, res) => {
    // The handler answers its own errors; this is the last safety net, so that a failure while
    // sending an error reply drops that one connection instead of crashing the whole server.
    handleRequest(req, res).catch((err) => {
      log.error("[http] request handler failed:", err);
      res.destroy();
    });
  });

  for (const { id, ...opts } of DEFAULT_ROOMS) rooms.create(id, { ...opts, persistent: true });

  return {
    server,
    wss,
    rooms,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    /** Graceful shutdown: stop accepting, say goodbye, flush logs, then wait (up to a grace period). */
    async close() {
      const closed = new Promise((resolve) => server.close(resolve)); // no new connections
      server.closeIdleConnections();
      for (const client of wss.clients) client.close(CLOSE.GOING_AWAY, "server shutting down");
      rooms.closeAll(); // rooms emit "closed" -> match logs end their pipelines
      await Promise.allSettled([...pending]); // files flushed and closed
      const force = setTimeout(() => {
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections();
      }, config.shutdownGraceMs);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    },
  };
}
