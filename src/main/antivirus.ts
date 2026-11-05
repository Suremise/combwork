import { execFile } from 'child_process'
import { msg, tr } from '../shared/i18n'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { appendFileSync } from 'original-fs'
import { mkdir, readFile, realpath, rm, stat } from 'original-fs/promises'
import { app } from 'electron'
import { changeOutcome, covered, defenderMovePlan, emptyStatus, folderPlan, listed, nextOffer, normPath, offerOf, parseProbe, REMIND_MS, remindAtOf, statusOf, testsEligible, type AntivirusStatus, type AvAction, type AvChangeResult, type AvMovePlan, type AvPathKind, type AvSuggestionReply } from '../shared/antivirus'
import { config } from './config'
import { createLogger, userText } from './logger'
import { worktreesRoot } from './worktrees'
import { currentWorkspace, type WorkspaceService } from './workspace'

/**
 * Antivirus scanning of the window's workspace (#316, rules in shared/antivirus.ts). Reading the status runs a
 * read-only PowerShell probe (Get-MpComputerStatus, Get-MpPreference, Security Center, the volumes), with a time limit,
 * never on the UI's thread, cached per workspace and folder set. Changing exclusions is two steps: `prepare` works out
 * the exact operation (the workspace, its lifetime, the action and the resolved folders) for the user to confirm, and
 * `apply` runs exactly that one, after checking nothing changed meanwhile, in one elevated PowerShell (one UAC prompt).
 *
 * Test copies (an unpackaged build with a test profile) never ask Defender: CW_TEST_ANTIVIRUS names a fixture (the
 * probe's answer and what elevated changes do) and CW_TEST_ANTIVIRUS_LOG records every call; without a fixture the
 * status is "test copy" and changes are refused. So no test can change the machine's Defender settings.
 */

const log = createLogger('antivirus')

/** How long a probe may take, and how long its answer is kept. */
const PROBE_TIMEOUT_MS = 20_000
const CACHE_MS = 10 * 60_000
/** How many workspaces' statuses are kept at once (#322): the oldest probe's goes first. */
const CACHE_MAX = 16
/** How long the elevated change may take, the UAC prompt included (the user may take a while to answer it). */
const ELEVATED_TIMEOUT_MS = 5 * 60_000
/** How long a prepared change waits for the user's answer, and how many may wait at once. */
const PREPARED_MS = 10 * 60_000
const PREPARED_MAX = 8

const isTestCopy = (): boolean => !app.isPackaged && !!process.env.CW_USER_DATA
const fixtureFile = (): string | null => (!app.isPackaged ? process.env.CW_TEST_ANTIVIRUS || null : null)

const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** PowerShell's single-quoted string for a value (quotes doubled): paths and file names, never commands. */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** A script as PowerShell's -EncodedCommand takes it (UTF-16LE, base64), with UTF-8 output and no progress bars. */
const encode = (script: string): string => Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64')

/** Runs a script in a hidden, profile-less PowerShell, its output as text (UTF-8). */
function runPowerShell(script: string, timeout: number): Promise<string> {
  const encoded = encode(script)
  return new Promise((done, fail) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) fail(new Error(err.killed ? tr(msg({ id: 'main.antivirus.timeout', defaultMessage: 'PowerShell took longer than {seconds} s', description: "An error in Settings → Workspace → Antivirus scanning: Combwork's PowerShell check didn't finish in time." }), { seconds: Math.round(timeout / 1000) }) : (stderr || err.message).trim().slice(0, 300)))
      else done(stdout)
    })
  })
}

/** The read-only probe: Defender's state and (if visible) exclusions and performance mode, Security Center's products, the drives' file systems. */
export function probeScript(drives: string[]): string {
  return `
$r = @{}
try { $s = Get-MpComputerStatus -ErrorAction Stop; $r.defender = @{ antivirus = [bool]$s.AntivirusEnabled; realTime = [bool]$s.RealTimeProtectionEnabled; mode = "$($s.AMRunningMode)" } } catch { $r.defender = $null }
try { $p = Get-MpPreference -ErrorAction Stop; $r.exclusions = @($p.ExclusionPath | Where-Object { $_ }); if ($null -ne $p.PerformanceModeStatus) { $r.perfMode = [int]$p.PerformanceModeStatus } } catch { $r.exclusions = $null }
try { $r.products = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object { @{ name = "$($_.displayName)"; state = [int]$_.productState } }) } catch { $r.products = $null }
$r.volumes = @(foreach ($d in @(${drives.map(psQuote).join(', ')})) { try { $v = Get-Volume -DriveLetter $d -ErrorAction Stop; @{ drive = $d; fs = "$($v.FileSystemType)" } } catch { @{ drive = $d; fs = $null } } })
ConvertTo-Json -InputObject $r -Compress -Depth 4
`
}

