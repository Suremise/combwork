import { join } from 'path'
import { execFile } from 'child_process'
import { stat } from 'original-fs/promises'
import type { McpServerDef } from '../../../shared/types'
import { MUSE_DESCRIPTOR, museModeFlags } from '../../../shared/providers/muse'
import { TOOLS_SERVER } from '../../../shared/assistantTools'
import { agentMsg, say } from '../../../shared/agentText'
import { findSecretWarnings } from '../../mcpSecrets'
import { taskArgs } from '../common'
import type { LaunchContext } from '../types'
import { isMuseSessionId } from './transcript'
import { DEFAULT_NAMES, type MuseNames } from './names'
import { EVENT_ROLES } from '../../../shared/providers/muse/names'

// A Muse launch's command line (HI-3202, checked against 1.4.20 offline): `muse [resume <id>] <options>
// --trust-workspace -c hooks=<json> -c mcpServers.<name>=<json>… -c context.foreign_personal_*=false [-- PROMPT]`. Every
// -c applies to this run only (its --help: "Set one setting for this run"), so nothing is written to Muse's config.

/** The file of a launch's guidance that its SessionStart hook prints (`type`): in its private folder, never the project. */
export const GUIDANCE_FILE = 'muse-guidance.md'
/** The whole guidance, when it is over Muse's start limit: the hook prints a pointer to it instead. */
export const GUIDANCE_FULL_FILE = 'muse-guidance-full.md'

const T = {
  pointer: agentMsg({
    id: 'muse.guidance.pointer',
    text: "Combwork's guidance for this session, this agent's instructions and the Workspace notes are too long for Muse's start context ({size} bytes; Muse keeps {max}). Read the whole file now, before anything else, and follow it as your instructions: {file}",
    note: 'What a Muse Code agent reads at its start in place of its guidance, when that is over Muse’s limit: a pointer to the file holding it. {size} and {max} are byte counts, {file} a path.'
  })
}

/** What a launch gives as its guidance: Combwork's (with its tools), the launch's instructions, the Workspace notes. */
export function launchGuidance(ctx: Pick<LaunchContext, 'guidance' | 'instructions' | 'notes' | 'mcpServers'>): string {
  const parts = [Object.hasOwn(ctx.mcpServers, TOOLS_SERVER) ? ctx.guidance : '', ctx.instructions ?? '', ctx.notes ?? ''].map((t) => t.trim()).filter(Boolean)
  return parts.length ? parts.join('\n\n') + '\n' : ''
}

/** A text's size as Muse's start limit counts it: UTF-8 bytes of the hook's whole output, newlines included. */
export const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/**
 * What the SessionStart hook prints (`printed`) and, when the guidance is over `max` bytes, the whole of it for its own
 * file (`full`): 1.4.20 keeps a hook's output of up to `max` bytes whole and none of a longer one (16,384 kept, 16,385
 * dropped: tests/fixtures/muse/guidance-limit-1.4.20.json), so a guidance that doesn't fit is never printed; a pointer
 * to the file is, which names the very file the launch
 * writes. A pointer that wouldn't fit either (a path absurdly long) leaves nothing printed: `tooLong`.
 */
export function startContext(guidance: string, max: number, fullPath: string): { printed: string; full: string | null; tooLong?: true } {
  if (utf8Bytes(guidance) <= max) return { printed: guidance, full: null }
  const pointer = say(T.pointer, { size: String(utf8Bytes(guidance)), max: String(max), file: fullPath }) + '\n'
  return utf8Bytes(pointer) <= max ? { printed: pointer, full: guidance } : { printed: '', full: guidance, tooLong: true }
}

/** A whole-value `${VAR}` reference (Muse resolves those, its --help: "Secrets only as whole-value ${VAR}"). */
const isRef = (v: unknown): boolean => typeof v === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v.trim())

/**
 * An MCP server as a Muse -c value (1.4.20 takes command/args/env or url/headers, refuses `type` and `required`: "unknown
 * key"), or why it can't be passed. 1.4.20 takes an env or header value only as one whole `${VAR}` naming a variable
 * that is set ("secret leaves need exactly one whole-value `${VAR}`", observed: a literal refuses the run), so each
 * literal goes into Muse's environment under a name of Combwork's (`vars`, prefix `${prefix}_<n>`), and the value names
 * it. A literal secret would then be in the environment of everything Muse runs, so such a server isn't passed (Codex's
 * rule); the user's own `${VAR}` reference is passed as it is, and only when that variable is set in `env` (else Muse
 * refuses the whole run). Combwork's own is `mode: "required"`, so a session never runs without its tools (`config`: the launch's
 * names for them, muse.names.configKeys).
 */
