import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeychainStore } from "../src/secrets/keychain.js";
import { Switchboard } from "../src/server.js";
import { PolicyError } from "../src/secret-run.js";
import { tempHome, tempKeychain, writeTestManifest } from "./helpers.js";

const VALUE = "sb-dummy-inbox-" + "d00d".repeat(5);
const CLI = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "cli.js");
let kc: ReturnType<typeof tempKeychain>;
let home: ReturnType<typeof tempHome>;
let store: KeychainStore;

before(async () => {
  kc = tempKeychain();
  home = tempHome();
  writeTestManifest(home.root);
  store = new KeychainStore(kc.path);
  await store.set({ name: "TEST_TOKEN", service: "switchboard-test", account: "TEST_TOKEN" }, VALUE);
});

after(() => {
  home?.cleanup();
  kc?.cleanup();
});

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, "inbox", ...args], {
    encoding: "utf8",
    env: { ...process.env, SWITCHBOARD_HOME: home.root, SWITCHBOARD_KEYCHAIN: kc.path },
  });
  let json: any = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const card = { title: "Pick a font", summary: "Header font for the portfolio.", options: ["Geist (Recommended)", "Inter"], harness: "hermes" };

test("Switchboard does not register any inbox MCP tool (zero schema tokens)", async () => {
  const { buildServer } = await import("../src/server.js");
  const sb = new Switchboard({ root: home.root, store });
  try {
    const server: any = buildServer(sb);
    const names = Object.keys(server._registeredTools ?? {});
    assert.ok(names.length === 7, names.join(","));
    assert.equal(names.some((n) => n.includes("inbox")), false);
  } finally {
    sb.close();
  }
});

test("inboxSubmit refuses stored secrets and credential patterns in any text field", async () => {
  const sb = new Switchboard({ root: home.root, store });
  try {
    for (const bad of [
      { ...card, summary: `use ${VALUE}` },
      { ...card, title: Buffer.from(VALUE).toString("base64").slice(0, 60) + "==" },
      { ...card, options: ["ok", "key ghp_" + "a".repeat(36)] },
      { ...card, project: "x", agent: "y", summary: "AKIA" + "A".repeat(16) },
    ]) {
      await assert.rejects(sb.inboxSubmit(bad), PolicyError);
    }
    assert.equal(sb.inbox.list("open").length, 0, "nothing was stored");
    const ok = await sb.inboxSubmit(card);
    assert.equal(ok.status, "open");
    await assert.rejects(sb.inboxDecide(ok.id, { decision: "1", feedback: `token ${VALUE}` }), PolicyError);
    assert.equal(sb.inbox.get(ok.id).status, "open", "a refused decision changes nothing");
  } finally {
    sb.close();
  }
});

test("inboxDecide with saveRule writes a preference note and marks the card", async () => {
  const sb = new Switchboard({ root: home.root, store });
  try {
    const c = await sb.inboxSubmit({ ...card, project: "portfolio" });
    const r = await sb.inboxDecide(c.id, { decision: "1", feedback: "Keep the font smaller on mobile", saveRule: true });
    assert.equal(r.card.status, "resolved");
    assert.equal(r.card.savedAsRule, true);
    assert.ok(r.rule);
    const note = sb.memory.read(r.rule!.path);
    assert.equal(note.type, "preference");
    assert.ok(note.tags.includes("inbox-rule"));
    assert.ok(note.tags.includes("portfolio"));
    assert.match(note.body, /Geist \(Recommended\)/);
    assert.match(note.body, /Keep the font smaller on mobile/);
    assert.match(note.body, new RegExp(c.id));
    assert.equal(sb.memory.search("font smaller mobile")[0].path, r.rule!.path);
    const plain = await sb.inboxDecide((await sb.inboxSubmit(card)).id, { decision: "2" });
    assert.equal(plain.rule, null);
    assert.equal(plain.card.savedAsRule, false);
  } finally {
    sb.close();
  }
});

