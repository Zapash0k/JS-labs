// Dev/preview middleware used by the Lab 03 experiments and the failure gallery.
//   /assets/...?delay=MS  delays the response by MS milliseconds (slow network, timeouts, progress)
//   /__test/corrupt.json  200 OK with truncated JSON (JSON.parse fails on the client)
//   /__test/503           always 503 (exercises retry with backoff)
//   /assets/*, /api/*     a missing file is a real 404 (Vite would answer 200 with index.html)
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";

const isFile = (path) => existsSync(path) && statSync(path).isFile();

const labMiddleware = (root) => (req, res, next) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/__test/corrupt.json") {
    res.setHeader("Content-Type", "application/json");
    res.end('{"broken": [1, 2,');
    return;
  }
  if (url.pathname === "/__test/503") {
    res.statusCode = 503;
    res.end("service unavailable");
    return;
  }

  const isData = url.pathname.startsWith("/assets/") || url.pathname.startsWith("/api/");
  if (isData && !isFile(join(root, decodeURIComponent(url.pathname)))) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  const delay = Number(url.searchParams.get("delay"));
  if (url.pathname.startsWith("/assets/") && delay > 0) {
    // If the client gives up (abort/timeout), do not answer a closed socket.
    const timer = setTimeout(next, delay);
    res.on("close", () => clearTimeout(timer));
    return;
  }
  next();
};

export default defineConfig({
  plugins: [
    {
      name: "dogfight-lab-middleware",
      configureServer(server) {
        server.middlewares.use(labMiddleware(server.config.publicDir));
      },
      configurePreviewServer(server) {
        server.middlewares.use(labMiddleware(join(server.config.root, server.config.build.outDir)));
      },
    },
  ],
});
