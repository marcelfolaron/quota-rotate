# Shared by claude-rotate and quota-accounts. Sourced, not run; HERE is set by the caller.
# Works on bash 3.2 (macOS) and later.

BASE="${QUOTA_ROTATE_BASE:-$HOME/.claude-accounts}"
PRIMARY="$HOME/.claude"
# A terminal wrapper on PATH (cmux ships one) injects flags before subcommands;
# CLAUDE_BIN names the real binary when that gets in the way.
CLAUDE="${CLAUDE_BIN:-claude}"
PLUGIN_DIR="$(cd "$HERE/.." && pwd)"
REG="$BASE/accounts.json"

config_dir_of() { # config_dir_of <name>: "default" is ~/.claude itself
  if [ "$1" = "default" ]; then printf '%s\n' "$PRIMARY"; else printf '%s\n' "$BASE/$1"; fi
}

# The scripts drive the picker and the registry with node; the .ts picker needs type
# stripping, which node runs without a flag from 22.18 (and 23.6) on.
require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "quota-rotate: node is required (22.18 or newer); install it from https://nodejs.org" >&2
    exit 1
  fi
  if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 23 || (a === 23 && b >= 6) || (a === 22 && b >= 18) ? 0 : 1)'; then
    echo "quota-rotate: node $(node --version) is too old; 22.18 or newer is required" >&2
    exit 1
  fi
}

# True when the mod is installed as a Claude Code plugin. Every account shares the
# primary's plugins/ directory and settings.json, so an installed mod loads in each
# session on its own, and loading the folder a second time would run it twice.
# QUOTA_ROTATE_LOAD_PLUGIN_DIR=1 forces the folder (a checkout under development),
# =0 forces the installed copy.
plugin_installed() {
  case "${QUOTA_ROTATE_LOAD_PLUGIN_DIR:-}" in
    1) return 1 ;;
    0) return 0 ;;
  esac
  local f="$PRIMARY/plugins/installed_plugins.json"
  [ -f "$f" ] || return 1
  node -e '
    try {
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(Object.keys(r.plugins || {}).some(k => k.split("@")[0] === "quota-rotate") ? 0 : 1);
    } catch { process.exit(1) }' "$f"
}

# CLAUDE_CODE_PLUGIN_DIRS for a child session: the inherited list without this folder
# (a session started by the launcher passes the variable down), plus this folder
# unless the mod is installed. Prints nothing when the result is empty.
plugin_dirs_for_child() {
  local out="" dir
  local IFS=:
  for dir in ${CLAUDE_CODE_PLUGIN_DIRS:-}; do
    if [ -n "$dir" ] && [ "$dir" != "$PLUGIN_DIR" ]; then out="${out:+$out:}$dir"; fi
  done
  if ! plugin_installed; then out="$PLUGIN_DIR${out:+:$out}"; fi
  printf '%s' "$out"
}

# Runs claude as the named account. "default" means ~/.claude with the variable
# UNSET: the macOS Keychain entry is keyed to CLAUDE_CONFIG_DIR, so an explicit
# ~/.claude reads a different entry than no variable at all.
claude_as() { # claude_as <name> <args...>
  local name="$1"; shift
  if [ "$name" = "default" ]; then
    env -u CLAUDE_CONFIG_DIR "$CLAUDE" "$@"
  else
    CLAUDE_CONFIG_DIR="$BASE/$name" "$CLAUDE" "$@"
  fi
}

# What a claude the scripts start must not inherit from the session around them: its
# config dir and plugin folders, the launcher's handoff, a token that outranks every
# login, the session's own identity. Keep in step with PROBE_UNSET_VARS in hooks/policy.ts.
CHILD_ENV_UNSET=(-u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_PLUGIN_DIRS -u QUOTA_ROTATE_HANDOFF -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY
  -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN
  -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PLUGIN_DATA -u CLAUDE_PID -u CLAUDECODE)

# One headless turn under <name> with the mod loaded, so that account's own mod
# instance writes its reading. Nothing else runs: no MCP server, no tool, no
# transcript, no wait at a usage limit. Quiet; the exit status says whether it ran.
# Keep in step with probeArgv in hooks/policy.ts.
probe_account() { # probe_account <name>
  local name="$1" dirs
  local cfg=() load=()
  [ "$name" = "default" ] || cfg=("CLAUDE_CONFIG_DIR=$BASE/$name")
  dirs="$(plugin_dirs_for_child)"
  [ -z "$dirs" ] || load=("CLAUDE_CODE_PLUGIN_DIRS=$dirs")
  (cd "$HOME" && env "${CHILD_ENV_UNSET[@]}" \
      ${cfg[@]+"${cfg[@]}"} ${load[@]+"${load[@]}"} QUOTA_ROTATE_ACCOUNT="$name" QUOTA_ROTATE_PROBE=1 \
      "$CLAUDE" -p "Reply with the single word ok." --model haiku --setting-sources user \
      --settings '{"autoContinueAtUsageLimit":false}' --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
      --tools "" --no-session-persistence >/dev/null 2>&1)
}

registry_names() { # every enabled account, space separated
  [ -f "$REG" ] || return 0
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.entries(r.accounts).filter(([,a])=>a.enabled!==false).map(([n])=>n).join(" "))' "$REG"
}

# Brings <name>'s own .claude.json in step with the primary login's MCP servers and
# per-project MCP switches (scripts/sync-mcp.ts); mcp-sync/<name>.json records which names
# came from the primary. "default" is that login, so there is nothing to do.
# A line per change on stdout; the exit status says whether every write went through.
sync_mcp() { # sync_mcp <name>
  [ "$1" != "default" ] || return 0
  env "${CHILD_ENV_UNSET[@]}" QUOTA_ROTATE_ACCOUNT="$1" \
    node --disable-warning=ExperimentalWarning "$HERE/sync-mcp.ts" "$1" "$(config_dir_of "$1")" "$CLAUDE" "$BASE/mcp-sync/$1.json"
}

