import { describe, expect, test } from 'claude-code/testing'

import type { AccountUsage, Snapshot } from '../types'
import {
  accountNameOf,
  bindingPercent,
  clampThreshold,
  effectivePercent,
  formatReset,
  isKnownFull,
  isStale,
  matchAccount,
  pickNext,
  probeArgv,
  probeVerdict,
  rankCandidates,
} from './policy'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const LATER = new Date(NOW + 3_600_000).toISOString()
const EARLIER = new Date(NOW - 60_000).toISOString()

function reading(account: string, windows: AccountUsage['windows']): AccountUsage {
  return { version: 1, account, configDir: `/x/${account}`, observedAt: EARLIER, windows }
}

const REGISTRY = {
  work: { configDir: '/x/work' },
  personal: { configDir: '/x/personal' },
  spare: { configDir: '/x/spare' },
  off: { configDir: '/x/off', enabled: false },
}

describe('windows', () => {
  test('a window whose reset has passed counts as empty', async () => {
    expect(effectivePercent({ percentUsed: 80, resetsAt: EARLIER }, NOW)).toBe(0)
    expect(effectivePercent({ percentUsed: 80, resetsAt: LATER }, NOW)).toBe(80)
    expect(effectivePercent({ percentUsed: 80 }, NOW)).toBe(80)
  })

  test('the binding percent is the fullest live window', async () => {
    const usage = reading('work', {
      five_hour: { percentUsed: 30, resetsAt: LATER },
      seven_day: { percentUsed: 91, resetsAt: LATER },
      seven_day_opus: { percentUsed: 99, resetsAt: EARLIER },
    })
    expect(bindingPercent(usage, NOW)).toBe(91)
    expect(bindingPercent(undefined, NOW)).toBe(0)
  })
})

describe('picking the next account', () => {
  test('ranks the emptiest first and leaves out the current and disabled accounts', async () => {
    const snapshot: Snapshot = {
      work: reading('work', { five_hour: { percentUsed: 97, resetsAt: LATER } }),
      personal: reading('personal', { five_hour: { percentUsed: 40, resetsAt: LATER } }),
      spare: reading('spare', { five_hour: { percentUsed: 10, resetsAt: LATER } }),
      off: reading('off', { five_hour: { percentUsed: 0, resetsAt: LATER } }),
    }
    const ranked = rankCandidates(snapshot, REGISTRY, 'work', NOW)
    expect(ranked.map(c => c.account)).toEqual(['spare', 'personal'])
    expect(pickNext(snapshot, REGISTRY, 'work', NOW, 95)).toBe('spare')
  })

  test('with a registry, a reading from an unregistered config dir is never a candidate', async () => {
    const snapshot: Snapshot = {
      default: reading('default', { five_hour: { percentUsed: 0, resetsAt: LATER } }),
      personal: reading('personal', { five_hour: { percentUsed: 40, resetsAt: LATER } }),
    }
    const ranked = rankCandidates(snapshot, { personal: REGISTRY.personal }, 'work', NOW)
    expect(ranked.map(c => c.account)).toEqual(['personal'])
    // No registry at all: readings are all there is.
    expect(rankCandidates(snapshot, {}, 'work', NOW).map(c => c.account)).toEqual(['default', 'personal'])
  })

  test('an account with no reading is a candidate, behind a known-empty one', async () => {
    const snapshot: Snapshot = {
      spare: reading('spare', { five_hour: { percentUsed: 0, resetsAt: LATER } }),
    }
    const ranked = rankCandidates(snapshot, REGISTRY, 'work', NOW)
    expect(ranked[0]).toEqual({ account: 'spare', percent: 0, isKnown: true })
    expect(ranked[1]).toEqual({ account: 'personal', percent: 0, isKnown: false })
  })

  test('refuses a target without enough headroom below the threshold', async () => {
    const snapshot: Snapshot = {
      personal: reading('personal', { five_hour: { percentUsed: 80, resetsAt: LATER } }),
      spare: reading('spare', { five_hour: { percentUsed: 90, resetsAt: LATER } }),
    }
    expect(pickNext(snapshot, { personal: REGISTRY.personal, spare: REGISTRY.spare }, 'work', NOW, 95)).toBeUndefined()
    expect(pickNext(snapshot, { personal: REGISTRY.personal, spare: REGISTRY.spare }, 'work', NOW, 100)).toBe('personal')
  })

  test('a passed reset makes a full account the best candidate again', async () => {
    const snapshot: Snapshot = {
      personal: reading('personal', { five_hour: { percentUsed: 100, resetsAt: EARLIER } }),
      spare: reading('spare', { five_hour: { percentUsed: 50, resetsAt: LATER } }),
    }
    expect(pickNext(snapshot, REGISTRY, 'work', NOW, 95)).toBe('personal')
  })
})

