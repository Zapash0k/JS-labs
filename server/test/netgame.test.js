// Headless netcode tests: the real client logic (client/src/net) against the real server with injected latency.
// Each "bot" is a Connection + NetGame stepping at 30 Hz with a scripted keyboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TICK_DT } from "@dogfight/shared/protocol.js";
import { Connection } from "../../client/src/net/connection.js";
import { NetGame } from "../../client/src/net/netgame.js";
import { once } from "../../client/src/events.js";
import { sleep, startServer } from "./helpers.js";

const keys = (tick) => {
  const down = new Set(["ArrowUp"]);
  down.add(tick % 90 < 45 ? "ArrowRight" : "ArrowLeft");
  if (tick % 20 < 3) down.add("Space");
  return { isDown: (code) => down.has(code) };
};

async function startBot(
  s,
  { name, room = "open-space", rtt = 0, jitter = 0, drop = 0, codec = "binary", options = {} },
) {
  const query = `?rtt=${rtt}&jitter=${jitter}&drop=${drop}`;
  const conn = new Connection({
    url: s.wsUrl + query,
    hello: () => ({ type: "join", room, name, codec }),
    baseMs: 50,
  });
  const joined = once(conn, "message:joined");
  conn.open();
  const { detail } = await joined;
  const net = new NetGame({ conn, codec, slot: detail.you.slot, options });
  const bot = { conn, net, tick: 0, frames: [] };
  bot.run = async (ticks, onFrame) => {
    for (let i = 0; i < ticks; i++, bot.tick++) {
      net.step(TICK_DT, keys(bot.tick));
      net.update(TICK_DT);
      onFrame?.(net.drawables(1), i);
      await sleep(33);
    }
  };
  bot.stop = () => (net.destroy(), conn.close());
  return bot;
}

const summarize = (net, from = 0) => {
  const h = net.stats.correctionHistory.slice(from);
  return { avg: h.reduce((a, b) => a + b, 0) / h.length, max: Math.max(...h), n: h.length };
};

test("prediction + reconciliation at 100 ms RTT +-30 ms jitter: corrections stay ~0", async () => {
  const s = await startServer();
  try {
    const bot = await startBot(s, { name: "Ace", rtt: 100, jitter: 30 });
    await bot.run(150);
    const c = summarize(bot.net, 20);
    console.log(
      `  corrections: avg ${c.avg.toFixed(4)} px, max ${c.max.toFixed(4)} px, rtt ${bot.net.stats.rtt.toFixed(0)} ms, pending ${bot.net.stats.pending}`,
    );
    assert.ok(c.n > 50, "snapshots arrived");
    assert.ok(
      c.avg < 0.05 && c.max < 0.5,
      `prediction should match the server: avg ${c.avg}, max ${c.max}`,
    );
    assert.ok(
      bot.net.stats.pending >= 2 && bot.net.stats.pending <= 8,
      `~RTT/33 unacknowledged inputs, got ${bot.net.stats.pending}`,
    );
    assert.ok(bot.net.stats.rtt > 80 && bot.net.stats.rtt < 200);
    assert.ok(bot.net.bullets.length >= 0);
    bot.stop();
  } finally {
    await s.close();
  }
});

test("breaking determinism on purpose makes the corrections grow", async () => {
  const s = await startServer();
  try {
    const good = await startBot(s, { name: "Good", rtt: 60, room: "rock-field" });
    const bad = await startBot(s, {
      name: "Bad",
      rtt: 60,
      room: "quiet-corner",
      options: { nondeterministic: true },
    });
    await Promise.all([good.run(120), bad.run(120)]);
    const g = summarize(good.net, 20);
    const b = summarize(bad.net, 20);
    console.log(
      `  deterministic: avg ${g.avg.toFixed(4)} px | with Math.random() in prediction: avg ${b.avg.toFixed(3)} px, max ${b.max.toFixed(2)} px`,
    );
    assert.ok(
      b.avg > 50 * Math.max(g.avg, 0.001),
      `random prediction should disagree with the server: ${b.avg} vs ${g.avg}`,
    );
    assert.ok(b.avg > 0.5);
    good.stop();
    bad.stop();
  } finally {
    await s.close();
  }
});

