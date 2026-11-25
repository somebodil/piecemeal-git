import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { nodeHttp, NodeFs } from "../../tests/node.ts";
import { TestServer } from "../../tests/server.ts";
import { History } from "./history.ts";
import { type Http } from "./http.ts";
import { momentOf } from "./objects.ts";
import { parsePack } from "./pack.ts";
import { fetchPack } from "./protocol.ts";
import { ObjectStore } from "./store.ts";

describe("when a file was last changed on the remote", () => {
  const server = new TestServer();
  let counter = 0;

  before(async () => {
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  /** A commit for `git fast-import`: the files that it changes, the second at which it was made, and what it stands on. */
  interface Made {
    mark: number;
    at: number;
    files: Record<string, string>;
    parents?: number[];
  }

  /**
   * A repository with these commits, the last of them as its branch, and a
   * device that has that last commit and its folders, as after a sync.
   */
  async function setup(commits: Made[]) {
    const name = `history${++counter}`;
    const url = server.createRepo(name);
    let stream = "";
    for (const commit of commits) {
      const message = `commit ${commit.mark}`;
      stream += `commit refs/heads/main\nmark :${commit.mark}\ncommitter Test <test@example.com> ${commit.at} +0000\ndata ${message.length}\n${message}\n`;
      const [first, ...others] = commit.parents ?? [];
      if (first !== undefined) {
        stream += `from :${first}\n`;
      }
      for (const other of others) {
        stream += `merge :${other}\n`;
      }
      for (const [file, content] of Object.entries(commit.files)) {
        stream += `M 100644 inline ${file}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
      }
    }
    server.gitWith(stream, `${name}.git`, "fast-import", "--quiet");
    const tip = server.git(`${name}.git`, "rev-parse", "main");
    const store = new ObjectStore(new NodeFs(mkdtempSync(path.join(server.root, `${name}-device-`))), ".piecemeal");
    const fetched = await fetchPack(nodeHttp, { url }, { wants: [tip], depth: 1, filter: "blob:none" });
    for (const object of await parsePack(fetched.pack)) {
      await store.write(object, object.oid);
    }
    const requests: number[] = [];
    const http: Http = async (request) => {
      const response = await nodeHttp(request);
      requests.push(response.body.length);
      return response;
    };
    /** The time of the commit that `git log` shows first for a path, in milliseconds, or null if it shows none. */
    const asGit = (file: string): number | null => {
      const seconds = server.git(`${name}.git`, "log", "-1", "--format=%ct", "main", "--", file);
      return seconds === "" ? null : Number(seconds) * 1000;
    };
    return { history: new History(http, { url }, store, tip), requests, store, tip, url, asGit };
  }

  /** So many commits one upon the other, a second apart from `at` on. Each changes a file of its own. */
  const chain = (from: number, count: number, at: number): Made[] =>
    Array.from({ length: count }, (_, i) => ({ mark: from + i, at: at + i, files: { [`other/${from + i}.md`]: `${i}\n` }, parents: [from + i - 1] }));

  it("reads the moment that a commit names", () => {
    assert.equal(momentOf("Some One <one@example.com> 1795000000 +0900"), 1_795_000_000_000);
    assert.equal(momentOf("Some One <one@example.com>"), null);
  });

  it("finds the newest commit that changed a file, with one request for all files", async () => {
    const w = await setup([
      { mark: 1, at: 1000, files: { "a.md": "a\n", "b.md": "b\n", "dir/deep/c.md": "c\n", "dir/d.md": "d\n" } },
      { mark: 2, at: 2000, files: { "a.md": "a, changed\n" }, parents: [1] },
      { mark: 3, at: 3000, files: { "dir/deep/c.md": "c, changed\n" }, parents: [2] },
      { mark: 4, at: 4000, files: { "new.md": "new\n" }, parents: [3] },
      // Changed back to what it held before: that is a change all the same
      { mark: 5, at: 5000, files: { "b.md": "b, changed\n" }, parents: [4] },
      { mark: 6, at: 6000, files: { "b.md": "b\n" }, parents: [5] },
    ]);
    assert.equal(await w.history.changedAt("a.md"), 2_000_000);
    assert.equal(await w.history.changedAt("dir/deep/c.md"), 3_000_000);
    assert.equal(await w.history.changedAt("dir/d.md"), 1_000_000);
    assert.equal(await w.history.changedAt("new.md"), 4_000_000);
    assert.equal(await w.history.changedAt("b.md"), 6_000_000);
    assert.equal(await w.history.changedAt("not there.md"), null);
    assert.equal(await w.history.changedAt("dir/deep"), 3_000_000);
    assert.equal(w.requests.length, 1);
    for (const file of ["a.md", "b.md", "dir/deep/c.md", "dir/d.md", "new.md", "not there.md"]) {
      assert.equal(await w.history.changedAt(file), w.asGit(file), file);
    }
    // Commits and folders came, and no file: a few hundred bytes for each commit
    assert.ok(w.requests[0] < 4000, `a response of ${w.requests[0]} bytes`);
  });

  it("asks once also for a file that the newest commit changed", async () => {
    const w = await setup([
      { mark: 1, at: 1000, files: { "a.md": "a\n" } },
      { mark: 2, at: 2000, files: { "a.md": "a, changed\n" }, parents: [1] },
    ]);
    // Its parent is not here, and has to be asked for to know that
    assert.equal(await w.history.changedAt("a.md"), 2_000_000);
    assert.equal(w.requests.length, 1);
  });

  it("follows the side of a merge that the file came from", async () => {
    const w = await setup([
      { mark: 1, at: 1000, files: { "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" } },
      { mark: 2, at: 2000, files: { "a.md": "a from the side\n", "c.md": "c from the side\n" }, parents: [1] },
      { mark: 3, at: 3000, files: { "b.md": "b from the trunk\n", "c.md": "c from the trunk\n" }, parents: [1] },
      // The merge takes each file from the side that changed it, and makes a text of its own of the one that both changed
      { mark: 4, at: 4000, files: { "a.md": "a from the side\n", "c.md": "c from both\n" }, parents: [3, 2] },
      { mark: 5, at: 5000, files: { "other.md": "other\n" }, parents: [4] },
    ]);
    assert.equal(await w.history.changedAt("a.md"), 2_000_000);
    assert.equal(await w.history.changedAt("b.md"), 3_000_000);
    assert.equal(await w.history.changedAt("c.md"), 4_000_000);
    for (const file of ["a.md", "b.md", "c.md", "other.md"]) {
      assert.equal(await w.history.changedAt(file), w.asGit(file), file);
    }
  });

  it("asks for more commits when the change is further back, and gives up after three requests", async () => {
    const w = await setup([
      { mark: 1, at: 1000, files: { "old.md": "old\n", "older.md": "older\n" } },
      { mark: 2, at: 2000, files: { "older.md": "older, changed\n" }, parents: [1] },
      ...chain(3, 230, 3000),
      { mark: 233, at: 9000, files: { "old.md": "old, changed\n" }, parents: [232] },
      ...chain(234, 40, 10_000),
      { mark: 274, at: 20_000, files: { "near.md": "near\n" }, parents: [273] },
      ...chain(275, 5, 30_000),
    ]);
    assert.equal(await w.history.changedAt("near.md"), 20_000_000);
    assert.equal(w.requests.length, 1);
    assert.equal(await w.history.changedAt("old.md"), 9_000_000);
    assert.equal(w.requests.length, 2);
    // 278 commits back, which is more than is asked for
    assert.equal(await w.history.changedAt("older.md"), null);
    assert.equal(w.requests.length, 3);
    assert.equal(await w.history.changedAt("older.md"), null);
    assert.equal(w.requests.length, 3);
    assert.ok(Math.max(...w.requests) < 100_000, `a response of ${Math.max(...w.requests)} bytes`);
    // What was asked for was not written to the device
    assert.equal(await w.store.read(server.git(path.basename(w.url), "rev-parse", "main~1")), null);
  });

  it("asks once only where the history is no line, so that not very many commits come", async () => {
    const w = await setup([
      { mark: 1, at: 1000, files: { "old.md": "old\n", "a.md": "a\n" } },
      { mark: 2, at: 2000, files: { "old.md": "old, changed\n" }, parents: [1] },
      ...chain(3, 20, 3000),
      { mark: 23, at: 4000, files: { "side.md": "side\n" }, parents: [22] },
      { mark: 24, at: 5000, files: { "trunk.md": "trunk\n" }, parents: [22] },
      { mark: 25, at: 6000, files: { "a.md": "a, changed\n", "side.md": "side\n" }, parents: [24, 23] },
      ...chain(26, 3, 7000),
    ]);
    assert.equal(await w.history.changedAt("a.md"), 6_000_000);
    assert.equal(await w.history.changedAt("side.md"), 4_000_000);
    // 26 commits back, behind a commit with two parents
    assert.equal(await w.history.changedAt("old.md"), null);
    assert.equal(w.requests.length, 1);
  });

  it("knows no time, and asks nothing, where the newest commit is not on the device", async () => {
    const w = await setup([
      { mark: 1, at: 1000, files: { "a.md": "a\n" } },
      { mark: 2, at: 2000, files: { "b.md": "b\n" }, parents: [1] },
    ]);
    const empty = new ObjectStore(new NodeFs(mkdtempSync(path.join(server.root, "empty-device-"))), ".piecemeal");
    assert.equal(await new History(nodeHttp, { url: w.url }, empty, w.tip).changedAt("a.md"), null);
    assert.equal(w.requests.length, 0);
  });

  it("tells what a file held before its newest change, as far as the commits that came tell, and asks nothing more for it", async () => {
    const w = await setup([
      { mark: 1, at: 1000, files: { "a.md": "one\n", "b.md": "b\n", "dir/c.md": "c one\n" } },
      { mark: 2, at: 2000, files: { "a.md": "two\n" }, parents: [1] },
      { mark: 3, at: 3000, files: { "dir/c.md": "c two\n" }, parents: [2] },
      { mark: 4, at: 4000, files: { "a.md": "three\n" }, parents: [3] },
      // Back to what it held at first: that is what it holds now, and not what it held before
      { mark: 5, at: 5000, files: { "a.md": "one\n" }, parents: [4] },
      { mark: 6, at: 6000, files: { "other.md": "other\n" }, parents: [5] },
    ]);
    const idOf = (commit: string, file: string): string => server.git(path.basename(w.url), "rev-parse", `${commit}:${file}`);
    const a = await w.history.lastChange("a.md");
    assert.equal(a?.at, 5_000_000);
    assert.deepEqual([...(a?.before ?? [])].sort(), [idOf("main~2", "a.md"), idOf("main~4", "a.md")].sort());
    const c = await w.history.lastChange("dir/c.md");
    assert.deepEqual([c?.at, c?.before], [3_000_000, [idOf("main~5", "dir/c.md")]]);
    // A file that its first commit made held nothing before
    assert.deepEqual(await w.history.lastChange("other.md"), { at: 6_000_000, before: [] });
    assert.deepEqual((await w.history.lastChange("b.md"))?.before, []);
    assert.equal(w.requests.length, 1);
  });

  it("keeps no more in mind than a few megabytes, however little came, and asks no further where more would not fit", async () => {
    /** A folder of so many notes, and three hundred commits that each change one of them. */
    const line = (notes: number): Made[] => {
      const all: Record<string, string> = { "old.md": "old\n" };
      for (let i = 0; i < notes; i++) {
        all[`notes/note number ${i} with a longer name.md`] = `n${i}\n`;
      }
      const commits: Made[] = [{ mark: 1, at: 1000, files: all }];
      for (let i = 0; i < 300; i++) {
        commits.push({ mark: i + 2, at: 2000 + i, files: { [`notes/note number ${(i * 7) % notes} with a longer name.md`]: `changed ${i}\n` }, parents: [i + 1] });
      }
      return commits;
    };
    const MB = 1024 * 1024;

    // Two thousand notes: the folder is some 140 kB each time it is read, and comes as a few bytes
    const w = await setup(line(2000));
    assert.equal(await w.history.changedAt(`notes/note number ${(299 * 7) % 2000} with a longer name.md`), 2_299_000);
    assert.equal(await w.history.changedAt(`notes/note number ${(290 * 7) % 2000} with a longer name.md`), 2_290_000);
    // Three hundred commits back: sixty-four commits would hold four times as much, so they are not asked for
    assert.equal(await w.history.changedAt("old.md"), null);
    assert.equal(w.requests.length, 1);
    assert.ok(Math.max(...w.requests) < 100_000, `a response of ${Math.max(...w.requests)} bytes`);
    const held = w.history.held();
    assert.ok(held.bytes > 1 * MB && held.bytes <= 4 * MB, `${held.bytes} bytes kept in mind`);
    assert.ok(held.objects <= 64, `${held.objects} objects kept in mind`);

    // Eight thousand notes: sixteen commits hold more than fits already. None of it is kept, and no time is known.
    const v = await setup(line(8000));
    assert.equal(await v.history.changedAt(`notes/note number ${(299 * 7) % 8000} with a longer name.md`), null);
    assert.equal(await v.history.changedAt("old.md"), null);
    assert.equal(v.requests.length, 1);
    // What came is a fraction of what it would be once it is read
    assert.ok(Math.max(...v.requests) < 1 * MB, `a response of ${Math.max(...v.requests)} bytes`);
    assert.deepEqual(v.history.held(), { objects: 0, bytes: 0 });
  });

  it("gives what git log gives, or nothing, on histories that are made at random", async () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const files = ["a.md", "d/b.md", "d/e/c.md", "f.md"];
    let same = 0;
    const wrong: string[] = [];
    for (let round = 0; round < 40; round++) {
      // What each commit holds, by its mark
      const trees: Map<string, string>[] = [new Map<string, string>()];
      const commits: Made[] = [];
      let content = 0;
      const count = 4 + rnd(14);
      for (let mark = 1; mark <= count; mark++) {
        if (mark === 1) {
          trees[1] = new Map(files.map((file) => [file, `c${content++}\n`]));
          commits.push({ mark, at: 1000 + rnd(100_000), files: Object.fromEntries(trees[1]) });
          continue;
        }
        const first = mark - 1 - (rnd(4) === 0 ? rnd(Math.min(3, mark - 1)) : 0);
        let second = mark > 3 && rnd(3) === 0 ? 1 + rnd(mark - 1) : 0;
        if (second === first) {
          second = 0;
        }
        const tree = new Map(trees[first]);
        const changed: Record<string, string> = {};
        for (const file of files) {
          const roll = rnd(second !== 0 ? 6 : 8);
          let now = tree.get(file)!;
          if (second !== 0 && roll < 3) {
            // As the second parent has it
            now = trees[second].get(file)!;
          } else if (roll === 3) {
            now = `c${content++}\n`;
          } else if (roll === 5 && rnd(2) === 0) {
            // What an earlier commit held
            now = trees[1 + rnd(mark - 1)].get(file)!;
          }
          if (now !== tree.get(file)) {
            tree.set(file, now);
            changed[file] = now;
          }
        }
        trees[mark] = tree;
        commits.push({ mark, at: 1000 + rnd(100_000), files: changed, parents: second === 0 ? [first] : [first, second] });
      }
      const w = await setup(commits);
      const repo = path.basename(w.url);
      for (const file of files) {
        const ours = await w.history.lastChange(file);
        if (ours === null) {
          // Not known is never wrong: both versions are kept then
          continue;
        }
        if (ours.at !== w.asGit(file)) {
          wrong.push(`round ${round} ${file}: ${ours.at}, and git says ${w.asGit(file)}`);
          continue;
        }
        // Every id that is told is one that the file held in a commit of the branch, and not what it holds now
        const versions = new Set(server.git(repo, "rev-list", "main").split("\n").map((commit) => server.git(repo, "rev-parse", `${commit}:${file}`)));
        const now = server.git(repo, "rev-parse", `main:${file}`);
        if (ours.before.some((oid) => !versions.has(oid) || oid === now)) {
          wrong.push(`round ${round} ${file}: an id that the file never held`);
          continue;
        }
        same++;
      }
    }
    assert.deepEqual(wrong, []);
    assert.ok(same > 100, `${same} times were told`);
  });

  it("knows no time, and does not fail, whatever goes wrong with the asking", async () => {
    const commits: Made[] = [
      { mark: 1, at: 1000, files: { "a.md": "a\n" } },
      { mark: 2, at: 2000, files: { "b.md": "b\n" }, parents: [1] },
    ];
    const answers: Http[] = [
      // No network
      () => Promise.reject(new Error("the network is gone")),
      // A page of a proxy, and not what git sends
      () => Promise.resolve({ status: 200, headers: {}, body: Buffer.from("<html>sign in</html>") }),
      () => Promise.resolve({ status: 502, headers: {}, body: new Uint8Array(0) }),
    ];
    for (const answer of answers) {
      const w = await setup(commits);
      const said: string[] = [];
      let asked = 0;
      const history = new History(
        (request) => {
          asked++;
          return answer(request);
        },
        { url: w.url },
        w.store,
        w.tip,
        (message) => said.push(message),
      );
      assert.equal(await history.changedAt("a.md"), null);
      assert.equal(await history.lastChange("a.md"), null);
      // Asked once, and not again for the next file
      assert.equal(asked, 1);
      assert.equal(said.length, 1);
    }
    // A commit on the device that is not what it should be
    const w = await setup(commits);
    const broken = { read: () => Promise.reject(new Error("the disk does not answer")) } as unknown as ObjectStore;
    assert.equal(await new History(nodeHttp, { url: w.url }, broken, w.tip).lastChange("a.md"), null);
  });

  it("knows no time where the server does not answer", async () => {
    const w = await setup([
      { mark: 1, at: 1000, files: { "a.md": "a\n" } },
      { mark: 2, at: 2000, files: { "b.md": "b\n" }, parents: [1] },
    ]);
    server.git(path.basename(w.url), "config", "uploadpack.allowFilter", "false");
    assert.equal(await w.history.changedAt("a.md"), null);
    assert.equal(await w.history.changedAt("a.md"), null);
    assert.equal(w.requests.length, 1);
  });
});
