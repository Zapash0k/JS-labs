// JSON codec: the readable baseline the binary one is compared against. Same message model, text frames.
import { InputCommandSchema, PROTOCOL_VERSION, SnapshotMessageSchema } from "../protocol.ts";
import { CodecError } from "./types.ts";
import type { InputCommand, Snapshot } from "../protocol.ts";
import type { JsonCodec } from "./types.ts";

export const name = "json";
export const isBinary = false;
export const quantizeCommand = <T extends { readonly turn: number }>(cmd: T): T => cmd;

export const encodeInput = (cmd: InputCommand): string =>
  JSON.stringify({ v: PROTOCOL_VERSION, type: "input", ...cmd });

// JSON.parse returns `any`; the first thing we do is pin it to `unknown`.
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CodecError(`${what} is not valid JSON`);
  }
}

export function decodeInput(text: string): InputCommand {
  const checked = InputCommandSchema.safeParse(parseJson(text, "input"));
  if (!checked.success) throw new CodecError(checked.error.issues[0]?.message ?? "bad input");
  return checked.data;
}

export const encodeSnapshot = (snap: Snapshot): string =>
  JSON.stringify({ v: PROTOCOL_VERSION, type: "snapshot", ...snap });

export function decodeSnapshot(text: string): Snapshot {
  const checked = SnapshotMessageSchema.safeParse(parseJson(text, "snapshot"));
  if (!checked.success) throw new CodecError("not a snapshot");
  const { tick, ack, self, entities, events } = checked.data;
  return { tick, ack, self, entities, events };
}

export const jsonCodec: JsonCodec = {
  name,
  isBinary,
  quantizeCommand,
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
};
