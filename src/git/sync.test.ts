import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { nodeHttp, NodeFs } from "../platform/node.ts";
import { TestServer } from "../testing/server.ts";
import { BLOCK_START } from "./ignore.ts";
import { sync, type SyncOptions, type SyncResult } from "./sync.ts";

describe("sync", () => {
  const server = new TestServer();
  let counter = 0;

  before(async () => {
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  /** A repository on the server, a clone of it made by git that plays the computer, and an empty vault that plays the phone. */
  function setup(files: Record<string, string | Buffer> = {}) {
    const name = `repo${++counter}`;
    const url = server.createRepo(name);
    const pc = `${name}-pc`;
    server.cloneWithGit(name, pc);
    const pcDir = path.join(server.root, pc);
    const phoneDir = mkdtempSync(path.join(server.root, `${name}-phone-`));
    let clock = Date.parse("2026-01-01T00:00:00Z");

    const world = {
      url,
      pcDir,
      phoneDir,
      writePc(file: string, content: string | Buffer): void {
        mkdirSync(path.dirname(path.join(pcDir, file)), { recursive: true });
        writeFileSync(path.join(pcDir, file), content);
      },
      /** Commits everything on the computer and pushes it. */
      pushPc(message = "from the computer"): void {
        server.git(pc, "add", "-A");
        server.git(pc, "commit", "-q", "--allow-empty", "-m", message);
        server.git(pc, "push", "-q", "origin", "HEAD:main");
      },
      pullPc(): void {
        server.git(pc, "pull", "-q", "origin", "main");
      },
      readPc(file: string): string | null {
        return existsSync(path.join(pcDir, file)) ? readFileSync(path.join(pcDir, file), "utf8") : null;
      },
      /** Writes a file of the phone, at a time that differs from every earlier one. */
      writePhone(file: string, content: string | Buffer): void {
        const full = path.join(phoneDir, file);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content);
        clock += 60_000;
        utimesSync(full, clock / 1000, clock / 1000);
      },
      removePhone(file: string): void {
        unlinkSync(path.join(phoneDir, file));
      },
      readPhone(file: string): string | null {
        return existsSync(path.join(phoneDir, file)) ? readFileSync(path.join(phoneDir, file), "utf8") : null;
      },
      log(): string[] {
        return server.git(`${name}.git`, "log", "--format=%s", "main").split("\n");
      },
      syncPhone(extra: Partial<SyncOptions> = {}): Promise<SyncResult> {
        return sync({
          fs: new NodeFs(phoneDir),
          http: nodeHttp,
          remote: { url },
          storeDir: ".piecemeal",
          author: { name: "Phone", email: "phone@example.com" },
          message: () => "from the phone",
          maxFileBytes: 10_000,
          batchBytes: 4_000,
          // What a host like GitHub can tell: the sizes of the files of a tree
          sizes: async (tree) => {
            const out = new Map<string, number>();
            for (const line of server.git(`${name}.git`, "ls-tree", "-r", "-l", tree).split("\n")) {
              const match = /^\d+ blob ([0-9a-f]{40}) +(\d+)\t/.exec(line);
              if (match !== null) {
                out.set(match[1], Number(match[2]));
              }
            }
            return out;
          },
          now: () => new Date(2026, 10, 22, 9, 15),
          ...extra,
        });
      },
    };
    if (Object.keys(files).length > 0) {
      for (const [file, content] of Object.entries(files)) {
        world.writePc(file, content);
      }
      world.pushPc("first");
    }
    return world;
  }

  it("brings a repository into an empty vault, in responses that stay small", async () => {
    const files: Record<string, string> = { "한글 노트.md": "한글 내용\n", "폴더/깊은/곳.md": "깊다\n", ".gitignore": "*.tmp\n" };
    for (let i = 0; i < 30; i++) {
      files[`notes/note ${i}.md`] = `note ${i}\n${"some text of a note. ".repeat(40)}${Math.random()}\n`;
    }
    const w = setup(files);
    server.responseSizes.length = 0;
    const result = await w.syncPhone();
    assert.equal(result.downloaded.length, 33);
    assert.equal(w.readPhone("한글 노트.md"), "한글 내용\n");
    assert.equal(w.readPhone("폴더/깊은/곳.md"), "깊다\n");
    assert.equal(w.readPhone("notes/note 7.md"), files["notes/note 7.md"]);
    // About 25 kB of notes came in batches of about 4 kB, not in one response
    assert.ok(server.responseSizes.length >= 6, `only ${server.responseSizes.length} responses`);
    assert.ok(Math.max(...server.responseSizes) < 8_000, `a response of ${Math.max(...server.responseSizes)} bytes`);

    const again = await w.syncPhone();
    assert.deepEqual([again.downloaded, again.uploaded, again.commit], [[], [], result.commit]);
    assert.deepEqual(w.log(), ["first"]);
  });

  it("sends what the phone changed as one commit that git accepts", async () => {
    const w = setup({ "a.md": "a\n", "b.md": "b\n", "dir/c.md": "c\n" });
    await w.syncPhone();
    w.writePhone("a.md", "a, changed on the phone\n");
    w.writePhone("새 폴더/새 노트.md", "new\n");
    w.removePhone("dir/c.md");
    const result = await w.syncPhone();
    assert.deepEqual(result.uploaded.sort(), ["a.md", "새 폴더/새 노트.md"]);
    assert.deepEqual(result.deletedThere, ["dir/c.md"]);
    assert.deepEqual(w.log(), ["from the phone", "first"]);
    assert.equal(server.git(path.basename(w.url), "fsck", "--strict"), "");

    w.pullPc();
    assert.equal(w.readPc("a.md"), "a, changed on the phone\n");
    assert.equal(w.readPc("새 폴더/새 노트.md"), "new\n");
    assert.equal(w.readPc("b.md"), "b\n");
    assert.equal(w.readPc("dir/c.md"), null);
    assert.equal(server.git(path.basename(w.pcDir), "status", "--porcelain"), "");
  });

  it("takes what the computer changed", async () => {
    const w = setup({ "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" });
    await w.syncPhone();
    w.writePc("a.md", "a, changed on the computer\n");
    w.writePc("new/d.md", "d\n");
    unlinkSync(path.join(w.pcDir, "c.md"));
    w.pushPc();
    const result = await w.syncPhone();
    assert.deepEqual(result.downloaded.sort(), ["a.md", "new/d.md"]);
    assert.deepEqual(result.deletedHere, ["c.md"]);
    assert.equal(w.readPhone("a.md"), "a, changed on the computer\n");
    assert.equal(w.readPhone("new/d.md"), "d\n");
    assert.equal(w.readPhone("c.md"), null);
    assert.deepEqual(w.log(), ["from the computer", "first"]);
  });

  it("merges changes to different files, and keeps both versions of a file that both changed", async () => {
    const w = setup({ "a.md": "a\n", "b.md": "b\n", "both.md": "start\n" });
    await w.syncPhone();
    w.writePc("a.md", "a from the computer\n");
    w.writePc("both.md", "the computer's version\n");
    w.pushPc();
    w.writePhone("b.md", "b from the phone\n");
    w.writePhone("both.md", "the phone's version\n");
    const result = await w.syncPhone();

    const copy = "both (conflict 2026-11-22 0915).md";
    assert.deepEqual(result.conflicts, [{ path: "both.md", copy }]);
    assert.equal(w.readPhone("a.md"), "a from the computer\n");
    assert.equal(w.readPhone("both.md"), "the phone's version\n");
    assert.equal(w.readPhone(copy), "the computer's version\n");
    assert.deepEqual(w.log(), ["from the phone", "from the computer", "first"]);

    w.pullPc();
    assert.equal(w.readPc("b.md"), "b from the phone\n");
    assert.equal(w.readPc("both.md"), "the phone's version\n");
    assert.equal(w.readPc(copy), "the computer's version\n");

    const again = await w.syncPhone();
    assert.deepEqual([again.downloaded, again.uploaded, again.conflicts], [[], [], []]);
    assert.equal(w.log().length, 3);
  });

  it("lets a change win over a removal, on either side", async () => {
    const w = setup({ "x.md": "x\n", "y.md": "y\n" });
    await w.syncPhone();
    unlinkSync(path.join(w.pcDir, "x.md"));
    w.writePc("y.md", "y changed on the computer\n");
    w.pushPc();
    w.writePhone("x.md", "x changed on the phone\n");
    w.removePhone("y.md");
    await w.syncPhone();
    assert.equal(w.readPhone("y.md"), "y changed on the computer\n");
    w.pullPc();
    assert.equal(w.readPc("x.md"), "x changed on the phone\n");
    assert.equal(w.readPc("y.md"), "y changed on the computer\n");
  });

  it("does not send a new file that is too large, and writes it into .gitignore", async () => {
    const w = setup({ "a.md": "a\n", ".gitignore": "*.tmp\n" });
    await w.syncPhone();
    w.writePhone("Attachments/[big] video.mp4", Buffer.alloc(20_000, 1));
    w.writePhone("small.md", "small\n");
    w.writePhone("scratch.tmp", "ignored\n");
    const result = await w.syncPhone();
    assert.deepEqual(result.tooLargeIgnored, ["Attachments/[big] video.mp4"]);
    assert.deepEqual(result.uploaded.sort(), [".gitignore", "small.md"]);
    assert.ok(existsSync(path.join(w.phoneDir, "Attachments/[big] video.mp4")));

    w.pullPc();
    assert.equal(w.readPc("Attachments/[big] video.mp4"), null);
    assert.equal(w.readPc("scratch.tmp"), null);
    const gitignore = w.readPc(".gitignore")!;
    assert.ok(gitignore.startsWith("*.tmp\n"));
    assert.ok(gitignore.includes(BLOCK_START));
    // The line means the same to git: the file is ignored there too
    w.writePc("Attachments/[big] video.mp4", "x");
    assert.equal(server.git(path.basename(w.pcDir), "status", "--porcelain"), "");

    const again = await w.syncPhone();
    assert.deepEqual([again.tooLargeIgnored, again.uploaded], [[], []]);
  });

  it("leaves a file of the remote that is too large out of the vault, and does not remove it from the remote", async () => {
    const w = setup({ "a.md": "a\n", "huge.bin": Buffer.alloc(50_000, 7) });
    const first = await w.syncPhone();
    assert.deepEqual(first.tooLargeThere, ["huge.bin"]);
    assert.equal(w.readPhone("huge.bin"), null);
    w.writePhone("a.md", "a changed\n");
    await w.syncPhone();
    w.pullPc();
    assert.equal(readFileSync(path.join(w.pcDir, "huge.bin")).length, 50_000);
    assert.equal(w.readPc("a.md"), "a changed\n");
  });

  it("gets a file that is too large for one response through the way the host offers", async () => {
    const w = setup({ "huge.bin": Buffer.alloc(50_000, 7) });
    const fs = new NodeFs(w.phoneDir);
    const result = await w.syncPhone({
      largeBlob: async (oid, file, size) => {
        // A host would be asked for ranges of bytes. Here the file is written in pieces.
        const data = Buffer.from(server.git(path.basename(w.url), "cat-file", "blob", oid), "utf8");
        assert.equal(size, 50_000);
        await fs.remove(file);
        for (let at = 0; at < size; at += 16_000) {
          await fs.append(file, Buffer.alloc(Math.min(16_000, size - at), data[0]));
        }
        return true;
      },
    });
    assert.deepEqual([result.downloaded, result.tooLargeThere], [["huge.bin"], []]);
    assert.equal(readFileSync(path.join(w.phoneDir, "huge.bin")).length, 50_000);
    const again = await w.syncPhone();
    assert.deepEqual([again.downloaded, again.uploaded, again.tooLargeChanged], [[], [], []]);
  });

  it("keeps the version of the remote when a tracked file grows too large here", async () => {
    const w = setup({ "grows.md": "small\n" });
    await w.syncPhone();
    w.writePhone("grows.md", Buffer.alloc(20_000, 65));
    const result = await w.syncPhone();
    assert.deepEqual([result.tooLargeChanged, result.uploaded], [["grows.md"], []]);
    w.pullPc();
    assert.equal(w.readPc("grows.md"), "small\n");
    assert.deepEqual((await w.syncPhone()).tooLargeChanged, ["grows.md"]);
  });

  it("starts a branch on a repository that is empty", async () => {
    const w = setup();
    w.writePhone("first.md", "the first note\n");
    w.writePhone("폴더/둘째.md", "둘째\n");
    const result = await w.syncPhone({ branch: "main" });
    assert.deepEqual(result.uploaded.sort(), ["first.md", "폴더/둘째.md"]);
    assert.deepEqual(w.log(), ["from the phone"]);
    assert.equal(server.git(path.basename(w.url), "fsck", "--strict"), "");
    w.pullPc();
    assert.equal(w.readPc("폴더/둘째.md"), "둘째\n");
  });

  it("joins a vault that has notes already with a repository that has others", async () => {
    const w = setup({ "there.md": "there\n", "same.md": "same\n", "differs.md": "the computer's\n" });
    w.writePhone("here.md", "here\n");
    w.writePhone("same.md", "same\n");
    w.writePhone("differs.md", "the phone's\n");
    const result = await w.syncPhone();
    assert.deepEqual(result.downloaded.sort(), ["differs (conflict 2026-11-22 0915).md", "there.md"]);
    assert.deepEqual(result.uploaded.sort(), ["differs.md", "here.md"]);
    assert.equal(w.readPhone("differs.md"), "the phone's\n");
    assert.equal(w.readPhone("differs (conflict 2026-11-22 0915).md"), "the computer's\n");
  });

  it("sends many changes as several commits of a bounded size", async () => {
    const w = setup({ "a.md": "a\n" });
    await w.syncPhone();
    for (let i = 0; i < 9; i++) {
      w.writePhone(`big ${i}.md`, `${i}`.repeat(1_500));
    }
    const result = await w.syncPhone();
    assert.equal(result.uploaded.length, 9);
    // Nine files of 1.5 kB in batches of 4 kB: two files to a commit, the last one alone
    assert.equal(w.log().length, 1 + 5);
    w.pullPc();
    assert.equal(w.readPc("big 8.md"), "8".repeat(1_500));
    assert.equal(server.git(path.basename(w.url), "fsck", "--strict"), "");
  });

  it("refuses to sync a vault with another repository than before", async () => {
    const w = setup({ "a.md": "a\n" });
    await w.syncPhone();
    await assert.rejects(w.syncPhone({ remote: { url: `${w.url}x` } }), /was synced with/);
  });

  it("never touches its own folder or a .git folder", async () => {
    const w = setup({ "a.md": "a\n" });
    w.writePhone(".git/config", "not ours\n");
    const result = await w.syncPhone();
    assert.deepEqual(result.uploaded, []);
    w.pullPc();
    assert.equal(existsSync(path.join(w.pcDir, ".piecemeal")), false);
    rmSync(path.join(w.phoneDir, ".git"), { recursive: true });
  });
});
