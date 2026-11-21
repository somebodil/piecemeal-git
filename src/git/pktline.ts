import { concat, decode, encode } from "./bytes.ts";

/** A line of the git protocol: four hex digits of length, then the line. */
export function pkt(line: string | Uint8Array): Uint8Array {
  const data = typeof line === "string" ? encode(line) : line;
  const head = encode((data.length + 4).toString(16).padStart(4, "0"));
  return concat([head, data]);
}

export const FLUSH = encode("0000");
export const DELIM = encode("0001");

export type Pkt =
  | { type: "data"; data: Uint8Array }
  | { type: "flush" }
  | { type: "delim" }
  | { type: "end" };

/** Reads every line of a buffer. A buffer that ends in the middle of a line is an error. */
export function* readPkts(buffer: Uint8Array, start = 0): Generator<Pkt> {
  let pos = start;
  while (pos < buffer.length) {
    if (pos + 4 > buffer.length) {
      throw new Error("pkt-line: cut off in a length");
    }
    const length = parseInt(decode(buffer.subarray(pos, pos + 4)), 16);
    if (Number.isNaN(length)) {
      throw new Error("pkt-line: a length is not hex");
    }
    if (length === 0) {
      yield { type: "flush" };
      pos += 4;
    } else if (length === 1) {
      yield { type: "delim" };
      pos += 4;
    } else if (length === 2) {
      yield { type: "end" };
      pos += 4;
    } else {
      if (length < 4 || pos + length > buffer.length) {
        throw new Error("pkt-line: cut off in a line");
      }
      yield { type: "data", data: buffer.subarray(pos + 4, pos + length) };
      pos += length;
    }
  }
}

/** The text of a line without the newline at its end. */
export function lineText(data: Uint8Array): string {
  const text = decode(data);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
