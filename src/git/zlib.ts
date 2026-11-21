import pako from "pako";
import zlib from "pako/lib/zlib/inflate.js";
import ZStream from "pako/lib/zlib/zstream.js";

const Z_FINISH = 4;
const Z_STREAM_END = 1;

export function deflate(data: Uint8Array): Uint8Array {
  return pako.deflate(data);
}

/** Inflates a buffer that holds one compressed stream and nothing else. */
export function inflate(data: Uint8Array): Uint8Array {
  return pako.inflate(data);
}

/**
 * Inflates the stream that starts at `pos` and says where it ends. A pack is
 * one stream after the other with no lengths in between, so the end of one
 * is known only by inflating it. `size` is the size that the pack promises.
 */
export function inflateAt(
  buffer: Uint8Array,
  pos: number,
  size: number,
): { data: Uint8Array; end: number } {
  const strm = new ZStream();
  zlib.inflateInit2(strm, 15);
  strm.input = buffer;
  strm.next_in = pos;
  strm.avail_in = buffer.length - pos;
  // One byte more than promised, so that a stream that is too long is noticed
  const out = new Uint8Array(size + 1);
  strm.output = out;
  strm.next_out = 0;
  strm.avail_out = out.length;
  const status = zlib.inflate(strm, Z_FINISH);
  const end = strm.next_in;
  const written = strm.next_out;
  zlib.inflateEnd(strm);
  if (status !== Z_STREAM_END || written !== size) {
    throw new Error(`pack: an object at ${pos} does not inflate to its ${size} bytes`);
  }
  return { data: out.subarray(0, size), end };
}
