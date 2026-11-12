import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Replay ids are file names without ".ndjson". Only this alphabet is accepted, so an id can never
// contain a slash or "..".
export const REPLAY_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function replayPath(dir, id) {
  return REPLAY_ID.test(id) ? join(dir, `${id}.ndjson`) : null;
}

export async function listReplays(dir) {
  const names = await readdir(dir).catch((err) =>
    err.code === "ENOENT" ? [] : Promise.reject(err),
  );
  const files = await Promise.all(
    names
      .filter((n) => n.endsWith(".ndjson"))
      .map(async (n) => {
        const info = await stat(join(dir, n));
        return {
          id: n.slice(0, -".ndjson".length),
          size: info.size,
          modified: info.mtime.toISOString(),
        };
      }),
  );
  return files.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Async generator over an NDJSON file: parsed events, constant memory (one chunk + one partial line). */
export async function* readEvents(file) {
  let rest = "";
  let lineNo = 0;
  // encoding: "utf8" makes the stream decode multi-byte characters that straddle chunk borders.
  for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
    rest += chunk;
    const lines = rest.split("\n");
    rest = lines.pop();
    for (const line of lines) {
      lineNo++;
      if (line) yield parse(line, lineNo);
    }
  }
  if (rest.trim()) yield parse(rest, lineNo + 1);
}

function parse(line, lineNo) {
  try {
    return JSON.parse(line);
  } catch (cause) {
    throw new Error(`invalid JSON on line ${lineNo}`, { cause });
  }
}
