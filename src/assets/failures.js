// Failure injection for the M4 "failure gallery": ?fail=<mode> adds one broken asset to the manifest.
// The middleware that serves /__test/* and ?delay lives in vite.config.js.
const EXTRA = {
  // optional sprite that does not exist: game starts, one asset is reported as skipped
  404: { key: "ghost", type: "image", url: "/assets/ghost.png" },
  // the same, but critical: loading stops and the Retry button appears
  "404-critical": { key: "ghost", type: "image", url: "/assets/ghost.png", critical: true },
  // an asset that never answers within the per-attempt timeout (main.js sets a short timeout)
  timeout: { key: "slow", type: "audio", url: "/assets/sfx/shoot.wav?delay=60000" },
  // server keeps answering 503: retried with backoff, then reported
  503: { key: "flaky", type: "json", url: "/__test/503" },
  // truncated JSON that is critical: Retry button, error says "corrupt JSON"
  json: { key: "corrupt", type: "json", url: "/__test/corrupt.json", critical: true },
};

export const FAILURE_MODES = Object.keys(EXTRA);

export function injectFailure(manifest, mode) {
  const extra = EXTRA[mode];
  return extra ? { ...manifest, assets: [...manifest.assets, extra] } : manifest;
}
