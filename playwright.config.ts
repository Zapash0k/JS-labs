import { defineConfig, devices } from "@playwright/test";

// End-to-end tests (Lab 07, M2): a real browser against the real server, which also serves the built
// client. `npm run e2e` builds the client, starts the server and runs e2e/*.spec.ts.
//
//   E2E_PORT=4200 npm run e2e     use another port
//   E2E_CHANNEL=chrome npm run e2e   use the Chrome that is already installed instead of Playwright's
//                                    own Chromium (handy where `playwright install` cannot download)
const PORT = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: "./e2e",
  // One worker: two canvases at 60 fps per test, and the movement test has a 500 ms latency budget.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: process.env.E2E_CHANNEL },
    },
  ],
  webServer: {
    // CI builds in its own step first (see .github/workflows/ci.yml), so it only has to start the server.
    command: process.env.CI ? "npm start" : "npm run build && npm start",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { PORT: String(PORT), HOST: "127.0.0.1" },
  },
});
