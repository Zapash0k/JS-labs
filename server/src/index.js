import { ConfigError, loadConfig } from "./config.js";
import { createApp } from "./app.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`config error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const app = createApp(config);
const address = await app.listen();
console.log(
  `dogfight server on http://${address.address}:${address.port}  (logs: ${config.logDir})`,
);
if (config.demo) console.warn("DEMO_ENDPOINTS is on: /api/slow blocks the event loop on purpose");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down...`);
    try {
      await app.close();
      console.log("bye");
      process.exit(0);
    } catch (err) {
      console.error("shutdown failed:", err);
      process.exit(1);
    }
  });
}
