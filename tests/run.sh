#!/usr/bin/env bash
# Runs every check: manifest validation, the mod's tests (policy and hooks), the
# shell tests. `claude` is needed for the first two; CLAUDE_BIN names it when a
# wrapper on PATH gets in the way.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"
status=0

echo "== claude plugin validate --strict"
"$CLAUDE" plugin validate --strict "$REPO" || status=1
echo "== claude plugin test"
"$CLAUDE" plugin test "$REPO" || status=1
for t in "$HERE"/*.test.sh; do
  echo "== $(basename "$t")"
  bash "$t" || status=1
done
[ "$status" -eq 0 ] && echo "all green" || echo "FAILED"
exit "$status"
