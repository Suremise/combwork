import { execFile } from 'child_process'
import { existsSync, readFileSync, statSync } from 'original-fs'
import { appendFile, mkdir, readdir, readFile, writeFile } from 'original-fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'path'
import { englishText, shownText, type TextPart } from '../../shared/advanced'
import { msg, tr } from '../../shared/i18n'
import type { AgentInstallInfo, ReadinessIssue, RecacheEstimate, SessionUsage } from '../../shared/types'
import { readFirstLineOf } from '../transcriptFiles'
import { cleanSwaps, contentHash, ContentTooLarge, COPY_MARKER, CopyFailed, LinkNotCopied, removePath, sourceProblem, swapIn, tooBigToDeliver, withFileLock } from '../fsutil'
import { createLogger, userText } from '../logger'
import { hiveError } from '../hiveError'
import { git } from '../git'
import type { HookIds, LaunchContext, SkillDelivery } from './types'

const log = createLogger('providers')

/** The first line of a file (a transcript's header), read without loading the whole transcript. */
export function readFirstLine(path: string, max = 1 << 20): Promise<string> {
  // A compressed backup too (#1110).
  return readFirstLineOf(path, max)
}

/** Helpers shared by provider adapters. */

export function run(file: string, args: string[], timeoutMs = 15000, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  const shell = /\.(cmd|bat)$/i.test(file)
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, shell, encoding: 'utf8', env }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) || 1 : 0
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: typeof code === 'number' ? code : 1 })
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

/** Copies of a CLI that belong to an editor extension (VS Code, Cursor…), which Hive never uses. */
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
 * The node and script a Node CLI's .cmd launcher runs, so Hive can start them directly instead of through cmd.exe (and
 * its 8,191-character command line, which the Hive Assistant's Codex launch is longer than). Only launchers that do
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

/** Whether Hive starts this executable through cmd.exe (a .cmd/.bat it can't start directly). */
export function runsThroughCmd(file: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file) && !shimTarget(file)
}

/**
 * How to start a CLI with node-pty: an .exe as it is; a Node CLI's .cmd launcher as its node and script (shimTarget);
 * any other .cmd/.bat through cmd.exe, refused with a clear error when the command line is longer than cmd.exe takes.
 */
export function toSpawnable(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const direct = shimTarget(file)
    if (direct) return { file: direct.node, args: [direct.script, ...args] }
    const out = { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', file, ...args] }
    const length = commandLineLength(out.file, out.args)
    if (length > CMD_MAX_CHARS) {
      throw hiveError(CMD_TOO_LONG, { file: basename(file), max: CMD_MAX_CHARS, length })
    }
    return out
  }
  return { file, args }
}

/** About how long a Windows command line is with these arguments, quoted as CreateProcess needs (an estimate, on the long side). */
export function commandLineLength(file: string, args: string[]): number {
  const quoted = (a: string): number => (/[\s"]/.test(a) || !a ? a.length + 2 + (a.match(/["\\]/g)?.length ?? 0) : a.length)
  return [file, ...args].reduce((n, a) => n + quoted(a) + 1, 0)
}

/**
 * A first task as the CLI's last argument. A .cmd/.bat Hive can't start directly runs through cmd.exe, which can't pass
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
 * Codex): behind a "--" of Hive's own, so an option that takes a list ("--allowedTools a b", Codex's "--image a.png")
 * ending the extra arguments can't read the task as another of its values (#523). Extra arguments never hold a bare
 * "--" of their own: Settings refuses one, and so does a launch (extraArgsProblem).
 */
export function taskArgs(executable: string, text: string): string[] {
  return ['--', promptArg(executable, text)]
}

/**
 * A shell command that forwards a hook's JSON (stdin) to Hive's hook server with curl (on PATH in Windows 10+, and in
 * Git Bash), for hooks a CLI can only run as commands. The Authorization header comes from the launch's auth file
 * (`-H @<file>`, in Hive's user data), so neither the command nor any file it is written to holds a token (#345). The
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
// Hive's skill copies in a project's .agents/skills (Codex, Copilot)
// ---------------------------------------------------------------------------

/** The folder, relative to an agent's working folder, where CLIs without a per-launch skills folder read Hive's copies. */
export const AGENTS_SKILLS = join('.agents', 'skills')

/** Where a launch's CLI reads Hive's copy of a skill in .agents/skills. */
export function agentsSkillCopyPath(cwd: string, skill: string): string {
  return join(cwd, AGENTS_SKILLS, `hive-${skill}`)
}

/** The hash in a Hive copy's marker ('' for one from before hashes), or null: not Hive's copy (or no folder). */
async function skillMarker(folder: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(join(folder, COPY_MARKER), 'utf8')) as { hash?: string }).hash ?? ''
  } catch {
    return null
  }
}

