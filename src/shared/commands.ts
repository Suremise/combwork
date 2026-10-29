import type { CloseReason, CommandPoint, CommandRef, CommandsHive, CommandsWorkspace, CustomCommand } from './types'
import { msg } from './i18n'

// HI-1954: custom commands (JetBrains' External Tools), named once at Hive's level or a workspace's and picked for the
// points Hive runs them at: a workspace opening or closing, Hive quitting, or by hand. Design HI-1954/s15, s19, s21.
// Pure: main runs them (main/commands/), Settings edits them, both through these.

/** Why a list runs: its `{reason}`. */
export type CommandReason = CloseReason | 'open' | 'manual'

/** A point a list runs at. */
export type PointName = 'onOpen' | 'onClose' | 'onQuit'

/** The names HI-1368's single commands get as they become commands of the list (the user can rename them). */
export const MIGRATED_CLOSE = msg({ id: 'commands.migrated.close', defaultMessage: 'Close command', description: "The name Hive gives the command the user had in Settings → Workspace → When this workspace closes, run, as it becomes one of the workspace's named commands (HI-1954). The user can rename it." })
export const MIGRATED_QUIT = msg({ id: 'commands.migrated.quit', defaultMessage: 'Quit command', description: "The name Hive gives the command the user had in Settings → General → When Hive quits, run, as it becomes one of Hive's named commands (HI-1954). The user can rename it." })

/** How often a list's runner looks for a control while a failure waits (main/closeCommand/listRunner.ts). */
export const CONTROL_MS = 250
/** Hive touches a list's `observer` file this often while it watches its run. */
export const OBSERVE_MS = 5000
/** An `observer` older than this: nobody watches, and a failure waiting for a choice is settled as unattended. */
export const OBSERVER_STALE_MS = 30_000

export const MAX_NAME = 100
export const MAX_COMMAND = 4000
export const MAX_FOLDER = 1000
/** Commands kept per scope. */
export const MAX_COMMANDS = 100

const ID = /^c-[0-9a-f]{8}$/
export const isCommandId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

