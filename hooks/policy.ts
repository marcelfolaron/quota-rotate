// Pure decisions: which account has headroom, how a reading ages, how a row is drawn,
// what the mod runs on the host. Nothing here touches `$`, so `claude plugin test`
// checks it without a session.
import type { AccountUsage, RegistryAccount, Snapshot, UsageWindow } from '../types'

export const PLUGIN_NAME = 'quota-rotate'
export const BASE_DIR_NAME = '.claude-accounts'
export const DEFAULT_ACCOUNT = 'default'
/** Points of headroom the target account must have below the switch threshold to be worth moving to. */
export const HEADROOM_MARGIN = 20

/** A window whose reset time has passed counts as empty. */
export function effectivePercent(window: UsageWindow, nowMs: number): number {
  if (window.resetsAt !== undefined) {
    const resets = Date.parse(window.resetsAt)
    if (Number.isFinite(resets) && resets <= nowMs) return 0
  }
  return window.percentUsed
}

/** The fullest window of an account: the one that blocks first. */
export function bindingPercent(usage: AccountUsage | undefined, nowMs: number): number {
  if (usage === undefined) return 0
  let max = 0
  for (const window of Object.values(usage.windows)) max = Math.max(max, effectivePercent(window, nowMs))
  return max
}

export function hasReading(usage: AccountUsage | undefined): boolean {
  return usage !== undefined && Object.keys(usage.windows).length > 0
}

export type Candidate = { account: string; percent: number; isKnown: boolean }

/**
 * Every account but `me`, emptiest first; a known reading outranks a guess at the same percent.
 * With a registry, only registered accounts are candidates: a reading alone (an unregistered
 * config dir that ran the mod) is shown but never switched to.
 */
export function rankCandidates(
  snapshot: Snapshot,
  registry: Record<string, RegistryAccount>,
  me: string,
  nowMs: number,
): Candidate[] {
  const names = new Set(Object.keys(registry).length > 0 ? Object.keys(registry) : Object.keys(snapshot))
  names.delete(me)
  return [...names]
    .filter(account => registry[account]?.enabled !== false)
    .map(account => ({
      account,
      percent: bindingPercent(snapshot[account], nowMs),
      isKnown: hasReading(snapshot[account]),
    }))
    .sort(
      (a, b) =>
        a.percent - b.percent || Number(b.isKnown) - Number(a.isKnown) || a.account.localeCompare(b.account),
    )
}

/** The account to move to, or undefined when none has enough headroom. */
export function pickNext(
  snapshot: Snapshot,
  registry: Record<string, RegistryAccount>,
  me: string,
  nowMs: number,
  switchAt: number,
): string | undefined {
  const best = rankCandidates(snapshot, registry, me, nowMs)[0]
  if (best === undefined) return undefined
  if (best.percent > switchAt - HEADROOM_MARGIN) return undefined
  return best.account
}

/** The account a session belongs to: the launcher's name, else derived from its config directory. */
export function accountNameOf(env: { account?: string; configDir?: string; home?: string }): string {
  if (env.account) return env.account
  const dir = env.configDir?.replace(/\/+$/, '')
  if (!dir) return DEFAULT_ACCOUNT
  const home = env.home?.replace(/\/+$/, '')
  if (home && dir === `${home}/.claude`) return DEFAULT_ACCOUNT
  const base = home ? `${home}/${BASE_DIR_NAME}/` : undefined
  if (base && dir.startsWith(base)) return dir.slice(base.length).split('/')[0] || DEFAULT_ACCOUNT
  return dir.split('/').pop() || DEFAULT_ACCOUNT
}

/** The registered account a live login belongs to: email plus organization, email alone when the entry has no org. */
export function matchAccount(
  registry: Record<string, RegistryAccount>,
  login: { email?: string; orgId?: string },
): string | undefined {
  if (!login.email) return undefined
  const sameEmail = Object.entries(registry).filter(([, account]) => account.email === login.email)
  if (sameEmail.length === 0) return undefined
  const byOrg = sameEmail.find(([, account]) => account.orgId !== undefined && account.orgId === login.orgId)
  if (byOrg) return byOrg[0]
  if (sameEmail.length === 1 && sameEmail[0]![1].orgId === undefined) return sameEmail[0]![0]
  return undefined
}

/** Six hours: a reading older than this is refreshed with a probe before it is trusted. */
export const PROBE_AFTER_MS = 6 * 3_600_000

/** True when the account has no reading, or one older than `maxAgeMs`. */
export function isStale(usage: AccountUsage | undefined, nowMs: number, maxAgeMs: number): boolean {
  if (!hasReading(usage)) return true
  const observed = Date.parse(usage!.observedAt)
  return !Number.isFinite(observed) || nowMs - observed > maxAgeMs
}

/**
 * The argv of a probe: a one-line headless run under `account` with this mod loaded, so that
 * account's own mod instance writes its reading. `env -u` first, so the launcher's variables and
 * an explicit ~/.claude never leak into the probe (the primary's Keychain entry is keyed to NO variable).
 * The mod's folder is always passed: in a headless run a second load beside an installed copy
 * costs nothing, and the probe then works whatever the install scope.
 */
