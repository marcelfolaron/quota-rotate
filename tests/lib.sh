# Test helpers for the shell scripts: a scratch HOME, a fake `claude` on CLAUDE_BIN
# that logs every call and plays a scenario, and a few asserts. Sourced by each test.
set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$TESTS_DIR/.." && pwd)"
ROTATE="$REPO/scripts/claude-rotate"
ACCOUNTS="$REPO/scripts/quota-accounts"

PASS=0
FAIL=0
CURRENT=""

begin() { CURRENT="$1"; }
ok() { PASS=$((PASS + 1)); echo "  ok   $CURRENT"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $CURRENT: $*"; }

assert_eq() { # assert_eq <expected> <actual> [what]
  if [ "$1" = "$2" ]; then return 0; fi
  fail "${3:-value}: expected [$1], got [$2]"
  return 1
}
assert_contains() { # assert_contains <haystack> <needle> [what]
  case "$1" in *"$2"*) return 0 ;; esac
  fail "${3:-text} does not contain [$2]:"$'\n'"$1"
  return 1
}
assert_not_contains() {
  case "$1" in *"$2"*) fail "${3:-text} contains [$2]:"$'\n'"$1"; return 1 ;; esac
  return 0
}
assert_file() { [ -e "$1" ] || { fail "missing: $1"; return 1; }; }
assert_no_file() { [ ! -e "$1" ] || { fail "unexpected: $1"; return 1; }; }

finish() {
  echo "$PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ]
}

# A fresh world: HOME with ~/.claude, the accounts base, the fake binary. Sets
# HOME, BASE, FAKE (the fake's own state dir), LOG (every call the fake saw).
world() {
  WORLD="$(mktemp -d "${TMPDIR:-/tmp}/quota-rotate-test.XXXXXX")"
  export HOME="$WORLD/home"
  export BASE="$HOME/.claude-accounts"
  export QUOTA_ROTATE_BASE="$BASE"
  export FAKE="$WORLD/fake"
  export LOG="$FAKE/calls.log"
  export FAKE_CLAUDE_DIR="$FAKE"
  export CLAUDE_BIN="$FAKE/claude"
  export QUOTA_ROTATE_NO_PROBE=1
  # The tests may run inside a session the launcher started: none of its variables may leak in.
  unset CLAUDE_CONFIG_DIR CLAUDE_CODE_PLUGIN_DIRS QUOTA_ROTATE_ACCOUNT QUOTA_ROTATE_HANDOFF QUOTA_ROTATE_PROBE \
    QUOTA_ROTATE_LOAD_PLUGIN_DIR QUOTA_ROTATE_SWITCH_AT CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY 2>/dev/null || true
  mkdir -p "$HOME/.claude/projects" "$HOME/.claude/plugins" "$HOME/.claude/skills" "$BASE/usage" "$FAKE"
  printf '{}\n' >"$HOME/.claude/settings.json"
  : >"$LOG"
  install_fake_claude
}

