// Copies the MCP setup of the primary login into another account's config. Each account keeps
// its own .claude.json (the primary's is ~/.claude.json, not a file inside ~/.claude), so without
// this a session the launcher moves to another account loses every MCP server added under the
// first one.
// Usage: node scripts/sync-mcp.ts <account> <config-dir> <claude-bin> <record-file>
//
// The primary is the source:
// - Servers (user scope, and local scope for each project folder that still exists) that are
//   missing in the account or differ there are written with `claude mcp add-json`, Claude Code's
//   own writer. A server that came from the primary and is gone from it now is removed with
//   `claude mcp remove`. A server only the account has is kept.
// - The per-project switches follow the primary's: a server the primary disables in a project
//   (/mcp) is disabled there too, and enabled again when the primary enables it again; the
//   primary's .mcp.json approvals and rejections replace the account's for the same names, and
//   one the primary withdraws is withdrawn too. These have no command, so they are written into
//   the file under the lock Claude Code's config writer takes (`<file>.lock`, a directory,
//   through proper-lockfile), from a fresh read inside it, and the file is replaced with a rename.
//
// The record file says which names came from the primary: every name the primary has now, and
// every name of the last record that the account still has, so a removal that did not go through
// is tried again at the next sync. It holds names only, never a server's settings. Without a
// record nothing counts as the primary's, so nothing is removed until one is written.
//
// Prints a line per change and never a server's settings, which carry tokens. Exits 1 when a
// write did not go through; the next sync tries it again.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

type Server = Record<string, unknown>
const SWITCHES = ['disabledMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers'] as const
type Switch = (typeof SWITCHES)[number]
type Key = 'mcpServers' | Switch
type Project = { mcpServers?: Record<string, Server> } & { [K in Switch]?: string[] }
type Config = { mcpServers?: Record<string, Server>; projects?: Record<string, Project> }
/** The record: the shape of a config, with the names of the servers in place of their settings. */
type Names = { version?: number; mcpServers?: string[]; projects?: Record<string, { [K in Key]?: string[] }> }
/** One name: the project folder ('' for user scope), where in it, the name. */
type Entry = [folder: string, key: Key, name: string]

// proper-lockfile's default, which Claude Code's config writer keeps: a lock directory not
// touched for this long belongs to a process that is gone.
const LOCK_STALE_MS = 10_000
// A config save holds the lock briefly; when it stays held this long, leave the switches for
// the next sync instead of holding up the launch.
const LOCK_WAIT_MS = 2_000
// The mod gives `claude auth status` the same budget; a hung call must not park a launch.
const CLAUDE_TIMEOUT_MS = 20_000

const [account, configDir, claudeBin, recordFile] = process.argv.slice(2)
if (!account || !configDir || !claudeBin || !recordFile) {
  console.error('usage: sync-mcp.ts <account> <config-dir> <claude-bin> <record-file>')
  process.exit(2)
}
const accountFile = join(configDir, '.claude.json')
const primaryFile = join(homedir(), '.claude.json')
const say = (what: string) => console.log(`${account}: ${what}`)
let failed = false

if (resolve(accountFile) === resolve(primaryFile)) process.exit(0)
const primary = readConfig(primaryFile)
if (primary === undefined) process.exit(0)
const before = readConfig(accountFile) ?? {}
const record = readRecord()
const folders = [...new Set([...Object.keys(primary.projects ?? {}), ...Object.keys(record.projects ?? {})])].filter(isDirectory)

copyServers(primary.mcpServers ?? {}, before.mcpServers ?? {}, record.mcpServers ?? [], 'user', homedir())
for (const folder of folders) {
  copyServers(
    primary.projects?.[folder]?.mcpServers ?? {},
    before.projects?.[folder]?.mcpServers ?? {},
    record.projects?.[folder]?.mcpServers ?? [],
    'local',
    folder,
  )
}
copySwitches()
writeRecord()
process.exit(failed ? 1 : 0)

