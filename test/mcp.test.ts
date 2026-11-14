import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { KeychainStore } from "../src/secrets/keychain.js";
import { connect, Connected } from "../scripts/mcp-client.js";
import { tempHome, tempKeychain, writeTestManifest } from "./helpers.js";

const VALUE = "sb-dummy-mcp-" + "beef".repeat(4);
let kc: ReturnType<typeof tempKeychain>;
let home: ReturnType<typeof tempHome>;
let c: Connected;

before(async () => {
  kc = tempKeychain();
  home = tempHome();
  writeTestManifest(home.root);
  await new KeychainStore(kc.path).set({ name: "TEST_TOKEN", service: "switchboard-test", account: "TEST_TOKEN" }, VALUE);
  c = await connect({ SWITCHBOARD_HOME: home.root, SWITCHBOARD_KEYCHAIN: kc.path });
});

after(async () => {
  await c?.close();
  home?.cleanup();
  kc?.cleanup();
});

test("server exposes exactly the seven tools", async () => {
  const { tools } = await c.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "memory_read", "memory_search", "memory_write", "secret_list", "secret_run", "skill_get", "skill_list",
  ]);
});

test("memory round trip over MCP", async () => {
  const w = await c.call("memory_write", { title: "MCP round trip", body: "pelican handoff", source: "test" });
  assert.equal(w.isError, false, w.text);
  const path = JSON.parse(w.text).path;
  const s = JSON.parse((await c.call("memory_search", { query: "pelican" })).text);
  assert.equal(s.results[0].path, path);
  const r = JSON.parse((await c.call("memory_read", { path })).text);
  assert.match(r.note.body, /pelican/);
});

test("skills over MCP", async () => {
  const l = JSON.parse((await c.call("skill_list")).text);
  assert.ok(l.some((s: any) => s.name === "switchboard-handoff"));
  const g = await c.call("skill_get", { name: "switchboard-handoff" });
  assert.match(g.text, /memory_write/);
});

test("no tool response contains the value", async () => {
  const outs = [
    await c.call("secret_list"),
    await c.call("secret_run", { name: "TEST_TOKEN", argv: ["/usr/bin/printenv", "TEST_TOKEN"] }),
    await c.call("memory_write", { title: "leak", body: `token is ${VALUE}` }),
    await c.call("secret_run", { name: "TEST_TOKEN", argv: ["/bin/echo", VALUE] }),
  ];
  for (const o of outs) assert.equal(o.text.includes(VALUE), false, o.text);
  assert.equal(outs[2].isError, true);
  assert.match(outs[2].text, /refused/);
});
