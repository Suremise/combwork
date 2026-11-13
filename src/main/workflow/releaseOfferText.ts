// HI-3155: a release offer in the Assistant's words (agent text: English, said with say()), for its inbox line and its
// project status. It names the offer's id, which its answers carry (cw_update_setting's `offer`, cw_branch's).

import { agentMsg, say } from '../../shared/agentText'
import type { ReleaseOffer } from '../../shared/types'

const T = {
  head: agentMsg({ id: 'service.releaseOffer.head', text: 'Release offer {id} for {project}, the user’s to decide:', note: 'HI-3155: the first line of a release offer told to the Assistant (its inbox, its project status).' }),
  move: agentMsg({ id: 'service.releaseOffer.move', text: '{target} is released ({tag}, merged into {into}). {how, select, move {Moving Work merges into to {next}: cw_update_setting project.workflow.target {next} with offer {id}, then its retarget preview.} start {{next} doesn’t exist yet: cw_branch nextVersion with offer {id} starts it.} other {No next version to move to.}}', note: 'HI-3155: the move part of a release offer, for the Assistant. {next}: the next version’s branch (how move: it exists and isn’t released; how start: it doesn’t exist yet).' }),
  drop: agentMsg({ id: 'service.releaseOffer.drop', text: 'Released and unused, can come off Other branches work can merge into: {branches} (cw_update_setting project.workflow.otherTargets with offer {id}).', note: 'HI-3155: the cleanup part of a release offer, for the Assistant: released branches nothing uses ({branches}: their names, joined).' }),
  kept: agentMsg({ id: 'service.releaseOffer.kept', text: 'Released but still used, kept: {kept}.', note: 'HI-3155: released Other branches still in use, each with what uses it ({kept}: "1.3.0 (AM-12, B1’s lane)", joined by "; ").' }),
  tail: agentMsg({ id: 'service.releaseOffer.tail', text: 'Tell the user; act only on their answer. cw_branch dismissOffer {id} puts it off (their Not now).', note: 'HI-3155: the last line of a release offer told to the Assistant.' })
}

/** The offer as the Assistant reads it: a few lines (its inbox, its project status). */
export function releaseOfferSaid(o: ReleaseOffer, _where: 'delivery' | 'status'): string {
  const lines = [say(T.head, { id: o.id, project: o.project })]
  if (o.move) lines.push(say(T.move, { id: o.id, target: o.move.target, tag: o.move.tag, into: o.move.into, how: o.move.moveTo ? 'move' : o.move.startNext ? 'start' : 'none', next: o.move.moveTo ?? o.move.startNext ?? '' }))
  if (o.cleanup?.drop.length) lines.push(say(T.drop, { id: o.id, branches: o.cleanup.drop.map((d) => d.branch).join(', ') }))
  if (o.cleanup?.kept.length) lines.push(say(T.kept, { kept: o.cleanup.kept.map((k) => `${k.branch} (${k.uses.join(', ')})`).join('; ') }))
  lines.push(say(T.tail, { id: o.id }))
  return lines.join('\n')
}
