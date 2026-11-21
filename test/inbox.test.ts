import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InboxStore, InboxError, parseUntil } from "../src/inbox.js";
import { PathError } from "../src/memory.js";
import { homePaths } from "../src/home.js";
import { tempHome } from "./helpers.js";

/** Smallest valid PNG signature plus padding: enough for the magic-byte sniff. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

function clock(start = "2026-11-21T12:00:00.000Z") {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance: (ms: number) => { t += ms; },
  };
}

function withStore(fn: (s: InboxStore, root: string, c: ReturnType<typeof clock>) => void) {
  const h = tempHome();
  const c = clock();
  const s = new InboxStore(h.root, { now: c.now });
  try {
    fn(s, h.root, c);
  } finally {
    s.close();
    h.cleanup();
  }
}

const base = { title: "Ship it?", summary: "Ready to merge.", options: ["Approve (Recommended)", "Reject"], harness: "hermes" };

test("submit inserts an open card with keyed options and defaults", () => {
  withStore((s, root) => {
    const c = s.submit(base);
    assert.match(c.id, /^ib_[0-9a-f]{12}$/);
    assert.equal(c.status, "open");
    assert.equal(c.priority, "p2");
    assert.equal(c.blockingCount, 1);
    assert.deepEqual(c.options, [{ key: "1", label: "Approve (Recommended)" }, { key: "2", label: "Reject" }]);
    assert.deepEqual(s.get(c.id), c);
    assert.ok(existsSync(homePaths(root).inboxDb));
  });
});

test("submit enforces the card caps", () => {
  withStore((s) => {
    const bad: [string, any][] = [
      ["title > 100", { ...base, title: "x".repeat(101) }],
      ["empty title", { ...base, title: "  " }],
      ["summary > 600", { ...base, summary: "y".repeat(601) }],
      ["1 option", { ...base, options: ["only"] }],
      ["5 options", { ...base, options: ["a", "b", "c", "d", "e"] }],
      ["empty option", { ...base, options: ["a", " "] }],
      ["bad priority", { ...base, priority: "p9" }],
      ["no harness", { ...base, harness: "" }],
      ["bad blocks", { ...base, blockingCount: -1 }],
    ];
    for (const [label, input] of bad) assert.throws(() => s.submit(input), InboxError, label);
    assert.doesNotThrow(() => s.submit({ ...base, title: "x".repeat(100), summary: "y".repeat(600), options: ["a", "b", "c", "d"] }));
  });
});

test("list(open) sorts by priority, blocking_count desc, created_at asc and hides active snoozes", () => {
  withStore((s, _root, c) => {
    const p2old = s.submit({ ...base, title: "p2 old", priority: "p2", blockingCount: 1 });
    c.advance(1000);
    const p1few = s.submit({ ...base, title: "p1 few", priority: "p1", blockingCount: 1 });
    c.advance(1000);
    const p1many = s.submit({ ...base, title: "p1 many", priority: "p1", blockingCount: 5 });
    c.advance(1000);
    const p2new = s.submit({ ...base, title: "p2 new", priority: "p2", blockingCount: 1 });
    c.advance(1000);
    const p0 = s.submit({ ...base, title: "p0", priority: "p0", blockingCount: 0 });
    const snoozed = s.submit({ ...base, title: "snoozed", priority: "p0" });
    s.snooze(snoozed.id, "2h");
    assert.deepEqual(s.list("open").map((x) => x.title), [p0, p1many, p1few, p2old, p2new].map((x) => x.title));
    assert.deepEqual(s.list("snoozed").map((x) => x.id), [snoozed.id]);
    c.advance(2 * 3600_000 + 1);
    assert.equal(s.list("open")[0].id, snoozed.id, "an expired snooze comes back into the queue");
    assert.deepEqual(s.list("open", { harness: "nope" }), []);
  });
});

test("decide resolves the card and records decision and feedback", () => {
  withStore((s) => {
    const c = s.submit(base);
    const d = s.decide(c.id, { decision: "2", feedback: "Too risky before the demo" });
    assert.equal(d.status, "resolved");
    assert.equal(d.decision, "2");
    assert.equal(d.decisionLabel, "Reject");
    assert.equal(d.feedback, "Too risky before the demo");
    assert.ok(d.decidedAt);
    assert.deepEqual(s.list("open"), []);
    assert.deepEqual(s.list("resolved").map((x) => x.id), [c.id]);
    assert.throws(() => s.decide(c.id, { decision: "1" }), /already resolved/);
    assert.throws(() => s.decide("ib_000000000000", { decision: "1" }), /not found/);
    const o = s.submit(base);
    assert.equal(s.decide(o.id, { decision: "Neither: wait for Monday" }).decisionLabel, "Neither: wait for Monday", "free text is an override");
    assert.throws(() => s.decide(s.submit(base).id, { decision: "" }), InboxError);
  });
});

test("snooze accepts 2h, 30m, 3d, tomorrow and ISO timestamps", () => {
  const now = new Date("2026-11-21T12:00:00.000Z");
  assert.equal(parseUntil("2h", now).toISOString(), "2026-11-21T14:00:00.000Z");
  assert.equal(parseUntil("30m", now).toISOString(), "2026-11-21T12:30:00.000Z");
  assert.equal(parseUntil("3d", now).toISOString(), "2026-11-24T12:00:00.000Z");
  const t = parseUntil("tomorrow", now);
  assert.ok(t.getTime() > now.getTime() && t.getTime() - now.getTime() <= 48 * 3600_000);
  assert.equal(t.getHours(), 9, "tomorrow means 9am local");
  assert.equal(parseUntil("2026-12-01T08:00:00Z", now).toISOString(), "2026-12-01T08:00:00.000Z");
  for (const bad of ["soon", "2x", "", "2020-01-01T00:00:00Z"]) assert.throws(() => parseUntil(bad, now), InboxError, bad);
  withStore((s) => {
    const c = s.submit(base);
    const z = s.snooze(c.id, "2h");
    assert.equal(z.snoozedUntil, "2026-11-21T14:00:00.000Z");
  });
});

test("poll returns unpicked resolved cards for a harness once when acked", () => {
  withStore((s) => {
    const mine = s.submit({ ...base, harness: "claude-code", agent: "builder" });
    const other = s.submit({ ...base, harness: "hermes" });
    const open = s.submit({ ...base, harness: "claude-code" });
    s.decide(mine.id, { decision: "1" });
    s.decide(other.id, { decision: "1" });
    assert.deepEqual(s.poll({ harness: "claude-code" }).map((x) => x.id), [mine.id], "no ack: peek");
    assert.deepEqual(s.poll({ harness: "claude-code", agent: "someone-else" }), []);
    const got = s.poll({ harness: "claude-code", ack: true });
    assert.deepEqual(got.map((x) => x.id), [mine.id]);
    assert.ok(got[0].pickedUpAt);
    assert.deepEqual(s.poll({ harness: "claude-code", ack: true }), [], "second poll is empty");
    assert.deepEqual(s.poll({}).map((x) => x.id), [other.id]);
    assert.equal(s.get(open.id).status, "open");
  });
});

test("prune deletes resolved cards older than N days and their artifacts only", () => {
  withStore((s, root, c) => {
    const img = join(root, "..", "shot.png");
    writeFileSync(img, PNG);
    const old = s.submit({ ...base, artifacts: [{ path: img, caption: "before" }] });
    const openOld = s.submit(base);
    s.decide(old.id, { decision: "1" });
    const dir = join(homePaths(root).inboxArtifacts, old.id);
    assert.ok(existsSync(dir));
    c.advance(31 * 86400_000);
    const recent = s.submit(base);
    s.decide(recent.id, { decision: "1" });
    assert.deepEqual(s.prune(30), { removed: 1 });
    assert.equal(existsSync(dir), false);
    assert.throws(() => s.get(old.id), /not found/);
    assert.equal(s.get(openOld.id).status, "open");
    assert.equal(s.get(recent.id).status, "resolved");
  });
});

test("distillExport returns undistilled resolved cards and stamps them", () => {
  withStore((s) => {
    const a = s.submit(base);
    const b = s.submit(base);
    s.submit(base); // still open
    s.decide(a.id, { decision: "1" });
    s.decide(b.id, { decision: "2", feedback: "never on Fridays" });
    assert.equal(s.distillExport().length, 2, "peek does not stamp");
    const got = s.distillExport({ markDistilled: true });
    assert.deepEqual(got.map((x) => x.id).sort(), [a.id, b.id].sort());
    assert.ok(s.get(a.id).distilledAt);
    assert.deepEqual(s.distillExport(), []);
  });
});

test("artifacts: images are copied in, non-images and traversal are refused", () => {
  withStore((s, root) => {
    const outside = join(root, "..");
    const img = join(outside, "Screen Shot 1.png");
    writeFileSync(img, PNG);
    const c = s.submit({ ...base, artifacts: [{ path: img, caption: "the new header" }] });
    assert.equal(c.artifacts.length, 1);
    assert.match(c.artifacts[0].file, /^1-screen-shot-1\.png$/);
    assert.equal(c.artifacts[0].caption, "the new header");
    const p = s.artifactPath(c.id, c.artifacts[0].file);
    assert.deepEqual(readFileSync(p), PNG);
    // a text file renamed .png fails the magic-byte sniff
    const fake = join(outside, "id_rsa.png");
    writeFileSync(fake, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    assert.throws(() => s.submit({ ...base, artifacts: [{ path: fake, caption: "" }] }), InboxError);
    assert.throws(() => s.submit({ ...base, artifacts: [{ path: join(outside, "notes.txt"), caption: "" }] }), InboxError);
    assert.throws(() => s.submit({ ...base, artifacts: [{ path: "relative.png", caption: "" }] }), InboxError);
    // read side: ids and file names cannot escape the artifact dir
    const dir = homePaths(root).inboxArtifacts;
    mkdirSync(join(dir, "ib_aaaaaaaaaaaa"), { recursive: true });
    symlinkSync(join(root, "secrets.manifest.yaml"), join(dir, c.id, "link.png"));
    for (const [id, file] of [
      ["../../memory", "x.png"],
      [c.id, "../../../secrets.manifest.yaml"],
      [c.id, "link.png"],
      [c.id, "/etc/passwd"],
      ["ib_aaaaaaaaaaaa/../" + c.id, c.artifacts[0].file],
      [c.id, "missing.png"],
    ]) {
      assert.throws(() => s.artifactPath(id, file), PathError, `${id} ${file}`);
    }
    assert.throws(() => s.get("../etc"), PathError);
    // a listed artifact swapped for a symlink out of the dir is refused too
    const c2 = s.submit({ ...base, artifacts: [{ path: img, caption: "" }] });
    rmSync(join(dir, c2.id, c2.artifacts[0].file));
    symlinkSync(join(root, "secrets.manifest.yaml"), join(dir, c2.id, c2.artifacts[0].file));
    assert.throws(() => s.artifactPath(c2.id, c2.artifacts[0].file), PathError, "swapped symlink");
  });
});