/** A new command's id (random). */
export function newCommandId(): string {
  const b = new Uint8Array(4)
  globalThis.crypto.getRandomValues(b)
  return `c-${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

/** A short hash of text (FNV-1a, 32 bits): ids made the same way each time, and versions. Not for secrets. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** The id of a command migrated from HI-1368's single one: the same each time, so a migration run again adds nothing. */
export const migratedId = (point: 'onClose' | 'onQuit', command: string): string => `c-${shortHash(`migrated:${point}:${command}`)}`

/** A command as saved: its fields cleaned and bounded, or null when it can't be one (no id, name or command). */
export function cleanCommand(v: unknown): CustomCommand | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  const name = typeof c.name === 'string' ? c.name.trim().slice(0, MAX_NAME) : ''
  const command = typeof c.command === 'string' ? c.command.trim().slice(0, MAX_COMMAND) : ''
  if (!isCommandId(c.id) || !name || !command) return null
  const folder = typeof c.folder === 'string' ? c.folder.trim().slice(0, MAX_FOLDER) : ''
  return { id: c.id, name, command, ...(folder ? { folder } : {}), ...(c.needed === true ? { needed: true } : {}) }
}

/** A list as saved: its commands cleaned, each id once, at most MAX_COMMANDS. */
export function cleanList(v: unknown): CustomCommand[] {
  const out: CustomCommand[] = []
  for (const x of Array.isArray(v) ? v : []) {
    const c = cleanCommand(x)
    if (c && !out.some((o) => o.id === c.id)) out.push(c)
  }
  return out.slice(0, MAX_COMMANDS)
}

/** A point as saved: its refs well formed, each once, those of a scope it may not use dropped. */
export function cleanPoint(v: unknown, scopes: readonly CommandRef['scope'][], update: boolean): CommandPoint {
  const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const run: CommandRef[] = []
  for (const r of Array.isArray(p.run) ? p.run : []) {
    const ref = r as Record<string, unknown>
    if (!scopes.includes(ref?.scope as CommandRef['scope']) || !isCommandId(ref?.id)) continue
    if (!run.some((x) => x.scope === ref.scope && x.id === ref.id)) run.push({ scope: ref.scope as CommandRef['scope'], id: ref.id as string })
  }
  return { run, ...(update && p.onUpdate === true ? { onUpdate: true } : {}) }
}

export const EMPTY_HIVE: CommandsHive = { list: [], onQuit: { run: [] } }
export const EMPTY_WORKSPACE: CommandsWorkspace = { list: [], onOpen: { run: [] }, onClose: { run: [] } }

/** Hive's commands as saved (settings.commands). */
export function cleanHive(v: unknown): CommandsHive {
  const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { list: cleanList(c.list), onQuit: cleanPoint(c.onQuit, ['hive'], true) }
}

/** A workspace's commands as saved (workspace.json's commands): its points may use its own and Hive's. */
export function cleanWorkspace(v: unknown): CommandsWorkspace {
  const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { list: cleanList(c.list), onOpen: cleanPoint(c.onOpen, ['workspace', 'hive'], false), onClose: cleanPoint(c.onClose, ['workspace', 'hive'], true) }
}

/** HI-1368's single command ({ command, onUpdate }), if it had one: its text as saved, and its box. */
function legacy(v: unknown): { command: string; onUpdate: boolean } | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  const command = typeof o?.command === 'string' ? o.command.trim() : ''
  return command ? { command: command.slice(0, MAX_COMMAND), onUpdate: o?.onUpdate === true } : null
}

/**
 * HI-1368's command for a point into a list (one way, at load; written with the next save, which drops the old field):
 * a command of its own, named, and the point running it, its box kept. Its id is the same each time, so running this
 * again (a save that didn't happen, or a file with both) adds nothing.
 */
function adopt<T extends { list: CustomCommand[] }>(into: T, point: CommandPoint, old: unknown, which: 'onClose' | 'onQuit', name: string, scope: CommandRef['scope']): { commands: T; point: CommandPoint } {
  const was = legacy(old)
  if (!was) return { commands: into, point }
  const id = migratedId(which, was.command)
  const list = into.list.some((c) => c.id === id) ? into.list : [...into.list, { id, name, command: was.command }]
  const run = point.run.some((r) => r.scope === scope && r.id === id) ? point.run : [...point.run, { scope, id }]
  return { commands: { ...into, list }, point: { run, ...(was.onUpdate || point.onUpdate ? { onUpdate: true } : {}) } }
}

/** A workspace's commands from what workspace.json holds, HI-1368's `onClose` adopted. `name`: the command's name for it. */
export function migrateWorkspaceCommands(raw: { commands?: unknown; onClose?: unknown }, name: string): CommandsWorkspace {
  const now = cleanWorkspace(raw.commands)
  const { commands, point } = adopt(now, now.onClose, raw.onClose, 'onClose', name, 'workspace')
  return { ...commands, onClose: point }
}

/** Hive's commands from what settings hold, HI-1368's `general.onQuit` adopted. */
export function migrateHiveCommands(raw: { commands?: unknown; onQuit?: unknown }, name: string): CommandsHive {
  const now = cleanHive(raw.commands)
  const { commands, point } = adopt(now, now.onQuit, raw.onQuit, 'onQuit', name, 'hive')
  return { ...commands, onQuit: point }
}

/** A point's commands in order, each found in its scope's list; a ref to one no longer there is null. */
export function resolvePoint(point: CommandPoint, lists: { hive: readonly CustomCommand[]; workspace?: readonly CustomCommand[] }): { ref: CommandRef; command: CustomCommand | null }[] {
  return point.run.map((ref) => ({ ref, command: (ref.scope === 'hive' ? lists.hive : (lists.workspace ?? [])).find((c) => c.id === ref.id) ?? null }))
}

/** A scope's version: a hash of its commands and points, for a change proposed against them (HI-1954/s21). */
export const commandsVersion = (c: CommandsHive | CommandsWorkspace): string => shortHash(JSON.stringify(c))

/** What a command's placeholders stand for. `projects`: each project's path by its name (lower-cased). */
export interface CommandValues {
  workspace?: string
  name?: string
  reason: CommandReason
  projects?: Record<string, string>
}

/**
 * A command (or folder) with `{workspace}`, `{name}`, `{reason}` and `{project:<name>}` filled in, as written: the user
 * quotes them where a path may hold spaces (HI-1368's contract). `missing`: the placeholders that couldn't be filled
 * (no workspace, no such project): the step then doesn't run (HI-1954/s19 §5). Any other `{…}` stays as it is.
 */
export function fillCommand(template: string, v: CommandValues): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = template.replace(/\{(workspace|name|reason)\}|\{project:([^{}]+)\}/g, (all, key: 'workspace' | 'name' | 'reason' | undefined, project: string | undefined) => {
    const value = key ? v[key] : v.projects?.[project!.trim().toLowerCase()]
    if (value === undefined || value === '') {
      missing.push(all)
      return all
    }
    return value
  })
  return { text, missing: [...new Set(missing)] }
}
