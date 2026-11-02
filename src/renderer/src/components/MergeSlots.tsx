import { Children, useEffect, type ReactNode } from 'react'
import type { MergeSlotInfo } from '@shared/types'
import { fmt, msg, tr, tRich } from '@shared/i18n'
import { attempt } from '../actions'
import { call } from '../api'
import { cardLabelOf, confirm, get, setLoaded, useLanguage, useStore } from '../store'
import { useNow } from '../usage'
import { Icon, Tooltip } from './ui'

/**
 * The merge slots (#350): who is merging into a project's branch and who waits, in the Progress panel (every project),
 * the project's Overview and the Merge dialog, with Release for a holder that is stuck.
 */

const NO_SLOTS: MergeSlotInfo[] = []

/** This window's slots, loaded when its workspace changes (events keep them current). */
export function useMergeSlots(): MergeSlotInfo[] {
  const ws = useStore((s) => s.workspace?.path)
  useEffect(() => {
    if (!ws) return
    let current = true
    void call('mergeSlots:list').then((slots) => current && setLoaded({ mergeSlots: slots }))
    return () => {
      current = false
    }
  }, [ws])
  return useStore((s) => s.mergeSlots ?? NO_SLOTS)
}

type Holder = NonNullable<MergeSlotInfo['holder']>

/**
 * The merge slot in the window's words (#798): shared/mergeSlot words it in English for agents and the hive tools, and
 * these are the window's, in the user's language.
 */

/** A length of time in whole minutes: "under a minute", "48 min". */
export function minutesText(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60000)
  if (m < 1) return tr(msg({ id: 'board.slots.underMinute', defaultMessage: 'under a minute', description: 'How long a merge has held the merge slot (or has left), when under a minute. Lower case: it starts a phrase ("under a minute so far").' }))
  return tr(msg({ id: 'board.slots.minutes', defaultMessage: '{n, number} min', description: 'How long a merge has held the merge slot (or has left), in whole minutes ("48 min"). Keep it short: an abbreviation.' }), { n: m })
}

/**
 * Who holds a slot: "B4 is merging #305", "B4 is next to merge" (its turn, not taken yet), "you are merging". `start`: it
 * begins a line, so it starts with a capital.
 */
export function holderWords(h: Holder, start = false): string {
  if (h.kind === 'user') {
    return start
      ? tr(msg({ id: 'board.slots.youMergingStart', defaultMessage: 'You are merging', description: 'Who holds the merge slot, at the start of a line: the user (merging from the window).' }))
      : tr(msg({ id: 'board.slots.youMerging', defaultMessage: 'you are merging', description: 'Who holds the merge slot, inside a line ("main: you are merging (3 min so far…)"): the user (merging from the window). Lower case.' }))
  }
  const values = { agent: start ? h.name[0].toUpperCase() + h.name.slice(1) : h.name, cards: h.cards.length ? h.cards.map((n) => cardLabelOf(get(), n)).join(', ') : 'none' }
  if (h.taken) return tr(msg({ id: 'board.slots.agentMerging', defaultMessage: '{agent} is merging{cards, select, none {} other { {cards}}}', description: 'Who holds the merge slot: an agent ({agent}) merging, then the cards it merges ({cards}: "#305, #306"; none: leave that branch empty).' }), values)
  return tr(msg({ id: 'board.slots.agentNext', defaultMessage: '{agent} is next to merge{cards, select, none {} other { {cards}}}', description: 'Who holds the merge slot: an agent ({agent}) whose turn it is, not started yet, then the cards it will merge ({cards}: "#305, #306"; none: leave that branch empty).' }), values)
}