/**
 * The elevated change. It goes to the elevated PowerShell whole, as its encoded command (never a file another process
 * could change before the prompt is answered), its paths as quoted literals. It reads Defender's list first and asks
 * only for what is needed: Add skips folders an existing exclusion (the folder or a parent) already covers; Remove
 * takes only exact entries that are there, so a parent someone else added is never touched. It then reads the list
 * again, and each drive's Dev Drive state, and writes all of it to `output`.
 */
export function elevatedScript(action: AvAction, paths: string[], drives: string[], output: string, remove: string[] = []): string {
  return `
$ErrorActionPreference = 'Stop'
$out = @{ ok = $false; listed = $false; requested = @() }
function Norm([string]$p) { return $p.Replace('/', '\\').TrimEnd('\\').ToLowerInvariant() }
function Covered([string]$p, $list) { $n = Norm $p; foreach ($e in $list) { $x = Norm $e; if ($x -and ($n -eq $x -or $n.StartsWith($x + '\\'))) { return $true } }; return $false }
function Listed([string]$p, $list) { $n = Norm $p; foreach ($e in $list) { if ((Norm $e) -eq $n) { return $true } }; return $false }
function Readable($list) { foreach ($e in $list) { if ("$e".Trim() -like 'N/A*') { return $false } }; return $true }
try {
  $paths = @(${paths.map(psQuote).join(', ')})
  $action = ${psQuote(action)}
  $before = @((Get-MpPreference).ExclusionPath | Where-Object { $_ })
  # Which exclusions already exist must be known before anything changes: otherwise nothing changes.
  if (-not (Readable $before)) { throw "Defender's exclusions couldn't be read even with administrator rights, so nothing was changed." }
  if ($action -eq 'add') { $need = @($paths | Where-Object { -not (Covered $_ $before) }); $out.requested = $need; if ($need.Count) { Add-MpPreference -ExclusionPath $need } }
  elseif ($action -eq 'remove') { $need = @($paths | Where-Object { Listed $_ $before }); $out.requested = $need; if ($need.Count) { Remove-MpPreference -ExclusionPath $need } }
  elseif ($action -eq 'move') {
    $remove = @(${remove.map(psQuote).join(', ')})
    $rm = @($remove | Where-Object { Listed $_ $before }); $out.removing = $rm; if ($rm.Count) { Remove-MpPreference -ExclusionPath $rm }
    $left = @($before | Where-Object { -not (Listed $_ $rm) })
    $need = @($paths | Where-Object { -not (Covered $_ $left) }); $out.requested = $need; if ($need.Count) { Add-MpPreference -ExclusionPath $need }
  }
  $out.ok = $true
} catch { $out.error = $_.Exception.Message }
try { $after = @((Get-MpPreference).ExclusionPath | Where-Object { $_ }); if (Readable $after) { $out.exclusions = $after; $out.listed = $true } } catch { $out.listError = $_.Exception.Message }
$out.devDrives = @{}
foreach ($d in @(${drives.map(psQuote).join(', ')})) { try { $out.devDrives[$d] = (& fsutil devdrv query ($d + ':') 2>&1 | Out-String) } catch { } }
ConvertTo-Json -InputObject $out -Compress -Depth 4 | Set-Content -LiteralPath ${psQuote(output)} -Encoding UTF8
`
}

/** Starts the elevated script (the UAC prompt) and waits for it; a declined prompt is "cancelled". */
export function launcherScript(script: string): string {
  return `
try {
  $p = Start-Process -FilePath ${psQuote(POWERSHELL)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ${psQuote(encode(script))})
  ConvertTo-Json -InputObject @{ started = $true } -Compress
} catch {
  $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
  ConvertTo-Json -InputObject @{ started = $false; cancelled = ($e.NativeErrorCode -eq 1223 -or "$($_.Exception.Message)" -match 'cancel'); error = "$($_.Exception.Message)" } -Compress
}
`
}

// ------------------------------------------------------------------------------------------------ test fixtures

