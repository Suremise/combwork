import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { addProjectKeys, boardOpen, boardReadOnly, boardWrite, boardChanged, cardKeyOf, cardNamed, hasCard, keysNoticeDue, keysNoticeSaid, projectKeys, setProjectKey } from './boardStore'
import { fmt, msg, tr } from '../shared/i18n'
import { projectNow } from '../shared/projectIds'
import { keyProblem, KEY_FORM, nameWithKey, normalKey, setCardNaming, suggestKey, type CardNames, type KeyHeld } from '../shared/projectKeys'
import type { WorkspaceInfo } from '../shared/types'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import { contextWorkspace, workspaceFor, type WorkspaceService } from './workspace'

const log = createLogger('keys')

/**
 * Project keys (#1219, #704; SPEC §16.12): each project of a workspace has one, given when the workspace opens (suggested
 * from its folder name; the upgrade to 1.0 gives the projects with cards theirs), changed by the user, its old keys kept
 * as aliases. The rules are shared/projectKeys.ts's, the rows boardStore's (schema/keysStep.ts).
 */

const folderOf = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

/**
 * Whether a keyed card is in `scope`'s project (null: every card is), by the project it is in now: the one with its id,
 * renamed or moved since it was saved, as the board's readers show it (#1219 round 2, finding 2), never by the folder
 * name it was saved with, which another project may have now.
 */
const inScope = (ws: WorkspaceService, of: { project: string; projectId: string | null }, scope: string | null): boolean =>
  scope === null || projectNow(ws.projectIdsNow(), of.project, of.projectId).toLowerCase() === scope.toLowerCase()

// ---------------------------------------------------------------------------
// Card names in what agents read (#1219; HI-1661, Darren 26 Oct: by key only, "HI-1230").
// ---------------------------------------------------------------------------

/** The names in force for the work running now: an Agent API request's, a wake's or a delivery's (withCardNames). */
const naming = new AsyncLocalStorage<CardNames>()
// Outside them, the work's own workspace (the window's IPC calls, background work run in it) names its cards by key too
// (HI-1661): every card in it, as the window sees them.
setCardNaming(() => {
  const named = naming.getStore()
  if (named) return named
  const ws = contextWorkspace()
  return ws?.path ? cardNamesOf(ws) : null
})

/**
 * A workspace's card names, looked up as they are asked for (a key found is kept; one not found yet is looked up again,
 * so a card made meanwhile has its key): `#N` once the workspace's database is closed (never opened again for a name),
 * or the window has another workspace.
 */
export function cardNamesOf(ws: WorkspaceService, scope: string | null = null): CardNames {
  const path = ws.path
  const found = new Map<number, string>()
  return (n) => {
    const known = found.get(n)
    if (known) return nameWithKey(n, known)
    if (!path || ws.path !== path || !boardOpen(path)) return `#${n}`
    try {
      const k = cardKeyOf(ws, n)
      // Another project's card, for an agent confined to its own (#1219 round 1, finding 4): its number only, as before.
      const key = k && inScope(ws, k, scope) ? k.key : undefined
      if (key) found.set(n, key)
      return nameWithKey(n, key)
    } catch {
      return `#${n}`
    }
  }
}

/**
 * Runs `fn` (and what it awaits) with the workspace's card names in the texts it makes for agents; none: as before.
 * `scope`: a project agent's project, whose cards alone are named by key (another's by number, as it sees them).
 */
export function withCardNames<T>(ws: WorkspaceService | null | undefined, fn: () => T, scope: string | null = null): T {
  return ws?.path ? naming.run(cardNamesOf(ws, scope), fn) : fn()
}

/** The scope a session host's texts name cards in: its project's folder name, or every card for the Assistant's home. */
export function scopeOfHost(host: string): string | null {
  const ws = workspaceFor(host)
  return ws?.isAssistantHome(host) ? null : folderOf(host)
}

