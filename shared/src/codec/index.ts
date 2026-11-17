import { binaryCodec } from "./binary.ts";
import { jsonCodec } from "./json.ts";
import type { BinaryCodec, Codec, JsonCodec } from "./types.ts";

export { CodecError } from "./types.ts";
export type { BinaryCodec, Codec, JsonCodec } from "./types.ts";

export const codecs = { json: jsonCodec, binary: binaryCodec };

export function getCodec(name: "json"): JsonCodec;
export function getCodec(name: "binary"): BinaryCodec;
export function getCodec(name: string): Codec | null;
export function getCodec(name: string): Codec | null {
  // An explicit comparison, not codecs[name]: getCodec("constructor") used to return Object's constructor.
  return name === "json" ? codecs.json : name === "binary" ? codecs.binary : null;
}
