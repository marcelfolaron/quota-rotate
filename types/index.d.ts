export type UsageWindow = {
  /** 0 to 100, as the API reports it. */
  percentUsed: number
  /** ISO 8601; absent when the API sent none. */
  resetsAt?: string
}

/** One account's last observed usage, as `~/.claude-accounts/usage/<account>.json` holds it. */
export type AccountUsage = {
  version: 1
  account: string
  configDir: string
  /** ISO 8601 time of the reading. */
  observedAt: string
  /** Keyed by window kind: `five_hour`, `seven_day`, ... */
  windows: Record<string, UsageWindow>
  sessionId?: string
}

export type Snapshot = Record<string, AccountUsage>

export type RegistryAccount = {
  configDir: string
  email?: string
  orgId?: string
  orgName?: string
  subscriptionType?: string
  enabled?: boolean
}

/** `~/.claude-accounts/accounts.json`, written by scripts/quota-accounts. */
export type Registry = {
  version: 1
  accounts: Record<string, RegistryAccount>
}

/** `$QUOTA_ROTATE_HANDOFF`, written by the mod and consumed by scripts/claude-rotate. */
export type Handoff = {
  version: 1
  from: string
  to: string
  sessionId: string
  cwd: string
  reason: 'threshold' | 'rate_limit' | 'manual'
  at: string
}

declare module 'claude-code' {
  interface PluginState {
    'quota-rotate': {
      snapshot: Snapshot
      registry: Record<string, RegistryAccount>
    }
  }
}
