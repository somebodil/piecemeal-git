import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { nodeHttp, NodeFs } from "../../tests/node.ts";
import { CaseBlindFs } from "../../tests/case-blind-fs.ts";
import { DecomposingFs } from "../../tests/decomposing-fs.ts";
import { FlakyFs } from "../../tests/flaky-fs.ts";
import { TestServer } from "../../tests/server.ts";
import { type FileStat, VerifiedFs } from "./fs.ts";
import { BLOCK_START } from "./ignore.ts";
import { remoteOf } from "./protocol.ts";
import { CancelledError, type Plan, sync, type SyncOptions, type SyncResult } from "./sync.ts";

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
  function setup(files: Record<string, string | Buffer> = {}, tellsSizes = false) {
    const name = `repo${++counter}`;
    const url = server.createRepo(name, tellsSizes);
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
      commitThere(changes: Record<string, string | Buffer | { link: string } | null>, message = "from another computer"): void {
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

  it("merges changes to different files, and gives the name of a file that both changed to the version of the remote", async () => {
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
    assert.equal(w.readPhone("both.md"), "the computer's version\n");
    assert.equal(w.readPhone(copy), "the phone's version\n");
    assert.deepEqual(result.uploaded.sort(), ["b.md", copy]);
    assert.deepEqual(result.downloaded.sort(), ["a.md", "both.md"]);
    assert.deepEqual(w.log(), ["from the phone", "from the computer", "first"]);

    w.pullPc();
    assert.equal(w.readPc("b.md"), "b from the phone\n");
    assert.equal(w.readPc("both.md"), "the computer's version\n");
    assert.equal(w.readPc(copy), "the phone's version\n");

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

  it("keeps the version of the vault as a copy of what is not a text, and of a text when it is told not to put texts together", async () => {
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
    assert.equal(w.readPhone("note.md"), "ONE\ntwo\nthree\nfour\n");
    assert.equal(w.readPhone("note (conflict 2026-11-22 0915).md"), "one\ntwo\nthree\nFOUR\n");
    assert.deepEqual(readFileSync(path.join(w.phoneDir, "image.png")), image(2));
    assert.deepEqual(readFileSync(path.join(w.phoneDir, "image (conflict 2026-11-22 0915).png")), image(3));
    w.pullPc();
    assert.deepEqual(readFileSync(path.join(w.pcDir, "image.png")), image(2));
    assert.deepEqual(readFileSync(path.join(w.pcDir, "image (conflict 2026-11-22 0915).png")), image(3));

    // The same with texts put together: the image still gets its copy
    w.writePc("image.png", image(4));
    w.pushPc();
    w.writePhone("image.png", image(5));
    const second = await w.syncPhone();
    assert.deepEqual([second.merged, second.conflicts], [[], [{ path: "image.png", copy: "image (conflict 2026-11-22 0915 2).png" }]]);
    assert.deepEqual(readFileSync(path.join(w.phoneDir, "image.png")), image(4));
    assert.deepEqual(readFileSync(path.join(w.phoneDir, "image (conflict 2026-11-22 0915 2).png")), image(5));
  });

  it("makes one copy only of a version that gives way, also when the sync is cut off before the other one came", async () => {
    const w = setup({ "note.md": "start\n" });
    await w.syncPhone();
    w.writePc("note.md", "the computer's\n");
    w.pushPc();
    w.writePhone("note.md", "the phone's\n");
    // The copy goes to the remote, and then the network is gone
    let sent = false;
    await assert.rejects(
      w.syncPhone({
        http: (request) => {
          if (sent && request.url.endsWith("/git-upload-pack")) {
            return Promise.reject(new Error("no network"));
          }
          sent = sent || request.url.endsWith("/git-receive-pack");
          return nodeHttp(request);
        },
      }),
      /no network/,
    );
    const copy = "note (conflict 2026-11-22 0915).md";
    assert.deepEqual([w.readPhone("note.md"), w.readPhone(copy)], ["the phone's\n", "the phone's\n"]);

    const result = await w.syncPhone({ now: () => new Date(2026, 10, 22, 9, 30) });
    assert.deepEqual([result.conflicts, result.downloaded, result.uploaded], [[{ path: "note.md", copy }], ["note.md"], []]);
    assert.deepEqual(readdirSync(w.phoneDir).sort(), [".piecemeal", copy, "note.md"]);
    assert.deepEqual([w.readPhone("note.md"), w.readPhone(copy)], ["the computer's\n", "the phone's\n"]);
    w.pullPc();
    assert.deepEqual([w.readPc("note.md"), w.readPc(copy)], ["the computer's\n", "the phone's\n"]);
    const again = await w.syncPhone();
    assert.deepEqual([again.downloaded, again.uploaded, again.conflicts], [[], [], []]);
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

  it("asks a server for the sizes that tells them as git does, and leaves a file out that is too large", async () => {
    const files: Record<string, Buffer> = { "huge.bin": Buffer.alloc(20_000, 9) };
    for (let i = 0; i < 6; i++) {
      files[`image ${i}.png`] = Buffer.from(Array.from({ length: 3_000 }, () => Math.floor(Math.random() * 256)));
    }
    const w = setup(files, true);
    server.responseSizes.length = 0;
    const result = await w.syncPhone({ sizes: undefined });
    assert.deepEqual(result.tooLargeThere, ["huge.bin"]);
    assert.equal(result.downloaded.length, 6);
    assert.equal(w.readPhone("huge.bin"), null);
    // Six images of 3 kB in batches of 4 kB: one to a response, and the file of 20 kB in none
    assert.ok(Math.max(...server.responseSizes) < 5_000, `a response of ${Math.max(...server.responseSizes)} bytes`);
    // The file stays on the remote, and comes when the limit lets it in
    w.writePhone("note.md", "note\n");
    await w.syncPhone({ sizes: undefined });
    assert.ok(w.pathsThere().includes("huge.bin"));
    const raised = await w.syncPhone({ sizes: undefined, maxFileBytes: 50_000 });
    assert.deepEqual(raised.downloaded, ["huge.bin"]);
  });

  it("gives the name and the token to a server that asks for them", async () => {
    const w = setup({ "a.md": "a\n" });
    server.credentials = "누구:secret token";
    try {
      await assert.rejects(w.syncPhone(), /the server wants a token \(401\)/);
      await assert.rejects(w.syncPhone({ remote: { url: w.url, token: "secret token" } }), /the server refuses the token \(401\)/);
      const remote = remoteOf(w.url.replace("//", `//${encodeURIComponent("누구")}@`), "secret token");
      assert.equal(remote.url, w.url);
      const result = await w.syncPhone({ remote });
      assert.deepEqual(result.downloaded, ["a.md"]);
      w.writePhone("b.md", "b\n");
      assert.deepEqual((await w.syncPhone({ remote })).uploaded, ["b.md"]);
    } finally {
      server.credentials = null;
    }
    w.pullPc();
    assert.equal(w.readPc("b.md"), "b\n");
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

  it("does not send again what the remote has, when a folder gets another name", async () => {
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 4; i++) {
      files[`album/photo ${i}.jpg`] = Buffer.from(Array.from({ length: 3_000 }, () => Math.floor(Math.random() * 256)));
    }
    const w = setup(files);
    await w.syncPhone();
    renameSync(path.join(w.phoneDir, "album"), path.join(w.phoneDir, "photos"));
    w.writePhone("copy of a photo.jpg", files["album/photo 0.jpg"]);
    let sent = 0;
    const result = await w.syncPhone({
      http: (request) => {
        if (request.url.endsWith("/git-receive-pack")) {
          sent += request.body?.length ?? 0;
        }
        return nodeHttp(request);
      },
    });
    assert.equal(result.uploaded.length, 5);
    assert.equal(result.deletedThere.length, 4);
    // Twelve thousand bytes of photos got new names, and none of them went over the line again
    assert.ok(sent > 0 && sent < 1_500, `${sent} bytes were sent`);
    assert.deepEqual(w.pathsThere(), ["copy of a photo.jpg", "photos/photo 0.jpg", "photos/photo 1.jpg", "photos/photo 2.jpg", "photos/photo 3.jpg"]);
    w.pullPc();
    assert.deepEqual(readFileSync(path.join(w.pcDir, "photos/photo 3.jpg")), files["album/photo 3.jpg"]);
    assert.equal(server.git(path.basename(w.url), "fsck", "--strict"), "");
  });

  it("takes a file above the limit that got another name for the file it was", async () => {
    const w = setup({ "video.mp4": Buffer.alloc(50_000, 7), "a.md": "a\n" });
    const fs = new NodeFs(w.phoneDir);
    const largeBlob: SyncOptions["largeBlob"] = async (file, to) => {
      await fs.write(to, Buffer.alloc(file.size, 7));
      return true;
    };
    await w.syncPhone({ largeBlob });
    const before = server.git(path.basename(w.url), "rev-parse", "main:video.mp4");
    mkdirSync(path.join(w.phoneDir, "Attachments"));
    renameSync(path.join(w.phoneDir, "video.mp4"), path.join(w.phoneDir, "Attachments/holiday.mp4"));
    const result = await w.syncPhone({ largeBlob });
    // Neither removed from the remote, nor written into .gitignore as a new file that is too large
    assert.deepEqual([result.uploaded, result.deletedThere, result.tooLargeIgnored], [["Attachments/holiday.mp4"], ["video.mp4"], []]);
    assert.deepEqual(w.pathsThere(), ["Attachments/holiday.mp4", "a.md"]);
    assert.equal(server.git(path.basename(w.url), "rev-parse", "main:Attachments/holiday.mp4"), before);
    assert.equal(w.readPhone(".gitignore"), null);
    const again = await w.syncPhone({ largeBlob });
    assert.deepEqual([again.uploaded, again.downloaded, again.deletedThere, again.tooLargeChanged], [[], [], [], []]);
    // Another file of another size that is too large is still not sent
    w.writePhone("other.mp4", Buffer.alloc(50_001, 8));
    const other = await w.syncPhone({ largeBlob });
    assert.deepEqual(other.tooLargeIgnored, ["other.mp4"]);
  });

  it("joins the remote anew when what was agreed on cannot be read", async () => {
    const w = setup({ "a.md": "a\n", "b.md": "b\n" });
    await w.syncPhone();
    writeFileSync(path.join(w.phoneDir, ".piecemeal/state.json"), '{"version":1,"url":"');
    w.writePhone("a.md", "a of the phone\n");
    w.writePhone("c.md", "c\n");
    const result = await w.syncPhone();
    // What the phone changed since may be nowhere else: it is kept, beside the version of the remote
    const copy = "a (conflict 2026-11-22 0915).md";
    assert.deepEqual([result.deletedHere, result.deletedThere, result.downloaded, result.replaced], [[], [], ["a.md"], []]);
    assert.deepEqual(result.conflicts, [{ path: "a.md", copy }]);
    assert.deepEqual(result.uploaded.sort(), [copy, "c.md"]);
    assert.deepEqual([w.readPhone("a.md"), w.readPhone(copy), w.readPhone("b.md")], ["a\n", "a of the phone\n", "b\n"]);
    const again = await w.syncPhone();
    assert.deepEqual([again.downloaded, again.uploaded], [[], []]);
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
    // A file that differs is as the repository has it afterwards, and nothing of it is sent
    assert.deepEqual(result.downloaded.sort(), ["differs.md", "there.md"]);
    assert.deepEqual([result.uploaded, result.replaced, result.conflicts], [["here.md"], ["differs.md"], []]);
    assert.equal(w.readPhone("differs.md"), "the computer's\n");
    assert.deepEqual(readdirSync(w.phoneDir).sort(), [".piecemeal", "differs.md", "here.md", "same.md", "there.md"]);
    assert.deepEqual(w.pathsThere(), ["differs.md", "here.md", "same.md", "there.md"]);
    w.pullPc();
    assert.equal(w.readPc("differs.md"), "the computer's\n");
    const again = await w.syncPhone();
    assert.deepEqual([again.downloaded, again.uploaded, again.replaced], [[], [], []]);
  });

  it("puts what gives way at a first sync where a person can get it back", async () => {
    const w = setup({ "differs.md": "the computer's\n", "same.md": "same\n" });
    w.writePhone("differs.md", "the phone's\n");
    w.writePhone("same.md", "same\n");
    const fs = new NodeFs(w.phoneDir) as NodeFs & { discard?: (file: string) => Promise<void> };
    const discarded: Record<string, string | null> = {};
    fs.discard = async (file) => {
      discarded[file] = w.readPhone(file);
      await fs.remove(file);
    };
    const result = await w.syncPhone({ fs });
    assert.deepEqual([result.replaced, discarded], [["differs.md"], { "differs.md": "the phone's\n" }]);
    assert.equal(w.readPhone("differs.md"), "the computer's\n");
  });

  it("goes on as a first sync after a first sync that was cut off", async () => {
    const w = setup({ "there.md": "there\n", "differs.md": "the computer's\n" });
    w.writePhone("here.md", "here\n");
    w.writePhone("differs.md", "the phone's\n");
    await assert.rejects(
      w.syncPhone({
        http: (request) => (request.url.endsWith("/git-receive-pack") ? Promise.reject(new Error("no network")) : nodeHttp(request)),
      }),
      /no network/,
    );
    assert.equal(w.readPhone("differs.md"), "the phone's\n");
    const plans: Plan[] = [];
    const result = await w.syncPhone({
      confirm: (plan) => {
        plans.push(plan);
        return Promise.resolve(true);
      },
    });
    assert.deepEqual([plans[0].first, plans[0].replace], [true, ["differs.md"]]);
    assert.deepEqual([result.replaced, result.conflicts, result.uploaded], [["differs.md"], [], ["here.md"]]);
    assert.equal(w.readPhone("differs.md"), "the computer's\n");
    // Done with: a file that both sides change from here on is not replaced without a copy
    w.pullPc();
    w.writePc("differs.md", "the computer's, again\n");
    w.pushPc();
    w.writePhone("differs.md", "the phone's, again\n");
    const later = await w.syncPhone({ mergeText: false });
    assert.deepEqual([later.replaced, later.conflicts.length], [[], 1]);
  });

  it("leaves out at a first sync what the .gitignore of the repository leaves out", async () => {
    const w = setup({ "a.md": "a\n", ".gitignore": "*.tmp\n/settings/device.json\n", "sub/.gitignore": "*.log\n" });
    w.writePhone("mine.md", "mine\n");
    w.writePhone("scratch.tmp", "not for the repository\n");
    w.writePhone("settings/device.json", "{}\n");
    w.writePhone("settings/shared.json", "{}\n");
    w.writePhone("sub/run.log", "a log\n");
    w.writePhone("run.log", "a log at the top\n");
    const result = await w.syncPhone();
    assert.deepEqual(result.uploaded.sort(), ["mine.md", "run.log", "settings/shared.json"]);
    assert.deepEqual(w.pathsThere(), [".gitignore", "a.md", "mine.md", "run.log", "settings/shared.json", "sub/.gitignore"]);
    assert.deepEqual([w.readPhone("scratch.tmp"), w.readPhone("sub/run.log")], ["not for the repository\n", "a log\n"]);
    assert.equal(w.readPhone(".gitignore"), "*.tmp\n/settings/device.json\n");

    // Later too: a rule that the computer adds counts for what the phone made in the meantime
    w.pullPc();
    w.writePc(".gitignore", "*.tmp\n/settings/device.json\n*.bak\n");
    w.pushPc();
    w.writePhone("old.bak", "a file of the phone\n");
    w.writePhone("new.md", "new\n");
    const later = await w.syncPhone();
    assert.deepEqual([later.uploaded, later.downloaded], [["new.md"], [".gitignore"]]);
    assert.ok(!w.pathsThere().includes("old.bak"));
    const again = await w.syncPhone();
    assert.deepEqual([again.downloaded, again.uploaded], [[], []]);
  });

  it("writes a file that is too large at a first sync into the .gitignore of the repository", async () => {
    const w = setup({ "a.md": "a\n", ".gitignore": "*.tmp\n" });
    w.writePhone("video.mp4", Buffer.alloc(20_000, 7));
    w.writePhone("scratch.tmp", "not for the repository\n");
    const result = await w.syncPhone();
    assert.deepEqual([result.tooLargeIgnored, result.uploaded, result.replaced], [["video.mp4"], [".gitignore"], []]);
    const rules = w.readPhone(".gitignore")!;
    assert.ok(rules.startsWith("*.tmp\n") && rules.includes(BLOCK_START) && rules.includes("video.mp4"));
    assert.deepEqual(w.pathsThere(), [".gitignore", "a.md"]);
    w.pullPc();
    assert.equal(w.readPc(".gitignore"), rules);
    const again = await w.syncPhone();
    assert.deepEqual([again.downloaded, again.uploaded, again.tooLargeIgnored], [[], [], []]);
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
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(
      result.clashes.sort((x, y) => x.path.localeCompare(y.path)),
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
    assert.deepEqual([again.downloaded, again.uploaded, again.conflicts, again.clashes], [[], [], [], []]);
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
  describe("for a person who watches", () => {
    it("says what it is about to do, and changes nothing when it is told to stop", async () => {
      const w = setup({ "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" });
      w.writePhone("mine.md", "mine\n");
      w.writePhone("a.md", "a of the phone\n");
      const plans: Plan[] = [];
      await assert.rejects(
        w.syncPhone({
          confirm: (plan) => {
            plans.push(plan);
            return Promise.resolve(false);
          },
        }),
        CancelledError,
      );
      assert.deepEqual([...plans], [{ first: true, tracked: 0, take: 3, send: 1, removeHere: [], removeThere: [], replace: ["a.md"], bothChanged: [] }]);
      assert.deepEqual([w.readPhone("b.md"), existsSync(path.join(w.phoneDir, ".piecemeal/state.json")), w.pathsThere()], [null, false, ["a.md", "b.md", "c.md"]]);
      assert.equal(w.readPhone("a.md"), "a of the phone\n");

      await w.syncPhone({ confirm: () => Promise.resolve(true) });
      w.removePhone("b.md");
      w.commitThere({ "c.md": null });
      await w.syncPhone({
        confirm: (plan) => {
          plans.push(plan);
          return Promise.resolve(true);
        },
      });
      assert.deepEqual(plans[1], { first: false, tracked: 4, take: 0, send: 0, removeHere: ["c.md"], removeThere: ["b.md"], replace: [], bothChanged: [] });
    });

    it("asks once, also when the sync starts over", async () => {
      const w = setup({ "a.md": "a\n" });
      await w.syncPhone();
      w.writePhone("b.md", "b\n");
      let asked = 0;
      let pushes = 0;
      await w.syncPhone({
        confirm: () => Promise.resolve(++asked > 0),
        http: (request) => {
          if (request.url.endsWith("/git-receive-pack") && ++pushes === 1) {
            w.writePc("c.md", "c\n");
            w.pushPc();
          }
          return nodeHttp(request);
        },
      });
      assert.deepEqual([asked, pushes], [1, 2]);
    });

    it("asks the device once for the size and time of a file that did not change", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 20; i++) {
        files[`dir ${i % 4}/note ${i}.md`] = `note ${i}\n`;
      }
      const w = setup(files);
      await w.syncPhone();
      const asked = new Map<string, number>();
      const fs = new NodeFs(w.phoneDir);
      const stat = fs.stat.bind(fs);
      const read = fs.read.bind(fs);
      let reads = 0;
      fs.stat = (file) => {
        asked.set(file, (asked.get(file) ?? 0) + 1);
        return stat(file);
      };
      fs.read = (file) => {
        reads += file.startsWith(".piecemeal/") ? 0 : 1;
        return read(file);
      };
      // The files are a second old by now, so none has to be read to see that it is as it was
      for (const file of Object.keys(files)) {
        utimesSync(path.join(w.phoneDir, file), 1_700_000_000, 1_700_000_000);
      }
      await w.syncPhone({ fs });
      asked.clear();
      reads = 0;
      const result = await w.syncPhone({ fs });
      assert.deepEqual([result.downloaded, result.uploaded], [[], []]);
      assert.deepEqual(
        Object.keys(files).map((file) => asked.get(file)),
        Object.keys(files).map(() => 1),
      );
      // Only .gitignore is looked for by reading, and there is none
      assert.equal(reads, 1);
    });

    it("writes nothing into the vault when there was nothing to do", async () => {
      const w = setup({ "a.md": "a\n", "dir/b.md": "b\n" });
      await w.syncPhone();
      utimesSync(path.join(w.phoneDir, "a.md"), 1_700_000_000, 1_700_000_000);
      utimesSync(path.join(w.phoneDir, "dir/b.md"), 1_700_000_000, 1_700_000_000);
      // The first sync after files were written looks at them once more, and notes that they are as they were
      await w.syncPhone();
      const fs = new NodeFs(w.phoneDir);
      const write = fs.write.bind(fs);
      const written: string[] = [];
      fs.write = (file, data) => {
        written.push(file);
        return write(file, data);
      };
      const result = await w.syncPhone({ fs });
      assert.deepEqual([result.downloaded, result.uploaded, written], [[], [], []]);
      // What changes is written as before
      w.writePhone("a.md", "a, changed\n");
      await w.syncPhone({ fs });
      // The commit and its folder are kept, and what was agreed on is noted
      assert.deepEqual(written.filter((file) => !file.startsWith(".piecemeal/objects/")), [".piecemeal/state.json"]);
    });

    it("asks the vault a few things at once, never many, and while the remote answers", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 60; i++) {
        files[`dir ${i % 12}/sub ${i % 3}/note ${i}.md`] = `note ${i}\n`;
      }
      const w = setup(files);
      await w.syncPhone();
      for (let i = 0; i < 30; i++) {
        w.writePhone(`dir ${i % 12}/new ${i}.md`, `new ${i}\n`);
      }
      const fs = new NodeFs(w.phoneDir);
      let atOnce = 0;
      let most = 0;
      let answered = false;
      let askedBeforeTheAnswer = 0;
      /** An answer that takes a moment, as on a phone */
      const slow = <A extends unknown[], R>(ask: (...args: A) => Promise<R>): ((...args: A) => Promise<R>) => {
        return async (...args) => {
          most = Math.max(most, ++atOnce);
          askedBeforeTheAnswer += answered ? 0 : 1;
          await new Promise((resolve) => setTimeout(resolve, 1));
          try {
            return await ask(...args);
          } finally {
            atOnce--;
          }
        };
      };
      fs.stat = slow(fs.stat.bind(fs));
      fs.list = slow(fs.list.bind(fs));
      fs.read = slow(fs.read.bind(fs));
      const result = await w.syncPhone({
        fs,
        http: async (request) => {
          const response = await nodeHttp(request);
          await new Promise((resolve) => setTimeout(resolve, 30));
          answered = true;
          return response;
        },
      });
      assert.equal(result.uploaded.length, 30);
      assert.ok(most > 1 && most <= 8, `${most} at once`);
      // The folders were listed and the files looked at before the remote had said where its branch is
      assert.ok(askedBeforeTheAnswer > 60, `${askedBeforeTheAnswer} asked before the answer`);
      w.pullPc();
      assert.equal(w.readPc("dir 3/new 3.md"), "new 3\n");
      assert.equal(server.git(path.basename(w.url), "fsck", "--strict"), "");
    });

    it("asks once for the size and time of a file that it wrote and looked at", async () => {
      const w = setup();
      const inner = new NodeFs(w.phoneDir);
      const stat = inner.stat.bind(inner);
      let asked = 0;
      inner.stat = (file) => {
        asked++;
        return stat(file);
      };
      const fs = new VerifiedFs(inner);
      await fs.write("a.md", new Uint8Array([1, 2, 3]));
      assert.equal(asked, 1);
      assert.equal((await fs.stat("a.md"))?.size, 3);
      assert.equal(asked, 1);
      // Told once: later the file may be another one
      writeFileSync(path.join(w.phoneDir, "a.md"), "longer than before");
      assert.equal((await fs.stat("a.md"))?.size, 18);
      assert.equal(asked, 2);
      // Not what was written before another file was, and not after the file is gone
      await fs.write("a.md", new Uint8Array([1]));
      await fs.write("b.md", new Uint8Array([1, 2]));
      assert.equal((await fs.stat("a.md"))?.size, 1);
      await fs.write("b.md", new Uint8Array([1, 2]));
      await fs.remove("b.md");
      assert.equal(await fs.stat("b.md"), null);
    });

    it("knows a remote that did not move by one file, and reads its folders again when that file is no good", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 12; i++) {
        files[`dir ${i % 6}/note ${i}.md`] = `note ${i}\n`;
      }
      const w = setup(files);
      await w.syncPhone();
      const fs = new NodeFs(w.phoneDir);
      const read = fs.read.bind(fs);
      let objects = 0;
      fs.read = (file) => {
        objects += file.startsWith(".piecemeal/objects/") ? 1 : 0;
        return read(file);
      };
      const quiet = await w.syncPhone({ fs });
      assert.deepEqual([quiet.downloaded, quiet.uploaded, objects], [[], [], 0]);

      // The remote moves: its folders are read, and the next sync is back to the one file
      w.writePc("dir 0/note 0.md", "changed\n");
      w.pushPc();
      const moved = await w.syncPhone({ fs });
      assert.deepEqual(moved.downloaded, ["dir 0/note 0.md"]);
      assert.ok(objects > 0);
      objects = 0;
      await w.syncPhone({ fs });
      assert.equal(objects, 0);

      // The file is cut off, or is of another commit: it counts for nothing
      const flat = path.join(w.phoneDir, ".piecemeal/flat.json");
      writeFileSync(flat, readFileSync(flat, "utf8").slice(0, 40));
      w.removePhone("dir 1/note 1.md");
      const again = await w.syncPhone({ fs });
      assert.deepEqual([again.deletedThere, again.deletedHere, again.downloaded], [["dir 1/note 1.md"], [], []]);
      assert.ok(objects > 0);
    });

    it("takes the word of the app for a file that is as it was, and looks at the disk for any other", async () => {
      const w = setup({ "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" });
      await w.syncPhone();
      for (const file of ["a.md", "b.md", "c.md"]) {
        utimesSync(path.join(w.phoneDir, file), 1_700_000_000, 1_700_000_000);
      }
      await w.syncPhone();
      const fs = new NodeFs(w.phoneDir) as NodeFs & { quickStat?: (file: string) => FileStat | null };
      const stat = fs.stat.bind(fs);
      const looked: string[] = [];
      fs.stat = (file) => {
        looked.push(file);
        return stat(file);
      };
      // What the app has in mind: a and b as they were, and nothing of c
      const inMind = new Map<string, FileStat>();
      for (const file of ["a.md", "b.md"]) {
        const now = statSync(path.join(w.phoneDir, file));
        inMind.set(file, { size: now.size, mtime: Math.floor(now.mtimeMs) });
      }
      fs.quickStat = (file) => inMind.get(file) ?? null;
      const quiet = await w.syncPhone({ fs });
      assert.deepEqual([quiet.uploaded, looked.filter((file) => !file.startsWith(".piecemeal/"))], [[], ["c.md"]]);

      // The app saw b change. It is looked at, read and sent.
      w.writePhone("b.md", "b changed\n");
      const changed = statSync(path.join(w.phoneDir, "b.md"));
      inMind.set("b.md", { size: changed.size, mtime: Math.floor(changed.mtimeMs) });
      looked.length = 0;
      const result = await w.syncPhone({ fs });
      assert.deepEqual(result.uploaded, ["b.md"]);
      assert.ok(looked.includes("b.md") && !looked.includes("a.md"));
      w.pullPc();
      assert.equal(w.readPc("b.md"), "b changed\n");
    });

    it("tells how far it is", async () => {
      const w = setup({ "a.md": "a\n", "b.md": "b\n" });
      await w.syncPhone();
      w.writePc("a.md", "a again\n");
      w.writePc("c.md", "c\n");
      w.pushPc();
      w.writePhone("d.md", "d\n");
      const told: string[] = [];
      await w.syncPhone({ onProgress: (p) => told.push(`${p.step} ${p.done}/${p.total}`) });
      assert.deepEqual(told, ["looking 0/0", "sending 0/1", "taking 0/2", "taking 1/2", "taking 2/2"]);
    });

    it("puts a file that the remote removed where a person can get it back, if there is such a place", async () => {
      const w = setup({ "a.md": "a\n", "b.md": "b\n" });
      await w.syncPhone();
      w.commitThere({ "b.md": null });
      const kept: string[] = [];
      const fs = new NodeFs(w.phoneDir) as NodeFs & { discard?: (file: string) => Promise<void> };
      fs.discard = async (file) => {
        kept.push(file);
        await fs.rename(file, `.trash-${file}`);
      };
      const result = await w.syncPhone({ fs: new VerifiedFs(fs) });
      assert.deepEqual([result.deletedHere, kept, w.readPhone("b.md"), w.readPhone(".trash-b.md")], [["b.md"], ["b.md"], null, "b\n"]);
    });

    it("takes the word of the remote for what a file is, when the vault holds the same content for the first time", async () => {
      const w = setup({ "a.md": "a\n" });
      w.commitThere({ "to a": { link: "a.md" } });
      // A phone that held the files before, from a copy: the link is a file there that holds where it points
      w.writePhone("a.md", "a\n");
      w.writePhone("to a", "a.md");
      const result = await w.syncPhone({ fs: new CaseBlindFs(new NodeFs(w.phoneDir)) });
      assert.deepEqual([result.conflicts, result.uploaded, result.downloaded], [[], [], []]);
      assert.equal(server.git(path.basename(w.url), "ls-tree", "main", "--", "to a").split(/\s/)[0], "120000");
    });
  });

  describe("with branches", () => {
    const repo = (w: { url: string }): string => path.basename(w.url);
    const branches = (w: { url: string }): string[] =>
      server
        .git(repo(w), "for-each-ref", "--format=%(refname:short)", "refs/heads")
        .split("\n")
        .sort();
    const files = (w: { phoneDir: string }): string[] => readdirSync(w.phoneDir).filter((name) => name !== ".piecemeal").sort();

    it("starts a branch that the remote does not have where the last sync left off", async () => {
      const w = setup({ "a.md": "a\n", "b.md": "b\n" });
      await w.syncPhone();
      w.writePhone("draft.md", "a draft\n");
      const result = await w.syncPhone({ branch: "draft" });
      assert.deepEqual([result.uploaded, result.deletedHere, result.downloaded], [["draft.md"], [], []]);
      assert.deepEqual(files(w), ["a.md", "b.md", "draft.md"]);
      assert.deepEqual(branches(w), ["draft", "main"]);
      // The new branch has the history of the one it came from, and that one is as it was
      assert.deepEqual(server.git(repo(w), "log", "--format=%s", "draft").split("\n"), ["from the phone", "first"]);
      assert.deepEqual(server.git(repo(w), "log", "--format=%s", "main").split("\n"), ["first"]);
      assert.equal(server.git(repo(w), "fsck", "--strict"), "");
      const again = await w.syncPhone({ branch: "draft" });
      assert.deepEqual([again.uploaded, again.downloaded, again.deletedHere], [[], [], []]);

      // With nothing to send the branch is made too
      const empty = await w.syncPhone({ branch: "second" });
      assert.deepEqual([empty.uploaded, empty.deletedHere], [[], []]);
      assert.equal(server.git(repo(w), "rev-parse", "second"), server.git(repo(w), "rev-parse", "draft"));
    });

    it("goes over to another branch of the remote, and takes along what was not sent yet", async () => {
      const w = setup({ "a.md": "a\n", "b.md": "b\n" });
      server.git(repo(w), "branch", "old", "main");
      w.commitThere({ "a.md": "a of main\n", "b.md": null, "c.md": "c\n" });
      await w.syncPhone();
      assert.deepEqual(files(w), ["a.md", "c.md"]);
      w.writePhone("mine.md", "mine\n");
      const result = await w.syncPhone({ branch: "old" });
      assert.deepEqual([result.downloaded.sort(), result.deletedHere, result.uploaded], [["a.md", "b.md"], ["c.md"], ["mine.md"]]);
      assert.deepEqual([files(w), w.readPhone("a.md")], [["a.md", "b.md", "mine.md"], "a\n"]);
      assert.deepEqual(server.git(repo(w), "ls-tree", "-r", "--name-only", "old").split("\n"), ["a.md", "b.md", "mine.md"]);
      assert.deepEqual(server.git(repo(w), "ls-tree", "-r", "--name-only", "main").split("\n"), ["a.md", "c.md"]);
      // Without a branch that is asked for, it stays with the one of last time
      const stays = await w.syncPhone();
      assert.deepEqual([stays.downloaded, stays.deletedHere, stays.uploaded], [[], [], []]);
    });

    it("follows a branch that got another name on the remote", async () => {
      const w = setup({ "a.md": "a\n" });
      await w.syncPhone();
      server.git(repo(w), "branch", "-m", "main", "trunk");
      server.git(repo(w), "symbolic-ref", "HEAD", "refs/heads/trunk");
      w.writePhone("b.md", "b\n");
      const result = await w.syncPhone();
      assert.deepEqual([result.uploaded, result.deletedHere, result.downloaded], [["b.md"], [], []]);
      assert.deepEqual(branches(w), ["trunk"]);
      assert.deepEqual(server.git(repo(w), "log", "--format=%s", "trunk").split("\n"), ["from the phone", "first"]);
    });

    it("keeps the vault and sends it anew when the branch is gone from the remote", async () => {
      const w = setup({ "a.md": "a\n", "dir/b.md": "b\n" });
      await w.syncPhone({ branch: "main" });
      // Someone removed the branch. Held against nothing, what was agreed on would say that all was removed there.
      server.git(repo(w), "update-ref", "-d", "refs/heads/main");
      w.writePhone("c.md", "c\n");
      const result = await w.syncPhone({ branch: "main" });
      assert.deepEqual([result.deletedHere, result.downloaded], [[], []]);
      assert.deepEqual(result.uploaded.sort(), ["a.md", "c.md", "dir/b.md"]);
      assert.deepEqual([w.readPhone("a.md"), w.readPhone("dir/b.md"), w.readPhone("c.md")], ["a\n", "b\n", "c\n"]);
      assert.deepEqual(server.git(repo(w), "ls-tree", "-r", "--name-only", "main").split("\n"), ["a.md", "c.md", "dir/b.md"]);
      assert.equal(server.git(repo(w), "fsck", "--strict", "--no-dangling"), "");
      const again = await w.syncPhone({ branch: "main" });
      assert.deepEqual([again.uploaded, again.downloaded, again.deletedHere], [[], [], []]);
    });
  });

  describe("in a vault whose files are not always written", () => {
    it("writes a file again that came out empty", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 12; i++) {
        files[`dir ${i % 3}/note ${i}.md`] = `note ${i}\n`;
      }
      const w = setup(files);
      // Every fifth write is lost, whatever it is: a note, a commit, a folder, what was agreed on
      const flaky = new FlakyFs(new NodeFs(w.phoneDir), (_path, nth) => nth % 5 === 2);
      const fs = new VerifiedFs(flaky);
      const result = await w.syncPhone({ fs });
      assert.equal(result.downloaded.length, 12);
      assert.ok(flaky.lost.length >= 4, `only ${flaky.lost.length} writes were lost`);
      assert.equal(fs.rewritten, flaky.lost.length);
      for (const [file, content] of Object.entries(files)) {
        assert.equal(w.readPhone(file), content);
      }
      w.writePhone("new.md", "new\n");
      w.writePc("dir 0/note 0.md", "changed\n");
      w.pushPc();
      const second = await w.syncPhone({ fs });
      assert.deepEqual([second.downloaded, second.uploaded], [["dir 0/note 0.md"], ["new.md"]]);
      assert.equal(server.git(path.basename(w.url), "fsck", "--strict"), "");
    });

    it("gives up on a file that never gets written", async () => {
      const w = setup({ "a.md": "a\n", "b.md": "b\n" });
      const fs = new VerifiedFs(new FlakyFs(new NodeFs(w.phoneDir), (file) => file === "b.md"));
      const first = await w.syncPhone({ fs });
      // The file that came out empty is gone again, so that it is not taken for a note of the phone
      assert.deepEqual([first.downloaded, first.busy, w.readPhone("a.md"), w.readPhone("b.md")], [["a.md"], ["b.md"], "a\n", null]);
      const still = await w.syncPhone({ fs });
      assert.deepEqual([still.busy, still.deletedThere, still.uploaded], [["b.md"], [], []]);
      // It comes once it can be written, and the remote has kept it all the while
      const result = await w.syncPhone();
      assert.deepEqual([result.downloaded, result.deletedThere, w.readPhone("b.md")], [["b.md"], [], "b\n"]);
      assert.deepEqual(w.pathsThere(), ["a.md", "b.md"]);
    });

    it("asks again for a commit or a folder that it kept and cannot read any more", async () => {
      const w = setup({ "a.md": "a\n", "dir/b.md": "b\n" });
      await w.syncPhone();
      const objects = path.join(w.phoneDir, ".piecemeal/objects");
      const kept = readdirSync(objects).flatMap((dir) => readdirSync(path.join(objects, dir)).map((file) => path.join(objects, dir, file)));
      assert.equal(kept.length, 3);
      // One is empty, one is cut off, one holds another object
      const whole = readFileSync(kept[2]);
      writeFileSync(kept[0], "");
      writeFileSync(kept[1], readFileSync(kept[1]).subarray(0, 10));
      writeFileSync(kept[2], readFileSync(kept[0] === kept[2] ? kept[1] : kept[2]));
      writeFileSync(kept[2], Buffer.from(whole).reverse());
      w.writePhone("c.md", "c\n");
      const result = await w.syncPhone();
      assert.deepEqual([result.downloaded, result.uploaded, result.deletedHere], [[], ["c.md"], []]);
      w.pullPc();
      assert.deepEqual([w.readPc("a.md"), w.readPc("dir/b.md"), w.readPc("c.md")], ["a\n", "b\n", "c\n"]);
      assert.equal(server.git(path.basename(w.url), "fsck", "--strict"), "");
    });
  });

  describe("with links", () => {
    /** What kind of thing the branch has at a path, and what it holds. */
    const there = (w: { url: string }, file: string): [string, string] => [
      server.git(path.basename(w.url), "ls-tree", "main", "--", file).split(/\s/)[0],
      server.git(path.basename(w.url), "cat-file", "blob", `main:${file}`),
    ];

    it("makes a link where the remote has one, and sends a link as one", async () => {
      const w = setup({ "note.md": "note\n" });
      w.commitThere({ "to note": { link: "note.md" }, "dir/up": { link: "../note.md" } });
      const result = await w.syncPhone();
      assert.deepEqual(result.downloaded.sort(), ["dir/up", "note.md", "to note"]);
      assert.equal(readlinkSync(path.join(w.phoneDir, "to note")), "note.md");
      assert.equal(readlinkSync(path.join(w.phoneDir, "dir/up")), "../note.md");
      assert.equal(w.readPhone("dir/up"), "note\n");
      const again = await w.syncPhone();
      assert.deepEqual([again.downloaded, again.uploaded], [[], []]);

      // The phone points a link at a folder, makes a new one, and puts a file where one was
      unlinkSync(path.join(w.phoneDir, "to note"));
      symlinkSync("dir", path.join(w.phoneDir, "to note"));
      symlinkSync("note.md", path.join(w.phoneDir, "new link"));
      unlinkSync(path.join(w.phoneDir, "dir/up"));
      w.writePhone("dir/up", "a file now\n");
      const sent = await w.syncPhone();
      assert.deepEqual(sent.uploaded.sort(), ["dir/up", "new link", "to note"]);
      assert.deepEqual(there(w, "to note"), ["120000", "dir"]);
      assert.deepEqual(there(w, "new link"), ["120000", "note.md"]);
      assert.deepEqual(there(w, "dir/up"), ["100644", "a file now"]);
      // The folder that the link points at was not gone into
      assert.deepEqual(w.pathsThere(), ["dir/up", "new link", "note.md", "to note"]);
      assert.equal(server.git(path.basename(w.url), "fsck", "--strict"), "");

      // The remote makes a file of a link, and a link of a file
      w.commitThere({ "new link": "a file\n", "note.md": { link: "dir/up" } });
      const taken = await w.syncPhone();
      assert.deepEqual(taken.downloaded.sort(), ["new link", "note.md"]);
      assert.equal(lstatSync(path.join(w.phoneDir, "new link")).isFile(), true);
      assert.equal(w.readPhone("new link"), "a file\n");
      assert.equal(readlinkSync(path.join(w.phoneDir, "note.md")), "dir/up");
      const last = await w.syncPhone();
      assert.deepEqual([last.downloaded, last.uploaded], [[], []]);
    });

    it("keeps a link as a file that holds where it points, where links cannot be made", async () => {
      const w = setup({ "note.md": "note\n" });
      w.commitThere({ "to note": { link: "note.md" } });
      // A phone: its files are files, and it has no word for a link
      const phone: Partial<SyncOptions> = { fs: new CaseBlindFs(new NodeFs(w.phoneDir)) };
      const result = await w.syncPhone(phone);
      assert.deepEqual(result.downloaded.sort(), ["note.md", "to note"]);
      assert.equal(lstatSync(path.join(w.phoneDir, "to note")).isFile(), true);
      assert.equal(w.readPhone("to note"), "note.md");
      const again = await w.syncPhone(phone);
      assert.deepEqual([again.downloaded, again.uploaded], [[], []]);

      // Written anew there, it is still a link on the remote
      w.writePhone("to note", "other.md");
      w.writePhone("plain.md", "plain\n");
      const sent = await w.syncPhone(phone);
      assert.deepEqual(sent.uploaded.sort(), ["plain.md", "to note"]);
      assert.deepEqual(there(w, "to note"), ["120000", "other.md"]);
      assert.deepEqual(there(w, "plain.md"), ["100644", "plain"]);
      assert.equal(server.git(path.basename(w.url), "fsck", "--strict"), "");
    });

    it("takes a link that an earlier version left out of the vault", async () => {
      const w = setup({ "note.md": "note\n" });
      w.commitThere({ "to note": { link: "note.md" } });
      await w.syncPhone();
      // As an earlier version left it: tracked, and not in the vault
      unlinkSync(path.join(w.phoneDir, "to note"));
      const statePath = path.join(w.phoneDir, ".piecemeal/state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { absent: Record<string, true>; stat: Record<string, unknown> };
      state.absent["to note"] = true;
      delete state.stat["to note"];
      writeFileSync(statePath, JSON.stringify(state));
      const result = await w.syncPhone();
      assert.deepEqual([result.downloaded, result.deletedThere], [["to note"], []]);
      assert.equal(readlinkSync(path.join(w.phoneDir, "to note")), "note.md");
    });
  });

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
