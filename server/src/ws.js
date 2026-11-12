// WebSocket lifecycle: join deadline, validation of every message, rate limit, heartbeat,
// slow-client policy, and an "error" listener on every socket.
import { WebSocketServer, WebSocket } from "ws";
import { getCodec, CodecError } from "@dogfight/shared/codec/index.js";
import { NO_SLOT, TICK_HZ, WORLD_SIZE } from "@dogfight/shared/protocol.js";
import { CLOSE, encode, validate } from "./protocol.js";
import { NetSim } from "./netsim.js";
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
    // Slow-client policy: above the threshold, droppable messages (chat, snapshots) are skipped; far above
    // it, the client is cut off. Critical messages (joined, roster) always go through below the hard limit.
    // Everything passes through the latency injector (outbound direction) on its way out.
    return (data, { critical = false, game = false } = {}) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (game && session.netsim.shouldDrop()) return;
      session.netsim.out(() => {
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
        session.bytesOut += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        if (session.player) session.player.bytesOut = session.bytesOut;
        socket.send(data, () => {}); // errors are reported through the socket's "error" event
      });
    };
  }

  wss.on("connection", (socket, req) => {
    const params = new URL(req.url, "http://localhost").searchParams;
    const num = (key, def, max) => {
      const n = Number(params.get(key));
      return config.netsim && Number.isFinite(n) && params.has(key)
        ? Math.min(Math.max(n, 0), max)
        : def;
    };
    const session = {
      netsim: new NetSim({
        rttMs: num("rtt", config.netsimRttMs, 2000),
        jitterMs: num("jitter", config.netsimJitterMs, 1000),
        dropPct: num("drop", config.netsimDropPct, 100),
      }),
      bytesIn: 0,
      bytesOut: 0,
      id: newPlayerId(),
      player: null,
      room: null,
      missed: 0, // heartbeats sent without an answer
      dropped: 0,
      bucket: new TokenBucket({ capacity: config.rateBurst, perSec: config.ratePerSec }),
      inputBucket: new TokenBucket({ capacity: config.inputBurst, perSec: config.inputPerSec }),
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
      session.netsim.dispose();
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
      session.bytesIn += data.length;
      if (session.player) session.player.bytesIn = session.bytesIn;

      // 1. decode: binary frames are game inputs, text frames are JSON control messages (or JSON inputs)
      let raw;
      if (isBinary) {
        try {
          raw = { v: 1, type: "input", ...getCodec("binary").decodeInput(data) };
        } catch (err) {
          if (err instanceof CodecError) return fail(CLOSE.PROTOCOL, err.message);
          throw err;
        }
      } else {
        try {
          raw = JSON.parse(data.toString("utf8"));
        } catch {
          return fail(CLOSE.PROTOCOL, "message is not valid JSON");
        }
      }
      const checked = validate(raw);
      // 2. abuse limits: inputs have their own bucket (about 30 per second are normal)
      const isInput = checked.ok && checked.msg.type === "input";
      if (rateLimited(isInput ? "input" : "message"))
        return fail(CLOSE.POLICY, "rate limit exceeded");
      if (!checked.ok) return fail(CLOSE.PROTOCOL, checked.reason);
      const { msg } = checked;

      // 3. latency injector (inbound direction): the message takes effect after the simulated delay
      if (isInput && session.netsim.shouldDrop()) return;
      session.netsim.in(() => {
        if (socket.readyState === WebSocket.OPEN) handle(msg);
      });
    }

    const rateLimited = (kind) => !(kind === "input" ? session.inputBucket : session.bucket).take();

    function handle(msg) {
      if (msg.type === "ping") return send(encode("pong", { t: msg.t }), { critical: true });
      if (msg.type === "netsim") {
        if (!config.netsim) return fail(CLOSE.POLICY, "latency injector is disabled");
        session.netsim.set({ rttMs: msg.rtt, jitterMs: msg.jitter, dropPct: msg.drop });
        return;
      }

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
        const player = {
          id: session.id,
          name: msg.name,
          send,
          codec: msg.codec,
          slot: NO_SLOT,
          bytesIn: 0,
          bytesOut: 0,
        };
        session.player = player;
        session.room = room;
        const slot = room.match ? room.match.addPlayer(player) : NO_SLOT;
        send(
          encode("joined", {
            room: room.id,
            you: { id: player.id, name: player.name, slot },
            tickRate: TICK_HZ,
            seed: room.match?.seed ?? 0,
            world: WORLD_SIZE,
            codec: msg.codec,
          }),
          { critical: true },
        );
        room.join(player); // emits "join" -> roster broadcast
        return;
      }

      if (!session.player) return fail(CLOSE.PROTOCOL, "join first");
      if (msg.type === "input") return session.room.match?.receiveInput(session.player.id, msg);
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
