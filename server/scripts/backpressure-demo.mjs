// M3 experiment: server RSS while a slow client downloads a large NDJSON log.
//   node scripts/backpressure-demo.mjs [sizeMB=200] [clientMBps=10]
// Starts the real server as a child process (so RSS is the server's alone), downloads
//   1) /api/replays/<id>        pipeline(createReadStream, res)   -> RSS should stay flat
//   2) /api/replays-naive/<id>  readFile + res.end                -> RSS jumps by ~file size
// with the same throttled client, samples /health every 200 ms, writes CSV + docs/rss-backpressure.svg.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const sizeMB = Number(process.argv[2]) || 200;
const clientMBps = Number(process.argv[3]) || 10;
const here = fileURLToPath(new URL(".", import.meta.url));
const docs = join(here, "../docs");
const port = 3400 + Math.floor(Math.random() * 500);
const dir = await mkdtemp(join(tmpdir(), "bp-"));

// ---- 1. synthetic log (itself written with pipeline, so generating it is flat too) ----
const line = (i) =>
  JSON.stringify({
    t: 1_700_000_000_000 + i,
    type: "chat",
    player: { id: "a1b2c3d4", name: "Ace" },
    text: "x".repeat(60),
  }) + "\n";
const lineBytes = Buffer.byteLength(line(0));
const lines = Math.ceil((sizeMB * 1024 * 1024) / lineBytes);
async function* generate() {
  let batch = "";
  for (let i = 0; i < lines; i++) {
    batch += line(i);
    if (batch.length > 64 * 1024) (yield batch, (batch = ""));
  }
  if (batch) yield batch;
}
await mkdir(join(dir, "logs"));
await pipeline(Readable.from(generate()), createWriteStream(join(dir, "logs", "synthetic.ndjson")));
console.log(`synthetic log: ${lines} lines, ~${sizeMB} MB`);

// ---- 2. server as a child process ----
const server = spawn(process.execPath, [join(here, "../src/index.js")], {
  env: { ...process.env, PORT: String(port), LOG_DIR: join(dir, "logs"), DEMO_ENDPOINTS: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.once("data", resolve));

const getJson = (path) =>
  new Promise((resolve, reject) => {
    http
      .get({ port, path, host: "127.0.0.1" }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve(JSON.parse(body)));
      })
      .on("error", reject);
  });

// ---- 3. throttled client + sampler ----
function slowDownload(path, mbps) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    http
      .get({ port, path, host: "127.0.0.1" }, (res) => {
        res.on("data", (chunk) => {
          bytes += chunk.length;
          res.pause(); // stop reading: TCP window fills, the server's res.write() starts returning false
          setTimeout(() => res.resume(), (chunk.length / (mbps * 1024 * 1024)) * 1000);
        });
        res.on("end", () => resolve(bytes));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function measure(label, path) {
  const samples = [];
  const t0 = performance.now();
  const timer = setInterval(async () => {
    try {
      samples.push([(performance.now() - t0) / 1000, (await getJson("/health")).rss / 1024 / 1024]);
    } catch {
      // sampling is best effort
    }
  }, 200);
  const bytes = await slowDownload(path, clientMBps);
  await sleep(600);
  clearInterval(timer);
  const rss = samples.map((s) => s[1]);
  console.log(
    `${label}: ${(bytes / 1e6).toFixed(0)} MB in ${samples.at(-1)[0].toFixed(1)} s, RSS min ${Math.min(...rss).toFixed(0)} / max ${Math.max(...rss).toFixed(0)} MB`,
  );
  return samples;
}

await sleep(500);
const idle = (await getJson("/health")).rss / 1024 / 1024;
console.log(`idle RSS: ${idle.toFixed(0)} MB, client speed: ${clientMBps} MB/s`);
const streamed = await measure("streamed (pipeline)", "/api/replays/synthetic");
await sleep(1000);
const naive = await measure("naive (readFile)    ", "/api/replays-naive/synthetic");
server.kill("SIGTERM");
await new Promise((resolve) => server.once("exit", resolve));

// ---- 4. CSV + SVG ----
await mkdir(docs, { recursive: true });
const csv = (rows) => rows.map(([t, v]) => `${t.toFixed(2)},${v.toFixed(1)}`).join("\n");
await writeFile(join(docs, "rss-streamed.csv"), "seconds,rss_mb\n" + csv(streamed) + "\n");
await writeFile(join(docs, "rss-naive.csv"), "seconds,rss_mb\n" + csv(naive) + "\n");

const W = 720,
  H = 360,
  m = { l: 60, r: 20, t: 40, b: 50 };
const tMax = Math.max(streamed.at(-1)[0], naive.at(-1)[0]);
const vMax =
  Math.ceil((Math.max(...streamed.map((s) => s[1]), ...naive.map((s) => s[1])) * 1.1) / 50) * 50;
const x = (t) => m.l + (t / tMax) * (W - m.l - m.r);
const y = (v) => H - m.b - (v / vMax) * (H - m.t - m.b);
const path = (rows) =>
  rows.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
const ticks = Array.from({ length: 5 }, (_, i) => (vMax / 4) * i);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="sans-serif" font-size="12">
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${W / 2}" y="22" text-anchor="middle" font-size="15" font-weight="bold">Server RSS while a ${clientMBps} MB/s client downloads a ${sizeMB} MB log</text>
${ticks.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="#ddd"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v} MB</text>`).join("\n")}
<line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${H - m.b}" stroke="#333"/><line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="#333"/>
<path d="${path(streamed)}" fill="none" stroke="#1a7f37" stroke-width="2.5"/>
<path d="${path(naive)}" fill="none" stroke="#cf222e" stroke-width="2.5"/>
<text x="${W / 2}" y="${H - 12}" text-anchor="middle">time since the request started (s) — each line is its own download, both start at 0</text>
<rect x="${W - 250}" y="${m.t + 6}" width="12" height="12" fill="#1a7f37"/><text x="${W - 232}" y="${m.t + 16}">pipeline(createReadStream, res)</text>
<rect x="${W - 250}" y="${m.t + 26}" width="12" height="12" fill="#cf222e"/><text x="${W - 232}" y="${m.t + 36}">readFile + res.end (anti-pattern)</text>
</svg>
`;
await writeFile(join(docs, "rss-backpressure.svg"), svg);
await rm(dir, { recursive: true, force: true });
console.log("wrote docs/rss-backpressure.svg and the two CSV files");
