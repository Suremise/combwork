/**
 * Agents' temp folder (HI-2496): Settings → Advanced → Agents' temp folder, empty by default. When set, each agent and
 * the Assistant launch with TEMP, TMP and TMPDIR pointing at a folder of their own in it, `<root>\<host>\<agent>`, made at
 * launch and kept (resumed sessions read their scratchpads again): Hive never deletes in it. Empty, the launch's
 * environment is as before. Provider-specific variables (Claude Code's CLAUDE_CODE_TMPDIR) are their adapters'.
 *
 * It never points inside a project, a slot, review copies, the Assistant's home or a workspace's .hive, in any open
 * workspace: checked on the real paths (a junction in the way counts), before and after the folder is made. A folder that
 * can't be used stops the launch with the reason, rather than putting the files back in the system Temp.
 */
import { createHash } from 'crypto'
import { mkdir, realpath, stat } from 'original-fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { AGENT_TEMP_FOLDER_ID } from '../shared/advanced'
import { HIVE_DIR } from '../shared/defaults'
import { msg } from '../shared/i18n'
import { advanced } from './advanced'
import { hiveError } from './hiveError'
import type { WorkspaceService } from './workspace'

const M = {
  unset: msg({ id: 'session.start.tempUnset', defaultMessage: "Agents' temp folder, {folder}, starts with a variable that isn't set. Fix it in Settings → Advanced, or empty it to use the system's Temp folder.", description: "Starting an agent failed (HI-2496): the folder in Settings → Advanced → Agents' temp folder starts with a %VARIABLE% Windows doesn't have. {folder} is the folder as written." }),
  inside: msg({ id: 'session.start.tempInside', defaultMessage: "Agents' temp folder, {folder}, is inside {inside}, a project's or Combwork's own folder. Choose another in Settings → Advanced, or empty it to use the system's Temp folder.", description: "Starting an agent failed (HI-2496): the folder in Settings → Advanced → Agents' temp folder is inside a project, a slot or Combwork's own folders. {folder} is the agent's folder in it; {inside} the folder it is inside." }),
  notMade: msg({ id: 'session.start.tempNotMade', defaultMessage: "The agent's temp folder, {folder}, couldn't be made: {why} Fix Agents' temp folder in Settings → Advanced, or empty it to use the system's Temp folder.", description: "Starting an agent failed (HI-2496): its folder in Settings → Advanced → Agents' temp folder couldn't be created. {folder} is that folder; {why} the system's reason, in English." })
}

/** The variables a launch's temp folder is given in (Windows' two, and POSIX shells' such as Git Bash's). */
export const TEMP_VARS = ['TEMP', 'TMP', 'TMPDIR'] as const

/** The folder as set (the workspace's own over Hive's), or null: empty, the system Temp. */
export function agentTempSetting(ws: WorkspaceService | null): string | null {
  const own = ws ? advanced.get<string[]>(AGENT_TEMP_FOLDER_ID, ws.config?.advanced ?? null) : null
  const listed = Array.isArray(own) && own.length ? own : advanced.get<string[]>(AGENT_TEMP_FOLDER_ID, null)
  const first = Array.isArray(listed) ? listed.find((f) => typeof f === 'string' && f.trim()) : undefined
  return first ? first.trim() : null
}

/** The setting's folder with a %VARIABLE% at its start filled in from env (any case), as a full path; null when it can't be. */
export function expandRoot(value: string, env: NodeJS.ProcessEnv): string | null {
  const byName = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]))
  let missing = false
  const filled = value.replace(/^%([a-z_][a-z0-9_]*)%/i, (_all, name: string) => {
    const v = byName.get(name.toLowerCase())
    if (!v) missing = true
    return v ?? ''
  })
  if (missing || !/^(?:[a-zA-Z]:[\\/]|\\\\[^\\/])/.test(filled)) return null
  return resolve(filled)
}

/** A name as one folder of a path: no separators or characters Windows refuses, no trailing dot or space, not a device name. */
function folderName(s: string): string {
  const safe = s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 40) || '_'
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe) ? `_${safe}` : safe
}

