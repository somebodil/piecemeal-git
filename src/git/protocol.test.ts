import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { nodeHttp } from "../platform/node.ts";
import { TestServer } from "../testing/server.ts";
import { encode } from "./bytes.ts";
import { objectId, parseCommit, parseTree, serializeCommit, serializeTree, signature } from "./objects.ts";
import { parsePack, writePack } from "./pack.ts";
import { fetchPack, lsRefs, push, RejectedError, ZERO_OID } from "./protocol.ts";

describe("the git protocol against a real server", () => {
  const server = new TestServer();
  let url = "";

  before(async () => {
    await server.start();
    url = server.createRepo("one");
    server.cloneWithGit("one", "seed");
    // Enough similar text for git to store some files as deltas of others
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} of a note`).join("\n");
    writeFileSync(path.join(server.root, "seed", "a.md"), text);
    writeFileSync(path.join(server.root, "seed", "b.md"), `${text}\nand one more line`);
    writeFileSync(path.join(server.root, "seed", "한글 노트.md"), "한글");
    server.git("seed", "add", "-A");
    server.git("seed", "commit", "-q", "-m", "first");
    writeFileSync(path.join(server.root, "seed", "a.md"), `${text}\nchanged`);
    server.git("seed", "commit", "-q", "-am", "second");
    server.git("seed", "push", "-q", "origin", "main");
    server.git("one.git", "repack", "-a", "-d", "-q", "--depth=10", "--window=10");
  });

  after(async () => {
    await server.stop();
  });

  it("lists the branches and the one that HEAD names", async () => {
    const refs = await lsRefs(nodeHttp, { url });
    assert.equal(refs.head, "refs/heads/main");
    assert.equal(refs.heads.get("refs/heads/main"), server.git("seed", "rev-parse", "HEAD"));
  });

  it("gets a commit and its folders without the contents of the files", async () => {
    const tip = server.git("seed", "rev-parse", "HEAD");
    const result = await fetchPack(nodeHttp, { url }, { wants: [tip], depth: 1, filter: "blob:none" });
    const objects = await parsePack(result.pack);
    assert.deepEqual(objects.map((o) => o.type).sort(), ["commit", "tree"]);
    assert.deepEqual(result.shallow, [tip]);
    const commit = parseCommit(objects.find((o) => o.type === "commit")!.data);
    const tree = parseTree(objects.find((o) => o.oid === commit.tree)!.data);
    assert.deepEqual(tree.map((e) => e.name).sort(), ["a.md", "b.md", "한글 노트.md"]);
  });

  it("gets chosen files by their ids, and undoes the deltas between them", async () => {
    const ids = ["a.md", "b.md"].map((name) => server.git("seed", "rev-parse", `HEAD:${name}`));
    const result = await fetchPack(nodeHttp, { url }, { wants: ids });
    const objects = await parsePack(result.pack);
    assert.deepEqual(objects.map((o) => o.oid).sort(), [...ids].sort());
    for (const object of objects) {
      assert.equal(await objectId(object), object.oid);
    }
  });

  it("reads a whole clone, deltas and all, to the same objects as git", async () => {
    const tip = server.git("seed", "rev-parse", "HEAD");
    const result = await fetchPack(nodeHttp, { url }, { wants: [tip] });
    const objects = await parsePack(result.pack);
    const expected = server.git("one.git", "cat-file", "--batch-all-objects", "--batch-check=%(objectname)");
    assert.deepEqual(objects.map((o) => o.oid).sort(), expected.split("\n").sort());
  });

  it("pushes a commit that git accepts, and is refused when the branch has moved", async () => {
    const tip = server.git("seed", "rev-parse", "HEAD");
    const base = await parsePack((await fetchPack(nodeHttp, { url }, { wants: [tip], depth: 1, filter: "blob:none" })).pack);
    const old = parseCommit(base.find((o) => o.type === "commit")!.data);
    const entries = parseTree(base.find((o) => o.oid === old.tree)!.data);

    const blob = { type: "blob" as const, data: encode("written on a phone\n") };
    const sub = { type: "tree" as const, data: serializeTree([{ mode: "100644", name: "new.md", oid: await objectId(blob) }]) };
    const root = {
      type: "tree" as const,
      data: serializeTree([...entries, { mode: "40000", name: "폴더", oid: await objectId(sub) }]),
    };
    const who = signature("Phone", "phone@example.com", new Date());
    const commit = {
      type: "commit" as const,
      data: serializeCommit({ tree: await objectId(root), parents: [tip], author: who, committer: who, message: "from the phone\n" }),
    };
    const newOid = await objectId(commit);
    const pack = await writePack([blob, sub, root, commit]);

    await push(nodeHttp, { url }, { ref: "refs/heads/main", oldOid: tip, newOid, pack });
    assert.equal(server.git("one.git", "rev-parse", "main"), newOid);
    assert.equal(server.git("one.git", "fsck", "--strict"), "");
    assert.equal(server.git("one.git", "show", "main:폴더/new.md"), "written on a phone");

    await assert.rejects(
      push(nodeHttp, { url }, { ref: "refs/heads/main", oldOid: tip, newOid, pack }),
      RejectedError,
    );
    await assert.rejects(
      push(nodeHttp, { url }, { ref: "refs/heads/other", oldOid: tip, newOid, pack }),
      RejectedError,
    );
    await push(nodeHttp, { url }, { ref: "refs/heads/other", oldOid: ZERO_OID, newOid, pack });
    assert.equal(server.git("one.git", "rev-parse", "other"), newOid);
  });
});
