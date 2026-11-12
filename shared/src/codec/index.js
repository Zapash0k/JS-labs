import * as binary from "./binary.js";
import * as json from "./json.js";

export { CodecError } from "./binary.js";
export const codecs = { json, binary };
export const getCodec = (name) => codecs[name] ?? null;
