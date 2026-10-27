import { CARD_TITLE_NUDGE } from '../shared/advanced'
import { advanced } from './advanced'
import type { TaskActor } from './tasks'

/**
 * The line an agent's reply adds when it gave a card a long title (HI-1872): the title is kept, never refused; a long
 * one is cut in git (it is the merge commit's subject) and on the board. The user's own titles get none, nor any
 * with the advanced setting at 0. Agent-facing: English.
 */
export function titleNudge(title: unknown, actor: TaskActor): string | null {
  if (actor.kind === 'user' || typeof title !== 'string') return null
  const limit = advanced.number(CARD_TITLE_NUDGE)
  if (!limit || [...title.trim()].length <= limit) return null
  return `Titles over ${limit} characters are cut in git and on the board: consider a shorter one (the detail belongs in the description).` // i18n-ignore: agent-facing (a tool reply's line)
}