interface Fixture {
  /** 'other': not Windows (nothing to check). */
  platform?: 'win32' | 'other'
  /** The probe's answer (shared/antivirus.ts AvProbe's JSON), or why it failed. */
  probe?: unknown
  probeError?: string
  /**
   * Elevated changes: the prompt declined, or failing to start; Defender refusing (an error, after `partial` of the
   * needed folders), or ignoring them (policy); the list unreadable afterwards; the starting list (as administrator
   * rights see it) and each drive's `fsutil devdrv query` text.
   */
  elevated?: { cancelled?: boolean; launchError?: string; error?: string; partial?: number; policy?: boolean; unlisted?: boolean; redacted?: boolean; exclusions?: string[]; devDrives?: Record<string, string> }
  /** Holds the probe's answer this long (a slow probe, to overlap requests). */
  probeDelayMs?: number
  /** How long before a reminder for the same folders (a day without it). */
  remindMs?: number
}

/** Defender's answer for a hidden list, as a fixture's redacted administrator read gives it. */
const HIDDEN = 'N/A: Must be an administrator to view exclusions' // i18n-ignore: what Defender's PowerShell says, matched

/** The exclusion list a fixture's elevated changes act on (as administrator rights would see it), per fixture file: the last few. */
const simulated = new Map<string, string[]>()
const SIMULATED_MAX = 4

async function readFixture(): Promise<Fixture | null> {
  const file = fixtureFile()
  if (!file) return null
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Fixture
  } catch (e) {
    throw new Error(`The antivirus test fixture couldn't be read: ${(e as Error).message}`, { cause: e }) // i18n-ignore: test copies only
  }
}

function testLog(entry: Record<string, unknown>): void {
  const file = !app.isPackaged ? process.env.CW_TEST_ANTIVIRUS_LOG : undefined
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
  } catch {
    // A test log that can't be written mustn't break Hive.
  }
}

// ------------------------------------------------------------------------------------------------ the folders

/** A folder as Windows names it (links and drive mappings resolved), or null when it can't be resolved. */
const resolved = (p: string): Promise<string | null> => realpath(resolve(p)).catch(() => null)

const exists = (p: string): Promise<boolean> => stat(p).then((s) => s.isDirectory(), () => false)

/**
 * Of the folders Hive excluded, those that no longer exist (#1389): gone only when they truly aren't there (ENOENT,
 * ENOTDIR), never for a folder that can't be looked at.
 */
async function missingOf(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) if (await stat(p).then(() => false, (e: NodeJS.ErrnoException) => e.code === 'ENOENT' || e.code === 'ENOTDIR')) out.push(p)
  return out
}

/** Whether the workspace holds Hive's own repository (someone developing Hive). */
async function holdsHive(w: WorkspaceService): Promise<boolean> {
  for (const p of await w.listProjectPaths().catch(() => [] as string[])) {
    try {
      const pkg = JSON.parse(await readFile(join(p, 'package.json'), 'utf8')) as { name?: unknown; productName?: unknown }
      // Its product name before and after the rename to Combwork (HI-2461, HI-2458).
      if (pkg.name === 'hive' && (pkg.productName === 'Hive Desktop' || pkg.productName === 'Hive' || pkg.productName === 'Combwork')) return true
    } catch {
      // Not a Node project.
    }
  }
  return false
}

/** The folders no exclusion may be or hold: the home folder, the profile and Windows' own, as given and resolved. */
async function guardedFolders(): Promise<string[]> {
  const env = process.env
  const candidates = [app.getPath('home'), env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.PUBLIC].filter((p): p is string => !!p)
  const out: string[] = []
  for (const p of candidates) {
    out.push(resolve(p))
    const real = await resolved(p)
    if (real) out.push(real)
  }
  return [...new Set(out)]
}

/**
 * The workspace's folders to exclude, as resolved absolute paths: its root, its worktrees folder once it exists, and
 * Hive's test area (%LOCALAPPDATA%\hive-test) only for people developing Hive and once it exists. Each is resolved
 * (links followed) and checked after resolving: one that is, or holds, a drive, a share, the home folder, the profile
 * or a system folder is never offered, nor one whose real location can't be established.
 */
