import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { NodeFs } from "../../tests/node.ts";
import { encode } from "./bytes.ts";
import { githubChangedAt, githubLargeBlob, parseGitHub } from "./github.ts";
import { type Http } from "./http.ts";
import { objectId } from "./objects.ts";

describe("githubLargeBlob", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "piecemeal-github-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const content = new Uint8Array(50_000).map((_, i) => (i * 31) % 251);
  /** A host that answers ranges of bytes of `served`, as raw.githubusercontent.com does */
  const host =
    (served: Uint8Array, seen: string[] = []): Http =>
    async (request) => {
      seen.push(request.url);
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers["Range"] ?? "");
      assert.ok(range !== null);
      return { status: 206, headers: {}, body: served.subarray(Number(range[1]), Number(range[2]) + 1) };
    };
  const where = parseGitHub("https://github.com/someone/vault.git")!;

  it("puts the pieces together to the file that the id names", async () => {
    const oid = await objectId({ type: "blob", data: content });
    const seen: string[] = [];
    const get = githubLargeBlob(host(content, seen), new NodeFs(dir), where, undefined, 16_000);
    const ok = await get({ oid, size: content.length, commit: "c0ffee", path: "folder/a file.bin" }, "to/a file.bin");
    assert.equal(ok, true);
    assert.deepEqual(new Uint8Array(readFileSync(path.join(dir, "to/a file.bin"))), content);
    assert.equal(seen.length, 4);
    assert.equal(seen[0], "https://raw.githubusercontent.com/someone/vault/c0ffee/folder/a%20file.bin");
  });

  it("does not put a file into the vault whose pieces add up to another id", async () => {
    const oid = await objectId({ type: "blob", data: content });
    const other = content.slice();
    other[40_000] ^= 1;
    const get = githubLargeBlob(host(other), new NodeFs(dir), where, undefined, 16_000);
    const ok = await get({ oid, size: content.length, commit: "c0ffee", path: "b.bin" }, "to/b.bin");
    assert.equal(ok, false);
    assert.equal(await new NodeFs(dir).stat("to/b.bin"), null);
    assert.equal(await new NodeFs(dir).stat("to/b.bin.piecemeal-part"), null);
  });
});

describe("githubChangedAt", () => {
  const where = parseGitHub("https://github.com/someone/vault.git")!;
  /** A host that answers with `body` as the commits API of GitHub does */
  const host =
    (status: number, body: string, seen: { url: string; headers: Record<string, string> }[] = []): Http =>
    (request) => {
      seen.push({ url: request.url, headers: request.headers });
      return Promise.resolve({ status, headers: {}, body: encode(body) });
    };

  it("asks for the newest commit that changed the path, back from a commit, and reads the time of its committer", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const answer = JSON.stringify([{ sha: "abc", commit: { author: { date: "2026-03-01T09:00:00Z" }, committer: { date: "2026-03-01T10:00:00Z" } } }]);
    const when = await githubChangedAt(host(200, answer, seen), where, "secret")("폴더/a note & more.md", "c0ffee");
    assert.equal(when, Date.parse("2026-03-01T10:00:00Z"));
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0].url,
      `https://api.github.com/repos/someone/vault/commits?path=${encodeURIComponent("폴더/a note & more.md")}&sha=c0ffee&per_page=1`,
    );
    assert.equal(seen[0].headers["Authorization"], "Bearer secret");
  });

  it("tells no time where GitHub does not answer with a commit", async () => {
    assert.equal(await githubChangedAt(host(200, "[]"), where, undefined)("a.md", "c0ffee"), null);
    assert.equal(await githubChangedAt(host(403, '{"message":"API rate limit exceeded"}'), where, undefined)("a.md", "c0ffee"), null);
    assert.equal(await githubChangedAt(host(200, "<html>"), where, undefined)("a.md", "c0ffee"), null);
    assert.equal(await githubChangedAt(host(200, '{"message":"no list"}'), where, undefined)("a.md", "c0ffee"), null);
    assert.equal(await githubChangedAt(host(200, '[{"commit":{"committer":{"date":"then"}}}]'), where, undefined)("a.md", "c0ffee"), null);
  });
});
