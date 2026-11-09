import { execFile } from 'child_process'
import { existsSync, readFileSync, statSync } from 'original-fs'
import { appendFile, mkdir, readdir, readFile, writeFile } from 'original-fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'path'
import { agentField, englishText, shownText, type TextPart } from '../../shared/advanced'
import { msg, tr } from '../../shared/i18n'
import type { AgentInstallInfo, ReadinessIssue, RecacheEstimate, SessionUsage } from '../../shared/types'
import { readFirstLineOf } from '../transcriptFiles'
import { cleanSwaps, contentHash, ContentTooLarge, COPY_MARKER, CopyFailed, LinkNotCopied, sourceProblem, swapIn, swapOut, tooBigToDeliver, withFileLock } from '../fsutil'
import { createLogger, userText } from '../logger'
import { combworkError } from '../combworkError'
import { git } from '../git'
import type { HookIds, LaunchContext, SkillCopyBook, SkillCopyRecord, SkillDelivery } from './types'

const log = createLogger('providers')

/** The first line of a file (a transcript's header), read without loading the whole transcript. */
export function readFirstLine(path: string, max = 1 << 20): Promise<string> {
  // A compressed backup too (#1110).
  return readFirstLineOf(path, max)
}

/** Helpers shared by provider adapters. */

/** `ended`: it didn't exit by itself (its timeout ended it, or it couldn't start): its code says nothing then. */
export function run(file: string, args: string[], timeoutMs = 15000, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number; ended?: true; timedOut?: true }> {
  const shell = /\.(cmd|bat)$/i.test(file)
  // Through cmd, Node joins the command and its arguments as they are: a path with spaces ("C:\My Tools\agy.cmd") would be
  // read as "C:\My" (HI-2548), so it and any argument with a space are quoted.
  const quote = (a: string): string => (shell && /\s/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a)
  return new Promise((resolve) => {
    execFile(quote(file), args.map(quote), { timeout: timeoutMs, windowsHide: true, shell, encoding: 'utf8', env }, (err, stdout, stderr) => {
      const raw = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0
      const code = err ? (raw as unknown as number) || 1 : 0
      const ended = !!err && (!!(err as { killed?: boolean }).killed || typeof raw !== 'number')
      // timedOut (HI-2779): killed at its timeout, told from a program that couldn't start (ENOENT), which ends too.
      const timedOut = !!err && !!(err as { killed?: boolean }).killed
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: typeof code === 'number' ? code : 1, ...(ended ? { ended: true as const } : {}), ...(timedOut ? { timedOut: true as const } : {}) })
    })
  })
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Copies of a CLI that belong to an editor extension (VS Code, Cursor…), which Combwork never uses. */
export const EDITOR_EXTENSION_PATH = /[\\/]\.(vscode|vscode-insiders|cursor|windsurf)[\\/]extensions[\\/]/i

export const EDITOR_ROOTS = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']

/** The longest command line cmd.exe runs; CreateProcess, which starts an .exe directly, allows 32,767 characters. */
export const CMD_MAX_CHARS = 8191
/** A .cmd/.bat launch too long for cmd.exe (#842): thrown at a launch, read by the window and agents alike. */
const CMD_TOO_LONG = msg({ id: 'providers.cmdTooLong', defaultMessage: "{file} has to run through cmd.exe, which takes a command line of at most {max, number} characters, and this launch needs about {length, number}. Set the CLI's path in Settings to its .exe (or install the standalone CLI), which has no such limit.", description: "Starting an agent is refused: its CLI is a .cmd or .bat launcher, and cmd.exe can't take a command line this long. {file} is the launcher's file name; {max} and {length} are numbers of characters. Keep cmd.exe and .exe as they are." })

/**
 * npm's launcher for a Node package's bin (cmd-shim), line by line, with the last line's script path left open: it
 * runs that script with node.exe beside it or `node` on PATH, and passes on exactly its arguments (%*).
 */
const NPM_SHIM_LINES = [
  '@ECHO off',
  'GOTO start', // i18n-ignore: an npm shim's batch file
  ':find_dp0',
  'SET dp0=%~dp0', // i18n-ignore: an npm shim's batch file
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (', // i18n-ignore: an npm shim's batch file
  'SET "_prog=%dp0%\\node.exe"', // i18n-ignore: an npm shim's batch file
  ') ELSE (', // i18n-ignore: an npm shim's batch file
  'SET "_prog=node"', // i18n-ignore: an npm shim's batch file
  'SET PATHEXT=%PATHEXT:;.JS;=;%', // i18n-ignore: an npm shim's batch file
  ')'
]
const NPM_SHIM_RUN = /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +"%dp0%\\([^"%*?<>|&^]+\.[cm]?js)" %\*$/
const ONE_LINE_RUN = /^@node "%~dp0\\?([^"%*?<>|&^]+\.[cm]?js)" %\*$/

