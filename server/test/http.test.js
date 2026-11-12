import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startServer } from "./helpers.js";
import { resolveSafe } from "../src/static.js";

let s;
before(async () => (s = await startServer({ MAX_BODY_BYTES: "256" })));
after(() => s.close());

const post = (path, body, headers = { "Content-Type": "application/json" }) =>
  fetch(s.url + path, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// fetch() normalizes "/../", so traversal attempts are sent as raw bytes.
function raw(path) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(s.port, "127.0.0.1", () =>
      sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`),
    );
    let out = "";
    sock.on("data", (d) => (out += d));
    sock.on("end", () => resolve(out));
    sock.on("error", reject);
  });
}

test("serves index.html with the right MIME type and caching", async () => {
  const res = await fetch(s.url + "/");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.match(await res.text(), /<title>t<\/title>/);
  const js = await fetch(s.url + "/assets/a.js");
  assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
});

test("ETag gives 304; HEAD has no body; unknown file is 404; POST is 405", async () => {
  const first = await fetch(s.url + "/assets/a.js");
  const again = await fetch(s.url + "/assets/a.js", {
    headers: { "If-None-Match": first.headers.get("etag") },
  });
  assert.equal(again.status, 304);
  const head = await fetch(s.url + "/assets/a.js", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
  assert.equal((await fetch(s.url + "/nope.png")).status, 404);
  assert.equal((await post("/assets/a.js", "{}")).status, 405);
});

test("path traversal is refused", async () => {
  assert.equal(resolveSafe("/srv/dist", "/../secret.txt"), null);
  assert.equal(resolveSafe("/srv/dist", "/%2e%2e/secret.txt"), null);
  assert.equal(resolveSafe("/srv/dist", "/a\0b"), null);
  assert.equal(resolveSafe("/srv/dist", "/%E0%A4%A"), null);
  assert.equal(resolveSafe("/srv/dist", "/assets/a.js"), "/srv/dist/assets/a.js");
  for (const p of [
    "/../secret.txt",
    "/assets/../../secret.txt",
    "/%2e%2e/secret.txt",
    "/..%2fsecret.txt",
  ]) {
    const out = await raw(p);
    assert.match(out, /^HTTP\/1\.1 (403|404)/, p);
    assert.doesNotMatch(out, /top secret/, p);
  }
});

test("GET /health", async () => {
  const body = await (await fetch(s.url + "/health")).json();
  assert.equal(body.status, "ok");
  assert.ok(body.rss > 0 && body.rooms >= 3);
});

test("rooms API: list, create, duplicate, validation, size cap, content type", async () => {
  const list = await (await fetch(s.url + "/api/rooms")).json();
  assert.ok(list.some((r) => r.id === "open-space" && r.maxPlayers === 8 && r.players === 0));

  const created = await post("/api/rooms", {
    name: "My Room",
    arena: { asteroids: 3, pickups: false },
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("location"), "/api/rooms/my-room");
  assert.deepEqual((await created.json()).arena, { asteroids: 3, pickups: false });

  assert.equal((await post("/api/rooms", { name: "my room" })).status, 409);
  assert.equal((await post("/api/rooms", { name: "" })).status, 422);
  assert.equal((await post("/api/rooms", { name: "!!!" })).status, 422);
  assert.equal((await post("/api/rooms", { name: "x", arena: { asteroids: 99 } })).status, 422);
  assert.equal((await post("/api/rooms", { name: "x", maxPlayers: 100 })).status, 422);
  assert.equal((await post("/api/rooms", "{nope")).status, 400);
  assert.equal((await post("/api/rooms", "{}", { "Content-Type": "text/plain" })).status, 415);

  const big = await post("/api/rooms", { name: "big", pad: "x".repeat(1000) });
  assert.equal(big.status, 413);
  assert.equal(big.headers.get("connection"), "close");

  assert.equal((await fetch(s.url + "/api/rooms", { method: "DELETE" })).status, 405);
  assert.equal((await fetch(s.url + "/api/unknown")).status, 404);
  assert.equal((await fetch(s.url + "/api/slow")).status, 404, "demo endpoints are off by default");
});
