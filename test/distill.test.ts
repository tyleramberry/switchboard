import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeychainStore } from "../src/secrets/keychain.js";
import { Switchboard } from "../src/server.js";
import { distillInbox } from "../scripts/distill-inbox.js";
import { tempHome, tempKeychain, writeTestManifest } from "./helpers.js";

const SCRIPT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "scripts", "distill-inbox.js");
let kc: ReturnType<typeof tempKeychain>;
let store: KeychainStore;

before(async () => {
  kc = tempKeychain();
  store = new KeychainStore(kc.path);
});

after(() => kc?.cleanup());

function withHome(fn: (sb: Switchboard, root: string) => Promise<void>) {
  return async () => {
    const h = tempHome();
    writeTestManifest(h.root);
    const sb = new Switchboard({ root: h.root, store });
    try {
      await fn(sb, h.root);
    } finally {
      sb.close();
      h.cleanup();
    }
  };
}

const base = { summary: "Context for the decision.", harness: "claude-code", project: "portfolio" };

test(
  "distill is a clean no-op when there are 0 undistilled resolved cards",
  withHome(async (sb, root) => {
    const open = await sb.inboxSubmit({ ...base, title: "Still open", options: ["A (Recommended)", "B"] });
    const memBefore = readdirSync(join(root, "memory")).sort();
    const r = await distillInbox(sb);
    assert.equal(r.status, "idle");
    assert.equal(r.exported, 0);
    assert.deepEqual(r.items, []);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(readdirSync(join(root, "memory")).sort(), memBefore, "memory untouched");
    assert.equal(sb.inbox.list("open").length, 1, "no conflict cards opened");
    assert.equal(sb.inbox.get(open.id).status, "open");
  }),
);

test(
  "distill skips cards already saved as rules and plain accepted defaults",
  withHome(async (sb) => {
    const ruled = await sb.inboxSubmit({ ...base, title: "Pick a font", options: ["Geist (Recommended)", "Inter"] });
    await sb.inboxDecide(ruled.id, { decision: "2", feedback: "Inter reads better", saveRule: true });
    const plain = await sb.inboxSubmit({ ...base, title: "Ship the patch", options: ["Ship (Recommended)", "Hold"] });
    await sb.inboxDecide(plain.id, { decision: "1" });
    const r = await distillInbox(sb);
    assert.equal(r.status, "ready");
    assert.equal(r.exported, 2);
    assert.deepEqual(r.items, []);
    assert.deepEqual(
      r.skipped.map((s) => [s.id, s.reason]).sort(),
      [[ruled.id, "saved_as_rule"], [plain.id, "accepted_default"]].sort(),
    );
    assert.equal(sb.inbox.distillExport().length, 0, "every exported card is marked distilled");
  }),
);

test(
  "distill extracts feedback and overrides into a compact bundle",
  withHome(async (sb) => {
    const fb = await sb.inboxSubmit({ ...base, title: "Hero image size", options: ["Large (Recommended)", "Small"] });
    await sb.inboxDecide(fb.id, { decision: "1", feedback: "Keep it under 400px tall" });
    const ov = await sb.inboxSubmit({ ...base, title: "Deploy target", options: ["Vercel (Recommended)", "Netlify"] });
    await sb.inboxDecide(ov.id, { decision: "2" });
    const free = await sb.inboxSubmit({ ...base, title: "Color theme", options: ["Dark (Recommended)", "Light"] });
    await sb.inboxDecide(free.id, { decision: "Use the brand teal" });
    const r = await distillInbox(sb);
    assert.equal(r.status, "ready");
    const byId = new Map(r.items.map((i) => [i.id, i]));
    assert.equal(r.items.length, 3);
    assert.deepEqual(
      { kind: byId.get(fb.id)!.kind, chosen: byId.get(fb.id)!.chosen, feedback: byId.get(fb.id)!.feedback },
      { kind: "feedback", chosen: "Large (Recommended)", feedback: "Keep it under 400px tall" },
    );
    assert.equal(byId.get(ov.id)!.kind, "override");
    assert.equal(byId.get(ov.id)!.chosen, "Netlify");
    assert.deepEqual(byId.get(ov.id)!.notChosen, ["Vercel (Recommended)"]);
    assert.equal(byId.get(free.id)!.kind, "override");
    assert.equal(byId.get(free.id)!.chosen, "Use the brand teal");
    assert.equal(byId.get(free.id)!.project, "portfolio");
    assert.equal(byId.get(free.id)!.harness, "claude-code");
    assert.ok(r.instructions.length > 0);
    assert.equal((await distillInbox(sb)).status, "idle", "second run finds nothing new");
  }),
);

test(
  "dryRun peeks without marking cards distilled",
  withHome(async (sb) => {
    const c = await sb.inboxSubmit({ ...base, title: "Deploy target", options: ["Vercel (Recommended)", "Netlify"] });
    await sb.inboxDecide(c.id, { decision: "2" });
    assert.equal((await distillInbox(sb, { dryRun: true })).items.length, 1);
    assert.equal((await distillInbox(sb, { dryRun: true })).items.length, 1);
    assert.equal(sb.inbox.distillExport().length, 1);
  }),
);

test(
  "a decision that contradicts a memory rule opens a conflict card in inbox.db",
  withHome(async (sb) => {
    const old = await sb.inboxSubmit({ ...base, title: "Pick a header font", options: ["Geist (Recommended)", "Inter"] });
    const saved = await sb.inboxDecide(old.id, { decision: "1", saveRule: true });
    assert.ok(saved.rule);
    const neu = await sb.inboxSubmit({ ...base, title: "Pick a header font", options: ["Geist (Recommended)", "Inter"] });
    await sb.inboxDecide(neu.id, { decision: "2", feedback: "Inter for this one" });
    const agree = await sb.inboxSubmit({ ...base, title: "Pick a header font", options: ["Geist (Recommended)", "Inter"] });
    await sb.inboxDecide(agree.id, { decision: "1", feedback: "Geist again" });

    const r = await distillInbox(sb);
    assert.equal(r.conflicts.length, 1, JSON.stringify(r.conflicts));
    const k = r.conflicts[0];
    assert.equal(k.cardId, neu.id);
    assert.equal(k.notePath, saved.rule!.path);
    assert.equal(k.memoryChoice, "Geist (Recommended)");
    assert.equal(k.newChoice, "Inter");

    const conflict = sb.inbox.get(k.conflictCardId);
    assert.equal(conflict.status, "open");
    assert.equal(conflict.harness, "switchboard");
    assert.equal(conflict.agent, "distill");
    assert.equal(conflict.priority, "p1");
    assert.match(conflict.title, /^Conflict: /);
    assert.ok(conflict.title.length <= 100 && conflict.summary.length <= 600);
    assert.match(conflict.summary, /Inter/);
    assert.match(conflict.summary, /Geist/);
    assert.ok(conflict.summary.includes(saved.rule!.path));
    assert.equal(conflict.options[0].label, "Keep new decision (Recommended)");
    assert.ok(!/\u2014/.test(conflict.title + conflict.summary), "no em dashes");
    assert.equal(sb.inbox.list("open").length, 1, "exactly one conflict card");
  }),
);

test("the distill script exits 0 with an idle JSON bundle on an empty Home", () => {
  const h = tempHome();
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--json"], {
      encoding: "utf8",
      env: { ...process.env, SWITCHBOARD_HOME: h.root, SWITCHBOARD_KEYCHAIN: kc.path },
    });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, "idle");
    assert.deepEqual(j.items, []);
  } finally {
    h.cleanup();
  }
});
