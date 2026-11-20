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

## 2026-11-16 (attended Air session)

5. **Manifest pinning (F3 fix): sha256 pin beside the manifest, not a signature.** The pin
   file lives in Home (git-tracked), so editing or deleting it shows in the diff — the
   same trust root as the manifest itself. `switchboard pin` is the only writer; unpinned
   Homes load with a warning instead of failing (backwards compatible, and pinning is a
   habit, not a gate). A signature would add key management for no extra security here.
6. **rot13 added to the scrubber (F1 fix): enumerated transform, not general detection.**
   rot13 is the canonical `tr` dodge and is cheap to enumerate (plus rot13-of-reversed).
   Arbitrary-transform detection is not attempted — the interpreter refusal is the control;
   the scrubber remains a seatbelt with a longer list.
7. **Real Home on the Air is `~/agent-home`, a local git repo.** Seeded with AGENTS.md
   (who Tyler is), obsidian + github skills, and the handoff evidence note. Not pushed
   anywhere yet; remote/sync story is Sprint 6.

## 2026-11-16 (F2 fix session)

8. **Keychain reads go through a compiled ad-hoc-signed helper (F2 fix).** Items created
   by `security` default to an ACL trusting `/usr/bin/security` itself, which any
   same-user process can exec. Reads/deletes now go through `switchboard-keychain-read`
   (embedded C source, compiled with clang at first use, ad-hoc signed), and items are
   created with `-T` trusting only that helper. Ad-hoc signing matters: the ACL binds to
   the code's cdhash, so overwriting the helper at its path breaks trust. A failed exec
   also poisons macOS's trust cache for the helper path (observed), so the red-team
   overwrite probe runs on an isolated throwaway keychain. Known residual, kept honest:
   the ACL follows the code identity, not the path, so an INTACT copy of the helper exec'd
   by a same-user process still returns the value — same-user arbitrary code stays out of
   scope until the 1Password backend.

## 2026-11-19 (UI v1, unattended mini session)

9. **Web UI is a localhost node:http server with vanilla JS, no new dependencies.** It reuses
   the Switchboard class, memory, skills, manifest, doctor and installers, so the UI and MCP
   cannot drift. Guards: bind 127.0.0.1, random per-launch token in a header (not a cookie, so
   CSRF needs the token), Host allowlist against DNS rebinding, cross-origin Origin refused,
   strict CSP with `script-src 'self'`. Every JSON response is scrubbed; if a scrubber cannot be
   built the response fails closed. Values are write-only, there is no reveal path.
   Manifest saves from the UI are re-pinned (the owner is the one clicking), but the UI
   refuses to edit a manifest whose pin no longer matches: re-pinning would silently bless an
   out-of-band edit. The form cannot turn on `unsafe_allow_interpreter`. Home git commits only
   happen through the explicit Commit changes button. The activity log (plan section 7) is
   deferred.
