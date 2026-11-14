# Switchboard — Sprint 5 write-up (DRAFT; Tyler, edit freely)

## The problem

Moving between agent harnesses (Hermes, Claude Code, and eventually Grokbot, Buzz, Codex)
means re-explaining who I am, re-wiring keys, and re-copying memory. Worst part: secrets
sit in `.env` files where every agent can read them.

## What Switchboard is

One local "Home" directory (markdown memory, SKILL.md skills, AGENTS.md, a
secrets.manifest.yaml with names and allowlists but never values) and one stdio MCP server
that every harness points at. Secrets live in the macOS Keychain and are *used* through
`secret_run`, which injects them into an allowlisted child process (env var) or an
allowlisted HTTPS call (header) and scrubs every encoding it knows from the output. No
tool returns a value. One command per harness (`switchboard setup <harness>`) wires a
harness to Home.

## Design choices that mattered

- **Markdown + SQLite FTS5 (built-in `node:sqlite`) as memory.** The files are the truth;
  the index is a cache re-synced by mtime before every search. That is why handoff is live:
  one server process writes a file, the next process's search sees it. No daemon, no
  vector DB.
- **No shell, ever, for secrets.** `secret_run` takes argv and spawns with `shell: false`,
  so `$VAR`, backticks and `;` are literal bytes. Allowlists are per-secret: exact absolute
  program paths, every argument must match a regex, URLs and bare hosts are checked against
  a host allowlist, curl's proxy/config/redirect flags are denied outright.
- **Values never touch argv.** Keychain writes go through `security -i` on stdin; the
  injected value travels only as the child's env var.
- **Defense in depth:** every tool response (including errors) is scrubbed against every
  stored value, so even a hand-planted file containing a secret is redacted when read back
  through the tools.

## What it cost

- Wall clock: one unattended overnight session (2026-11-14, roughly 40 minutes of build
  time up to this draft). Token spend: not visible to the build agent — unknown.
- Dependencies: 3 runtime (MCP SDK, zod, yaml) + 2 dev (typescript, @types/node). SQLite
  comes from Node itself, keychain from `/usr/bin/security`, diffs from `/usr/bin/diff`,
  tests from `node:test`.

## What failed (red team: 8 of 10 pass, 2 honest findings)

Full log with real output: `redteam/RESULTS.md`.

- **F1 — unknown encodings.** If you allowlist an interpreter (opt-in flag), the secret can
  leave in any transform the scrubber doesn't know; rot13 was demonstrated. The default
  profile refuses interpreters, which blocks the whole class. Lesson: the allowlist is the
  control; scrubbing is a seatbelt.
- **F2 — the Keychain is not a boundary.** Items created through `/usr/bin/security` have
  an ACL that trusts that binary, so any same-user process (i.e. an agent with a shell tool)
  can read the value directly, bypassing Switchboard. I could not fix this tonight: a
  `-T ""` item refuses non-interactive reads entirely (Switchboard itself breaks), and
  trusting the node binary is useless when the agent harness also runs on node. Sprint 6
  needs a signed helper binary with its own ACL, or the 1Password CLI with biometric
  gating. Until then the honest statement is: Switchboard protects the MCP door, not a
  shell-level agent.
- Also worth knowing: `ps eww` / `ps -E` could not read a running child's env on this
  macOS build (tested), and the audit log / index / git history never contained the value.

## Unverified / not done

- No LLM was in the loop anywhere (a fresh Claude config is not logged in, and I would not
  run a real model unattended without asking). "Agent" in the red team means a scripted,
  fully-obedient tool caller — a stronger attacker in one way (it never refuses), weaker in
  another (no model judgement at all).
- Codex, Grokbot, Buzz installers are written from their docs but UNTESTED (not installed
  on the build machine). Buzz is a documented manual path: its agents run as Claude Code /
  Codex / Goose via buzz-acp.
- Claude Code native skill discovery is a symlink per skill (re-run setup after adding a
  skill); through MCP `skill_list` new skills appear immediately. The `@import` in
  CLAUDE.md and SOUL.md start-here block were not exercised by a real model session.
- Migration of existing Hermes/Claude memory was out of scope for the overnight brief;
  copying real memory needs a reviewed, attended run.

## Sprint 6 should take

1. Keychain ACL problem (F2): signed helper binary, or 1Password CLI backend (the
   `SecretStore` seam is already there — `OnePasswordStore` throws "not implemented").
2. Manifest integrity: sign the manifest or store a hash so an agent can't widen its own
   allowlist (F3 in RESULTS.md).
3. A live end-to-end demo with a real model in Hermes and Claude Code on a clean profile,
   plus attended migration of existing memory into Home.
4. Sync: Home as a private git repo across the mini and the Air, and a `switchboard sync`
   or hooks story.
5. Consider per-call timeouts/allowlist review UX: a `switchboard doctor` that lints
   manifests (unsafe flags, over-broad regexes) would have caught the LAB profile instantly.
