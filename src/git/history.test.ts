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
