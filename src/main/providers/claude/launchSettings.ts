import { isAbsolute, join } from 'path'
import { open, stat } from 'original-fs/promises'
import { SETTINGS_FILE_LIMIT, SETTINGS_READ_CHUNK, settingsArgValue } from './autoCompact'
import { msg } from '../../../shared/i18n/msg'
import { errorText, hiveError } from '../../combworkError'

/**
 * A `--settings` in the user's own arguments (#330). Claude Code reads only the last `--settings` it is given (checked
 * with 2.1.291 in a test home), so the user's would replace Hive's launch settings and with them every hook and the
 * status line. Instead Hive reads the user's settings, merges them into its own launch file and passes that alone.
 */

/**
 * Why a launch is refused (#842): thrown as HiveErrors, so the window reads them in its language and the Agent API (an
 * agent or the Assistant starting one) in English.
 */
const M = {
  noValue: msg({ id: 'providers.settings.noValue', defaultMessage: "The last --settings in Extra arguments has no value. Give it a settings file or inline JSON (--settings '''<file or JSON>'''), or remove it in Agent Settings or Settings → Claude Code.", description: 'Starting a Claude Code agent is refused: its extra arguments end with --settings and nothing after it. Keep --settings as it is, and the straight quotes around <file or JSON>: each three apostrophes show one (ICU); the words file or JSON may be translated; "Agent Settings" and "Settings → Claude Code" are where to change it, as Combwork shows them.' }),
  unreadable: msg({ id: 'providers.settings.unreadable', defaultMessage: "The settings file {file} (--settings in Extra arguments) can't be read: {why}. Fix it or remove it in Agent Settings or Settings → Claude Code.", description: "Starting a Claude Code agent is refused: the settings file in its extra arguments can't be read. {file} is its path; {why} is the reason (\"there is no such file\", \"it isn't a file\", or the system's own words). Keep --settings as it is." }),
  noFile: msg({ id: 'providers.settings.noFile', defaultMessage: 'there is no such file', description: "Why a settings file can't be read, after \"can't be read:\" in another message: it doesn't exist." }),
  notAFile: msg({ id: 'providers.settings.notAFile', defaultMessage: "it isn't a file", description: "Why a settings file can't be read, after \"can't be read:\" in another message: the path is a folder or a device." }),
  tooLarge: msg({ id: 'providers.settings.tooLarge', defaultMessage: "it's over Claude Code's 2 MiB limit for settings files", description: "Why a settings file can't be read, after \"can't be read:\" in another message: it is larger than Claude Code takes. Keep 2 MiB as it is." }),
  notJson: msg({ id: 'providers.settings.notJson', defaultMessage: "The settings file {file} (--settings in Extra arguments) isn't valid JSON ({why}). Fix it or remove it in Agent Settings or Settings → Claude Code.", description: "Starting a Claude Code agent is refused: its settings file isn't JSON. {file} is its path; {why} is the JSON parser's own words (English). Keep --settings and JSON as they are." }),
  notObject: msg({ id: 'providers.settings.notObject', defaultMessage: "{source, select, inline {The --settings in Extra arguments} other {The settings file {file} (--settings in Extra arguments)}} isn't a settings object ('{ … }'). Fix it or remove it in Agent Settings or Settings → Claude Code.", description: "Starting a Claude Code agent is refused: its settings aren't an object. {source} is inline (settings written in the argument itself) or file; {file} is the file's path as the user wrote it. Keep --settings and the setting names as they are; \"Agent Settings\" and \"Settings → Claude Code\" are where to change it, as Combwork shows them. Keep { … } as it is." }),
  hooksOff: msg({ id: 'providers.settings.hooksOff', defaultMessage: "{source, select, inline {The --settings in Extra arguments} other {The settings file {file} (--settings in Extra arguments)}} turns off all hooks (disableAllHooks). Combwork's hooks are how it knows what the agent is doing (its status, file locks, what it is told) and they carry its status line, so Combwork doesn't start an agent without them. Take disableAllHooks out of those settings, or remove the --settings from Extra arguments in Agent Settings or Settings → Claude Code.", description: "Starting a Claude Code agent is refused: its settings turn Claude Code's hooks off. {source} is inline (settings written in the argument itself) or file; {file} is the file's path as the user wrote it. Keep --settings, disableAllHooks and the setting names as they are; \"Agent Settings\" and \"Settings → Claude Code\" are where to change it, as Combwork shows them." }),
  notList: msg({ id: 'providers.settings.notList', defaultMessage: "{source, select, inline {The --settings in Extra arguments} other {The settings file {file} (--settings in Extra arguments)}} sets {key} to something other than a list, which stops Combwork's hooks reaching it. Make it a list ([ … ]) or remove it in Agent Settings or Settings → Claude Code.", description: "Starting a Claude Code agent is refused: a hook allowlist in its settings isn't a list. {key} is the setting's name. {source} is inline (settings written in the argument itself) or file; {file} is the file's path as the user wrote it. Keep --settings and the setting names as they are; \"Agent Settings\" and \"Settings → Claude Code\" are where to change it, as Combwork shows them. Keep [ … ] as it is." })
}