export function museServer(name: string, def: McpServerDef, prefix: string, env: Readonly<Record<string, string>>, config: MuseNames['config'] = DEFAULT_NAMES.config): { value: Record<string, unknown>; vars: Record<string, string> } | { skipped: 'secret' | 'mixed' | 'unset' | 'empty' } {
  if (findSecretWarnings(def).length) return { skipped: 'secret' }
  const vars: Record<string, string> = {}
  let problem: 'mixed' | 'unset' | null = null
  const leaves = (o: Record<string, string> | undefined): Record<string, string> | null => {
    const entries = Object.entries(o ?? {})
    if (!entries.length) return null
    const out: Record<string, string> = {}
    for (const [k, v] of entries) {
      const text = String(v)
      if (isRef(text)) {
        if (env[text.trim().slice(2, -1)] === undefined) problem ??= 'unset'
        out[k] = text.trim()
      } else if (text.includes('${')) problem ??= 'mixed'
      else {
        const variable = `${prefix}_${Object.keys(vars).length}`
        vars[variable] = text
        out[k] = `\${${variable}}`
      }
    }
    return out
  }
  const required = name === TOOLS_SERVER ? { [config.mode]: config.modeRequired } : {}
  if (typeof def.url === 'string' && def.url) {
    const headers = leaves(def.headers)
    if (problem) return { skipped: problem }
    return { value: { url: def.url, ...(headers ? { headers } : {}), ...required }, vars }
  }
  if (typeof def.command !== 'string' || !def.command) return { skipped: 'empty' }
  const envs = leaves(def.env)
  if (problem) return { skipped: problem }
  return { value: { command: def.command, ...(def.args?.length ? { args: def.args.map(String) } : {}), ...(envs ? { env: envs } : {}), ...required }, vars }
}

