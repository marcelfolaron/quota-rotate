// The mod against a mocked host: an in-memory file system, a scripted `claude`, a
// clock the test moves. Covers what the policy tests cannot: the handoff file, the
// wait for an idle session, the signal that ends it, the pane and /quota-setup.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AccountUsage, Handoff } from '../types'
import { END_SESSION_SCRIPT, SHIM_MARKER } from './policy'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const HOME = '/home/u'
const BASE = `${HOME}/.claude-accounts`
const HANDOFF = `${BASE}/handoff.1.json`
const LATER = new Date(NOW + 3_600_000).toISOString()
const FRESH = new Date(NOW - 60_000).toISOString()

function reading(account: string, percentUsed: number, observedAt = FRESH): AccountUsage {
  return {
    version: 1,
    account,
    configDir: `${BASE}/${account}`,
    observedAt,
    windows: { five_hour: { percentUsed, resetsAt: LATER }, seven_day: { percentUsed: 10, resetsAt: LATER } },
  }
}

const REGISTRY = {
  version: 1,
  accounts: {
    work: { configDir: `${BASE}/work`, email: 'me@example.com', orgId: 'org-work', enabled: true },
    personal: { configDir: `${BASE}/personal`, email: 'me@example.com', orgId: 'org-me', enabled: true },
  },
}

type Host = {
  files: Map<string, string>
  runs: string[][]
  toasts: string[]
  logs: string[]
  statuses: (string | undefined)[]
  commands: string[]
  opened: string[]
  agents: { id: string; status: string }[]
  /** When set, every probe the mod runs is killed by the host (a timeout), as a hung child is. */
  probesFail: boolean
  /** The accounts the mod probed, in order. */
  probed: string[]
  /** True once the mod ran the script that sends SIGTERM to the session. */
  isEnded: () => boolean
  handoff: () => Handoff | undefined
}

/** Everything beneath the mod, answered from memory. `files` is keyed by absolute path. */
function host(on: On, env: Record<string, string>, files: Record<string, string> = {}): Host {
  const state: Host = {
    files: new Map(Object.entries(files)),
    runs: [],
    toasts: [],
    logs: [],
    statuses: [],
    commands: [],
    opened: [],
    agents: [],
    probesFail: false,
    probed: [],
    isEnded: () => state.runs.some(argv => argv[0] === 'sh' && argv[2] === END_SESSION_SCRIPT),
    handoff: () => {
      const text = state.files.get(HANDOFF)
      return text === undefined ? undefined : (JSON.parse(text) as Handoff)
    },
  }
  mock.env(on, { HOME, PATH: '/usr/bin', ...env })
  // The engine's own answers to the lifecycle events the mod passes on with `next(e)`.
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}) as never)
  on('classic.SubagentStop', () => ({}) as never)
  on('classic.StopFailure', () => ({}) as never)
  // A `$` call is answered with `{ value }`, as the engine's own bottom would.
  on('fs.exists', (_, e) => ({ value: state.files.has(e.path) || [...state.files.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.read', (_, e) => {
    const text = state.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    state.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: [...state.files.keys()]
      .filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/'))
      .map(k => ({ name: k.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false })),
  }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    state.runs.push(argv)
    const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (argv[0] === 'mv') {
      state.files.set(argv[3]!, state.files.get(argv[2]!) ?? '')
      state.files.delete(argv[2]!)
      return { value: ok }
    }
    if (argv[0] === 'rm') {
      state.files.delete(argv[2]!)
      return { value: ok }
    }
    if (argv[1] === 'auth') return { value: { ...ok, stdout: JSON.stringify({ loggedIn: true, email: 'me@example.com', orgId: 'org-work' }) } }
    if (argv[0] === 'env') {
      const account = argv.find(a => a.startsWith('QUOTA_ROTATE_ACCOUNT='))?.slice('QUOTA_ROTATE_ACCOUNT='.length) ?? '?'
      state.probed.push(account)
      if (state.probesFail) throw new Error('$.process.run(env) aborted: still running after 60000ms')
      // The probed account's own mod instance writes its reading.
      state.files.set(`${BASE}/usage/${account}.json`, JSON.stringify({ ...reading(account, 10), observedAt: new Date(NOW).toISOString() }))
      return { value: { ...ok, stdout: 'ok' } }
    }
    return { value: ok }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 50, resetsAt: LATER }] },
  }))
  on('command.register', (_, e) => {
    state.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('command.list', () => ({ value: [] }))
  on('agent.list', () => ({ value: state.agents as never }))
  on('ui.toast', (_, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    state.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    state.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    state.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  return state
}

const LAUNCHER_ENV = {
  QUOTA_ROTATE_ACCOUNT: 'work',
  QUOTA_ROTATE_HANDOFF: HANDOFF,
  CLAUDE_CONFIG_DIR: `${BASE}/work`,
}

function files(personalPercent = 10): Record<string, string> {
  return {
    [`${BASE}/accounts.json`]: JSON.stringify(REGISTRY),
    [`${BASE}/usage/personal.json`]: JSON.stringify(reading('personal', personalPercent)),
  }
}

const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }

function measure(percentUsed: number) {
  return {
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: LATER }, { kind: 'seven_day', percentUsed: 10, resetsAt: LATER }],
    changed: ['rateLimits' as const],
  }
}