export async function workspaceFolders(w: WorkspaceService): Promise<{ path: string; kind: AvPathKind; unsafe?: string }[]> {
  const root = w.path
  if (!root) return []
  const rootReal = await resolved(root)
  const trees = worktreesRoot(root)
  const local = process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local')
  const tests = join(local, 'hive-test')
  const wantTests = testsEligible({ packaged: app.isPackaged, holdsHive: app.isPackaged ? await holdsHive(w) : false }) && (await exists(tests))
  return folderPlan(
    {
      root: rootReal,
      ...(rootReal ? {} : { rootUnresolved: resolve(root) }),
      trees: (await exists(trees)) ? await resolved(trees) : null,
      tests: wantTests ? await resolved(tests) : null
    },
    await guardedFolders()
  )
}

// ------------------------------------------------------------------------------------------------ status

/** What Hive remembers (config.json, this machine's): what it added, the last administrator check, the offers. */
const remembered = () => config.get().antivirus ?? {}

/** The folder set, as a key: a status for another set (a worktrees folder appeared) is probed again. */
const folderKey = (folders: { path: string }[]): string => folders.map((f) => normPath(f.path)).join('|')

interface Cached {
  status: AntivirusStatus
  folders: string
  at: number
  seq: number
  life: AbortSignal
}

/**
 * The status of open workspaces, by path in lower case, with its folder set, age, probe's order and the workspace's
 * lifetime: at most CACHE_MAX, the oldest probe's first out; expired ones go whenever one is kept, and a workspace's go
 * when it closes (#322).
 */
const cache = new Map<string, Cached>()
/** Probes under way, by workspace path and folder set: shared only by requests for the same set and workspace lifetime. */
const inFlight = new Map<string, { life: AbortSignal; seq: number; promise: Promise<AntivirusStatus> }>()
/** Lifetimes whose close already retires what was kept for them (one listener each). */
const retiring = new WeakSet<AbortSignal>()
let probes = 0

function keep(key: string, entry: Cached): void {
  const now = Date.now()
  for (const [k, e] of cache) if (now - e.at >= CACHE_MS || e.life.aborted) cache.delete(k)
  // Kept last: the order is the probes', oldest first.
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  const life = entry.life
  if (retiring.has(life)) return
  retiring.add(life)
  life.addEventListener(
    'abort',
    () => {
      for (const [k, e] of cache) if (e.life === life) cache.delete(k)
      for (const [k, f] of inFlight) if (f.life === life) inFlight.delete(k)
    },
    { once: true }
  )
}

/** The window's workspace's status: cached for ten minutes unless `refresh` or its folders changed. */
export function antivirusStatus(refresh = false): Promise<AntivirusStatus> {
  return statusFor(currentWorkspace(), refresh)
}

export async function statusFor(w: WorkspaceService, refresh = false): Promise<AntivirusStatus> {
  const root = w.path
  if (!root) throw new Error(tr(msg({ id: 'main.antivirus.noWorkspace', defaultMessage: 'No workspace is open', description: 'An error in Settings → Workspace → Antivirus scanning.' })))
  const key = root.toLowerCase()
  const folders = await workspaceFolders(w)
  const set = folderKey(folders)
  const hit = cache.get(key)
  if (!refresh && hit && hit.folders === set && Date.now() - hit.at < CACHE_MS) return hit.status
  const life = w.lifetime
  // A probe for another folder set (one started before a worktrees folder appeared) or an earlier lifetime of the
  // workspace answers another question: this request starts its own.
  const flightKey = `${key}|${set}`
  const running = inFlight.get(flightKey)
  if (running && running.life === life && !life.aborted) return running.promise
  const seq = ++probes
  const promise = probe(root, folders)
    .then((status) => {
      // A workspace closed meanwhile isn't cached (its window may show another), and an older probe finishing late
      // never replaces a newer one's answer.
      const now = cache.get(key)
      if (!life.aborted && w.path === root && (!now || now.seq < seq)) keep(key, { status, folders: set, at: Date.now(), seq, life })
      return status
    })
    .finally(() => {
      if (inFlight.get(flightKey)?.seq === seq) inFlight.delete(flightKey)
    })
  inFlight.set(flightKey, { life, seq, promise })
  return promise
}

const drivesOf = (paths: string[]): string[] => [...new Set(paths.map((p) => /^([a-z]):/i.exec(p)?.[1].toUpperCase()).filter((d): d is string => !!d))]

