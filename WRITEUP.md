# Switchboard: Sprint 5 Write-up

## The problem

Moving between agent harnesses (Hermes, Claude Code, and eventually Grokbot, Buzz, Codex)
means re-explaining who I am, re-wiring keys, and re-copying memory. The worst part is
secrets: they sit in `.env` files where any agent can read them directly.

## What Switchboard is

One local "Home" directory (`~/agent-home`: markdown memory, `SKILL.md` skills, `AGENTS.md`,
and a `secrets.manifest.yaml` with names and allowlists but never values) paired with one
local stdio MCP server (`switchboard-mcp`) that every harness points at. Secrets live in the
macOS Keychain and are *used* through `secret_run`, which injects them into an allowlisted
child process (env var) or an allowlisted HTTPS call (header) and scrubs every encoding it
knows from the output. No tool returns a value. One command per harness
(`switchboard setup <harness>`) wires a harness to Home.

During the sprint, Switchboard also grew two operational layers on top of the core kit:
- **Local Web UI (`switchboard ui`):** a localhost-only vanilla HTML/CSS/JS control panel
  (bound to `127.0.0.1`, per-launch random token header, Host/Origin/CSP guards, dark mode,
  `Cmd+K` palette) over the exact same modules as the MCP server. No screen or endpoint ever
  returns a secret value; values are write-only, manifest edits run through `doctor` and
  re-pin, and Home git commits only happen when you click Commit changes.
- **Decision Inbox + nightly distillation (`switchboard inbox`, `npm run distill`):** a
  SQLite-backed queue (`inbox.db`) for short human-in-the-loop decision cards, driven by a
  zero-MCP CLI (zero extra schema tokens in agent prompts), a single-card focus Inbox view
  with keyboard shortcuts, dictation, and embed mode, a `switchboard-inbox` skill, and a
  nightly distillation script that turns resolved decisions and overrides into memory rules
  and opens conflict cards when a decision contradicts an existing rule.

## Design choices that mattered

- **Markdown + SQLite FTS5 (built-in `node:sqlite`) as memory.** The files are the truth;
  the index is a cache re-synced by mtime before every search. That is why handoff is live:
  one server process writes a file, and the next process's search sees it immediately. No
  daemon, no vector DB.
- **No shell, ever, for secrets.** `secret_run` takes argv and spawns with `shell: false`,
  so `$VAR`, backticks, and `;` stay literal bytes. Allowlists are per-secret: exact absolute
  program paths, every argument must match a regex, URLs and bare hosts are checked against
  a host allowlist, and curl's proxy/config/redirect flags are denied outright.
- **Values never touch argv.** Keychain writes go through `security -i` on stdin; the
  injected value travels only as the child's env var.
- **Defense in depth:** every MCP tool response and every Web UI API response (including
  errors) is scrubbed against every stored value, so even a hand-planted file containing a
  secret is redacted when read back through Switchboard.
- **Zero-dependency UI and zero-MCP inbox.** The Web UI adds zero runtime packages, and the
  Decision Inbox uses a CLI + skill instead of MCP tools so it adds zero token overhead to
  every agent turn.

## What it cost

- **Timeline:** built across four focused pushes from Nov 14 to Nov 21:
  1. Nov 14: initial overnight build of Home, MCP server, Keychain store, installers, and
     first red-team pass (~40 min wall clock).
  2. Nov 16: attended Air session fixing all three red-team findings (F1, F2, F3), adding
     `switchboard pin` and `switchboard doctor`, installing on real `~/.hermes` and
     `~/.claude`, and running the live model-driven handoff (Hermes -> Claude Code -> Hermes).
  3. Nov 19 to 20: fresh install and verification on the Mac mini, plus Web UI v1.
  4. Nov 21: SQLite Decision Inbox, zero-MCP CLI, single-card focus Inbox UI, and nightly
     memory distillation.
- **Test coverage:** 92/92 automated tests passing (`npm test`), plus 10/10 red-team attacks
  passing (`npm run redteam`).