function turnDone(turnId: string) {
  return { answer: 'done', durationMs: 10, isAborted: false, turnId, reason: 'answer' as const }
}

describe('session start', () => {
  test('records this account, registers the commands, opens the pane and records the plugin folder', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, files())
    mock.clock(on, { now: NOW })
    await $.session.start(START)
    const mine = JSON.parse(h.files.get(`${BASE}/usage/work.json`) ?? '{}') as AccountUsage
    expect(mine.account).toBe('work')
    expect(mine.windows.five_hour?.percentUsed).toBe(50)
    expect(h.commands.sort()).toEqual(['quota', 'quota-probe', 'quota-setup', 'quota-switch'])
    expect(h.opened).toEqual(['quota'])
    expect(h.files.get(`${BASE}/plugin-root`)?.trim().length).toBeGreaterThan(0)
    expect(h.logs.some(line => line.includes('account work') && line.includes('under claude-rotate'))).toBe(true)
  })

  test('a probe run records and stops: no commands, no pane', async ($, on) => {
    const h = host(on, { ...LAUNCHER_ENV, QUOTA_ROTATE_PROBE: '1' }, files())
    mock.clock(on, { now: NOW })
    await $.session.start({ ...START, isInteractive: false })
    expect(h.files.has(`${BASE}/usage/work.json`)).toBe(true)
    expect(h.commands).toEqual([])
    expect(h.opened).toEqual([])
  })

  test('a handoff file left behind is removed at start', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, { ...files(), [HANDOFF]: '{"stale":true}' })
    mock.clock(on, { now: NOW })
    await $.session.start(START)
    expect(h.files.has(HANDOFF)).toBe(false)
  })
})

