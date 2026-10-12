// quota-rotate: one reading per account on disk, a pane over all of them, and a
// handoff to the launcher when this account runs out.
//
// Identity: QUOTA_ROTATE_ACCOUNT (set by scripts/claude-rotate), else derived
// from CLAUDE_CONFIG_DIR, then corrected by `claude auth status` when the
// registry knows the account's email.
//
// Handoff: the mod writes the handoff file, waits until the session is idle (no
// turn, no running agent or background task), then ends the process with SIGTERM.
// `/exit` through the command API cannot do this: with a background task running
// it opens a confirmation nobody answers. The launcher sees the exit, reads the
// file and relaunches under the next account with `--resume`.
import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { AccountUsage, Handoff, Registry, RegistryAccount, Snapshot } from '../types'
import type { ProbeMark } from './policy'
import {
  BASE_DIR_NAME,
  accountNameOf,
  bar,
  bindingPercent,
  clampThreshold,
  colorOf,
  endSessionArgv,
  formatAge,
  formatReset,
  hasReading,
  isInstalled,
  isStale,
  matchAccount,
  pickNext,
  probeArgv,
  probeVerdict,
  PROBE_AFTER_MS,
  PROBE_RETRY_MS,
  PROBE_TIMEOUT_MS,
  rankCandidates,
  SHIM_MARKER,
  SHIMS,
  shimScript,
  windowLabel,
} from './policy'

const PANE = 'quota'
const REFRESH_MS = 60_000
const NAG_MS = 10 * 60_000
/** Between the toast and the signal, so the toast is seen and the turn's bookkeeping is done. */
const EXIT_DELAY_MS = 750
/** A process still alive this long after SIGTERM did not take it: the switch is given back to the person. */
const EXIT_GRACE_MS = 10_000
/** Before a handoff, a target's reading older than this is refreshed first. */
const PROBE_BEFORE_SWITCH_MS = 3_600_000
const BUSY_AGENT: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['pending', 'running', 'waiting'])

const snapshot = atom({ plugin: 'quota-rotate', key: 'snapshot' } as const, {})
const registry = atom({ plugin: 'quota-rotate', key: 'registry' } as const, {})

type Identity = {
  me: string
  configDir: string
  home: string
  baseDir: string
  handoffPath: string | undefined
  switchAt: number
  claudeBin: string
  /** A headless probe run: record only, never probe, switch or draw. */
  isProbe: boolean
  isInteractive: boolean
  isInstalled: boolean
}

type Pending = {
  to: string
  reason: Handoff['reason']
  /** Said once: what the switch waits for. */
  isAnnounced: boolean
}

type BackgroundTask = { id: string; type: string; status: string; description: string }

let identity: Identity = {
  me: 'default',
  configDir: '',
  home: '',
  baseDir: '',
  handoffPath: undefined,
  switchAt: 95,
  claudeBin: 'claude',
  isProbe: false,
  isInteractive: false,
  isInstalled: false,
}
let isIdentified = false
/** Set from the moment a handoff is written until the process ends or the switch is given up. */
let isSwitching = false
let pending: Pending | undefined
let lastNagAt = 0
const probing = new Set<string>()
/** Accounts whose last probe from this session failed: the failure is said once, not on every retry. */
const probeFailed = new Set<string>()
/** Main-agent turns in flight, by id. */
const turns = new Set<string>()
/** The background tasks the last `Stop` reported. */
let backgroundTasks: BackgroundTask[] = []

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

async function readIfExists($: EngineInterface, path: string): Promise<string | undefined> {
  if (!(await $.fs.exists(path))) return undefined
  try {
    return String(await $.fs.read(path))
  } catch {
    return undefined
  }
}

async function loadRegistry($: EngineInterface): Promise<void> {
  const parsed = parseJson<Registry>((await readIfExists($, `${identity.baseDir}/accounts.json`)) ?? '')
  await update($, registry, () => parsed?.accounts ?? {})
}

