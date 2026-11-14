import { join } from "node:path";
import { homedir } from "node:os";
import { Plan, SetupOptions, readOrNull, serverCommand } from "./common.js";

/**
 * Grokbot. UNTESTED: grokbot is not installed on the build machine.
 * Format from the GrokBot docs (docs/cli/mcp.md): config at ~/.grokbot/grokbot.json, saved MCP
 * servers under `mcp.servers.<name>` as `{command, args, env}`; the supported CLI equivalent is
 *   grokbot mcp set switchboard '{"command":"...","args":[...],"env":{...}}'
 * The docs do not describe a custom global-instructions path or a shared skills dir, so those
 * are a documented manual step (docs/harnesses.md).
 */
export function planGrokbot(opts: SetupOptions): Plan {
  const dir = opts.configDir ?? join(homedir(), ".grokbot");
  const path = join(dir, "grokbot.json");
  const before = readOrNull(path);
  let cfg: any = {};
  if (before) {
    try {
      cfg = JSON.parse(before);
    } catch {
      throw new Error(
        `${path} is not plain JSON (it may be JSON5). Use the manual path instead:\n  ${manualCommand(opts.root)}`,
      );
    }
  }
  const { command, args } = serverCommand();
  const want = { command, args, env: { SWITCHBOARD_HOME: opts.root } };
  let after = before ?? "";
  if (JSON.stringify(cfg?.mcp?.servers?.switchboard) !== JSON.stringify(want)) {
    cfg.mcp = { ...(cfg.mcp ?? {}), servers: { ...(cfg.mcp?.servers ?? {}), switchboard: want } };
    after = JSON.stringify(cfg, null, 2) + "\n";
  }
  return {
    harness: "grokbot",
    status: "UNTESTED",
    files: [{ path, before, after }],
    links: [],
    notes: [
      `config dir: ${dir}`,
      "UNTESTED: grokbot is not installed on this machine",
      "instructions + skills: manual (see docs/harnesses.md); paste the start-here rule into your bot's instructions",
      `CLI alternative: ${manualCommand(opts.root)}`,
    ],
  };
}

export function manualCommand(root: string): string {
  const { command, args } = serverCommand();
  const json = JSON.stringify({ command, args, env: { SWITCHBOARD_HOME: root } });
  return `grokbot mcp set switchboard '${json}'`;
}