/** Whether the work started in a workspace is still its (the window has it open, the same folder). */
const stillIn = (ws: WorkspaceService, path: string, life: AbortSignal): boolean => !life.aborted && ws.path === path

/**
 * Gives each project of the workspace that has no key one, suggested from its folder name (in name order, so two new
 * ones choose the same way each time), in one board change. Run each time the workspace opens and when its projects are
 * read again; changes nothing once each has one. Returns the keys given.
 */
export async function keyProjects(ws: WorkspaceService): Promise<string[]> {
  // Its folder and lifetime before anything waits (#1219 round 1, finding 1): a window that opens another workspace, or
  // closes this one, meanwhile gets nothing written, in either.
  const path = ws.path
  const life = ws.lifetime
  // A board waiting for its upgrade to 1.0 takes no writes: its projects get their keys once it is upgraded (#1621).
  if (!path || boardReadOnly(ws)) return []
  const ids = await ws.projectIds()
  if (!stillIn(ws, path, life)) return []
  const projects = [...ids.byId].map(([id, p]) => ({ id, name: folderOf(p), path: resolve(p).toLowerCase() })).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  if (!projects.length) return []
  const held = new Set(projectKeys(ws).filter((k) => k.current).map((k) => k.projectId))
  if (projects.every((p) => held.has(p.id))) return []
  return boardWrite(ws, async () => {
    if (!stillIn(ws, path, life)) return []
    // A project made in the New Project dialog takes the key chosen there (#1221), reserved for it until then; the
    // others a suggestion, never a key reserved for a project being made.
    const pick = (p: (typeof projects)[number], keys: { key: string; projectId: string }[]): string => {
      const chosen = wanted.get(path.toLowerCase())?.get(p.path)
      return chosen && !keyProblem(chosen, p.id, keys) ? chosen : suggestKey(p.name, p.id, [...keys, ...reserved(path, p.path)])
    }
    const added = addProjectKeys(ws, projects.map((p) => ({ id: p.id, pick: (keys) => pick(p, keys) })))
    if (added.length) {
      log.info(`${added.length} project(s) given a key: ${added.join(', ')}`)
      boardChanged(ws)
    }
    return added
  })
}

/**
 * The keys chosen for projects being made (the New Project dialog, #1221), by workspace folder, then project folder
 * (lower case): reserved from the check before the folder is made until the project has it, so a key change or another
 * new project in that workspace meanwhile is refused it (#1221 round 1, finding 2). Keys are a workspace's own: a
 * reservation never reaches another workspace (round 2, finding 1).
 */
const wanted = new Map<string, Map<string, string>>()

/** The keys reserved for projects being made in the workspace at `wsPath`, as keys held (but `except`'s own). */
const reserved = (wsPath: string, except: string | null = null): KeyHeld[] => [...(wanted.get(wsPath.toLowerCase()) ?? [])].filter(([p]) => p !== except).map(([p, key]) => ({ key, projectId: `new:${p}` }))

/**
 * Makes a project folder (the New Project dialog) with the key chosen for it: refused, saying why, before the folder
 * is made when the key can't be one (as a key change is); none given, it gets the suggestion, as a folder opened does.
 */
export async function createProjectWithKey(ws: WorkspaceService, name: string, key?: string | null): Promise<WorkspaceInfo> {
  const k = key ? normalKey(String(key)) : null
  const wsPath = ws.path?.toLowerCase() ?? null
  const path = ws.path ? resolve(ws.path, String(name ?? '').trim()).toLowerCase() : null
  // Checked and reserved at once, with nothing awaited between: from here no one else in this workspace can take it.
  if (k && wsPath) refuseKey(k, '', [...projectKeys(ws), ...reserved(wsPath, path)])
  const mine = wsPath ? (wanted.get(wsPath) ?? new Map<string, string>()) : null
  if (k && path && wsPath && mine) wanted.set(wsPath, mine.set(path, k))
  try {
    const info = await ws.createProject(name)
    // Its id read now, so it has its key before this returns (the chosen one is only known meanwhile).
    const ids = await ws.projectIds({ fresh: true })
    await keyProjects(ws)
    // Never another key in its place without saying so (another Hive on the same workspace could have taken it).
    const id = path ? ids.byPath.get(path) : undefined
    const now = id ? projectKeys(ws).find((h) => h.projectId === id && h.current)?.key : undefined
    if (k && now && now !== k) throw hiveError(PROBLEM.taken, { key: k }, { kind: 'conflict' })
    return info
  } finally {
    if (path && wsPath && mine?.get(path) === k) {
      mine.delete(path)
      if (!mine.size) wanted.delete(wsPath)
    }
  }
}

