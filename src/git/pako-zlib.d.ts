// The parts of pako under its convenient functions. They are needed to know
// where a compressed stream ends inside a larger buffer.
declare module "pako/lib/zlib/zstream.js" {
  export default class ZStream {
    input: Uint8Array | null;
    next_in: number;
    avail_in: number;
    output: Uint8Array | null;
    next_out: number;
    avail_out: number;
    msg: string;
  }
}

declare module "pako/lib/zlib/inflate.js" {
  import type ZStream from "pako/lib/zlib/zstream.js";
  const zlib: {
    inflateInit2(strm: ZStream, windowBits: number): number;
    inflate(strm: ZStream, flush: number): number;
    inflateEnd(strm: ZStream): number;
  };
  export default zlib;
}
