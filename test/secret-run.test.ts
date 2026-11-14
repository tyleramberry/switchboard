import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { KeychainStore } from "../src/secrets/keychain.js";
import { Switchboard } from "../src/server.js";
import { checkCommand, PolicyError } from "../src/secret-run.js";
import { parseManifest } from "../src/manifest.js";
import { tempHome, tempKeychain, writeTestManifest } from "./helpers.js";

const VALUE = "sb-dummy-" + "c0ffee".repeat(3);
let kc: ReturnType<typeof tempKeychain>;
let home: ReturnType<typeof tempHome>;
let sb: Switchboard;

before(async () => {
  kc = tempKeychain();
  home = tempHome();
  writeTestManifest(home.root);
  const store = new KeychainStore(kc.path);
  await store.set({ name: "TEST_TOKEN", service: "switchboard-test", account: "TEST_TOKEN" }, VALUE);
  sb = new Switchboard({ root: home.root, store });
});

after(() => {
  sb?.close();
  home?.cleanup();
  kc?.cleanup();
});

test("keychain round trip in a temp keychain", async () => {
  const s = new KeychainStore(kc.path);
  const ref = { name: "X", service: "switchboard-test", account: "rt" };
  assert.equal(await s.get(ref), null);
  await s.set(ref, 'with "quotes" and \\ backslash');
  assert.equal(await s.get(ref), 'with "quotes" and \\ backslash');
  assert.equal(await s.delete(ref), true);
  assert.equal(await s.has(ref), false);
});

test("secret_list never includes the value", async () => {
  const out = JSON.stringify(await sb.secretList());
  assert.equal(out.includes(VALUE), false);
  assert.match(out, /"present": ?true/);
});

test("secret_run injects the env var and scrubs it", async () => {
  const r = await sb.secretRun({ name: "TEST_TOKEN", argv: ["/usr/bin/printenv", "TEST_TOKEN"] });
  assert.equal(r.exit_code, 0);
  assert.equal(r.stdout.trim(), "[REDACTED:secret]");
  assert.equal(r.redactions, 1);
});

test("no shell interpolation: $VAR stays literal", async () => {
  const r = await sb.secretRun({ name: "TEST_TOKEN", argv: ["/bin/echo", "$TEST_TOKEN; `id`"] });
  assert.equal(r.stdout.trim(), "$TEST_TOKEN; `id`");
});

test("child env is minimal (only PATH, HOME, TMPDIR, LANG, the secret)", async () => {
  const r = await sb.secretRun({ name: "TEST_TOKEN", argv: ["/usr/bin/printenv", "HOME"] });
  assert.match(r.stdout, /sb-run-/);
});

test("non-allowlisted program and argument are refused", async () => {
  await assert.rejects(sb.secretRun({ name: "TEST_TOKEN", argv: ["/bin/cat", "/etc/hosts"] }), /not allowlisted/);
  await assert.rejects(sb.secretRun({ name: "TEST_TOKEN", argv: ["/usr/bin/printenv", "USER"] }), /argument 1 not allowed/);
  await assert.rejects(sb.secretRun({ name: "TEST_TOKEN", argv: ["printenv"] }), /not allowlisted/);
});

test("timeout kills the child", async () => {
  const t0 = Date.now();
  const r = await sb.secretRun({ name: "TEST_TOKEN", argv: ["/bin/sleep", "30"] });
  assert.equal(r.timed_out, true);
  assert.ok(Date.now() - t0 < 10_000);
});

test("http host allowlist and https-only", async () => {
  await assert.rejects(sb.secretRun({ name: "TEST_TOKEN", http: { url: "https://evil.test/x" } }), /host not allowlisted/);
  await assert.rejects(sb.secretRun({ name: "TEST_TOKEN", http: { url: "http://httpbin.org/get" } }), /only https/);
  await assert.rejects(sb.secretRun({ name: "TEST_TOKEN", http: { url: "https://httpbin.org.evil.test/" } }), /host not allowlisted/);
  await assert.rejects(
    sb.secretRun({ name: "TEST_TOKEN", http: { url: "https://httpbin.org/get", headers: { authorization: "x" } } }),
    /set by Switchboard/,
  );
});

test("URL arguments are host-checked", () => {
  const m = parseManifest(`secrets:
  - name: T
    hosts: [api.example.com]
    commands:
      - program: /usr/bin/curl
        args: ["https://.*"]`);
  assert.doesNotThrow(() => checkCommand(m.secrets[0], ["/usr/bin/curl", "https://api.example.com/v1"]));
  assert.throws(() => checkCommand(m.secrets[0], ["/usr/bin/curl", "https://evil.test/v1"]), PolicyError);
  assert.throws(() => checkCommand(m.secrets[0], ["/usr/bin/curl", "https://api.example.com@evil.test/"]), PolicyError);
});

test("manifest refuses interpreters and value fields", () => {
  assert.throws(() => parseManifest(`secrets:\n  - name: T\n    commands: [{program: /bin/sh, args: [".*"]}]`), /interpreter/);
  assert.throws(() => parseManifest(`secrets:\n  - name: T\n    commands: [{program: /usr/bin/python3}]`), /interpreter/);
  assert.throws(() => parseManifest(`secrets:\n  - name: T\n    value: hunter2`), /must not contain/);
  assert.throws(() => parseManifest(`secrets:\n  - name: T\n    commands: [{program: curl}]`), /absolute/);
});

test("memory writes containing the secret (or an encoding) are refused", async () => {
  assert.match(String(await sb.memoryLeakReason(`note ${VALUE}`)), /stored secret/);
  assert.match(String(await sb.memoryLeakReason(Buffer.from(VALUE).toString("base64"))), /stored secret/);
  assert.match(String(await sb.memoryLeakReason("ghp_" + "a".repeat(36))), /credential pattern/);
  assert.equal(await sb.memoryLeakReason("plain note"), null);
});

test("curl exfil channels are refused", async () => {
  const m = parseManifest(`secrets:
  - name: T
    hosts: [api.example.com]
    commands:
      - program: /usr/bin/curl
        args: [".*"]`);
  const s = m.secrets[0];
  assert.doesNotThrow(() => checkCommand(s, ["/usr/bin/curl", "-s", "https://api.example.com/v1"]));
  assert.throws(() => checkCommand(s, ["/usr/bin/curl", "-x", "127.0.0.1:8888", "http://api.example.com/"]), /not allowed/);
  assert.throws(() => checkCommand(s, ["/usr/bin/curl", "-K", "/tmp/cfg", "https://api.example.com/"]), /not allowed/);
  assert.throws(() => checkCommand(s, ["/usr/bin/curl", "https://api.example.com/", "127.0.0.1:8888"]), /host not allowlisted/);
  assert.throws(() => checkCommand(s, ["/usr/bin/curl", "httpbin.org"]), /host not allowlisted/);
  assert.doesNotThrow(() => checkCommand(s, ["/usr/bin/curl", "https://api.example.com/x", "-H", "Accept: application/json"]));
  assert.throws(() => parseManifest(`secrets:\n  - name: T\n    commands: [{program: /usr/bin/ssh, args: [".*"]}]`), /interpreter/);
  assert.throws(() => parseManifest(`secrets:\n  - name: T\n    commands: [{program: /usr/bin/nc, args: [".*"]}]`), /interpreter/);
});
