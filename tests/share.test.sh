#!/usr/bin/env bash
# What every account shares with the primary: the links made at add and before every
# launch, and the merge of an account's own tasks/file-history/plans into the primary's.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
echo "share"

begin "add links the session state too, and creates it in the primary"
world
bash "$ACCOUNTS" add work >/dev/null 2>&1
assert_eq "$HOME/.claude/tasks" "$(readlink "$BASE/work/tasks")" "tasks symlink" &&
assert_eq "$HOME/.claude/file-history" "$(readlink "$BASE/work/file-history")" "file-history symlink" &&
assert_eq "$HOME/.claude/plans" "$(readlink "$BASE/work/plans")" "plans symlink" &&
assert_file "$HOME/.claude/tasks" &&
assert_no_file "$BASE/work/commands" && ok

begin "sync-shared links what an older account lacks, and an entry the primary gets later"
world; register work
out="$(bash "$ACCOUNTS" sync-shared 2>&1)"
assert_contains "$out" "work: tasks now shared" &&
assert_eq "$HOME/.claude/projects" "$(readlink "$BASE/work/projects")" "projects symlink" &&
assert_no_file "$BASE/work/commands" &&
mkdir "$HOME/.claude/commands" &&
assert_eq "work: commands now shared" "$(bash "$ACCOUNTS" sync-shared work 2>&1)" "second run" &&
assert_eq "$HOME/.claude/commands" "$(readlink "$BASE/work/commands")" "commands symlink" &&
assert_eq "work: shares everything already" "$(bash "$ACCOUNTS" sync-shared work 2>&1)" "third run" && ok

begin "an account's own task lists are merged: the list written last wins whole, the old folder is kept"
world; register work
P="$HOME/.claude/tasks"; W="$BASE/work/tasks"
mkdir -p "$P/both-old" "$P/both-new" "$W/both-old" "$W/both-new" "$W/only-work"
echo primary >"$P/both-old/1.json"; echo primary >"$P/both-old/2.json"
echo primary >"$P/both-new/1.json"; echo primary >"$P/both-new/2.json"
echo work >"$W/both-old/1.json"; echo work >"$W/both-new/1.json"; echo work >"$W/only-work/1.json"
touch -t 202601010000 "$W/both-old/1.json" "$P/both-new/1.json" "$P/both-new/2.json"
touch -t 202602010000 "$P/both-old/1.json" "$P/both-old/2.json" "$W/both-new/1.json"
out="$(bash "$ACCOUNTS" sync-shared work 2>&1)"
assert_contains "$out" "work: merged its own tasks into default's and shares it now; the old folder is kept as tasks.before-share-" &&
assert_eq "$P" "$(readlink "$W")" "tasks symlink" &&
assert_eq primary "$(cat "$P/both-old/1.json")" "the account's older list loses" &&
assert_file "$P/both-old/2.json" &&
assert_eq work "$(cat "$P/both-new/1.json")" "the account's newer list wins" &&
assert_no_file "$P/both-new/2.json" &&
assert_eq work "$(cat "$W/only-work/1.json")" "a list only the account had, read through the link" &&
assert_eq 1 "$(ls -d "$BASE/work"/tasks.before-share-* | wc -l | tr -d ' ')" "kept folders" &&
assert_eq work "$(cat "$BASE/work"/tasks.before-share-*/both-old/1.json)" "the losing list is still in the kept folder" && ok

