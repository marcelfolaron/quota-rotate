#!/usr/bin/env bash
# MCP sync against a fake claude: quota-accounts sync-mcp, the launcher before each launch,
# add after the login. The primary login's ~/.claude.json is the source.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
echo "sync"

json() { # json <file> <js expression over c>: edits a JSON file in place
  node -e '
    const fs = require("fs"); const [file, expr] = process.argv.slice(1);
    const c = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    new Function("c", expr)(c);
    fs.writeFileSync(file, JSON.stringify(c, null, 2));
  ' "$1" "$2"
}
get() { # get <file> <js expression over c>: prints its value as JSON
  node -e '
    const fs = require("fs"); const [file, expr] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(JSON.stringify(new Function("c", "return " + expr)(c)));
  ' "$1" "$2"
}
mcp_calls() { grep -c '^ARGV: \[mcp\]' "$LOG" || true; }

# The primary login: two user servers (one without args, as `claude mcp add` writes none), a
# project with a local server and a switch, and a project whose folder is gone. Then an account
# "work" with a login and a server of its own.
setup() {
  world
  PROJ="$WORLD/proj"
  mkdir -p "$PROJ"
  json "$HOME/.claude.json" "
    c.mcpServers = {
      grafana: { type: 'stdio', command: '/bin/grafana', env: { TOKEN: 'sekret-1' } },
      web: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer sekret-2' } },
    };
    c.projects = {
      '$PROJ': { mcpServers: { pw: { command: 'npx', args: ['pw'] } }, disabledMcpServers: ['web'] },
      '$WORLD/gone': { mcpServers: { old: { command: '/bin/old', args: [] } }, disabledMcpServers: ['grafana'] },
    };"
  register work 10
  ACCOUNT_FILE="$BASE/work/.claude.json"
  json "$ACCOUNT_FILE" "
    c.oauthAccount = { emailAddress: 'work@example.com' };
    c.mcpServers = { mine: { command: '/bin/mine', args: [] } };"
}

begin "sync-mcp copies the primary's servers through claude mcp add-json, local ones from their folder"
setup
out="$(bash "$ACCOUNTS" sync-mcp work 2>&1)"; status=$?
assert_eq 0 "$status" "exit status" &&
assert_contains "$(grep -A1 '^ARGV: \[mcp\] \[add-json\] \[grafana\]' "$LOG")" "CLAUDE_CONFIG_DIR=$BASE/work QUOTA_ROTATE_ACCOUNT=work" "grafana env" &&
assert_contains "$(grep '^ARGV: \[mcp\] \[add-json\] \[pw\]' "$LOG")" "[-s] [local]" "pw scope" &&
assert_contains "$(grep -A1 '^ARGV: \[mcp\] \[add-json\] \[pw\]' "$LOG")" "CWD=$PROJ" "pw cwd" &&
assert_eq '["grafana","mine","web"]' "$(get "$ACCOUNT_FILE" 'Object.keys(c.mcpServers).sort()')" "user servers" &&
assert_eq '{"command":"npx","args":["pw"]}' "$(get "$ACCOUNT_FILE" "c.projects['$PROJ'].mcpServers.pw")" "local server" &&
assert_eq '{"emailAddress":"work@example.com"}' "$(get "$ACCOUNT_FILE" 'c.oauthAccount')" "login kept" &&
assert_eq 'false' "$(get "$ACCOUNT_FILE" "'$WORLD/gone' in (c.projects ?? {})")" "gone folder skipped" &&
assert_contains "$out" "added MCP server grafana (user scope)" &&
assert_contains "$out" "added MCP server pw (local scope, $PROJ)" &&
assert_not_contains "$out" "sekret" "output" && ok

begin "a second sync writes nothing, though claude stored args: [] the primary does not have"
setup
bash "$ACCOUNTS" sync-mcp work >/dev/null 2>&1
before="$(mcp_calls)"
out="$(bash "$ACCOUNTS" sync-mcp work 2>&1)"; status=$?
assert_eq 0 "$status" "exit status" &&
assert_eq '{"type":"stdio","command":"/bin/grafana","env":{"TOKEN":"sekret-1"},"args":[]}' "$(get "$ACCOUNT_FILE" 'c.mcpServers.grafana')" "stored form" &&
assert_eq "$before" "$(mcp_calls)" "mcp calls" &&
assert_eq "work: MCP servers already in step" "$out" && ok

