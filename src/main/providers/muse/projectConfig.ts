import { dirname, join, resolve } from 'path'
import { existsSync } from 'original-fs'
import { readFile } from 'original-fs/promises'

// What a trusted Muse workspace would load of the project's own (HI-3202, checked against 1.4.20): Combwork's tools need
// --trust-workspace (without it Muse withholds every MCP server, Combwork's included), and trust also starts the
// project's .mcp.json servers and loads its .muse hooks, which no setting turns off (a -c for a project server's name is
// refused: "the server name is reserved"). So these files are read before each launch, from the folder the agent runs in
// and each parent up to the repository root (Muse's project root; nested roots in between count too), and a launch they
// would add anything to is refused (adapter.ts). A file that can't be read or understood refuses the launch: never read
// as empty. Nothing in them is ever run to find out what it is.

/** A config Muse would read that Combwork couldn't: the launch is refused (fail closed), never read as empty. */
export class UnreadableConfig extends Error {
  constructor(
    readonly file: string,
    readonly why: string
  ) {
    super(`${file}: ${why}`)
  }
}

/** The folders scanned for a launch's folder: it and each parent up to the repository root (the folder with .git). */
export function scannedFolders(folder: string): string[] {
  const out: string[] = []
  let d = resolve(folder)
  for (;;) {
    out.push(d)
    if (existsSync(join(d, '.git'))) break
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return out
}

/** A file's JSON object, or null when it is absent or empty. */
async function objectIn(file: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(file)) return null
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    throw new UnreadableConfig(file, e instanceof Error ? e.message : String(e))
  }
  if (!text.trim()) return null
  let j: unknown
  try {
    j = JSON.parse(text.replace(/^﻿/, ''))
  } catch (e) {
    throw new UnreadableConfig(file, e instanceof Error ? e.message : String(e))
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new UnreadableConfig(file, 'not a JSON object') // i18n-ignore: a parse diagnostic, shown inside the window's own message like an error's own words
  return j as Record<string, unknown>
}

/** An object field's entries, none when absent; anything but an object can't be understood. */
function entriesOf(file: string, o: Record<string, unknown>, key: string): [string, unknown][] {
  const v = o[key]
  if (v === undefined || v === null) return []
  if (typeof v !== 'object' || Array.isArray(v)) throw new UnreadableConfig(file, `${key} is not an object`) // i18n-ignore: a parse diagnostic, shown inside the window's own message like an error's own words
  return Object.entries(v as Record<string, unknown>)
}

/** Whether a hooks object defines any hook: an event with at least one entry. */
function definesHooks(file: string, hooks: [string, unknown][]): boolean {
  for (const [, list] of hooks) {
    if (list === null || list === undefined) continue
    if (!Array.isArray(list)) throw new UnreadableConfig(file, 'a hook event is not a list') // i18n-ignore: a parse diagnostic, shown inside the window's own message like an error's own words
    if (list.length) return true
  }
  return false
}

/** A project MCP server Muse would start: the file it comes from, and its definition as written. */
export type ProjectServer = { file: string; def: unknown }

/** What a trusted launch in this folder would load of the project's own: its MCP servers by name, and the files with hooks. */
export interface ProjectConfig {
  servers: Map<string, ProjectServer[]>
  hookFiles: string[]
}

/**
 * The project's own MCP servers and hooks a trusted Muse launch in `folder` would load (scannedFolders): .mcp.json's
 * `mcpServers`, .muse\settings.json's `mcpServers` and `hooks`, and .muse\hooks.json (its `hooks`, or the whole file as
 * the events). Every definition of a name counts. An unreadable or invalid file throws UnreadableConfig.
 */
export async function projectConfig(folder: string): Promise<ProjectConfig> {
  const servers = new Map<string, ProjectServer[]>()
  const hookFiles: string[] = []
  const add = (file: string, list: [string, unknown][]): void => {
    for (const [n, def] of list) servers.set(n, [...(servers.get(n) ?? []), { file, def }])
  }
  for (const d of scannedFolders(folder)) {
    const mcp = join(d, '.mcp.json')
    const m = await objectIn(mcp)
    if (m) add(mcp, entriesOf(mcp, m, 'mcpServers'))
    const settings = join(d, '.muse', 'settings.json')
    const s = await objectIn(settings)
    if (s) {
      add(settings, entriesOf(settings, s, 'mcpServers'))
      if (definesHooks(settings, entriesOf(settings, s, 'hooks'))) hookFiles.push(settings)
    }
    const hooksFile = join(d, '.muse', 'hooks.json')
    const h = await objectIn(hooksFile)
    if (h && definesHooks(hooksFile, 'hooks' in h ? entriesOf(hooksFile, h, 'hooks') : Object.entries(h))) hookFiles.push(hooksFile)
  }
  return { servers, hookFiles }
}

/**
 * A server definition in a canonical form, every field kept, keys sorted; an empty `args`, `env` or `headers` is the same
 * as none. Null for what runs nothing (no command, no URL), which is never the same server as anything.
 */
function canonicalServer(d: unknown): string | null {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted)
    if (v && typeof v === 'object') return Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])
    return v
  }
  const empty = (k: string, v: unknown): boolean => ['args', 'env', 'headers'].includes(k) && ((Array.isArray(v) && !v.length) || (!!v && typeof v === 'object' && !Object.keys(v).length))
  const o = d as Record<string, unknown>
  if (!(typeof o.command === 'string' && o.command) && !(typeof o.url === 'string' && o.url)) return null
  return JSON.stringify(
    Object.keys(o)
      .sort()
      .filter((k) => !empty(k, o[k]))
      .map((k) => [k, sorted(o[k])])
  )
}

/** Whether two MCP server definitions are the same server: equal in every field, so neither runs other code or reaches elsewhere. */
export function sameServer(a: unknown, b: unknown): boolean {
  const x = canonicalServer(a)
  return x !== null && x === canonicalServer(b)
}

/** How a launch stands with the project's own config: the servers it would add (by name, with a file each) and the hook files. */
export interface ProjectVerdict {
  /** Project servers the agent wasn't given, or given otherwise: name → the file defining it. */
  refused: Map<string, string>
  /** Files with hooks the agent wasn't given. */
  hookFiles: string[]
  /** Given servers the project defines identically: Muse loads them from the project, so they aren't passed again. */
  fromProject: Set<string>
}

/**
 * The launch's servers (as it would pass them, `given`) against the project's (`project`): a project server counts as
 * the agent's only when every definition of its name is the very same server as the one given under it.
 */
export function judgeProject(given: Record<string, unknown>, project: ProjectConfig): ProjectVerdict {
  const refused = new Map<string, string>()
  const fromProject = new Set<string>()
  for (const [name, defs] of project.servers) {
    const mine = Object.hasOwn(given, name) ? given[name] : undefined
    const bad = mine === undefined ? defs[0] : defs.find((p) => !sameServer(mine, p.def))
    if (bad) refused.set(name, bad.file)
    else fromProject.add(name)
  }
  return { refused, hookFiles: project.hookFiles, fromProject }
}