/** A path's short, stable hash: the same folder in any case or spelling gives the same one. */
const pathHash = (p: string): string => createHash('sha256').update(resolve(p).toLowerCase()).digest('hex').slice(0, 8)

/**
 * An agent's own folder in the root: per host (a project by its name and its path's hash, so equal names in two
 * workspaces never share; the Assistant's home apart from any project) and per agent id (never its editable name).
 */
export function agentTempFolder(root: string, host: string, agentId: string, assistant: boolean): string {
  return join(root, `${assistant ? '_assistant' : folderName(basename(host))}-${pathHash(host)}`, folderName(agentId))
}

/** A path's real form: its deepest existing folder resolved (junctions and links), the rest as written. */
export async function realForm(p: string): Promise<string> {
  const abs = resolve(p)
  let at = abs
  for (;;) {
    const real = await realpath(at).catch(() => null)
    if (real) return join(real, relative(at, abs))
    const up = dirname(at)
    if (up === at) return abs
    at = up
  }
}

const inside = (p: string, root: string): boolean => {
  const rel = relative(root.toLowerCase(), p.toLowerCase())
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The protected folder p is in, as written and as real paths (each root's real path too), or null. */
async function protectedHit(p: string, protect: readonly string[]): Promise<string | null> {
  const real = await realForm(p)
  for (const r of protect) {
    if (inside(resolve(p), resolve(r)) || inside(real, resolve(r)) || inside(real, await realForm(r))) return r
  }
  return null
}

/** Every open workspace's projects (hidden ones too), slots and copies, Assistant home and .hive. */
export async function protectedFolders(workspaces: readonly WorkspaceService[]): Promise<string[]> {
  const all = await Promise.all(
    workspaces.map(async (w) => {
      if (!w.path) return []
      const projects = (await Promise.all([w.listProjectPaths().catch(() => [] as string[]), w.listProjectPaths({ hidden: true }).catch(() => [] as string[])])).flat()
      return [...projects, w.worktreesRoot, w.assistantHome, join(w.path, HIVE_DIR)]
    })
  )
  return all.flat()
}

export interface AgentTempLaunch {
  /** The setting's value, null or empty for none. */
  setting: string | null
  /** The session's host: its project, or the Assistant's home. */
  host: string
  agentId: string
  assistant: boolean
  /** Folders it must not be in: protectedFolders(), plus the launch's own host and working folder. */
  protect: readonly string[]
  env?: NodeJS.ProcessEnv
}

/** The launch's own temp folder, made; null when the setting is empty. Throws (translated) when it can't be used. */
export async function prepareAgentTemp(o: AgentTempLaunch): Promise<string | null> {
  if (!o.setting?.trim()) return null
  const root = expandRoot(o.setting.trim(), o.env ?? process.env)
  if (!root) throw hiveError(M.unset, { folder: o.setting }, { kind: 'conflict' })
  const dir = agentTempFolder(root, o.host, o.agentId, o.assistant)
  const before = await protectedHit(dir, o.protect)
  if (before) throw hiveError(M.inside, { folder: dir, inside: before }, { kind: 'conflict' })
  try {
    await mkdir(dir, { recursive: true })
    if (!(await stat(dir)).isDirectory()) throw new Error('not a folder') // i18n-ignore: the system's reason, in English
  } catch (e) {
    throw hiveError(M.notMade, { folder: dir, why: (e as Error).message }, { kind: 'conflict' })
  }
  // Made: where it really is now (a junction made meanwhile, or one inside the root) must still be outside them.
  const after = await protectedHit(dir, o.protect)
  if (after) throw hiveError(M.inside, { folder: dir, inside: after }, { kind: 'conflict' })
  return dir
}

/** env with the temp variables, any case, replaced by dir; env itself when dir is null (the empty default). */
export function withAgentTemp<T extends Record<string, string | undefined>>(env: T, dir: string | null): T {
  if (!dir) return env
  const names = new Set<string>(TEMP_VARS.map((n) => n.toLowerCase()))
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !names.has(k.toLowerCase()))) as T
  for (const n of TEMP_VARS) (out as Record<string, string>)[n] = dir
  return out
}
