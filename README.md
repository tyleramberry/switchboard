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
node dist/src/cli.js pin                     # pin the secrets manifest (tamper-proofing)
node dist/src/cli.js doctor                 # lint the manifest (errors on interpreter + catch-all allowlists)
node dist/src/cli.js mcp                     # the MCP server (harnesses run this)
node dist/src/cli.js ui                      # local web UI (opens http://127.0.0.1:7337/?token=...)
```

## Web UI

`switchboard ui [--port N] [--no-open]` starts a local control panel over the same modules the
MCP server uses: dashboard (doctor, pin state, Home git status, needs-attention list), memory
browser and editor, handoffs, skills library, secrets manager and harness setup.

- Bound to 127.0.0.1 only. Each launch prints a URL with a random token; the page keeps it and
  sends it as a header on every API call. Requests with another Host or a cross-origin Origin
  are refused.
- No screen and no endpoint returns a secret value. Values are write-only (set or rotate);
  every API response passes through the same scrubber as the MCP tools.
- Manifest edits are validated by the parser and doctor (errors reject the save), then the
  manifest is re-pinned. Memory and skill writes go through the memory_write secret scan.
- Nothing is committed to Home's git repo unless you press Commit changes.
- Plain HTML, CSS and vanilla JS in `ui/public/`; no framework, no bundler, no new
  dependencies. Cmd+K opens a palette to jump to sections, notes and skills.


## Layout of Home

```
$SWITCHBOARD_HOME/
  AGENTS.md               who you are and how you work; every harness reads this first
  memory/                 markdown notes with frontmatter (type, tags, date)
  skills/<name>/SKILL.md  standard skill folders shared by all harnesses
  secrets.manifest.yaml   secret NAMES, purposes and allowlists. Never values.
  secrets.manifest.sha256 optional pin (`switchboard pin`): tampering then fails closed
  .switchboard/           derived state (SQLite FTS index); safe to delete
```

## Docs

- `docs/design.md` - architecture, threat model, dependencies
- `docs/decisions.md` - decisions made during the build
- `docs/harnesses.md` - per-harness setup, tested vs untested
- `redteam/RESULTS.md` - the 10 attacks and their real output
- `WRITEUP.md` - sprint write-up (draft)