async function probe(root: string, folders: { path: string; kind: AvPathKind; unsafe?: string }[]): Promise<AntivirusStatus> {
  const now = new Date()
  const fixture = await readFixture()
  if (fixture ? fixture.platform === 'other' : process.platform !== 'win32') return emptyStatus(root, 'not-applicable', folders, now)
  if (!fixture && isTestCopy()) return emptyStatus(root, 'test-copy', folders, now)
  try {
    let raw: unknown
    if (fixture) {
      testLog({ call: 'probe', paths: folders.map((f) => f.path) })
      if (fixture.probeDelayMs) await new Promise((r) => setTimeout(r, Math.min(fixture.probeDelayMs!, 30_000)))
      if (fixture.probeError) throw new Error(fixture.probeError)
      raw = fixture.probe
    } else raw = JSON.parse((await runPowerShell(probeScript(drivesOf(folders.map((f) => f.path))), PROBE_TIMEOUT_MS)).trim() || 'null')
    const mem = remembered()
    return statusOf(root, parseProbe(raw), folders, { added: mem.added ?? [], adminCheck: mem.adminCheck ?? null, now, missing: await missingOf(mem.added ?? []) })
  } catch (e) {
    log.warn(`antivirus status of ${userText(root)}: ${userText((e as Error).message)}`)
    return emptyStatus(root, 'unavailable', folders, now, (e as Error).message)
  }
}

// ------------------------------------------------------------------------------------------------ changes

interface Prepared {
  w: WorkspaceService
  life: AbortSignal
  root: string
  action: AvAction
  paths: string[]
  drives: string[]
  at: number
}

/** Changes waiting for the user's answer, by id: used once, within ten minutes, at most a few at a time. */
const prepared = new Map<string, Prepared>()

/**
 * The folders an action would change now: Add the safe ones not known to be excluded, Remove the safe ones Hive added
 * and Hive's exclusions of folders that are gone (#1389).
 */
async function planFor(w: WorkspaceService, action: AvAction): Promise<{ status: AntivirusStatus; paths: string[] }> {
  const status = await statusFor(w, true)
  if (status.scan !== 'defender') throw new Error(status.scan === 'other' ? tr(msg({ id: 'main.antivirus.other', defaultMessage: 'Another antivirus is active: Combwork can only change Microsoft Defender’s exclusions.', description: 'An error in Settings → Workspace → Antivirus scanning. Microsoft Defender is a name.' })) : tr(msg({ id: 'main.antivirus.notDefender', defaultMessage: 'Microsoft Defender isn’t the active antivirus here.', description: 'An error in Settings → Workspace → Antivirus scanning.' })))
  const added = (remembered().added ?? []).map(normPath)
  const safe = status.paths.filter((p) => !p.unsafe)
  const paths = action === 'add' ? safe.filter((p) => p.state !== 'excluded').map((p) => p.path) : action === 'remove' ? [...safe.filter((p) => added.includes(normPath(p.path))).map((p) => p.path), ...(status.gone ?? []).map((g) => g.path)] : []
  if (action !== 'check' && !paths.length) throw new Error(action === 'add' ? tr(msg({ id: 'main.antivirus.allExcluded', defaultMessage: 'Every folder Combwork may offer is already excluded.', description: 'An error in Settings → Workspace → Antivirus scanning: nothing to add.' })) : tr(msg({ id: 'main.antivirus.noneAdded', defaultMessage: 'Combwork added no exclusions for this workspace.', description: 'An error in Settings → Workspace → Antivirus scanning: nothing to remove.' })))
  return { status, paths }
}

/**
 * Works out a change for the window's workspace, for the user to confirm: the exact folders it would change. Nothing
 * runs until `applyAntivirus` gets its id back.
 */
export async function prepareAntivirus(action: AvAction): Promise<{ id: string; action: AvAction; paths: string[]; workspacePath: string }> {
  if (action !== 'add' && action !== 'remove' && action !== 'check') throw new Error('Not an antivirus action.') // i18n-ignore: a programming error, never shown
  const w = currentWorkspace()
  const root = w.path
  if (!root) throw new Error(tr(msg({ id: 'main.antivirus.noWorkspace', defaultMessage: 'No workspace is open', description: 'An error in Settings → Workspace → Antivirus scanning.' })))
  const life = w.lifetime
  const { status, paths } = await planFor(w, action)
  if (life.aborted || w.path !== root) throw new Error(tr(msg({ id: 'main.antivirus.closed', defaultMessage: 'The workspace closed meanwhile.', description: 'An error in Settings → Workspace → Antivirus scanning.' })))
  const now = Date.now()
  for (const [id, p] of prepared) if (now - p.at > PREPARED_MS || p.life.aborted) prepared.delete(id)
  while (prepared.size >= PREPARED_MAX) prepared.delete(prepared.keys().next().value!)
  const id = randomUUID()
  prepared.set(id, { w, life, root, action, paths, drives: drivesOf(status.paths.map((p) => p.path)), at: now })
  return { id, action, paths, workspacePath: root }
}

