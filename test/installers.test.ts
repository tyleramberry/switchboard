import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { initHome } from "../src/home.js";
import { runSetup } from "../src/installers/index.js";
import { upsertBlock } from "../src/installers/common.js";

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "sb-inst-"));
  const root = join(base, "home");
  initHome(root);
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

async function setup(h: string, root: string, dir: string, dryRun = false) {
  const lines: string[] = [];
  await runSetup(h, { root, configDir: dir, dryRun, log: (s) => lines.push(s) });
  return lines.join("\n");
}

test("upsertBlock inserts once and replaces in place", () => {
  const a = upsertBlock("hello\n", "one");
  const b = upsertBlock(a, "two");
  assert.equal((b.match(/switchboard:start/g) ?? []).length, 1);
  assert.match(b, /^hello\n\n<!-- switchboard:start/);
  assert.match(b, /two/);
  assert.doesNotMatch(b, /one/);
});

for (const harness of ["hermes", "claude-code", "codex", "grokbot"]) {
  test(`${harness}: dry run writes nothing; apply is idempotent; backups kept`, async () => {
    const s = sandbox();
    const dir = join(s.base, harness);
    try {
      const dry = await setup(harness, s.root, dir, true);
      assert.match(dry, /dry run/);
      assert.equal(existsSync(dir), false, "dry run must not create the config dir");
      await setup(harness, s.root, dir);
      const again = await setup(harness, s.root, dir);
      assert.match(again, /no changes: already set up/);
    } finally {
      s.cleanup();
    }
  });
}

test("hermes: preserves existing keys and servers, backs up", async () => {
  const s = sandbox();
  const dir = join(s.base, "hermes");
  try {
    mkdirSync(dir);
    writeFileSync(
      join(dir, "config.yaml"),
      "model:\n  default: x/y\nmcp_servers:\n  other:\n    url: https://example.com/mcp\nskills:\n  external_dirs:\n    - /opt/skills\n",
    );
    await setup("hermes", s.root, dir);
    const cfg = YAML.parse(readFileSync(join(dir, "config.yaml"), "utf8"));
    assert.equal(cfg.model.default, "x/y");
    assert.equal(cfg.mcp_servers.other.url, "https://example.com/mcp");
    assert.equal(cfg.mcp_servers.switchboard.env.SWITCHBOARD_HOME, s.root);
    assert.deepEqual(cfg.skills.external_dirs, ["/opt/skills", join(s.root, "skills")]);
    assert.ok(readdirSync(dir).some((f) => f.startsWith("config.yaml.switchboard-bak-")));
  } finally {
    s.cleanup();
  }
});

test("claude-code: keeps other JSON keys, links skills, never clobbers a foreign skill dir", async () => {
  const s = sandbox();
  const dir = join(s.base, "claude");
  try {
    mkdirSync(join(dir, "skills", "switchboard-handoff"), { recursive: true });
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ theme: "dark", mcpServers: { a: { command: "x" } } }));
    const out = await setup("claude-code", s.root, dir);
    assert.match(out, /not Switchboard's link; left alone/);
    const cfg = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    assert.equal(cfg.theme, "dark");
    assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ["a", "switchboard"]);
    assert.match(readFileSync(join(dir, "CLAUDE.md"), "utf8"), new RegExp(`@${s.root}/AGENTS.md`));
  } finally {
    s.cleanup();
  }
});

test("codex: refuses to duplicate a hand-written [mcp_servers.switchboard]", async () => {
  const s = sandbox();
  const dir = join(s.base, "codex");
  try {
    mkdirSync(dir);
    writeFileSync(join(dir, "config.toml"), 'model = "x"\n\n[mcp_servers.switchboard]\ncommand = "old"\n');
    await assert.rejects(setup("codex", s.root, dir), /outside Switchboard's managed block/);
  } finally {
    s.cleanup();
  }
});

test("setup refuses when Home is not initialised", async () => {
  const base = mkdtempSync(join(tmpdir(), "sb-inst-"));
  try {
    await assert.rejects(
      runSetup("hermes", { root: join(base, "nohome"), configDir: join(base, "h"), dryRun: true, log: () => {} }),
      /not initialised/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