begin "a server that differs is replaced; a server only the account has is kept"
setup
bash "$ACCOUNTS" sync-mcp work >/dev/null 2>&1
json "$HOME/.claude.json" "c.mcpServers.grafana.env.TOKEN = 'sekret-3'"
out="$(bash "$ACCOUNTS" sync-mcp work 2>&1)"
assert_contains "$(grep '^ARGV: \[mcp\]' "$LOG" | tail -2 | head -1)" "[mcp] [remove] [grafana] [-s] [user]" "remove first" &&
assert_eq '"sekret-3"' "$(get "$ACCOUNT_FILE" 'c.mcpServers.grafana.env.TOKEN')" "new token" &&
assert_eq '{"command":"/bin/mine","args":[]}' "$(get "$ACCOUNT_FILE" 'c.mcpServers.mine')" "own server" &&
assert_contains "$out" "replaced MCP server grafana (user scope)" &&
assert_not_contains "$out" "sekret" "output" && ok

begin "switches: the primary's disables are added, the account's own stay, the rest of the project entry is kept"
setup
json "$ACCOUNT_FILE" "c.projects = { '$PROJ': { allowedTools: ['Bash(ls)'], disabledMcpServers: ['claude.ai Gmail'] } }"
bash "$ACCOUNTS" sync-mcp work >/dev/null 2>&1
assert_eq '["claude.ai Gmail","web"]' "$(get "$ACCOUNT_FILE" "c.projects['$PROJ'].disabledMcpServers")" "disabled" &&
assert_eq '["Bash(ls)"]' "$(get "$ACCOUNT_FILE" "c.projects['$PROJ'].allowedTools")" "other keys" &&
assert_eq '{"emailAddress":"work@example.com"}' "$(get "$ACCOUNT_FILE" 'c.oauthAccount')" "login kept" && ok

begin "switches: a project the account never opened gets an entry with the switches alone"
setup
bash "$ACCOUNTS" sync-mcp work >/dev/null 2>&1
json "$HOME/.claude.json" "c.projects['$WORLD/other'] = { disabledMcpServers: ['grafana'] }"
mkdir -p "$WORLD/other"
out="$(bash "$ACCOUNTS" sync-mcp work 2>&1)"
assert_eq '{"disabledMcpServers":["grafana"]}' "$(get "$ACCOUNT_FILE" "c.projects['$WORLD/other']")" "new entry" &&
assert_contains "$out" "set disabledMcpServers in $WORLD/other: grafana" && ok

begin "switches: the primary's .mcp.json approval replaces the account's rejection of the same server"
setup
json "$HOME/.claude.json" "c.projects['$PROJ'].enabledMcpjsonServers = ['db']"
json "$ACCOUNT_FILE" "c.projects = { '$PROJ': { disabledMcpjsonServers: ['db', 'other'] } }"
bash "$ACCOUNTS" sync-mcp work >/dev/null 2>&1
assert_eq '["db"]' "$(get "$ACCOUNT_FILE" "c.projects['$PROJ'].enabledMcpjsonServers")" "approved" &&
assert_eq '["other"]' "$(get "$ACCOUNT_FILE" "c.projects['$PROJ'].disabledMcpjsonServers")" "rejected" && ok

begin "switches wait for Claude Code's lock: a held lock leaves them for the next sync, a stale one is taken"
setup
mkdir "$ACCOUNT_FILE.lock"
out="$(bash "$ACCOUNTS" sync-mcp work 2>&1)"; status=$?
assert_eq 1 "$status" "exit status while held" &&
assert_contains "$out" "lock stayed held" &&
assert_eq 'null' "$(get "$ACCOUNT_FILE" "c.projects['$PROJ'].disabledMcpServers ?? null")" "not written while held" &&
assert_file "$ACCOUNT_FILE.lock" &&
touch -t 202001010000 "$ACCOUNT_FILE.lock"
out="$(bash "$ACCOUNTS" sync-mcp work 2>&1)"; status=$?
assert_eq 0 "$status" "exit status once stale" &&
assert_eq '["web"]' "$(get "$ACCOUNT_FILE" "c.projects['$PROJ'].disabledMcpServers")" "written once stale" &&
assert_no_file "$ACCOUNT_FILE.lock" && ok