/**
 * Runs a prepared change, exactly as confirmed: refused if it isn't the window's workspace's any more, or the folders
 * it would change now differ from those the user saw (they must confirm the new set). One elevated PowerShell, one UAC
 * prompt. What Hive added is remembered from what Defender lists afterwards, never from what was asked.
 */
export async function applyAntivirus(id: string): Promise<{ result: AvChangeResult; status: AntivirusStatus | null }> {
  const op = typeof id === 'string' ? prepared.get(id) : undefined
  if (!op) throw new Error(tr(msg({ id: 'main.antivirus.notWaiting', defaultMessage: 'That change is no longer waiting: ask again.', description: 'An error in Settings → Workspace → Antivirus scanning: an exclusion change asked for was answered too late or twice.' })))
  prepared.delete(id)
  if (Date.now() - op.at > PREPARED_MS) throw new Error(tr(msg({ id: 'main.antivirus.tooLong', defaultMessage: 'That change waited too long for an answer: ask again.', description: 'An error in Settings → Workspace → Antivirus scanning.' })))
  if (op.life.aborted || currentWorkspace() !== op.w || op.w.path !== op.root) throw new Error(tr(msg({ id: 'main.antivirus.changed', defaultMessage: 'The workspace changed since you were asked: nothing was changed.', description: 'An error in Settings → Workspace → Antivirus scanning.' })))
  const { paths } = await planFor(op.w, op.action)
  if (op.life.aborted || op.w.path !== op.root) throw new Error(tr(msg({ id: 'main.antivirus.changed', defaultMessage: 'The workspace changed since you were asked: nothing was changed.', description: 'An error in Settings → Workspace → Antivirus scanning.' })))
  const same = paths.length === op.paths.length && paths.every((p) => op.paths.some((q) => normPath(q) === normPath(p)))
  if (!same) throw new Error(tr(msg({ id: 'main.antivirus.foldersChanged', defaultMessage: 'The folders changed since you were asked: review them again. Nothing was changed.', description: 'An error in Settings → Workspace → Antivirus scanning.' })))
  log.info(`antivirus ${op.action}: ${op.paths.map((p) => userText(p)).join(', ') || '(read the list)'}`)
  const result = await elevated(op.action, op.paths, op.drives)
  // What happened to Defender is the machine's, whatever the window shows now: remembered either way.
  await remember(result)
  log.info(`antivirus ${op.action}: ${result.outcome}`)
  const status = op.life.aborted || op.w.path !== op.root ? null : await statusFor(op.w, true)
  return { result, status }
}

/**
 * What an elevated run found, remembered (config.json, the machine's): the list read with administrator rights, what
 * it added and removed. With the list read, Hive also forgets its exclusions of folders that are gone and that Defender
 * no longer lists (#1389: taken away in Windows Security, say): there's nothing of Hive's left to show or remove.
 */
async function remember(result: AvChangeResult): Promise<void> {
  const missing = result.exclusions ? await missingOf(remembered().added ?? []) : []
  config.update((c) => {
    const a = { ...c.antivirus }
    if (result.exclusions) a.adminCheck = { at: new Date().toISOString(), exclusions: result.exclusions, ...(result.devDrives ? { devDrives: result.devDrives } : {}) }
    if (result.added?.length) a.added = [...new Set([...(a.added ?? []), ...result.added])]
    if (result.removed?.length) a.added = (a.added ?? []).filter((p) => !result.removed!.some((x) => normPath(x) === normPath(p)))
    const known = result.exclusions
    if (known && a.added) a.added = a.added.filter((p) => listed(p, known) || !missing.some((m) => normPath(m) === normPath(p)))
    c.antivirus = a
  })
}

/** A moved workspace's old folders, as Hive kept them: where it was, and its worktrees folder beside it then. */
const oldFolders = (from: string): string[] => [resolve(from), worktreesRoot(resolve(from))]