/** The user's arguments without any `--settings` (Hive's one launch settings file carries what it held). */
export function withoutSettingsArgs(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settings') i++
    else if (!args[i].startsWith('--settings=')) out.push(args[i])
  }
  return out
}

/**
 * The settings of the last `--settings` in the user's arguments: inline JSON or a file (relative to the session's folder),
 * as an object; null without one. Throws, saying which argument, when Claude Code would have refused it too (no value,
 * #361; a missing file: "Settings file not found"), when it isn't a settings object, or when it would turn Hive's hooks off in a way a
 * merge can't undo (disableAllHooks, an HTTP hook allowlist that isn't a list), rather than launching without what it
 * asked for or without Hive's hooks.
 */
export async function userSettings(args: readonly string[], cwd: string): Promise<Record<string, unknown> | null> {
  const v = settingsArgValue(args)
  if (v === null) return null
  // `--settings` at the end, `--settings=` or an empty value: a mistake to fix, not "no settings" (#361).
  if (!v) throw hiveError(M.noValue)
  // Claude Code takes a value that parses as JSON as inline settings, and anything else as a file's path.
  let json: unknown
  let inline = false
  if (v.startsWith('{')) {
    try {
      json = JSON.parse(v)
      inline = true
    } catch {
      // not JSON: a file's name, as Claude Code reads it
    }
  }
  const what = { source: inline ? 'inline' : 'file', file: v }
  if (!inline) {
    const file = isAbsolute(v) ? v : join(cwd, v)
    let text: string
    try {
      text = await readSettingsFile(file)
    } catch (e) {
      throw hiveError(M.unreadable, { file: v, why: (e as NodeJS.ErrnoException).code === 'ENOENT' ? M.noFile : errorText(e) }, { cause: e })
    }
    try {
      json = JSON.parse(text.replace(/^﻿/, ''))
    } catch (e) {
      throw hiveError(M.notJson, { file: v, why: (e as Error).message }, { cause: e })
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw hiveError(M.notObject, what)
  // It would turn off Hive's hooks and status line with the user's (Claude Code 2.1.292): Hive can't keep both. Refused,
  // not launched without them (#1285, Darren's decision: no hooks-free mode): the hooks are how Hive knows the agent.
  if ((json as Record<string, unknown>).disableAllHooks === true) throw hiveError(M.hooksOff, what)
  // A list's entries are added to (mergeLaunchSettings); anything else in its place blocks Hive's hooks (2.1.292).
  for (const key of HOOK_ALLOWLISTS) {
    if (key in json && !Array.isArray((json as Record<string, unknown>)[key])) throw hiveError(M.notList, { ...what, key })
  }
  return json as Record<string, unknown>
}

/**
 * A `--settings` file's text, as Claude Code would take it (2.1.292): a regular file of at most 2 MiB, which it refuses
 * otherwise ("Settings file exceeds the 2MiB limit", "Cannot use settings file (EISDIR…)"). Checked before it is opened,
 * so a device name, a pipe or a huge file never holds up the launch (#333); then the opened file is checked again and
 * read to its end, a chunk at a time and never past a byte over the limit, since it may have changed since the stat.
 */
async function readSettingsFile(file: string): Promise<string> {
  const st = await stat(file)
  if (!st.isFile()) throw hiveError(M.notAFile)
  const over = (): Error => hiveError(M.tooLarge)
  if (st.size > SETTINGS_FILE_LIMIT) throw over()
  const fh = await open(file, 'r')
  try {
    if (!(await fh.stat()).isFile()) throw hiveError(M.notAFile)
    const chunks: Buffer[] = []
    let n = 0
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(SETTINGS_READ_CHUNK, SETTINGS_FILE_LIMIT + 1 - n))
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      chunks.push(chunk.subarray(0, bytesRead))
      n += bytesRead
      if (n > SETTINGS_FILE_LIMIT) throw over()
    }
    return Buffer.concat(chunks, n).toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Allowlists for HTTP hooks, which Claude Code takes whole from the highest settings file that sets one. */
const HOOK_ALLOWLISTS = ['allowedHttpHookUrls', 'httpHookAllowedEnvVars'] as const

/** What Hive's own hooks need from the settings: the URL its HTTP hooks post to and the variable their header reads. */
export interface HiveHookNeeds {
  url: string
  envVar: string
}

/**
 * Hive's launch settings with the user's merged in: every setting of theirs, and their hooks added to Hive's for each
 * event (Hive's first). Hive's status line wins, since a session has one and Hive's reports its context, cost and
 * limits. Their allowlists for HTTP hooks gain what Hive's hooks need, since Claude Code takes such a list whole from
 * the highest file that sets one, and without it blocks Hive's hooks (`allowedHttpHookUrls`) or sends them without
 * the token (`httpHookAllowedEnvVars`); checked with 2.1.292. Managed settings, above this file, still apply.
 */
export function mergeLaunchSettings(hive: { hooks: Record<string, unknown[]>; statusLine: unknown }, user: Record<string, unknown> | null, needs: HiveHookNeeds): Record<string, unknown> {
  if (!user) return { ...hive }
  const theirs = user.hooks && typeof user.hooks === 'object' && !Array.isArray(user.hooks) ? (user.hooks as Record<string, unknown>) : {}
  const hooks: Record<string, unknown[]> = { ...hive.hooks }
  for (const [ev, groups] of Object.entries(theirs)) {
    if (Array.isArray(groups)) hooks[ev] = [...(hooks[ev] ?? []), ...groups]
  }
  const out: Record<string, unknown> = { ...user, hooks, statusLine: hive.statusLine }
  const allowing = (key: (typeof HOOK_ALLOWLISTS)[number], entry: string): void => {
    const list = user[key]
    if (Array.isArray(list) && !list.includes(entry)) out[key] = [...list, entry]
  }
  allowing('allowedHttpHookUrls', needs.url)
  allowing('httpHookAllowedEnvVars', needs.envVar)
  return out
}

/** A status line Claude Code runs: its command, and its padding when it sets one. */
export interface StatusLine {
  type: 'command'
  command: string
  padding?: number
}

/**
 * The user's own status line, as Claude Code would take it without Hive's (#1285, #966 row 12): the first settings
 * scope, highest first (managed, the user's --settings, the project's local and shared files, theirs), that sets a
 * command one. Null when none does.
 */
export function ownStatusLine(scopes: readonly { json: unknown }[]): StatusLine | null {
  for (const s of scopes) {
    const line = s.json && typeof s.json === 'object' ? (s.json as Record<string, any>).statusLine : undefined
    if (!line || typeof line !== 'object') continue
    if (line.type !== 'command' || typeof line.command !== 'string' || !line.command.trim()) continue
    return { type: 'command', command: line.command, ...(typeof line.padding === 'number' ? { padding: line.padding } : {}) }
  }
  return null
}

/**
 * Hive's status line (#1285): its forwarding command (`forward`, posting Claude Code's status JSON to Hive), alone and
 * showing nothing, or with the user's own after it. Then Hive's server echoes the JSON back (the URL's `echo`), which
 * goes on the user's command's input as Claude Code would give it, and the user's command's output is the status line.
 * The user's command is grouped in a subshell, on lines of its own, so all of it reads that input and nothing of it (a
 * comment at its end, several lines) can reach past the group: Claude Code runs status lines with bash (Git Bash on
 * Windows), where that holds for any command that runs alone.
 */
export function hiveStatusLine(forward: (echo: boolean) => string, own: StatusLine | null): StatusLine {
  if (!own) return { type: 'command', command: forward(false), padding: 0 }
  return { ...own, command: `${forward(true)} | (\n${own.command}\n)` }
}
