// quota-rotate: one reading per account on disk, a pane over all of them, and a
// handoff to the launcher when this account runs out.
//
// Identity: QUOTA_ROTATE_ACCOUNT (set by scripts/claude-rotate), else derived
// from CLAUDE_CONFIG_DIR, then corrected by `claude auth status` when the
// registry knows the account's email.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { AccountUsage, Handoff, Registry, RegistryAccount, Snapshot } from '../types'
import {
  BASE_DIR_NAME,
  accountNameOf,
  bar,
  bindingPercent,
  clampThreshold,
  colorOf,
  formatAge,
  formatReset,
  hasReading,
  isStale,
  matchAccount,
  pickNext,
  probeArgv,
  PROBE_AFTER_MS,
  rankCandidates,
  windowLabel,
} from './policy'

const PANE = 'quota'
const REFRESH_MS = 60_000
const NAG_MS = 10 * 60_000
const EXIT_DELAY_MS = 750
const PROBE_TIMEOUT_MS = 120_000
/** Before a handoff, a target's reading older than this is refreshed first. */
const PROBE_BEFORE_SWITCH_MS = 3_600_000

const snapshot = atom({ plugin: 'quota-rotate', key: 'snapshot' } as const, {})
const registry = atom({ plugin: 'quota-rotate', key: 'registry' } as const, {})

type Identity = {
  me: string
  configDir: string
  baseDir: string
  handoffPath: string | undefined
  switchAt: number
  /** A headless probe run: record only, never probe, switch or draw. */
  isProbe: boolean
  isInteractive: boolean
}

let identity: Identity = {
  me: 'default', configDir: '', baseDir: '', handoffPath: undefined, switchAt: 95, isProbe: false, isInteractive: false,
}
let isIdentified = false
let isSwitching = false
let lastNagAt = 0
const probing = new Set<string>()

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

function usageDir(): string {
  return `${identity.baseDir}/usage`
}

async function loadRegistry($: EngineInterface): Promise<void> {
  const path = `${identity.baseDir}/accounts.json`
  let accounts: Record<string, RegistryAccount> = {}
  if (await $.fs.exists(path)) {
    const parsed = parseJson<Registry>(String(await $.fs.read(path)))
    if (parsed?.accounts) accounts = parsed.accounts
  }
  await update($, registry, () => accounts)
}

/** Re-reads every account's last reading; a half-written file is skipped until the next pass. */
async function refreshSnapshot($: EngineInterface): Promise<Snapshot> {
  const next: Snapshot = {}
  if (await $.fs.exists(usageDir())) {
    for (const entry of await $.fs.list(usageDir())) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const parsed = parseJson<AccountUsage>(String(await $.fs.read(`${usageDir()}/${entry.name}`)))
      if (parsed?.version === 1 && typeof parsed.account === 'string' && parsed.windows) next[parsed.account] = parsed
    }
  }
  await update($, snapshot, () => next)
  return next
}