/**
 * Defender and a workspace moved from `from` (#1302): the old folders and the new, with whether Defender skips each,
 * and what Repair would move. Read fresh, never cached (the old folders aren't the workspace's set); null without a
 * workspace. For Repair's dialog, which asks for it on its own: the probe is too slow to hold up the plan.
 */
export async function moveDefenderPlan(w: WorkspaceService, from: string): Promise<AvMovePlan | null> {
  const root = w.path
  if (!root) return null
  const old = oldFolders(from)
  const folders = await workspaceFolders(w)
  const status = await probe(root, [...folders, { path: old[0], kind: 'workspace' }, { path: old[1], kind: 'worktrees' }])
  return defenderMovePlan(status, old)
}

/**
 * Moves Hive's exclusions from the old folders to the new ones (#1302), in one elevated PowerShell (one UAC prompt):
 * the plan worked out again now, so only what is true now is changed (exactly Hive's old entries; only the new folders
 * Hive may offer). Null when there is nothing of Hive's to move. What Hive added is remembered from what Defender lists
 * afterwards, as for Add and Remove.
 */
export async function moveExclusions(w: WorkspaceService, from: string): Promise<AvChangeResult | null> {
  const plan = await moveDefenderPlan(w, from)
  if (!plan || plan.scan !== 'defender' || !plan.remove.length) return null
  log.info(`antivirus move: remove ${plan.remove.map((p) => userText(p)).join(', ')}; add ${plan.add.map((p) => userText(p)).join(', ') || '(none)'}`)
  const result = await elevated('move', plan.add, drivesOf([...plan.add, ...plan.now.map((p) => p.path)]), plan.remove)
  await remember(result)
  log.info(`antivirus move: ${result.outcome}`)
  // The window's status reads the new list.
  if (!w.lifetime.aborted && w.path) await statusFor(w, true).catch(() => undefined)
  return result
}