/** A slot in a line: who holds it, for how long so far and how long it has left; or free. */
function slotWords(s: MergeSlotInfo, now: number): string {
  const h = s.holder
  if (!h) return s.waiting.length ? tr(msg({ id: 'board.slots.freeNext', defaultMessage: 'free, {agent} next', description: "A merge slot nobody holds, after its branch (\"main: free, B4 next\"): the agent next in line ({agent}) gets it. Lower case." }), { agent: s.waiting[0].name }) : tr(msg({ id: 'board.slots.free', defaultMessage: 'free', description: 'A merge slot nobody holds, after its branch ("main: free"). Lower case.' }))
  const left = h.until - now
  const values = { holder: holderWords(h), sofar: minutesText(now - h.since) }
  if (left > 0) return tr(msg({ id: 'board.slots.held', defaultMessage: '{holder} ({sofar} so far, {left} left)', description: 'A merge slot in a line, after its branch: who holds it ({holder}: "B4 is merging #305"), how long so far ({sofar}: "3 min") and how long its hold has left ({left}: "57 min").' }), { ...values, left: minutesText(left) })
  return tr(msg({ id: 'board.slots.heldOver', defaultMessage: '{holder} ({sofar} so far, over its time)', description: 'A merge slot in a line, after its branch: who holds it ({holder}: "B4 is merging #305"), how long so far ({sofar}: "63 min"), and that its hold has run out.' }), values)
}

/** "Waiting: B4, B5": who waits for a slot. */
export const waitingWords = (s: MergeSlotInfo): string => tr(msg({ id: 'board.slots.waiting', defaultMessage: 'Waiting: {agents}', description: 'Who waits for the merge slot, in line order ({agents}: their names, listed).' }), { agents: fmt.list(s.waiting.map((w) => w.name), 'unit') })

/** The Release button's tooltip. */
export const releaseTip = (h: Holder): string =>
  h.kind === 'agent'
    ? tr(msg({ id: 'board.slots.releaseTipAgent', defaultMessage: 'Release the merge slot {agent} holds, if it is stuck', description: 'Tooltip of the Release button on a merge slot an agent ({agent}) holds.' }), { agent: h.name })
    : tr(msg({ id: 'board.slots.releaseTipYou', defaultMessage: 'Release the merge slot your merge holds, if it is stuck', description: "Tooltip of the Release button on a merge slot the user's own merge holds." }))

/** The Release button's label. */
export const releaseLabel = (): string => tr(msg({ id: 'board.slots.release', defaultMessage: 'Release', description: 'Button on a merge slot: frees the slot from a holder that is stuck. Keep it short.' }))

/** "into <code>main</code>": where a merge goes, its branch as code. */
const slotBranch = (chunks: ReactNode[]): ReactNode => <span className="merge-slot-branch">{chunks}</span>

export const intoBranch = (branch: string): ReactNode[] => tRich<ReactNode>(msg({ id: 'board.slots.into', defaultMessage: 'into <code>{branch}</code>', description: 'Where a merge goes: into a branch ({branch}, shown as code; keep the <code> tags around it).' }), { branch, code: (chunks) => <code key="code">{chunks}</code> })

/** One project's slots. */
export function projectSlots(slots: MergeSlotInfo[], projectPath: string): MergeSlotInfo[] {
  return slots.filter((s) => s.project.toLowerCase() === projectPath.toLowerCase())
}

