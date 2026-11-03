import type { SessionListItem } from './types'
import { providerName } from './providers'
import { msg, tr } from './i18n'
import { shownText, withValues, type Text } from './advanced'
import type { ResumeHold } from './agentFolders'
import { samePath } from './movePaths'
import { cardRef } from './projectKeys'

/**
 * Why a session can't be resumed, for the Sessions tab's marker and its disabled Resume buttons (the reason is their
 * tooltip), or null when it can. From what Hive already knows: the session (a sub-session, its transcript), its
 * provider (turned on, installed) and the agents that could run it now.
 */
export interface ResumeContext {
  /** It is running now (in an agent of this project, or any window). Shown as running rather than resumable. */
  live: boolean
  /** Its provider is turned on in Settings → Providers. */
  providerEnabled: boolean
  /** Its provider's CLI was found; null while not known yet. */
  providerInstalled: boolean | null
  /** The agents that can run it now: those working in the folder it ran in (it resumes in its own provider, #506). */
  runners: readonly { id: string; name: string }[]
  /** Resume may add an agent for it (a session from the project folder, and room for another agent). */
  canAddAgent: boolean
  /** The Hive Assistant's conversations: its one agent resumes each in the provider it ran in (#506). */
  assistant?: boolean
  /** The project's folder: a session that recorded it ran there, not in a worktree. */
  projectPath?: string
}

type Resumable = Pick<SessionListItem, 'provider' | 'sub' | 'hasTranscript' | 'hasBackup' | 'cwd' | 'agentId' | 'agentName' | 'hold'>

/** What a lease was for, as the holds' messages name it: a card ("AM-14"), or a lane. */
const workOf = (h: { card: number | null }): { kind: 'card' | 'lane'; work: string } => (h.card !== null ? { kind: 'card', work: cardRef(h.card) } : { kind: 'lane', work: '' })

/**
 * Why a conversation can't resume where it was made (#1434, shared/agentFolders.ts's holds), for the window and for the
 * error main gives a refused Resume: `agent` is its agent's name. A `byHand` hold says only the user's own Resume takes
 * its slot (Resume All and startup leave it).
 */
export function holdText(h: ResumeHold, agent: string): Text {
  switch (h.is) {
    case 'after':
      return withValues(msg({ id: 'agents.resume.hold.after', defaultMessage: '{agent} is on {kind, select, card {{work}} other {its lane}} in {slot}: resume this after {kind, select, card {{work}} other {its lane}}.', description: "Why a conversation can't resume now (#1434): its agent ({agent}) builds a card ({work}: \"AM-14\"; kind card) or a lane (kind lane) in another slot ({slot}: \"slot-a\"), and this conversation is in the slot the agent kept: it resumes once that work ends." }), { agent, slot: h.slot, ...workOf(h) })
    case 'reused':
      return withValues(msg({ id: 'agents.resume.hold.reused', defaultMessage: "This conversation's slot ({slot}) now holds {kind, select, card {{work}'s work} other {a lane's work}}. Read its transcript, or start fresh with a handover.", description: "Why a conversation can't resume (#1434): the slot it ran in ({slot}: \"slot-b\") was lent to other work since: a card's ({work}: \"AM-14\"; kind card) or a lane's (kind lane). Reading its transcript and starting fresh with a handover are what the window offers." }), { slot: h.slot, ...workOf(h) })
    case 'holds':
      return withValues(msg({ id: 'agents.resume.hold.holds', defaultMessage: '{agent} already keeps {slot}. Release that slot to resume this conversation in its own.', description: "Why a conversation can't resume (#1434): its agent ({agent}) already keeps another slot ({slot}: \"slot-a\"), and an agent keeps one at a time." }), { agent, slot: h.slot })
    case 'draining':
      return withValues(msg({ id: 'agents.resume.hold.draining', defaultMessage: "This conversation's slot ({slot}) is still being handed back from its last session. Try again in a moment.", description: "Why a conversation can't resume just now (#1434): the slot it ran in ({slot}: \"slot-b\") is free, but its last session there is still exiting and Hive hasn't finished taking the slot back. It can be resumed in a moment." }), { slot: h.slot })
    case 'changed':
      return withValues(msg({ id: 'agents.resume.hold.changed', defaultMessage: "This conversation's slot ({slot}) has changed since it ran, so it can't resume there. Read its transcript, or start fresh with a handover.", description: "Why a conversation can't resume (#1434): the slot it ran in ({slot}: \"slot-b\") is free, but its files or its revision changed since (or it isn't set up)." }), { slot: h.slot })
    case 'gone':
      return withValues(msg({ id: 'agents.resume.hold.gone', defaultMessage: "This conversation's slot ({slot}) is gone from disk. Read its transcript, or start fresh with a handover.", description: "Why a conversation can't resume (#1434): the slot folder it ran in ({slot}: \"slot-b\") no longer exists." }), { slot: h.slot })
    case 'reviewer':
      return withValues(msg({ id: 'agents.resume.hold.reviewer', defaultMessage: '{agent} reviews now, and reviewers never run in a slot ({slot}). Read its transcript, or start fresh with a handover.', description: "Why a conversation can't resume (#1434): its agent ({agent}) has the reviewer role now, and reviewers work in the project folder, never in a slot ({slot}: \"slot-b\")." }), { agent, slot: h.slot })
    case 'byHand':
      return withValues(msg({ id: 'agents.resume.hold.byHand', defaultMessage: 'Its slot ({slot}) is free: Resume takes it for {agent} again. Resume All and startup leave it, so free slots stay for new work.', description: "A conversation's note (#1434): the slot it ran in ({slot}: \"slot-b\") is free and as it left it, so the user's own Resume takes it again for its agent ({agent}); Resume All and Hive's startup don't." }), { agent, slot: h.slot })
  }
}

