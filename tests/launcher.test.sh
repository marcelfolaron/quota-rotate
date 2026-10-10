#!/usr/bin/env bash
# claude-rotate against a fake claude: the pick, the environment of each launch, the
# handoff loop, the flags that apply to the first launch only, install-mode detection.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
echo "launcher"

begin "picks the account with the most headroom and passes the rest through"
world; register default 90; register work 40; register personal 10
scenario "exit 0"
bash "$ROTATE" --model opus 2>/dev/null; status=$?
assert_eq 0 "$status" "exit status" &&
assert_eq 1 "$(launches)" "launches" &&
assert_contains "$(env_n 1)" "CLAUDE_CONFIG_DIR=$BASE/personal" &&
assert_contains "$(env_n 1)" "QUOTA_ROTATE_ACCOUNT=personal" &&
assert_contains "$(env_n 1)" "QUOTA_ROTATE_HANDOFF=$BASE/handoff." &&
assert_contains "$(env_n 1)" "CLAUDE_CODE_PLUGIN_DIRS=$REPO" &&
assert_eq "ARGV: [--model] [opus]" "$(launch_n 1)" "argv" && ok

begin "the default account runs with CLAUDE_CONFIG_DIR unset"
world; register default 5; register work 40
scenario "exit 0"
bash "$ROTATE" 2>/dev/null
assert_contains "$(env_n 1)" "CLAUDE_CONFIG_DIR=<unset>" &&
assert_contains "$(env_n 1)" "QUOTA_ROTATE_ACCOUNT=default" && ok

begin "--account forces the account; the exit status is claude's"
world; register default 5; register work 40
scenario "exit 3"
bash "$ROTATE" --account work 2>/dev/null; status=$?
assert_eq 3 "$status" "exit status" &&
assert_contains "$(env_n 1)" "QUOTA_ROTATE_ACCOUNT=work" && ok

begin "a handoff relaunches under the next account with --resume, then stops when claude exits plainly"
world; register default 90; register work 40; register personal 10
scenario "handoff work sid-123 rate_limit" "exit 0"
out="$(bash "$ROTATE" -r old-session --model opus 2>&1 >/dev/null)"
assert_eq 2 "$(launches)" "launches" &&
assert_eq "ARGV: [-r] [old-session] [--model] [opus]" "$(launch_n 1)" "first argv" &&
assert_contains "$(launch_n 2)" "[--resume] [sid-123] [The account was switched because of a usage limit. Continue exactly where you left off.] [--model] [opus]" "second argv" &&
assert_contains "$(env_n 2)" "QUOTA_ROTATE_ACCOUNT=work" &&
assert_contains "$(env_n 2)" "CLAUDE_CONFIG_DIR=$BASE/work" &&
assert_contains "$out" "handoff personal -> work (rate_limit)" &&
assert_no_file "$BASE/handoff.$$.json" && ok

begin "a threshold handoff resumes without a prompt; a second handoff follows the first"
world; register default 90; register work 40; register personal 10
scenario "handoff work sid-1 threshold" "handoff default sid-1 manual" "exit 0"
bash "$ROTATE" 2>/dev/null
assert_eq 3 "$(launches)" "launches" &&
assert_eq "ARGV: [--resume] [sid-1]" "$(launch_n 2)" "second argv" &&
assert_eq "ARGV: [--resume] [sid-1]" "$(launch_n 3)" "third argv" &&
assert_contains "$(env_n 3)" "CLAUDE_CONFIG_DIR=<unset>" &&
assert_contains "$(env_n 3)" "QUOTA_ROTATE_ACCOUNT=default" && ok

begin "an installed plugin is not loaded a second time from the folder"
world; register default 5
printf '{"version":2,"plugins":{"quota-rotate@quota-rotate":[{"scope":"user","installPath":"/x"}]}}\n' >"$HOME/.claude/plugins/installed_plugins.json"
scenario "exit 0"
bash "$ROTATE" 2>/dev/null
assert_contains "$(env_n 1)" "CLAUDE_CODE_PLUGIN_DIRS=<unset>" && ok

