import { test } from "node:test";
import assert from "node:assert/strict";
import { OnePasswordStore, createStore, KeychainStore } from "../src/secrets/index.js";

test("OnePasswordStore is a visible, unimplemented seam", async () => {
  const s = new OnePasswordStore();
  await assert.rejects(s.get({ name: "X", service: "s", account: "a" }), /not implemented/);
  await assert.rejects(s.set({ name: "X", service: "s", account: "a" }, "v"), /not implemented/);
});

test("createStore picks backends", () => {
  assert.ok(createStore("keychain", {}) instanceof KeychainStore);
  assert.ok(createStore("1password", {}) instanceof OnePasswordStore);
  assert.throws(() => createStore("nope", {}), /unknown secret store/);
});