begin "file history and plans are merged as a union; where both have a file, the one written last stays"
world; register work
P="$HOME/.claude"; W="$BASE/work"
mkdir -p "$P/file-history/sid-1" "$W/file-history/sid-1" "$W/file-history/sid-2" "$W/plans"
echo primary >"$P/file-history/sid-1/aaa@v1"; echo work >"$W/file-history/sid-1/aaa@v1"
echo primary >"$P/file-history/sid-1/aaa@v2"; echo work >"$W/file-history/sid-1/aaa@v2"
touch -t 202601010000 "$W/file-history/sid-1/aaa@v1" "$P/file-history/sid-1/aaa@v2"
touch -t 202602010000 "$P/file-history/sid-1/aaa@v1" "$W/file-history/sid-1/aaa@v2"
echo work >"$W/file-history/sid-1/bbb@v1"; echo work >"$W/file-history/sid-2/ccc@v1"; echo plan >"$W/plans/calm otter.md"
bash "$ACCOUNTS" sync-shared work >/dev/null 2>&1
assert_eq primary "$(cat "$P/file-history/sid-1/aaa@v1")" "file both had, the primary's written last" &&
assert_eq work "$(cat "$P/file-history/sid-1/aaa@v2")" "file both had, the account's written last" &&
assert_eq work "$(cat "$W"/file-history.before-share-*/sid-1/aaa@v1)" "the losing file is still in the kept folder" &&
assert_eq work "$(cat "$P/file-history/sid-1/bbb@v1")" "file only the account had" &&
assert_eq work "$(cat "$P/file-history/sid-2/ccc@v1")" "session only the account had" &&
assert_eq plan "$(cat "$P/plans/calm otter.md")" "plan with a space in its name" &&
assert_eq "$P/file-history" "$(readlink "$W/file-history")" "file-history symlink" &&
assert_eq "$P/plans" "$(readlink "$W/plans")" "plans symlink" && ok

begin "a link that points elsewhere and an account's own commands are left alone"
world; register work
mkdir -p "$WORLD/elsewhere" "$HOME/.claude/commands" "$BASE/work/commands"
ln -s "$WORLD/elsewhere" "$BASE/work/tasks"
out="$(bash "$ACCOUNTS" sync-shared work 2>&1)"
assert_eq "$WORLD/elsewhere" "$(readlink "$BASE/work/tasks")" "the foreign link" &&
assert_eq "" "$(readlink "$BASE/work/commands")" "commands is still a folder" &&
assert_contains "$out" "work: keeps its own commands" && ok

begin "a merge that fails leaves the account's folder where it is"
world; register work
mkdir -p "$BASE/work/tasks/list-1"; echo work >"$BASE/work/tasks/list-1/1.json"
echo unreadable >"$BASE/work/tasks/list-1/2.json"; chmod 000 "$BASE/work/tasks/list-1/2.json"
out="$(bash "$ACCOUNTS" sync-shared work 2>&1)"; status=$?
chmod 644 "$BASE/work/tasks/list-1/2.json"
if [ "$(id -u)" = 0 ]; then ok; else
  assert_eq 1 "$status" "exit status" &&
  assert_contains "$out" "work: could not merge its own tasks into default's; it stays separate" &&
  assert_eq "" "$(readlink "$BASE/work/tasks")" "tasks is still the account's folder" &&
  assert_eq work "$(cat "$BASE/work/tasks/list-1/1.json")" "its list" && ok
fi

begin "the launcher links every account before a launch, not only the one it launches under"
world; register default 90; register work 10; register spare 50
mkdir -p "$BASE/spare/tasks/list-1"; echo spare >"$BASE/spare/tasks/list-1/1.json"
scenario "exit 0"
out="$(bash "$ROTATE" 2>&1 >/dev/null)"
assert_contains "$(env_n 1)" "QUOTA_ROTATE_ACCOUNT=work" &&
assert_eq "$HOME/.claude/tasks" "$(readlink "$BASE/work/tasks")" "work's tasks" &&
assert_eq "$HOME/.claude/tasks" "$(readlink "$BASE/spare/tasks")" "spare's tasks" &&
assert_eq spare "$(cat "$HOME/.claude/tasks/list-1/1.json")" "spare's list in the primary" &&
assert_contains "$out" "claude-rotate: spare: merged its own tasks into default's" && ok

