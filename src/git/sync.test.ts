import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { nodeHttp, NodeFs } from "../platform/node.ts";
import { CaseBlindFs } from "../testing/case-blind-fs.ts";
import { DecomposingFs } from "../testing/decomposing-fs.ts";
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
      /** Commits changes on the remote as a computer would that tells capital letters apart. Null removes a file. */
      commitThere(changes: Record<string, string | Buffer | null>, message = "from another computer"): void {
        server.commit(name, changes, message);
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
      /** The paths of the files that the branch of the remote holds, spelled as it has them. */
      pathsThere(): string[] {
        return server
          .git(`${name}.git`, "-c", "core.quotepath=false", "-c", "core.precomposeunicode=false", "ls-tree", "-r", "--name-only", "main")
          .split("\n")
          .sort();
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

  it("puts together what both sides changed in different places of a text", async () => {
    const text = (second: string, last: string): string => `# Title\n${second}\nthree\nfour\nfive\n${last}\n`;
    const w = setup({ "note.md": text("two", "six"), "한글.md": text("둘", "여섯") });
    await w.syncPhone();
    w.writePc("note.md", text("two from the computer", "six"));
    w.writePc("한글.md", text("컴퓨터가 고친 둘", "여섯"));
    w.pushPc();
    w.writePhone("note.md", text("two", "six from the phone"));
    w.writePhone("한글.md", text("둘", "폰이 고친 여섯"));
    const result = await w.syncPhone();

    assert.deepEqual([result.merged.sort(), result.conflicts, result.downloaded], [["note.md", "한글.md"], [], []]);
    assert.deepEqual(result.uploaded.sort(), ["note.md", "한글.md"]);
    assert.equal(w.readPhone("note.md"), text("two from the computer", "six from the phone"));
    assert.equal(w.readPhone("한글.md"), text("컴퓨터가 고친 둘", "폰이 고친 여섯"));
    assert.deepEqual(readdirSync(w.phoneDir).sort(), [".piecemeal", "note.md", "한글.md"]);
    w.pullPc();
    assert.equal(w.readPc("note.md"), text("two from the computer", "six from the phone"));
    assert.equal(w.readPc("한글.md"), text("컴퓨터가 고친 둘", "폰이 고친 여섯"));
    assert.equal(server.git(path.basename(w.url), "fsck", "--strict"), "");

    const again = await w.syncPhone();
    assert.deepEqual([again.merged, again.downloaded, again.uploaded], [[], [], []]);
  });

  it("takes the text of the remote when it holds the change of the vault too", async () => {
    const w = setup({ "note.md": "one\ntwo\nthree\nfour\nfive\n" });
    await w.syncPhone();
    w.writePc("note.md", "ONE\ntwo\nthree\nfour\nFIVE\n");
    w.pushPc();
    w.writePhone("note.md", "ONE\ntwo\nthree\nfour\nfive\n");
    const result = await w.syncPhone();
    assert.deepEqual([result.merged, result.uploaded, result.conflicts], [["note.md"], [], []]);
    assert.equal(w.readPhone("note.md"), "ONE\ntwo\nthree\nfour\nFIVE\n");
    assert.deepEqual(w.log(), ["from the computer", "first"]);
    const again = await w.syncPhone();
    assert.deepEqual([again.merged, again.downloaded, again.uploaded], [[], [], []]);
  });

  it("keeps both versions of what is not a text, and of a text when it is told not to put texts together", async () => {
    const image = (byte: number): Buffer => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, byte, 10, 1, 10, 2, 10]);
    const w = setup({ "image.png": image(1), "note.md": "one\ntwo\nthree\nfour\n" });
    await w.syncPhone();
    w.writePc("image.png", image(2));
    w.writePc("note.md", "ONE\ntwo\nthree\nfour\n");
    w.pushPc();
    w.writePhone("image.png", image(3));
    w.writePhone("note.md", "one\ntwo\nthree\nFOUR\n");
    const result = await w.syncPhone({ mergeText: false });
    assert.deepEqual(result.merged, []);
    assert.deepEqual(result.conflicts.map((c) => c.path).sort(), ["image.png", "note.md"]);
    assert.equal(w.readPhone("note.md"), "one\ntwo\nthree\nFOUR\n");
    assert.equal(w.readPhone("note (conflict 2026-11-22 0915).md"), "ONE\ntwo\nthree\nfour\n");
    assert.deepEqual(readFileSync(path.join(w.phoneDir, "image.png")), image(3));
    assert.deepEqual(readFileSync(path.join(w.phoneDir, "image (conflict 2026-11-22 0915).png")), image(2));

    // The same with texts put together: the image still gets its copy
    w.pullPc();
    w.writePc("image.png", image(4));
    w.pushPc();
    w.writePhone("image.png", image(5));
    const second = await w.syncPhone();
    assert.deepEqual([second.merged, second.conflicts.map((c) => c.path)], [[], ["image.png"]]);
  });

  it("puts a text together again after a sync that stopped before it sent the result", async () => {
    const w = setup({ "note.md": "one\ntwo\nthree\nfour\nfive\n" });
    await w.syncPhone();
    w.writePc("note.md", "ONE\ntwo\nthree\nfour\nfive\n");
    w.pushPc();
    w.writePhone("note.md", "one\ntwo\nthree\nfour\nFIVE\n");
    await assert.rejects(
      w.syncPhone({
        http: (request) => (request.url.endsWith("/git-receive-pack") ? Promise.reject(new Error("no network")) : nodeHttp(request)),
      }),
      /no network/,
    );
    assert.equal(w.readPhone("note.md"), "ONE\ntwo\nthree\nfour\nFIVE\n");
    const result = await w.syncPhone();
    assert.deepEqual([result.merged, result.uploaded, result.conflicts], [["note.md"], ["note.md"], []]);
    w.pullPc();
    assert.equal(w.readPc("note.md"), "ONE\ntwo\nthree\nfour\nFIVE\n");
  });

  it("sends a change with the next sync when the one before failed while it sent", async () => {
    const w = setup({ "a.md": "a\n", "b.md": "b\n" });
    await w.syncPhone();
    w.writePhone("a.md", "a from the phone\n");
    w.removePhone("b.md");
    w.writePhone("new.md", "new\n");
    await assert.rejects(
      w.syncPhone({
        http: (request) => (request.url.endsWith("/git-receive-pack") ? Promise.reject(new Error("no network")) : nodeHttp(request)),
      }),
      /no network/,
    );
    const result = await w.syncPhone();
    assert.deepEqual([result.uploaded.sort(), result.deletedThere], [["a.md", "new.md"], ["b.md"]]);
    w.pullPc();
    assert.deepEqual([w.readPc("a.md"), w.readPc("b.md"), w.readPc("new.md")], ["a from the phone\n", null, "new\n"]);
  });

  it("starts over when another device sent something while the sync ran", async () => {
    const w = setup({ "a.md": "a\n", "b.md": "b\n" });
    await w.syncPhone();
    w.writePhone("a.md", "a from the phone\n");
    let pushes = 0;
    const result = await w.syncPhone({
      http: (request) => {
        if (request.url.endsWith("/git-receive-pack") && ++pushes === 1) {
          // The computer is a moment faster
          w.writePc("b.md", "b from the computer\n");
          w.pushPc();
        }
        return nodeHttp(request);
      },
    });
    assert.equal(pushes, 2);
    assert.deepEqual([result.uploaded, result.downloaded], [["a.md"], ["b.md"]]);
    assert.equal(w.readPhone("b.md"), "b from the computer\n");
    assert.deepEqual(w.log(), ["from the phone", "from the computer", "first"]);
    w.pullPc();
    assert.equal(w.readPc("a.md"), "a from the phone\n");
    // The commit that was refused stays on the server until it tidies up, and nothing points to it
    assert.match(server.git(path.basename(w.url), "fsck", "--strict"), /^dangling commit [0-9a-f]{40}$/);
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

  it("takes a file that was too large once the limit lets it in, and asks nothing about it until then", async () => {
    const w = setup({ "a.md": "a\n", "huge.bin": Buffer.alloc(50_000, 7) });
    const first = await w.syncPhone();
    assert.deepEqual([first.downloaded, first.tooLargeThere], [["a.md"], ["huge.bin"]]);

    // The same limit: the file is not asked about again, and nothing is said
    const before = server.responseSizes.length;
    const second = await w.syncPhone({
      sizes: async () => {
        throw new Error("the sizes were asked for");
      },
    });
    assert.deepEqual([second.downloaded, second.tooLargeThere, second.uploaded, second.deletedThere], [[], [], [], []]);
    assert.equal(server.responseSizes.length - before, 1);

    const third = await w.syncPhone({ maxFileBytes: 100_000 });
    assert.deepEqual([third.downloaded, third.tooLargeThere, third.uploaded], [["huge.bin"], [], []]);
    assert.equal(readFileSync(path.join(w.phoneDir, "huge.bin")).length, 50_000);
    const fourth = await w.syncPhone({ maxFileBytes: 100_000 });
    assert.deepEqual([fourth.downloaded, fourth.uploaded, fourth.deletedThere], [[], [], []]);
    assert.deepEqual(w.log(), ["first"]);
  });

  it("keeps batches small on a host that does not tell the sizes, by what came before", async () => {
    const files: Record<string, string | Buffer> = {};
    for (let i = 0; i < 24; i++) {
      files[`notes/note ${i}.md`] = `note ${i}\n${"some text of a note. ".repeat(40)}${Math.random()}\n`;
      files[`pictures/picture ${i}.png`] = Buffer.from(Array.from({ length: 3000 }, () => Math.floor(Math.random() * 256)));
    }
    const w = setup(files);
    const before = server.responseSizes.length;
    const result = await w.syncPhone({ sizes: undefined });
    assert.equal(result.downloaded.length, 48);
    const responses = server.responseSizes.slice(before);
    // Notes of 850 bytes come several at a time, pictures of 3000 bytes one at a time
    assert.ok(responses.length < 48, `${responses.length} requests`);
    assert.ok(Math.max(...responses) < 8_000, `largest response ${Math.max(...responses)}`);
    for (const file of Object.keys(files)) {
      assert.equal(server.git(path.basename(w.phoneDir), "hash-object", file), server.git(path.basename(w.url), "rev-parse", `main:${file}`));
    }
  });

  it("gets a file that is too large for one response through the way the host offers", async () => {
    const w = setup({ "huge.bin": Buffer.alloc(50_000, 7) });
    const fs = new NodeFs(w.phoneDir);
    const result = await w.syncPhone({
      largeBlob: async (file, to) => {
        // A host would be asked for ranges of bytes of the file at that commit. Here it is written in pieces.
        assert.equal(file.size, 50_000);
        assert.equal(server.git(path.basename(w.url), "rev-parse", `${file.commit}:${file.path}`), file.oid);
        await fs.remove(to);
        for (let at = 0; at < file.size; at += 16_000) {
          await fs.append(to, Buffer.alloc(Math.min(16_000, file.size - at), 7));
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

  it("reads the .gitignore of a folder too, as git does", async () => {
    const w = setup({ "a.md": "a\n", ".gitignore": "*.log\n" });
    await w.syncPhone();
    w.writePhone("sub/.gitignore", "*.tmp\n/only-here.md\n!keep.log\n");
    w.writePhone("sub/scratch.tmp", "ignored by the folder\n");
    w.writePhone("sub/only-here.md", "ignored by the folder\n");
    w.writePhone("sub/deeper/only-here.md", "a line with a slash is for the folder of its file only\n");
    w.writePhone("sub/deeper/x.tmp", "ignored further down too\n");
    w.writePhone("sub/keep.log", "brought back by the folder\n");
    w.writePhone("sub/other.log", "ignored by the vault\n");
    w.writePhone("top.tmp", "the file of the folder says nothing here\n");
    const result = await w.syncPhone();
    assert.deepEqual(result.uploaded.sort(), ["sub/.gitignore", "sub/deeper/only-here.md", "sub/keep.log", "top.tmp"]);
    // git sees the same: nothing in the folder of the computer is left to add
    w.pullPc();
    for (const file of ["sub/scratch.tmp", "sub/only-here.md", "sub/deeper/x.tmp", "sub/other.log"]) {
      w.writePc(file, "x");
    }
    assert.equal(server.git(path.basename(w.pcDir), "status", "--porcelain"), "");
  });

  it("removes a folder that lost its last file, and leaves one that still holds something", async () => {
    const w = setup({ "gone/deep/a.md": "a\n", "gone/b.md": "b\n", "stays/c.md": "c\n", "stays/d.md": "d\n", "mine/e.md": "e\n" });
    await w.syncPhone();
    w.writePhone("mine/not synced.tmp", "the vault alone has this\n");
    w.writePhone(".gitignore", "*.tmp\n");
    rmSync(path.join(w.pcDir, "gone"), { recursive: true });
    unlinkSync(path.join(w.pcDir, "stays/c.md"));
    unlinkSync(path.join(w.pcDir, "mine/e.md"));
    w.pushPc();
    const result = await w.syncPhone();
    assert.deepEqual(result.deletedHere.sort(), ["gone/b.md", "gone/deep/a.md", "mine/e.md", "stays/c.md"]);
    assert.equal(existsSync(path.join(w.phoneDir, "gone")), false);
    assert.equal(existsSync(path.join(w.phoneDir, "stays")), true);
    assert.equal(w.readPhone("mine/not synced.tmp"), "the vault alone has this\n");
  });

  it("takes a file that became a folder on the computer, and a folder that became a file", async () => {
    const w = setup({ "thing": "a file\n", "other/inner.md": "in a folder\n" });
    await w.syncPhone();
    unlinkSync(path.join(w.pcDir, "thing"));
    w.writePc("thing/now inside.md", "inside\n");
    rmSync(path.join(w.pcDir, "other"), { recursive: true });
    w.writePc("other", "now a file\n");
    w.pushPc();
    const result = await w.syncPhone();
    assert.deepEqual(result.busy, []);
    assert.equal(w.readPhone("thing/now inside.md"), "inside\n");
    assert.equal(w.readPhone("other"), "now a file\n");
    const again = await w.syncPhone();
    assert.deepEqual([again.downloaded, again.uploaded, again.deletedThere], [[], [], []]);
  });

  it("keeps both when a name is a file here and a folder there, or the other way round", async () => {
    const w = setup({ "a.md": "a\n" });
    await w.syncPhone();
    w.writePc("plan/steps.md", "the computer made a folder\n");
    w.writePc("notes", "the computer made a file\n");
    w.pushPc();
    w.writePhone("plan", "the phone made a file\n");
    w.writePhone("notes/idea.md", "the phone made a folder\n");
    const result = await w.syncPhone();

    const copies = { "plan/steps.md": "plan (conflict 2026-11-22 0915)/steps.md", notes: "notes (conflict 2026-11-22 0915)" };
    assert.deepEqual(
      result.conflicts.sort((x, y) => x.path.localeCompare(y.path)),
      [
        { path: "notes", copy: copies.notes },
        { path: "plan/steps.md", copy: copies["plan/steps.md"] },
      ],
    );
    assert.equal(w.readPhone("plan"), "the phone made a file\n");
    assert.equal(w.readPhone(copies["plan/steps.md"]), "the computer made a folder\n");
    assert.equal(w.readPhone("notes/idea.md"), "the phone made a folder\n");
    assert.equal(w.readPhone(copies.notes), "the computer made a file\n");
    assert.equal(server.git(path.basename(w.url), "fsck", "--strict"), "");

    w.pullPc();
    assert.equal(w.readPc("plan"), "the phone made a file\n");
    assert.equal(w.readPc(copies["plan/steps.md"]), "the computer made a folder\n");
    assert.equal(w.readPc("notes/idea.md"), "the phone made a folder\n");
    assert.equal(w.readPc(copies.notes), "the computer made a file\n");
    const again = await w.syncPhone();
    assert.deepEqual([again.downloaded, again.uploaded, again.conflicts], [[], [], []]);
  });

  it("puts a file where the vault has an empty folder of that name", async () => {
    const w = setup({ "a.md": "a\n" });
    await w.syncPhone();
    mkdirSync(path.join(w.phoneDir, "report"));
    w.writePc("report", "a file on the computer\n");
    w.pushPc();
    const result = await w.syncPhone();
    assert.deepEqual([result.downloaded, result.busy], [["report"], []]);
    assert.equal(w.readPhone("report"), "a file on the computer\n");
  });

  it("sees a change that left the size and the time of a file as they were", async () => {
    const w = setup({ "a.md": "a\n" });
    await w.syncPhone();
    // A file that is written right before a sync, as a note that is being typed
    const file = path.join(w.phoneDir, "typed.md");
    writeFileSync(file, "first\n");
    await w.syncPhone();
    const { mtime } = statSync(file);
    writeFileSync(file, "other\n");
    utimesSync(file, mtime, mtime);
    const result = await w.syncPhone();
    assert.deepEqual(result.uploaded, ["typed.md"]);
    w.pullPc();
    assert.equal(w.readPc("typed.md"), "other\n");
  });

  it("leaves a path that is never synced alone on both sides", async () => {
    const w = setup({ "a.md": "a\n", "device/settings.json": "the computer's\n", ".piecemeal/state.json": "not ours\n" });
    const exclude = (file: string): boolean => file === "device/settings.json";
    w.writePhone("device/settings.json", "the phone's\n");
    const first = await w.syncPhone({ exclude });
    assert.deepEqual([first.downloaded, first.uploaded, first.conflicts], [["a.md"], [], []]);
    assert.equal(w.readPhone("device/settings.json"), "the phone's\n");
    // The next sync does not take the missing agreement for a removal either
    w.writePhone("a.md", "a changed\n");
    const second = await w.syncPhone({ exclude });
    assert.deepEqual([second.uploaded, second.deletedThere], [["a.md"], []]);
    w.pullPc();
    assert.equal(w.readPc("device/settings.json"), "the computer's\n");
    assert.equal(w.readPc(".piecemeal/state.json"), "not ours\n");
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

  // A phone and most computers take "a.md" and "A.md" for one file. Git does not.
  describe("in a vault that does not tell capital letters from small ones", () => {
    const blind = (w: { phoneDir: string }): Partial<SyncOptions> => ({ fs: new CaseBlindFs(new NodeFs(w.phoneDir)) });
    const names = (dir: string): string[] => readdirSync(dir).filter((name) => name !== ".piecemeal").sort();

    it("leaves out a file of the remote that is named like another but for capital letters", async () => {
      const w = setup();
      w.commitThere({ "Note.md": "capital\n", "note.md": "small\n", "other.md": "other\n" }, "first");
      const first = await w.syncPhone(blind(w));
      assert.equal(first.sameName.length, 1);
      const [out] = first.sameName;
      const kept = out === "Note.md" ? "note.md" : "Note.md";
      assert.deepEqual(names(w.phoneDir), [kept, "other.md"].sort());
      assert.equal(w.readPhone(kept), kept === "Note.md" ? "capital\n" : "small\n");

      // Nothing of this goes back to the remote
      const second = await w.syncPhone(blind(w));
      assert.deepEqual([second.uploaded, second.deletedThere, second.downloaded, second.sameName], [[], [], [], []]);
      assert.deepEqual(w.log(), ["first"]);

      // A change of the file that was left out does not reach the one that is here
      w.commitThere({ [out]: "changed on the computer\n" }, "change");
      const third = await w.syncPhone(blind(w));
      assert.deepEqual([third.sameName, third.downloaded, third.uploaded, third.busy], [[out], [], [], []]);
      assert.equal(w.readPhone(kept), kept === "Note.md" ? "capital\n" : "small\n");

      // Nor does its removal
      w.commitThere({ [out]: null }, "removal");
      const fourth = await w.syncPhone(blind(w));
      assert.deepEqual([fourth.deletedHere, fourth.uploaded, fourth.deletedThere, fourth.busy], [[], [], [], []]);
      assert.deepEqual(names(w.phoneDir), [kept, "other.md"].sort());
      const fifth = await w.syncPhone(blind(w));
      assert.deepEqual([fifth.downloaded, fifth.uploaded, fifth.deletedThere], [[], [], []]);
      assert.deepEqual(w.log(), ["removal", "change", "first"]);
    });

    it("takes a file that was left out for its name once the other one is gone", async () => {
      const w = setup();
      w.commitThere({ "Note.md": "capital\n", "note.md": "small\n" }, "first");
      const first = await w.syncPhone(blind(w));
      const [out] = first.sameName;
      const kept = out === "Note.md" ? "note.md" : "Note.md";

      // As long as the other one is there, a sync looks, asks the remote nothing, and says nothing
      const before = server.responseSizes.length;
      const second = await w.syncPhone({
        ...blind(w),
        sizes: async () => {
          throw new Error("the sizes were asked for");
        },
      });
      assert.deepEqual([second.downloaded, second.sameName], [[], []]);
      assert.equal(server.responseSizes.length - before, 1);

      // The one that had the name is removed on the device: its removal is sent, and the other one comes
      w.removePhone(kept);
      const third = await w.syncPhone(blind(w));
      assert.deepEqual([third.deletedThere, third.downloaded, third.sameName], [[kept], [out], []]);
      assert.deepEqual(names(w.phoneDir), [out]);
      assert.equal(w.readPhone(out), out === "Note.md" ? "capital\n" : "small\n");
      const fourth = await w.syncPhone(blind(w));
      assert.deepEqual([fourth.downloaded, fourth.uploaded, fourth.deletedThere, fourth.sameName], [[], [], [], []]);
      assert.deepEqual(w.log(), ["from the phone", "first"]);
    });

    it("leaves out a file of a folder that is spelled otherwise in the vault", async () => {
      const w = setup({ "Notes/a.md": "a\n" });
      await w.syncPhone(blind(w));
      w.commitThere({ "notes/b.md": "b\n" }, "another spelling");
      const result = await w.syncPhone(blind(w));
      assert.deepEqual([result.sameName, result.downloaded], [["notes/b.md"], []]);
      assert.deepEqual(names(path.join(w.phoneDir, "Notes")), ["a.md"]);
      const again = await w.syncPhone(blind(w));
      assert.deepEqual([again.uploaded, again.deletedThere], [[], []]);
    });

    it("takes a name that the remote spells otherwise now", async () => {
      const w = setup({ "Note.md": "a note\n" });
      await w.syncPhone(blind(w));
      w.commitThere({ "Note.md": null, "note.md": "a note\n" }, "small letters");
      const result = await w.syncPhone(blind(w));
      assert.deepEqual([result.deletedHere, result.downloaded, result.sameName], [["Note.md"], ["note.md"], []]);
      assert.deepEqual(names(w.phoneDir), ["note.md"]);
      assert.equal(w.readPhone("note.md"), "a note\n");
      const again = await w.syncPhone(blind(w));
      assert.deepEqual([again.uploaded, again.deletedThere, again.downloaded], [[], [], []]);
    });

    it("sends a name that the vault spells otherwise now", async () => {
      const w = setup({ "Note.md": "a note\n", "Folder/in.md": "inside\n" });
      await w.syncPhone(blind(w));
      renameSync(path.join(w.phoneDir, "Note.md"), path.join(w.phoneDir, "note.md"));
      renameSync(path.join(w.phoneDir, "Folder"), path.join(w.phoneDir, "folder"));
      const result = await w.syncPhone(blind(w));
      assert.deepEqual([result.uploaded.sort(), result.deletedThere.sort()], [["folder/in.md", "note.md"], ["Folder/in.md", "Note.md"]]);
      w.pullPc();
      assert.deepEqual(names(w.pcDir), [".git", "folder", "note.md"]);
      assert.equal(w.readPc("folder/in.md"), "inside\n");
      const again = await w.syncPhone(blind(w));
      assert.deepEqual([again.uploaded, again.deletedThere, again.downloaded], [[], [], []]);
    });
  });

  // An iPhone, an iPad and the apps of a Mac keep "한" as its three parts and "é" as "e" and an accent,
  // whatever a name was written as. Git keeps a name as it is given, which for most is in one piece.
  describe("in a vault that takes the letters of a name apart", () => {
    const apple = (w: { phoneDir: string }): Partial<SyncOptions> => ({
      fs: new DecomposingFs(new NodeFs(w.phoneDir)),
      composeNames: true,
    });
    const apart = (name: string): string => name.normalize("NFD");
    const names = (dir: string): string[] => readdirSync(dir).filter((name) => name !== ".piecemeal").sort();

    it("takes names with such letters, and does not send them back under another spelling", async () => {
      const w = setup();
      w.commitThere({ "한글 노트.md": "한글\n", "폴더/깊은 곳.md": "깊다\n", "café.md": "coffee\n", "plain.md": "plain\n" }, "first");
      const first = await w.syncPhone(apple(w));
      assert.deepEqual([...first.downloaded].sort(), ["café.md", "plain.md", "폴더/깊은 곳.md", "한글 노트.md"].sort());
      // The device spells them its own way
      assert.deepEqual(names(w.phoneDir), ["café.md", "plain.md", "폴더", "한글 노트.md"].map(apart).sort());
      assert.equal(w.readPhone(apart("폴더/깊은 곳.md")), "깊다\n");

      const second = await w.syncPhone(apple(w));
      assert.deepEqual([second.downloaded, second.uploaded, second.deletedHere, second.deletedThere], [[], [], [], []]);
      assert.deepEqual(w.log(), ["first"]);

      // A change of either side reaches the same file
      w.writePhone(apart("한글 노트.md"), "한글, 폰에서 고침\n");
      w.commitThere({ "폴더/깊은 곳.md": "더 깊다\n" }, "change");
      const third = await w.syncPhone(apple(w));
      assert.deepEqual([third.uploaded, third.downloaded, third.deletedThere, third.conflicts], [["한글 노트.md"], ["폴더/깊은 곳.md"], [], []]);
      assert.equal(w.readPhone(apart("폴더/깊은 곳.md")), "더 깊다\n");
      assert.deepEqual(w.pathsThere(), ["café.md", "plain.md", "폴더/깊은 곳.md", "한글 노트.md"].sort());
      assert.deepEqual(names(path.join(w.phoneDir, apart("폴더"))), [apart("깊은 곳.md")]);
    });

    it("sends a new name with its letters in one piece", async () => {
      const w = setup({ "a.md": "a\n" });
      await w.syncPhone(apple(w));
      w.writePhone(apart("새 폴더/새 노트.md"), "새로 썼다\n");
      const result = await w.syncPhone(apple(w));
      assert.deepEqual(result.uploaded, ["새 폴더/새 노트.md"]);
      assert.deepEqual(w.pathsThere(), ["a.md", "새 폴더/새 노트.md"].sort());
      const again = await w.syncPhone(apple(w));
      assert.deepEqual([again.uploaded, again.downloaded, again.deletedThere], [[], [], []]);

      // The removal of the file on the device removes that one
      w.removePhone(apart("새 폴더/새 노트.md"));
      const removal = await w.syncPhone(apple(w));
      assert.deepEqual(removal.deletedThere, ["새 폴더/새 노트.md"]);
      assert.deepEqual(w.pathsThere(), ["a.md"]);
    });

    it("keeps a name that the repository spells in parts", async () => {
      const w = setup();
      const there = apart("분해된 이름.md");
      w.commitThere({ [there]: "one\n" }, "first");
      const first = await w.syncPhone(apple(w));
      assert.deepEqual(first.downloaded, [there]);
      w.writePhone(there, "two\n");
      const second = await w.syncPhone(apple(w));
      assert.deepEqual([second.uploaded, second.deletedThere], [[there], []]);
      assert.deepEqual(w.pathsThere(), [there]);
    });

    it("leaves out a file of the remote whose name differs from another in this only", async () => {
      const w = setup();
      const whole = "이름.md";
      w.commitThere({ [whole]: "whole\n", [apart(whole)]: "apart\n" }, "first");
      const first = await w.syncPhone(apple(w));
      assert.equal(first.downloaded.length, 1);
      assert.equal(first.sameName.length, 1);
      assert.deepEqual(names(w.phoneDir), [apart(whole)]);
      const second = await w.syncPhone(apple(w));
      assert.deepEqual([second.uploaded, second.deletedThere, second.downloaded, second.sameName], [[], [], [], []]);
      assert.deepEqual(w.pathsThere(), [whole, apart(whole)].sort());
    });
  });
});
