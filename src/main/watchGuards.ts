// Guards on an agent's new watch (HI-2197), checked by the Agent API's wait routes before a watch is registered. Agent-
// facing text, English (scripts/i18nGuard.mjs leaves this file out).
import { basename } from 'path'
import { placementDue } from './slotCards'
import { liveCardHeads, readTask, scopeOf, type TaskActor } from './tasks'
import { cardOfRef } from './projectKeys'
import { cardKeyOf } from './boardStore'
import type { WorkspaceService } from './workspace'
import { agentMsg, say } from '../shared/agentText'

const T = {
  whilePlaced: agentMsg({ id: 'wake.watch.whilePlaced', text: 'Combwork is giving you {card} in {slot}: end your turn with no watch. The card comes to you as a task; a watch now would hold it off.', note: 'HI-2197: a watch refused while Combwork is placing a card of the agent\'s in a slot (a watch would hold that placement off). card: its key ("HI-12"); slot: the slot\'s name.' }),
  numberClash: agentMsg({ id: 'wake.watch.numberClash', text: '{n} is {key}\'s number (#{n}), not {prefix}-{n}, which is another card. Name cards by key: "{prefix}-{n}" or "{key}".', note: 'A watch refused for naming a card by a plain number that reads as another card\'s key (2189 is HI-2182\'s number while HI-2189 is another card). n: the number; key: the card it is the number of; prefix: the project\'s key.' })
}

/**
 * The card Combwork is about to give an agent in a slot (a start of its own, its placement not made yet), or null. A watch
 * the agent set meanwhile would hold that placement off ("waiting on cards") with nothing to wake it.
 */
export async function placementComing(ws: WorkspaceService, projectPath: string, agentId: string): Promise<{ key: string; slot: string } | null> {
  const project = basename(projectPath).toLowerCase()
  const mine = (await liveCardHeads(ws).catch(() => [])).filter((c) => c.agent === agentId && c.column === 'doing' && c.project.toLowerCase() === project)
  for (const c of mine) {
    const due = await placementDue(ws, projectPath, c.number).catch(() => null)
    if (due) return { key: cardKeyOf(ws, c.number)?.key ?? `#${c.number}`, slot: due.slot }
  }
  return null
}

/** Why an agent's watch is refused while Combwork is giving it a card in a slot, or null. */
export async function watchWhilePlaced(ws: WorkspaceService, projectPath: string, agentId: string): Promise<string | null> {
  const due = await placementComing(ws, projectPath, agentId)
  return due ? say(T.whilePlaced, { card: due.key, slot: due.slot }) : null
}

/**
 * Why an agent's plain number (12, "12") in a watch's cards is refused, or null: where it reads as another card's key
 * (2189 is HI-2182's number while HI-2189 is another card). Never remapped; `#2189`, and a number no key of its project
 * reads as, go on as before. Only cards the agent may see are named: each is read in its scope first (a card outside it
 * is unknown, as before), and the other card only by a key of the agent's own project.
 */
export async function clashingNumber(ws: WorkspaceService, cards: unknown, actor: TaskActor): Promise<string | null> {
  if (!Array.isArray(cards)) return null
  for (const v of cards) {
    const plain = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v) : null
    if (plain === null || !Number.isInteger(plain) || plain < 1) continue
    const card = await readTask(plain, actor)
    const prefix = card.key?.split('-')[0]
    if (!prefix || card.key === `${prefix}-${plain}`) continue
    const other = cardOfRef(ws, `${prefix}-${plain}`, scopeOf(actor))
    if (other === null || other === plain) continue
    return say(T.numberClash, { n: String(plain), key: card.key ?? '', prefix })
  }
  return null
}
