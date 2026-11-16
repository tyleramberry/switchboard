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

## What failed (red team: 9 of 10 pass after fixes, 1 honest finding)

Full log with real output: `redteam/RESULTS.md` (re-run 2026-11-16 on the Air).

- **F1 — unknown encodings — FIXED 2026-11-16.** The scrubber now covers rot13 and
  rot13-of-reversed, so the demonstrated leak is gone (attack 3 passes). The deeper lesson
  stands: if you allowlist an interpreter (opt-in flag), the secret can leave in any
  transform the scrubber doesn't know. The default profile refuses interpreters, which
  blocks the whole class; the allowlist is the control, scrubbing is a seatbelt.
- **F3 — manifest tampering — FIXED 2026-11-16.** `switchboard pin` records a sha256 of
  the manifest next to it (inside Home's git); every tool call verifies the pin and fails
  closed if the manifest changed. Attack 5 now includes the tamper probe: an agent that
  widens its own allowlist gets nothing. Unpinned Homes work but warn.
- **F2 — the Keychain ACL trusted /usr/bin/security — FIXED 2026-11-16.** Items created
  through `/usr/bin/security` had an ACL that trusted that binary, so any same-user
  process could read the value directly. Now reads and deletes go through a tiny compiled
  helper (`src/secrets/keychain-helper.ts`) that is ad-hoc code-signed, and items are
  created with `-T` trusting only that helper. Verified in attack 8: a direct
  `security find-generic-password` read is refused (untrusted callers get a GUI prompt,
  which is a refusal unattended), and an attacker who OVERWRITES the helper at its path
  breaks the cdhash binding of its ACL entry and is refused too.
  **Residual, recorded honestly:** the ACL binds to the helper's code identity, not its
  path, so an INTACT copy of the helper exec'd by a same-user process still returns the
  value. Same-user arbitrary code remains out of scope — Switchboard protects the MCP door
  and the common un-audited paths, not a shell-level agent. The real fix is the 1Password
  CLI backend with its own auth domain (Sprint 6).
- Also worth knowing: `ps eww` / `ps -E` could not read a running child's env on this
  macOS build (tested), and the audit log / index / git history never contained the value.

## Unverified / not done

- No LLM was in the loop anywhere (a fresh Claude config is not logged in, and I would not
  run a real model unattended without asking). "Agent" in the red team means a scripted,
  fully-obedient tool caller — a stronger attacker in one way (it never refuses), weaker in
  another (no model judgement at all). The 2026-11-16 Air run additionally hit
  `OAuth session expired` on the logged-in personal Claude config, so the live
  model-driven demo still needs a `claude /login` first.
- Codex, Grokbot, Buzz installers are written from their docs but UNTESTED (not installed
  on the build machine). Buzz is a documented manual path: its agents run as Claude Code /
  Codex / Goose via buzz-acp.
- Claude Code native skill discovery is a symlink per skill (re-run setup after adding a
  skill); through MCP `skill_list` new skills appear immediately. The `@import` in
  CLAUDE.md and SOUL.md start-here block were not exercised by a real model session.
- Migration of existing memory beyond the starter set (obsidian + github skills, AGENTS.md)
  still needs an attended, reviewed pass.

## Sprint 6 should take

1. ~~Keychain ACL problem (F2)~~ **Done 2026-11-16:** helper binary + restrictive ACL
   (see F2 above). The same-user residual still argues for the 1Password CLI backend (the
   `SecretStore` seam is already there — `OnePasswordStore` throws "not implemented").
2. A live end-to-end demo with a real model in Hermes and Claude Code on a clean profile,
   plus attended migration of existing memory into Home.
3. Sync: Home as a private git repo across the mini and the Air, and a `switchboard sync`
   or hooks story.
4. ~~Consider per-call timeouts/allowlist review UX: a `switchboard doctor` that lints
   manifests (unsafe flags, over-broad regexes) would have caught the LAB profile instantly.~~
   **Done 2026-11-16:** `switchboard doctor` ships — it flags interpreter allowlists with
   catch-all args and broad-arg network programs as errors (the exact LAB profile),
   wildcard/local hosts, long timeouts, missing purposes, and pin state. Exit 1 on errors.
