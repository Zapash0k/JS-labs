// Match log: room events -> object-mode Transform -> NDJSON file, wired with pipeline.
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { on } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Objects in, one JSON line per object out. Writable side is object mode, readable side is bytes. */
export class NdjsonEncode extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }
  _transform(event, _encoding, callback) {
    try {
      callback(null, JSON.stringify(event) + "\n");
    } catch (err) {
      callback(err); // e.g. a circular structure: fail the stream, do not throw inside the stream machinery
    }
  }
}

export const logId = (roomId, date = new Date()) =>
  `${roomId}-${date.toISOString().replace(/[:.]/g, "-")}`;

/**
 * Starts logging `room`. The file is closed (and flushed) when the room emits "closed".
 * Returns { id, file, done }; `done` resolves when the file is complete and never rejects.
 */
export function startMatchLog(room, { dir, onError = (err) => console.error("[matchlog]", err) }) {
  const id = logId(room.id);
  const file = join(dir, `${id}.ndjson`);

  // Subscribe NOW (events.on attaches its listener when called), so nothing emitted before the
  // pipeline starts pulling is lost. `close` ends the iteration after the buffered events.
  const events = on(room, "event", { close: ["closed"] });

  async function* source() {
    yield { t: room.createdAt, type: "room_open", room: room.toJSON() };
    for await (const [event] of events) yield event;
  }

  const done = (async () => {
    await mkdir(dir, { recursive: true });
    await pipeline(
      Readable.from(source()),
      new NdjsonEncode(),
      createWriteStream(file, { flags: "wx" }),
    );
  })().catch((err) => onError(err));

  return { id, file, done };
}
