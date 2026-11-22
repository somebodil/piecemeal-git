import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { encode } from "./bytes.ts";
import { Sha1, sha1 } from "./sha1.ts";

describe("Sha1", () => {
  it("gives the digests that are known", () => {
    assert.equal(new Sha1().hex(), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    assert.equal(new Sha1().update(encode("abc")).hex(), "a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it("gives what Web Crypto gives, however the bytes are cut into pieces", async () => {
    for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const data = new Uint8Array(randomBytes(length));
      const whole = await sha1(data);
      for (const piece of [1, 7, 64, 100, 4096]) {
        if (length > 2000 && piece < 64) {
          continue;
        }
        const hash = new Sha1();
        for (let at = 0; at < length; at += piece) {
          hash.update(data.subarray(at, at + piece));
        }
        assert.equal(hash.hex(), whole, `${length} bytes in pieces of ${piece}`);
      }
    }
  });
});