/** Brings one scope in step: `wanted` is the primary's, `current` the account's, `copied` the record's names. */
function copyServers(
  wanted: Record<string, Server>,
  current: Record<string, Server>,
  copied: string[],
  scope: 'user' | 'local',
  cwd: string,
): void {
  for (const [name, server] of Object.entries(wanted)) {
    copyServer(name, server, Object.hasOwn(current, name) ? current[name] : undefined, scope, cwd)
  }
  for (const name of copied) {
    if (Object.hasOwn(wanted, name) || !Object.hasOwn(current, name)) continue
    const removed = claude(['mcp', 'remove', name, '-s', scope], cwd)
    if (removed === 0) {
      say(`removed MCP server ${name} (${where(scope, cwd)}): default no longer has it`)
    } else {
      failed = true
      say(`could not remove MCP server ${name} (${where(scope, cwd)}): claude exited ${removed}`)
    }
  }
}

function copyServer(name: string, wanted: Server, current: Server | undefined, scope: 'user' | 'local', cwd: string): void {
  if (current !== undefined && canonical(current) === canonical(wanted)) return
  if (current !== undefined) {
    const removed = claude(['mcp', 'remove', name, '-s', scope], cwd)
    if (removed !== 0) {
      failed = true
      say(`could not replace MCP server ${name} (${where(scope, cwd)}): claude exited ${removed}`)
      return
    }
  }
  const added = claude(['mcp', 'add-json', name, JSON.stringify(wanted), '-s', scope], cwd)
  if (added === 0) {
    say(`${current === undefined ? 'added' : 'replaced'} MCP server ${name} (${where(scope, cwd)})`)
  } else {
    failed = true
    say(`could not add MCP server ${name} (${where(scope, cwd)}): claude exited ${added}`)
  }
}

function where(scope: 'user' | 'local', cwd: string): string {
  return scope === 'user' ? 'user scope' : `local scope, ${cwd}`
}

function copySwitches(): void {
  const listed = (project: { [K in Switch]?: string[] } | undefined) => SWITCHES.some(key => (project?.[key]?.length ?? 0) > 0)
  const wanted = folders.filter(folder => listed(primary.projects?.[folder]) || listed(record.projects?.[folder]))
  // Claude Code writes this file at an account's first start; until then there is nothing to add to.
  if (wanted.length === 0 || !existsSync(accountFile)) return
  const held = withLock(accountFile, () => {
    const config = readConfig(accountFile) as (Config & Record<string, unknown>) | undefined
    if (config === undefined) return
    const changes: string[] = []
    for (const folder of wanted) {
      const entry: Project & Record<string, unknown> = { ...config.projects?.[folder] }
      const ours = primary.projects?.[folder] ?? {}
      // A name the primary listed at the last sync and lists no more leaves the account's list too.
      const withdrawn = (key: Switch) => without(record.projects?.[folder]?.[key], ours[key])
      const next: Record<Switch, string[]> = {
        disabledMcpServers: union(without(entry.disabledMcpServers, withdrawn('disabledMcpServers')), ours.disabledMcpServers),
        // A .mcp.json server is approved or rejected, never both: the primary's answer replaces the account's.
        enabledMcpjsonServers: union(
          without(entry.enabledMcpjsonServers, [...(ours.disabledMcpjsonServers ?? []), ...withdrawn('enabledMcpjsonServers')]),
          ours.enabledMcpjsonServers,
        ),
        disabledMcpjsonServers: union(
          without(entry.disabledMcpjsonServers, [...(ours.enabledMcpjsonServers ?? []), ...withdrawn('disabledMcpjsonServers')]),
          ours.disabledMcpjsonServers,
        ),
      }
      let changed = false
      for (const key of SWITCHES) {
        if (sameSet(next[key], entry[key] ?? [])) continue
        entry[key] = next[key]
        changes.push(`${key} in ${folder}: ${next[key].join(', ') || 'none'}`)
        changed = true
      }
      if (changed) config.projects = { ...config.projects, [folder]: entry }
    }
    if (changes.length === 0) return
    replaceFile(accountFile, JSON.stringify(config, null, 2), statSync(accountFile).mode & 0o777)
    for (const change of changes) say(`set ${change}`)
  })
  if (!held) {
    failed = true
    say(`${accountFile}.lock stayed held; the MCP switches wait for the next sync`)
  }
}

