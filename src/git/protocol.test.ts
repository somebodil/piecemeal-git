import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { nodeHttp } from "../../tests/node.ts";
import { TestServer } from "../../tests/server.ts";
import { concat, encode } from "./bytes.ts";
import { FLUSH, pkt } from "./pktline.ts";
import { objectId, parseCommit, parseTree, serializeCommit, serializeTree, signature } from "./objects.ts";
import { parsePack, writePack } from "./pack.ts";
import { capabilities, fetchPack, lsRefs, objectSizes, push, pushReport, RejectedError, remoteOf, ZERO_OID } from "./protocol.ts";

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
    // What the server has to say about it comes with what it reports
    await assert.rejects(push(nodeHttp, { url }, { ref: "refs/heads/main", oldOid: tip, newOid, pack }), (error: Error) => {
      assert.match(error.message, /^push: the server keeps the branch as it is \(.+\)\. The server says: .*cannot lock ref 'refs\/heads\/main'/);
      return true;
    });
    await assert.rejects(
      push(nodeHttp, { url }, { ref: "refs/heads/other", oldOid: tip, newOid, pack }),
      RejectedError,
    );
    await push(nodeHttp, { url }, { ref: "refs/heads/other", oldOid: ZERO_OID, newOid, pack });
    assert.equal(server.git("one.git", "rev-parse", "other"), newOid);
  });

  it("takes the answer to a push apart, with and without what the server says beside it", () => {
    const line = (text: string): Uint8Array => pkt(text);
    const band = (n: number, data: Uint8Array | string): Uint8Array => pkt(concat([new Uint8Array([n]), typeof data === "string" ? encode(data) : data]));
    // A server that sends the report alone
    const plain = concat([line("unpack ok\n"), line("ng refs/heads/main failed\n"), FLUSH]);
    assert.deepEqual(pushReport(plain), { report: plain, said: "" });
    // Side by side: the report in band 1, cut where the server likes, and what it says in band 2
    const report = concat([line("unpack ok\n"), line("ng refs/heads/main failed\n"), FLUSH]);
    const both = concat([
      band(2, "error: GH013: Repository rule violations found for refs/heads/main.\n"),
      band(1, report.subarray(0, 9)),
      band(2, "\rReview all repository rules at the page of the repository\n\n"),
      band(1, report.subarray(9)),
      FLUSH,
    ]);
    const read = pushReport(both);
    assert.deepEqual(read.report, report);
    assert.equal(read.said, "error: GH013: Repository rule violations found for refs/heads/main. Review all repository rules at the page of the repository");
    assert.deepEqual(pushReport(new Uint8Array(0)), { report: new Uint8Array(0), said: "" });
  });

  it("reads what the server can do, and the sizes of objects where it tells them", async () => {
    assert.equal((await capabilities(nodeHttp, { url })).get("fetch")?.includes("filter"), true);
    assert.equal((await capabilities(nodeHttp, { url })).has("object-info"), false);
    server.git("one.git", "config", "transfer.advertiseObjectInfo", "true");
    assert.equal((await capabilities(nodeHttp, { url })).has("object-info"), true);
    const blobs = server
      .git("one.git", "ls-tree", "-r", "-l", "main")
      .split("\n")
      .map((line) => /^\d+ blob ([0-9a-f]{40}) +(\d+)\t/.exec(line)!);
    const sizes = await objectSizes(nodeHttp, { url }, [...blobs.map((match) => match[1]), "1".repeat(40)]);
    assert.deepEqual([...sizes].sort(), blobs.map((match) => [match[1], Number(match[2])]).sort());
  });
});

describe("the address of a repository", () => {
  it("is taken as it is when it names nobody", () => {
    assert.deepEqual(remoteOf("https://github.com/you/vault.git", "t"), { url: "https://github.com/you/vault.git", token: "t" });
    assert.deepEqual(remoteOf("not an address", "t"), { url: "not an address", token: "t" });
  });

  it("gives the name that goes with the token, and never keeps a password", () => {
    assert.deepEqual(remoteOf("https://someone@host.example/you/vault.git", "t"), {
      url: "https://host.example/you/vault.git",
      token: "t",
      username: "someone",
    });
    assert.deepEqual(remoteOf("http://some%20one:pass%40word@host.example:3000/vault.git"), {
      url: "http://host.example:3000/vault.git",
      token: "pass@word",
      username: "some one",
    });
    assert.deepEqual(remoteOf("https://someone:password@host.example/vault.git", "t").token, "t");
  });
});