/**
 * A skill not delivered this time, for `problem`: what the CLI reads of it is Hive's copy from an earlier launch, if one
 * is there (its revision, and the problem says it kept it); a folder of the user's with its name is never Hive's delivery.
 */
async function keptCopy(dest: string, problem: string): Promise<SkillDelivery> {
  const kept = existsSync(dest) && (await skillMarker(dest)) !== null ? await contentHash(dest).catch(() => null) : null
  return { revision: kept, problem: kept ? `${problem}, so it kept its old copy` : problem } // i18n-ignore: the skills' launch record, which agents read (the Agent API's status): guidance.ts
}

/**
 * Copies the session's Hive skills into <cwd>/.agents/skills/hive-<name> (for CLIs with no per-launch skills folder:
 * Codex and Copilot, which share the copies), removes Hive's copies of skills it no longer gets, and keeps them out of
 * git. Hive's copies carry a marker file (with the source's hash): folders without one are the user's and are never
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
    // Hive made at an earlier launch, read without the lock: another launch may be changing it).
    log.warn(`Could not copy skills for ${cli}`, e)
    const out: Record<string, SkillDelivery> = {}
    for (const s of ctx.skills) out[s.name] = await keptCopy(agentsSkillCopyPath(ctx.cwd, s.name), 'the skills could not be copied') // i18n-ignore: the skills' launch record, which agents read (the Agent API's status): guidance.ts
    return out
  }
}

async function syncAgentsSkillsNow(ctx: LaunchContext, cli: string): Promise<Record<string, SkillDelivery>> {
  const dir = join(ctx.cwd, AGENTS_SKILLS)
  const out: Record<string, SkillDelivery> = {}
  const wanted = new Map(ctx.skills.map((s) => [`hive-${s.name}`, s]))
  if (!ctx.skills.length && !existsSync(dir)) return out
  await mkdir(dir, { recursive: true })
  // Under the same lock as the swaps: Hive's own leftovers only (dot-folders named for a swap).
  await cleanSwaps(dir)
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    // A copy Hive no longer gives that can't be removed now (a file in it open) goes at a later launch.
    if (f.startsWith('hive-') && !wanted.has(f) && (await skillMarker(join(dir, f))) !== null) await removePath(join(dir, f)).catch((e) => log.warn(`Could not remove ${userText(f)} for ${cli}; trying again next time`, e))
  }
  for (const [folder, s] of wanted) {
    // One skill's failure is its own: the others are still delivered, and each record says what the CLI reads.
    try {
      out[s.name] = await deliverSkill(s, join(dir, folder), folder, cli)
    } catch (e) {
      log.warn(`Could not copy skill ${userText(s.name)} for ${cli}`, e)
      out[s.name] = await keptCopy(join(dir, folder), 'it could not be copied') // i18n-ignore: the skills' launch record, which agents read (the Agent API's status): guidance.ts
    }
  }
  // Keeping the copies out of git: a failure here changes nothing about what was delivered.
  await excludeCopies(ctx.cwd).catch((e) => log.warn(`Could not add Hive's ${cli} skill copies to git's exclude file`, e))
  return out
}

/** One skill into its folder in .agents/skills (under syncAgentsSkills' lock): what the CLI reads of it afterwards. */
async function deliverSkill(s: LaunchContext['skills'][number], dest: string, folder: string, cli: string): Promise<SkillDelivery> {
  // One identity for the source, Hive's copies and their markers: contentHash, which counts links (never following
  // them) and leaves the marker out. A marker from before (another hash) just means one more copy.
  let hash: string
  try {
    hash = await contentHash(s.sourcePath)
  } catch (e) {
    // Not copied. Hive's copy from an earlier launch stays, and is what the CLI reads: its revision is what reached the
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
      log.warn(`Not copying skill ${userText(s.name)} for ${cli}: ${userText(dest)} is not Hive's copy.`)
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

/** Keeps Hive's copies (and a swap's dot-folders) out of git, in the repository's info/exclude. */
export async function excludeCopies(cwd: string): Promise<void> {
  const common = await git(cwd, ['rev-parse', '--git-common-dir'], undefined, undefined, { timeout: 5000 })
  const gitDir = common.ok ? common.out.trim() : ''
  if (!gitDir) return
  const exclude = join(isAbsolute(gitDir) ? gitDir : resolvePath(cwd, gitDir), 'info', 'exclude')
  const text = await readFile(exclude, 'utf8').catch(() => '')
  const lines = text.split(/\r?\n/)
  // Hive's copies, and the dot-folders a swap uses for a moment (left behind only by a crash, until the next launch).
  const missing = ['/.agents/skills/hive-*/', '/.agents/skills/.hive-*/'].filter((l) => !lines.includes(l))
  if (missing.length) {
    await mkdir(join(exclude, '..'), { recursive: true })
    await appendFile(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${lines.some((l) => l.startsWith("# Hive's copies of workspace skills")) ? '' : "# Hive's copies of workspace skills for Codex and Copilot (added by Hive)\n"}${missing.join('\n')}\n`)
  }
}

/**
 * The English text a provider's install info holds (its readiness, its notes), each with the same as data (#797):
 * Hive's own code and the Agent API (GET /v1/status, /v1/providers) read the English, and the window is sent it in the
 * language it shows (shownInstallInfo).
 */
const INSTALL_TEXT = new Map<string, TextPart>()

/** Text for a provider's install info: its English, remembered as data so the window can be shown it in its language. */
export function installText(t: TextPart): string {
  const english = englishText(t)
  INSTALL_TEXT.set(english, t)
  return english
}

/** A provider's install info as the window shows it: its readiness and notes in the language shown (#797). */
export function shownInstallInfo(info: AgentInstallInfo): AgentInstallInfo {
  const shown = (s: string): string => {
    const t = INSTALL_TEXT.get(s)
    return t === undefined ? s : shownText(t)
  }
  return {
    ...info,
    ...(info.updateRetry ? { updateRetry: { message: shown(info.updateRetry.message), label: shown(info.updateRetry.label) } } : {}),
    ...(info.readiness ? { readiness: info.readiness.map((r) => ({ ...r, message: shown(r.message), ...(r.action ? { action: { ...r.action, label: shown(r.action.label) } } : {}), ...(r.detail ? { detail: r.detail.map(shown) } : {}) })) } : {}),
    ...(info.notes ? { notes: info.notes.map(shown) } : {})
  }
}

const READINESS = {
  notInstalled: msg({ id: 'providers.readiness.notInstalled', defaultMessage: '{provider} is not installed.', description: "Agent Setup and Settings → Providers: Hive didn't find the coding agent's CLI. {provider} is its name (Claude Code)." }),
  signedOut: msg({ id: 'providers.readiness.signedOut', defaultMessage: '{provider} is not signed in.', description: "Agent Setup and Settings → Providers: the coding agent's CLI has no sign-in. {provider} is its name." }),
  update: msg({ id: 'providers.readiness.update', defaultMessage: '{provider} {version} is available.', description: 'Agent Setup and Settings → Providers: a newer version of the coding agent is out. {provider} is its name, {version} the version.' }),
  install: msg({ id: 'providers.action.install', defaultMessage: 'Install', description: "Agent Setup's button: installs the coding agent's CLI in a terminal." }),
  signIn: msg({ id: 'providers.action.signIn', defaultMessage: 'Sign in', description: "Agent Setup's button: signs the coding agent's CLI in, in a terminal." }),
  updateAction: msg({ id: 'providers.action.update', defaultMessage: 'Update', description: "Agent Setup's button: updates the coding agent's CLI in a terminal." })
}

/** The CLI isn't installed: install it from Agent Setup. */
export const notInstalledIssue = (provider: string): ReadinessIssue => ({ id: 'not-installed', level: 'error', message: installText({ m: READINESS.notInstalled, values: { provider } }), action: { label: installText(READINESS.install), task: 'install' } })

/** The CLI isn't signed in: sign in from Agent Setup, with what that does (`detail`). */
export const signedOutIssue = (provider: string, detail?: TextPart[]): ReadinessIssue => ({
  id: 'signed-out',
  level: 'error',
  message: installText({ m: READINESS.signedOut, values: { provider } }),
  action: { label: installText(READINESS.signIn), task: 'login' },
  ...(detail ? { detail: detail.map(installText) } : {})
})

/** A newer version is out: Update, or (`detail`) how to update it where Hive can't. */
export const updateIssue = (provider: string, version: string | null, detail?: TextPart[]): ReadinessIssue => ({
  id: 'update',
  level: 'info',
  message: installText({ m: READINESS.update, values: { provider, version: version ?? '' } }),
  ...(detail ? { detail: detail.map(installText) } : { action: { label: installText(READINESS.updateAction), task: 'update' } })
})

const EXPORT_SUBTITLE = msg({ id: 'providers.export.subtitle', defaultMessage: '{provider} session `{session}` · project {project}', description: "The Markdown export of a conversation (Sessions tab → Export): the line under its title. {provider} is the coding agent (Claude Code), {session} the session's id (`…` marks it: keep the marks), {project} the project." })
const USER_MEMORY = msg({ id: 'providers.memory.user', defaultMessage: 'User {file} (all projects)', description: "In the Memory view: the user's own instructions file, which every project's agents read. {file} is its name (CLAUDE.md)." })

/** The line under an exported conversation's title (#797). */
export const exportSubtitleText = (provider: string, session: string, project: string): string => tr(EXPORT_SUBTITLE, { provider, session, project })

/** The Memory view's label for the user's own instructions file, which every project's agents read. */
export const userMemoryLabel = (file: string): string => tr(USER_MEMORY, { file })
