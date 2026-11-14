// HI-3235 (HI-2840/s30, s34; HI-3235/s7, s10, s13, s16): the generic workflow's records of a platform's advance of a
// card's target, the `AdvanceHost` its adapter writes through. Each record is one write of the card, made only while the
// card is still where the call says (its cycle; an outcome only for its own attempt, still unsettled), so a late or
// repeated call records nothing. Nothing here names a platform: the descriptor declares the finish (`finishAdvances`),
// the adapter decides readiness and runs the protocol, holding its card and repository locks (card → repository → this
// write's transaction); these writes take no repository lock and leave their actions for the caller to run once its
// locks are let go (`runActions: false`).

import { ADVANCE_PREVIEW_GATE, ADVANCE_STOPPED_GATE, ADVANCE_UNCERTAIN_GATE, advanceUnresolved, type CardState, type FactData } from '../../shared/workflow/facts'
import { basename } from 'path'
import { PLATFORMS, type PlatformId } from '../../shared/platform/descriptors'
import { FOR_YOU, workflowText } from '../../shared/workflow/texts'
import { agentMsg, say } from '../../shared/agentText'
import { inDefaultDialect } from '../../shared/agentText/asyncScope'
import type { StoredText } from '../../shared/types'
import type { AdvanceHost, AdvanceRef, AdvanceWords } from '../platform/adapter'
import type { Fact } from '../../shared/workflow/facts'
import type { CardRecord } from './factStore'
import type { Workflow, Write } from './runtime'
import { createLogger, userText } from '../logger'

const log = createLogger('advance')

/** HI-3236: the project's meta marking a plan's preview dismissed by the user (Not for this plan), for the card's cycle. */
export const previewDeclinedKey = (card: string, cycle: number, plan: string): string => `advance_declined:${card.toLowerCase()}:${cycle}:${plan}`

/** The project's meta (scoped to it) marking its one-time note about the advance being its default (HI-3235). */
export const advanceNoteKey = (project: string): string => `advance_note:${project.toLowerCase()}`

/** HI-3235: what agents read of the advance's card comment and notice (the window shows FOR_YOU's messages beside them). */
const A = {
  refused: agentMsg({ id: 'workflow.advance.refused', text: "Combwork didn't move {target} for {card}: refused before anything changed ({why}: {detail}). It tries again once the repository changes; the user can integrate it themselves.", note: 'A card comment (HI-3235): Combwork’s jj advance refused at its base read; {why} a code, {detail} refs or folders.' }),
  note: agentMsg({ id: 'workflow.advance.note', text: "Combwork now integrates {project}'s jj cards itself once their merge checks pass (Version Control → Workflow → Who integrates).", note: 'A notice, once per jj project (HI-3235): the new default finish applies to it.' })
}

/** The longest `detail` a question or a fact keeps. */
const DETAIL_MAX = 600
const clip = (s: string | undefined): string => (s ?? '').slice(0, DETAIL_MAX)

/** The words a question about an attempt is asked in (FOR_YOU's two advance messages). */
function question(card: CardRecord, platform: PlatformId, state: 'stopped' | 'uncertain', w: AdvanceWords): StoredText {
  const short = PLATFORMS[platform].revisionShort
  const values = {
    card: card.key,
    target: w.target,
    result: w.result ? short(w.result) : '—',
    why: w.why,
    detail: clip(w.detail) || '—',
    again: w.again ?? 'none',
    op: w.op ? short(w.op) : 'none'
  }
  return workflowText(state === 'stopped' ? FOR_YOU.advanceStopped : FOR_YOU.advanceUncertain, values)
}

/** Whether a write is still at the call's cycle and attempt, that attempt unsettled. */
const atAttempt = (w: Write, ref: AdvanceRef): boolean => {
  const s = w.state()
  return s.cycle === ref.cycle && s.advance?.attempt === ref.attempt && advanceUnresolved(s)
}

/** The attempt's open questions closed (one open request per attempt): before a fresh one is asked. */
const closeOpen = (w: Write, attempt: string): void => {
  for (const r of w.state().requests) if ((r.gate === ADVANCE_STOPPED_GATE || r.gate === ADVANCE_UNCERTAIN_GATE) && r.entry === attempt) w.fact('RequestClosed', { request: r.request, why: 'advance' }) // i18n-ignore: a fact's kind and codes, not text
}

