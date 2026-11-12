import http from "node:http";
import { createHttpHandler } from "./http.js";
import { startMatchLog } from "./log/matchlog.js";
import { CLOSE } from "./protocol.js";
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

  // One match log per room; `pending` lets shutdown wait until every file is flushed.
  const pending = new Set();
  rooms.on("created", (room) => {
    const { done } = startMatchLog(room, {
      dir: config.logDir,
      onError: (err) => log.error("[matchlog]", err),
    });
    pending.add(done);
    done.finally(() => pending.delete(done));
  });

  const server = http.createServer();
  const wss = attachWebSocket({ server, rooms, config, log });
  server.on(
    "request",
    createHttpHandler({ config, rooms, getStats: () => ({ connections: wss.clients.size }) }),
  );

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