async function elevated(action: AvAction, paths: string[], drives: string[], remove: string[] = []): Promise<AvChangeResult> {
  const fixture = await readFixture()
  if (fixture) return fixtureChange(fixture, action, paths, remove)
  if (isTestCopy()) throw new Error('Test copies of Hive never change Defender’s settings.') // i18n-ignore: test copies only
  if (process.platform !== 'win32') throw new Error(tr(msg({ id: 'main.antivirus.windowsOnly', defaultMessage: 'Only Windows has Defender exclusions.', description: 'An error in Settings → Workspace → Antivirus scanning on another system.' })))
  const dir = join(tmpdir(), `hive-antivirus-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  try {
    const output = join(dir, 'result.json')
    let launch: { started: boolean; cancelled?: boolean; error?: string }
    try {
      launch = JSON.parse((await runPowerShell(launcherScript(elevatedScript(action, paths, drives, output, remove)), ELEVATED_TIMEOUT_MS)).trim()) as typeof launch
    } catch (e) {
      launch = { started: false, error: (e as Error).message }
    }
    const result = launch.started ? await readFile(output, 'utf8').then((t) => JSON.parse(t.replace(/^\ufeff/, '')) as unknown, () => null) : null
    return changeOutcome(action, launch, result)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** A fixture's elevated change: what the elevated script does, on a simulated exclusion list, every call logged. */
function fixtureChange(f: Fixture, action: AvAction, paths: string[], remove: string[] = []): AvChangeResult {
  testLog({ call: action, paths, ...(action === 'move' ? { remove } : {}) })
  const e = f.elevated ?? {}
  const file = fixtureFile()!
  if (!simulated.has(file)) {
    while (simulated.size >= SIMULATED_MAX) simulated.delete(simulated.keys().next().value!)
    simulated.set(file, [...(e.exclusions ?? [])])
  }
  let current = simulated.get(file)!
  if (e.cancelled) return changeOutcome(action, { started: false, cancelled: true }, null)
  if (e.launchError) return changeOutcome(action, { started: false, error: e.launchError }, null)
  // A redacted list even with administrator rights: which exclusions exist can't be known, so nothing changes, and the
  // list it reports (Defender's "N/A" answer, as if it had slipped through) must count as unknown.
  if (e.redacted) return changeOutcome(action, { started: true }, { ok: action === 'check', ...(action === 'check' ? {} : { error: tr(msg({ id: 'main.antivirus.unreadable', defaultMessage: "Defender's exclusions couldn't be read even with administrator rights, so nothing was changed.", description: 'An error in Settings → Workspace → Antivirus scanning.' })) }), requested: [], listed: true, exclusions: [HIDDEN] })
  if (action === 'move') {
    // As the elevated script does it: Hive's listed old entries removed, then the new folders the rest doesn't cover added.
    const removing = remove.filter((p) => listed(p, current))
    const left = current.filter((x) => !removing.some((p) => normPath(p) === normPath(x)))
    const adding = paths.filter((p) => !covered(p, left))
    const ok = !e.policy && !e.error
    if (ok) current = [...left, ...adding]
    simulated.set(file, current)
    testLog({ call: 'move-requested', paths: adding, remove: removing })
    return changeOutcome(action, { started: true }, { ok: !e.error, ...(e.error ? { error: e.error } : {}), requested: adding, removing, ...(e.unlisted ? {} : { listed: true, exclusions: current }), devDrives: e.devDrives ?? {} })
  }
  const need = action === 'add' ? paths.filter((p) => !covered(p, current)) : action === 'remove' ? paths.filter((p) => listed(p, current)) : []
  const applied = e.policy ? [] : e.error ? need.slice(0, e.partial ?? 0) : need
  if (action === 'add') current = [...current, ...applied]
  if (action === 'remove') current = current.filter((x) => !applied.some((p) => normPath(p) === normPath(x)))
  simulated.set(file, current)
  testLog({ call: `${action}-requested`, paths: need })
  return changeOutcome(action, { started: true }, { ok: !e.error, ...(e.error ? { error: e.error } : {}), requested: need, ...(e.unlisted ? {} : { listed: true, exclusions: current }), devDrives: e.devDrives ?? {} })
}

// ------------------------------------------------------------------------------------------------ the offer

/**
 * Whether to suggest exclusions now (the window saw a reason: several agents running, a long command, or a new
 * worktrees folder while they run): when scanning likely slows this workspace and it wasn't declined for good. Folders
 * not offered before are suggested at once; the same folders again at most once a day (a reminder, #348), until the
 * user says "Don't ask again" or they stop being slowed (excluded, a trusted Dev Drive, Defender not active). The check
 * and the claim happen together after the status is known, so two requests can't both offer, and one can't ignore a
 * "Don't ask again" given meanwhile. The reply also says when a reminder may come, for the window to ask again then
 * while the reason lasts.
 */
export function antivirusSuggestion(): Promise<AvSuggestionReply> {
  return suggestionFor(currentWorkspace())
}

const NO_SUGGESTION: AvSuggestionReply = { offer: null, remindAt: null }

export async function suggestionFor(w: WorkspaceService): Promise<AvSuggestionReply> {
  const root = w.path
  if (!root) return NO_SUGGESTION
  const life = w.lifetime
  const key = root.toLowerCase()
  if (remembered().dismissed?.[key]) return NO_SUGGESTION
  // A fixture may space reminders closer, so a suite sees one.
  const spacing = (await readFixture().catch(() => null))?.remindMs ?? REMIND_MS
  const status = await statusFor(w)
  if (life.aborted || w.path !== root || !status.slowed) return NO_SUGGESTION
  // From here to the claim nothing awaits: what is remembered now is what decides.
  const mem = remembered()
  if (mem.dismissed?.[key]) return NO_SUGGESTION
  const prev = offerOf(mem.offered?.[key])
  const offer = nextOffer(prev, status.offerKey, new Date(), spacing)
  if (!offer) return { offer: null, remindAt: remindAtOf(prev, status.offerKey, spacing) }
  config.update((c) => {
    c.antivirus = { ...c.antivirus, offered: { ...c.antivirus?.offered, [key]: offer } }
  })
  log.info(`antivirus: suggested exclusions for ${userText(basename(root))}${offer.count > 1 ? ` (reminder ${offer.count - 1})` : ''}`)
  return { offer: { status, count: offer.count }, remindAt: remindAtOf(offer, status.offerKey, spacing) }
}

/** "Don't ask again" for the window's workspace. */
export function dismissAntivirus(): void {
  dismissFor(currentWorkspace())
}

export function dismissFor(w: WorkspaceService): void {
  const root = w.path
  if (!root) return
  config.update((c) => {
    c.antivirus = { ...c.antivirus, dismissed: { ...c.antivirus?.dismissed, [root.toLowerCase()]: true } }
  })
}
