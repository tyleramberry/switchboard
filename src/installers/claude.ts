import { join } from "node:path";
import { homedir } from "node:os";
import { Plan, SetupOptions, readOrNull, serverCommand, upsertBlock, startHereRule, planSkillLinks } from "./common.js";

/**
 * Claude Code (tested against a temp CLAUDE_CONFIG_DIR).
 * - MCP: user-scope `mcpServers.switchboard` in the global config JSON. With CLAUDE_CONFIG_DIR set,
 *   Claude keeps it at $CLAUDE_CONFIG_DIR/.claude.json (verified with `claude mcp add -s user`);
 *   with the default dir it is ~/.claude.json.
 * - Instructions: managed block in <dir>/CLAUDE.md that imports Home/AGENTS.md with `@path`.
 * - Skills: one symlink per Home skill in <dir>/skills. New Home skills need a re-run for the
 *   native list; they are visible immediately through the MCP skill_list tool.
 */
export function planClaude(opts: SetupOptions): Plan {
  const explicit = opts.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  const dir = explicit ?? join(homedir(), ".claude");
  const jsonPath = explicit ? join(explicit, ".claude.json") : join(homedir(), ".claude.json");
  const before = readOrNull(jsonPath);
  let cfg: any = {};
  if (before) {
    try {
      cfg = JSON.parse(before);
    } catch (e) {
      throw new Error(`cannot parse ${jsonPath}: ${(e as Error).message}`);
    }
  }
  const { command, args } = serverCommand();
  const want = { type: "stdio", command, args, env: { SWITCHBOARD_HOME: opts.root } };
  let after = before ?? "";
  if (JSON.stringify(cfg.mcpServers?.switchboard) !== JSON.stringify(want)) {
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), switchboard: want };
    after = JSON.stringify(cfg, null, 2) + "\n";
  }
  const mdPath = join(dir, "CLAUDE.md");
  const mdBefore = readOrNull(mdPath);
  const notes = [`config dir: ${dir}`, `mcp config: ${jsonPath}`];
  const links = planSkillLinks(opts.root, join(dir, "skills"), notes);
  return {
    harness: "claude-code",
    status: "tested",
    files: [
      { path: jsonPath, before, after },
      {
        path: mdPath,
        before: mdBefore,
        after: upsertBlock(mdBefore, startHereRule(opts.root, { importLine: `@${join(opts.root, "AGENTS.md")}` })),
      },
    ],
    links,
    notes,
  };
}
