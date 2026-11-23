import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { decode, encode } from "./bytes.ts";
import { chosenText, diffCounts, type DiffRow, diffRows, diffText, isText, merge3, sameRows } from "./merge.ts";

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

describe("diffText", () => {
  /** What the rows show of each side, with every fold opened. */
  const sides = (rows: DiffRow[], before: string[]): { old: string; now: string } => {
    let old = "";
    let now = "";
    for (const row of rows) {
      const lines = row.kind === "fold" ? [...sameRows(before, row.oldStart, row.newStart, row.count)] : [row];
      for (const line of lines) {
        if (line.kind === "fold") {
          continue;
        }
        old += line.kind === "added" ? "" : line.text;
        now += line.kind === "removed" ? "" : line.text;
      }
    }
    return { old, now };
  };

  it("tells the lines that were added and taken away, with a few lines around them and the rest folded", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join("");
    const after = before.replace("line 10\n", "line ten\n").replace("line 25\n", "") + "a last line";
    const diffed = diffText(encode(before), encode(after))!;
    assert.deepEqual(diffCounts(diffed), { added: 2, removed: 2 });
    assert.equal(diffed.coarse, false);
    const rows = [...diffRows(diffed)];
    assert.deepEqual(
      rows.map((row) => (row.kind === "fold" ? `fold ${row.count}` : `${row.kind[0]} ${row.oldLine ?? "-"} ${row.newLine ?? "-"}`)),
      [
        "fold 6", "s 7 7", "s 8 8", "s 9 9", "r 10 -", "a - 10", "s 11 11", "s 12 12", "s 13 13",
        "fold 8", "s 22 22", "s 23 23", "s 24 24", "r 25 -", "s 26 25", "s 27 26", "s 28 27",
        // Five lines lie between the last two changes: three after the one and two before the other, and no fold
        "s 29 28", "s 30 29", "a - 30",
      ],
    );
    assert.deepEqual(sides(rows, diffed.before), { old: before, now: after });
    // A fold tells where its lines are in both texts
    assert.deepEqual(rows[9], { kind: "fold", oldStart: 13, newStart: 13, count: 8 });
    assert.deepEqual([...sameRows(diffed.before, 13, 13, 1)], [{ kind: "same", text: "line 14\n", oldLine: 14, newLine: 14, change: null }]);
    // A line that was taken away or added tells which change it belongs to
    assert.deepEqual(
      rows.filter((row) => row.kind === "removed" || row.kind === "added").map((row) => (row.kind === "fold" ? null : row.change)),
      [0, 0, 1, 2],
    );
  });

  it("shows a new file and one that is gone as all added and all taken away", () => {
    const text = "one\ntwo\n";
    const added = diffText(new Uint8Array(0), encode(text))!;
    assert.deepEqual([diffCounts(added), [...diffRows(added)].map((row) => row.kind)], [{ added: 2, removed: 0 }, ["added", "added"]]);
    const removed = diffText(encode(text), new Uint8Array(0))!;
    assert.deepEqual([diffCounts(removed), [...diffRows(removed)].map((row) => row.kind)], [{ added: 0, removed: 2 }, ["removed", "removed"]]);
    assert.deepEqual(diffText(encode(text), encode(text))?.changes, []);
  });

  it("does not compare what is not a text", () => {
    assert.equal(diffText(new Uint8Array([1, 0, 2]), encode("text\n")), null);
    assert.equal(diffText(encode("text\n"), new Uint8Array([0xff, 0xfe])), null);
  });

  it("shows two texts that are too far apart as one change between what they start and end with alike", () => {
    const lines = (word: string, count: number): string => Array.from({ length: count }, (_, i) => `${word} ${i}\n`).join("");
    const before = `top\n${lines("old", 5000)}bottom\n`;
    const after = `top\n${lines("new", 4500)}bottom\n`;
    const diffed = diffText(encode(before), encode(after))!;
    assert.equal(diffed.coarse, true);
    assert.deepEqual(diffed.changes, [{ oldStart: 1, oldEnd: 5001, newStart: 1, newEnd: 4501 }]);
    assert.deepEqual(diffCounts(diffed), { added: 4500, removed: 5000 });
    // The rows come as they are asked for: the first few cost nothing of the rest
    const rows = diffRows(diffed);
    assert.deepEqual([rows.next().value, rows.next().value], [
      { kind: "same", text: "top\n", oldLine: 1, newLine: 1, change: null },
      { kind: "removed", text: "old 0\n", oldLine: 2, newLine: null, change: 0 },
    ]);
  });

  it("turns the one text into the other, whatever the two are", () => {
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const words = ["alpha\n", "beta\n", "gamma\n", "\n", "delta\r\n", "한글\n", "alpha\n"];
    for (let round = 0; round < 300; round++) {
      const text = (): string => {
        const count = Math.floor(random() * 40);
        let out = "";
        for (let i = 0; i < count; i++) {
          out += words[Math.floor(random() * words.length)];
        }
        return random() < 0.2 ? `${out}no end of line` : out;
      };
      const before = text();
      // Mostly the same text with a few changes, sometimes another one altogether
      const after = random() < 0.2 ? text() : before.split(/(?<=\n)/).filter(() => random() > 0.15).flatMap((line) => (random() < 0.15 ? [line, "added\n"] : [line])).join("");
      const diffed = diffText(encode(before), encode(after))!;
      for (const context of [0, 3]) {
        assert.deepEqual(sides([...diffRows(diffed, context)], diffed.before), { old: before, now: after }, JSON.stringify({ before, after, context }));
      }
      const counts = diffCounts(diffed);
      assert.equal(diffed.before.length - counts.removed + counts.added, diffed.after.length);
      // Every change as the one side has it is that side
      assert.equal(chosenText(diffed, diffed.changes.map(() => 0)), before);
      assert.equal(chosenText(diffed, diffed.changes.map(() => 1)), after);
    }
  });

  it("compares two long texts with many changes piece by piece, between the lines that both have once", () => {
    const line = (i: number): string => `line ${i} of a long text\n`;
    const before: string[] = [];
    const after: string[] = [];
    for (let i = 0; i < 60_000; i++) {
      before.push(line(i));
      // Every twentieth line is another one, and now and then a line is added or left out
      if (i % 20 === 7) {
        after.push(`changed ${line(i)}`);
      } else if (i % 997 !== 3) {
        after.push(line(i));
      }
      if (i % 1009 === 5) {
        after.push(`added after ${i}\n`);
      }
    }
    const started = performance.now();
    const diffed = diffText(encode(before.join("")), encode(after.join("")))!;
    const took = performance.now() - started;
    // Far more changes than two texts are compared through in one piece, and none of them told coarsely
    assert.equal(diffed.coarse, false);
    assert.ok(diffed.changes.length > 3000, `${diffed.changes.length} changes`);
    assert.deepEqual(diffCounts(diffed), { added: 3000 + 60, removed: 3000 + 61 - 3 });
    assert.equal(chosenText(diffed, new Uint8Array(diffed.changes.length).fill(1)), after.join(""));
    assert.equal(chosenText(diffed, new Uint8Array(diffed.changes.length)), before.join(""));
    assert.ok(took < 3000, `it took ${took.toFixed(0)} ms`);
  });
});

