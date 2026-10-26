// Copies the MCP setup of the primary login into another account's config. Each account keeps
// its own .claude.json (the primary's is ~/.claude.json, not a file inside ~/.claude), so without
// this a session the launcher moves to another account loses every MCP server added under the
// first one.
// Usage: node scripts/sync-mcp.ts <account> <config-dir> <claude-bin>
//
// The primary is the source:
// - Servers (user scope, and local scope for each project folder that still exists) that are
//   missing in the account or differ there are written with `claude mcp add-json`, Claude Code's
//   own writer. A server only the account has is kept.
// - The per-project switches are added to the account's: a server the primary disables in a
//   project (/mcp) is disabled there too, and the primary's .mcp.json approvals and rejections
//   replace the account's for the same names. These have no command, so they are written into
//   the file under the lock Claude Code's config writer takes (`<file>.lock`, a directory, through
//   proper-lockfile), from a fresh read inside it, and the file is replaced with a rename.
// Nothing is removed: a server removed from the primary, or re-enabled there, stays as it is in
// the account.
//
// Prints a line per change and never a server's settings, which carry tokens. Exits 1 when a
// write did not go through; the next sync tries it again.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

type Server = Record<string, unknown>
type Project = {
  mcpServers?: Record<string, Server>
  disabledMcpServers?: string[]
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
}
type Config = { mcpServers?: Record<string, Server>; projects?: Record<string, Project> }

// proper-lockfile's default, which Claude Code's config writer keeps: a lock directory not
// touched for this long belongs to a process that is gone.
const LOCK_STALE_MS = 10_000
// A config save holds the lock briefly; when it stays held this long, leave the switches for
// the next sync instead of holding up the launch.
const LOCK_WAIT_MS = 2_000
// The mod gives `claude auth status` the same budget; a hung call must not park a launch.
const CLAUDE_TIMEOUT_MS = 20_000

const [account, configDir, claudeBin] = process.argv.slice(2)
if (!account || !configDir || !claudeBin) {
  console.error('usage: sync-mcp.ts <account> <config-dir> <claude-bin>')
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
const folders = Object.entries(primary.projects ?? {}).filter(([folder]) => isDirectory(folder))

for (const [name, server] of Object.entries(primary.mcpServers ?? {})) {
  copyServer(name, server, before.mcpServers?.[name], 'user', homedir())
}
for (const [folder, project] of folders) {
  for (const [name, server] of Object.entries(project.mcpServers ?? {})) {
    copyServer(name, server, before.projects?.[folder]?.mcpServers?.[name], 'local', folder)
  }
}
copySwitches()
process.exit(failed ? 1 : 0)

function copyServer(name: string, wanted: Server, current: Server | undefined, scope: 'user' | 'local', cwd: string): void {
  if (current !== undefined && canonical(current) === canonical(wanted)) return
  const where = scope === 'user' ? 'user scope' : `local scope, ${cwd}`
  if (current !== undefined) {
    const removed = claude(['mcp', 'remove', name, '-s', scope], cwd)
    if (removed !== 0) {
      failed = true
      say(`could not replace MCP server ${name} (${where}): claude exited ${removed}`)
      return
    }
  }
  const added = claude(['mcp', 'add-json', name, JSON.stringify(wanted), '-s', scope], cwd)
  if (added === 0) {
    say(`${current === undefined ? 'added' : 'replaced'} MCP server ${name} (${where})`)
  } else {
    failed = true
    say(`could not add MCP server ${name} (${where}): claude exited ${added}`)
  }
}

function copySwitches(): void {
  const wanted = folders.filter(([, p]) =>
    [p.disabledMcpServers, p.enabledMcpjsonServers, p.disabledMcpjsonServers].some(list => (list?.length ?? 0) > 0),
  )
  // Claude Code writes this file at an account's first start; until then there is nothing to add to.
  if (wanted.length === 0 || !existsSync(accountFile)) return
  const held = withLock(accountFile, () => {
    const config = readConfig(accountFile) as (Config & Record<string, unknown>) | undefined
    if (config === undefined) return
    const changes: string[] = []
    for (const [folder, project] of wanted) {
      const entry: Project & Record<string, unknown> = { ...config.projects?.[folder] }
      const disabled = union(entry.disabledMcpServers, project.disabledMcpServers)
      // A .mcp.json server is approved or rejected, never both: the primary's answer replaces the account's.
      const approved = union(without(entry.enabledMcpjsonServers, project.disabledMcpjsonServers), project.enabledMcpjsonServers)
      const rejected = union(without(entry.disabledMcpjsonServers, project.enabledMcpjsonServers), project.disabledMcpjsonServers)
      let changed = false
      for (const [key, next] of [
        ['disabledMcpServers', disabled],
        ['enabledMcpjsonServers', approved],
        ['disabledMcpjsonServers', rejected],
      ] as const) {
        if (sameSet(next, entry[key] ?? [])) continue
        entry[key] = next
        changes.push(`${key} in ${folder}: ${next.join(', ') || 'none'}`)
        changed = true
      }
      if (changed) config.projects = { ...config.projects, [folder]: entry }
    }
    if (changes.length === 0) return
    replaceFile(accountFile, config)
    for (const change of changes) say(`set ${change}`)
  })
  if (!held) {
    failed = true
    say(`${accountFile}.lock stayed held; the MCP switches wait for the next sync`)
  }
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

/** Replaces `file` with `value` in one rename, keeping its mode (the config is private). */
function replaceFile(file: string, value: unknown): void {
  const temp = `${file}.quota-rotate.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: statSync(file).mode & 0o777 })
  renameSync(temp, file)
}