# What an extra account reads from the primary instead of keeping its own: one symlink
# per entry. An entry the primary does not have yet is linked once it appears there.
SHARED=(projects plugins skills commands agents settings.json CLAUDE.md keybindings.json tasks file-history plans)
# The session state among those: task lists, the file versions a rewind restores, plans.
# Claude Code makes these folders by itself under whichever account runs, so the
# primary's is created when missing (the link then exists before the first write) and an
# account's own folder is merged into the primary's before the link replaces it.
SHARED_STATE=(tasks file-history plans)

is_shared_state() { # is_shared_state <item>
  local i
  for i in "${SHARED_STATE[@]}"; do
    if [ "$i" = "$1" ]; then return 0; fi
  done
  return 1
}

# The file under <dir> written last, among those the find arguments select. Empty when none.
newest_file() { # newest_file <dir> [find args...]
  local dir="$1" best="" f
  shift
  while IFS= read -r f; do
    if [ -z "$best" ] || [ "$f" -nt "$best" ]; then best="$f"; fi
  done < <(find "$dir" -type f "$@" 2>/dev/null)
  printf '%s' "$best"
}

# Copies <from> into <to> file by file: what <to> lacks, and what <from> wrote later.
copy_newer() { # copy_newer <from> <to>
  local from="$1" to="$2" rel parent
  mkdir -p "$to" || return 1
  while IFS= read -r rel; do
    rel="${rel#./}"
    if [ -e "$to/$rel" ] || [ -L "$to/$rel" ]; then
      [ "$from/$rel" -nt "$to/$rel" ] || continue
    fi
    parent="$to/$rel"
    parent="${parent%/*}"
    [ -d "$parent" ] || mkdir -p "$parent" || return 1
    cp -pP "$from/$rel" "$to/$rel" || return 1
  done < <(cd "$from" && find . ! -type d)
}

# Merges an account's own <item> folder into the primary's. tasks holds one folder per
# task list, whose numbered files only make sense together: the list written last wins
# whole. file-history and plans are stores of separate files: the union, and where both
# have a file, the one written last. (Before the folder was shared, a session that moved
# could write a second, different file under a name it had used under another account.)
merge_state() { # merge_state <item> <from> <to>
  local item="$1" from="$2" to="$3" entry name mine theirs
  mkdir -p "$to" || return 1
  if [ "$item" != "tasks" ]; then
    copy_newer "$from" "$to"
    return
  fi
  while IFS= read -r entry; do
    name="$(basename "$entry")"
    if [ ! -d "$entry" ]; then
      if [ ! -e "$to/$name" ]; then cp -pP "$entry" "$to/$name" || return 1; fi
      continue
    fi
    if [ ! -e "$to/$name" ]; then
      copy_newer "$entry" "$to/$name" || return 1
      continue
    fi
    mine="$(newest_file "$entry" -name '*.json')"
    theirs="$(newest_file "$to/$name" -name '*.json')"
    if [ -z "$mine" ]; then continue; fi
    if [ -n "$theirs" ] && [ ! "$mine" -nt "$theirs" ]; then continue; fi
    rm -rf "$to/.$name.incoming"
    copy_newer "$entry" "$to/.$name.incoming" && rm -rf "$to/$name" && mv "$to/.$name.incoming" "$to/$name" || return 1
  done < <(find "$from" -mindepth 1 -maxdepth 1)
}

# Links everything in SHARED from <name>'s config dir to the primary's. A link that is
# already there is left alone wherever it points, and so is anything else the account
# keeps under a shared name, except its own session state, which is merged first and
# kept beside the link as <item>.before-share-<time>. "default" is the primary.
# A line per change on stdout (SHARE_VERBOSE=1 adds what was left alone); the exit
# status says whether everything that should be linked is.
sync_shared() { # sync_shared <name>
  [ "$1" != "default" ] || return 0
  local name="$1" dir item src dst aside merged failed=0
  dir="$(config_dir_of "$name")"
  [ -d "$dir" ] || return 0
  for item in "${SHARED[@]}"; do
    src="$PRIMARY/$item"
    dst="$dir/$item"
    merged=""
    if [ -L "$dst" ]; then continue; fi
    if is_shared_state "$item"; then
      if ! mkdir -p "$src"; then failed=1; continue; fi
      if [ -d "$dst" ]; then
        aside="$dst.before-share-$(date +%Y%m%d-%H%M%S)"
        [ ! -e "$aside" ] || aside="$aside-$$"
        if merge_state "$item" "$dst" "$src" && mv "$dst" "$aside"; then
          merged=1
          echo "$name: merged its own $item into default's and shares it now; the old folder is kept as $(basename "$aside")"
        else
          echo "$name: could not merge its own $item into default's; it stays separate"
          failed=1
          continue
        fi
      fi
    fi
    if [ ! -e "$src" ]; then continue; fi
    if [ -e "$dst" ]; then
      [ -z "${SHARE_VERBOSE:-}" ] || echo "$name: keeps its own $item (move it away to share default's)"
      continue
    fi
    if ! ln -s "$src" "$dst"; then
      failed=1
    elif [ -z "$merged" ]; then
      echo "$name: $item now shared"
    fi
  done
  return "$failed"
}

# Every enabled account, not only the one about to run: a session can arrive from an
# account that has not been launched since the folder was last checked.
sync_shared_all() {
  local name failed=0
  for name in $(registry_names); do
    sync_shared "$name" || failed=1
  done
  return "$failed"
}
