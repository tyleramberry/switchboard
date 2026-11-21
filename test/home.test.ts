import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homePaths } from "../src/home.js";

test("inbox paths live inside the gitignored .switchboard state dir", () => {
  const p = homePaths("/tmp/sb-home");
  assert.ok(p.inboxDb.endsWith(join(".switchboard", "inbox.db")), p.inboxDb);
  assert.ok(p.inboxArtifacts.endsWith(join(".switchboard", "inbox-artifacts")), p.inboxArtifacts);
  assert.ok(p.inboxDb.startsWith(p.state));
  assert.ok(p.inboxArtifacts.startsWith(p.state));
});