begin "an inherited CLAUDE_CODE_PLUGIN_DIRS keeps other folders and never repeats this one"
world; register default 5
scenario "exit 0"
CLAUDE_CODE_PLUGIN_DIRS="/other/mod:$REPO" bash "$ROTATE" 2>/dev/null
assert_contains "$(env_n 1)" "CLAUDE_CODE_PLUGIN_DIRS=$REPO:/other/mod " && ok

begin "an inherited CLAUDE_CODE_PLUGIN_DIRS loses this folder when the plugin is installed"
world; register default 5
printf '{"version":2,"plugins":{"quota-rotate@quota-rotate":[{"scope":"user","installPath":"/x"}]}}\n' >"$HOME/.claude/plugins/installed_plugins.json"
scenario "exit 0"
CLAUDE_CODE_PLUGIN_DIRS="$REPO:/other/mod" bash "$ROTATE" 2>/dev/null
assert_contains "$(env_n 1)" "CLAUDE_CODE_PLUGIN_DIRS=/other/mod " && ok

begin "QUOTA_ROTATE_LOAD_PLUGIN_DIR=1 loads the folder even when installed"
world; register default 5
printf '{"version":2,"plugins":{"quota-rotate@quota-rotate":[{"scope":"user","installPath":"/x"}]}}\n' >"$HOME/.claude/plugins/installed_plugins.json"
scenario "exit 0"
QUOTA_ROTATE_LOAD_PLUGIN_DIR=1 bash "$ROTATE" 2>/dev/null
assert_contains "$(env_n 1)" "CLAUDE_CODE_PLUGIN_DIRS=$REPO" && ok

begin "accounts without a reading are probed before the first pick"
world; register default 50; register spare
scenario "exit 0"
FAKE_PROBE_PERCENT=5 QUOTA_ROTATE_NO_PROBE=0 bash "$ROTATE" 2>/dev/null
assert_contains "$(grep -c '\[-p\]' "$LOG")" "1" "probe calls" &&
assert_contains "$(env_n 1)" "QUOTA_ROTATE_ACCOUNT=spare" && ok

begin "OAuth token and API key never reach the session"
world; register default 5
scenario "exit 0"
CLAUDE_CODE_OAUTH_TOKEN=tok ANTHROPIC_API_KEY=key bash "$ROTATE" 2>/dev/null
assert_contains "$(env_n 1)" "CLAUDE_CODE_OAUTH_TOKEN=<unset>" &&
assert_contains "$(env_n 1)" "ANTHROPIC_API_KEY=<unset>" && ok

begin "handoff files of launchers that are gone are removed; a live launcher's is kept"
world; register default 5
printf '{}' >"$BASE/handoff.4000000000.json"
printf '{}' >"$BASE/handoff.$$.json"
scenario "exit 0"
bash "$ROTATE" 2>/dev/null
assert_no_file "$BASE/handoff.4000000000.json" &&
assert_file "$BASE/handoff.$$.json" && ok

begin "no registry: a clear message and exit 1"
world
out="$(bash "$ROTATE" 2>&1)"; status=$?
assert_eq 1 "$status" "exit status" && assert_contains "$out" "quota-accounts add" && ok

begin "the shim finds the plugin folder through the pointer file and runs the launcher"
world; register default 5
printf '%s\n' "$REPO" >"$BASE/plugin-root"
node --disable-warning=ExperimentalWarning -e "import('$REPO/hooks/policy.ts').then(m => process.stdout.write(m.shimScript('claude-rotate')))" >"$FAKE/cr"
chmod +x "$FAKE/cr"
out="$("$FAKE/cr" --help 2>&1)"; status=$?
assert_eq 0 "$status" "exit status" && assert_contains "$out" "claude-rotate: run Claude Code" && ok

begin "the shim says what to do when no folder is known"
world
node --disable-warning=ExperimentalWarning -e "import('$REPO/hooks/policy.ts').then(m => process.stdout.write(m.shimScript('claude-rotate')))" >"$FAKE/cr"
chmod +x "$FAKE/cr"
out="$("$FAKE/cr" --help 2>&1)"; status=$?
assert_eq 1 "$status" "exit status" && assert_contains "$out" "cannot find the plugin folder" && ok

finish