/** A server name Muse can take in a -c key (`mcpServers.<name>`): a dot or anything odd would read as another key. */
export const passableName = (name: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(name)

/** The prefix of the variables a launch's server values are in (museServer). */
export const SERVER_VARS = 'CW_MUSE_MCP'

/**
 * The servers a launch passes, by name (museServer's values), the variables their values are in (for Muse's environment),
 * and those it can't pass, with why. `env`: the launch's environment, where a `${VAR}` of the user's must be set.
 */
export function launchServers(given: Record<string, McpServerDef>, fromProject: ReadonlySet<string>, env: Readonly<Record<string, string>>, config: MuseNames['config'] = DEFAULT_NAMES.config): { pass: Record<string, Record<string, unknown>>; vars: Record<string, string>; skipped: Map<string, string> } {
  const pass: Record<string, Record<string, unknown>> = Object.create(null)
  const vars: Record<string, string> = {}
  const skipped = new Map<string, string>()
  let n = 0
  for (const [name, def] of Object.entries(given)) {
    // Defined identically by the project: Muse starts it from there, and refuses a -c of a project server's name.
    if (fromProject.has(name)) continue
    if (!passableName(name)) {
      skipped.set(name, 'name')
      continue
    }
    const s = museServer(name, def, `${SERVER_VARS}_${n++}`, env, config)
    if ('value' in s) {
      pass[name] = s.value
      Object.assign(vars, s.vars)
    } else skipped.set(name, s.skipped)
  }
  return { pass, vars, skipped }
}

/** The hook events Combwork asks Muse for, by their roles, in the order they're given (their names: muse.names.hookEvents). */
export const HOOK_EVENTS = EVENT_ROLES

/**
 * A path a hook command can name without quotes: Muse 1.4.20 runs a hook as `%COMSPEC% /C <command>` with each `"` in it
 * escaped as `\"` (Rust's argument escaping, which cmd doesn't undo: observed on the host, a quoted `type` failed and a
 * quoted URL reached curl as a bad one), and clears the hook's environment to Windows' own variables and Muse's ids
 * (observed), so neither a quote nor a variable of Combwork's can carry a path with a space. Such a path is given by its
 * 8.3 short name (`shortName`); null when it has none (8.3 names off on its volume) or still has a character cmd reads.
 */
export async function hookPath(path: string, shortName: (p: string) => Promise<string | null>): Promise<string | null> {
  if (CMD_SAFE.test(path)) return path
  const short = await shortName(path)
  return short && CMD_SAFE.test(short) ? short : null
}

/** What cmd reads as text in an unquoted word (no space, quote, %, !, ^, &, |, <, >, parentheses or ;,=). */
const CMD_SAFE = /^[A-Za-z0-9_.:\\/~#@+[\]{}$'-]+$/

/** The URL as one unquoted cmd word: its `&` and other operators escaped (cmd removes the carets). */
export const cmdUrl = (url: string): string => url.replace(/[\^&|<>()]/g, '^$&')

/**
 * A command that posts the hook's JSON (stdin) to Combwork's hook server with the launch's token from its auth file
 * (`-H @<file>`), with no quote anywhere (hookPath): hookForwardCommand's form, unquoted.
 */
export function museForwardCommand(hookUrl: string, authPath: string, seconds: number): string {
  return `curl.exe -s -m ${seconds} -X POST -H @${authPath.split('\\').join('/')} -H Content-Type:application/json --data-binary @- ${cmdUrl(hookUrl)}` // i18n-ignore: a hook command the CLI runs
}

/**
 * The hooks a launch gives Muse (`-c hooks=<json>`): each event forwards its JSON to Combwork's hook server (curl, the
 * launch's auth file: no token in the command or the environment); SessionStart first prints the launch's guidance
 * file. Muse runs a hook through %COMSPEC% /C, with its JSON on stdin and a cleared environment (1.4.20, observed). Paths
 * are hookPath's. Each event is keyed by the launch's name for it (`events`, muse.names.hookEvents), the name its hooks
 * then come back with.
 */
export function museHooks(hookUrl: string, authPath: string, guidancePath: string | null, seconds: number, events: MuseNames['events'] = DEFAULT_NAMES.events): Record<string, unknown> {
  const command = museForwardCommand(hookUrl, authPath, seconds)
  // Only PreToolUse's reply is Muse's to read (a lock's block). Any other's is discarded: Muse takes a hook's plain output
  // as context (SessionStart's, observed), and Combwork's reply to it is never meant for the model.
  const quiet = `${command} -o NUL`
  const out: Record<string, unknown> = Object.create(null)
  for (const role of HOOK_EVENTS) {
    const hooks: Record<string, unknown>[] = []
    // Its plain output is the session's start context (cmd's `type` prints the file's bytes as they are: UTF-8 kept).
    if (role === 'start' && guidancePath) hooks.push({ type: 'command', command: `type ${guidancePath}`, timeout: seconds }) // i18n-ignore: a hook command the CLI runs
    // 1.4.20 admits an Interrupt hook only as async ("synchronous cancellation hooks are not admitted", observed).
    hooks.push({ type: 'command', command: role === 'preTool' ? command : quiet, timeout: seconds, ...(role === 'interrupt' ? { async: true } : {}) })
    out[events[role]] = [{ hooks }]
  }
  return out
}

export interface MuseArgsInput {
  ctx: Pick<LaunchContext, 'executable' | 'resume' | 'sessionId' | 'model' | 'effort' | 'permissionMode' | 'extraArgs' | 'initialPrompt'>
  hooks: Record<string, unknown>
  servers: Record<string, Record<string, unknown>>
  keepPersonalOut: boolean
  /** The launch's names for the settings it gives (muse.names.configKeys); 1.4.20's when absent. */
  config?: MuseNames['config']
}

/** A launch's arguments (1.4.20's --help; `muse resume <id>` takes the root options after it). */
export function museArgs(i: MuseArgsInput): string[] {
  const { ctx } = i
  const args: string[] = []
  if (ctx.resume) {
    if (!isMuseSessionId(ctx.sessionId)) throw new Error(`not a Muse session id: ${ctx.sessionId}`) // i18n-ignore: an internal check, never shown
    args.push('resume', ctx.sessionId)
  }
  if (ctx.model) args.push('--model', ctx.model)
  if (ctx.effort) args.push('--reasoning-effort', ctx.effort)
  args.push(...museModeFlags(ctx.permissionMode || MUSE_DESCRIPTOR.defaultPermissionMode))
  // Combwork's tools start only in a trusted workspace (1.4.20 withholds every MCP server otherwise); for this run only.
  args.push('--trust-workspace')
  const config = i.config ?? DEFAULT_NAMES.config
  args.push('-c', `${config.hooks}=${JSON.stringify(i.hooks)}`)
  for (const [name, value] of Object.entries(i.servers)) args.push('-c', `${config.mcpServers}.${name}=${JSON.stringify(value)}`)
  if (i.keepPersonalOut) args.push('-c', `${config.foreignSkills}=false`, '-c', `${config.foreignRules}=false`)
  args.push(...ctx.extraArgs)
  // A new session's first task on its command line (after --, observed); a resume takes none (resumePromptTyped).
  if (ctx.initialPrompt && !ctx.resume) args.push(...taskArgs(ctx.executable, ctx.initialPrompt))
  return args
}

/** The guidance files' paths in a launch's private folder. */
export const guidancePaths = (privateDir: string): { start: string; full: string } => ({ start: join(privateDir, GUIDANCE_FILE), full: join(privateDir, GUIDANCE_FULL_FILE) })

/**
 * A path's 8.3 short name (Windows), read by cmd off main's thread, or null: none (8.3 names off), not Windows, or a
 * name that isn't that very file. Only for a path hookPath can't give as it is.
 */
export function windowsShortName(path: string): Promise<string | null> {
  if (process.platform !== 'win32' || /["%!]/.test(path)) return Promise.resolve(null)
  return new Promise((done) => {
    execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], { windowsVerbatimArguments: true, windowsHide: true, timeout: 5000 }, (e, out) => {
      const short = e ? '' : String(out).trim()
      if (!short || short === path) return done(null)
      stat(short)
        .then((s) => stat(path).then((p) => done(s.ino === p.ino && s.dev === p.dev ? short : null)))
        .catch(() => done(null))
    })
  })
}
