import { join } from "node:path";
import { homedir } from "node:os";
import { Plan, SetupOptions, readOrNull, serverCommand, upsertBlock, startHereRule, planSkillLinks } from "./common.js";

const TOML_START = "# switchboard:start (managed by `switchboard setup codex`)";
const TOML_END = "# switchboard:end";

function tomlStr(s: string): string {
  return JSON.stringify(s); // TOML basic strings accept JSON-style escapes for these inputs
}

/**
 * Codex CLI. UNTESTED: codex is not installed on the build machine.
 * Format from Codex docs / ecosystem installers: $CODEX_HOME/config.toml `[mcp_servers.<id>]`
 * with command/args and a `[mcp_servers.<id>.env]` table; global instructions in
 * $CODEX_HOME/AGENTS.md (no include syntax, so the rule names the Home AGENTS.md path).
 * Skills: symlinked into $CODEX_HOME/skills (newer Codex builds read ~/.agents/skills; see docs/harnesses.md).
 */
export function planCodex(opts: SetupOptions): Plan {
  const dir = opts.configDir ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const tomlPath = join(dir, "config.toml");
  const before = readOrNull(tomlPath);
  const stripped = (before ?? "").replace(new RegExp(`${TOML_START.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")}[\\s\\S]*?${TOML_END}\\n?`), "");
  if (/^\s*\[mcp_servers\.switchboard\]/m.test(stripped)) {
    throw new Error(`${tomlPath} already defines [mcp_servers.switchboard] outside Switchboard's managed block; remove it first`);
  }
  const { command, args } = serverCommand();
  const block = [
    TOML_START,
    "[mcp_servers.switchboard]",
    `command = ${tomlStr(command)}`,
    `args = [${args.map(tomlStr).join(", ")}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 120",
    "",
    "[mcp_servers.switchboard.env]",
    `SWITCHBOARD_HOME = ${tomlStr(opts.root)}`,
    TOML_END,
  ].join("\n");
  const after = upsertBlock(before, block.split("\n").slice(1, -1).join("\n"), TOML_START, TOML_END);
  const mdPath = join(dir, "AGENTS.md");
  const mdBefore = readOrNull(mdPath);
  const notes = [`config dir: ${dir}`, "UNTESTED: codex is not installed on this machine"];
  return {
    harness: "codex",
    status: "UNTESTED",
    files: [
      { path: tomlPath, before, after },
      { path: mdPath, before: mdBefore, after: upsertBlock(mdBefore, startHereRule(opts.root)) },
    ],
    links: planSkillLinks(opts.root, join(dir, "skills"), notes),
    notes,
  };
}