/** Why a key can't be a project's, in the window's language (Project Settings). */
const PROBLEM = {
  form: msg({ id: 'service.keys.form', defaultMessage: 'A project key is 2 to 4 letters, A to Z.', description: "An error changing a project's key (Project Settings): the key typed isn't 2–4 letters A–Z." }),
  taken: msg({ id: 'service.keys.taken', defaultMessage: '{key} is another project’s key, or was: a key stays with its project for good.', description: "An error changing a project's key: {key} (letters such as AM) belongs to another project now or did before (its old keys stay its aliases)." }),
  prefix: msg({ id: 'service.keys.prefix', defaultMessage: '{key} and another project’s key {other} begin alike: no key can be the start of another.', description: "An error changing a project's key: {key} and another project's key {other} (both letters such as AM and AMB) would be one the start of the other, which isn't allowed." }),
  closed: msg({ id: 'service.keys.closed', defaultMessage: 'The workspace was closed, or the window opened another, before the key was changed: nothing changed.', description: "An error changing a project's key: its workspace closed (or the window switched to another workspace) while the change waited; nothing was changed." }),
  unknownProject: msg({ id: 'service.keys.unknownProject', defaultMessage: 'That project has no id yet, so it can’t have a key: open it in Hive first.', description: "An error changing a project's key: the project hasn't been given Hive's id (it hasn't been opened yet)." })
}

/** Refuses a key the project `id` can't take, saying why. */
function refuseKey(k: string, id: string, held: KeyHeld[]): void {
  const problem = keyProblem(k, id, held)
  if (problem === 'form') throw hiveError(PROBLEM.form, undefined, { kind: 'invalid' })
  if (problem === 'taken') throw hiveError(PROBLEM.taken, { key: k }, { kind: 'conflict' })
  if (problem === 'prefix') {
    const other = held.find((h) => h.projectId !== id && (normalKey(h.key).startsWith(k) || k.startsWith(normalKey(h.key))))!.key
    throw hiveError(PROBLEM.prefix, { key: k, other: normalKey(other) }, { kind: 'conflict' })
  }
}

/**
 * Makes `key` the project's key (Project Settings), its key before kept as an alias: refused, saying why, when it isn't
 * 2–4 letters or another project has it, or had it, or one begins the other. A key it had before is its key again.
 */
export async function changeProjectKey(ws: WorkspaceService, projectPath: string, key: string): Promise<string> {
  const path = ws.path
  const life = ws.lifetime
  const ids = await ws.projectIds({ fresh: true })
  if (!path || !stillIn(ws, path, life)) throw hiveError(PROBLEM.closed, undefined, { kind: 'conflict' })
  const id = ids.byPath.get(resolve(projectPath).toLowerCase())
  if (!id) throw hiveError(PROBLEM.unknownProject, undefined, { kind: 'invalid' })
  const k = normalKey(String(key ?? ''))
  return boardWrite(ws, async () => {
    if (!stillIn(ws, path, life)) throw hiveError(PROBLEM.closed, undefined, { kind: 'conflict' })
    const held = projectKeys(ws)
    refuseKey(k, id, [...held, ...reserved(path)])
    if (held.some((h) => h.projectId === id && h.current && normalKey(h.key) === k)) return k
    setProjectKey(ws, id, k)
    log.info(`${userText(folderOf(projectPath))}'s key is now ${k}`)
    boardChanged(ws)
    return k
  })
}