test("CLI: submit, list order, status, decide --save-rule, snooze", () => {
  const sub = (title: string, extra: string[]) =>
    cli(["submit", "--title", title, "--summary", "s", "--option", "Yes (Recommended)", "--option", "No", "--harness", "claude-code", "--json", ...extra]);
  const low = sub("low", ["--priority", "p3"]);
  assert.equal(low.code, 0, low.stderr);
  assert.match(low.json.id, /^ib_/);
  assert.equal(low.json.status, "open");
  const hi = sub("hi", ["--priority", "p0", "--blocks", "3"]);
  const mid = sub("mid", ["--priority", "p0", "--blocks", "1", "--agent", "builder", "--project", "sb"]);
  const list = cli(["list", "--harness", "claude-code", "--json"]);
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(list.json.cards.map((c: any) => c.title), ["hi", "mid", "low"]);
  const human = cli(["list", "--harness", "claude-code"]);
  assert.match(human.stdout, /hi/);
  assert.match(human.stdout, /p0/);

  const bad = cli(["submit", "--title", "x".repeat(101), "--summary", "s", "--option", "a", "--option", "b", "--harness", "h"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /title is too long/);
  const leak = cli(["submit", "--title", "t", "--summary", `x ${VALUE}`, "--option", "a", "--option", "b", "--harness", "h"]);
  assert.equal(leak.code, 1);
  assert.match(leak.stderr, /refused/);
  assert.equal(leak.stderr.includes(VALUE), false);

  const d = cli(["decide", hi.json.id, "--decision", "1", "--feedback", "Always ship small PRs first", "--save-rule", "--json"]);
  assert.equal(d.code, 0, d.stderr);
  assert.equal(d.json.card.status, "resolved");
  assert.match(d.json.rule.path, /\.md$/);
  assert.match(readFileSync(join(home.root, "memory", d.json.rule.path), "utf8"), /type: preference/);
  const st = cli(["status", hi.json.id, "--json"]);
  assert.equal(st.json.decision, "1");
  assert.equal(st.json.feedback, "Always ship small PRs first");
  assert.ok(st.json.decidedAt);
  assert.equal(cli(["status", "../x", "--json"]).code, 1);

  const z = cli(["snooze", low.json.id, "--until", "2h", "--json"]);
  assert.equal(z.code, 0, z.stderr);
  assert.ok(z.json.snoozedUntil);
  assert.deepEqual(cli(["list", "--view", "snoozed", "--json"]).json.cards.map((c: any) => c.id), [low.json.id]);
  assert.equal(mid.code, 0);
});

test("CLI: poll --harness --ack returns that harness's decisions exactly once", () => {
  const mk = (h: string) => cli(["submit", "--title", `for ${h}`, "--summary", "s", "--option", "a", "--option", "b", "--harness", h, "--json"]).json.id;
  const mine = mk("codex");
  const theirs = mk("grokbot");
  cli(["decide", mine, "--decision", "2"]);
  cli(["decide", theirs, "--decision", "1"]);
  const p1 = cli(["poll", "--harness", "codex", "--ack", "--json"]);
  assert.equal(p1.code, 0, p1.stderr);
  assert.deepEqual(p1.json.cards.map((c: any) => c.id), [mine]);
  assert.equal(p1.json.cards[0].decisionLabel, "b");
  assert.ok(p1.json.cards[0].pickedUpAt);
  assert.deepEqual(cli(["poll", "--harness", "codex", "--ack", "--json"]).json.cards, []);
  assert.deepEqual(cli(["poll", "--harness", "grokbot", "--json"]).json.cards.map((c: any) => c.id), [theirs]);
});

test("CLI: distill-export and usage errors", () => {
  const e = cli(["distill-export", "--json"]);
  assert.equal(e.code, 0, e.stderr);
  assert.ok(e.json.cards.length >= 1);
  assert.ok(e.json.cards.every((c: any) => c.status === "resolved" && c.distilledAt === null));
  const m = cli(["distill-export", "--mark-distilled", "--json"]);
  assert.equal(m.json.cards.length, e.json.cards.length);
  assert.deepEqual(cli(["distill-export", "--json"]).json.cards, []);
  assert.equal(cli(["nope"]).code, 2);
  assert.equal(cli(["decide"]).code, 1);
});