export function probeArgv(account: string, configDir: string | undefined, pluginRoot: string, claudeBin = 'claude'): string[] {
  return [
    'env',
    '-u', 'CLAUDE_CONFIG_DIR', '-u', 'QUOTA_ROTATE_HANDOFF', '-u', 'CLAUDE_CODE_OAUTH_TOKEN', '-u', 'ANTHROPIC_API_KEY',
    ...(configDir !== undefined ? [`CLAUDE_CONFIG_DIR=${configDir}`] : []),
    `QUOTA_ROTATE_ACCOUNT=${account}`,
    'QUOTA_ROTATE_PROBE=1',
    `CLAUDE_CODE_PLUGIN_DIRS=${pluginRoot}`,
    claudeBin, '-p', 'Reply with the single word ok.', '--model', 'haiku', '--setting-sources', 'user',
  ]
}

/**
 * The shell script that ends the Claude Code process this mod runs in. `$.process.run` spawns the
 * shell straight from that process, so its parent is the session; the name is checked first so a
 * host that spawns through a helper is never signalled. SIGTERM ends the session (`session.end`
 * with reason `other`); the launcher then reads the handoff file and relaunches.
 */
export const END_SESSION_SCRIPT = [
  'parent="$(ps -o command= -p "$PPID" 2>/dev/null)"',
  'case "$parent" in',
  '  *claude*) kill -TERM "$PPID" ;;',
  '  *) echo "parent $PPID is not claude: $parent" >&2; exit 3 ;;',
  'esac',
].join('\n')

export function endSessionArgv(): string[] {
  return ['sh', '-c', END_SESSION_SCRIPT]
}

/** True when `~/.claude/plugins/installed_plugins.json` (its text) records this mod under any marketplace. */
export function isInstalled(installedJson: string | undefined): boolean {
  if (!installedJson) return false
  try {
    const parsed = JSON.parse(installedJson) as { plugins?: Record<string, unknown> }
    return Object.keys(parsed.plugins ?? {}).some(key => key.split('@')[0] === PLUGIN_NAME)
  } catch {
    return false
  }
}

/** The commands `/quota-setup` puts on the PATH: `cr` is the short name of the launcher. */
export const SHIMS: ReadonlyArray<{ name: string; target: 'claude-rotate' | 'quota-accounts' }> = [
  { name: 'claude-rotate', target: 'claude-rotate' },
  { name: 'cr', target: 'claude-rotate' },
  { name: 'quota-accounts', target: 'quota-accounts' },
]

/** The first comment line of every shim: a file without it is somebody else's and is left alone. */
export const SHIM_MARKER = '# quota-rotate shim, written by /quota-setup; safe to delete.'

/**
 * A shim that runs `scripts/<target>` of whichever folder the plugin currently lives in. The folder
 * changes with every `claude plugin update`, so the shim resolves it at run time: the pointer file the
 * mod refreshes on every session start, else the install record.
 */
export function shimScript(target: 'claude-rotate' | 'quota-accounts'): string {
  return `#!/usr/bin/env bash
${SHIM_MARKER}
set -eu
base="\${QUOTA_ROTATE_BASE:-$HOME/.claude-accounts}"
root="$(cat "$base/plugin-root" 2>/dev/null || true)"
if [ -z "$root" ] || [ ! -f "$root/scripts/${target}" ]; then
  root="$("\${CLAUDE_BIN:-claude}" plugin list --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const rows = JSON.parse(s); const hit = rows.find(r => r.enabled && String(r.id).split("@")[0] === "${PLUGIN_NAME}");
      if (hit) console.log(hit.installPath) })' 2>/dev/null || true)"
fi
if [ -z "$root" ] || [ ! -f "$root/scripts/${target}" ]; then
  echo "quota-rotate: cannot find the plugin folder. Start claude once with the plugin enabled, then try again (or run /quota-setup in that session)." >&2
  exit 1
fi
exec bash "$root/scripts/${target}" "$@"
`
}

export function clampThreshold(value: unknown, fallback = 95): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(100, Math.max(50, Math.round(n)))
}

export function bar(percent: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function colorOf(percent: number): 'green' | 'yellow' | 'red' {
  if (percent >= 85) return 'red'
  if (percent >= 60) return 'yellow'
  return 'green'
}

export function windowLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  return kind.replace(/^seven_day_/, '7d ').replace(/_/g, ' ')
}

/** "in 2h 05m", "now" once passed, "" when unknown. */
export function formatReset(resetsAt: string | undefined, nowMs: number): string {
  if (resetsAt === undefined) return ''
  const resets = Date.parse(resetsAt)
  if (!Number.isFinite(resets)) return ''
  const left = resets - nowMs
  if (left <= 0) return 'now'
  const hours = Math.floor(left / 3_600_000)
  const minutes = Math.floor((left % 3_600_000) / 60_000)
  if (hours >= 48) return `in ${Math.round(hours / 24)}d`
  if (hours > 0) return `in ${hours}h ${String(minutes).padStart(2, '0')}m`
  return `in ${minutes}m`
}

/** "2m ago", "3h ago", "4d ago". */
export function formatAge(observedAt: string, nowMs: number): string {
  const observed = Date.parse(observedAt)
  if (!Number.isFinite(observed)) return ''
  const age = Math.max(0, nowMs - observed)
  const minutes = Math.floor(age / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