describe('handing off', () => {
  test('at the threshold, idle: writes the handoff and ends the session after the toast', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, files())
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    await $.session.measure(measure(96))
    expect(h.handoff()).toEqual(expect.objectContaining({ from: 'work', to: 'personal', sessionId: 'sess-1', cwd: '/work', reason: 'threshold' }))
    expect(h.isEnded()).toBe(false)
    await clock.advance(750)
    expect(h.isEnded()).toBe(true)
    expect(h.toasts.some(t => t.includes('switching to personal'))).toBe(true)
  })

  test('below the threshold nothing happens', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, files())
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    await $.session.measure(measure(80))
    await clock.advance(5_000)
    expect(h.handoff()).toBeUndefined()
    expect(h.isEnded()).toBe(false)
    expect(h.statuses.at(-1)).toContain('work at 80%')
  })

  test('waits for the running turn, then goes', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, files())
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    await $.turn.start({ text: 'build it', turnId: 't1' })
    await $.session.measure(measure(97))
    expect(h.handoff()?.to).toBe('personal')
    await clock.advance(5_000)
    expect(h.isEnded()).toBe(false)
    expect(h.toasts.some(t => t.includes('once this turn ends'))).toBe(true)
    await $.turn.complete(turnDone('t1'))
    await clock.advance(750)
    expect(h.isEnded()).toBe(true)
  })

  test('a threshold switch waits for running agents and background tasks; a rate limit does not', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, files())
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    h.agents = [{ id: 'a1', status: 'running' }]
    await $.session.measure(measure(96))
    await clock.advance(5_000)
    expect(h.isEnded()).toBe(false)
    expect(h.statuses.at(-1)).toContain('once the running agent ends')
    h.agents = []
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'watch CI' }] } as never)
    await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'a1', agent_type: 'x', agent_transcript_path: '' } as never)
    await clock.advance(5_000)
    expect(h.isEnded()).toBe(false)
    expect(h.statuses.at(-1)).toContain('once the background task ends')
    // The hard limit arrives while still waiting: the wait is over.
    await $.classic.StopFailure({ error: 'rate_limit' } as never)
    expect(h.handoff()?.reason).toBe('rate_limit')
    await clock.advance(750)
    expect(h.isEnded()).toBe(true)
  })

  test('a rate limit forces the switch below the threshold', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, files())
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    await $.session.measure(measure(40))
    await $.classic.StopFailure({ error: 'rate_limit' } as never)
    expect(h.handoff()).toEqual(expect.objectContaining({ to: 'personal', reason: 'rate_limit' }))
    await clock.advance(750)
    expect(h.isEnded()).toBe(true)
  })

  test('without the launcher it asks for /login instead', async ($, on) => {
    const { QUOTA_ROTATE_HANDOFF: _, ...env } = LAUNCHER_ENV
    const h = host(on, env, files())
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    await $.session.measure(measure(99))
    await clock.advance(5_000)
    expect(h.handoff()).toBeUndefined()
    expect(h.isEnded()).toBe(false)
    expect(h.toasts.some(t => t.includes('/login') && t.includes('personal'))).toBe(true)
  })

  test('with no account that has headroom it says so and stays', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, files(90))
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    await $.session.measure(measure(99))
    await clock.advance(5_000)
    expect(h.handoff()).toBeUndefined()
    expect(h.isEnded()).toBe(false)
    expect(h.toasts.some(t => t.includes('no other account has headroom'))).toBe(true)
  })

  test('/quota-switch names the account and hands off at once', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, files())
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    const result = await $.command.run({ command: 'quota-switch', args: 'personal', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)
    expect(result.text).toBe('Switching to personal.')
    expect(h.handoff()?.reason).toBe('manual')
    await clock.advance(750)
    expect(h.isEnded()).toBe(true)
  })

  test('if the process survives the signal, the switch is handed back to the person', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, files())
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    await $.session.measure(measure(96))
    await clock.advance(750)
    expect(h.isEnded()).toBe(true)
    await clock.advance(10_000)
    expect(h.toasts.at(-1)).toContain('type /exit to switch to personal')
    // and a later measurement tries again
    await $.session.measure(measure(97))
    await clock.advance(750)
    expect(h.runs.filter(argv => argv[2] === END_SESSION_SCRIPT).length).toBe(2)
  })
})

