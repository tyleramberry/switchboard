import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homePaths, initHome, AGENTS_TEMPLATE, INBOX_SKILL } from "../src/home.js";

test("AGENTS.md carries a one-line inbox pointer and init installs the switchboard-inbox skill", () => {
  const pointer = AGENTS_TEMPLATE.split("\n").filter((l) => l.includes("switchboard inbox"));
  assert.equal(pointer.length, 1, "exactly one inbox line");
  assert.match(pointer[0], /switchboard-inbox/);
  assert.match(INBOX_SKILL, /^---\nname: switchboard-inbox\ndescription: Use when /);
  for (const cmd of ["submit", "status", "poll", "--ack", "--save-rule"]) assert.ok(INBOX_SKILL.includes(cmd), cmd);
  assert.ok(!/\u2014/.test(AGENTS_TEMPLATE + INBOX_SKILL), "no em dashes");
  const base = mkdtempSync(join(tmpdir(), "sb-home-"));
  try {
    const root = join(base, "home");
    initHome(root);
    const f = join(root, "skills", "switchboard-inbox", "SKILL.md");
    assert.ok(existsSync(f));
    assert.equal(readFileSync(f, "utf8"), INBOX_SKILL);
    assert.ok(initHome(root).existing.includes(f), "idempotent");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("inbox paths live inside the gitignored .switchboard state dir", () => {
  const p = homePaths("/tmp/sb-home");
  assert.ok(p.inboxDb.endsWith(join(".switchboard", "inbox.db")), p.inboxDb);
  assert.ok(p.inboxArtifacts.endsWith(join(".switchboard", "inbox-artifacts")), p.inboxArtifacts);
  assert.ok(p.inboxDb.startsWith(p.state));
  assert.ok(p.inboxArtifacts.startsWith(p.state));
});
