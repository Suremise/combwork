// Guards on an agent's new watch (HI-2197), checked by the Agent API's wait routes before a watch is registered. Agent-
// facing text, English (scripts/i18nGuard.mjs leaves this file out).
import { basename } from 'path'
import { placementDue } from './slotCards'
import { liveCardHeads, readTask, scopeOf, type TaskActor } from './tasks'
import { cardOfRef } from './projectKeys'
import { cardKeyOf } from './boardStore'
import type { WorkspaceService } from './workspace'

/**
 * The card Hive is about to give an agent in a slot (a start of its own, its placement not made yet), or null. A watch
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

/** Why an agent's watch is refused while Hive is giving it a card in a slot, or null. */
export async function watchWhilePlaced(ws: WorkspaceService, projectPath: string, agentId: string): Promise<string | null> {
  const due = await placementComing(ws, projectPath, agentId)
  return due ? `Hive is giving you ${due.key} in ${due.slot}: end your turn with no watch. The card comes to you as a task; a watch now would hold it off.` : null
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
    return `${plain} is ${card.key}'s number (#${plain}), not ${prefix}-${plain}, which is another card. Name cards by key: "${prefix}-${plain}" or "${card.key}".`
  }
  return null
}
