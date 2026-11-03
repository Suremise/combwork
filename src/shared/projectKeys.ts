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
 * ambrosia AM, website WE); on a clash other 2-letter pairs of its letters, the first letter kept first; then 3 and 4
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
 * A card as everything names it (HI-1661, Darren 26 Oct: "reference cards only by key"): its key, `HI-1230`, never the
 * workspace-wide number beside it; `#1240` only for a card with no key (a workspace card, a project with no key yet, a
 * number no card has). The one rule for agents' texts and the window alike.
 */
export const nameWithKey = (n: number, key: string | undefined | null): string => key || `#${n}`
/** A card in a text agents read: its key, else as cardRef names its number. */
export const cardName = (c: { number: number; key?: string }): string => c.key || cardRef(c.number)

/** A card as the window names it (#1221, #704: "the ID is the ID"): nameWithKey's form. */
export const cardLabel = (c: { number: number; key?: string }): string => nameWithKey(c.number, c.key)

/** How a text names a card by its number: its key (`HI-1230`) where its workspace is known, `#1240` where it isn't. */
export type CardNames = (n: number) => string
const plain: CardNames = (n) => `#${n}`
let naming: () => CardNames | null = () => null
let scoped: CardNames | null = null

/**
 * Where the texts agents read get their card names (#1219): main sets it once (the namer of the request, wake or
 * delivery being made, for its own workspace); elsewhere (the window, the hive MCP server) there is none, and a text
 * names a card `#N` unless it runs in namedBy.
 */
export function setCardNaming(get: () => CardNames | null): void {
  naming = get
}

/** Runs `fn` (synchronous) with these names for the cards its texts name; null or undefined: as it would without. */
export function namedBy<T>(names: CardNames | null | undefined, fn: () => T): T {
  if (!names) return fn()
  const was = scoped
  scoped = names
  try {
    return fn()
  } finally {
    scoped = was
  }
}

/** A card as a text names it, by its number (see CardNames). */
export const cardRef = (n: number): string => (scoped ?? naming() ?? plain)(n)

/** Names for some cards, by number, as a text's JSON carries them (`names`): what the hive MCP server words a reply with. */
export function namesOf(numbers: Iterable<number>): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  let any = false
  for (const n of numbers) {
    const name = cardRef(n)
    if (name !== `#${n}`) {
      out[String(n)] = name
      any = true
    }
  }
  return any ? out : undefined
}

/** The names a text's JSON carries (namesOf), for namedBy; null when it carries none. */
export const namesFrom = (names: Record<string, string> | undefined | null): CardNames | null => (names ? (n) => names[String(n)] ?? `#${n}` : null)
