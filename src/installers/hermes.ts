import { join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { Plan, SetupOptions, readOrNull, serverCommand, upsertBlock, startHereRule } from "./common.js";

/**
 * Hermes Agent (tested against a temp HERMES_HOME).
 * - config.yaml: mcp_servers.switchboard (stdio) + skills.external_dirs += Home/skills
 *   (external_dirs is read live, so new Home skills show up without re-running setup).
 * - SOUL.md: managed "start here" block. Hermes loads AGENTS.md only from the cwd, while SOUL.md
 *   in HERMES_HOME is loaded in every session, so that is where the global rule goes.
 */
export function planHermes(opts: SetupOptions): Plan {
  const dir = opts.configDir ?? process.env.HERMES_HOME ?? join(homedir(), ".hermes");
  const cfgPath = join(dir, "config.yaml");
  const soulPath = join(dir, "SOUL.md");
  const before = readOrNull(cfgPath);
  const doc = before ? YAML.parseDocument(before) : new YAML.Document({});
  if (doc.errors.length) throw new Error(`cannot parse ${cfgPath}: ${doc.errors[0].message}`);
  if (!doc.contents || !YAML.isMap(doc.contents)) doc.contents = doc.createNode({}) as any;
  const { command, args } = serverCommand();
  const want = { command, args, env: { SWITCHBOARD_HOME: opts.root }, timeout: 60 };
  const cur = doc.getIn(["mcp_servers", "switchboard"]);
  const curJs = cur && YAML.isNode(cur) ? (cur as any).toJSON() : cur;
  if (JSON.stringify(curJs) !== JSON.stringify(want)) doc.setIn(["mcp_servers", "switchboard"], doc.createNode(want));
  const skillsDir = join(opts.root, "skills");
  const ext = doc.getIn(["skills", "external_dirs"]);
  const list: string[] = ext && YAML.isSeq(ext) ? (ext as any).toJSON() : [];
  if (!list.includes(skillsDir)) {
    if (ext && YAML.isSeq(ext)) (ext as YAML.YAMLSeq).add(skillsDir);
    else doc.setIn(["skills", "external_dirs"], doc.createNode([skillsDir]));
  }
  let after = String(doc);
  if (before !== null && after === before) after = before;
  const soulBefore = readOrNull(soulPath);
  return {
    harness: "hermes",
    status: "tested",
    files: [
      { path: cfgPath, before, after },
      { path: soulPath, before: soulBefore, after: upsertBlock(soulBefore, startHereRule(opts.root)) },
    ],
    links: [],
    notes: [`config dir: ${dir}`],
  };
}