begin "a second launch has nothing left to link and says nothing about it"
scenario "exit 0"
out="$(bash "$ROTATE" 2>&1 >/dev/null)"
assert_not_contains "$out" "shared" &&
assert_not_contains "$out" "merged" && ok

begin "a merge says how far it is on a terminal, and nothing when it is not one"
world; register work
mkdir -p "$BASE/work/file-history/sid-1"
for i in 1 2 3; do echo x >"$BASE/work/file-history/sid-1/f$i@v1"; done
out="$(SHARE_PROGRESS=1 bash "$ACCOUNTS" sync-shared work 2>&1)"
world; register work
mkdir -p "$BASE/work/file-history/sid-1"; echo x >"$BASE/work/file-history/sid-1/f1@v1"
quiet="$(bash "$ACCOUNTS" sync-shared work 2>&1)"
assert_contains "$out" "sharing work's file-history, once: 0 of 3 files" &&
assert_contains "$out" "work: merged its own file-history into default's and shares it now" &&
assert_not_contains "$quiet" "of 1 files" &&
assert_contains "$quiet" "work: merged its own file-history into default's and shares it now" && ok

begin "a lock left by a launcher that is gone is taken over"
world; register work
mkdir "$BASE/.share.lock"; touch -t 202601010000 "$BASE/.share.lock"
bash "$ACCOUNTS" sync-shared work >/dev/null 2>&1; status=$?
assert_eq 0 "$status" "exit status" &&
assert_eq "$HOME/.claude/tasks" "$(readlink "$BASE/work/tasks")" "tasks symlink" &&
assert_no_file "$BASE/.share.lock" && ok

begin "a sync waits while another holds the lock, then goes on"
world; register work
mkdir "$BASE/.share.lock"
bash "$ACCOUNTS" sync-shared work >"$WORLD/waiter.out" 2>&1 &
waiter=$!
sleep 2
held="$(readlink "$BASE/work/tasks" 2>/dev/null || true)"
rmdir "$BASE/.share.lock"
wait "$waiter"; status=$?
assert_eq "" "$held" "nothing linked while the lock was held" &&
assert_eq 0 "$status" "exit status" &&
assert_eq "$HOME/.claude/tasks" "$(readlink "$BASE/work/tasks")" "tasks symlink afterwards" &&
assert_no_file "$BASE/.share.lock" && ok

begin "two syncs at once merge an account's folder once"
world; register work
mkdir -p "$BASE/work/file-history/sid-1" "$BASE/work/tasks/list-1"
for i in $(seq 1 300); do echo "$i" >"$BASE/work/file-history/sid-1/f$i@v1"; done
echo work >"$BASE/work/tasks/list-1/1.json"
bash "$ACCOUNTS" sync-shared work >"$WORLD/a.out" 2>&1 & a=$!
bash "$ACCOUNTS" sync-shared work >"$WORLD/b.out" 2>&1 & b=$!
wait "$a"; sa=$?; wait "$b"; sb=$?
assert_eq "0 0" "$sa $sb" "exit statuses" &&
assert_eq 300 "$(ls "$HOME/.claude/file-history/sid-1" | wc -l | tr -d ' ')" "files in the primary" &&
assert_eq 1 "$(ls -d "$BASE/work"/file-history.before-share-* | wc -l | tr -d ' ')" "kept file-history folders" &&
assert_eq 1 "$(ls -d "$BASE/work"/tasks.before-share-* | wc -l | tr -d ' ')" "kept tasks folders" &&
assert_eq "" "$(readlink "$BASE/work"/file-history.before-share-* 2>/dev/null || true)" "the kept folder is a real folder" &&
assert_eq 1 "$(cat "$WORLD/a.out" "$WORLD/b.out" | grep -c 'merged its own file-history')" "merges reported" &&
assert_eq "$HOME/.claude/file-history" "$(readlink "$BASE/work/file-history")" "file-history symlink" && ok

finish
