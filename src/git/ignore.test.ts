import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { addToBlock, BLOCK_END, BLOCK_START, escapePattern, matcher } from "./ignore.ts";

describe("escapePattern", () => {
  it("matches the one path, also when its name has characters that mean something", () => {
    const names = ["a.mp4", "Attachments/[Level 2] Data*.zip", "영상/첫 번째?.mov", "#tag.md", "!x", "end ", "back\\slash.md", "a]b.md"];
    for (const name of names) {
      const ignores = matcher(`${escapePattern(name)}\n`);
      assert.equal(ignores(name, false), true, name);
      assert.equal(ignores(`sub/${name}`, false), false, name);
      assert.equal(ignores(`${name}x`, false), false, name);
    }
  });
});

describe("addToBlock", () => {
  it("starts a part of its own at the end and leaves the rest alone", () => {
    const text = addToBlock("node_modules/\n*.tmp", ["big.mp4"]);
    assert.equal(text, `node_modules/\n*.tmp\n\n${BLOCK_START}\n/big.mp4\n${BLOCK_END}\n`);
  });

  it("adds to the part that is there, once", () => {
    const first = addToBlock("", ["a.bin"]);
    const second = addToBlock(first, ["a.bin", "b.bin"]);
    assert.equal(second, `${BLOCK_START}\n/a.bin\n/b.bin\n${BLOCK_END}\n`);
    assert.equal(addToBlock(second, ["b.bin"]), second);
  });

  it("keeps what follows the part", () => {
    const text = addToBlock(`${BLOCK_START}\n/a.bin\n${BLOCK_END}\nlater/\n`, ["b.bin"]);
    assert.equal(text, `${BLOCK_START}\n/a.bin\n/b.bin\n${BLOCK_END}\nlater/\n`);
  });
});

describe("matcher", () => {
  it("decides as git does", () => {
    const gitignore = [
      "# a comment",
      "*.tmp",
      "!keep.tmp",
      "build/",
      "/top.md",
      "docs/*.pdf",
      "**/cache",
      "logs/**",
      "a/**/z.md",
      "[Dd]raft?.md",
      "note[!0-9].md",
      "\\#literal",
      "trailing   ",
      ".obsidian/workspace*",
      "!build/kept.md",
      "",
    ].join("\n");
    const paths = [
      "x.tmp", "sub/x.tmp", "keep.tmp", "sub/keep.tmp", "build", "build/out.js", "build/kept.md", "src/build",
      "top.md", "sub/top.md", "docs/a.pdf", "docs/sub/a.pdf", "x/docs/a.pdf", "cache", "a/b/cache", "a/cache/file",
      "logs/x", "logs/a/b", "logs", "a/z.md", "a/b/c/z.md", "b/a/z.md", "Draft1.md", "draftx.md", "drafts/x.md",
      "noteA.md", "note1.md", "#literal", "trailing", "trailing   ", ".obsidian/workspace.json", ".obsidian/app.json",
      "한글.tmp", "폴더/한글.md",
    ];
    const dir = mkdtempSync(path.join(tmpdir(), "piecemeal-ignore-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(path.join(dir, ".gitignore"), gitignore);
      const ignores = matcher(gitignore);
      for (const candidate of paths) {
        for (const isDir of [false, true]) {
          let git = true;
          try {
            execFileSync("git", ["check-ignore", "-q", "--no-index", isDir ? `${candidate}/` : candidate], { cwd: dir });
          } catch {
            git = false;
          }
          assert.equal(ignores(candidate, isDir), git, `${candidate}${isDir ? "/" : ""}`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
