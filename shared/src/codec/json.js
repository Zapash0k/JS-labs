// JSON codec: the readable baseline the binary one is compared against. Same message model, text frames.
import { PROTOCOL_VERSION, validateInput } from "../protocol.js";
import { CodecError } from "./binary.js";

export const name = "json";
export const isBinary = false;
export const quantizeCommand = (cmd) => cmd;

export const encodeInput = (cmd) => JSON.stringify({ v: PROTOCOL_VERSION, type: "input", ...cmd });

export function decodeInput(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CodecError("input is not valid JSON");
  }
  const checked = validateInput(raw);
  if (!checked.ok) throw new CodecError(checked.reason);
  return checked.cmd;
}

export const encodeSnapshot = (snap) =>
  JSON.stringify({ v: PROTOCOL_VERSION, type: "snapshot", ...snap });

export function decodeSnapshot(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CodecError("snapshot is not valid JSON");
  }
  if (raw?.type !== "snapshot" || !Array.isArray(raw.entities))
    throw new CodecError("not a snapshot");
  const { v, type, ...snap } = raw;
  void v;
  void type;
  return snap;
}
