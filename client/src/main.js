import { createLoop } from "./loop.js";
import { createInput } from "./input.js";
import { World } from "./sim/world.js";
import { setupCanvas } from "./render/canvas.js";
import { drawBackground, drawHud, drawWorld, makeStars } from "./render/draw.js";
import { drawLoading } from "./render/loading.js";
import { createSprites } from "./render/sprites.js";
import { loadAll, loadManifest, HttpError, JsonError } from "./assets/loader.js";
import { injectFailure } from "./assets/failures.js";
import { createAudio } from "./audio.js";
import { createHud } from "./hud.js";
import { Lobby } from "./lobby/lobby.js";
import { mountLobbyView } from "./lobby/lobbyView.js";
import { once } from "./events.js";
import { Connection, wsUrl } from "./net/connection.js";
import { mountChat } from "./chatView.js";

// Experiment switches, set through the URL:
// Lab 01:
//   ?busy=1           experiment 1: 100 ms busy-wait in render every 60th frame
//   ?loop=interval    experiment 2: setInterval(frame, 16) instead of requestAnimationFrame
//   ?step=variable    experiment 3: no accumulator, simulate(dt) once per frame
//   ?auto=1           hold "thrust" automatically and report position after 5 s of sim time
//                     (asteroids and pickups are off; skips the lobby so the result stays comparable)
// Lab 02:
//   ?bug=1            wire the click handler naively (ship.fire) to show the `this` bug
// Lab 03:
//   ?fail=MODE        failure gallery: 404 | 404-critical | timeout | 503 | json (see assets/failures.js)
//   ?delay=MS         every /assets request is delayed by MS (dev server), to see the progress bar
//   ?seq=1            load assets one after another instead of concurrently (README timing)
//   ?nolobby=1        skip the lobby and start the default arena (offline, no server needed)
// Lab 04: without ?nolobby / ?auto the lobby talks to the Node server (npm run dev:server) over
//   /api/rooms and a WebSocket on /ws; two windows in one room see each other's names and chat.
const params = new URLSearchParams(location.search);
const busy = params.has("busy");
const mode = params.get("loop") === "interval" ? "interval" : "raf";
const fixed = params.get("step") !== "variable";
const auto = params.has("auto");
const bug = params.has("bug");
const fail = params.get("fail");
const sequential = params.has("seq");
const delay = Number(params.get("delay")) || 0;
const urlFor = (url) => (delay && url.startsWith("/assets/") ? `${url}?delay=${delay}` : url);

const canvas = document.getElementById("game");
const { ctx, size } = setupCanvas(canvas);

const realInput = createInput(window);
const input = auto
  ? { isDown: (code) => code === "ArrowUp", justPressed: () => false, endStep() {} }
  : realInput;

let audio = null;
try {
  audio = createAudio();
} catch (err) {
  console.warn("[audio] disabled:", err.message);
}
const hud = createHud();

// Scene state. Until startGame() runs, `game` is null and the loop draws the loading screen / lobby backdrop.
const loading = { done: 0, total: 0, error: null };
let game = null;
let idleStars = makeStars(140, size.w, size.h);
let assetInfo = "assets: loading";
let autoResult = null;
let net = null; // Connection to the server once joined
let frameCounter = 0;

const loop = createLoop({
  mode,
  fixed,
  simulate(dt) {
    if (!game) return;
    game.world.step(dt, input);
    input.endStep();

    if (auto && autoResult === null && loop.stats.simTime + dt >= 5 - 1e-6) {
      const { x, y } = game.world.player.pos;
      autoResult = `x=${x.toFixed(3)} y=${y.toFixed(3)}`;
      console.log(
        `[auto] ${fixed ? "fixed" : "variable"} step, ${mode}: after ~5 s sim time -> ${autoResult}`,
      );
    }
  },
  render(alpha, stats) {
    frameCounter++;
    if (busy && frameCounter % 60 === 0) {
      const t = performance.now();
      while (performance.now() < t + 100) {
        // deliberate synchronous block (experiment 1)
      }
    }

    if (!game) {
      if (!assets) drawLoading(ctx, size.w, size.h, loading);
      else drawBackground(ctx, size.w, size.h, idleStars);
      return;
    }

    const { world } = game;
    const p = world.player;
    drawBackground(ctx, size.w, size.h, game.stars, game.background);
    drawWorld(ctx, world, alpha, size, sprites);
    hud.draw(ctx);
    drawHud(ctx, stats, [
      `pilot: ${game.pilot} · room: ${game.room}`,
      `score: ${world.score}`,
      p.alive ? `hp: ${p.hp}` : `respawn in: ${world.respawnIn?.toFixed(1) ?? "-"} s`,
      `shield ${p.shield.toFixed(1)}  rapid ${p.rapid.toFixed(1)}  homing ${p.homingAmmo.toFixed(1)}`,
      `entities: ${world.count}`,
      assetInfo,
      `net: ${net ? (net.connected ? "connected" : "reconnecting...") : "offline"}`,
      `sound: ${audio ? (audio.unlocked ? "on" : "click to enable") : "unavailable"}`,
      ...(auto ? [`auto @5s: ${autoResult ?? "running..."}`] : []),
    ]);
  },
});
loop.start(); // running from the first frame: the loading screen animates while assets load