describe('identity and formatting', () => {
  test('derives the account name from the config directory', async () => {
    const home = '/Users/me'
    expect(accountNameOf({ account: 'work', configDir: '/anything', home })).toBe('work')
    expect(accountNameOf({ configDir: '/Users/me/.claude', home })).toBe('default')
    expect(accountNameOf({ configDir: '/Users/me/.claude-accounts/personal/', home })).toBe('personal')
    expect(accountNameOf({ configDir: '/srv/tenant-a', home })).toBe('tenant-a')
    expect(accountNameOf({ home })).toBe('default')
  })

  test('matches a login to its account by email and organization', async () => {
    const accounts = {
      team: { configDir: '/x/team', email: 'me@x.io', orgId: 'org-team' },
      personal: { configDir: '/x/personal', email: 'me@x.io', orgId: 'org-me' },
      other: { configDir: '/x/other', email: 'other@x.io' },
    }
    expect(matchAccount(accounts, { email: 'me@x.io', orgId: 'org-me' })).toBe('personal')
    expect(matchAccount(accounts, { email: 'me@x.io', orgId: 'org-team' })).toBe('team')
    // Same email, two orgs, org unknown: ambiguous, so no match rather than a wrong one.
    expect(matchAccount(accounts, { email: 'me@x.io' })).toBeUndefined()
    // One entry without an org on record matches by email alone.
    expect(matchAccount(accounts, { email: 'other@x.io', orgId: 'whatever' })).toBe('other')
    expect(matchAccount(accounts, { email: 'nobody@x.io' })).toBeUndefined()
  })

  test('a reading is stale when missing or older than the limit', async () => {
    const fresh = reading('a', { five_hour: { percentUsed: 1 } })
    expect(isStale(undefined, NOW, 1000)).toBe(true)
    expect(isStale({ ...fresh, windows: {} }, NOW, 1000)).toBe(true)
    expect(isStale(fresh, NOW, 120_000)).toBe(false)
    expect(isStale(fresh, NOW, 30_000)).toBe(true)
  })

  test('a probe is a process of its own: launcher and session variables unset, the config dir only for a non-default account', async () => {
    const forWork = probeArgv('work', '/x/work', { pluginRoot: '/plug', claudeBin: '/bin/claude' })
    expect(forWork[0]).toBe('env')
    for (const name of ['CLAUDE_CONFIG_DIR', 'QUOTA_ROTATE_HANDOFF', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDECODE']) {
      expect(forWork[forWork.indexOf(name) - 1]).toBe('-u')
    }
    expect(forWork).toContain('CLAUDE_CONFIG_DIR=/x/work')
    expect(forWork).toContain('QUOTA_ROTATE_PROBE=1')
    expect(forWork).toContain('CLAUDE_CODE_PLUGIN_DIRS=/plug')
    expect(forWork.indexOf('/bin/claude')).toBeGreaterThan(forWork.indexOf('CLAUDE_CODE_PLUGIN_DIRS=/plug'))
    const forDefault = probeArgv('default', undefined)
    expect(forDefault.some(a => a.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false)
    expect(forDefault.some(a => a.startsWith('CLAUDE_CODE_PLUGIN_DIRS='))).toBe(false)
    expect(forDefault.indexOf('-p')).toBeGreaterThan(forDefault.indexOf('claude'))
  })

  test('a probe runs nothing but the one turn: no MCP server, no tool, no transcript, no wait at a limit', async () => {
    const argv = probeArgv('work', '/x/work')
    const tail = argv.slice(argv.indexOf('claude'))
    expect(tail).toContain('--strict-mcp-config')
    expect(tail[tail.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}')
    expect(tail[tail.indexOf('--tools') + 1]).toBe('')
    expect(tail).toContain('--no-session-persistence')
    expect(tail[tail.indexOf('--settings') + 1]).toBe('{"autoContinueAtUsageLimit":false}')
    expect(tail[tail.indexOf('--model') + 1]).toBe('haiku')
  })

  test('an account at 100 with its reset ahead is known full', async () => {
    expect(isKnownFull(reading('a', { seven_day: { percentUsed: 100, resetsAt: LATER }, five_hour: { percentUsed: 0 } }), NOW)).toBe(true)
    expect(isKnownFull(reading('a', { seven_day: { percentUsed: 100, resetsAt: EARLIER } }), NOW)).toBe(false)
    expect(isKnownFull(reading('a', { seven_day: { percentUsed: 99, resetsAt: LATER } }), NOW)).toBe(false)
    expect(isKnownFull(reading('a', { seven_day: { percentUsed: 100 } }), NOW)).toBe(false)
    expect(isKnownFull(undefined, NOW)).toBe(false)
  })

  test('whether to probe: fresh, full and recently failed accounts wait; a running probe is never doubled', async () => {
    const old = { ...reading('a', { five_hour: { percentUsed: 10, resetsAt: LATER } }), observedAt: new Date(NOW - 7 * 3_600_000).toISOString() }
    const full = { ...old, windows: { seven_day: { percentUsed: 100, resetsAt: LATER } } }
    const fresh = reading('a', { five_hour: { percentUsed: 10, resetsAt: LATER } })
    const sixHours = 6 * 3_600_000
    expect(probeVerdict(undefined, undefined, NOW, sixHours)).toBe('due')
    expect(probeVerdict(old, undefined, NOW, sixHours)).toBe('due')
    expect(probeVerdict(fresh, undefined, NOW, sixHours)).toBe('fresh')
    expect(probeVerdict(full, undefined, NOW, sixHours)).toBe('full')
    expect(probeVerdict(old, { failedAt: new Date(NOW - 10 * 60_000).toISOString() }, NOW, sixHours)).toBe('failed-recently')
    expect(probeVerdict(old, { failedAt: new Date(NOW - 31 * 60_000).toISOString() }, NOW, sixHours)).toBe('due')
    expect(probeVerdict(old, { startedAt: new Date(NOW - 60_000).toISOString() }, NOW, sixHours)).toBe('in-flight')
    expect(probeVerdict(old, { startedAt: new Date(NOW - 4 * 60_000).toISOString() }, NOW, sixHours)).toBe('due')
    // Asked for by a person: only a running probe stands in the way.
    expect(probeVerdict(fresh, undefined, NOW, sixHours, true)).toBe('due')
    expect(probeVerdict(full, { failedAt: EARLIER }, NOW, sixHours, true)).toBe('due')
    expect(probeVerdict(old, { startedAt: new Date(NOW - 60_000).toISOString() }, NOW, sixHours, true)).toBe('in-flight')
  })

  test('clamps the threshold and formats resets', async () => {
    expect(clampThreshold(undefined)).toBe(95)
    expect(clampThreshold(120)).toBe(100)
    expect(clampThreshold(10)).toBe(50)
    expect(clampThreshold('90')).toBe(90)
    expect(formatReset(LATER, NOW)).toBe('in 1h 00m')
    expect(formatReset(EARLIER, NOW)).toBe('now')
    expect(formatReset(undefined, NOW)).toBe('')
  })
})