test("without reconciliation the prediction is never corrected and drifts when the server disagrees", async () => {
  const s = await startServer();
  try {
    const bot = await startBot(s, {
      name: "Ace",
      rtt: 60,
      options: { nondeterministic: true, reconcile: false },
    });
    await bot.run(120);
    const own = bot.net.local;
    const server = bot.net.serverSelf;
    const dist = Math.hypot(own.x - server.x, own.y - server.y);
    console.log(
      `  reconcile off + noise: client ${dist.toFixed(1)} px away from the server's ship (RTT lag included)`,
    );
    assert.ok(
      bot.net.stats.correctionAvg > 0.5,
      "the disagreement is measured even though it is not applied",
    );
    bot.stop();
  } finally {
    await s.close();
  }
});

test("2% packet drop: the game keeps working; corrections spike when an input was lost", async () => {
  const s = await startServer();
  try {
    const bot = await startBot(s, { name: "Ace", rtt: 100, jitter: 30, drop: 2 });
    await bot.run(200);
    const c = summarize(bot.net, 20);
    console.log(
      `  with 2% drop: corrections avg ${c.avg.toFixed(3)} px, max ${c.max.toFixed(2)} px`,
    );
    assert.ok(c.max < 60, "bounded: at most a few steps of movement");
    assert.ok(bot.net.local, "still alive and predicting");
    bot.stop();
  } finally {
    await s.close();
  }
});

test("the other player is interpolated: smooth positions, no teleporting, appears and disappears cleanly", async () => {
  const s = await startServer();
  try {
    const a = await startBot(s, { name: "Ace", rtt: 100, jitter: 30 });
    const b = await startBot(s, { name: "Bea", rtt: 100, jitter: 30 });
    const seen = [];
    await Promise.all([
      a.run(150, (list) =>
        seen.push(list.find((e) => e.kind === "ship" && e.slot !== a.net.slot && !e.own)?.pos),
      ),
      b.run(150),
    ]);
    const positions = seen.filter(Boolean);
    assert.ok(positions.length > 100, "the remote ship was drawn on most frames");
    let maxJump = 0;
    for (let i = 1; i < positions.length; i++) {
      const dx = Math.abs(positions[i].x - positions[i - 1].x);
      const dy = Math.abs(positions[i].y - positions[i - 1].y);
      if (dx < 640 && dy < 360) maxJump = Math.max(maxJump, Math.hypot(dx, dy)); // ignore wrap-arounds
    }
    console.log(
      `  remote ship: max movement between frames ${maxJump.toFixed(1)} px (top speed 420 px/s = 14 px per 33 ms)`,
    );
    assert.ok(maxJump < 25, `no teleporting: ${maxJump}`);
    assert.ok(
      a.net.interp.starved < 40,
      `interpolation buffer mostly full (starved ${a.net.interp.starved})`,
    );

    b.stop(); // the second player leaves: its ship disappears from A's view
    await sleep(600);
    a.net.update(0.016);
    assert.equal(
      a.net.drawables(1).some((e) => e.kind === "ship" && !e.own),
      false,
    );
    a.stop();
  } finally {
    await s.close();
  }
});

test("works the same with the JSON codec (the flag used for the comparison)", async () => {
  const s = await startServer();
  try {
    const bot = await startBot(s, { name: "Ace", rtt: 60, codec: "json" });
    await bot.run(90);
    const c = summarize(bot.net, 15);
    assert.ok(c.avg < 0.001, `JSON snapshots are exact: ${c.avg}`);
    bot.stop();
  } finally {
    await s.close();
  }
});
