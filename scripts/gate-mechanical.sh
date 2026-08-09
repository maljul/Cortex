#!/usr/bin/env bash
#
# The mechanical rows of /check, enforced at the shell.
#
# Everything here is a command with a deterministic exit code — no judgment, no
# reading of code. Those rows used to live as prose in `.claude/commands/check.md`,
# where they were instructions an agent could skip, summarise, or believe it had
# run. Here they are a process that either exits 0 or does not.
#
# Two entry points, one implementation, so the gate and the commit block can never
# disagree about what passing means:
#
#   --report   Run every check, print a row per check, exit 1 if any failed.
#              This is what /check row 4 invokes.
#   (no args)  Claude Code PreToolUse hook. Reads the tool call on stdin, does
#              nothing unless it is a `git commit`, and exits 2 to block the commit
#              if any check fails.
#
# Deliberately bash and not tsx: the hook runs on every Bash tool call in the
# session, so it must start in milliseconds and must not depend on node resolving.
#
# NOTE ON THE ESCAPE HATCH: there isn't one, and that is the point. No env var
# disables this, because an env var is something the model can set — which is
# exactly the failure it exists to prevent. The hook governs commits made through
# Claude Code only; a human committing from their own terminal is unaffected. That
# is the intended split: the agent cannot decline, the human is not blocked.

set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}" || exit 0

FAILED=0
REPORT=0
[ "${1:-}" = "--report" ] && REPORT=1

# Hook mode: the tool call arrives as JSON on stdin, and this hook is attached to
# every Bash call. Do nothing unless the command is a commit — running tsc on each
# `ls` would make the session unusable.
#
# Matched against the raw payload rather than a parsed `.tool_input.command`, on
# purpose. It needs no jq or python on PATH, and it survives the compound form
# `git add -A && git commit -m ...`, which a prefix matcher like the hook config's
# `if: "Bash(git commit*)"` would miss — that form is how most commits here are
# actually written. A false positive costs one wasted typecheck; a false negative
# costs the whole gate.
if [ "$REPORT" != "1" ]; then
  case "$(cat)" in
    *'git commit'*) ;;
    *) exit 0 ;;
  esac
fi

# Placeholder DSNs that are supposed to be in the repo — .env.example and the
# error message in env-doctor. Matching them is a false positive, not a leak.
PLACEHOLDER='user:password@|user:pass@'

# Two patterns, because one of them must not be case-folded.
#
# CI (case-insensitive): the DSN requires credentials before an `@`, not a bare
# `postgresql://`. A DSN with no auth section carries no secret, and the bare
# scheme matches the check documenting itself — the grep string in
# `.claude/commands/check.md` is committed text, so the loose form flagged every
# run and would have trained someone to ignore the row.
#
# CS (case-sensitive): an AWS access key id is `AKIA` plus 16 UPPERCASE
# alphanumerics. Folding case makes it match inside base64 — the npm integrity
# hash `sha512-...Eyq4AKiAdPQlkOhFhqNfDtDCwi...` in package-lock.json is a hit
# under `-i` and is not a credential. Neither narrowing lets a real key through:
# a lowercased AKIA prefix is not a valid key id.
CREDENTIAL_CI="postgresql://[^[:space:]'\"]*@|sk-ant-"
CREDENTIAL_CS="AKIA[0-9A-Z]{16}"

# Failures accumulate as they happen. The block message must not re-run the checks
# to describe itself: hook mode scans the staged diff and report mode scans all
# history, so a re-run would print a different scope's verdict — the first version
# of this script said "BLOCKED" and then listed every row as PASS.
FAILURES=""

row() { # row <name> <PASS|FAIL> <evidence>
  [ "$REPORT" = "1" ] && printf '%-22s %-4s %s\n' "$1" "$2" "$3"
  if [ "$2" = "FAIL" ]; then
    FAILED=1
    FAILURES="${FAILURES}$(printf '%-22s %-4s %s' "$1" "$2" "$3")
"
  fi
  return 0
}

# ── typecheck ────────────────────────────────────────────────────────────────
if TSC=$(npx tsc --noEmit 2>&1); then
  row "typecheck" "PASS" "npx tsc --noEmit exits 0"
else
  row "typecheck" "FAIL" "$(printf '%s' "$TSC" | head -3)"
fi

# ── SQL containment ──────────────────────────────────────────────────────────
SQL=$(grep -rn "SELECT\|INSERT\|UPDATE\|DELETE" src/ --include="*.ts" 2>/dev/null \
      | grep -v "src/memory/\|src/db/")
if [ -z "$SQL" ]; then
  row "sql-containment" "PASS" "no SQL outside src/memory/ and src/db/"
else
  row "sql-containment" "FAIL" "$(printf '%s' "$SQL" | head -3)"
fi

# ── .env ignored ─────────────────────────────────────────────────────────────
if git check-ignore -q .env 2>/dev/null; then
  row "env-ignored" "PASS" "git check-ignore .env matches"
elif [ ! -e .env ]; then
  row "env-ignored" "PASS" "no .env present"
else
  row "env-ignored" "FAIL" ".env exists and is NOT gitignored"
fi

# ── credentials ──────────────────────────────────────────────────────────────
# Hook mode scans what is about to be committed. Report mode scans all history,
# which is the row as /check writes it and is too slow to run per commit.
SCAN=$(mktemp "${TMPDIR:-/tmp}/cortex-gate.XXXXXX")
trap 'rm -f "$SCAN"' EXIT
if [ "$REPORT" = "1" ]; then
  git log -p --all >"$SCAN" 2>/dev/null
  SCOPE="all history"
else
  git diff --cached -U0 2>/dev/null | grep -E '^\+' >"$SCAN"
  SCOPE="staged diff"
fi
CREDS=$( { grep -iE "$CREDENTIAL_CI" "$SCAN"; grep -E "$CREDENTIAL_CS" "$SCAN"; } \
         | grep -viE "$PLACEHOLDER")
if [ -z "$CREDS" ]; then
  row "credentials" "PASS" "no credential pattern in $SCOPE (placeholders excluded)"
else
  row "credentials" "FAIL" "$(printf '%s' "$CREDS" | head -3)"
fi

# ── verdict ──────────────────────────────────────────────────────────────────
if [ "$REPORT" = "1" ]; then
  echo
  [ "$FAILED" = "0" ] && echo "mechanical rows: PASS" || echo "mechanical rows: FAIL"
  exit "$FAILED"
fi

[ "$FAILED" = "0" ] && exit 0

{
  echo "BLOCKED: the mechanical rows of /check do not pass, so this commit did not run."
  echo "Scope: $SCOPE."
  echo
  printf '%s' "$FAILURES" | sed 's/^/  /'
  echo
  echo "Fix the failing row and commit again. Do not work around this by staging"
  echo "less, amending later, or narrowing a check — those are the moves it exists"
  echo "to catch. If the check itself is wrong, say so to Julian rather than"
  echo "editing it to pass."
} >&2
exit 2
