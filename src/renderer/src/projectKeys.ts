import { tr } from '@shared/i18n'
import { msg } from '@shared/i18n/msg'
import { keyProblem, normalKey, type KeyHeld } from '@shared/projectKeys'
import { get } from './store'

/**
 * Project keys in the window (#1221; the rules are shared/projectKeys.ts's, the rows main's): the keys the projects hold
 * now and before, and why a key typed can't be a project's, in the window's language. A project is named by its path.
 */

/** Every key the workspace's projects hold, current and old, each with its project (by path). */
export function keysHeld(): KeyHeld[] {
  return get().projectKeys.flatMap((p) => [p.key, ...p.aliases].map((key) => ({ key, projectId: p.projectPath.toLowerCase() })))
}

/** The project holding this key now or before (another than `projectPath`), by name, for a reason. */
function holderOf(k: string, projectPath: string, held: readonly KeyHeld[]): string {
  const h = held.find((x) => x.projectId !== projectPath.toLowerCase() && (normalKey(x.key).startsWith(k) || k.startsWith(normalKey(x.key))))
  return h ? normalKey(h.key) : ''
}

/** Why `key` can't be the project's at `projectPath` ('' for a project not made yet), in the window's language; null when it can. */
export function keyProblemText(key: string, projectPath: string, held: readonly KeyHeld[] = keysHeld()): string | null {
  const k = normalKey(key)
  const problem = keyProblem(k, projectPath.toLowerCase(), held)
  if (problem === 'form') return tr(msg({ id: 'project.key.form', defaultMessage: 'A key is 2 to 4 letters, A to Z.', description: "Why a project key typed can't be used (New Project dialog, Project Settings): it isn't 2–4 letters A–Z." }))
  if (problem === 'taken') return tr(msg({ id: 'project.key.taken', defaultMessage: '{key} is another project’s key, or was: a key stays with its project for good.', description: "Why a project key typed can't be used: {key} (letters such as AM) belongs to another project now or did before (its old keys stay its aliases)." }), { key: k })
  if (problem === 'prefix') return tr(msg({ id: 'project.key.prefix', defaultMessage: '{key} and {other}, another project’s key, begin alike: no key can be the start of another.', description: "Why a project key typed can't be used: {key} and another project's key {other} (letters such as AM and AMB) would be one the start of the other." }), { key: k, other: holderOf(k, projectPath, held) })
  return null
}

/**
 * The card a reference names, as the window has the board (#1221): `AM-12` (any case, an old key of its project, or a
 * moved card's name in a project it left), `#12` or `12`. Null for one the board has no card for.
 */
export function cardNumberOf(ref: string): number | null {
  const v = ref.trim()
  const n = /^#?(\d{1,9})$/.exec(v)
  if (n) return Number(n[1])
  const k = /^([A-Za-z]{2,4})-(\d{1,9})$/.exec(v)
  if (!k) return null
  const typed = normalKey(k[1])
  const project = get().projectKeys.find((p) => p.key === typed || p.aliases.includes(typed))
  const key = `${project ? project.key : typed}-${Number(k[2])}`
  // A card of that project now, else one that moved away from it (its name there kept).
  return get().tasks.find((c) => c.key === key)?.number ?? get().movedCardNames[`${typed}-${Number(k[2])}`] ?? null
}
