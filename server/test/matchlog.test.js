import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NdjsonEncode } from "../src/log/matchlog.js";
import { listReplays, readEvents, replayPath } from "../src/log/replay.js";
import { joinRoom, sleep, startServer } from "./helpers.js";

async function collect(readable) {
  const out = [];
  for await (const chunk of readable) out.push(Buffer.from(chunk));
  return Buffer.concat(out).toString("utf8");
}

test("NdjsonEncode: objects in, one line each out; a bad object fails the stream", async () => {
  const text = await collect(Readable.from([{ a: 1 }, { b: "я" }]).pipe(new NdjsonEncode()));
  assert.equal(text, '{"a":1}\n{"b":"я"}\n');
  const circular = {};
  circular.self = circular;
  await assert.rejects(
    pipeline(Readable.from([circular]), new NdjsonEncode(), async (src) => collect(src)),
    TypeError,
  );
});

test("readEvents handles lines and multi-byte characters across chunk boundaries", async (t) => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "replay-"));
  const file = join(dir, "x.ndjson");
  const events = Array.from({ length: 5000 }, (_, i) => ({ i, text: "привіт ".repeat(10) }));
  await writeFile(file, events.map((e) => JSON.stringify(e)).join("\n")); // no trailing newline
  const got = [];
  for await (const e of readEvents(file)) got.push(e);
  assert.equal(got.length, 5000);
  assert.deepEqual(got[4999], events[4999]);

  await appendFile(file, "\n{broken\n");
  await assert.rejects(async () => {
    for await (const e of readEvents(file)) void e;
  }, /invalid JSON on line 5001/);
  t.diagnostic(`file size ${(await readFile(file)).length} bytes`);
});

test("replayPath only accepts plain ids", () => {
  assert.ok(replayPath("/logs", "room-2026-11-11T10-00-00-000Z"));
  for (const id of ["..", "../x", "a/b", "a\\b", "", "a.b", "x".repeat(101)])
    assert.equal(replayPath("/logs", id), null, id);
});

test("a room's events end up in an NDJSON file, which the replay endpoint streams back", async () => {
  const s = await startServer();
  try {
    const a = await joinRoom(s.wsUrl, "match-1", "Ace");
    const b = await joinRoom(s.wsUrl, "match-1", "Bea");
    a.sendJson({ type: "chat", text: "gg" });
    await b.waitFor((m) => m.type === "chat");
    a.close();
    b.close();
    await Promise.all([a.closed, b.closed]);
    await sleep(100); // room becomes empty -> deleted -> closed -> log flushed

    const files = (await readdir(s.config.logDir)).filter((f) => f.startsWith("match-1-"));
    assert.equal(files.length, 1);
    const events = [];
    for await (const e of readEvents(join(s.config.logDir, files[0]))) events.push(e);
    assert.deepEqual(
      events.map((e) => e.type),
      ["room_open", "join", "join", "chat", "leave", "leave", "room_closed"],
    );
    assert.equal(events[3].text, "gg");
    assert.ok(events.every((e, i) => i === 0 || e.t >= events[i - 1].t));

    const list = await (await fetch(s.url + "/api/replays")).json();
    const id = files[0].replace(".ndjson", "");
    assert.ok(list.some((r) => r.id === id && r.size > 0));

    const res = await fetch(`${s.url}/api/replays/${id}`);
    assert.equal(res.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.equal((await res.text()).trim().split("\n").length, 7);
    assert.equal((await fetch(`${s.url}/api/replays/nope`)).status, 404);
    assert.equal((await fetch(`${s.url}/api/replays/..%2f..%2fpackage`)).status, 404);
    assert.equal((await listReplays(s.config.logDir)).length >= 1, true);
  } finally {
    await s.close();
  }
});

test("graceful shutdown: sockets get 1001, logs are flushed, close() resolves", async () => {
  const s = await startServer();
  const ws = await joinRoom(s.wsUrl, "open-space", "Ace");
  ws.sendJson({ type: "chat", text: "last words" });
  await ws.waitFor((m) => m.type === "chat");
  await s.close();
  assert.equal((await ws.closed).code, 1001);
  const files = (await readdir(s.config.logDir)).filter((f) => f.startsWith("open-space-"));
  const events = [];
  for await (const e of readEvents(join(s.config.logDir, files[0]))) events.push(e);
  assert.equal(events.at(-1).type, "room_closed");
  assert.ok(events.some((e) => e.type === "chat" && e.text === "last words"));
  await assert.rejects(fetch(s.url + "/health"), "the port is closed");
});
