# Switchboard design

## Shape

```
 Hermes ─┐                                   ┌─ memory/*.md  ──► .switchboard/index.db (FTS5, derived)
 Claude ─┼── stdio MCP ──► switchboard mcp ──┼─ skills/*/SKILL.md
 Codex  ─┤   (one process per harness        ├─ secrets.manifest.yaml (names + allowlists only)
 Grokbot ┘    session, all share Home)       └─ SecretStore ──► macOS Keychain (values)
```

Every harness spawns its own `switchboard mcp` process. They do not talk to each other;
they share state through files in Home. That is what makes handoff "live": a note written
by one process is a markdown file on disk, and the next `memory_search` in any other
process re-syncs the FTS index from disk before it queries.

## Components

| Path | Role |
|---|---|
| `src/home.ts` | `switchboard init`: creates Home, idempotent, never overwrites |
| `src/memory.ts` | memory write/read/search; markdown is the source of truth, SQLite FTS5 is a cache |
| `src/skills.ts` | skill list/get over `skills/<name>/SKILL.md` |
| `src/manifest.ts` | parses and validates `secrets.manifest.yaml` |
| `src/secrets/` | `SecretStore` interface, `KeychainStore`, stub `OnePasswordStore` |
| `src/scrub.ts` | builds every encoded form of a value and redacts it from text |
| `src/secret-run.ts` | allowlisted command / HTTP execution with the secret injected |
| `src/server.ts` | MCP tool registration; all output passes a final scrub |
| `src/installers/` | `switchboard setup <harness>` |
| `src/cli.ts` | CLI entry |

## Secret handling rules

1. **No tool returns a value.** `secret_list` returns names, purposes, allowlists, and
   whether the item exists in the store.
2. **Values never touch argv.** Keychain writes go through `security -i` on stdin.
   `secret_run` injects the value as an env var of the child only. The server's own
   `process.env` is never modified.
3. **No shell.** `secret_run` takes an argv array and calls `spawn(program, args, {shell:false})`.
   `$VAR`, backticks and `;` are literal bytes.
4. **Allowlist per secret** in the manifest: exact absolute `program` paths, each argument
   must fully match one of that command's `args` regexes (no `args` = no arguments).
   HTTP calls must target a host in `hosts`; redirects are not followed.
5. **Scrubbing** of child stdout/stderr and HTTP bodies: raw, base64 (standard and
   URL-safe, at all three byte alignments so it is caught inside a longer base64 blob),
   hex (any case), reversed, URL-encoded (`%XX` and `+` forms). As defense in depth, every
   MCP tool response, including errors, goes through the same scrubber for every secret in
   the manifest.
6. **Child isolation:** minimal env (`PATH`, `HOME` set to a fresh temp dir, `LANG`, the one
   secret), fresh temp cwd deleted afterwards, own process group killed on timeout,
   output capped.
7. **Memory writes are scanned**: content containing a known secret value (any encoding
   above) or a high-confidence token pattern is rejected.
8. **Audit log** `.switchboard/audit.jsonl` records tool, secret name, program, exit code,
   and whether anything was redacted. Never the value.

Known limit (from the spec, confirmed by the red team): an allowlisted program can still
leak through an encoding the scrubber does not know (rot13, XOR, splitting across lines).
Allowlisting is the real control; scrubbing narrows the channel.

## Path containment

`memory_read` and `skill_get` resolve the requested path with `realpath` and require the
result to sit inside the real `memory/` or `skills/<name>/` directory. `..`, absolute
paths, NUL bytes and symlinks that escape are refused.

## Dependencies

Kept short on purpose.

| Package | Kind | Why |
|---|---|---|
| `@modelcontextprotocol/sdk` | runtime | official MCP server/client over stdio (required by the brief) |
| `zod` | runtime | tool input schemas; peer dependency of the MCP SDK |
| `yaml` | runtime | parse the manifest and edit Hermes `config.yaml` without losing comments |
| `typescript` | dev | compiler / typecheck |
| `@types/node` | dev | Node typings |

SQLite comes from Node's built-in `node:sqlite` (FTS5 included in Node 22.23), so there is
no native module to build. Keychain access shells out to `/usr/bin/security`. Diffs use
`/usr/bin/diff`. Tests use the built-in `node:test`.
