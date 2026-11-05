import { execFile } from 'child_process'
import { app } from 'electron'
import { delimiter, dirname, join } from 'path'
import { createLogger, userText } from './logger'

// A CLI installed while Hive runs (#472): its installer adds its folder to the user's or the machine's PATH in the
// registry, and running processes keep the PATH they started with. Before Hive looks for the CLIs (at start, Agent
// Setup's Check again, after an install or update task), it reads the PATH Windows gives a new process and adds the
// folders it doesn't have yet to its own, so where.exe finds the new CLI and sessions started from then on get it
// (childEnv copies Hive's environment). Hive's own folders keep their order and come first; nothing is removed.
// Hive also reads it just before it starts a process of its own (#821): an agent, a provider task's terminal, an
// external terminal. Without that, a CLI or tool installed outside Hive stayed unknown to them until something made
// Hive look for the CLIs again.

const log = createLogger('path')

/** A folder as PATH lists it, for comparing: no quotes or trailing slash, any case. */
const folderKey = (d: string): string => d.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '').toLowerCase()

/** %NAME% replaced by env's NAME (any case); a name env doesn't have is left as it is. */
export function expandVars(value: string, env: NodeJS.ProcessEnv): string {
  const byName = new Map(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]))
  return value.replace(/%([^%;]+)%/g, (all, name: string) => byName.get(name.toUpperCase()) ?? all)
}

/** The folders in a PATH value, expanded; empty entries, and entries still naming a variable, left out. */
export function pathFolders(value: string, env: NodeJS.ProcessEnv): string[] {
  return value
    .split(';')
    .map((d) => expandVars(d.trim(), env))
    .filter((d) => !!d && !/%[^%]+%/.test(d))
}

/**
 * `current` with each of `fresh`'s folders it doesn't have yet added at its end, in `fresh`'s order: Hive's own come
 * first, so nothing it found before resolves differently. `added` lists the new ones.
 */
export function mergePath(current: string, fresh: string[], sep = delimiter): { value: string; added: string[] } {
  const have = new Set(current.split(sep).filter(Boolean).map(folderKey))
  const added: string[] = []
  for (const d of fresh) {
    const k = folderKey(d)
    if (!k || have.has(k)) continue
    have.add(k)
    added.push(d)
  }
  if (!added.length) return { value: current, added }
  let base = current
  while (base.endsWith(sep)) base = base.slice(0, -sep.length)
  return { value: [base, ...added].filter(Boolean).join(sep), added }
}

/** `reg query <key> /v Path`'s value ("    Path    REG_EXPAND_SZ    C:\…;%USERPROFILE%\…"), or '' when it has none. */
export function parseRegQuery(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line)
    if (m) return m[1].trim()
  }
  return ''
}

const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const USER_KEY = 'HKCU\\Environment'
/** System32, by its full path: Hive's own PATH may not have it. */
const system32 = (): string => join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32')

function exec(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : stdout))
  })
}

/**
 * The machine's then the user's PATH from the registry, as Windows builds a new process's: PowerShell reads them (as
 * Unicode, expanded); where it can't run (a locked-down machine), reg.exe (whose output keeps only ASCII safely).
 */
async function registryPath(): Promise<string[] | null> {
  const ps = await exec(join(system32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; 'M=' + [Environment]::GetEnvironmentVariable('Path','Machine'); 'U=' + [Environment]::GetEnvironmentVariable('Path','User')"
  ])
  const lines = ps?.split(/\r?\n/) ?? []
  const machine = lines.find((l) => l.startsWith('M='))
  const user = lines.find((l) => l.startsWith('U='))
  if (machine !== undefined && user !== undefined) return [...pathFolders(machine.slice(2), process.env), ...pathFolders(user.slice(2), process.env)]
  const [m, u] = await Promise.all([exec(join(system32(), 'reg.exe'), ['query', MACHINE_KEY, '/v', 'Path']), exec(join(system32(), 'reg.exe'), ['query', USER_KEY, '/v', 'Path'])])
  if (m === null && u === null) return null
  return [...pathFolders(parseRegQuery(m ?? ''), process.env), ...pathFolders(parseRegQuery(u ?? ''), process.env)]
}

