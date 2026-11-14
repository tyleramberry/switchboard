# Switchboard

One agent setup (memory, skills, secrets) for every harness.

Switchboard keeps your agent context in one local directory ("Home") and gives every
agent harness (Hermes, Claude Code, Grokbot, Buzz, Codex) the same door into it: a
local stdio MCP server. Secrets live in the macOS Keychain and are *used* through
`secret_run`; no tool ever returns a secret value.

Status: Sprint 5 build, macOS only, local only. See `docs/overnight-report.md` for
what is verified and what is not.

## Quick start

```sh
npm install && npm run build
export SWITCHBOARD_HOME=~/agent-home        # default if unset
node dist/src/cli.js init                    # create Home
node dist/src/cli.js setup hermes --dry-run  # show the diff, change nothing
node dist/src/cli.js setup hermes            # apply (backs up what it edits)
node dist/src/cli.js mcp                     # the MCP server (harnesses run this)
```

## Layout of Home

```
$SWITCHBOARD_HOME/
  AGENTS.md               who you are and how you work; every harness reads this first
  memory/                 markdown notes with frontmatter (type, tags, date)
  skills/<name>/SKILL.md  standard skill folders shared by all harnesses
  secrets.manifest.yaml   secret NAMES, purposes and allowlists. Never values.
  .switchboard/           derived state (SQLite FTS index); safe to delete
```

## Docs

- `docs/design.md` - architecture, threat model, dependencies
- `docs/decisions.md` - decisions made during the build
- `docs/harnesses.md` - per-harness setup, tested vs untested
- `redteam/RESULTS.md` - the 10 attacks and their real output
- `WRITEUP.md` - sprint write-up (draft)
