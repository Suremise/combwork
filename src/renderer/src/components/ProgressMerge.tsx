import type { MergeSlotInfo } from '@shared/types'
import { msg, tr } from '@shared/i18n'
import { call } from '../api'
import { findProject, set, useLanguage, useStore } from '../store'
import { cx } from '../util'
import { holderWords, intoBranch, minutesText, releaseLabel, releaseSlot, releaseTip, waitingWords } from './MergeSlots'
import { Icon, IconButton, Tooltip } from './ui'

/**
 * The top of the Progress panel (#484): a card per merge going on (a slot its holder has taken), in its own colour, with who
 * holds it, which branch goes where, the holder's current step (its running progress), how long so far and left, and
 * who waits. It folds up to its first line (remembered per workspace); Release frees a holder that is stuck. These are
 * the merge slot's cards (agents merging under "The agent merges", the user's merges); Hive's merge queue has its own
 * (ProgressQueue.tsx, #1356), with no Release.
 */

/** Where the merge cards' fold is remembered (`ui.panes`, as the panel's other folds). */
const foldKey = (ws: string): string => `progress-merge-fold:${ws.toLowerCase()}`

/** The fold of one of the panel's sections, remembered per workspace: true when folded. */
export function usePanelFold(key: string | null): [boolean, () => void] {
  const folded = useStore((s) => (key ? s.panes[key] === 1 : false))
  const toggle = (): void => {
    if (!key) return
    set((s) => ({ panes: { ...s.panes, [key]: folded ? 0 : 1 } }))
    void call('ui:setPane', key, folded ? null : 1)
  }
  return [folded, toggle]
}

/** The merge cards' fold (one for all of them, remembered per workspace). */
export function useMergeFold(): [boolean, () => void] {
  const ws = useStore((s) => s.workspace?.path ?? null)
  return usePanelFold(ws ? foldKey(ws) : null)
}

export function MergeCards({ slots, projectName, showProject, stepOf, now }: { slots: MergeSlotInfo[]; projectName: (path: string) => string; showProject: boolean; stepOf: (s: MergeSlotInfo) => string | null; now: number }) {
  useLanguage()
  const [folded, toggle] = useMergeFold()
  if (!slots.length) return null
  return (
    <div className="progress-merge" role="region" aria-label={tr(msg({ id: 'board.merge.region', defaultMessage: 'Merging', description: "Accessible name of the top of the Progress panel: a card for each merge going on." }))}>
      {slots.map((s) => (
        <MergeCard key={`${s.project}#${s.branch}`} slot={s} project={projectName(s.project)} showProject={showProject} step={stepOf(s)} now={now} folded={folded} onFold={toggle} />
      ))}
    </div>
  )
}

export function MergeCard({ slot: s, project, showProject, step, now, folded, onFold }: { slot: MergeSlotInfo; project: string; showProject: boolean; step: string | null; now: number; folded: boolean; onFold: () => void }) {
  // Only taken slots get a card (Progress.tsx).
  const h = s.holder!
  // The holder's branch, when it is an agent working outside the project folder (its slot's card line, or its own
  // worktree's branch, #1442): "hive/b1 → main".
  const from = useStore((st) => (h.agentId ? (findProject(st, s.project)?.agents.find((a) => a.id === h.agentId)?.place.branch ?? null) : null))
  const late = h.until < now
  const left = h.until - now
  const sofar = minutesText(now - h.since)
  const time =
    left > 0
      ? tr(msg({ id: 'board.merge.time', defaultMessage: '{sofar} so far · {left} left', description: 'How long a merge has held the merge slot ({sofar}: "3 min") and how long its hold has left ({left}: "57 min"), on its card in the Progress panel.' }), { sofar, left: minutesText(left) })
      : tr(msg({ id: 'board.merge.timeOver', defaultMessage: '{sofar} so far · over its time', description: 'How long a merge has held the merge slot ({sofar}: "63 min"), on its card in the Progress panel, once its hold has run out.' }), { sofar })
  return (
    <div className={cx('progress-merge-card', late && 'late', folded && 'folded')} data-slot={`${project}#${s.branch}`}>
      <div className="progress-merge-top">
        <Icon name="git-merge" />
        <span className="progress-merge-who">{holderWords(h, true)}</span>
        {folded && <span className="progress-merge-short">{sofar}</span>}
        <div className="grow" />
        {!folded && (
          <Tooltip content={releaseTip(h)}>
            <button type="button" className="btn small subtle" onClick={() => void releaseSlot(s, project)}>
              {releaseLabel()}
            </button>
          </Tooltip>
        )}
        <IconButton icon={folded ? 'chevron-down' : 'chevron-up'} title={folded ? tr(msg({ id: 'board.merge.unfold', defaultMessage: 'Show the merge in full', description: "Tooltip of the button unfolding a merge's card in the Progress panel." })) : tr(msg({ id: 'board.merge.fold', defaultMessage: 'Fold the merge to one line', description: "Tooltip of the button folding a merge's card in the Progress panel to its first line." }))} expanded={!folded} onClick={onFold} />
      </div>
      {!folded && (
        <>
          <div className="progress-merge-branch">
            {showProject && <span className="faint">{project} · </span>}
            {from ? (
              <>
                <code>{from}</code> → <code>{s.branch}</code>
              </>
            ) : (
              <>{intoBranch(s.branch)}</>
            )}
          </div>
          {step && (
            <Tooltip block content={step}>
              <div className="progress-merge-step">{step}</div>
            </Tooltip>
          )}
          <div className={cx('progress-merge-time', 'faint', late && 'late')}>{time}</div>
          {s.waiting.length > 0 && <div className="progress-merge-waiting faint">{waitingWords(s)}</div>}
        </>
      )}
    </div>
  )
}