/** Releases a stuck holder, after asking. */
export async function releaseSlot(s: MergeSlotInfo, projectName: string): Promise<void> {
  const h = s.holder
  if (!h) return
  const where = { project: projectName, branch: s.branch }
  const ok = await confirm({
    title: tr(msg({ id: 'board.slots.releaseTitle', defaultMessage: 'Release the merge slot?', description: 'Title of the confirmation before freeing a merge slot from its holder.' })),
    message:
      h.kind === 'agent'
        ? tr(msg({ id: 'board.slots.releaseAgent', defaultMessage: '{agent} holds the merge slot for {project} · {branch}. Release it only if it is stuck: {agent} may be in the middle of merging, and is told the slot was released when it next asks.', description: 'The confirmation before freeing a merge slot an agent ({agent}) holds, for a project ({project}) and its branch ({branch}).' }), { ...where, agent: h.name })
        : tr(msg({ id: 'board.slots.releaseYours', defaultMessage: 'Your merge holds the merge slot for {project} · {branch}. Release it only if it is stuck: the merge may still be running.', description: "The confirmation before freeing a merge slot the user's own merge holds, for a project ({project}) and its branch ({branch})." }), where),
    detail: s.waiting.length ? tr(msg({ id: 'board.slots.releaseNext', defaultMessage: '{agent} is next in line and gets it.', description: 'Under the confirmation before freeing a merge slot: the agent next in line ({agent}) gets the slot.' }), { agent: s.waiting[0].name }) : undefined,
    confirmLabel: releaseLabel(),
    danger: true
  })
  // Releases the hold this question named: if it has changed hands meanwhile, Hive refuses and says so.
  if (ok) await attempt(tr(msg({ id: 'board.slots.releaseFailed', defaultMessage: "Couldn't release the merge slot", description: "An error's title: freeing a merge slot failed." })), () => call('mergeSlots:release', s.project, s.branch, h.id))
}

/** The slots as rows: the branch, who holds it (and until when), who waits; Release for a holder. */
export function MergeSlotList({ slots, projectName, showProject }: { slots: MergeSlotInfo[]; projectName: (path: string) => string; showProject: boolean }) {
  useLanguage()
  const now = useNow(30000)
  if (!slots.length) return null
  return (
    <div className="merge-slots">
      {slots.map((s) => {
        const h = s.holder
        const late = !!h && h.until < now
        return (
          <div key={`${s.project}#${s.branch}`} className={`merge-slot${late ? ' late' : ''}`} data-slot={`${projectName(s.project)}#${s.branch}`}>
            <Icon name="git-merge" />
            <div className="merge-slot-text">
              <div className="merge-slot-line">
                {showProject && <span className="merge-slot-project">{projectName(s.project)} · </span>}
                {Children.toArray(tRich<ReactNode>(msg({ id: 'board.slots.line', defaultMessage: '<branch>{name}</branch>: {state}', description: "A merge slot in the Progress panel: its branch ({name}, shown as code: keep the <branch> tags around it) and who holds it or waits for it ({state}). Your language's punctuation goes around the colon." }), { name: s.branch, state: slotWords(s, now), branch: slotBranch }))}
              </div>
              {s.waiting.length > 0 && <div className="merge-slot-waiting faint">{waitingWords(s)}</div>}
            </div>
            {h && (
              <Tooltip content={releaseTip(h)}>
                <button type="button" className="btn small subtle" onClick={() => void releaseSlot(s, projectName(s.project))}>
                  {releaseLabel()}
                </button>
              </Tooltip>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The Merge dialog's note while the slot it merges into is taken: the merge waits until it is free. */
export function MergeSlotNote({ slot }: { slot: MergeSlotInfo | null }) {
  useLanguage()
  if (!slot || (!slot.holder && !slot.waiting.length)) return null
  const name = slot.waiting[0]?.name ?? ''
  const who = slot.holder ? holderWords(slot.holder, true) : tr(msg({ id: 'board.slots.waitingToMerge', defaultMessage: '{agent} is waiting to merge', description: "Who has the merge slot in the Merge dialog's note when nobody holds it: the agent first in line ({agent}). It starts the note." }), { agent: name ? name[0].toUpperCase() + name.slice(1) : name })
  return (
    <div className="banner warn merge-slot-note">
      <Icon name="git-merge" />
      <span>
        {tr(msg({ id: 'board.slots.note', defaultMessage: '{who} into {branch} (the merge slot). Merge waits until it is free{waiting, plural, =0 {} other {; # waiting}}.', description: "The Merge dialog's note while the branch it merges into ({branch}) is taken: who holds it ({who}: \"B4 is merging #305\"), that the merge waits, and how many wait in line ({waiting}; none: leave that branch empty)." }), { who, branch: slot.branch, waiting: slot.waiting.length })}
      </span>
    </div>
  )
}
