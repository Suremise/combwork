import { CARD_TITLE_NUDGE } from '../shared/advanced'
import { advanced } from './advanced'
import type { TaskActor } from './tasks'

/** A file name's extension, of code, docs, data or logs (a title naming a file: HI-2061). */
const FILE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|yml|yaml|toml|py|rs|go|cs|java|c|h|cpp|css|scss|html|sh|ps1|bat|cmd|exe|dll|log|txt|db|sql|lock|xml|ini|cfg|env|csv)$/i
/** A product spelled like a file ("Node.js", "Vue.js"): a word, not a file. */
const PRODUCT = /^[A-Z][a-z]+\.js$/
/** A number with a unit: a measurement ("300 s", "20 MB", "95 %"), evidence for the description. */
const MEASURE = /(?<![\w.])\d+(?:[.,]\d+)?\s?(?:ms|s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?|days?|[KMGT]i?B|bytes?|px|chars?|characters|lines|tokens|°C|%)(?![\w%])/g

/**
 * What in an agent's title belongs in the description (HI-2061): paths, file names, card numbers and keys, and
 * measurements, at most three, as written. `keys`: the workspace's project keys, current and old, so "HI-12" counts
 * and "UTF-8" doesn't.
 */
export function titleDetails(title: string, keys: readonly string[]): string[] {
  const known = new Set(keys.map((k) => k.toUpperCase()))
  const found: string[] = []
  for (const raw of title.split(/\s+/)) {
    const t = raw.replace(/^[("'`[]+/, '').replace(/[)"'`\],:;!?]+$/, '').replace(/\.$/, '')
    if (!t) continue
    const seps = (t.match(/[\\/]/g) ?? []).length
    const path = seps > 0 && /\w/.test(t) && (FILE_EXT.test(t) || seps >= 2 || /^[A-Za-z]:[\\/]/.test(t))
    const file = !seps && /^[\w-]+(?:\.[\w-]+)*$/.test(t) && FILE_EXT.test(t) && !PRODUCT.test(t)
    const card = /^#\d+$/.test(t) || (/^[A-Za-z]{2,4}-\d+$/.test(t) && known.has(t.split('-')[0].toUpperCase()))
    if (path || file || card) found.push(t)
  }
  for (const m of title.matchAll(MEASURE)) found.push(m[0])
  return [...new Set(found)].slice(0, 3)
}

/**
 * The line an agent's reply adds when it gave a card a title that should be shorter: past the length set in Settings →
 * Advanced (HI-1872), or naming what belongs in the description (HI-2061). The title is kept, never refused; a long one
 * is cut in git (it is the merge commit's subject) and on the board. The user's own titles get none; the length's at 0
 * turns off only the length's. Agent-facing: English.
 */
export function titleNudge(title: unknown, actor: TaskActor, keys: readonly string[] = []): string | null {
  if (actor.kind === 'user' || typeof title !== 'string') return null
  const lines: string[] = []
  const limit = advanced.number(CARD_TITLE_NUDGE)
  if (limit && [...title.trim()].length > limit) lines.push(`Titles over ${limit} characters are cut in git and on the board: consider a shorter one (the detail belongs in the description).`) // i18n-ignore: agent-facing (a tool reply's line)
  const details = titleDetails(title, keys)
  if (details.length) {
    const quoted = details.map((d) => `"${d}"`)
    const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}` : quoted[0] // i18n-ignore: agent-facing (a tool reply's line)
    // A step to take, not a place to put it (HI-2260: told to put it in a description that already had it, agents kept the title).
    lines.push(`A title says the outcome or the problem in words: retitle it without ${list} (hive_update_task with title), keeping ${details.length > 1 ? 'them' : 'it'} in the description.`) // i18n-ignore: agent-facing (a tool reply's line)
  }
  return lines.length ? lines.join(' ') : null
}