install_fake_claude() {
  cat >"$FAKE/claude" <<'FAKE'
#!/usr/bin/env bash
# Fake claude for the tests. Logs argv and the environment it cares about, then:
#   auth status [--json]  -> the status file of this config dir (exit 1 when none)
#   auth login            -> writes that status file (a successful browser login)
#   -p ...                -> a probe: writes the usage file of QUOTA_ROTATE_ACCOUNT
#   anything else         -> an interactive launch: pops one line of $FAKE/scenario:
#                            "handoff <to> <sid> <reason>" writes the handoff file
#                            and exits 0; "exit <code>" exits with that code.
dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
{
  printf 'ARGV:'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'
  printf 'ENV: CLAUDE_CONFIG_DIR=%s QUOTA_ROTATE_ACCOUNT=%s QUOTA_ROTATE_HANDOFF=%s CLAUDE_CODE_PLUGIN_DIRS=%s QUOTA_ROTATE_PROBE=%s CLAUDE_CODE_OAUTH_TOKEN=%s ANTHROPIC_API_KEY=%s\n' \
    "${CLAUDE_CONFIG_DIR-<unset>}" "${QUOTA_ROTATE_ACCOUNT-<unset>}" "${QUOTA_ROTATE_HANDOFF-<unset>}" \
    "${CLAUDE_CODE_PLUGIN_DIRS-<unset>}" "${QUOTA_ROTATE_PROBE-<unset>}" "${CLAUDE_CODE_OAUTH_TOKEN-<unset>}" "${ANTHROPIC_API_KEY-<unset>}"
} >>"$FAKE_CLAUDE_DIR/calls.log"
status_file="$FAKE_CLAUDE_DIR/status.$(printf '%s' "$dir" | tr '/' '_').json"
case "${1:-}" in
  auth)
    case "${2:-}" in
      status)
        [ -f "$status_file" ] || { echo '{"loggedIn":false}'; exit 1; }
        cat "$status_file"; exit 0 ;;
      login)
        printf '{"loggedIn":true,"email":"%s","orgId":"%s","orgName":"Org","subscriptionType":"max"}\n' \
          "${FAKE_LOGIN_EMAIL:-me@example.com}" "${FAKE_LOGIN_ORG:-org-1}" >"$status_file"; exit 0 ;;
    esac ;;
  -p)
    acct="${QUOTA_ROTATE_ACCOUNT:-default}"
    mkdir -p "$QUOTA_ROTATE_BASE/usage"
    printf '{"version":1,"account":"%s","configDir":"%s","observedAt":"%s","windows":{"five_hour":{"percentUsed":%s}}}\n' \
      "$acct" "$dir" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${FAKE_PROBE_PERCENT:-10}" >"$QUOTA_ROTATE_BASE/usage/$acct.json"
    echo ok; exit 0 ;;
esac
line=""
if [ -f "$FAKE_CLAUDE_DIR/scenario" ]; then
  line="$(head -n 1 "$FAKE_CLAUDE_DIR/scenario")"
  tail -n +2 "$FAKE_CLAUDE_DIR/scenario" >"$FAKE_CLAUDE_DIR/scenario.next" && mv "$FAKE_CLAUDE_DIR/scenario.next" "$FAKE_CLAUDE_DIR/scenario"
fi
set -- $line
case "${1:-exit}" in
  handoff)
    printf '{"version":1,"from":"%s","to":"%s","sessionId":"%s","cwd":"%s","reason":"%s","at":"now"}\n' \
      "${QUOTA_ROTATE_ACCOUNT:-?}" "$2" "$3" "$PWD" "$4" >"$QUOTA_ROTATE_HANDOFF"
    exit 0 ;;
  exit) exit "${2:-0}" ;;
esac
FAKE
  chmod +x "$FAKE/claude"
}

scenario() { printf '%s\n' "$@" >"$FAKE/scenario"; }

register() { # register <name> [percent] : an enabled account with a config dir and, with a percent, a fresh reading
  local name="$1" dir
  if [ "$name" = "default" ]; then dir="$HOME/.claude"; else dir="$BASE/$name"; mkdir -p "$dir"; fi
  node -e '
    const fs = require("fs"); const [reg, name, dir] = process.argv.slice(1);
    const r = fs.existsSync(reg) ? JSON.parse(fs.readFileSync(reg, "utf8")) : { version: 1, accounts: {} };
    r.accounts[name] = { configDir: dir, email: name + "@example.com", enabled: true };
    fs.writeFileSync(reg, JSON.stringify(r, null, 2) + "\n");
  ' "$BASE/accounts.json" "$name" "$dir"
  if [ -n "${2:-}" ]; then
    printf '{"version":1,"account":"%s","configDir":"%s","observedAt":"%s","windows":{"five_hour":{"percentUsed":%s}}}\n' \
      "$name" "$dir" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" >"$BASE/usage/$name.json"
  fi
}

launch_n() { # launch_n <n>: the ARGV line of the n-th interactive launch (auth/probe calls excluded)
  grep '^ARGV:' "$LOG" | grep -v '\[auth\]' | grep -v '\[-p\]' | sed -n "${1}p"
}
env_n() { # env_n <n>: the ENV line of the n-th interactive launch
  awk '/^ARGV:/ { keep = ($0 !~ /\[auth\]/ && $0 !~ /\[-p\]/) } /^ENV:/ && keep { n++; if (n == want) print }' want="$1" "$LOG"
}
launches() { grep '^ARGV:' "$LOG" | grep -vc '\[auth\]\|\[-p\]' || true; }