/**
 * A hold in plain words, short, for the lists of agents Resume All and Hive's start left (#1434): "its slot is free.
 * Resume it by hand to take it", "its slot now holds AM-14's work", "after AM-14".
 */
export function holdShort(h: ResumeHold): Text {
  switch (h.is) {
    case 'byHand':
      return msg({ id: 'agents.resume.short.byHand', defaultMessage: 'its slot is free. Resume it by hand to take it', description: "Resume All's list of agents it left (#1434), after the agent's name: this one's conversation resumes only with its own Resume, which takes its slot again (the slot is free)." })
    case 'after':
      return withValues(msg({ id: 'agents.resume.short.after', defaultMessage: 'after {kind, select, card {{work}} other {its lane}}', description: "Resume All's list of agents it left (#1434), after the agent's name: this one's conversation resumes after the card ({work}: \"AM-14\"; kind card) or lane (kind lane) its agent builds now." }), workOf(h))
    case 'reused':
      return withValues(msg({ id: 'agents.resume.short.reused', defaultMessage: "its slot now holds {kind, select, card {{work}'s work} other {a lane's work}}", description: "Resume All's list of agents it left (#1434), after the agent's name: this one's conversation's slot was lent to other work since, a card's ({work}: \"AM-14\"; kind card) or a lane's (kind lane)." }), workOf(h))
    default:
      return msg({ id: 'agents.resume.short.other', defaultMessage: "can't resume in its slot", description: "Resume All's list of agents it left (#1434): this one's conversation can't resume in the slot it ran in (changed, gone, or its agent reviews now)." })
  }
}

export function resumeBlock(s: Resumable, ctx: ResumeContext): string | null {
  // Its slot's hold (#1434): a `byHand` one isn't a block here, the Sessions tab's Resume being the user's own.
  if (s.hold && s.hold.is !== 'byHand' && !ctx.live && !s.sub) return shownText(holdText(s.hold, s.agentName ?? ''))
  const who = providerName(s.provider)
  if (s.sub) return tr(msg({ id: 'agents.resume.sub', defaultMessage: "A {kind} {cli} ran for another session, not a conversation of its own: it can't be resumed.", description: "Why a session in the Sessions tab can't be resumed: it was a helper run (a {kind}, as the CLI names it: \"subagent\") that the CLI ({cli}) started for another session." }), { kind: s.sub.kind, cli: who })
  if (ctx.live) return tr(msg({ id: 'agents.resume.running', defaultMessage: 'It is running now.', description: "Why a session in the Sessions tab can't be resumed: it is running." }))
  if (!s.hasTranscript && !s.hasBackup) return tr(msg({ id: 'agents.resume.noTranscript', defaultMessage: 'Neither {cli} nor Combwork has its transcript any more, so there is nothing to resume.', description: "Why a session can't be resumed: its conversation's file is gone from the CLI ({cli}) and from Hive's backup." }), { cli: who })
  if (!ctx.providerEnabled) return tr(msg({ id: 'agents.resume.providerOff', defaultMessage: '{cli} is turned off. Turn it on in Settings → Providers to resume it.', description: "Why a session can't be resumed: its CLI ({cli}) is turned off. Settings → Providers is where: use its translated names." }), { cli: who })
  if (ctx.providerInstalled === false) return tr(msg({ id: 'agents.resume.notInstalled', defaultMessage: "{cli} isn't installed. Set it up in Provider Setup to resume it.", description: "Why a session can't be resumed: its CLI ({cli}) isn't installed. Provider Setup is a Help window: use its translated name." }), { cli: who })
  if (ctx.assistant) return null
  if (!ctx.runners.length && !ctx.canAddAgent) {
    return s.cwd && !(ctx.projectPath && samePath(s.cwd, ctx.projectPath))
      ? tr(msg({ id: 'agents.resume.goneWorktree', defaultMessage: 'It ran in a worktree no agent uses any more ({folder}). Add an agent for that worktree to resume it.', description: "Why a session can't be resumed: no agent works in the worktree folder it ran in ({folder}, a path)." }), { folder: s.cwd })
      : tr(msg({ id: 'agents.resume.noRoom', defaultMessage: 'No agent works in the project folder, and the project has no room for another agent.', description: "Why a session can't be resumed: no agent works in the project's own folder, and the project has as many agents as it may have." }))
  }
  return null
}

/** For a resumable session whose agent was removed: which agent resumes it now ("Its agent Coder was removed: it resumes in Helper."). */
export function removedAgentNote(s: Resumable, agents: readonly { id: string }[], target: { name: string } | null): string | null {
  if (!s.agentId || agents.some((a) => a.id === s.agentId)) return null
  const agent = s.agentName ?? 'none'
  if (target) return tr(msg({ id: 'agents.resume.removedTo', defaultMessage: '{agent, select, none {Its agent} other {Its agent {agent}}} was removed: it resumes in {target}.', description: "A note on a session in the Sessions tab whose agent ({agent}: its name; none when unknown) was removed: another agent ({target}) resumes it." }), { agent, target: target.name })
  return tr(msg({ id: 'agents.resume.removedAdd', defaultMessage: '{agent, select, none {Its agent} other {Its agent {agent}}} was removed: Resume adds a {cli} agent for it.', description: "A note on a session in the Sessions tab whose agent ({agent}: its name; none when unknown) was removed: Resume (a button) adds an agent of its CLI ({cli}) for it." }), { agent, cli: providerName(s.provider) })
}
