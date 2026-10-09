// Picks the account to launch under, from the same policy the mod uses.
// Usage: node scripts/pick.ts <base-dir> [exclude-account] [switch-at]
// Prints the account name, or nothing when no account has headroom.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { rankCandidates, HEADROOM_MARGIN } from '../hooks/policy.ts'
import type { AccountUsage, Registry, Snapshot } from '../types/index.d.ts'

const [base, exclude = '', switchAtArg = '95'] = process.argv.slice(2)
if (!base) {
  console.error('usage: pick.ts <base-dir> [exclude-account] [switch-at]')
  process.exit(2)
}
const switchAt = Number(switchAtArg)
const registryPath = join(base, 'accounts.json')
const registry: Registry = existsSync(registryPath)
  ? (JSON.parse(readFileSync(registryPath, 'utf8')) as Registry)
  : { version: 1, accounts: {} }

const snapshot: Snapshot = {}
const usageDir = join(base, 'usage')
if (existsSync(usageDir)) {
  for (const name of readdirSync(usageDir)) {
    if (!name.endsWith('.json')) continue
    try {
      const reading = JSON.parse(readFileSync(join(usageDir, name), 'utf8')) as AccountUsage
      if (reading.version === 1 && reading.account) snapshot[reading.account] = reading
    } catch {
      // a half-written file: skipped this pass
    }
  }
}

const ranked = rankCandidates(snapshot, registry.accounts, exclude, Date.now())
const best = ranked[0]
if (process.env.QUOTA_ROTATE_DEBUG) console.error(JSON.stringify(ranked, null, 2))
// With an exclusion (a handoff), insist on headroom; for a cold launch any account will do.
const isUsable = best !== undefined && (!exclude || best.percent <= switchAt - HEADROOM_MARGIN)
if (!isUsable) process.exit(1)
console.log(best.account)
