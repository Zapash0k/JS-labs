# Dogfight server (Lab 04)

A `node:http` + [`ws`](https://github.com/websockets/ws) server: serves the built client, a small JSON API, rooms with
WebSocket chat, match logs streamed to disk, and replays streamed back.

```txt
npm install                       # at the repo root (npm workspaces: client + server)
npm run dev                       # server on :3000 and Vite on :5173 (Vite proxies /api, /health, /ws)
npm run build && npm start        # production: Node serves client/dist on http://127.0.0.1:3000
npm test                          # node:test, ~30 tests (HTTP, WebSocket, streams, shutdown, Connection)
```

Configuration is read from the environment in `src/config.js` only (`cp .env.example .env`; Node loads it with
`--env-file-if-exists`). Invalid values stop the server at startup with a message.

## Layout

```txt
src/index.js        entry: config -> app -> listen; SIGINT/SIGTERM -> graceful shutdown
src/app.js          wires RoomManager + http handler + WebSocketServer + match logs; close()
src/config.js       PORT, HOST, LOG_DIR, STATIC_DIR and all limits (validated)
src/http.js         routes: /health, /api/rooms (GET, POST), /api/replays[/:id], static fallback
src/static.js       static files: MIME types, ETag/304, path-traversal guard, pipeline streaming
src/rooms.js        Room extends EventEmitter; RoomManager (create / find / delete on "empty")
src/protocol.js     message types, close codes, validate()
src/ws.js           connection lifecycle: join deadline, validation, rate limit, heartbeat, slow clients
src/ratelimit.js    token bucket
src/log/matchlog.js room events -> object-mode Transform -> NDJSON file (pipeline)
src/log/replay.js   async generator over an NDJSON file; list of replays
scripts/            backpressure-demo.mjs, block-demo.mjs, crash-demo.mjs (experiments below)
test/               node:test suite
```

## HTTP API

| Request                 | Result                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /health`           | `{ status, uptimeSec, rss, rooms, connections }`                                                       |
| `GET /api/rooms`        | `[{ id, name, players, maxPlayers, arena }]`                                                           |
| `POST /api/rooms`       | body `{ name, maxPlayers?, arena? }` (JSON, capped at `MAX_BODY_BYTES`) → 201, 400/409/413/415/422/503 |
| `GET /api/replays`      | list of `{ id, size, modified }`                                                                       |
| `GET /api/replays/:id`  | the NDJSON file, **streamed** with `pipeline(createReadStream, res)`                                   |
| anything else under `/` | static file from `client/dist` (`403` for traversal, `404`, `503` if the client is not built)          |

Three rooms always exist (`open-space`, `rock-field`, `quiet-corner`). Rooms created by `POST` (or by a `join` to an
unknown id) are deleted when they become empty, or after `EMPTY_ROOM_TTL_MS` if nobody ever joins.

## WebSocket protocol v1 (`/ws`)

Text frames, JSON, every message has `{ "v": 1, "type": ... }`. The server validates every incoming message
(`validate()` returns a clean copy; unknown fields are dropped).

| Direction | Message                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| → server  | `join { room, name }` — must be the first message, within `JOIN_TIMEOUT_MS`                                |
| → server  | `chat { text }` (1–280 chars) · `leave {}`                                                                 |
| ← client  | `joined { room, you }` · `roster { room, players }` · `chat { from, text, t }` · `error { code, message }` |

Close codes: `1002` malformed / unknown / out of order · `1003` binary frame · `1008` rate limit · `1009` over
`MAX_PAYLOAD` (sent by `ws`) · `1001` server shutting down · `4001` no `join` in time · `4002` room full ·
`4003` too many rooms · `4004` client too slow. The client does not reconnect after the codes that retrying cannot fix.

## M3 — match logs and backpressure

Every room has a log: `events.on(room, "event")` → async generator → `Readable.from` → `NdjsonEncode` (an object-mode
`Transform`) → `createWriteStream("<LOG_DIR>/<room>-<timestamp>.ndjson")`, all joined by `pipeline`. When the room is
deleted it emits `"closed"`, the iteration ends and the file is flushed; shutdown waits for that.

**Experiment:** `node scripts/backpressure-demo.mjs 200 10` generates a 200 MB log, starts the server as a child
process and downloads it with a client throttled to 10 MB/s (it pauses the response stream, so TCP backpressure builds
up), sampling the server's RSS from `/health` every 200 ms. The same download is done through a deliberately bad
endpoint (`/api/replays-naive/:id`, `DEMO_ENDPOINTS=1`) that does `readFile` + `res.end`.

![RSS while a slow client downloads a 200 MB log](docs/rss-backpressure.svg)

| Download                          | RSS min / max |
| --------------------------------- | ------------- |
| idle server                       | 70 MB         |
| `pipeline(createReadStream, res)` | 73 / 104 MB   |
| `readFile` + `res.end`            | 274 / 274 MB  |

The streamed download stays flat (a few chunks of 64 KB plus the socket buffers); the naive one holds the whole file
(~200 MB). Raw samples: `docs/rss-streamed.csv`, `docs/rss-naive.csv`. _These numbers are from a run in a Linux
sandbox with a Node client; repeat it on your machine (or with DevTools → Network → Slow 4G, polling `/health`) and
replace them._

## M4 — abuse handling

| Limit                    | Where                             | Default                                     |
| ------------------------ | --------------------------------- | ------------------------------------------- |
| message size             | `WebSocketServer({ maxPayload })` | 4096 B → close 1009                         |
| message rate             | token bucket per socket           | burst 20, 10/s → close 1008                 |
| players per room / rooms | `RoomManager`                     | 8 / 50 → close 4002 / 4003                  |
| HTTP body                | `readBody` cap                    | 4096 B → 413 + `Connection: close`          |
| dead connections         | ping every 15 s, two missed pongs | `terminate()`                               |
| no `join`                | 5 s deadline                      | close 4001                                  |
| slow client              | `socket.bufferedAmount`           | > 64 KB: chat dropped; > 256 KB: close 4004 |

## The event loop, backpressure, and crashes (write-up)

**The loop.** Node runs my JavaScript on one thread. libuv cycles through phases: _timers_ (`setTimeout`/`setInterval`
callbacks that are due) → _pending callbacks_ → _poll_ (wait for and run I/O callbacks: a socket became readable, a file
read finished) → _check_ (`setImmediate`) → _close callbacks_. After every callback `process.nextTick` callbacks run,
then promise microtasks, before the loop moves on. File and DNS work is done by libuv's thread pool, but the result
comes back as a callback on the same single thread.

**What a blocking handler does.** A WebSocket message is a poll-phase callback. If another callback is running for
300 ms, that message waits in the queue — for _all_ clients, not just the one that caused it. I measured it with
`node scripts/block-demo.mjs 300 6` (two chat clients; one measures how long a message takes to reach the other, while a
third client calls `GET /api/slow?ms=300`, a busy loop, six times):

| Phase of the experiment           | messages | median latency | max latency |
| --------------------------------- | -------- | -------------- | ----------- |
| idle server                       | 9        | 1.4 ms         | 1.8 ms      |
| while `/api/slow` blocks the loop | 17       | 76.8 ms        | 274.6 ms    |
| idle again                        | 5        | 0.8 ms         | 0.9 ms      |

The handler itself is "correct", yet chat froze for up to 275 ms. Heartbeats and timers are delayed the same way. The
fix is never to compute on the loop (`worker_threads`, Lab 07) and to keep handlers short.

**Backpressure** appeared in M3: `res.write()` returns `false` when the socket's buffer is full; `pipeline` then pauses
the file stream until `"drain"`. Without it (`readFile`, or a `for` loop that ignores `write()`'s result) the data piles
up in RAM — see the graph. The same idea protects the WebSocket side: `socket.bufferedAmount` is the send buffer of a
client that does not read, and the slow-client policy drops chat for it instead of buffering without limit.

**Why an unhandled `"error"` / rejection kills the server.** `emit("error")` with no listener _throws_, and an
exception that reaches the top of the stack ends the process; since Node 15 an unhandled promise rejection does the same.
`node scripts/crash-demo.mjs error` reproduces it with `ws` itself: a client sends a frame bigger than `maxPayload`,
the server socket emits `'error'` (`RangeError`), nobody listens:

```txt
$ node scripts/crash-demo.mjs error
node:events:497
      throw er; // Unhandled 'error' event
      ^

RangeError: Max payload size exceeded
    at Receiver.haveLength (.../node_modules/ws/lib/receiver.js:442:28)
    ...
exit code: 1
```

One abusive client would take every room down. The fix is a listener on _every_ socket (`ws.js` does:
`socket.on("error", ...)`):

```txt
$ node scripts/crash-demo.mjs error-fixed
handled: Max payload size exceeded
mode "error-fixed": still alive after 500 ms          (exit code 0)
```

The same for promises: `socket.on("message", async () => { throw ... })` crashes (`rejection` mode; the stack points at the
handler), and `.catch()` / `try`-`await`-`catch` fixes it (`rejection-fixed`). In `ws.js` the message handler is wrapped
in `try/catch`, and `test/ws.test.js` checks that a client that vanishes or floods does not stop the server.

## Graceful shutdown

`SIGINT`/`SIGTERM` → `app.close()`: stop accepting connections, close idle HTTP connections, close every socket with
`1001`, close all rooms (which flushes the match logs), wait for the sockets to finish (force after
`SHUTDOWN_GRACE_MS`), `exit(0)`. Covered by `test/matchlog.test.js` ("graceful shutdown").

---

# Lab 05 — real-time networking

The match is now **server-authoritative**: the server runs the simulation at 30 Hz, clients send inputs and draw
what the server tells them, and hide the latency with prediction and interpolation.

```mermaid
sequenceDiagram
  participant P as Player
  participant C as Client (30 Hz)
  participant S as Server (30 Hz, authority)
  P->>C: hold thrust
  C->>C: predict own ship now (same shared code)
  C->>S: input #n (12 bytes)
  Note over S: apply one input per player per tick,<br/>World.step(1/30), build snapshots
  S->>C: snapshot (tick, ack = last input applied, own exact state, all entities)
  C->>C: reconcile: server state + replay of inputs > ack
  C->>C: interpolate everybody else ~66 ms in the past
```

## Where the code lives

| Package   | What is there                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/` | `sim/` (moved from the client: World, Ship, `shipPhysics.js`), `prng.js` (seeded), `protocol.js`, `codec/` (JSON + binary) — runs in browser and Node, no DOM |
| `server/` | `match.js` (the 30 Hz loop), `netsim.js` (latency injector), `ws.js` (lifecycle), `/api/stats`                                                                |
| `client/` | `net/netgame.js` (prediction + reconciliation), `net/interpolation.js`, `net/netgraph.js`, `net/netui.js` (sliders)                                           |

`shared/test/sim.test.js` fails if shared code touches `document`/`window`, imports a Node built-in, or calls
`Math.random` / `Date.now`. The simulation takes a seeded PRNG (`mulberry32`); the server sends the seed in `joined`.

## Server loop (M1)

- Every room has a `Match`. It ticks only while somebody is in it. Per tick: dequeue **one** input per player,
  `world.setCommand`, `world.step(1/30)`, then one snapshot per player.
- **Timer:** each tick is scheduled against an absolute deadline (`next += 33.3 ms`), not with `setInterval`.
  A late tick is followed by a shorter wait, so the rate stays 30.0 Hz on average; after a stall longer than 4 steps
  it skips ahead instead of bursting (`skipped` counter). `/api/stats` shows tick duration, jitter and overruns.
- **No input = no movement:** a ship with nothing in its queue does not advance that tick. The client replays only the
  inputs the server has acknowledged (`ack`), so server and client stay in step however the packets bunch up.
- **Validation:** inputs are validated like every other message (`turn` outside −1..1 is a cheat and closes the
  socket with 1002, not a clamp). Stale/duplicate `seq` are dropped. Inputs have their own token bucket (30 burst, 40/s)
  and a queue of at most 8 per player.

## Prediction and reconciliation (M2)

The client simulates its own ship with `stepShipState` (`shared/src/sim/shipPhysics.js`) **before** the server answers;
the server's `Ship.update` calls the very same function with the same `dt`, so for the same inputs both compute the same
numbers. When a snapshot arrives it contains the server's ship state after input `ack`; the client takes that state,
replays the inputs it has sent since (`seq > ack`) and compares the result with its own prediction. The difference is the
_correction_; it is applied at once to the simulation but hidden visually by an offset that decays in ~100 ms.
(`test/match.test.js` proves the equality for both codecs; `test/netgame.test.js` measures it end to end.)

## Interpolation (M3)

Other ships, bullets and asteroids are drawn 66 ms (two snapshots, adjustable 0–300 ms) in the past, between the two
snapshots that bracket that moment, with shortest-arc angle interpolation and no interpolation across a screen wrap.
Own bullets are predicted (spawned at the press, matched to the server's by `fireSeq`, dropped once the server has seen
them and they are gone). If the buffer runs dry (`starved` in the netgraph) the newest snapshot is drawn.

## Binary protocol (M4)

All numbers little-endian. Full byte layout: the header comment of `shared/src/codec/binary.js`.

| Message                    | Size                                       | Notes                                                       |
| -------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| input (client → server)    | 12 bytes                                   | `u8 type, u8 version, u32 seq, u32 tick, u8 flags, i8 turn` |
| snapshot (server → client) | 14 + 41 (own state) + 18/entity + 10/event | position f32, angle i16 milliradians, ids u16               |

Control messages (join, chat, roster, ping) stay JSON text frames; `?codec=json` switches inputs and snapshots back to
JSON for comparison. Decoders treat every byte as untrusted: wrong length/type/version → `CodecError` → close 1002
(fuzzed in `shared/test/codec.test.js`).

### Measured: JSON vs binary (`node server/scripts/codec-bench.mjs`, 20 s of simulated play per row)

| codec / scenario          | entities | B/snapshot | KB/s per client | decode µs | tick ms |
| ------------------------- | -------- | ---------- | --------------- | --------- | ------- |
| json, 2 players, 0 ast    | 13.2     | 2088       | 61.17           | 14.1      | 0.117   |
| binary, 2 players, 0 ast  | 13.1     | 293        | 8.57            | 37.1      | 0.142   |
| json, 4 players, 6 ast    | 27.6     | 4018       | 117.72          | 61.6      | 0.426   |
| binary, 4 players, 6 ast  | 26.9     | 545        | 15.95           | 39.6      | 0.239   |
| json, 8 players, 12 ast   | 47.1     | 6722       | 196.92          | 61.0      | 0.503   |
| binary, 8 players, 12 ast | 47.7     | 923        | 27.04           | 7.8       | 0.204   |

Binary snapshots are **~7×** smaller (4 players: 4018 → 545 bytes, 118 → 16 KB/s per client). Inputs: 85 → 12 bytes
(×30/s). Decode times are tiny either way and noisy (JIT warm-up), so bandwidth, not CPU, is the argument for binary.

### Measured: the cost of a wrong prediction (`npm test -w server`, 100 ms RTT ± 30 ms jitter)

| Case                                           | correction avg | correction max |
| ---------------------------------------------- | -------------- | -------------- |
| deterministic prediction                       | 0.0000 px      | 0.0001 px      |
| `Math.random()` inside the prediction          | 0.734 px       | 1.33 px        |
| deterministic, 2 % of inputs/snapshots dropped | 0.176 px       | 6.16 px        |

With the same code on both sides the correction is only float32 rounding (< 0.001 px); one random number per step makes
it visible every snapshot. A lost input shows as one step of movement (≈ 6–14 px) that is corrected.

### Measured: the 30 Hz loop (`node server/scripts/tick-stats-demo.mjs 4 10`, 4 bots, 60 ms RTT ± 20 ms)

`tickMs` avg 0.31 / max 4.4 (budget 33.3), `jitterMs` avg 0.63 / max 7.2, overruns 0, skipped 0, 12.9 KB/s down and
0.4 KB/s up per client, server RSS 73 MB. _These numbers come from a Linux sandbox; run the scripts on your machine and
replace them._

## Latency injector and experiments

Server-side, per socket, both directions (`netsim.js`): added RTT (half per direction), jitter, drop % for game messages.
Delivery stays in order (like TCP: a late message holds back the rest). Start with `?rtt=100&jitter=30&drop=2` or use the
sliders in the game (they send `{type:"netsim"}`; `NETSIM=0` disables it). In the game window:

1. **M1:** untick _client-side prediction_: the ship now moves only when a snapshot arrives, one RTT late, at 30 Hz.
2. **M2:** tick it again; at 100 ms RTT thrust responds at once. Untick _reconciliation_ or tick _break determinism_
   and watch `correction` in the netgraph grow.
3. **M3:** open a second window in the same room; move _interpolation delay_ to 0 and the other ship starts to stutter.
4. **Determinism:** `npm run hash -w shared` prints `[hashcheck] seed=42 ticks=1000 -> 18cf1134`; open
   `/?hashcheck=1` in the browser, and the console line must show the same hash.

## Known gaps

- The browser could not be driven in my environment: the headless tests use the real client logic against the real
  server, but I could not record the two-window GIF or compare the browser hash — do both.
- No lag compensation for hits (the server checks collisions at its own present), no scoreboard in the UI.
- Drop is simulated at the application level (WebSocket is reliable); real TCP would add head-of-line blocking instead.
