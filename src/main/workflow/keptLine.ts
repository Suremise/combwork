// HI-3112: a waiting card's kept line target, read in one place by the start (the git platform's `startTarget` and
// `start`), a change of Work merges into's preview, a branch's uses (`referencesTo`: the options save and the branch
// undo) and a card's own Merges into. Its own module, importing only the history port: the platform reads it too.
import { lineHistory } from '../platform/historyPorts'
import { isUnknown } from '../platform/types'
import type { CardState } from '../../shared/workflow/facts'

/** What a reader answers: the branch the card keeps, none (it follows its target), or unknown (kept, or refused). */
export type KeptLine = { target: string } | null | 'unknown'

/**
 * The branch a waiting card keeps merging into because of its line, whatever Work merges into is now: the one its earlier
 * start made the line from (`Started.target`), for a card in On Hold or Todo with no Merges into of its own whose own line
 * (`cw/<project key>/<card key>…`, built in a slot) still exists and holds history `to` lacks: committed work, or the old
 * branch's commits it was made from (reused on `to`, either would be merged there). Null when it has none of that (never
 * started, its own target set, built in the project folder, the line gone, or all of it in `to` already), or `to` is that
 * branch. Unknown when a head or the containment can't be read: every caller keeps the card or refuses, never frees it.
 * `at`: the branch whose head `to` will have, where `to` isn't made yet (Start the next version makes it at the release's
 * head: its preview is made before).
 */
export async function keptLineTarget(projectPath: string, s: CardState, card: { key: string; target?: string | null }, projectKey: string, to: string, at: string = to): Promise<KeptLine> {
  const from = s.started?.target
  if (card.target || !from || from === to || (s.stage !== 'hold' && s.stage !== 'todo') || s.started!.folder === 'project') return null
  const H = lineHistory()
  const own = `cw/${projectKey}/${card.key}`
  let head: string | null = null
  // Its newest own line still there, as the start finds it (`lineFor`): the last started first, then the others.
  for (const l of new Set([s.started!.line, ...[...s.lines].reverse()])) {
    if (!l || (l !== own && !l.startsWith(`${own}-`))) continue
    const h = await H.lineHead(projectPath, l)
    if (isUnknown(h)) return 'unknown'
    if (h) {
      head = h
      break
    }
  }
  if (!head) return null
  const th = await H.lineHead(projectPath, at)
  if (isUnknown(th) || !th) return 'unknown'
  if (head === th) return null
  const inTo = await H.isAncestor(projectPath, head, th)
  if (isUnknown(inTo)) return 'unknown'
  return inTo ? null : { target: from }
}
