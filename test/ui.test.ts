import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeychainStore } from "../src/secrets/keychain.js";
import { startUi, UiHandle, nearDuplicates } from "../src/ui/server.js";
import { pinPathFor, writeManifestPin } from "../src/manifest.js";
import { Switchboard } from "../src/server.js";
import { tempHome, tempKeychain, writeTestManifest } from "./helpers.js";

const VALUE = "sb-dummy-ui-" + "cafe".repeat(5);
const ROTATED = "sb-rotated-ui-" + "f00d".repeat(5);
let kc: ReturnType<typeof tempKeychain>;
let home: ReturnType<typeof tempHome>;
let dirs: string;
let ui: UiHandle;
const seen: string[] = []; // every API response body, for the leak grep

before(async () => {
  kc = tempKeychain();
  home = tempHome();
  writeTestManifest(home.root);
  writeManifestPin(join(home.root, "secrets.manifest.yaml"));
  spawnSync("/usr/bin/git", ["-C", home.root, "init", "-q"]);
  spawnSync("/usr/bin/git", ["-C", home.root, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  spawnSync("/usr/bin/git", ["-C", home.root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  const store = new KeychainStore(kc.path);
  await store.set({ name: "TEST_TOKEN", service: "switchboard-test", account: "TEST_TOKEN" }, VALUE);
  dirs = mkdtempSync(join(tmpdir(), "sb-ui-harness-"));
  ui = await startUi({
    root: home.root,
    port: 0,
    store,
    harnessDirs: { hermes: join(dirs, "hermes"), "claude-code": join(dirs, "claude"), codex: join(dirs, "codex"), grokbot: join(dirs, "grokbot") },
  });
});

after(async () => {
  await ui?.close();
  home?.cleanup();
  kc?.cleanup();
  if (dirs) rmSync(dirs, { recursive: true, force: true });
});

function raw(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; host?: string } = {}) {
  return new Promise<{ status: number; text: string; json: any; headers: Record<string, any>; bytes: Buffer }>((ok, fail) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: "127.0.0.1",
        port: ui.port,
        method,
        path,
        headers: { host: opts.host ?? `127.0.0.1:${ui.port}`, ...(body ? { "content-type": "application/json" } : {}), ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          const text = bytes.toString("utf8");
          seen.push(text);
          let json: any = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          ok({ status: res.statusCode ?? 0, text, json, headers: res.headers, bytes });
        });
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}
const call = (method: string, path: string, body?: unknown) => raw(method, path, { headers: { "x-switchboard-token": ui.token }, body });

test("URL is loopback with a per-launch token", () => {
  assert.match(ui.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{48}$/);
});

test("api requires the token", async () => {
  assert.equal((await raw("GET", "/api/dashboard")).status, 401);
  assert.equal((await raw("GET", "/api/secrets", { headers: { "x-switchboard-token": "nope" } })).status, 401);
  assert.equal((await raw("GET", "/api/memory?token=" + ui.token)).status, 401, "token in the query string is not accepted for api");
  assert.equal((await call("GET", "/api/dashboard")).status, 200);
});

test("bad Host and cross-origin Origin are rejected", async () => {
  const h = { "x-switchboard-token": ui.token };
  assert.equal((await raw("GET", "/api/dashboard", { headers: h, host: "evil.example.com" })).status, 421);
  assert.equal((await raw("GET", "/api/dashboard", { headers: h, host: `evil.example.com:${ui.port}` })).status, 421);
  assert.equal((await raw("GET", "/", { host: "attacker.test" })).status, 421);
  assert.equal((await raw("GET", "/api/dashboard", { headers: { ...h, origin: "https://evil.example.com" } })).status, 403);
  assert.equal((await raw("GET", "/api/dashboard", { headers: { ...h, origin: `http://localhost:${ui.port}` } })).status, 200);
  assert.equal((await raw("GET", "/api/dashboard", { headers: h, host: `localhost:${ui.port}` })).status, 200);
});

test("static UI is served with a CSP and no path traversal", async () => {
  const r = await raw("GET", "/");
  assert.equal(r.status, 200);
  assert.match(r.text, /Switchboard/);
  assert.equal((await raw("GET", "/app.js")).status, 200);
  assert.equal((await raw("GET", "/..%2fpackage.json")).status, 404);
  assert.equal((await raw("GET", "/../package.json")).status, 404);
});

test("memory create, read, search, edit, delete round trip", async () => {
  const c = await call("POST", "/api/memory", { title: "UI round trip", body: "the walrus handoff", tags: ["ui"], type: "note" });
  assert.equal(c.status, 201, c.text);
  const path = c.json.path;
  const s = await call("GET", "/api/memory?q=walrus");
  assert.equal(s.json.results[0].path, path);
  const u = await call("PUT", `/api/memory/note?path=${encodeURIComponent(path)}`, { title: "UI round trip v2", body: "the narwhal handoff", tags: ["ui", "edited"], type: "decision" });
  assert.equal(u.status, 200, u.text);
  const r = await call("GET", `/api/memory/note?path=${encodeURIComponent(path)}`);
  assert.equal(r.json.note.title, "UI round trip v2");
  assert.equal(r.json.note.type, "decision");
  assert.deepEqual(r.json.note.tags, ["ui", "edited"]);
  assert.match(r.json.note.body, /narwhal/);
  assert.equal((await call("GET", "/api/memory?q=walrus")).json.results.length, 0, "old text gone from the index");
  assert.equal((await call("GET", "/api/memory?q=narwhal")).json.results[0].path, path);
  assert.equal((await call("GET", `/api/memory/note?path=${encodeURIComponent("../secrets.manifest.yaml")}`)).status, 400);
  assert.equal((await call("DELETE", `/api/memory/note?path=${encodeURIComponent(path)}`)).status, 200);
  assert.equal((await call("GET", `/api/memory/note?path=${encodeURIComponent(path)}`)).status, 400);
});

test("memory writes go through the secret scan", async () => {
  const a = await call("POST", "/api/memory", { title: "leak", body: `the token is ${VALUE}` });
  assert.equal(a.status, 422);
  assert.match(a.json.error, /refused/);
  const b = await call("POST", "/api/memory", { title: "leak2", body: "key ghp_" + "a".repeat(36) });
  assert.equal(b.status, 422);
  const ok = await call("POST", "/api/memory", { title: "Handoff for UI test", body: "ship it", type: "handoff" });
  const e = await call("PUT", `/api/memory/note?path=${encodeURIComponent(ok.json.path)}`, { title: "x", body: Buffer.from(VALUE).toString("base64") });
  assert.equal(e.status, 422, "edits are scanned too (base64 form)");
});

test("handoffs view and resolve", async () => {
  const list = await call("GET", "/api/handoffs");
  const h = list.json.find((n: any) => n.title === "Handoff for UI test");
  assert.ok(h);
  assert.equal(h.resolved, false);
  await call("POST", "/api/handoffs/resolve", { path: h.path, resolved: true });
  const again = (await call("GET", "/api/handoffs")).json.find((n: any) => n.path === h.path);
  assert.equal(again.resolved, true);
});

test("skills: list, create from template, edit, visibility", async () => {
  const c = await call("POST", "/api/skills", { name: "ui-test-skill", description: "Use when testing the UI." });
  assert.equal(c.status, 201, c.text);
  assert.equal((await call("POST", "/api/skills", { name: "../evil", description: "x" })).status, 400);
  const g = await call("GET", "/api/skills/ui-test-skill");
  assert.match(g.json.content, /name: ui-test-skill/);
  const p = await call("PUT", "/api/skills/ui-test-skill", { content: g.json.content + "\n3. Step three.\n" });
  assert.equal(p.status, 200);
  assert.match((await call("GET", "/api/skills/ui-test-skill")).json.content, /Step three/);
  const l = await call("GET", "/api/skills");
  const s = l.json.find((x: any) => x.name === "ui-test-skill");
  assert.deepEqual(s.visibility, { name: "ui-test-skill", hermes: false, claude: false, codex: false });
  const d = await call("GET", "/api/dashboard");
  assert.ok(d.json.attention.some((a: any) => a.kind === "skill" && a.target === "ui-test-skill"));
});

test("manifest edit is rejected on doctor errors and file is untouched", async () => {
  const mpath = join(home.root, "secrets.manifest.yaml");
  const before = readFileSync(mpath, "utf8");
  const bad = { name: "BAD_TOKEN", purpose: "curl anything", hosts: ["api.example.com"], commands: [{ program: "/usr/bin/curl", args: [".*"] }] };
  const v = await call("POST", "/api/secrets/validate", { entry: bad, mode: "create" });
  assert.equal(v.json.ok, false);
  assert.match(v.json.errors.join(" "), /matches anything/);
  const s = await call("POST", "/api/secrets/entry", { entry: bad });
  assert.equal(s.status, 422);
  assert.match(s.json.error, /rejected by doctor/);
  const interp = await call("POST", "/api/secrets/entry", { entry: { name: "SH_TOKEN", commands: [{ program: "/bin/sh", args: ["-c"] }] } });
  assert.equal(interp.status, 422, "parser errors are rejected too");
  const lower = await call("POST", "/api/secrets/entry", { entry: { name: "lower" } });
  assert.equal(lower.status, 422);
  assert.equal(readFileSync(mpath, "utf8"), before);
});

test("manifest add, edit, delete re-pins; tampered manifest blocks edits", async () => {
  const mpath = join(home.root, "secrets.manifest.yaml");
  const good = { name: "NEW_API_KEY", purpose: "example api", hosts: ["api.example.com"], http: { header: "Authorization", template: "Bearer {value}" } };
  const a = await call("POST", "/api/secrets/entry", { entry: good });
  assert.equal(a.status, 201, a.text);
  assert.equal(readFileSync(pinPathFor(mpath), "utf8").trim().slice(0, 12), a.json.pinned);
  let list = (await call("GET", "/api/secrets")).json;
  assert.equal(list.pin, "pinned");
  assert.ok(list.secrets.some((s: any) => s.name === "NEW_API_KEY" && s.present === false));
  const e = await call("PUT", "/api/secrets/entry", { entry: { ...good, purpose: "edited purpose" } });
  assert.equal(e.status, 200, e.text);
  list = (await call("GET", "/api/secrets")).json;
  assert.equal(list.secrets.find((s: any) => s.name === "NEW_API_KEY").purpose, "edited purpose");
  assert.equal((await call("DELETE", "/api/secrets/entry?name=NEW_API_KEY")).status, 200);
  assert.equal((await call("GET", "/api/secrets")).json.secrets.some((s: any) => s.name === "NEW_API_KEY"), false);
  // an out-of-band edit must not be silently blessed by the UI's re-pin
  const orig = readFileSync(mpath, "utf8");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(mpath, orig + "\n# agent was here\n");
  const t = await call("POST", "/api/secrets/entry", { entry: { ...good, name: "OTHER_KEY" } });
  assert.equal(t.status, 409);
  assert.equal((await call("GET", "/api/dashboard")).json.pin, "tampered");
  writeFileSync(mpath, orig);
});

test("set and rotate value: write-only", async () => {
  const r = await call("POST", "/api/secrets/value", { name: "TEST_TOKEN", value: ROTATED });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["name", "ok", "present"]);
  const got = await new KeychainStore(kc.path).get({ name: "TEST_TOKEN", service: "switchboard-test", account: "TEST_TOKEN" });
  assert.equal(got, ROTATED);
  assert.equal((await call("POST", "/api/secrets/value", { name: "NOPE", value: "abcdef" })).status, 404);
  assert.equal((await call("POST", "/api/secrets/value", { name: "TEST_TOKEN", value: "ab" })).status, 400);
  // put the original back so the leak grep covers both values
  await call("POST", "/api/secrets/value", { name: "TEST_TOKEN", value: VALUE });
});

test("harnesses: status, dry-run diff writes nothing, apply only into temp dirs", async () => {
  const list = await call("GET", "/api/harnesses");
  assert.equal(list.status, 200);
  const herm = list.json.find((h: any) => h.id === "hermes");
  assert.equal(herm.state, "not installed");
  const d = await call("GET", "/api/harnesses/hermes/diff");
  assert.ok(d.json.files.length >= 1);
  assert.ok(d.json.files.every((f: any) => f.path.startsWith(dirs)), "plan targets the temp dir");
  assert.equal(existsSync(join(dirs, "hermes")), false, "diff must not write");
  const a = await call("POST", "/api/harnesses/hermes/apply");
  assert.equal(a.status, 200, a.text);
  assert.ok(existsSync(join(dirs, "hermes", "config.yaml")));
  assert.equal((await call("GET", "/api/harnesses")).json.find((h: any) => h.id === "hermes").state, "installed");
  const sk = (await call("GET", "/api/skills")).json.find((s: any) => s.name === "switchboard-handoff");
  assert.equal(sk.visibility.hermes, true);
  assert.equal((await call("GET", "/api/harnesses/nope/diff")).status, 404);
});

test("commit only via the endpoint", async () => {
  const st = await call("GET", "/api/git");
  assert.ok(st.json.changes.length > 0);
  const c = await call("POST", "/api/commit", { message: "UI test commit" });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.git.clean, true);
  const log = spawnSync("/usr/bin/git", ["-C", home.root, "log", "-1", "--format=%s"], { encoding: "utf8" }).stdout.trim();
  assert.equal(log, "UI test commit");
  assert.equal((await call("POST", "/api/commit", { message: "again" })).status, 409);
});

test("near-duplicate detection", () => {
  const d = nearDuplicates([
    { path: "a.md", title: "Handoff: switchboard UI 2026-11-18" },
    { path: "b.md", title: "Handoff switchboard UI" },
    { path: "c.md", title: "Grocery list" },
  ]);
  assert.equal(d.length, 1);
  assert.equal(d[0].a, "a.md");
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const inboxIds: Record<string, string> = {};

test("inbox: queue in leverage order with counts on the dashboard", async () => {
  const img = join(dirs, "header.png");
  writeFileSync(img, PNG);
  const sb = new Switchboard({ root: home.root, store: new KeychainStore(kc.path) });
  try {
    inboxIds.low = (await sb.inboxSubmit({ title: "Low", summary: "s", options: ["a", "b"], harness: "hermes", priority: "p3" })).id;
    inboxIds.top = (await sb.inboxSubmit({ title: "Top", summary: "s", options: ["Ship (Recommended)", "Hold"], harness: "claude-code", priority: "p0", blockingCount: 4, artifacts: [{ path: img, caption: "new header" }] })).id;
    inboxIds.mid = (await sb.inboxSubmit({ title: "Mid", summary: "s", options: ["a", "b"], harness: "hermes", priority: "p1", project: "portfolio" })).id;
  } finally {
    sb.close();
  }
  const r = await call("GET", "/api/inbox");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.view, "open");
  assert.deepEqual(r.json.cards.map((c: any) => c.title), ["Top", "Mid", "Low"]);
  assert.deepEqual(r.json.counts, { open: 3, snoozed: 0, resolved: 0 });
  assert.equal(r.json.cards[0].artifacts[0].caption, "new header");
  assert.equal((await call("GET", "/api/inbox?view=bogus")).status, 400);
  assert.equal((await raw("GET", "/api/inbox")).status, 401, "inbox needs the token");
  const d = await call("GET", "/api/dashboard");
  assert.equal(d.json.inboxOpenCount, 3);
});

test("inbox: artifact served as an image, traversal and unknown names refused", async () => {
  const card = (await call("GET", "/api/inbox")).json.cards[0];
  const file = card.artifacts[0].file;
  const a = await call("GET", `/api/inbox/artifact/${card.id}/${file}`);
  assert.equal(a.status, 200);
  assert.equal(a.headers["content-type"], "image/png");
  assert.equal(a.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(a.bytes, PNG);
  assert.equal((await raw("GET", `/api/inbox/artifact/${card.id}/${file}`)).status, 401);
  for (const p of [
    `/api/inbox/artifact/${card.id}/..%2F..%2F..%2Fsecrets.manifest.yaml`,
    `/api/inbox/artifact/..%2F..%2Fmemory/x.png`,
    `/api/inbox/artifact/${card.id}/%2Fetc%2Fpasswd`,
    `/api/inbox/artifact/${card.id}/2-other.png`,
    `/api/inbox/artifact/${card.id}/../../index.db`,
  ]) {
    const r = await call("GET", p);
    assert.ok(r.status === 400 || r.status === 404, `${p} -> ${r.status}`);
    assert.equal(r.bytes.includes(Buffer.from("TEST_TOKEN")), false);
  }
});

test("inbox: snooze and decide (with save_rule) over the API", async () => {
  const z = await call("POST", `/api/inbox/${inboxIds.low}/snooze`, { until: "2h" });
  assert.equal(z.status, 200, z.text);
  assert.ok(z.json.snoozedUntil);
  assert.equal((await call("POST", `/api/inbox/${inboxIds.low}/snooze`, { until: "later" })).status, 400);
  assert.deepEqual((await call("GET", "/api/inbox?view=snoozed")).json.cards.map((c: any) => c.id), [inboxIds.low]);

  const leak = await call("POST", `/api/inbox/${inboxIds.top}/decide`, { decision: "1", feedback: `here ${VALUE}` });
  assert.equal(leak.status, 422);
  const d = await call("POST", `/api/inbox/${inboxIds.top}/decide`, { decision: "1", feedback: "Ship headers with the smaller font", save_rule: true });
  assert.equal(d.status, 200, d.text);
  assert.equal(d.json.card.status, "resolved");
  assert.equal(d.json.card.savedAsRule, true);
  const note = (await call("GET", `/api/memory/note?path=${encodeURIComponent(d.json.rule.path)}`)).json.note;
  assert.equal(note.type, "preference");
  assert.match(note.body, /smaller font/);
  assert.equal((await call("POST", `/api/inbox/${inboxIds.top}/decide`, { decision: "2" })).status, 409, "already resolved");
  assert.equal((await call("POST", `/api/inbox/ib_000000000000/decide`, { decision: "1" })).status, 404);
  assert.equal((await call("POST", `/api/inbox/..%2Fx/decide`, { decision: "1" })).status, 400);
  assert.equal((await call("POST", `/api/inbox/${inboxIds.mid}/decide`, {})).status, 400, "decision required");
  const plain = await call("POST", `/api/inbox/${inboxIds.mid}/decide`, { decision: "2" });
  assert.equal(plain.json.rule, null);
  assert.deepEqual((await call("GET", "/api/inbox")).json.counts, { open: 0, snoozed: 1, resolved: 2 });
});

test("inbox: embed mode is served by the same CSP-locked page", async () => {
  const r = await raw("GET", "/?embed=inbox");
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.match(String(r.headers["content-security-policy"]), /img-src 'self' data: blob:/);
  const js = (await raw("GET", "/app.js")).text;
  for (const needle of ["embed", "SpeechRecognition", "/api/inbox", "save_rule"]) assert.ok(js.includes(needle), needle);
});

test("no API response ever contained a secret value", async () => {
  // sweep every read endpoint once more, then grep everything collected during this file
  for (const p of ["/api/inbox", "/api/inbox?view=resolved", "/api/dashboard", "/api/memory", "/api/handoffs", "/api/skills", "/api/secrets", "/api/harnesses", "/api/git", "/api/harnesses/claude-code/diff"]) {
    assert.equal((await call("GET", p)).status, 200, p);
  }
  assert.ok(seen.length > 40);
  for (const v of [VALUE, ROTATED]) {
    for (const body of seen) {
      assert.equal(body.includes(v), false, "raw value leaked");
      assert.equal(body.includes(Buffer.from(v).toString("base64").slice(0, 20)), false, "base64 value leaked");
      assert.equal(body.includes(Buffer.from(v).toString("hex")), false, "hex value leaked");
    }
  }
});
