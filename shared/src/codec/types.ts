import type { InputCommand, Snapshot } from "../protocol.ts";

/** Thrown by every decoder on malformed input. The caller closes the socket; nothing else can escape. */
export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

interface CodecBase<Wire extends string | Uint8Array, Incoming> {
  /** The value the server will actually see for a command (turn may be quantized). Clients predict with this. */
  quantizeCommand<T extends { readonly turn: number }>(cmd: T): T;
  encodeInput(cmd: InputCommand): Wire;
  decodeInput(data: Incoming): InputCommand;
  encodeSnapshot(snap: Snapshot): Wire;
  decodeSnapshot(data: Incoming): Snapshot;
}

export interface JsonCodec extends CodecBase<string, string> {
  readonly name: "json";
  readonly isBinary: false;
}

export interface BinaryCodec extends CodecBase<Uint8Array, Uint8Array | ArrayBuffer> {
  readonly name: "binary";
  readonly isBinary: true;
}

/** The JSON-vs-binary flag as a type: `if (codec.isBinary)` narrows to the right wire format. */
export type Codec = JsonCodec | BinaryCodec;