describe('probes', () => {
  const STALE = new Date(NOW - 7 * 3_600_000).toISOString()
  const spare = { configDir: `${BASE}/spare`, email: 'me@example.com', orgId: 'org-spare', enabled: true }
  const full = { configDir: `${BASE}/full`, email: 'me@example.com', orgId: 'org-full', enabled: true }

  function probeFiles(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...files(),
      [`${BASE}/accounts.json`]: JSON.stringify({ version: 1, accounts: { ...REGISTRY.accounts, spare, full } }),
      [`${BASE}/usage/full.json`]: JSON.stringify({ ...reading('full', 100, STALE), windows: { seven_day: { percentUsed: 100, resetsAt: LATER } } }),
      ...extra,
    }
  }

  test('shortly after start, an account with no reading is probed and a full one is left alone', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, probeFiles())
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    await clock.advance(3_000)
    expect(h.probed).toEqual(['spare'])
    expect(h.files.has(`${BASE}/usage/spare.probe.json`)).toBe(false)
    const argv = h.runs.find(r => r[0] === 'env')!
    expect(argv).toContain('--strict-mcp-config')
    expect(argv.some(a => a.startsWith('CLAUDE_CODE_PLUGIN_DIRS='))).toBe(true)
    // The reading the probe produced is in the pane's data from then on.
    await clock.advance(60_000)
    expect(h.probed).toEqual(['spare'])
  })

  test('a failed probe is said once and backed off for thirty minutes, for every session', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, probeFiles())
    h.probesFail = true
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    await clock.advance(3_000)
    expect(h.probed).toEqual(['spare'])
    const mark = JSON.parse(h.files.get(`${BASE}/usage/spare.probe.json`) ?? '{}') as { failedAt?: string }
    expect(mark.failedAt).toBe(new Date(NOW + 3_000).toISOString())
    expect(h.logs.filter(l => l.includes('probe of spare failed')).length).toBe(1)
    await clock.advance(10 * 60_000)
    expect(h.probed).toEqual(['spare'])
    await clock.advance(21 * 60_000)
    expect(h.probed).toEqual(['spare', 'spare'])
    expect(h.logs.filter(l => l.includes('probe of spare failed')).length).toBe(1)
  })

  test('a probe another session started is not doubled; /quota-probe overrides a backoff but not that', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, probeFiles({ [`${BASE}/usage/spare.probe.json`]: JSON.stringify({ startedAt: new Date(NOW - 30_000).toISOString() }) }))
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(START)
    await clock.advance(3_000)
    expect(h.probed).toEqual([])
    const run = { command: 'quota-probe', args: 'spare', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never
    expect((await $.command.run(run)).text).toBe('Could not probe spare.')
    h.files.set(`${BASE}/usage/spare.probe.json`, JSON.stringify({ failedAt: new Date(NOW).toISOString() }))
    expect((await $.command.run(run)).text).toBe('Probed spare.')
    expect(h.probed).toEqual(['spare'])
  })
})

describe('setup and pane', () => {
  test('/quota-setup writes the shims, keeps a foreign file, and points at the PATH line', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, { ...files(), [`${HOME}/.local/bin/cr`]: '#!/bin/sh\necho mine\n' })
    mock.clock(on, { now: NOW })
    await $.session.start(START)
    const result = await $.command.run({ command: 'quota-setup', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)
    expect(h.files.get(`${HOME}/.local/bin/claude-rotate`)).toContain(SHIM_MARKER)
    expect(h.files.get(`${HOME}/.local/bin/claude-rotate`)).toContain('scripts/claude-rotate')
    expect(h.files.get(`${HOME}/.local/bin/quota-accounts`)).toContain('scripts/quota-accounts')
    expect(h.files.get(`${HOME}/.local/bin/cr`)).toBe('#!/bin/sh\necho mine\n')
    expect(h.runs.some(argv => argv[0] === 'chmod' && argv[2] === `${HOME}/.local/bin/claude-rotate`)).toBe(true)
    expect(result.text).toContain('Left /home/u/.local/bin/cr alone')
    expect(result.text).toContain('export PATH="/home/u/.local/bin:$PATH"')
    expect(result.text).toContain('Accounts registered: work, personal')
  })

  test('the pane lists every account and offers the next one', async ($, on) => {
    const h = host(on, LAUNCHER_ENV, files())
    mock.clock(on, { now: NOW })
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({
        plugin: 'quota-rotate',
        surface,
        component: 'Pane',
        requestId: 'quota',
        props: { title: 'Quota', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { top: 0 }, view: { rows: 20 } } as never,
      })
      const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
      expect(texts.some(t => t.includes('work'))).toBe(true)
      expect(texts.some(t => t.includes('personal'))).toBe(true)
      expect(texts.some(t => t.includes('next: personal (10%)'))).toBe(true)
      expect((await pane.find({ type: 'Button', key: 'switch' }))?.props.label).toBe('Switch to personal')
      await pane.unmount()
    }
    expect(h.isEnded()).toBe(false)
  })
})
