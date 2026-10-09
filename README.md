# quota-rotate

A Claude Code mod plus a launcher. It tracks the claude.ai usage windows of every
account you own, shows them in one pane, and when the account a session runs under
reaches its limit it hands the session to the account with the most headroom:
the launcher restarts Claude Code under that account and resumes the same session.

What it does **not** do: switch accounts without a restart. The one in-process
switch Claude Code offers is `/login`, which keeps the session and its context but
needs a click in the browser, so it cannot be automated. The automatic path is an
exit plus a relaunch with `--resume`, at a turn boundary; the conversation is kept.
`/login` stays the manual fallback, and the mod tells you when it is due.

## Terms

Multiple accounts per machine are documented by Anthropic (`CLAUDE_CONFIG_DIR`,
"Log in with multiple accounts"). Rotating between your own paid accounts to keep
working past one account's window is not addressed by the Consumer Terms or the
Usage Policy either way. Read both before relying on this.

## Layout

```
~/.claude-accounts/
  accounts.json          registry: name -> configDir, email, orgName, enabled
  usage/<name>.json      last reading per account, written by the mod
  <name>/                a CLAUDE_CONFIG_DIR per extra account; projects/, plugins/,
                         skills/, settings.json are symlinks to ~/.claude so every
                         account sees the same sessions and setup
```

`default` is `~/.claude` itself, run with `CLAUDE_CONFIG_DIR` **unset**. The macOS
Keychain entry is keyed to the variable, so `CLAUDE_CONFIG_DIR=~/.claude` reads a
different, empty entry and reports "Not logged in"; both scripts unset it for `default`.

## Setup

```bash
# one time per account; opens the browser login for that account
~/Source/quota-rotate/scripts/quota-accounts add default
~/Source/quota-rotate/scripts/quota-accounts add work
~/Source/quota-rotate/scripts/quota-accounts add personal
~/Source/quota-rotate/scripts/quota-accounts list
```

Then launch through the rotator instead of `claude`:

```bash
alias cr='~/Source/quota-rotate/scripts/claude-rotate'
cr                      # picks the emptiest account
cr --account work       # or name one
cr --model opus         # anything after the launcher's own flags goes to claude
cr --resume             # session picker (all accounts share projects/, so every session is listed)
cr -r <id|name>         # resume one session; cr -c continues the latest in this directory
```

The launcher loads the mod with `CLAUDE_CODE_PLUGIN_DIRS`, so it is active in every
account without installing it per config dir.

## In a session

- `/quota` opens the pane: one row per account and window, bar, percent, reset time,
  age of the reading, which account is next.
- `/quota-switch [account]` hands off now.
- The mod records this account's windows after every turn (`session.measure`),
  re-reads the other accounts' files once a minute, and hands off when the fullest
  window reaches `switch_at` (default 95, set in `/config`) or when a turn dies on a
  `rate_limit` error. On a rate-limit handoff the relaunch sends one prompt asking
  Claude to continue; on a threshold handoff it resumes idle.
- Outside the launcher (plain `claude`), it still records and shows usage and tells
  you to `/login` yourself when a switch would be due.

## Limits and known gaps

- An idle account's reading ages. A passed `resetsAt` counts as 0, but claude.ai web
  use on that account is invisible until a session runs there.
- An account with no reading ranks as empty. Its first turn corrects that.
- `session.usage().rateLimits` is empty off a subscription; Console or API-key logins
  are not tracked.
- The handoff exits with `/exit` through the mods API. If the engine refuses that
  from a hook, a toast asks you to type `/exit`; the launcher takes over from there.
- Do not set `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in your shell: both
  outrank every account's login. The launcher unsets them for its run.
- Claude Code's own `autoContinueAtUsageLimit` (on by default) parks a session at a
  usage limit to wait for the reset. A parked session may not count as idle, and the
  mod's `/exit` is queued until the session is idle. Under the launcher set
  `"autoContinueAtUsageLimit": false` in the shared `settings.json`; the threshold
  handoff normally fires before the hard limit anyway.
- Launch each new account once by hand (`cr --account <name>`) before relying on a
  handoff into it: the first start in a fresh config dir can show onboarding and
  workspace-trust prompts, and those would sit in front of the resumed session.
- On start the mod logs one line: the account it tracks, whether it runs under the
  launcher, and whether `/exit` is reachable from a hook. If that line says `NOT
  listed`, the switch is manual: the toast asks you to type `/exit`.

## Develop

```bash
claude plugin validate ~/Source/quota-rotate
claude plugin test ~/Source/quota-rotate          # hooks/policy.test.ts
# a terminal wrapper on PATH (cmux) breaks `plugin test`; use the real binary:
~/.local/bin/claude plugin test ~/Source/quota-rotate
claude --plugin-dir ~/Source/quota-rotate         # one session, hot reload on save
```
