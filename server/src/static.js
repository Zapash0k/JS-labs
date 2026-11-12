// Static file serving written by hand to learn the layer: MIME types, ETag/304,
// a path-traversal guard, and streaming with pipeline (never readFile).
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream";
import { extname, resolve, sep, join } from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
};

/**
 * Maps a URL pathname to a file inside `root`, or returns null if it would escape it.
 * "/../../etc/passwd", "%2e%2e/", NUL bytes and backslashes are all rejected.
 */
export function resolveSafe(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed %-escape
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const rootAbs = resolve(root);
  const file = resolve(rootAbs, "." + decoded); // "." + "/x" keeps it relative to root
  return file === rootAbs || file.startsWith(rootAbs + sep) ? file : null;
}

function plain(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** @returns {Promise<boolean>} true if the request was handled (including with an error response) */
export async function serveStatic(req, res, pathname, root) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    plain(res, 405, "method not allowed");
    return true;
  }
  let file = resolveSafe(root, pathname);
  if (!file) {
    plain(res, 403, "forbidden");
    return true;
  }

  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) {
    const rootInfo = await stat(root).catch(() => null);
    if (!rootInfo) {
      plain(res, 503, "client is not built: run `npm run build` first");
    } else {
      plain(res, 404, "not found");
    }
    return true;
  }

  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": type,
    ETag: etag,
    // index.html must always be revalidated; everything else may be reused for an hour.
    "Cache-Control": type.startsWith("text/html") ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  // pipeline forwards backpressure from the socket to the file and destroys both on error.
  pipeline(createReadStream(file), res, () => {});
  return true;
}