- **Dependencies:** 3 runtime (`@modelcontextprotocol/sdk`, `zod`, `yaml`) + 2 dev
  (`typescript`, `@types/node`). SQLite comes from Node's built-in `node:sqlite`, Keychain
  from `/usr/bin/security` plus a small compiled C helper, diffs from `/usr/bin/diff`, and
  tests from `node:test`.

## What failed (red team: 10 of 10 pass after fixes, 1 documented residual)

Full log with real output: `redteam/RESULTS.md` (re-run 2026-11-16 on the Air). The first
pass went 8/10 and surfaced three real security findings, all fixed and re-verified:

- **F1 (unknown encodings under an interpreter allowlist): FIXED 2026-11-16.** The scrubber
  now covers rot13 and rot13-of-reversed, so the demonstrated leak is gone (attack 3 passes).
  The deeper lesson stands: if you allowlist an interpreter (opt-in flag), a secret can leave
  in any transform the scrubber does not know. The default profile refuses interpreters,
  which blocks the whole class; the allowlist is the control and scrubbing is a seatbelt.
- **F3 (manifest tampering): FIXED 2026-11-16.** `switchboard pin` records a sha256 of the
  manifest next to it (inside Home's git); every tool call verifies the pin and fails closed
  if the manifest changed. Attack 5 includes the tamper probe: an agent that widens its own
  allowlist gets nothing. Unpinned Homes still work but warn.
- **F2 (Keychain ACL trusted `/usr/bin/security`): FIXED 2026-11-16.** Items created through
  `/usr/bin/security` defaulted to an ACL trusting that binary, so any same-user process
  could read the value directly. Reads and deletes now go through a tiny compiled helper
  (`src/secrets/keychain-helper.ts`) that is ad-hoc code-signed, and items are created with
  `-T` trusting only that helper. Verified in attack 8: a direct
  `security find-generic-password` read is refused unattended, and overwriting the helper at
  its path breaks its cdhash binding and is refused too.
  **Residual, recorded honestly:** the ACL binds to the helper's code identity, not its
  path, so an intact copy of the helper exec'd by a same-user process still returns the
  value. Same-user arbitrary code remains out of scope: Switchboard protects the MCP door
  and common un-audited paths, not a shell-level agent. The real fix is the 1Password CLI
  backend with biometric gating (Sprint 6).
- **Also verified:** `ps eww` / `ps -E` could not read a running child's env on this macOS
  build, and the audit log, SQLite index, and git history never contained any secret value.

## Unverified / honest gaps

- **Red-team attacker model:** No LLM was in the loop during the scripted red team. The
  attacker is modeled as a fully obedient tool caller (stronger in that it never refuses an
  injection, weaker in that it does not invent novel multi-step exploits). Separately, a real
  model-driven handoff (Hermes -> Claude Code -> Hermes) ran live on the Air on Nov 16 and
  verified cross-agent memory read/write.
- **Untested harnesses:** Hermes and Claude Code are installed and verified on both the Air
  and the Mac mini. Codex and Grokbot installers are written from their docs and unit-tested
  on temp configs, but not tested against live installs. Buzz is a documented manual path
  (its agents run as Claude Code / Codex / Goose via `buzz-acp`).
- **Skill discovery caveat:** Hermes reads `Home/skills` live via `skills.external_dirs`.
  Claude Code uses one symlink per skill, so adding a new skill requires re-running
  `switchboard setup claude-code` for native discovery (though MCP `skill_list` sees it
  immediately).
- **Memory migration:** Starter memory, handoff notes, and core skills are live in
  `~/agent-home`; migrating older personal notes beyond the starter set still needs an
  attended pass.

## What Sprint 6 should take on

1. **1Password CLI backend:** replace the same-user Keychain helper residual with biometric
   gating (the `SecretStore` seam is already in place via `OnePasswordStore`).
2. **Git sync between Macs:** turn `~/agent-home` into a private remote git repo with a
   `switchboard sync` command or automatic hooks so the Air and Mac mini stay in lockstep.
3. **Live-test remaining harnesses:** verify the Codex and Grokbot installers against real
   installs and document any config-format drift.
4. **Activity log in the Web UI:** surface the audit log and recent `secret_run` / memory
   calls in the UI (deferred from UI v1).
