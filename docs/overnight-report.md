# Overnight report — Switchboard (2026-11-14)

Unattended build per `~/work/SPEC.md` + brief. Repo: `tyleramberry/switchboard`, all work on
`main`, small commits, gates (`npm run typecheck`, `npm test`, `npm run build`) green before
every commit/push. Times: build ran roughly 00:09–00:55 MST; token spend not visible to the
build agent (unknown).

## Status by brief item

1. **Repo skeleton — DONE.** TypeScript (ESM, tsc only), README, `docs/design.md` (includes
   the dependency list with reasons), `SecretStore` interface with a working
   `KeychainStore` and a throwing `OnePasswordStore` stub. (`src/secrets/`)
2. **Home layout — DONE.** `switchboard init` creates `$SWITCHBOARD_HOME` (default
   `~/agent-home`): AGENTS.md, memory/, skills/, secrets.manifest.yaml, .gitignore
   (`.switchboard/`, `.env`, keychains). Idempotent (never overwrites; tested). Example
   skill `switchboard-handoff` included.
3. **MCP server — DONE.** Official `@modelcontextprotocol/sdk` over stdio;
   memory_write, memory_search (markdown + FTS5 via built-in `node:sqlite` — chosen over
   better-sqlite3; the choice is documented in design.md and decisions.md), memory_read,
   skill_list, skill_get, secret_list, secret_run. Verified by spawning the real server
   from an SDK client in tests, and by the real harness CLIs (`hermes mcp test switchboard`
   and `claude mcp get switchboard` both report Connected, 7 tools). No tool returns a
   secret value; every response is scrubbed against stored values as defense in depth.
4. **secret_run — DONE.** Allowlisted per secret in the manifest: absolute program paths
   (shells/interpreters/tunnels refused unless `unsafe_allow_interpreter`), each argument
   must fully match a regex, URL args and bare-host args host-checked, curl
   proxy/config/redirect/output flags denied, no shell (`spawn` argv only), minimal child
   env, fresh temp cwd, process-group kill on timeout, output cap, stdout/stderr scrubbed
   (raw, base64 std/url-safe at all alignments, hex, reversed, URL-encoded; line-wrap
   tolerant). HTTP mode does server-side fetches with manual redirects.
5. **Installer — DONE (2 tested, 2 UNTESTED, 1 manual).** `switchboard setup <harness>
   [--config-dir <dir>] [--dry-run]`: unified diff, per-file timestamped backups,
   idempotent, refuses when an unmanaged conflicting entry exists. Hermes and Claude Code
   were tested against TEMP config dirs only — the mini's real `~/.hermes`/`~/.claude` were
   never touched (see docs/harnesses.md and docs/evidence/installers.txt). Codex and
   Grokbot installers written from their docs, marked UNTESTED. Buzz is a documented manual
   path (its agents run via buzz-acp as Claude Code/Codex/Goose).
6. **Red team — DONE, 8/10 PASS, 2 findings.** `npm run redteam` runs the 10 SPEC attacks;
   results with real output in `redteam/RESULTS.md` + `redteam/results.json`. Dummy secret
   created with `security` in a THROWAWAY keychain file (service `switchboard-test`) — the
   login keychain cannot be written headlessly ("User interaction is not allowed", exit 36),
   so the item lives in a temp keychain that is deleted after the run; decision recorded in
   docs/decisions.md. Findings: F1 unknown encodings beat the scrubber when an interpreter
   is allowlisted (rot13 demonstrated; default profile refuses interpreters so the attack
   class is blocked); F2 any same-user process can read the Keychain item directly through
   /usr/bin/security (ACL trusts the creating binary — not fixable tonight, top Sprint 6
   item). Two curl exfil channels (proxy flags, bare-host args) were hardened BEFORE the
   red-team run with unit tests pinning them, so no genuine before/after exists for those.
7. **Handoff proof — DONE.** `npm run handoff`: two separate client processes, each
   spawning its own MCP server process, write/find in both directions; real output in
   `docs/evidence/handoff.txt`. A real model-driven turn was not run (fresh Claude config
   is not logged in; `claude -p` → "Not logged in · Please run /login").
8. **WRITEUP.md — DRAFT DONE** (problem, design, cost, failures, Sprint 6).

## Gate output (real, final tree)

```
$ npm run typecheck      → exit 0
$ npm test               → 39 tests, 39 pass, 0 fail (node --test)
$ npm run build          → exit 0
$ npm run redteam        → overall FAIL (8/10 attacks pass; findings F1, F2 above)
$ npm run handoff        → RESULT: PASS (both directions)
```

## Unverified / not attempted

- No LLM agent turn anywhere (cost + auth constraints; documented in WRITEUP.md).
- Codex/Grokbot/Buzz installers untested (products not installed); config formats from
  their docs, sources cited in docs/harnesses.md.
- `claude mcp`/`hermes mcp` verified config wiring and tool listing, not model usage.
- Real memory migration: out of scope for the brief (would touch `~/.hermes`/`~/.claude`).
- Ship-to-second-Mac (Air) not attempted.

## Decisions (full log in docs/decisions.md)

TypeScript+tsc only; `node:sqlite` over better-sqlite3; keychain writes via `security -i`
stdin (value never in argv); temp keychain for tests/red team; no LLM in the loop;
interpreter allowlists refused by default; Buzz manual path; no memory migration tonight.

## git log --oneline

```
0896667 Red team: 10 scripted attacks run; 8 pass; findings F1 (unknown encodings under unsafe interpreter allowlist) and F2 (keychain ACL trusts /usr/bin/security)
3f90b60 Red-team hardening: refuse tunnel programs (ssh/nc/socat), deny curl proxy/config/redirect/output flags, host-check bare-host args to network tools
9d053a9 Cross-agent handoff proof: two separate MCP client processes, both directions
566b072 Installers: hermes + claude-code tested on temp configs; codex/grokbot UNTESTED; buzz manual; evidence
1685381 Home layout, MCP server (memory/skills/secrets tools), secret_run with scrubbing, installer scaffolding
4fc884b Skeleton: TypeScript, README, design doc, SecretStore with Keychain + 1Password stub
3a36715 Initial commit
```

## git ls-remote origin main

```
089666711053b77145199b6bed82d928d9193b01	refs/heads/main
```