begin "the default account and a missing ~/.claude.json are left alone"
setup
register default 10
bash "$ACCOUNTS" sync-mcp default >/dev/null 2>&1
assert_eq 0 "$(mcp_calls)" "mcp calls for default" &&
rm "$HOME/.claude.json" &&
out="$(bash "$ACCOUNTS" sync-mcp work 2>&1)"; status=$?
assert_eq 0 "$status" "exit status" &&
assert_eq 0 "$(mcp_calls)" "mcp calls without a primary config" &&
assert_eq "work: MCP servers already in step" "$out" && ok

begin "a failing claude mcp is reported and sets the exit status"
setup
out="$(FAKE_MCP_FAIL=1 bash "$ACCOUNTS" sync-mcp work 2>&1)"; status=$?
assert_eq 1 "$status" "exit status" &&
assert_contains "$out" "could not add MCP server grafana (user scope): claude exited 1" && ok

begin "the launcher syncs the account before launching it, and the next one after a handoff"
setup
register default 90; register personal 5
mkdir -p "$BASE/personal"; printf '{}\n' >"$BASE/personal/.claude.json"
scenario "handoff work sid-1 threshold" "exit 0"
bash "$ROTATE" 2>/dev/null
first_launch="$(grep -n '^ARGV:' "$LOG" | grep -v '\[mcp\]\|\[auth\]\|\[-p\]' | head -1 | cut -d: -f1)"
second_launch="$(grep -n '^ARGV:' "$LOG" | grep -v '\[mcp\]\|\[auth\]\|\[-p\]' | sed -n 2p | cut -d: -f1)"
personal_sync="$(grep -n -A1 '^ARGV: \[mcp\] \[add-json\] \[grafana\]' "$LOG" | grep "CLAUDE_CONFIG_DIR=$BASE/personal " | head -1 | cut -d- -f1)"
work_sync="$(grep -n -A1 '^ARGV: \[mcp\] \[add-json\] \[grafana\]' "$LOG" | grep "CLAUDE_CONFIG_DIR=$BASE/work " | head -1 | cut -d- -f1)"
order="personal sync ${personal_sync:-none}, launch $first_launch, work sync ${work_sync:-none}, launch $second_launch"
in_order=no
if [ -n "$personal_sync" ] && [ -n "$work_sync" ] && [ "$personal_sync" -lt "$first_launch" ] &&
   [ "$work_sync" -gt "$first_launch" ] && [ "$work_sync" -lt "$second_launch" ]; then in_order=yes; fi
assert_eq 2 "$(launches)" "launches" &&
assert_contains "$(env_n 1)" "QUOTA_ROTATE_ACCOUNT=personal" &&
assert_contains "$(env_n 2)" "QUOTA_ROTATE_ACCOUNT=work" &&
assert_eq yes "$in_order" "each sync right before its launch ($order)" && ok

begin "a sync that fails does not stop the launch"
setup
scenario "exit 0"
out="$(FAKE_MCP_FAIL=1 bash "$ROTATE" --account work 2>&1)"; status=$?
assert_eq 0 "$status" "exit status" &&
assert_eq 1 "$(launches)" "launches" &&
assert_contains "$out" "not every MCP server reached work; launching anyway" && ok

begin "the default account launches without a sync"
setup
register default 1
scenario "exit 0"
bash "$ROTATE" --account default 2>/dev/null
assert_eq 0 "$(mcp_calls)" "mcp calls" && assert_eq 1 "$(launches)" "launches" && ok

begin "add copies the servers after the login"
setup
out="$(bash "$ACCOUNTS" add spare 2>&1)"
login_line="$(grep -n '\[auth\] \[login\]' "$LOG" | cut -d: -f1)"
sync_line="$(grep -n -A1 '^ARGV: \[mcp\] \[add-json\] \[grafana\]' "$LOG" | grep "CLAUDE_CONFIG_DIR=$BASE/spare " | cut -d- -f1)"
after_login=no
if [ -n "$sync_line" ] && [ -n "$login_line" ] && [ "$sync_line" -gt "$login_line" ]; then after_login=yes; fi
assert_contains "$out" "Registered 'spare'" &&
assert_contains "$out" "added MCP server grafana (user scope)" &&
assert_eq yes "$after_login" "sync after the login (login line ${login_line:-none}, sync line ${sync_line:-none})" && ok

finish
