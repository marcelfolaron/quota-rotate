#!/usr/bin/env bash
# quota-accounts against a fake claude: add (login, symlinks, registry), default,
# list, refresh, probe, remove.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
echo "accounts"

begin "add creates the config dir, shares the primary's state and records the login"
world
out="$(FAKE_LOGIN_EMAIL=work@example.com FAKE_LOGIN_ORG=org-w bash "$ACCOUNTS" add work 2>&1)"
assert_contains "$out" "Registered 'work' -> $BASE/work" &&
assert_contains "$out" "work@example.com · Org · max" &&
assert_eq "$HOME/.claude/projects" "$(readlink "$BASE/work/projects")" "projects symlink" &&
assert_eq "$HOME/.claude/plugins" "$(readlink "$BASE/work/plugins")" "plugins symlink" &&
assert_eq "$HOME/.claude/settings.json" "$(readlink "$BASE/work/settings.json")" "settings symlink" &&
assert_contains "$(cat "$BASE/accounts.json")" '"email": "work@example.com"' &&
assert_contains "$(cat "$BASE/accounts.json")" '"orgId": "org-w"' &&
assert_contains "$(cat "$BASE/accounts.json")" '"enabled": true' &&
assert_contains "$(grep -c '\[auth\] \[login\]' "$LOG")" "1" "one login" && ok

begin "add keeps an existing login"
world
FAKE_LOGIN_EMAIL=a@example.com bash "$ACCOUNTS" add work >/dev/null 2>&1
out="$(bash "$ACCOUNTS" add work 2>&1)"
assert_contains "$out" "already logged in" &&
assert_contains "$(grep -c '\[auth\] \[login\]' "$LOG")" "1" "still one login" && ok

begin "add default registers ~/.claude and runs claude with CLAUDE_CONFIG_DIR unset"
world
bash "$ACCOUNTS" add default >/dev/null 2>&1
assert_contains "$(cat "$BASE/accounts.json")" "\"configDir\": \"$HOME/.claude\"" &&
assert_no_file "$HOME/.claude/projects/projects" &&
assert_contains "$(grep '^ENV:' "$LOG" | head -1)" "CLAUDE_CONFIG_DIR=<unset>" && ok

begin "add rejects a name with other characters"
world
bash "$ACCOUNTS" add "bad name" >/dev/null 2>&1; status=$?
assert_eq 2 "$status" "exit status" && ok

begin "list shows each account's windows or 'no reading'"
world
bash "$ACCOUNTS" add work >/dev/null 2>&1
bash "$ACCOUNTS" add spare >/dev/null 2>&1
printf '{"version":1,"account":"work","configDir":"x","observedAt":"2026-10-09T12:00:00Z","windows":{"five_hour":{"percentUsed":42},"seven_day":{"percentUsed":7}}}\n' >"$BASE/usage/work.json"
out="$(bash "$ACCOUNTS" list)"
assert_contains "$out" "five_hour=42% seven_day=7%" &&
assert_contains "$out" "no reading" && ok

begin "probe runs one headless turn per account with the mod loaded, under that account"
world
bash "$ACCOUNTS" add work >/dev/null 2>&1
bash "$ACCOUNTS" add default >/dev/null 2>&1
out="$(FAKE_PROBE_PERCENT=33 bash "$ACCOUNTS" probe 2>&1)"
assert_contains "$out" "probing work… ok" &&
assert_contains "$out" "probing default… ok" &&
assert_contains "$(cat "$BASE/usage/work.json")" '"percentUsed":33' &&
assert_contains "$(grep -A1 '\[-p\]' "$LOG" | grep ENV | head -1)" "CLAUDE_CONFIG_DIR=$BASE/work QUOTA_ROTATE_ACCOUNT=work QUOTA_ROTATE_HANDOFF=<unset> CLAUDE_CODE_PLUGIN_DIRS=$REPO QUOTA_ROTATE_PROBE=1" &&
assert_contains "$(grep -A1 '\[-p\]' "$LOG" | grep ENV | tail -1)" "CLAUDE_CONFIG_DIR=<unset> QUOTA_ROTATE_ACCOUNT=default" && ok

begin "probe of one account loads nothing extra when the plugin is installed"
world
bash "$ACCOUNTS" add work >/dev/null 2>&1
printf '{"version":2,"plugins":{"quota-rotate@quota-rotate":[{"scope":"user"}]}}\n' >"$HOME/.claude/plugins/installed_plugins.json"
bash "$ACCOUNTS" probe work >/dev/null 2>&1
assert_contains "$(grep -A1 '\[-p\]' "$LOG" | grep ENV)" "CLAUDE_CODE_PLUGIN_DIRS=<unset>" && ok

begin "refresh re-reads every login"
world
FAKE_LOGIN_EMAIL=old@example.com bash "$ACCOUNTS" add work >/dev/null 2>&1
printf '{"loggedIn":true,"email":"new@example.com","orgId":"org-n","orgName":"New","subscriptionType":"team"}\n' >"$FAKE/status.$(printf '%s' "$BASE/work" | tr '/' '_').json"
out="$(bash "$ACCOUNTS" refresh 2>&1)"
assert_contains "$out" "new@example.com · New · team" &&
assert_contains "$(cat "$BASE/accounts.json")" '"email": "new@example.com"' && ok

begin "remove forgets the account and keeps its directory"
world
bash "$ACCOUNTS" add work >/dev/null 2>&1
bash "$ACCOUNTS" remove work >/dev/null
assert_not_contains "$(cat "$BASE/accounts.json")" '"work"' &&
assert_file "$BASE/work" && ok

begin "no arguments prints the usage and exits 2"
world
bash "$ACCOUNTS" >/dev/null 2>&1; status=$?
assert_eq 2 "$status" "exit status" && ok

finish