/**
 * The node and script a Node CLI's .cmd launcher runs, so Combwork can start them directly instead of through cmd.exe (and
 * its 8,191-character command line, which the Combwork Assistant's Codex launch is longer than). Only launchers that do
 * nothing else are taken, matched whole: npm's (NPM_SHIM_LINES) and the bare one-line `@node "%~dp0cli.cjs" %*`. One
 * that sets anything, passes its own arguments or Node flags, or runs another interpreter gives null and still goes
 * through cmd.exe, since starting its script directly would leave that out.
 */
export function shimTarget(cmdFile: string, env: NodeJS.ProcessEnv = process.env): { node: string; script: string } | null {
  let text: string
  try {
    if (statSync(cmdFile).size > 64 * 1024) return null
    text = readFileSync(cmdFile, 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const dir = dirname(cmdFile)
  let rel: string | undefined
  let besideFirst = false
  if (lines.length === 1) rel = ONE_LINE_RUN.exec(lines[0])?.[1]
  else if (lines.length === NPM_SHIM_LINES.length + 1 && NPM_SHIM_LINES.every((l, i) => lines[i] === l)) {
    rel = NPM_SHIM_RUN.exec(lines[NPM_SHIM_LINES.length])?.[1]
    besideFirst = true
  }
  if (!rel) return null
  const script = join(dir, rel)
  if (!existsSync(script)) return null
  const beside = join(dir, 'node.exe')
  const node = besideFirst && existsSync(beside) ? beside : onPath('node.exe', env)
  return node ? { node, script } : null
}

/** A program on PATH (as cmd.exe would find it), or null. */
function onPath(exe: string, env: NodeJS.ProcessEnv): string | null {
  const path = env.PATH ?? env.Path ?? ''
  for (const d of path.split(delimiter)) {
    if (!d) continue
    const f = join(d.replace(/^"|"$/g, ''), exe)
    if (existsSync(f)) return f
  }
  return null
}

/** Whether Combwork starts this executable through cmd.exe (a .cmd/.bat it can't start directly). */
export function runsThroughCmd(file: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file) && !shimTarget(file)
}

/**
 * A program and its arguments as a list (quoted by whatever starts it), and on Windows maybe `line`: the command line to
 * start it with instead, passed on as it is, as cmd.exe needs it (toSpawnable). node-pty takes it as a string
 * (`ptyArgs`); a child process as its one verbatim argument (`childArgs`).
 */
export interface Spawnable {
  file: string
  args: string[]
  line?: string
}

/**
 * How to start a CLI with node-pty: an .exe as it is; a Node CLI's .cmd launcher as its node and script (shimTarget);
 * any other .cmd/.bat through cmd.exe, refused with a clear error when the command line is longer than cmd.exe takes.
 * cmd.exe's command line (`line`) is `/d /s /c "<launcher> <arguments>"`, each quoted where it needs it (HI-2722): `/s`
 * strips the line's first and last quote, so the extra pair keeps a quoted path (one with spaces) and quoted arguments
 * whole; passed on as a string, nothing quotes or escapes it again. Its `args` say the same as a list, for what reads them.
 */
export function toSpawnable(file: string, args: string[]): Spawnable {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const direct = shimTarget(file)
    if (direct) return { file: direct.node, args: [direct.script, ...args] }
    const out = { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', file, ...args], line: `/d /s /c "${[file, ...args].map(cmdArg).join(' ')}"` }
    const length = commandLineLength(out.file, out.line)
    if (length > CMD_MAX_CHARS) {
      throw combworkError(CMD_TOO_LONG, { file: basename(file), max: CMD_MAX_CHARS, length })
    }
    return out
  }
  return { file, args }
}

/** A Spawnable's arguments for node-pty: its command line where it has one (passed on as it is), else its list. */
export function ptyArgs(s: { args: string[]; line?: string }): string[] | string {
  return s.line ?? s.args
}

/**
 * One argument of the line cmd.exe runs, quoted when it is empty or has a space, a quote or a character cmd.exe acts on,
 * so that both cmd.exe (the line, then the launcher's own line holding it as %*) and the program read it whole. cmd.exe
 * turns its quoting on and off at every `"`, `\"` too, so a quote inside is doubled (`""`, which a program reads as one
 * quote inside quotes) and every `&|<>^` stays inside cmd.exe's quotes, never a command of its own (HI-2722, HR1). A `%`
 * is followed by `%cd:~,%`, which cmd.exe expands to nothing, so no `%NAME%` in it is expanded. Backslashes before a
 * quote are doubled, as a program reads them.
 */
export function cmdArg(arg: string): string {
  if (arg && !/[\s"&|<>^(),;=%!]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') slashes++
    else if (ch === '"') {
      out += `${'\\'.repeat(slashes * 2)}""`
      slashes = 0
    } else if (ch === '%') {
      out += `${'\\'.repeat(slashes)}%%cd:~,%`
      slashes = 0
    } else {
      out += '\\'.repeat(slashes) + ch
      slashes = 0
    }
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`
}

/** A Spawnable's arguments for child_process.spawn: its command line as its one argument, passed on verbatim, else its list. */
export function childArgs(s: Spawnable): { args: string[]; windowsVerbatimArguments: boolean } {
  return s.line !== undefined ? { args: [s.line], windowsVerbatimArguments: true } : { args: s.args, windowsVerbatimArguments: false }
}

/**
 * About how long a Windows command line is with these arguments, quoted as CreateProcess needs (an estimate, on the long
 * side); a command line given as a string is counted as it is.
 */
export function commandLineLength(file: string, args: string[] | string): number {
  const quoted = (a: string): number => (/[\s"]/.test(a) || !a ? a.length + 2 + (a.match(/["\\]/g)?.length ?? 0) : a.length)
  if (typeof args === 'string') return quoted(file) + 1 + args.length
  return [file, ...args].reduce((n, a) => n + quoted(a) + 1, 0)
}

/**
 * A first task as the CLI's last argument. A .cmd/.bat Combwork can't start directly runs through cmd.exe, which can't pass
 * newlines or its special characters safely, so there it becomes one plain line (a Node CLI's launcher is started as
 * node and its script, which take it as it is). A leading dash would read as an option.
 */
export function promptArg(executable: string, text: string): string {
  let t = runsThroughCmd(executable) ? text.replace(/["%^&|<>!]/g, ' ').replace(/\s+/g, ' ').trim() : text.trim()
  if (t.startsWith('-')) t = `Task: ${t}` // i18n-ignore: typed to the CLI
  return t
}

/**
 * A first task after the user's extra arguments, for a CLI that takes it as its last positional argument (Claude Code,
 * Codex): behind a "--" of Combwork's own, so an option that takes a list ("--allowedTools a b", Codex's "--image a.png")
 * ending the extra arguments can't read the task as another of its values (#523). Extra arguments never hold a bare
 * "--" of their own: Settings refuses one, and so does a launch (extraArgsProblem).
 */
export function taskArgs(executable: string, text: string): string[] {
  return ['--', promptArg(executable, text)]
}

/**
 * A shell command that forwards a hook's JSON (stdin) to Combwork's hook server with curl (on PATH in Windows 10+, and in
 * Git Bash), for hooks a CLI can only run as commands. The Authorization header comes from the launch's auth file
 * (`-H @<file>`, in Combwork's user data), so neither the command nor any file it is written to holds a token (#345). The
 * form works in Git Bash, PowerShell and cmd alike: `curl.exe` unquoted (a quoted path is an expression in PowerShell),
 * `"@-"` quoted (a bare @- is splatting there), forward slashes (bash would eat backslashes). Codex's hook trust hash
 * covers this text (codex/adapter.ts hookHash). `seconds`: how long curl tries, the hook's own timeout (#367).
 */
export function hookForwardCommand(hookUrl: string, authFile: string, seconds = 5): string {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'
  return `${curl} -s -m ${seconds} -X POST -H "@${authFile.split('\\').join('/')}" -H "Content-Type: application/json" --data-binary "@-" "${hookUrl}"` // i18n-ignore: a hook command the CLI runs
}

/**
 * A hook's own ids (#648), read from the fields that hold them in this CLI's hooks (`turn`: the field naming its turn).
 * Only plain, short strings: an id is never the user's text.
 */
export function hookIds(body: Record<string, any>, fields: { turn: string; call: string; sub?: string }): HookIds {
  const id = (v: unknown): string | null => (typeof v === 'string' && /^[\w.:-]{1,128}$/.test(v) ? v : null)
  return { turn: id(body[fields.turn]), call: id(body[fields.call]), sub: fields.sub ? id(body[fields.sub]) : null, continued: body.stop_hook_active === true }
}

/** Remembers `value` for a launch (`key`), keeping only the latest 16: a launch stopped part-way never takes its own. */
export function keepBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > 16) map.delete(map.keys().next().value!)
}

/** Estimates how many tokens resuming a session will write to the prompt cache (providers with a cache TTL). */
export function recacheEstimate(usage: SessionUsage, ttlOverride: 'auto' | '5m' | '1h', now = Date.now()): RecacheEstimate {
  const ttlSeconds = ttlOverride === '5m' ? 300 : ttlOverride === '1h' ? 3600 : usage.cacheTtlSeconds
  const last = usage.lastActivity ? Date.parse(usage.lastActivity) : 0
  const elapsed = last ? (now - last) / 1000 : Infinity
  const warm = elapsed < ttlSeconds
  return {
    tokens: usage.contextTokens,
    warm,
    secondsLeft: warm ? Math.max(0, Math.round(ttlSeconds - elapsed)) : 0,
    ttlSeconds
  }
}

// ---------------------------------------------------------------------------
// Combwork's skill copies in a project's .agents/skills (Codex, Copilot)
// ---------------------------------------------------------------------------

/** The folder, relative to an agent's working folder, where CLIs without a per-launch skills folder read Combwork's copies. */
export const AGENTS_SKILLS = join('.agents', 'skills')

/** The prefix of Combwork's copies' folders in .agents/skills (HI-2463: the name agents see their skills by). */
export const COPY_PREFIX = 'cw-'

/** Where a launch's CLI reads Combwork's copy of a skill in .agents/skills. */
export function agentsSkillCopyPath(cwd: string, skill: string): string {
  return join(cwd, AGENTS_SKILLS, `${COPY_PREFIX}${skill}`)
}

/** The hash in a Combwork copy's marker ('' for one from before hashes), or null: not Combwork's copy (or no folder). */
async function skillMarker(folder: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(join(folder, COPY_MARKER), 'utf8')) as { hash?: string }).hash ?? ''
  } catch {
    return null
  }
}

/**
 * A skill not delivered this time, for `problem`: what the CLI reads of it is Combwork's copy from an earlier launch, if one
 * is there (its revision, and the problem says it kept it); a folder of the user's with its name is never Combwork's delivery.
 */
async function keptCopy(dest: string, problem: string): Promise<SkillDelivery> {
  const kept = existsSync(dest) && (await skillMarker(dest)) !== null ? await contentHash(dest).catch(() => null) : null
  return { revision: kept, problem: kept ? `${problem}, so it kept its old copy` : problem } // i18n-ignore: the skills' launch record, which agents read (the Agent API's status): guidance.ts
}

/**
 * Copies the session's Combwork skills into <cwd>/.agents/skills/cw-<name> (for CLIs with no per-launch skills folder:
 * Codex and Copilot, which share the copies), removes Combwork's copies of skills it no longer gets, and keeps them out of
 * git. Combwork's copies carry a marker file (with the source's hash): folders without one are the user's and are never
 * touched. An unchanged skill isn't copied again, and a changed one is swapped in whole (swapIn), so another agent
 * sharing the folder never reads one half-copied; it does read the new version from then on (the CLIs read a skill's
 * files when they use it). What a swap interrupted by a crash left there is tidied first. Says what each skill's copy
 * now is. `cli` names the CLI in the log.
 */
export async function syncAgentsSkills(ctx: LaunchContext, cli: string): Promise<Record<string, SkillDelivery>> {
  try {
    // Agents sharing a folder start together (resuming after a restart): one copies at a time.
    return await withFileLock(join(ctx.cwd, AGENTS_SKILLS), () => syncAgentsSkillsNow(ctx, cli))
  } catch (e) {
    // The folder couldn't be set up or locked: nothing was copied, and each skill is what was there before (a copy
    // Combwork made at an earlier launch, read without the lock: another launch may be changing it).
    log.warn(`Could not copy skills for ${cli}`, e)
    const out: Record<string, SkillDelivery> = {}
    for (const s of ctx.skills) out[s.name] = await keptCopy(agentsSkillCopyPath(ctx.cwd, s.name), 'the skills could not be copied') // i18n-ignore: the skills' launch record, which agents read (the Agent API's status): guidance.ts
    return out
  }
}

async function syncAgentsSkillsNow(ctx: LaunchContext, cli: string): Promise<Record<string, SkillDelivery>> {
  const dir = join(ctx.cwd, AGENTS_SKILLS)
  const out: Record<string, SkillDelivery> = {}
  const wanted = new Map(ctx.skills.map((s) => [`${COPY_PREFIX}${s.name}`, s]))
  if (!ctx.skills.length && !existsSync(dir)) return out
  await mkdir(dir, { recursive: true })
  // Under the same lock as the swaps: Combwork's own leftovers only (dot-folders named for a swap).
  await cleanSwaps(dir, unchangedCopy)
  const own = await ownCopies(ctx.cwd, ctx.projectPath, ctx.copies)
  for (const f of (await readdir(dir).catch(() => [] as string[])).filter((e) => e.startsWith(COPY_PREFIX))) {
    // A copy Combwork no longer gives (switched off, deleted or renamed) goes only when it is Combwork's own, unchanged
    // (#1431), and no other session of Combwork's works in the folder (it may be reading it): asked for each copy, inside
    // the lock. One kept now (a reader there, or a file in it open) goes at a later launch with the folder to itself, or
    // when the last session there ends (as Settings → Advanced says).
    if (wanted.has(f) || ctx.othersHere?.()) continue
    const skill = f.slice(COPY_PREFIX.length)
    const revision = await own(skill)
    if (revision) await retireCopy(ctx.cwd, skill, revision, ctx.copies).catch((e) => log.warn(`Could not remove ${userText(f)} for ${cli}; trying again next time`, e))
  }
  for (const [folder, s] of wanted) {
    // One skill's failure is its own: the others are still delivered, and each record says what the CLI reads.
    try {
      out[s.name] = await deliverSkill(s, join(dir, folder), folder, cli)
    } catch (e) {
      log.warn(`Could not copy skill ${userText(s.name)} for ${cli}`, e)
      out[s.name] = await keptCopy(join(dir, folder), 'it could not be copied') // i18n-ignore: the skills' launch record, which agents read (the Agent API's status): guidance.ts
    }
    // Combwork's record of the copy (#1431): only one that is exactly what Combwork wrote (its content its marker's hash), so a
    // copy edited since keeps its old record and is never taken for Combwork's own.
    const revision = out[s.name].revision
    if (ctx.copies && revision && (await skillMarker(join(dir, folder))) === revision) await ctx.copies.record(ctx.cwd, ctx.projectPath, s.name, revision).catch((e) => log.warn(`Could not record Combwork's copy of ${userText(s.name)} for ${cli}`, e))
  }
  // Keeping the copies out of git: a failure here changes nothing about what was delivered.
  await excludeCopies(ctx.cwd).catch((e) => log.warn(`Could not add Combwork's ${cli} skill copies to git's exclude file`, e))
  return out
}

/**
 * Which copies in a folder's .agents/skills are Combwork's own to remove (#1431): the copy's marker says Combwork made it, Combwork's
 * record says so too, and its content is still the revision recorded (unchanged since delivery), so neither a user's
 * skill nor a copy edited since is ever removed. A marked copy without a record (made before records) whose content is
 * still its marker's hash is provably Combwork's and unchanged: it is recorded then. Records that can't be read: none is.
 * Without a book (tests), the marker and content alone decide. Each answer is the revision the copy may be removed at
 * (null: it stays), which retireCopy checks again as it goes: an edit made meanwhile keeps it.
 */
async function ownCopies(folder: string, project: string, book: SkillCopyBook | undefined): Promise<(skill: string) => Promise<string | null>> {
  const records = book ? await book.of(folder).catch((e) => (log.warn("Could not read Combwork's record of its skill copies", e), null)) : undefined
  return async (skill) => {
    if (records === null) return null
    const dest = agentsSkillCopyPath(folder, skill)
    const marker = await skillMarker(dest)
    // No marker: the user's. An empty one, from before hashes: whether it was changed can't be told.
    if (!marker) return null
    const now = await contentHash(dest).catch(() => null)
    if (!now) return null
    if (!records) return now === marker ? now : null
    const rec = records.get(skill.toLowerCase())
    if (rec) return now === rec.revision ? now : null
    if (now !== marker) return null
    await book!.record(folder, project, skill, now)
    return now
  }
}

/**
 * Removes Combwork's copy of a skill in a folder only while it is still `revision` (swapOut: checked under Combwork's editors'
 * file locks, again once moved aside and just before it goes, so an edit made since ownCopies looked keeps it, put back
 * or kept beside it as a conflict copy), then its record. One already gone just loses its record; one edited meanwhile
 * keeps its record, whose revision no longer matches, so it is never taken for Combwork's own again.
 */
async function retireCopy(folder: string, skill: string, revision: string, book: SkillCopyBook | undefined): Promise<void> {
  const dest = agentsSkillCopyPath(folder, skill)
  if (existsSync(dest)) await swapOut(dest, revision)
  await book?.forget(folder, skill)
}

/**
 * cleanSwaps' test in .agents/skills: what a crash left aside is removed only while it is a Combwork copy whose content is
 * still its marker's hash; anything else is kept beside it as a conflict copy.
 */
async function unchangedCopy(aside: string): Promise<boolean> {
  const marker = await skillMarker(aside)
  return !!marker && (await contentHash(aside).catch(() => null)) === marker
}

/**
 * Removes Combwork's own skill copies from a folder's .agents/skills (#1431: the last of Combwork's sessions there ended, a lease
 * ended, a slot is about to go, or at start for folders whose sessions are gone), under syncAgentsSkills' lock, so a
 * launch meanwhile wins: `busy` is asked inside the lock, and a folder a session of Combwork's is in keeps every copy. Only
 * Combwork's own copies go (ownCopies); a user's skill, a copy edited since, and anything else in the folder stay. Records of
 * copies no longer there are dropped. Says which skills' copies were removed.
 */
export async function removeCombworkCopies(folder: string, project: string, book: SkillCopyBook | undefined, busy: () => boolean): Promise<string[]> {
  const dir = join(folder, AGENTS_SKILLS)
  return withFileLock(dir, async () => {
    if (busy()) return []
    const recorded = book ? await book.of(folder).catch(() => new Map<string, SkillCopyRecord>()) : new Map<string, SkillCopyRecord>()
    if (!existsSync(dir)) {
      for (const r of recorded.values()) await book?.forget(folder, r.skill).catch(() => undefined)
      return []
    }
    await cleanSwaps(dir, unchangedCopy)
    const own = await ownCopies(folder, project, book)
    const names = new Set([...recorded.values()].map((r) => r.skill))
    for (const f of await readdir(dir).catch(() => [] as string[])) if (f.startsWith(COPY_PREFIX)) names.add(f.slice(COPY_PREFIX.length))
    const removed: string[] = []
    for (const skill of names) {
      try {
        if (!existsSync(agentsSkillCopyPath(folder, skill))) {
          // A record with no copy is dropped.
          await book?.forget(folder, skill)
        } else {
          const revision = await own(skill)
          if (!revision) continue
          await retireCopy(folder, skill, revision, book)
          if (!removed.includes(skill)) removed.push(skill)
        }
      } catch (e) {
        // In use (a CLI run on its own there has a file open): it stays, and goes at a later clean-up.
        log.warn(`Could not remove Combwork's copy of ${userText(skill)} from ${userText(folder)}; trying again later`, e)
      }
    }
    return removed
  })
}

/** One skill into its folder in .agents/skills (under syncAgentsSkills' lock): what the CLI reads of it afterwards. */
async function deliverSkill(s: LaunchContext['skills'][number], dest: string, folder: string, cli: string): Promise<SkillDelivery> {
  // One identity for the source, Combwork's copies and their markers: contentHash, which counts links (never following
  // them) and leaves the marker out. A marker from before (another hash) just means one more copy.
  // The launch's settings' read of the source where they had one (HI-2268: hashed again only when its files changed).
  let hash: string
  try {
    hash = s.revision || (await contentHash(s.sourcePath))
  } catch (e) {
    // Not copied. Combwork's copy from an earlier launch stays, and is what the CLI reads: its revision is what reached the
    // session. A folder of the user's with the name is theirs, not a delivery. Too big lasts until the skill is
    // smaller; a source that couldn't be read (gone, or being edited) may work at the next launch.
    if (e instanceof ContentTooLarge) return { ...(await keptCopy(dest, tooBigToDeliver(e))), lasting: true }
    log.warn(`Could not read skill ${userText(s.name)} for ${cli}`, e)
    return keptCopy(dest, sourceProblem(e, s.sourcePath))
  }
  const revision = (): Promise<string | null> => contentHash(dest).catch(() => null)
  // What the CLI reads now: the copy's revision, or why it has none (never a silent null).
  const current = async (): Promise<SkillDelivery> => {
    try {
      return { revision: await contentHash(dest) }
    } catch (e) {
      return e instanceof ContentTooLarge ? { revision: null, problem: tooBigToDeliver(e), lasting: true } : { revision: null, problem: 'its copy could not be read' } // i18n-ignore: the skills' launch record, which agents read (the Agent API's status): guidance.ts
    }
  }
  const had = existsSync(dest) ? await skillMarker(dest) : undefined
  if (had === hash) return current()
  if (had === null) {
    // Not marked: the user's own folder, unless it is an unchanged copy from before markers.
    if ((await revision()) !== hash) {
      log.warn(`Not copying skill ${userText(s.name)} for ${cli}: ${userText(dest)} is not Combwork's copy.`)
      return { revision: null, problem: `a folder of the user's in .agents/skills is named ${folder}`, lasting: true } // i18n-ignore: the skills' launch record, which agents read (the Agent API's status): guidance.ts
    }
    await writeFile(join(dest, COPY_MARKER), JSON.stringify({ source: s.sourcePath, hash }) + '\n')
    return current()
  }
  try {
    // The copy is checked before it goes in (within the limits, as the source is read), and its marker and the record
    // are what was copied: the source may have changed since it was hashed above.
    const copied = await swapIn(s.sourcePath, dest, { prepare: (copy, rev) => writeFile(join(copy, COPY_MARKER), JSON.stringify({ source: s.sourcePath, hash: rev }) + '\n') })
    return { revision: copied }
  } catch (e) {
    log.warn(`Could not update skill ${userText(s.name)} for ${cli}; it keeps the copy it has`, e)
    // A link the skill has that can't be made here, or a source grown past the limits while it was copied: a restart
    // won't change that. A source gone or unreadable while it was copied may work next time. Either way nothing was
    // replaced: what the CLI reads is the copy that was there.
    if (e instanceof LinkNotCopied) return { ...(await keptCopy(dest, e.message)), lasting: true }
    if (e instanceof ContentTooLarge) return { ...(await keptCopy(dest, tooBigToDeliver(e))), lasting: true }
    if (e instanceof CopyFailed || !existsSync(s.sourcePath)) return keptCopy(dest, sourceProblem(e, s.sourcePath))
    // With a file in the old copy open, that copy stays until a later launch.
    const code = (e as NodeJS.ErrnoException).code
    const kept = existsSync(dest) ? await revision() : null
    if (!kept) return { revision: null, problem: 'it could not be copied' } // i18n-ignore: the skills' launch record, which agents read (the Agent API's status): guidance.ts
    // Windows won't move a folder with a file in it open (EBUSY, EPERM, EACCES): a running session is reading it.
    return { revision: kept, problem: code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' ? 'its old copy was in use, so it kept that one' : `it could not be copied${code ? ` (${code})` : ''}, so it kept its old copy` } // i18n-ignore: the skills' launch record, which agents read (the Agent API's status): guidance.ts
  }
}

/** The comment above Combwork's copies' lines in a repository's info/exclude (HI-2580). */
export const COPIES_EXCLUDE_COMMENT = "# Combwork's copies of workspace skills for Codex and Copilot (added by Combwork)" // i18n-ignore: a line in git's exclude file, which stays English
/** How that comment starts: Combwork's own (one from before 1.1 says Combwork's by then: the names upgrade, HI-2587). */
const COPIES_COMMENT_HEAD = "# Combwork's copies of workspace skills" // i18n-ignore: a line in git's exclude file, which stays English

/** Keeps Combwork's copies (and a swap's dot-folders) out of git, in the repository's info/exclude. */
export async function excludeCopies(cwd: string): Promise<void> {
  const common = await git(cwd, ['rev-parse', '--git-common-dir'], undefined, undefined, { timeout: 5000 })
  const gitDir = common.ok ? common.out.trim() : ''
  if (!gitDir) return
  const exclude = join(isAbsolute(gitDir) ? gitDir : resolvePath(cwd, gitDir), 'info', 'exclude')
  const text = await readFile(exclude, 'utf8').catch(() => '')
  const lines = text.split(/\r?\n/)
  // Combwork's copies, and the dot-folders a swap uses for a moment (left behind only by a crash, until the next launch).
  const missing = ['/.agents/skills/cw-*/', '/.agents/skills/.cw-*/'].filter((l) => !lines.includes(l))
  if (missing.length) {
    await mkdir(join(exclude, '..'), { recursive: true })
    await appendFile(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${lines.some((l) => l.startsWith(COPIES_COMMENT_HEAD)) ? '' : `${COPIES_EXCLUDE_COMMENT}\n`}${missing.join('\n')}\n`)
  }
}

/**
 * The English text a provider's install info holds (its readiness, its notes), each with the same as data (#797):
 * Combwork's own code and the Agent API (GET /v1/status, /v1/providers) read the English, and the window is sent it in the
 * language it shows (shownInstallInfo).
 */
const INSTALL_TEXT = new Map<string, TextPart>()

/** Text for a provider's install info: its English, remembered as data so the window can be shown it in its language. */
export function installText(t: TextPart): string {
  // agent-stored: agentInstallInfo says it again for each agent, from INSTALL_TEXT
  const english = englishText(t)
  INSTALL_TEXT.set(english, t)
  return english
}

/** A provider's install info as the window shows it: its readiness and notes in the language shown (#797). */
export function shownInstallInfo(info: AgentInstallInfo): AgentInstallInfo {
  return installInfoIn(info, (s) => {
    const t = INSTALL_TEXT.get(s)
    return t === undefined ? s : shownText(t)
  })
}

/** A provider's install info as an agent reads it (the Agent API's status): Combwork's own words in its dialect (dialects, HI-2440). */
export const agentInstallInfo = (info: AgentInstallInfo): AgentInstallInfo => installInfoIn(info, (s) => agentField(s, INSTALL_TEXT.get(s)))

function installInfoIn(info: AgentInstallInfo, shown: (s: string) => string): AgentInstallInfo {
  return {
    ...info,
    ...(info.updateRetry ? { updateRetry: { message: shown(info.updateRetry.message), label: shown(info.updateRetry.label) } } : {}),
    ...(info.readiness ? { readiness: info.readiness.map((r) => ({ ...r, message: shown(r.message), ...(r.action ? { action: { ...r.action, label: shown(r.action.label) } } : {}), ...(r.detail ? { detail: r.detail.map(shown) } : {}) })) } : {}),
    ...(info.notes ? { notes: info.notes.map(shown) } : {})
  }
}

const READINESS = {
  notInstalled: msg({ id: 'providers.readiness.notInstalled', defaultMessage: '{provider} is not installed.', description: "Provider Setup and Settings → Providers: Combwork didn't find the coding agent's CLI. {provider} is its name (Claude Code)." }),
  signedOut: msg({ id: 'providers.readiness.signedOut', defaultMessage: '{provider} is not signed in.', description: "Provider Setup and Settings → Providers: the coding agent's CLI has no sign-in. {provider} is its name." }),
  updateStayed: msg({ id: 'providers.readiness.updateStayed', defaultMessage: "{provider} stayed on {version} after updating to {offered}: an organisation's policy may set its version or channel, or the update didn't take. Check again later, or update again.", description: 'Provider Setup and Settings → Providers: the coding agent was updated but is still on its old version (HI-2777). {provider} is its name, {version} the version it stayed on, {offered} the one offered. "Check again" and "update" name the buttons beside it.' }),
  update: msg({ id: 'providers.readiness.update', defaultMessage: '{provider} {version} is available.', description: 'Provider Setup and Settings → Providers: a newer version of the coding agent is out. {provider} is its name, {version} the version.' }),
  install: msg({ id: 'providers.action.install', defaultMessage: 'Install', description: "Provider Setup's button: installs the coding agent's CLI in a terminal." }),
  signIn: msg({ id: 'providers.action.signIn', defaultMessage: 'Sign in', description: "Provider Setup's button: signs the coding agent's CLI in, in a terminal." }),
  updateAction: msg({ id: 'providers.action.update', defaultMessage: 'Update', description: "Provider Setup's button: updates the coding agent's CLI in a terminal." })
}

/** The CLI isn't installed: install it from Provider Setup. */
export const notInstalledIssue = (provider: string): ReadinessIssue => ({ id: 'not-installed', level: 'error', message: installText({ m: READINESS.notInstalled, values: { provider } }), action: { label: installText(READINESS.install), task: 'install' } })

/** The CLI isn't signed in: sign in from Provider Setup, with what that does (`detail`). */
export const signedOutIssue = (provider: string, detail?: TextPart[]): ReadinessIssue => ({
  id: 'signed-out',
  level: 'error',
  message: installText({ m: READINESS.signedOut, values: { provider } }),
  action: { label: installText(READINESS.signIn), task: 'login' },
  ...(detail ? { detail: detail.map(installText) } : {})
})

/** A newer version is out: Update, or (`detail`) how to update it where Combwork can't. */
export const updateIssue = (provider: string, version: string | null, detail?: TextPart[]): ReadinessIssue => ({
  id: 'update',
  level: 'info',
  message: installText({ m: READINESS.update, values: { provider, version: version ?? '' } }),
  ...(detail ? { detail: detail.map(installText) } : { action: { label: installText(READINESS.updateAction), task: 'update' } })
})

/** It stayed on its version after an update (HI-2777): said tentatively, with Update still offered. */
export const updateStayedIssue = (provider: string, version: string, offered: string): ReadinessIssue => ({
  id: 'update',
  level: 'info',
  message: installText({ m: READINESS.updateStayed, values: { provider, version, offered } }),
  action: { label: installText(READINESS.updateAction), task: 'update' }
})

const EXPORT_SUBTITLE = msg({ id: 'providers.export.subtitle', defaultMessage: '{provider} session `{session}` · project {project}', description: "The Markdown export of a conversation (Sessions tab → Export): the line under its title. {provider} is the coding agent (Claude Code), {session} the session's id (`…` marks it: keep the marks), {project} the project." })
const USER_MEMORY = msg({ id: 'providers.memory.user', defaultMessage: 'User {file} (all projects)', description: "In the Memory view: the user's own instructions file, which every project's agents read. {file} is its name (CLAUDE.md)." })

/** The line under an exported conversation's title (#797). */
export const exportSubtitleText = (provider: string, session: string, project: string): string => tr(EXPORT_SUBTITLE, { provider, session, project })

/** The Memory view's label for the user's own instructions file, which every project's agents read. */
export const userMemoryLabel = (file: string): string => tr(USER_MEMORY, { file })

const CONNECTION_MEMORY = msg({ id: 'providers.memory.connection', defaultMessage: '{file} of connection {name} (its agents, all projects)', description: "In the Memory view: a connection's own instructions file (HI-1755), which the agents running on that connection read in every project. {file} is its name (CLAUDE.md), {name} the connection's name (\"Personal\")." })
/** The Memory view's label for a connection's own instructions file (HI-1755). */
export const connectionMemoryLabel = (file: string, name: string): string => tr(CONNECTION_MEMORY, { file, name })

/**
 * An environment for running a CLI on a connection (HI-1757): without the variables it would read as a login instead.
 * `adapter` null (not on a connection): the environment as it is.
 */
export function withoutAccountEnv<T extends Record<string, string | undefined>>(adapter: { accountEnvDrop?(): readonly string[]; accountEnvDropPattern?(): RegExp } | null, env: T): T {
  const drop = adapter?.accountEnvDrop?.() ?? []
  const pattern = adapter?.accountEnvDropPattern?.() ?? null
  if (!drop.length && !pattern) return env
  const out = { ...env }
  // Windows' variable names aren't case-sensitive: any spelling of one goes (a pattern is matched on the name in
  // capitals, as well as as written).
  const names = new Set(drop.map((k) => k.toUpperCase()))
  for (const k of Object.keys(out)) if (names.has(k.toUpperCase()) || (pattern && (pattern.test(k) || pattern.test(k.toUpperCase())))) delete out[k]
  return out
}

/**
 * An environment with a server connection's own variables set (HI-1772: its server, models and key), any spelling of
 * the same names before them gone. `vars` undefined: the environment as it is.
 */
export function withServerEnv<T extends Record<string, string | undefined>>(vars: Record<string, string> | undefined, env: T): T {
  if (!vars) return env
  const names = new Set(Object.keys(vars).map((k) => k.toUpperCase()))
  const out = { ...env }
  for (const k of Object.keys(out)) if (names.has(k.toUpperCase())) delete out[k]
  return { ...out, ...vars }
}