/**
 * The registry PATH a test copy gets instead of the machine's, or undefined for the machine's: an unpackaged build
 * with HIVE_TEST_REGISTRY_PATH (`;`-separated folders; a suite may change it while Hive runs, standing in for an
 * installer) or with a test profile (HIVE_USER_DATA: none), so a suite's PATH without a CLI stays without it.
 * `npm run dev` (no test profile) and the installed app read the registry.
 */
export function testRegistryPath(env: NodeJS.ProcessEnv = process.env, packaged = app.isPackaged): string | undefined {
  if (packaged) return undefined
  return env.HIVE_TEST_REGISTRY_PATH ?? (env.HIVE_USER_DATA ? '' : undefined)
}

/** What a new process's PATH would hold, the folders in order (null when it can't be read, or not on Windows). */
function freshFolders(): Promise<string[] | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const test = testRegistryPath()
  if (test !== undefined) return Promise.resolve(pathFolders(test, process.env))
  return registryPath()
}

let refreshing: Promise<string[]> | null = null

/**
 * Adds the registry PATH's new folders to Hive's own (one read at a time; a call meanwhile shares it). Returns the
 * folders added; none when it couldn't read the registry.
 */
export function refreshPath(): Promise<string[]> {
  refreshing ??= freshFolders()
    .then((fresh) => {
      if (!fresh) return []
      const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
      const { value, added } = mergePath(process.env[key] ?? '', fresh)
      if (added.length) {
        process.env[key] = value
        log.info(`Added to Combwork's PATH from the registry: ${userText(added.join(delimiter))}`)
      }
      return added
    })
    .catch((e) => {
      log.warn(`Couldn't read the PATH from the registry: ${userText(e instanceof Error ? e.message : String(e))}`)
      return []
    })
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

/** The folder of each provider's CLI as Hive last found it (#1103), by provider. */
const cliFolders = new Map<string, string>()

/**
 * Notes where Hive found a provider's CLI (null: not found), for the PATH of what Hive starts (#1103): a standalone CLI
 * found where its installer puts it (Claude Code's `~\.local\bin`) needn't be on any PATH, and Claude Code's native
 * installer can leave it off, so Provider Setup found it while the sessions and terminals Hive starts couldn't run it by
 * name. Hive's own PATH, which it finds the CLIs on, stays as it is (a folder found by a fixed place mustn't come before
 * one an installer adds later), and the user's PATH in the registry is never changed.
 */
export function noteCliFolder(id: string, executable: string | null): void {
  const folder = executable ? dirname(executable) : null
  if ((cliFolders.get(id) ?? null) === folder) return
  if (folder) cliFolders.set(id, folder)
  else cliFolders.delete(id)
  if (folder && !mergePath(process.env.PATH ?? process.env.Path ?? '', [folder]).added.length) return
  if (folder) log.info(`A CLI found off Combwork's PATH: what Combwork starts gets its folder, ${userText(folder)}`)
}

/**
 * The PATH for a process Hive starts (`childEnv`): `path` with the found CLIs' folders it lacks at its end, so the
 * session or terminal runs by name the CLI Provider Setup found (#1103), and nothing already on PATH resolves differently.
 */
export function withCliFolders(path: string): string {
  return mergePath(path, [...cliFolders.values()]).value
}

/** A copy of `env` whose PATH (however its name is cased) has the found CLIs' folders (withCliFolders). */
export function envWithCliFolders<T extends Record<string, string | undefined>>(env: T): T {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: withCliFolders(env[key] ?? '') }
}

/** The longest a new process waits for the registry's PATH: slower, it starts with the PATH Hive has (as before #821). */
export const FRESH_WAIT_MS = 2000

/**
 * refreshPath() before Hive starts an agent or a terminal (#821), so it gets the folders installers have added since
 * Hive started. Waits at most `maxMs`; a slower read carries on and counts for the next start.
 */
export async function refreshPathBeforeStart(maxMs = FRESH_WAIT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxMs)
  })
  await Promise.race([refreshPath().then(() => undefined), late])
  clearTimeout(timer)
}