/** The primary's names now, and the last record's names the account still has. */
function writeRecord(): void {
  const there = new Set(entriesOf(readConfig(accountFile) ?? {}).map(entry => JSON.stringify(entry)))
  const kept = entriesOf(record).filter(entry => there.has(JSON.stringify(entry)))
  const text = `${JSON.stringify(namesOf([...entriesOf(primary, folders), ...kept]), null, 2)}\n`
  if (existsSync(recordFile) && readFileSync(recordFile, 'utf8') === text) return
  mkdirSync(dirname(recordFile), { recursive: true })
  replaceFile(recordFile, text, 0o600)
}

function readRecord(): Names {
  if (!existsSync(recordFile)) return {}
  try {
    return JSON.parse(readFileSync(recordFile, 'utf8')) as Names
  } catch (error) {
    say(`cannot read ${recordFile} (${(error as Error).message}); nothing is removed until a new one is written`)
    return {}
  }
}

/** Every name in a config or a record, in the given project folders (all of them when none are given). */
function entriesOf(source: Config | Names, only?: string[]): Entry[] {
  const keys = (value: unknown) => (Array.isArray(value) ? (value as string[]) : Object.keys(value ?? {}))
  const out: Entry[] = keys(source.mcpServers).map(name => ['', 'mcpServers', name])
  const projects = (source.projects ?? {}) as Record<string, Record<string, unknown>>
  for (const folder of only ?? Object.keys(projects)) {
    const project = Object.hasOwn(projects, folder) ? projects[folder] : undefined
    if (project === undefined) continue
    for (const key of ['mcpServers', ...SWITCHES] as const) {
      for (const name of keys(project[key])) out.push([folder, key, name])
    }
  }
  return out
}

function namesOf(entries: Entry[]): Names {
  const out: Names = { version: 1 }
  const unique = [...new Set(entries.map(entry => JSON.stringify(entry)))].sort().map(text => JSON.parse(text) as Entry)
  for (const [folder, key, name] of unique) {
    const holder: { [K in Key]?: string[] } = folder === '' ? out : ((out.projects ??= {})[folder] ??= {})
    const names = (holder[key] ??= [])
    names.push(name)
  }
  return out
}

/** `claude mcp add-json` stores a command given without args with `args: []`; the rest it keeps as given. */
function canonical(server: Server): string {
  const filled = typeof server.command === 'string' && server.args === undefined ? { ...server, args: [] } : server
  return JSON.stringify(sortKeys(filled))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, sortKeys(record[key])]))
}

function union(current: string[] | undefined, added: string[] | undefined): string[] {
  const out = [...(current ?? [])]
  for (const name of added ?? []) if (!out.includes(name)) out.push(name)
  return out
}

function without(current: string[] | undefined, removed: string[] | undefined): string[] {
  return (current ?? []).filter(name => !(removed ?? []).includes(name))
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every(name => b.includes(name))
}

/** The exit status, or -1 when claude did not finish (not found, timed out). */
function claude(args: string[], cwd: string): number {
  const ran = spawnSync(claudeBin, args, {
    cwd,
    // PWD as well: spawn moves the child, and an inherited PWD would still name the launcher's folder.
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, PWD: cwd },
    stdio: 'ignore',
    timeout: CLAUDE_TIMEOUT_MS,
  })
  return ran.status ?? -1
}

function readConfig(path: string): Config | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Config
  } catch (error) {
    say(`cannot read ${path}: ${(error as Error).message}`)
    process.exit(1)
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Runs `body` holding `<file>.lock` the way proper-lockfile takes it; false when the lock stayed held. */
function withLock(file: string, body: () => void): boolean {
  const lock = `${file}.lock`
  const giveUpAt = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      if (isStale(lock)) {
        try {
          rmdirSync(lock)
        } catch {
          // another process removed it first
        }
        continue
      }
      if (Date.now() > giveUpAt) return false
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  try {
    body()
  } finally {
    rmdirSync(lock)
  }
  return true
}

function isStale(lock: string): boolean {
  try {
    return statSync(lock).mtimeMs < Date.now() - LOCK_STALE_MS
  } catch {
    return false
  }
}

/** Replaces `file` with `text` in one rename, with the given mode (both files are private). */
function replaceFile(file: string, text: string, mode: number): void {
  const temp = `${file}.quota-rotate.${process.pid}.tmp`
  writeFileSync(temp, text, { mode })
  renameSync(temp, file)
}
