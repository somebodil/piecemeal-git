import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULTS, readStored } from "./stored.ts";

describe("what the plugin keeps on the device", () => {
  const last = { at: 1_795_000_000_000, ok: true, text: "Synced: 2 taken, 0 sent.", attention: false };

  it("starts as the plugin comes where nothing is kept", () => {
    assert.deepEqual(readStored(null, null, null), { config: DEFAULTS, state: { last: null, panelPlaced: false }, fromFile: false });
    assert.deepEqual(readStored(undefined, undefined), { config: DEFAULTS, state: { last: null, panelPlaced: false }, fromFile: false });
  });

  it("reads the settings and how the last sync went, each from its place", () => {
    const stored = readStored({ url: "https://host.example/vault.git", everyMinutes: 10, onStart: true }, { last, panelPlaced: true }, null);
    assert.deepEqual(stored.config, { ...DEFAULTS, url: "https://host.example/vault.git", everyMinutes: 10, onStart: true });
    assert.deepEqual([stored.state, stored.fromFile], [{ last, panelPlaced: true }, false]);
  });

  it("takes all of it from the file of before, once, where the storage of the app has no settings", () => {
    const file = { ...DEFAULTS, url: "https://host.example/vault.git", tokenSecret: "my-token", authorName: "Me", last, panelPlaced: true };
    const stored = readStored(null, null, file);
    assert.deepEqual(stored.config, { ...DEFAULTS, url: "https://host.example/vault.git", tokenSecret: "my-token", authorName: "Me" });
    assert.deepEqual([stored.state, stored.fromFile], [{ last, panelPlaced: true }, true]);
    // A file of the version that did not know the panel yet
    assert.deepEqual(readStored(null, null, { url: "https://host.example/vault.git", last }).state, { last, panelPlaced: false });
  });

  it("leaves the file of before alone once the settings are kept in the storage of the app", () => {
    const stored = readStored({ url: "https://new.example/vault.git" }, null, { url: "https://old.example/vault.git", last, panelPlaced: true });
    assert.deepEqual([stored.config.url, stored.state, stored.fromFile], ["https://new.example/vault.git", { last: null, panelPlaced: false }, false]);
  });

  it("starts as the plugin comes where the file of before cannot be read, and does not take it for settings", () => {
    for (const file of [undefined, "", "{", 3, [], true]) {
      assert.deepEqual(readStored(null, null, file), { config: DEFAULTS, state: { last: null, panelPlaced: false }, fromFile: false });
    }
  });

  it("takes only what is a setting, and only of the kind that the setting is", () => {
    const stored = readStored(
      { url: 7, branch: "main", maxFileMB: "20", mergeText: "yes", everyMinutes: Number.NaN, onStart: true, last, more: "than a setting" },
      { last: { at: "then", ok: true, text: "" }, panelPlaced: "yes" },
    );
    assert.deepEqual(stored.config, { ...DEFAULTS, branch: "main", onStart: true });
    assert.deepEqual(stored.state, { last: null, panelPlaced: false });
  });
});
