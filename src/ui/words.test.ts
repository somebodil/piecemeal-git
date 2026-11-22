import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RemoteError } from "../git/protocol.ts";
import { type Plan } from "../git/sync.ts";
import { ago, explain, files, httpsAddress, list, progressText, worthAsking } from "./words.ts";

describe("the words of the plugin", () => {
  it("says how long ago a sync was", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    const minutes = (n: number): number => now - n * 60_000;
    assert.deepEqual(
      [minutes(0.5), minutes(1), minutes(59), minutes(60), minutes(23 * 60), minutes(24 * 60), minutes(72 * 60)].map((then) => ago(then, now)),
      ["just now", "1 minute ago", "59 minutes ago", "1 hour ago", "23 hours ago", "yesterday", "3 days ago"],
    );
  });

  it("counts files, and names a few of many", () => {
    assert.deepEqual([files(1), files(12)], ["1 file", "12 files"]);
    assert.equal(list(["a", "b", "c"], 2), "a, b and 1 more");
    assert.equal(progressText({ step: "taking", done: 3, total: 40 }), "Syncing… taking 40 files, 3 done");
    assert.equal(progressText({ step: "looking", done: 0, total: 0 }), "Syncing… looking at the vault and the repository");
  });

  it("says what to do about a sync that failed, where that is known", () => {
    assert.match(explain(new RemoteError("fetch: the server wants a token (401)", 401)), /Give one in the settings/);
    assert.match(explain(new RemoteError("fetch: the server refuses the token (403)", 403)), /Give a new one in the settings/);
    assert.match(explain(new RemoteError("fetch: no such repository", 404)), /Look at the address and the token/);
    assert.match(explain(new Error("Request Failed. ConnectException Failed to connect to /10.0.2.2:8417")), /^The server could not be reached/);
    assert.match(explain(new Error("net::ERR_NAME_NOT_RESOLVED")), /^The server could not be reached/);
    assert.equal(explain(new Error("pack: the checksum does not match")), "pack: the checksum does not match");
  });

  it("takes the address that a host shows for SSH for the one over HTTPS", () => {
    assert.equal(httpsAddress(" git@github.com:you/vault.git "), "https://github.com/you/vault.git");
    assert.equal(httpsAddress("ssh://git@host.example/you/vault.git"), "https://host.example/you/vault.git");
    assert.equal(httpsAddress("https://github.com/you/vault.git"), "https://github.com/you/vault.git");
    assert.equal(httpsAddress("http://name@10.0.0.2:8765/vault.git"), "http://name@10.0.0.2:8765/vault.git");
  });

  it("asks before a first sync of two sides that both hold files, and before many files go", () => {
    const plan = (over: Partial<Plan>): Plan => ({ first: false, tracked: 100, take: 0, send: 0, removeHere: [], removeThere: [], bothChanged: [], ...over });
    const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `note ${i}.md`);
    assert.equal(worthAsking(plan({ first: true, take: 300 })), false);
    assert.equal(worthAsking(plan({ first: true, send: 300 })), false);
    assert.equal(worthAsking(plan({ first: true, take: 300, send: 2 })), true);
    assert.equal(worthAsking(plan({ take: 50, send: 50, removeHere: paths(9), removeThere: paths(24) })), false);
    assert.equal(worthAsking(plan({ removeThere: paths(25) })), true);
    assert.equal(worthAsking(plan({ removeHere: paths(30) })), true);
    assert.equal(worthAsking(plan({ tracked: 12, removeHere: paths(9) })), false);
    assert.equal(worthAsking(plan({ tracked: 2000, removeThere: paths(400) })), false);
  });
});