describe("chosenText", () => {
  const before = "one\ntwo\nthree\nfour\nfive\n";
  const after = "one\nTWO\nthree\nfour\nFIVE\nsix\n";
  const diffed = diffText(encode(before), encode(after))!;

  it("keeps for each change the lines of the side that was chosen, or of both", () => {
    assert.equal(diffed.changes.length, 2);
    assert.equal(chosenText(diffed, [0, 0]), before);
    assert.equal(chosenText(diffed, [1, 1]), after);
    assert.equal(chosenText(diffed, [1, 0]), "one\nTWO\nthree\nfour\nfive\n");
    assert.equal(chosenText(diffed, [0, 1]), "one\ntwo\nthree\nfour\nFIVE\nsix\n");
    assert.equal(chosenText(diffed, [2, 2]), "one\ntwo\nTWO\nthree\nfour\nfive\nFIVE\nsix\n");
  });

  it("gives a last line without an end one, when another line comes after it", () => {
    const ends = diffText(encode("one\ntwo"), encode("one\nTWO\r\nthree"))!;
    assert.equal(chosenText(ends, [0]), "one\ntwo");
    assert.equal(chosenText(ends, [1]), "one\nTWO\r\nthree");
    // The line of the one side is no longer the last one: it ends as the line after it does
    assert.equal(chosenText(ends, [2]), "one\ntwo\r\nTWO\r\nthree");
  });
});
