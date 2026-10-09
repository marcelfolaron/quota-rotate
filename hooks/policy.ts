// Pure decisions: which account has headroom, how a reading ages, how a row is drawn.
// Nothing here touches `$`, so `claude plugin test` checks it without a session.
import type { AccountUsage, RegistryAccount, Snapshot, UsageWindow } from '../types'

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

/** Every account but `me`, emptiest first; a known reading outranks a guess at the same percent. */
export function rankCandidates(
  snapshot: Snapshot,
  registry: Record<string, RegistryAccount>,
  me: string,
  nowMs: number,
): Candidate[] {
  const names = new Set([...Object.keys(registry), ...Object.keys(snapshot)])
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
