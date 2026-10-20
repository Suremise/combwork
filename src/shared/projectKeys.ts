// Project keys (#704, SPEC §16.12): a project's short identity, as in `AM-12`. 2–4 letters A–Z, unique in the workspace,
// none a prefix of another; Hive suggests 2 letters (on a clash, other 2-letter pairs first). A key belongs to one project
// for good: a project's old keys stay its aliases, so no other project can take them.

/** A key's form: 2–4 letters A–Z (compared case-insensitively, kept upper case). */
export const KEY_FORM = /^[A-Za-z]{2,4}$/

/** A key as kept: upper case, trimmed. */
export const normalKey = (key: string): string => key.trim().toUpperCase()

/** A key someone has: whose project it names, and whether it is that project's current key (else an alias). */
export interface KeyHeld {
  key: string
  projectId: string
}

/** Why a key can't be a project's, or null when it can: its form, or another project's key (or alias) it equals or prefixes. */
export type KeyProblem = 'form' | 'taken' | 'prefix'

export function keyProblem(key: string, projectId: string, held: readonly KeyHeld[]): KeyProblem | null {
  if (!KEY_FORM.test(key.trim())) return 'form'
  const k = normalKey(key)
  for (const h of held) {
    if (h.projectId === projectId) continue
    const o = normalKey(h.key)
    if (o === k) return 'taken'
    if (o.startsWith(k) || k.startsWith(o)) return 'prefix'
  }
  return null
}

/** A name's letters A–Z, upper case (accents taken off: "Café" is CAFE), in order. */
function lettersOf(name: string): string[] {
  return [
    ...name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
  ]
}

/**
 * The key Hive suggests for a project named `name`, given the keys others hold: its first two letters (hive is HI,
 * amberlight AM, website WE); on a clash other 2-letter pairs of its letters, the first letter kept first; then 3 and 4
 * letters of its name; then any free pair. Always one that keyProblem accepts.
 */
export function suggestKey(name: string, projectId: string, held: readonly KeyHeld[]): string {
  const free = (k: string): boolean => keyProblem(k, projectId, held) === null
  const l = lettersOf(name)
  const tried = new Set<string>()
  const ok = (k: string): boolean => {
    if (tried.has(k)) return false
    tried.add(k)
    return free(k)
  }
  // Pairs in order: its first letter with each later one, then each later letter with those after it.
  for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) if (ok(l[i] + l[j])) return l[i] + l[j]
  for (const n of [3, 4]) if (l.length >= n && ok(l.slice(0, n).join(''))) return l.slice(0, n).join('')
  // A name with too few letters (or every pair taken): its first letter (P for a name with none) and any other.
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const first = l[0] ?? 'P'
  for (const c of A) if (ok(first + c)) return first + c
  for (const a of A) for (const b of A) if (ok(a + b)) return a + b
  for (const a of A) for (const b of A) for (const c of A) if (ok(a + b + c)) return a + b + c
  throw new Error('No project key is free') // i18n-ignore: can't happen (17,576 three-letter keys), for the log
}

/** A card's key: `HI-12` (its project's key and its number there). */
export const cardKey = (projectKey: string, projectNumber: number): string => `${projectKey}-${projectNumber}`

/**
 * A card as agents read it until P8 switches the tools to keys (#1119, Darren 20 Oct): its key with the number the tools
 * take, "HI-1230 (#1240)"; `#1240` for a card with no key (a workspace card, a project with no key yet).
 */
export const cardName = (c: { number: number; key?: string }): string => (c.key ? `${c.key} (#${c.number})` : `#${c.number}`)
