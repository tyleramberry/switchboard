import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync, mkdirSync, utimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../src/memory.js";
import { SkillStore } from "../src/skills.js";
import { initHome } from "../src/home.js";
import { tempHome } from "./helpers.js";

test("init is idempotent and never overwrites", () => {
  const h = tempHome();
  try {
    writeFileSync(join(h.root, "AGENTS.md"), "mine");
    const r = initHome(h.root);
    assert.equal(r.created.length, 0);
    assert.equal(readFileSync(join(h.root, "AGENTS.md"), "utf8"), "mine");
  } finally {
    h.cleanup();
  }
});

test("write then search and read", () => {
  const h = tempHome();
  const m = new MemoryStore(h.root);
  try {
    const { path } = m.write({ title: "Prefers oat milk", body: "Tyler-test user prefers oat milk lattes.", tags: ["prefs"], type: "preference" });
    const hits = m.search("oat milk");
    assert.equal(hits[0].path, path);
    assert.equal(hits[0].type, "preference");
    assert.deepEqual(m.read(path).tags, ["prefs"]);
    assert.equal(m.search("prefs", { tag: "nope" }).length, 0);
  } finally {
    m.close();
    h.cleanup();
  }
});

test("a second store instance sees writes from the first (cross-process model)", () => {
  const h = tempHome();
  const a = new MemoryStore(h.root);
  const b = new MemoryStore(h.root);
  try {
    assert.equal(b.search("zebra").length, 0);
    a.write({ title: "zebra crossing", body: "handoff" });
    assert.equal(b.search("zebra").length, 1);
    // hand-edited file (e.g. Obsidian) is picked up too
    writeFileSync(join(h.root, "memory", "manual.md"), "# Giraffe\nnotes");
    assert.equal(b.search("giraffe").length, 1);
  } finally {
    a.close();
    b.close();
    h.cleanup();
  }
});

test("FTS query syntax in user input cannot break the query", () => {
  const h = tempHome();
  const m = new MemoryStore(h.root);
  try {
    for (const q of ['"', "AND OR NOT", "a*b) (", "NEAR(", "*", "'; DROP TABLE notes; --"]) {
      assert.doesNotThrow(() => m.search(q), q);
    }
  } finally {
    m.close();
    h.cleanup();
  }
});

test("memory_read refuses traversal, absolute paths and escaping symlinks", () => {
  const h = tempHome();
  const m = new MemoryStore(h.root);
  try {
    writeFileSync(join(h.root, ".env"), "X=1");
    symlinkSync(join(h.root, ".env"), join(h.root, "memory", "evil.md"));
    for (const p of ["../.env", "../secrets.manifest.yaml", "/etc/passwd", "evil.md", "a/../../.env", "x\0.md"]) {
      assert.throws(() => m.read(p), /escapes|absolute|invalid|not found/, p);
    }
  } finally {
    m.close();
    h.cleanup();
  }
});

test("skills list and get, with containment", () => {
  const h = tempHome();
  const s = new SkillStore(h.root);
  try {
    mkdirSync(join(h.root, "skills", "demo"));
    writeFileSync(join(h.root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Use when testing.\n---\nbody");
    const names = s.list().map((x) => x.name);
    assert.deepEqual(names, ["demo", "switchboard-handoff"]);
    assert.match(s.get("demo").content, /body/);
    assert.throws(() => s.get("demo", "../../secrets.manifest.yaml"), /escapes/);
    assert.throws(() => s.get("../memory"), /invalid skill name/);
  } finally {
    h.cleanup();
  }
});

test("stale index entries are removed when files are deleted", async () => {
  const h = tempHome();
  const m = new MemoryStore(h.root);
  try {
    const { path } = m.write({ title: "ephemeral kiwi", body: "x" });
    assert.equal(m.search("kiwi").length, 1);
    const { rmSync } = await import("node:fs");
    rmSync(join(h.root, "memory", path));
    assert.equal(m.search("kiwi").length, 0);
    void utimesSync;
  } finally {
    m.close();
    h.cleanup();
  }
});
