import { toHex } from "./bytes.ts";

/** SHA-1 of the bytes, as 40 hex digits. Web Crypto is in Node.js and in every web view. */
export async function sha1(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>);
  return toHex(new Uint8Array(digest));
}

/**
 * SHA-1 of bytes that come piece by piece. Web Crypto wants them all at once,
 * which a file that is too large to hold whole cannot give.
 */
export class Sha1 {
  private readonly state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(80);
  /** How many bytes of `block` are filled */
  private filled = 0;
  /** How many bytes came in all */
  private length = 0;

  update(data: Uint8Array): this {
    this.length += data.length;
    let at = 0;
    while (at < data.length) {
      const take = Math.min(64 - this.filled, data.length - at);
      this.block.set(data.subarray(at, at + take), this.filled);
      this.filled += take;
      at += take;
      if (this.filled === 64) {
        this.compress();
        this.filled = 0;
      }
    }
    return this;
  }

  /** The digest as 40 hex digits. Nothing can be added after it. */
  hex(): string {
    const bits = this.length * 8;
    const tail = new Uint8Array((this.filled < 56 ? 64 : 128) - this.filled);
    tail[0] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(tail.length - 4, bits >>> 0);
    this.update(tail);
    const out = new Uint8Array(20);
    const digest = new DataView(out.buffer);
    this.state.forEach((word, i) => digest.setUint32(i * 4, word));
    return toHex(out);
  }

  private compress(): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const j = i * 4;
      w[i] = (this.block[j] << 24) | (this.block[j + 1] << 16) | (this.block[j + 2] << 8) | this.block[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = this.state;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = next;
    }
    this.state[0] += a;
    this.state[1] += b;
    this.state[2] += c;
    this.state[3] += d;
    this.state[4] += e;
  }
}