/** Each project's key and its old keys, as the board's search reads them (#1221: `AM-`, an old key). */
export function keysForSearch(ws: WorkspaceService): { key: string; aliases: string[] }[] {
  const held = projectKeys(ws)
  return held.filter((k) => k.current).map((k) => ({ key: k.key, aliases: held.filter((x) => x.projectId === k.projectId && !x.current).map((x) => x.key) }))
}

/** A project's key, current (null before it has one). */
export async function projectKeyOf(ws: WorkspaceService, projectPath: string): Promise<string | null> {
  const id = (await ws.projectIds()).byPath.get(resolve(projectPath).toLowerCase())
  return (id && projectKeys(ws).find((k) => k.projectId === id && k.current)?.key) || null
}

/**
 * Says once, quietly, that the projects have keys now (after the upgrade to 1.0 gave them): "Projects have keys now: HI,
 * AM… Change them in Project Settings." In the workspace's window.
 */
export function sayKeysOnce(ws: WorkspaceService): void {
  const path = ws.path
  const life = ws.lifetime
  if (!path || !keysNoticeDue(ws)) return
  const keys = projectKeys(ws).filter((k) => k.current).map((k) => k.key).sort()
  const title = tr(msg({ id: 'service.keys.noticeTitle', defaultMessage: 'Projects have keys now', description: "A quiet notice's title, once after the upgrade to Hive 1.0: each project now has a short key (letters such as HI or AM) its cards are named by (HI-12)." }))
  const message = tr(msg({ id: 'service.keys.notice', defaultMessage: 'Cards are named by their project’s key: {keys}. Change a key in Project Settings; the old one keeps working.', description: "A quiet notice once after the upgrade to Hive 1.0. {keys}: the projects' keys, joined (HI, AM and WE)." }), { keys: fmt.list(keys) })
  ws.emit({ type: 'toast', toast: { id: randomUUID(), level: 'info', title, message, timestamp: new Date().toISOString(), quiet: true } })
  void boardWrite(ws, async () => {
    if (stillIn(ws, path, life)) keysNoticeSaid(ws)
  }).catch((e) => log.warn('noting the keys notice as said', e))
}

/**
 * The card a reference names, for the Agent API and the hive tools (#1219; Darren, 20 Oct: tools take a key string too):
 * a key (`HI-12`, any case, an old key too), an old number as `#1061`, or the number the tools take (`1061`, the old global
 * number until P8). Null for a key or number no card has.
 */
export function cardOfRef(ws: WorkspaceService, ref: string | number, scope: string | null = null): number | null {
  const v = typeof ref === 'number' ? String(ref) : ref.trim()
  const n = /^#?(\d{1,9})$/.exec(v)
  if (n) return hasCard(ws, Number(n[1])) ? Number(n[1]) : null
  const k = /^([A-Za-z]{2,4})-(\d{1,9})$/.exec(v)
  if (!k || !KEY_FORM.test(k[1])) return null
  const card = cardNamed(ws, k[1], Number(k[2]))
  // A key of another project's card, for an agent confined to its own (#1219 round 1, finding 4): as a key no card has,
  // so a reply never tells whether it exists, nor its number.
  if (card === null || scope === null) return card
  const of = cardKeyOf(ws, card)
  return of && inScope(ws, of, scope) ? card : null
}

/** Whether a reference is in a card reference's form (a key, `#N` or a number), whether or not a card has it. */
export const isCardRef = (ref: unknown): boolean => (typeof ref === 'number' && Number.isInteger(ref) && ref > 0) || (typeof ref === 'string' && /^(#?\d{1,9}|[A-Za-z]{2,4}-\d{1,9})$/.test(ref.trim()))
