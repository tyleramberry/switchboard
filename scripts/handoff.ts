/**
 * Cross-agent handoff proof.
 *
 * Runs two SEPARATE client processes (this file re-executed with a role argument). Each
 * client spawns its own `switchboard mcp` server process over stdio, like two harnesses would.
 *   process A ("hermes"):      memory_write a handoff note, then exit.
 *   process B ("claude-code"): memory_search for it, memory_read it, then exit.
 * Then the reverse direction. PIDs are printed to show four distinct server processes.
 *
 * Usage: npm run handoff   (uses a temp Home unless SWITCHBOARD_HOME is set)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.js";
import { initHome } from "../src/home.js";

const SELF = fileURLToPath(import.meta.url);

async function writer(root: string, as: string, marker: string) {
  const c = await connect({ SWITCHBOARD_HOME: root }, as);
  const r = await c.call("memory_write", {
    title: `Handoff from ${as}`,
    body: `Working on the Switchboard demo. Next step: verify ${marker} from the other harness.`,
    type: "handoff",
    tags: ["switchboard", "handoff"],
    source: as,
  });
  console.log(`[${as}] client pid=${process.pid} server pid=${c.pid}`);
  console.log(`[${as}] memory_write -> ${r.isError ? "ERROR " : ""}${r.text.replace(/\s+/g, " ")}`);
  await c.close();
  if (r.isError) process.exit(1);
}

async function reader(root: string, as: string, marker: string) {
  const c = await connect({ SWITCHBOARD_HOME: root }, as);
  const s = JSON.parse((await c.call("memory_search", { query: marker })).text);
  console.log(`[${as}] client pid=${process.pid} server pid=${c.pid}`);
  console.log(`[${as}] memory_search "${marker}" -> ${s.results.length} hit(s)`);
  for (const h of s.results) console.log(`[${as}]   ${h.path}  source-title="${h.title}"  snippet=${JSON.stringify(h.snippet)}`);
  if (s.results.length !== 1) {
    await c.close();
    console.log(`[${as}] FAIL: expected exactly 1 hit`);
    process.exit(1);
  }
  const n = JSON.parse((await c.call("memory_read", { path: s.results[0].path })).text);
  console.log(`[${as}] memory_read -> type=${n.note.type} tags=${n.note.tags.join(",")} body=${JSON.stringify(n.note.body.trim())}`);
  await c.close();
}

function child(role: string, root: string, as: string, marker: string): number {
  const r = spawnSync(process.execPath, [SELF, role, root, as, marker], { encoding: "utf8" });
  process.stdout.write(r.stdout);
  if (r.stderr.trim()) process.stdout.write(r.stderr.split("\n").map((l) => `[${as} stderr] ${l}`).join("\n") + "\n");
  return r.status ?? 1;
}

async function orchestrate() {
  const ownHome = !process.env.SWITCHBOARD_HOME;
  const base = ownHome ? mkdtempSync(join(tmpdir(), "sb-handoff-")) : "";
  const root = process.env.SWITCHBOARD_HOME ?? join(base, "agent-home");
  initHome(root);
  console.log(`# Switchboard cross-agent handoff  ${new Date().toISOString()}`);
  console.log(`# Home: ${ownHome ? "<temp>/agent-home" : root}   orchestrator pid=${process.pid}`);
  let fail = 0;
  const m1 = "marker" + Math.random().toString(36).slice(2, 10);
  const m2 = "marker" + Math.random().toString(36).slice(2, 10);
  console.log(`\n## 1. hermes writes, claude-code finds (${m1})`);
  fail |= child("write", root, "hermes", m1);
  fail |= child("read", root, "claude-code", m1);
  console.log(`\n## 2. claude-code writes, hermes finds (${m2})`);
  fail |= child("write", root, "claude-code", m2);
  fail |= child("read", root, "hermes", m2);
  console.log(`\nRESULT: ${fail ? "FAIL" : "PASS"} (4 client processes, each with its own server process)`);
  if (ownHome) rmSync(base, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

const [role, root, as, marker] = process.argv.slice(2);
if (role === "write") await writer(root, as, marker);
else if (role === "read") await reader(root, as, marker);
else await orchestrate();
