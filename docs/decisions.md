# Decisions log

Decisions made during the unattended overnight build. Each is the simplest option
that unblocked work; all are reversible.

1. **Language: TypeScript, ESM, `tsc` only.** No bundler, no ts-node. `npm test` compiles
   then runs `node --test` on the compiled output.
2. **SQLite: built-in `node:sqlite`, not better-sqlite3.** Node 22.23 on the mini ships it with
   FTS5 (verified with a probe). It prints an ExperimentalWarning; the CLI suppresses that
   one warning so it does not pollute MCP stderr. No native dependency to compile.
3. **Keychain writes go through `security -i` on stdin**, so the value never appears in
   any process's argv (`security add-generic-password -w <value>` would put it in `ps`).
4. **Tests and red team use a throwaway keychain file**, not login.keychain. Reason: in the
   unattended session `security add-generic-password` against the default (login) keychain
   fails with `User interaction is not allowed` (exit 36). The brief asked for a
   `switchboard-test` item; it is created with service `switchboard-test` inside a temp
   keychain (`security create-keychain`) and the whole keychain is deleted afterwards.
   `SWITCHBOARD_KEYCHAIN` selects the keychain file.