export function advanceHostOf(wf: Workflow): AdvanceHost {
  const quiet = { runActions: false }
  const ask = (w: Write, card: CardRecord, ref: AdvanceRef, plan: string, state: 'stopped' | 'uncertain', words: AdvanceWords): void => {
    closeOpen(w, ref.attempt)
    const platform = wf.rulesetOf(card, w.state()).options.platform
    wf.askUser(w, 'approve', state === 'stopped' ? ADVANCE_STOPPED_GATE : ADVANCE_UNCERTAIN_GATE, question(card, platform, state, words), { unbound: true, entry: ref.attempt, result: plan })
  }
  const guarded = async (what: string, card: CardRecord, fn: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await fn()
    } catch (e) {
      log.warn(`advance ${what} for ${card.key} not recorded: ${userText((e as Error).message)}`) // i18n-ignore: the log (English)
      return false
    }
  }
  return {
    attempted: (card, cycle, plan, attempt) =>
      guarded('attempted', card, async () => {
        const s = wf.state(wf.store.card(card.id))
        const r = wf.rulesetOf(card, s)
        await wf.write(
          card,
          r,
          'combwork',
          (w) => {
            const now = w.state()
            if (now.cycle !== cycle || w.current !== 'approved' || advanceUnresolved(now)) return
            w.fact('AdvanceAttempted', { plan, attempt }) // i18n-ignore: a fact's kind and codes, not text
          },
          undefined,
          quiet
        )
        // Read back (s34 §2, write 2): only a fact the board now has counts.
        const back = wf.state(wf.store.card(card.id)).advance
        return back?.attempt === attempt && back.plan === plan && back.state === 'attempted'
      }),
    advanced: (card, ref, integrated, also) =>
      guarded('advanced', card, async () => {
        const s = wf.state(wf.store.card(card.id))
        const r = wf.rulesetOf(card, s)
        return wf.write(
          card,
          r,
          'combwork',
          (w) => {
            const now = w.state()
            if (now.cycle !== ref.cycle || now.advance?.attempt !== ref.attempt || now.advance.state === 'resolved') return now.integrated?.platform?.attempt === ref.attempt
            // Once per attempt (a repeat after a crash between `verified` and this fact records nothing twice).
            const f = w.tx.appendObserved(card.id, { kind: 'Integrated', actor: 'combwork', source: 'observed', dedupe: `advance:${ref.attempt}`, data: { ...integrated, by: 'combwork', platform: { ...integrated.platform, attempt: ref.attempt } } }) // i18n-ignore: a fact's kind and codes, not text
            if (!f) return true
            w.written.push(f as Fact)
            also?.(w)
            if (wf.cfg.reconcileActs && w.current !== 'done' && !wf.closeWaitsFor(w).length) w.move('done', 'derived')
            return true
          },
          undefined,
          quiet
        )
      }),
    stopped: (card, ref, plan, stop, words) =>
      guarded('stopped', card, async () => {
        const s = wf.state(wf.store.card(card.id))
        const r = wf.rulesetOf(card, s)
        return wf.write(
          card,
          r,
          'combwork',
          (w) => {
            if (!atAttempt(w, ref)) return false
            // A stop with no undo offered is the user's to settle, as an uncertain outcome is (its question the same).
            const uncertain = stop.uncertain || !stop.undo
            w.fact('AdvanceStopped', { attempt: ref.attempt, code: stop.code, ...(stop.detail ? { detail: clip(stop.detail) } : {}), undo: !uncertain, uncertain }) // i18n-ignore: a fact's kind and codes, not text
            ask(w, card, ref, plan, uncertain ? 'uncertain' : 'stopped', words)
            return true
          },
          undefined,
          quiet
        )
      }),
    resolved: (card, ref, how, detail) =>
      guarded('resolved', card, async () => {
        const s = wf.state(wf.store.card(card.id))
        const r = wf.rulesetOf(card, s)
        return wf.write(
          card,
          r,
          'combwork',
          (w) => {
            if (!atAttempt(w, ref)) return false
            closeOpen(w, ref.attempt)
            w.fact('AdvanceResolved', { attempt: ref.attempt, how, ...(detail ? { detail: clip(detail) } : {}) }) // i18n-ignore: a fact's kind and codes, not text
            return true
          },
          undefined,
          quiet
        )
      }),
    attested: (card, ref, answer, reason) =>
      guarded('attested', card, async () => {
        const s = wf.state(wf.store.card(card.id))
        const r = wf.rulesetOf(card, s)
        return wf.write(
          card,
          r,
          'user',
          (w) => {
            const now = w.state()
            // The answer it acts on: the user's Approve of exactly this attempt's uncertain question, in this cycle.
            const asked = now.made[answer.request]
            const approved = now.approvals.some((a) => a.request === answer.request && a.answer === 'approved')
            if (!atAttempt(w, ref) || now.advance?.state !== 'uncertain' || answer.state !== 'uncertain' || asked?.gate !== ADVANCE_UNCERTAIN_GATE || asked.entry !== ref.attempt || !approved) return false
            w.fact('AdvanceResolved', { attempt: ref.attempt, how: 'attested', detail: clip(reason) }) // i18n-ignore: a fact's kind and codes, not text
            // The user's word, never verified integration (s34 §2): an Override, so its finish is `override` (accepted for
            // dependents, finishAccepts) and no Integrated fact exists for it.
            w.fact('Override', { rules: ['advance.verified'], move: `${w.current}→done`, by: 'user', reason: clip(reason) }) // i18n-ignore: a fact's kind and codes, not text
            w.move('done', 'user')
            return true
          },
          undefined,
          quiet
        )
      }),
    askAgain: (card, ref, plan, state, words, answer) =>
      guarded('askAgain', card, async () => {
        const s = wf.state(wf.store.card(card.id))
        const r = wf.rulesetOf(card, s)
        return wf.write(
          card,
          r,
          'combwork',
          (w) => {
            if (!atAttempt(w, ref)) return false
            const now = w.state()
            // A consumed answer is this attempt's (else nothing is asked for it here: a stale delivery retires nothing new).
            if (answer && (now.made[answer.request]?.entry !== ref.attempt || answer.cycle !== ref.cycle)) return false
            // The state moves (stopped → uncertain where the undo isn't offered any more) as a fact of its own.
            if (now.advance?.state !== state) w.fact('AdvanceStopped', { attempt: ref.attempt, code: now.advance?.code ?? 'askedAgain', ...(now.advance?.detail ? { detail: now.advance.detail } : {}), undo: state === 'stopped', uncertain: state === 'uncertain' }) // i18n-ignore: a fact's kind and codes, not text
            ask(w, card, ref, plan, state, words)
            return true
          },
          undefined,
          quiet
        )
      }),
    refused: (card, cycle, plan, words) =>
      guarded('refused', card, async () => {
        // Once per cycle, plan and reason (s30 §1: refused at the base, the card stays Approved with the reason).
        const key = `advance_refused:${card.key.toLowerCase()}:${cycle}:${plan}:${words.why}`
        if (wf.store.meta(key)) return false
        const s = wf.state(wf.store.card(card.id))
        return wf.write(
          card,
          wf.rulesetOf(card, s),
          'combwork',
          (w) => {
            if (w.tx.meta(key) || w.state().cycle !== cycle) return false
            w.tx.setMeta(key, new Date().toISOString())
            const platform = wf.rulesetOf(card, w.state()).options.platform
            const text = workflowText(FOR_YOU.advanceRefused, { card: card.key, target: words.target, result: PLATFORMS[platform].revisionShort(words.result), why: words.why, detail: clip(words.detail) || '—' })
            // Agents read the card's comments: its English is the agent message, the window's the stored message.
            w.action('comment', { text: inDefaultDialect(() => say(A.refused, { card: card.key, target: words.target, why: words.why, detail: clip(words.detail) || '-' })), shown: text })
            return true
          },
          undefined,
          quiet
        )
      }),
    askPreview: (card, cycle, plan, words) =>
      guarded('askPreview', card, async () => {
        const s = wf.state(wf.store.card(card.id))
        return wf.write(
          card,
          wf.rulesetOf(card, s),
          'combwork',
          (w) => {
            const now = w.state()
            if (now.cycle !== cycle || w.current !== 'approved' || advanceUnresolved(now)) return false
            // One preview per card: any earlier one closed in this write (it can start no attempt once this one exists).
            for (const r of now.requests) if (r.gate === ADVANCE_PREVIEW_GATE) w.fact('RequestClosed', { request: r.request, why: 'advance' }) // i18n-ignore: a fact's kind and codes, not text
            const platform = wf.rulesetOf(card, now).options.platform
            const short = PLATFORMS[platform].revisionShort
            const text = workflowText(FOR_YOU.advancePreview, { card: card.key, target: words.target, expected: short(words.expected), result: short(words.result), style: words.style, commits: clip(words.commits) || '—', more: words.more, again: words.again ?? 'none' })
            wf.askUser(w, 'approve', ADVANCE_PREVIEW_GATE, text, { unbound: true, entry: plan, result: plan })
            return true
          },
          undefined,
          quiet
        )
      }),
    declinePreview: (card, cycle, plan) =>
      guarded('declinePreview', card, async () => {
        const key = previewDeclinedKey(card.key, cycle, plan)
        const s = wf.state(wf.store.card(card.id))
        return wf.write(
          card,
          wf.rulesetOf(card, s),
          'user',
          (w) => {
            if (w.state().cycle !== cycle) return false
            w.tx.setMeta(key, new Date().toISOString())
            return true
          },
          undefined,
          quiet
        )
      }),
    previewDeclined: (card, cycle, plan) => !!wf.store.meta(previewDeclinedKey(card.key, cycle, plan)),
    noteDefault: async (card) => {
      if (!wf.cfg.finishInherited?.()) return
      const key = advanceNoteKey(wf.cfg.projectId?.() ?? wf.cfg.project)
      if (wf.store.meta(key)) return
      await guarded('note', card, async () => {
        const s = wf.state(wf.store.card(card.id))
        await wf.write(
          card,
          wf.rulesetOf(card, s),
          'combwork',
          (w) => {
            if (w.tx.meta(key)) return
            w.tx.setMeta(key, new Date().toISOString())
            const text = workflowText(FOR_YOU.advanceNote, { project: basename(wf.cfg.project) })
            w.action('notify', { text: inDefaultDialect(() => say(A.note, { project: basename(wf.cfg.project) })), shown: text })
          },
          undefined,
          quiet
        )
        return true
      })
    }
  }
}

/** HI-3235: the facts an attested finish leaves, for tests and the window: its Override, no Integrated. */
export const attestedOverride = (s: CardState): FactData['Override'] | undefined => s.overrides.findLast((o) => o.rules.includes('advance.verified'))