window.addEventListener("resize", () => {
  idleStars = makeStars(140, size.w, size.h);
  if (game) game.stars = makeStars(game.starCount, size.w, size.h);
});

// ---------- loading ----------

let assets = null;
let sprites = null;

function describe(err, cancelled) {
  if (cancelled) return "Loading cancelled";
  const cause = err.cause ?? err;
  const what = err.item?.key ?? "asset";
  if (cause instanceof HttpError) return `${what}: server answered ${cause.status}`;
  if (cause instanceof JsonError) return `${what}: corrupt JSON`;
  if (cause?.name === "TimeoutError") return `${what}: timed out`;
  if (cause instanceof TypeError) return `${what}: network error`;
  return `${what}: ${cause.message}`;
}

async function loadOnce(signal) {
  const timeoutMs = fail === "timeout" ? 1500 : 8000;
  let manifest = injectFailure(
    await loadManifest("/assets/manifest.json", { signal, urlFor }),
    fail,
  );
  if (!audio) manifest = { ...manifest, assets: manifest.assets.filter((a) => a.type !== "audio") };
  const result = await loadAll(manifest, {
    signal,
    audioCtx: audio?.ctx,
    timeoutMs,
    sequential,
    urlFor,
    onProgress(done, total) {
      loading.done = done;
      loading.total = total;
    },
  });
  console.log(
    `[assets] ${loading.total} items in ${result.ms.toFixed(0)} ms (${sequential ? "sequential" : "concurrent"}), skipped: ${result.failures.length}`,
    result.failures.map((f) => `${f.key}: ${f.error.message}`),
  );
  return { ...result, frames: manifest.frames };
}

// Retry loop: a critical failure (or Esc) shows an error + Retry button; click or any key tries again.
async function loadWithRetryScreen() {
  for (;;) {
    const attempt = new AbortController();
    const onKey = (e) => e.code === "Escape" && attempt.abort();
    window.addEventListener("keydown", onKey);
    loading.error = null;
    loading.done = 0;
    loading.total = 0;
    try {
      return await loadOnce(attempt.signal);
    } catch (err) {
      loading.error = describe(err, attempt.signal.aborted);
      console.warn("[assets] failed:", err);
    } finally {
      window.removeEventListener("keydown", onKey);
    }
    const wait = new AbortController();
    await Promise.race([
      once(canvas, "click", { signal: wait.signal }),
      once(window, "keydown", { signal: wait.signal }),
    ]);
    wait.abort(); // drop the listener of the loser: Promise.race does not cancel it
  }
}

// ---------- game ----------

function startGame({ room = { id: "default", name: "default", arena: {} }, name = "Pilot" } = {}) {
  const arena = { ...(assets.json.arena ?? {}), ...room.arena };
  const world = new World(size, {
    hazards: !auto,
    asteroidTarget: arena.asteroids,
    pickups: arena.pickups,
  });
  world.start();

  const life = new AbortController();
  audio?.attach(world.events, life.signal);
  hud.attach(world.events, life.signal);

  // `this` bug (README): handing over the method loses the ship, because the browser calls
  // the listener with this = canvas. Also the player changes on respawn, so wrap in an arrow.
  if (bug) canvas.addEventListener("click", world.player.fire);
  else canvas.addEventListener("click", () => world.player.fire());

  const starCount = arena.stars ?? 140;
  game = {
    world,
    pilot: name,
    room: room.name,
    starCount,
    stars: makeStars(starCount, size.w, size.h),
    background: arena.background,
  };
}

assets = await loadWithRetryScreen();
if (assets.images.sprites) sprites = createSprites(assets.images.sprites, assets.frames);
audio?.setBuffers(assets.sounds);
assetInfo =
  `assets: ${loading.total - assets.failures.length}/${loading.total} in ${assets.ms.toFixed(0)} ms` +
  (assets.failures.length ? ` (skipped: ${assets.failures.map((f) => f.key).join(", ")})` : "");

if (auto || params.has("nolobby")) {
  startGame();
} else {
  const lobby = new Lobby();
  const view = mountLobbyView(document.getElementById("lobby"), lobby);
  lobby.addEventListener("joined", (e) => joinRoom(lobby, view, e.detail));
  lobby.enter();
}

// The player picked a room: open the socket, send `join`, start the game when the server confirms.
function joinRoom(lobby, view, { room, name }) {
  view.setStatus(`Joining ${room.name}...`);
  const conn = new Connection({
    url: wsUrl(),
    hello: () => ({ type: "join", room: room.id, name }),
  });
  let joined = false;

  conn.on("joined", () => {
    joined = true;
    net = conn;
    view.destroy();
    mountChat(document.getElementById("chat"), conn);
    startGame({ room, name });
  });
  conn.addEventListener("close", (e) => {
    if (joined) return; // in-game: the chat view reports it and the wrapper reconnects
    // Refused (room full, bad name...) or the server is down: back to the lobby.
    view.setStatus(
      `Cannot join: ${e.detail.reason || `connection closed (${e.detail.code})`}`,
      true,
    );
    conn.close();
    lobby.enter();
  });
  conn.open();
}
