import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { decode, encode } from "./bytes.ts";
import { isText, merge3 } from "./merge.ts";

function merged(base: string, ours: string, theirs: string): string | null {
  const out = merge3(encode(base), encode(ours), encode(theirs));
  return out === null ? null : decode(out);
}

describe("merge3", () => {
  const base = "one\ntwo\nthree\nfour\nfive\n";

  it("puts together changes to different lines", () => {
    assert.equal(merged(base, "ONE\ntwo\nthree\nfour\nfive\n", "one\ntwo\nthree\nfour\nFIVE\nsix\n"), "ONE\ntwo\nthree\nfour\nFIVE\nsix\n");
    assert.equal(merged(base, "one\nthree\nfour\nfive\n", "one\ntwo\nthree\nfour\nand a half\nfive\n"), "one\nthree\nfour\nand a half\nfive\n");
  });

  it("takes a change that both sides made once", () => {
    assert.equal(merged(base, "one\n2\nthree\nfour\nfive\n", "one\n2\nthree\nfour\nfive\n"), "one\n2\nthree\nfour\nfive\n");
    assert.equal(merged(base, "one\n2\nthree\nfour\nfive\nsix\n", "one\n2\nthree\nfour\nfive\n"), "one\n2\nthree\nfour\nfive\nsix\n");
  });

  it("gives up when both changed the same line, or lines next to each other", () => {
    assert.equal(merged(base, "one\n2\nthree\nfour\nfive\n", "one\nzwei\nthree\nfour\nfive\n"), null);
    assert.equal(merged(base, "one\n2\nthree\nfour\nfive\n", "one\ntwo\n3\nfour\nfive\n"), null);
    assert.equal(merged(base, "one\ntwo\nthree\nfour\nfive\nsix\n", "one\ntwo\nthree\nfour\nfive\nseven\n"), null);
  });

  it("gives up when lines were added that could stand a line further up or down just as well", () => {
    // The first side added a paragraph after "a", or before the second empty line: both tell the same
    const text = "a\n\nb\n";
    assert.equal(merged(text, "a\n\nnew\n\nb\n", "a\n\nb changed\n"), null);
  });

  it("keeps the ends of lines as they are, and a last line without one", () => {
    assert.equal(merged("a\r\nb\r\nc\r\nd", "A\r\nb\r\nc\r\nd", "a\r\nb\r\nc\r\nd\r\ne"), "A\r\nb\r\nc\r\nd\r\ne");
    assert.equal(merged("a\nb\nc\nd", "a\nb\nc\nd\n", "a\nb\nc\nD"), null);
    assert.equal(merged("a\r\nb\r\nc\r\nd", "A\r\nb\r\nc\r\nd", "a\r\nb\r\nC\r\nd"), "A\r\nb\r\nC\r\nd");
  });

  it("does not take for a text what holds a zero byte or is not UTF-8", () => {
    assert.equal(isText(encode("한글\n")), true);
    assert.equal(isText(new Uint8Array([97, 0, 98])), false);
    assert.equal(isText(new Uint8Array([0xff, 0xfe, 0x41])), false);
    assert.equal(merge3(encode("a\n"), new Uint8Array([97, 0]), encode("b\n")), null);
  });

  it("agrees with git merge-file wherever it puts two texts together", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "piecemeal-merge-"));
    let seed = 20261123;
    const random = (n: number): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let v = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      v = (v + Math.imul(v ^ (v >>> 7), 61 | v)) ^ v;
      return ((v ^ (v >>> 14)) >>> 0) % n;
    };
    const words = ["alpha", "beta", "gamma", "", "- item", "# head", "한글 줄"];
    const lines = (n: number): string[] => Array.from({ length: n }, () => `${words[random(words.length)]} ${random(30)}`);
    const edit = (from: string[]): string[] => {
      const out = [...from];
      for (let e = random(3); e > 0; e--) {
        const at = random(out.length + 1);
        const kind = random(3);
        if (kind === 0) {
          out.splice(at, 0, ...lines(1 + random(3)));
        } else if (kind === 1) {
          out.splice(at, 1 + random(3));
        } else {
          out.splice(at, 1 + random(2), ...lines(1 + random(2)));
        }
      }
      return out;
    };
    const text = (from: string[]): string => from.map((line) => `${line}\n`).join("");
    let together = 0;
    try {
      for (let n = 0; n < 250; n++) {
        const start = lines(5 + random(25));
        const [b, o, t] = [text(start), text(edit(start)), text(edit(start))];
        writeFileSync(path.join(dir, "b"), b);
        writeFileSync(path.join(dir, "o"), o);
        writeFileSync(path.join(dir, "t"), t);
        const mine = merged(b, o, t);
        if (mine !== null) {
          const git = spawnSync("git", ["merge-file", "-p", "o", "b", "t"], { cwd: dir, encoding: "utf8" });
          assert.equal(git.status, 0, `git finds a conflict in ${JSON.stringify({ b, o, t })}`);
          assert.equal(mine, git.stdout);
          together++;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(together > 100, `only ${together} of 250 texts were put together`);
  });
});
