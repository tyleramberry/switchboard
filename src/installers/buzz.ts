import { Plan, SetupOptions } from "./common.js";

/**
 * Buzz (block/buzz). MANUAL path, UNTESTED: buzz is not installed on the build machine.
 * Buzz does not run its own model loop for coding agents: buzz-acp runs each agent as Claude Code,
 * Codex or Goose. MCP servers and instructions are configured in that underlying harness, as the
 * OS user that runs buzz-acp. So `setup buzz` changes nothing itself and prints the steps.
 */
export function planBuzz(opts: SetupOptions): Plan {
  return {
    harness: "buzz",
    status: "manual",
    files: [],
    links: [],
    notes: [
      "Buzz agents run through buzz-acp as Claude Code, Codex or Goose; wire the underlying harness:",
      `  as the OS user that runs buzz-acp: SWITCHBOARD_HOME=${opts.root} switchboard setup claude-code`,
      `  and/or:                            SWITCHBOARD_HOME=${opts.root} switchboard setup codex`,
      "  Goose: add a stdio extension running `switchboard mcp` (not automated).",
      "Then in a Buzz channel ask the agent to call skill_list to confirm the tools are passed through.",
      "UNTESTED: Buzz's docs do not say whether buzz-acp forwards the harness's own MCP servers.",
    ],
  };
}