/** Re-reads every account's last reading; a half-written file is skipped until the next pass. */
async function refreshSnapshot($: EngineInterface): Promise<Snapshot> {
  const next: Snapshot = {}
  if (await $.fs.exists(usageDir())) {
    for (const entry of await $.fs.list(usageDir())) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const parsed = parseJson<AccountUsage>((await readIfExists($, `${usageDir()}/${entry.name}`)) ?? '')
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

/** Where this plugin lives right now, for the shims `/quota-setup` writes; refreshed every start, since an update moves it. */
async function writePluginRoot($: EngineInterface): Promise<void> {
  const path = `${identity.baseDir}/plugin-root`
  const current = (await readIfExists($, path))?.trim()
  if (current !== $.plugin.root) await $.fs.write(path, `${$.plugin.root}\n`)
}

/** Matches the live login's email against the registry, so a manual /login is attributed correctly. */
async function identify($: EngineInterface): Promise<void> {
  try {
    const ran = await $.process.run([identity.claudeBin, 'auth', 'status', '--json'], { timeoutMs: 20_000 })
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

function configDirOf(account: string, accounts: Record<string, RegistryAccount>): string | undefined {
  const dir = accounts[account]?.configDir
  if (dir === undefined || dir === `${identity.home}/.claude`) return undefined
  return dir
}

function probeMarkPath(account: string): string {
  return `${usageDir()}/${account}.probe.json`
}

async function readProbeMark($: EngineInterface, account: string): Promise<ProbeMark | undefined> {
  return parseJson<ProbeMark>((await readIfExists($, probeMarkPath(account))) ?? '')
}

/**
 * Runs one headless turn under `account`; that account's mod writes its reading, then we re-read.
 * The mark file tells other sessions a probe is running, and after a failure keeps every session
 * off that account for a while. `isForced` (a person asked) ignores everything but a running probe.
 */
async function probe($: EngineInterface, account: string, isForced = false): Promise<boolean> {
  if (identity.isProbe || probing.has(account) || account === identity.me) return false
  const accounts = await read($, registry)
  if (!(account in accounts)) return false
  const nowMs = await $.clock.now()
  const verdict = probeVerdict((await read($, snapshot))[account], await readProbeMark($, account), nowMs, PROBE_AFTER_MS, isForced)
  if (verdict !== 'due') return false
  probing.add(account)
  $.ui.status(`probing ${account}…`)
  await $.fs.write(probeMarkPath(account), JSON.stringify({ startedAt: new Date(nowMs).toISOString() }) + '\n')
  let failure: string | undefined
  try {
    const ran = await $.process.run(
      probeArgv(account, configDirOf(account, accounts), {
        claudeBin: identity.claudeBin,
        ...(identity.isInstalled ? {} : { pluginRoot: $.plugin.root }),
      }),
      { cwd: identity.home, timeoutMs: PROBE_TIMEOUT_MS },
    )
    if (ran.exitCode !== 0) failure = `exited ${ran.exitCode}: ${(ran.stderr || ran.stdout).trim().slice(0, 200)}`
  } catch (error) {
    failure = String(error).slice(0, 200)
  } finally {
    probing.delete(account)
    $.ui.status(undefined)
  }
  if (failure === undefined) {
    probeFailed.delete(account)
    await $.process.run(['rm', '-f', probeMarkPath(account)], { timeoutMs: 5_000 })
    await refreshSnapshot($)
    return true
  }
  await $.fs.write(probeMarkPath(account), JSON.stringify({ failedAt: new Date(await $.clock.now()).toISOString() }) + '\n')
  if (!probeFailed.has(account)) {
    probeFailed.add(account)
    $.ui.log(`probe of ${account} failed (${failure}); next try in ${Math.round(PROBE_RETRY_MS / 60_000)} min`)
  }
  return false
}

/** Probes every other registered account whose reading is due a refresh, one at a time. */
async function probeStale($: EngineInterface, maxAgeMs: number, isForced = false): Promise<void> {
  if (identity.isProbe || !identity.isInteractive) return
  const nowMs = await $.clock.now()
  const snap = await read($, snapshot)
  const accounts = await read($, registry)
  for (const account of Object.keys(accounts)) {
    if (account === identity.me || accounts[account]?.enabled === false) continue
    if (isForced || isStale(snap[account], nowMs, maxAgeMs)) await probe($, account, isForced)
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

/** A handoff file nobody consumed (a reload, a refused exit) would relaunch the session on its next ordinary exit. */
async function dropHandoff($: EngineInterface): Promise<void> {
  if (identity.handoffPath === undefined || !(await $.fs.exists(identity.handoffPath))) return
  await $.process.run(['rm', '-f', identity.handoffPath], { timeoutMs: 5_000 })
}

/** What the session is in the middle of, or undefined when it is idle. */
async function busyWith($: EngineInterface, isForced: boolean): Promise<string | undefined> {
  if (turns.size > 0) return 'this turn'
  // A forced switch (rate limit, or asked for) waits for the turn alone: agents on this account are blocked too.
  if (isForced) return undefined
  let agents = 0
  try {
    agents = (await $.agent.list()).filter(agent => BUSY_AGENT.has(agent.status)).length
  } catch {
    agents = 0
  }
  if (agents > 0) return agents === 1 ? 'the running agent' : `${agents} running agents`
  const tasks = backgroundTasks.filter(task => task.status === 'running' || task.status === 'pending').length
  if (tasks > 0) return tasks === 1 ? 'the background task' : `${tasks} background tasks`
  return undefined
}

function giveUpSwitch($: EngineInterface, text: string): void {
  isSwitching = false
  pending = undefined
  $.ui.status(undefined)
  $.ui.toast(text, { timeoutMs: 15_000 })
}

/** Ends this process with SIGTERM; the launcher takes over. Still alive after the grace period, the switch is handed back. */
async function endSession($: EngineInterface, to: string): Promise<void> {
  try {
    const ran = await $.process.run(endSessionArgv(), { timeoutMs: 5_000 })
    if (ran.exitCode !== 0) {
      $.ui.log(`could not end the session: ${(ran.stderr || ran.stdout).trim().slice(0, 200)}`)
      giveUpSwitch($, `type /exit to switch to ${to}`)
      return
    }
  } catch (error) {
    $.ui.log(`could not end the session: ${String(error).slice(0, 200)}`)
    giveUpSwitch($, `type /exit to switch to ${to}`)
    return
  }
  $.clock.after(EXIT_GRACE_MS, () => {
    if (isSwitching) giveUpSwitch($, `the session did not end; type /exit to switch to ${to}`)
  })
}

/** Carries a pending switch out once the session is idle; called at every point that may have made it so. */
async function attemptSwitch($: EngineInterface): Promise<void> {
  if (pending === undefined) return
  const isForced = pending.reason !== 'threshold'
  const busy = await busyWith($, isForced)
  if (busy !== undefined) {
    $.ui.status(`switching to ${pending.to} once ${busy} ends`)
    if (!pending.isAnnounced) {
      pending.isAnnounced = true
      $.ui.toast(`${identity.me} is out of quota: switching to ${pending.to} once ${busy} ends`, { timeoutMs: 10_000 })
    }
    return
  }
  const { to } = pending
  $.ui.status(`switching to ${to}…`)
  $.ui.toast(`switching to ${to}: this session resumes there`, { timeoutMs: 8_000 })
  $.clock.after(EXIT_DELAY_MS, () => {
    void endSession($, to)
  })
}

/** Hands the session to `to`: the launcher relaunches under that account and resumes this session id. */
async function switchTo($: EngineInterface, to: string, reason: Handoff['reason']): Promise<void> {
  if (isSwitching) {
    // A switch already waiting is upgraded by a forced one: it no longer waits for agents or tasks.
    if (pending !== undefined && reason !== 'threshold' && pending.reason === 'threshold') {
      pending = { ...pending, reason }
      await writeHandoff($, pending.to, reason)
      await attemptSwitch($)
    }
    return
  }
  if (!(await writeHandoff($, to, reason))) {
    $.ui.toast(`not running under claude-rotate; run /login and pick ${to} yourself`, { timeoutMs: 12_000 })
    return
  }
  isSwitching = true
  pending = { to, reason, isAnnounced: false }
  await attemptSwitch($)
}

async function maybeSwitch($: EngineInterface, reason: Handoff['reason'], isForced: boolean): Promise<void> {
  if (identity.isProbe) return
  let nowMs = await $.clock.now()
  let snap = await read($, snapshot)
  const mine = myPercent(snap, nowMs)
  if (isSwitching) {
    if (isForced) await switchTo($, pending?.to ?? '', reason)
    return
  }
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

/** Puts `cr`, `claude-rotate` and `quota-accounts` on the PATH as shims that find the plugin's current folder. */
async function setup($: EngineInterface): Promise<string> {
  await writePluginRoot($)
  const binDir = (await $.env.get('QUOTA_ROTATE_BIN_DIR')) ?? `${identity.home}/.local/bin`
  const written: string[] = []
  const kept: string[] = []
  for (const shim of SHIMS) {
    const path = `${binDir}/${shim.name}`
    const existing = await readIfExists($, path)
    if (existing !== undefined && !existing.includes(SHIM_MARKER)) {
      kept.push(path)
      continue
    }
    await $.fs.write(path, shimScript(shim.target))
    const chmod = await $.process.run(['chmod', '+x', path], { timeoutMs: 5_000 })
    if (chmod.exitCode !== 0) $.ui.log(`chmod +x ${path} failed: ${chmod.stderr.trim()}`)
    written.push(shim.name)
  }
  const onPath = ((await $.env.get('PATH')) ?? '').split(':').includes(binDir)
  const accounts = Object.keys(await read($, registry))
  const lines = [
    written.length > 0 ? `Installed ${written.join(', ')} in ${binDir}.` : `Nothing written to ${binDir}.`,
    ...kept.map(path => `Left ${path} alone: it is not a quota-rotate shim.`),
    ...(onPath ? [] : [`${binDir} is not on your PATH. Add this line to your shell profile, then open a new terminal:`, `  export PATH="${binDir}:$PATH"`]),
    '',
    ...(accounts.length === 0
      ? [
          'Next, from a terminal, register each account you own (each opens a browser login once):',
          '  quota-accounts add default      # the login in ~/.claude',
          '  quota-accounts add work         # any name you like',
          'Then start Claude Code with `cr` instead of `claude`.',
        ]
      : [`Accounts registered: ${accounts.join(', ')}. Start Claude Code with \`cr\` instead of \`claude\`.`]),
  ]
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  identity = { ...identity, switchAt: clampThreshold(options.switch_at) }

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
    identity = {
      ...identity,
      configDir,
      home,
      baseDir: `${home}/${BASE_DIR_NAME}`,
      handoffPath: await $.env.get('QUOTA_ROTATE_HANDOFF'),
      me: accountNameOf({ account: await $.env.get('QUOTA_ROTATE_ACCOUNT'), configDir, home }),
      claudeBin: (await $.env.get('CLAUDE_BIN')) ?? 'claude',
      isProbe: (await $.env.get('QUOTA_ROTATE_PROBE')) === '1',
      isInteractive: e.isInteractive,
      isInstalled: isInstalled(await readIfExists($, `${configDir}/plugins/installed_plugins.json`)),
    }
    isSwitching = false
    pending = undefined
    turns.clear()
    await loadRegistry($)
    await refreshSnapshot($)
    await identify($)
    const live = await $.session.usage()
    if (live.rateLimits.length > 0) await record($, live.rateLimits)
    if (identity.isProbe) return next(e)

    await writePluginRoot($)
    await dropHandoff($)

    $.clock.every(REFRESH_MS, () => {
      void (async () => {
        await loadRegistry($)
        await refreshSnapshot($)
        // The registry can appear or grow after this session started (quota-accounts add).
        if (!isIdentified && Object.keys(await read($, registry)).length > 0) await identify($)
        await attemptSwitch($)
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
      await $.command.register({
        name: 'quota-setup',
        description: 'Put the cr launcher and quota-accounts on your PATH',
      })
    } catch (error) {
      $.ui.log(`command not registered: ${String(error)}`)
    }
    const accounts = Object.keys(await read($, registry))
    $.ui.log(
      [
        `account ${identity.me}`,
        `switch at ${identity.switchAt}%`,
        identity.handoffPath ? 'under claude-rotate' : 'no launcher: switches are manual',
        identity.isInstalled ? 'installed' : `loaded from ${$.plugin.root}`,
        ...(accounts.length === 0 ? ['no accounts registered: run /quota-setup'] : []),
      ].join(' · '),
    )
    if (e.isInteractive) void $.ui.open({ id: PANE, title: 'Quota' })
    return next(e)
  })

  on('command.run', { command: 'quota' }, async $ => {
    await refreshSnapshot($)
    await $.ui.open({ id: PANE, title: 'Quota', closeOnEscape: true })
    return {}
  })

  on('command.run', { command: 'quota-switch' }, async ($, e) => {
    if (isSwitching && pending !== undefined) {
      const busy = await busyWith($, pending.reason !== 'threshold')
      return { text: busy ? `Already switching to ${pending.to} once ${busy} ends.` : `Already switching to ${pending.to}.` }
    }
    const nowMs = await $.clock.now()
    const snap = await refreshSnapshot($)
    const accounts = await read($, registry)
    const wanted = e.args.trim()
    const to = wanted || pickNext(snap, accounts, identity.me, nowMs, identity.switchAt)
    if (to === undefined) return { text: 'No other account has headroom.' }
    if (to === identity.me) return { text: `This session already runs as ${to}.` }
    if (wanted && !(wanted in accounts) && !(wanted in snap)) return { text: `Unknown account ${wanted}.` }
    await switchTo($, to, 'manual')
    return { text: identity.handoffPath ? `Switching to ${to}.` : `Not under claude-rotate: run /login and pick ${to}.` }
  })

  on('command.run', { command: 'quota-probe' }, async ($, e) => {
    const wanted = e.args.trim()
    if (wanted) {
      const ok = await probe($, wanted, true)
      return { text: ok ? `Probed ${wanted}.` : `Could not probe ${wanted}.` }
    }
    await probeStale($, 0, true)
    return { text: 'Probed every other account.' }
  })

  on('command.run', { command: 'quota-setup' }, async $ => ({ text: await setup($) }))

  on('turn.start', ($, e, next) => {
    turns.add(e.turnId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's run raises no turn.start and completes under its own id, so this is a no-op for it.
    turns.delete(e.turnId)
    if (e.agentId === undefined) await attemptSwitch($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) await record($, e.rateLimits)
    await maybeSwitch($, 'threshold', false)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    backgroundTasks = (e.background_tasks ?? []).map(task => ({
      id: task.id,
      type: task.type,
      status: task.status,
      description: task.description,
    }))
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    await attemptSwitch($)
    return result
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
    const busy = pending !== undefined ? await busyWith($, pending.reason !== 'threshold') : undefined

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
      pending !== undefined
        ? busy !== undefined
          ? `switching to ${pending.to} once ${busy} ends`
          : `switching to ${pending.to}…`
        : next !== undefined
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
                await probeStale($, 0, true)
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
