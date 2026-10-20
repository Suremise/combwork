import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { addProjectKeys, boardWrite, boardChanged, cardNamed, hasCard, keysNoticeDue, keysNoticeSaid, projectKeys, setProjectKey } from './boardStore'
import { fmt, msg, tr } from '../shared/i18n'
import { keyProblem, KEY_FORM, normalKey, suggestKey } from '../shared/projectKeys'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import type { WorkspaceService } from './workspace'

const log = createLogger('keys')

/**
 * Project keys (#1219, #704; SPEC §16.12): each project of a workspace has one, given when the workspace opens (suggested
 * from its folder name; the upgrade to 1.0 gives the projects with cards theirs), changed by the user, its old keys kept
 * as aliases. The rules are shared/projectKeys.ts's, the rows boardStore's (schema/keysStep.ts).
 */

const folderOf = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

/**
 * Gives each project of the workspace that has no key one, suggested from its folder name (in name order, so two new
 * ones choose the same way each time), in one board change. Run each time the workspace opens and when its projects are
 * read again; changes nothing once each has one. Returns the keys given.
 */
export async function keyProjects(ws: WorkspaceService): Promise<string[]> {
  if (!ws.path) return []
  const ids = await ws.projectIds()
  const projects = [...ids.byId].map(([id, path]) => ({ id, name: folderOf(path) })).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  if (!projects.length || !ws.path) return []
  const held = new Set(projectKeys(ws).filter((k) => k.current).map((k) => k.projectId))
  if (projects.every((p) => held.has(p.id))) return []
  return boardWrite(ws, async () => {
    const added = addProjectKeys(ws, projects.map((p) => ({ id: p.id, pick: (keys) => suggestKey(p.name, p.id, keys) })))
    if (added.length) {
      log.info(`${added.length} project(s) given a key: ${added.join(', ')}`)
      boardChanged(ws)
    }
    return added
  })
}

/** Why a key can't be a project's, in the window's language (Project Settings). */
const PROBLEM = {
  form: msg({ id: 'service.keys.form', defaultMessage: 'A project key is 2 to 4 letters, A to Z.', description: "An error changing a project's key (Project Settings): the key typed isn't 2–4 letters A–Z." }),
  taken: msg({ id: 'service.keys.taken', defaultMessage: '{key} is another project’s key, or was: a key stays with its project for good.', description: "An error changing a project's key: {key} (letters such as AM) belongs to another project now or did before (its old keys stay its aliases)." }),
  prefix: msg({ id: 'service.keys.prefix', defaultMessage: '{key} and another project’s key {other} begin alike: no key can be the start of another.', description: "An error changing a project's key: {key} and another project's key {other} (both letters such as AM and AMB) would be one the start of the other, which isn't allowed." }),
  unknownProject: msg({ id: 'service.keys.unknownProject', defaultMessage: 'That project has no id yet, so it can’t have a key: open it in Hive first.', description: "An error changing a project's key: the project hasn't been given Hive's id (it hasn't been opened yet)." })
}

/**
 * Makes `key` the project's key (Project Settings), its key before kept as an alias: refused, saying why, when it isn't
 * 2–4 letters or another project has it, or had it, or one begins the other. A key it had before is its key again.
 */
export async function changeProjectKey(ws: WorkspaceService, projectPath: string, key: string): Promise<string> {
  const ids = await ws.projectIds({ fresh: true })
  const id = ids.byPath.get(resolve(projectPath).toLowerCase())
  if (!id) throw hiveError(PROBLEM.unknownProject, undefined, { kind: 'invalid' })
  const k = normalKey(String(key ?? ''))
  return boardWrite(ws, async () => {
    const held = projectKeys(ws)
    const problem = keyProblem(k, id, held)
    if (problem === 'form') throw hiveError(PROBLEM.form, undefined, { kind: 'invalid' })
    if (problem === 'taken') throw hiveError(PROBLEM.taken, { key: k }, { kind: 'conflict' })
    if (problem === 'prefix') {
      const other = held.find((h) => h.projectId !== id && (normalKey(h.key).startsWith(k) || k.startsWith(normalKey(h.key))))!.key
      throw hiveError(PROBLEM.prefix, { key: k, other: normalKey(other) }, { kind: 'conflict' })
    }
    if (held.some((h) => h.projectId === id && h.current && normalKey(h.key) === k)) return k
    setProjectKey(ws, id, k)
    log.info(`${userText(folderOf(projectPath))}'s key is now ${k}`)
    boardChanged(ws)
    return k
  })
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
  if (!ws.path || !keysNoticeDue(ws)) return
  const keys = projectKeys(ws).filter((k) => k.current).map((k) => k.key).sort()
  const title = tr(msg({ id: 'service.keys.noticeTitle', defaultMessage: 'Projects have keys now', description: "A quiet notice's title, once after the upgrade to Hive 1.0: each project now has a short key (letters such as HI or AM) its cards are named by (HI-12)." }))
  const message = tr(msg({ id: 'service.keys.notice', defaultMessage: 'Cards are named by their project’s key: {keys}. Change a key in Project Settings; the old one keeps working.', description: "A quiet notice once after the upgrade to Hive 1.0. {keys}: the projects' keys, joined (HI, AM and WE)." }), { keys: fmt.list(keys) })
  ws.emit({ type: 'toast', toast: { id: randomUUID(), level: 'info', title, message, timestamp: new Date().toISOString(), quiet: true } })
  void boardWrite(ws, async () => keysNoticeSaid(ws)).catch((e) => log.warn('noting the keys notice as said', e))
}

/**
 * The card a reference names, for the Agent API and the hive tools (#1219; Darren, 20 Oct: tools take a key string too):
 * a key (`HI-12`, any case, an old key too), an old number as `#1061`, or the number the tools take (`1061`, the old global
 * number until P8). Null for a key or number no card has.
 */
export function cardOfRef(ws: WorkspaceService, ref: string | number): number | null {
  const v = typeof ref === 'number' ? String(ref) : ref.trim()
  const n = /^#?(\d{1,9})$/.exec(v)
  if (n) return hasCard(ws, Number(n[1])) ? Number(n[1]) : null
  const k = /^([A-Za-z]{2,4})-(\d{1,9})$/.exec(v)
  if (k && KEY_FORM.test(k[1])) return cardNamed(ws, k[1], Number(k[2]))
  return null
}

/** Whether a reference is in a card reference's form (a key, `#N` or a number), whether or not a card has it. */
export const isCardRef = (ref: unknown): boolean => (typeof ref === 'number' && Number.isInteger(ref) && ref > 0) || (typeof ref === 'string' && /^(#?\d{1,9}|[A-Za-z]{2,4}-\d{1,9})$/.test(ref.trim()))
