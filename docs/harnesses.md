# Harness setup

`switchboard setup <harness> [--config-dir <dir>] [--dry-run]`

Every installer: prints a unified diff, backs up each existing file it edits to
`<file>.switchboard-bak-<timestamp>`, writes only a managed block / its own key, and is
idempotent (a re-run prints `no changes: already set up`). It refuses to run until Home exists.

| Harness | Status | MCP registration | Instructions ("start here") | Skills |
|---|---|---|---|---|
| Hermes | **tested** (v0.23.0, temp `HERMES_HOME`) | `config.yaml` → `mcp_servers.switchboard` (stdio) | managed block in `$HERMES_HOME/SOUL.md` | `skills.external_dirs` += `Home/skills` (live: new skills appear without re-running) |
| Claude Code | **tested** (2.1.294, temp `CLAUDE_CONFIG_DIR`) | user scope `mcpServers.switchboard` in `$CLAUDE_CONFIG_DIR/.claude.json` (default `~/.claude.json`) | managed block in `<dir>/CLAUDE.md` that imports `@Home/AGENTS.md` | one symlink per skill in `<dir>/skills` (re-run setup after adding a skill; MCP `skill_list` sees it immediately) |
| Codex | **UNTESTED** (not installed) | managed block in `$CODEX_HOME/config.toml` (`[mcp_servers.switchboard]` + `.env`) | managed block in `$CODEX_HOME/AGENTS.md` | symlinks in `$CODEX_HOME/skills` |
| Grokbot | **UNTESTED** (not installed) | `~/.grokbot/grokbot.json` → `mcp.servers.switchboard`; or `grokbot mcp set switchboard '<json>'` (printed by setup) | manual: paste the start-here rule into the bot's instructions | manual: use MCP `skill_list`/`skill_get` |
| Buzz | **manual** | Buzz runs agents via buzz-acp as Claude Code / Codex / Goose; run `setup claude-code` or `setup codex` as the OS user that runs buzz-acp | via the underlying harness | via the underlying harness |

"Tested" means: the installer ran against an empty temp config dir, the harness's own CLI
then reported the server connected with 7 tools (`hermes mcp test switchboard`,
`claude mcp get switchboard`), and Hermes listed the Home skills. See
`docs/evidence/installers.txt`. It does **not** mean a model-driven agent turn ran: the
temp Claude config is not logged in (`Not logged in · Please run /login`), and a live
Hermes turn in a temp `HERMES_HOME` was not attempted so no model spend or credential copy
was needed. The cross-process handoff is proven at the MCP level instead
(`docs/evidence/handoff.txt`).

## Why Hermes gets SOUL.md and not AGENTS.md

Hermes loads `AGENTS.md` only from the current working directory; `SOUL.md` in
`HERMES_HOME` is loaded in every session. The start-here block therefore goes into SOUL.md
and names Home's AGENTS.md by path. Hermes scans context files for prompt injection; the
block is plain instructions and passed.

## Sources for untested formats

- Codex: `config.toml` `[mcp_servers.<id>]` with `command`, `args`, `env` table,
  `startup_timeout_sec`, `tool_timeout_sec`; global `AGENTS.md` in `CODEX_HOME`
  (Codex docs and community installers, reached via web search on the build night).
- Grokbot: `docs/cli/mcp.md` in the GrokBot repo (`grokbot mcp add|set`, config at
  `~/.grokbot/grokbot.json`, servers under `mcp.servers`). If your file is JSON5,
  setup refuses and prints the `grokbot mcp set` command instead.
- Buzz: block/buzz `AGENTS.md` and third-party guides: buzz-acp delegates to
  Claude Code / Codex / Goose; MCP pass-through is not documented.

## Running against your real config

Drop `--config-dir`. Run `--dry-run` first and read the diff. Backups sit next to each file.
