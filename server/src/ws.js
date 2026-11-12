// WebSocket lifecycle: join deadline, validation of every message, rate limit, heartbeat,
// slow-client policy, and an "error" listener on every socket.
import { WebSocketServer, WebSocket } from "ws";
import { CLOSE, encode, validate } from "./protocol.js";
import { TokenBucket } from "./ratelimit.js";
import { RoomLimitError, newPlayerId } from "./rooms.js";

export function attachWebSocket({ server, rooms, config, log = console }) {
  // maxPayload: ws refuses bigger frames itself (close code 1009 + an "error" event on the socket).
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: config.maxPayload });
  wss.on("error", (err) => log.error("[ws] server error:", err));

  // Every room gets the same wiring: roster on join/leave, chat to everyone.
  rooms.on("created", (room) => {
    const sendRoster = () =>
      room.broadcast(encode("roster", { room: room.id, players: room.roster() }), {
        critical: true,
      });
    room.on("join", sendRoster);
    room.on("leave", sendRoster);
    room.on("chat", (msg) => room.broadcast(encode("chat", msg)));
  });

  function makeSend(socket, session) {
    // Slow-client policy: above the threshold, droppable messages (chat) are skipped; far above it,
    // the client is cut off. Critical messages (joined, roster) always go through below the hard limit.
    return (data, { critical = false } = {}) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const buffered = socket.bufferedAmount;
      if (buffered > config.slowClientBytes * 4) {
        socket.close(CLOSE.SLOW_CLIENT, "client too slow");
        return;
      }
      if (buffered > config.slowClientBytes && !critical) {
        session.dropped++;
        return;
      }
      socket.send(data, () => {}); // errors are reported through the socket's "error" event
    };
  }

  wss.on("connection", (socket) => {
    const session = {
      id: newPlayerId(),
      player: null,
      room: null,
      missed: 0, // heartbeats sent without an answer
      dropped: 0,
      bucket: new TokenBucket({ capacity: config.rateBurst, perSec: config.ratePerSec }),
      joinTimer: null,
    };
    socket.session = session; // { player, room } travel with the socket
    const send = makeSend(socket, session);

    const fail = (code, reason) => {
      send(encode("error", { code: "rejected", message: reason }), { critical: true });
      socket.close(code, reason.slice(0, 100));
    };

    // A socket that never says who it is gets cut after joinTimeoutMs.
    session.joinTimer = setTimeout(
      () => fail(CLOSE.JOIN_TIMEOUT, "join timeout"),
      config.joinTimeoutMs,
    );

    socket.on("error", (err) => log.warn(`[ws] socket ${session.id}: ${err.message}`));
    socket.on("pong", () => {
      session.missed = 0;
    });
    socket.on("close", () => {
      clearTimeout(session.joinTimer);
      session.room?.leave(session.player);
    });
    socket.on("message", (data, isBinary) => {
      try {
        onMessage(data, isBinary);
      } catch (err) {
        log.error(`[ws] handler error for ${session.id}:`, err);
        socket.close(CLOSE.INTERNAL, "internal error");
      }
    });

    function onMessage(data, isBinary) {
      if (isBinary) return fail(CLOSE.UNSUPPORTED, "binary messages are not supported");
      if (!session.bucket.take()) return fail(CLOSE.POLICY, "rate limit exceeded");

      let raw;
      try {
        raw = JSON.parse(data.toString("utf8"));
      } catch {
        return fail(CLOSE.PROTOCOL, "message is not valid JSON");
      }
      const checked = validate(raw);
      if (!checked.ok) return fail(CLOSE.PROTOCOL, checked.reason);
      const { msg } = checked;

      if (msg.type === "join") {
        if (session.player) return fail(CLOSE.PROTOCOL, "already joined");
        let room = rooms.get(msg.room);
        if (!room) {
          try {
            room = rooms.create(msg.room);
          } catch (err) {
            if (err instanceof RoomLimitError) return fail(CLOSE.SERVER_BUSY, "too many rooms");
            throw err;
          }
        }
        if (room.size >= room.maxPlayers) return fail(CLOSE.ROOM_FULL, "room is full");
        clearTimeout(session.joinTimer);
        const player = { id: session.id, name: msg.name, send };
        session.player = player;
        session.room = room;
        send(encode("joined", { room: room.id, you: { id: player.id, name: player.name } }), {
          critical: true,
        });
        room.join(player); // emits "join" -> roster broadcast
        return;
      }

      if (!session.player) return fail(CLOSE.PROTOCOL, "join first");
      if (msg.type === "chat") return session.room.chat(session.player, msg.text);
      if (msg.type === "leave") return socket.close(CLOSE.NORMAL, "bye");
    }
  });

  // Heartbeat: ping everyone; a socket that left two pings unanswered is dead (NAT, proxy, sleep).
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const session = socket.session;
      if (!session) continue;
      if (session.missed >= 2) {
        socket.terminate();
        continue;
      }
      session.missed++;
      try {
        socket.ping();
      } catch (err) {
        log.warn(`[ws] ping failed: ${err.message}`);
      }
    }
  }, config.heartbeatMs);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