/** Writes this account's reading: temp file then rename, so a reader never sees a torn file. */
async function record($: EngineInterface, limits: readonly SessionRateLimit[]): Promise<void> {
  const windows: AccountUsage['windows'] = {}
  for (const limit of limits) {
    windows[limit.kind] = limit.resetsAt === undefined
      ? { percentUsed: limit.percentUsed }
      : { percentUsed: limit.percentUsed, resetsAt: limit.resetsAt }
  }
  const reading: AccountUsage = {
    version: 1,
    account: identity.me,
    configDir: identity.configDir,
    observedAt: new Date(await $.clock.now()).toISOString(),
    windows,
    sessionId: await $.session.id(),
  }
  const final = `${usageDir()}/${identity.me}.json`
  const temp = `${final}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await $.fs.write(temp, JSON.stringify(reading, null, 2) + '\n')
  const moved = await $.process.run(['mv', '-f', temp, final], { timeoutMs: 5_000 })
  if (moved.exitCode !== 0) $.ui.log(`could not write ${final}: ${moved.stderr.trim()}`)
  await update($, snapshot, current => ({ ...current, [identity.me]: reading }))
}

/** Matches the live login's email against the registry, so a manual /login is attributed correctly. */
async function identify($: EngineInterface): Promise<void> {
  try {
    const ran = await $.process.run(['claude', 'auth', 'status', '--json'], { timeoutMs: 20_000 })
    if (ran.exitCode !== 0) {
      $.ui.log(`auth status exited ${ran.exitCode}: ${(ran.stderr || ran.stdout).trim().slice(0, 160)}`)
      return
    }
    const status = parseJson<{ email?: string; orgId?: string }>(ran.stdout)
    if (!status?.email) {
      $.ui.log(`auth status gave no email: ${ran.stdout.trim().slice(0, 160)}`)
      return
    }
    const accounts = await read($, registry)
    const match = matchAccount(accounts, status)
    if (match === undefined) {
      $.ui.log(`login ${status.email} (org ${status.orgId ?? '?'}) matches no registered account; tracking as ${identity.me}`)
      return
    }
    isIdentified = true
    if (match !== identity.me) {
      $.ui.log(`login is ${match} (${status.email}); tracking that account`)
      identity = { ...identity, me: match }
    }
  } catch (error) {
    $.ui.log(`could not run claude auth status: ${String(error).slice(0, 200)}`)
  }
}

function configDirOf(account: string, accounts: Record<string, RegistryAccount>, home: string): string | undefined {
  const dir = accounts[account]?.configDir
  if (dir === undefined || dir === `${home}/.claude`) return undefined
  return dir
}

/** Runs one headless turn under `account`; that account's mod writes its reading, then we re-read. */
async function probe($: EngineInterface, account: string): Promise<boolean> {
  if (identity.isProbe || probing.has(account) || account === identity.me) return false
  const accounts = await read($, registry)
  if (!(account in accounts)) return false
  probing.add(account)
  $.ui.status(`probing ${account}…`)
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const ran = await $.process.run(probeArgv(account, configDirOf(account, accounts, home), $.plugin.root), {
      cwd: home,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    if (ran.exitCode !== 0) {
      $.ui.log(`probe of ${account} exited ${ran.exitCode}: ${(ran.stderr || ran.stdout).trim().slice(0, 200)}`)
    }
    await refreshSnapshot($)
    return ran.exitCode === 0
  } catch (error) {
    $.ui.log(`probe of ${account} failed: ${String(error).slice(0, 200)}`)
    return false
  } finally {
    probing.delete(account)
    $.ui.status(undefined)
  }
}

/** Probes every other registered account whose reading is missing or older than `maxAgeMs`, one at a time. */
async function probeStale($: EngineInterface, maxAgeMs: number): Promise<void> {
  if (identity.isProbe || !identity.isInteractive) return
  const nowMs = await $.clock.now()
  const snap = await read($, snapshot)
  const accounts = await read($, registry)
  for (const account of Object.keys(accounts)) {
    if (account === identity.me || accounts[account]?.enabled === false) continue
    if (isStale(snap[account], nowMs, maxAgeMs)) await probe($, account)
  }
}

function myPercent(snap: Snapshot, nowMs: number): number {
  return bindingPercent(snap[identity.me], nowMs)
}

async function writeHandoff($: EngineInterface, to: string, reason: Handoff['reason']): Promise<boolean> {
  if (identity.handoffPath === undefined) return false
  const handoff: Handoff = {
    version: 1,
    from: identity.me,
    to,
    sessionId: await $.session.id(),
    cwd: await $.session.cwd(),
    reason,
    at: new Date(await $.clock.now()).toISOString(),
  }
  await $.fs.write(identity.handoffPath, JSON.stringify(handoff, null, 2) + '\n')
  return true
}

/** Hands the session to `to`: the launcher relaunches under that account and resumes this session id. */
async function switchTo($: EngineInterface, to: string, reason: Handoff['reason']): Promise<void> {
  if (isSwitching) return
  if (!(await writeHandoff($, to, reason))) {
    $.ui.toast(`not running under claude-rotate; run /login and pick ${to} yourself`, { timeoutMs: 12_000 })
    return
  }
  isSwitching = true
  $.ui.toast(`switching to ${to}: this session resumes there`, { timeoutMs: 8_000 })
  $.clock.after(EXIT_DELAY_MS, () => {
    $.command.run({ command: 'exit' }).catch(() => {
      isSwitching = false
      $.ui.toast(`type /exit to switch to ${to}`, { timeoutMs: 15_000 })
    })
  })
}

async function maybeSwitch($: EngineInterface, reason: Handoff['reason'], isForced: boolean): Promise<void> {
  if (isSwitching || identity.isProbe) return
  let nowMs = await $.clock.now()
  let snap = await read($, snapshot)
  const mine = myPercent(snap, nowMs)
  if (!isForced && mine < identity.switchAt) {
    $.ui.status(mine >= 70 ? `${identity.me} at ${mine}% (switches at ${identity.switchAt}%)` : undefined)
    return
  }
  const accounts = await read($, registry)
  let to = pickNext(snap, accounts, identity.me, nowMs, identity.switchAt)
  // A target chosen on a stale or missing reading is checked first: a probe is 5 s, a wrong handoff is a loop.
  if (to !== undefined && isStale(snap[to], nowMs, PROBE_BEFORE_SWITCH_MS)) {
    await probe($, to)
    nowMs = await $.clock.now()
    snap = await read($, snapshot)
    to = pickNext(snap, accounts, identity.me, nowMs, identity.switchAt)
  }
  if (to === undefined) {
    if (nowMs - lastNagAt > NAG_MS) {
      lastNagAt = nowMs
      $.ui.toast(`${identity.me} at ${mine}% and no other account has headroom`, { timeoutMs: 10_000 })
    }
    $.ui.status(`${identity.me} at ${mine}%: no account with headroom`)
    return
  }
  await switchTo($, to, reason)
}

export const register: Register = (on, options) => {
  identity = { ...identity, switchAt: clampThreshold(options.switch_at) }

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
    identity = {
      ...identity,
      configDir,
      baseDir: `${home}/${BASE_DIR_NAME}`,
      handoffPath: await $.env.get('QUOTA_ROTATE_HANDOFF'),
      me: accountNameOf({ account: await $.env.get('QUOTA_ROTATE_ACCOUNT'), configDir, home }),
      isProbe: (await $.env.get('QUOTA_ROTATE_PROBE')) === '1',
      isInteractive: e.isInteractive,
    }
    await loadRegistry($)
    await refreshSnapshot($)
    await identify($)
    const live = await $.session.usage()
    if (live.rateLimits.length > 0) await record($, live.rateLimits)
    if (identity.isProbe) return next(e)

    $.clock.every(REFRESH_MS, () => {
      void (async () => {
        await loadRegistry($)
        await refreshSnapshot($)
        // The registry can appear or grow after this session started (quota-accounts add).
        if (!isIdentified && Object.keys(await read($, registry)).length > 0) await identify($)
        await probeStale($, PROBE_AFTER_MS)
      })()
    })
    // Readings the other accounts lack: fetched shortly after start, off the start path.
    $.clock.after(3_000, () => {
      void probeStale($, PROBE_AFTER_MS)
    })

    try {
      await $.command.register({ name: 'quota', description: 'Usage across all Claude accounts', immediate: true })
      await $.command.register({
        name: 'quota-switch',
        description: 'Move this session to another account (the emptiest when none is named)',
        argumentHint: '[account]',
      })
      await $.command.register({
        name: 'quota-probe',
        description: 'Refresh the other accounts\' readings with a one-line headless run each',
        argumentHint: '[account]',
      })
    } catch (error) {
      $.ui.log(`command not registered: ${String(error)}`)
    }
    // The handoff exits the session through /exit; say up front whether that command is reachable.
    const hasExit = (await $.command.list()).some(command => command.name === 'exit')
    $.ui.log(`account ${identity.me} · switch at ${identity.switchAt}% · ${identity.handoffPath ? 'under claude-rotate' : 'no launcher'} · /exit ${hasExit ? 'available' : 'NOT listed'}`)
    if (e.isInteractive) void $.ui.open({ id: PANE, title: 'Quota' })
    return next(e)
  })

  on('command.run', { command: 'quota' }, async $ => {
    await refreshSnapshot($)
    await $.ui.open({ id: PANE, title: 'Quota', closeOnEscape: true })
    return {}
  })

  on('command.run', { command: 'quota-switch' }, async ($, e) => {
    const nowMs = await $.clock.now()
    const snap = await refreshSnapshot($)
    const accounts = await read($, registry)
    const wanted = e.args.trim()
    const to = wanted || pickNext(snap, accounts, identity.me, nowMs, identity.switchAt)
    if (to === undefined) return { text: 'No other account has headroom.' }
    if (to === identity.me) return { text: `This session already runs as ${to}.` }
    if (wanted && !(wanted in accounts) && !(wanted in snap)) return { text: `Unknown account ${wanted}.` }
    await switchTo($, to, 'manual')
    return { text: `Switching to ${to}.` }
  })

  on('command.run', { command: 'quota-probe' }, async ($, e) => {
    const wanted = e.args.trim()
    if (wanted) {
      const ok = await probe($, wanted)
      return { text: ok ? `Probed ${wanted}.` : `Could not probe ${wanted}.` }
    }
    await probeStale($, 0)
    return { text: 'Probed every other account.' }
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) await record($, e.rateLimits)
    await maybeSwitch($, 'threshold', false)
    return next(e)
  })

  on('classic.StopFailure', { error: 'rate_limit' }, async ($, e, next) => {
    await refreshSnapshot($)
    await maybeSwitch($, 'rate_limit', true)
    return next(e)
  })

  on('classic.Notification', { notification_type: 'auth_success' }, async ($, e, next) => {
    await identify($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const nowMs = await $.clock.now()
    const snap = await read($, snapshot)
    const accounts = await read($, registry)
    const names = [...new Set([identity.me, ...Object.keys(accounts), ...Object.keys(snap)])]
    const isRegistered = (name: string) => Object.keys(accounts).length === 0 || name in accounts
    const candidates = rankCandidates(snap, accounts, identity.me, nowMs)
    const next = pickNext(snap, accounts, identity.me, nowMs, identity.switchAt)
    const width = Math.max(6, Math.min(20, (e.props.bodyColumns ?? 60) - 40))
    const nameWidth = Math.max(8, ...names.map(n => n.length))

    const rows = names.flatMap(name => {
      const usage = snap[name]
      const isMe = name === identity.me
      const label = (isMe ? '● ' : '  ') + name.padEnd(nameWidth)
      if (!isRegistered(name)) {
        return [
          Box({
            key: `acct-${name}`,
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ bold: isMe, dimColor: true, children: [label] }),
              Text({ dimColor: true, children: [`unregistered (${Math.round(bindingPercent(usage, nowMs))}%), never switched to`] }),
            ],
          }),
        ]
      }
      if (!hasReading(usage)) {
        return [
          Box({
            key: `acct-${name}`,
            flexDirection: 'row',
            columnGap: 1,
            children: [Text({ bold: isMe, children: [label] }), Text({ dimColor: true, children: ['no reading yet'] })],
          }),
        ]
      }
      const kinds = Object.keys(usage!.windows).sort()
      return kinds.map((kind, i) => {
        const window = usage!.windows[kind]!
        const percent = Math.round(bindingPercent({ ...usage!, windows: { [kind]: window } }, nowMs))
        const reset = formatReset(window.resetsAt, nowMs)
        return Box({
          key: `acct-${name}-${kind}`,
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Text({ bold: isMe, children: [i === 0 ? label : ' '.repeat(label.length)] }),
            Text({ dimColor: true, children: [windowLabel(kind).padEnd(3)] }),
            Text({ color: colorOf(percent), children: [bar(percent, width)] }),
            Text({ children: [`${String(percent).padStart(3)}%`] }),
            Text({ dimColor: true, children: [reset ? `resets ${reset}` : ''] }),
            ...(i === 0
              ? [Text({ dimColor: true, color: isStale(usage, nowMs, PROBE_AFTER_MS) ? 'warning' : undefined, children: [formatAge(usage!.observedAt, nowMs)] })]
              : []),
          ],
        })
      })
    })

    const summary =
      next !== undefined
        ? `next: ${next} (${Math.round(candidates.find(c => c.account === next)?.percent ?? 0)}%)`
        : candidates.length === 0
          ? 'no other accounts registered'
          : 'no other account has headroom'

    return Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ children: [`switch at ${identity.switchAt}%`] }),
            Text({ dimColor: true, children: [summary] }),
            Text({ dimColor: true, children: [identity.handoffPath ? '' : 'not under claude-rotate: manual /login'] }),
          ],
        }),
        Text({ children: [' '] }),
        ...rows,
        Text({ children: [' '] }),
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Button({
              key: 'refresh',
              label: 'Refresh',
              hotkey: 'r',
              plain: true,
              onPress: async () => {
                await refreshSnapshot($)
              },
            }),
            Button({
              key: 'probe',
              label: probing.size > 0 ? `Probing ${[...probing].join(', ')}…` : 'Probe others',
              hotkey: 'p',
              plain: true,
              dimColor: probing.size > 0,
              onPress: async () => {
                await probeStale($, 0)
              },
            }),
            Button({
              key: 'switch',
              label: next !== undefined ? `Switch to ${next}` : 'Switch',
              hotkey: 's',
              plain: true,
              dimColor: next === undefined,
              onPress: async () => {
                if (next !== undefined) await switchTo($, next, 'manual')
              },
            }),
          ],
        }),
      ],
    })
  })
}
