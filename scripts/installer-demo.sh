#!/bin/zsh
# Installer demo against a CLEAN temp profile. Never touches ~/.hermes or ~/.claude.
# Usage: scripts/installer-demo.sh  (after npm run build). Output -> docs/evidence/installers.txt
set -u
REPO=${0:A:h:h}
SB=(node "$REPO/dist/src/cli.js")
B=$(mktemp -d "${TMPDIR:-/tmp}/sb-demo-XXXX")
export SWITCHBOARD_HOME="$B/agent-home"
trap 'rm -rf "$B"' EXIT
step() { print -- "\n\$ $*"; "$@" 2>&1; print -- "[exit $?]"; }

print "# Installer demo $(date -u '+%Y-%m-%dT%H:%M:%SZ')  (temp root: \$B)"
print "# hermes $(hermes --version 2>/dev/null | head -1)"
print "# claude $(claude --version 2>/dev/null)"
step "${SB[@]}" init
print "\n## Hermes (fresh HERMES_HOME=\$B/hermes)"
step "${SB[@]}" setup hermes --config-dir "$B/hermes"
step "${SB[@]}" setup hermes --config-dir "$B/hermes"
step env HERMES_HOME="$B/hermes" hermes mcp test switchboard
print "\n## Claude Code (fresh CLAUDE_CONFIG_DIR=\$B/claude)"
step "${SB[@]}" setup claude-code --config-dir "$B/claude"
step "${SB[@]}" setup claude-code --config-dir "$B/claude"
mkdir -p "$B/proj"
( cd "$B/proj" && step env CLAUDE_CONFIG_DIR="$B/claude" claude mcp get switchboard )
print "\n## A skill added to Home appears in both"
mkdir -p "$SWITCHBOARD_HOME/skills/demo-new-skill"
printf -- '---\nname: demo-new-skill\ndescription: Use when demoing that Home skills propagate.\n---\n\n# Demo\n' > "$SWITCHBOARD_HOME/skills/demo-new-skill/SKILL.md"
step env HERMES_HOME="$B/hermes" hermes skills list
print "\n# Claude Code native skills dir needs one re-run of setup (symlink per skill):"
step "${SB[@]}" setup claude-code --config-dir "$B/claude"
step ls -l "$B/claude/skills"
print "\n## Codex / Grokbot (UNTESTED: not installed) and Buzz (manual)"
step "${SB[@]}" setup codex --config-dir "$B/codex" --dry-run
step "${SB[@]}" setup grokbot --config-dir "$B/grokbot" --dry-run
step "${SB[@]}" setup buzz
