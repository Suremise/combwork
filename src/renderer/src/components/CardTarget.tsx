import { useEffect, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import type { KeptTargetShown, LaneStartInfo, TaskCard } from '@shared/types'
import type { WorkBadge } from '@shared/workflow/workView'
import { call, errorMessage } from '../api'
import { loadTasks, notify, useLanguage, useStore } from '../store'
import { Icon, Tooltip, useBusy } from './ui'

// A card's Merges into in the window (HI-2556, SPEC §16.6.2 G7b): the branch its work is made from and merges into,
// the project's Work merges into or one of its Other branches work can merge into. Set when the card is made, or later
// while its branch has no work, or in flight with work all its own (HI-2753; main refuses it otherwise, saying why);
// shown on its tile when it isn't the project's.

const M = {
  field: msg({ id: 'board.target.field', defaultMessage: 'Merges into', description: 'HI-2556: a field label in the card dialog: the branch the card’s work is made from and merges into (Darren’s name for it).' }),
  own: msg({ id: 'board.target.own', defaultMessage: '{branch} (the project’s)', description: 'HI-2556: the first choice of the card dialog’s Merges into: the project’s Work merges into, {branch} its name.' }),
  mark: msg({ id: 'board.target.mark', defaultMessage: 'Into {branch}', description: 'HI-2556: a mark on a card’s tile: its work merges into {branch} (a branch name), not the project’s Work merges into.' }),
  markTip: msg({ id: 'board.target.markTip', defaultMessage: 'This card’s work is made from {branch} and merges into it, not the project’s Work merges into.', description: 'HI-2556: tooltip and accessible name of a card tile’s Merges into mark. {branch} is a branch name.' }),
  kept: msg({ id: 'board.target.kept', defaultMessage: 'Its work is kept on {branch}: it starts there again, whatever this says.', description: 'HI-3129: a note under the card dialog’s Merges into, for a card put back whose work is kept (in its slot) on another branch or bookmark ({branch}) than the one the field shows: its next start carries on there. Changing the field doesn’t move that work.' }),
  keptUnknown: msg({ id: 'board.target.keptUnknown', defaultMessage: 'Its work is kept in a slot whose branch Combwork can’t read now: it won’t start until it can.', description: 'HI-3129: a note under the card dialog’s Merges into, for a card put back whose kept work’s branch or bookmark can’t be read now: its start is refused until it can be, never started on the one the field shows.' }),
  failed: msg({ id: 'board.target.failed', defaultMessage: 'Where the card merges wasn’t changed', description: 'HI-2556: an error toast’s title: setting a card’s Merges into failed. Its text says why.' })
}

/**
 * The branches a project's lanes and cards may merge into (main's `lanes:startInfo`); null while unknown or none to pick.
 * Read again whenever `opened` changes (HI-2830: the card dialog stays mounted, so each opening counts) and on each
 * `workflow-changed` (HI-2851), as the project's Work merges into and Other branches change meanwhile; the last list
 * stays shown while the same project's is re-read.
 */
export function useProjectTargets(projectPath: string | null, opened: number): LaneStartInfo['targets'] {
  const [read, setRead] = useState<{ path: string; targets: LaneStartInfo['targets'] } | null>(null)
  const version = useStore((s) => s.workflowVersion)
  useEffect(() => {
    let live = true
    if (!projectPath) return
    call('lanes:startInfo', projectPath)
      .then((i) => live && setRead({ path: projectPath, targets: i.targets }))
      .catch(() => live && setRead({ path: projectPath, targets: null }))
    return () => {
      live = false
    }
  }, [projectPath, opened, version])
  return read && read.path === projectPath ? read.targets : null
}

/** The Merges into mark on a card's tile: its own branch, when it has one. */
export function TargetMark({ b }: { b: WorkBadge | undefined }) {
  useLanguage()
  if (!b?.target) return null
  const tip = tr(M.markTip, { branch: b.target })
  return (
    <Tooltip content={tip}>
      <span className="task-kind card-target" aria-label={tip} data-card-target={b.target}>
        <Icon name="git-merge" /> {tr(M.mark, { branch: b.target })}
      </span>
    </Tooltip>
  )
}

/**
 * The card dialog's Merges into, where the project lists other branches: for a new card, the choice it is made with;
 * for a card made, its branch and a choice that saves at once while it is in Todo (main checks it has no work), or in
 * flight (HI-2753: main moves it with its work kept, or refuses saying why).
 */
export function TargetField(props: { card: TaskCard | null; b: WorkBadge | undefined; targets: LaneStartInfo['targets']; value: string; setValue: (v: string) => void; readOnly: boolean }) {
  const { card, b, targets, value, setValue, readOnly } = props
  const action = useBusy()
  useLanguage()
  const kept = useKeptTarget(card && (b?.stage === 'hold' || b?.stage === 'todo') ? card.number : null, [targets, b?.target])
  // A card in flight shows the branch it merges into now (HI-2753): picking another moves it with its work kept, when main
  // finds all of that work its own (else it says why); the project's own branch is the empty choice.
  const flying = !!card && !!b?.startedOn
  const own = card ? (flying ? (b!.startedOn === targets?.default ? '' : b!.startedOn!) : (b?.target ?? '')) : value
  if (!targets && !own) return null
  // HI-3129: a card in flight keeps its target where its platform can't move started work (jj): shown, not changed.
  const open = !card || !b || b.stage === 'hold' || b.stage === 'todo' || (flying && !targets?.fixedInFlight)
  const save = async (to: string): Promise<void> => {
    if (!card) return setValue(to)
    let failed: string | null = null
    await action.run('target', async () => {
      try {
        await call('tasks:setTarget', card.number, to || null)
      } catch (e) {
        failed = errorMessage(e)
      }
    })
    if (failed !== null) notify('error', tr(M.failed), failed)
    await loadTasks()
  }
  const branches = [...new Set([...(targets?.others ?? []), ...(own ? [own] : [])])]
  return (
    <>
      <label htmlFor="card-target">{tr(M.field)}</label>
      <select id="card-target" className="select" value={own} disabled={readOnly || !open || !!action.busy || !!card?.archived} onChange={(e) => void save(e.target.value)} data-card-target-field={own}>
        <option value="">{targets ? tr(M.own, { branch: targets.default }) : ''}</option>
        {branches.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {kept && (
        <>
          <span />
          <span className="muted card-target-kept" data-card-target-kept={'target' in kept ? kept.target : 'unknown'}>
            {'target' in kept ? tr(M.kept, { branch: kept.target }) : tr(M.keptUnknown)}
          </span>
        </>
      )}
    </>
  )
}

/**
 * HI-3129: where card `n` (waiting to start) would start when that isn't what its Merges into shows: its kept work's
 * branch or bookmark, or unknown. Read again as the field's inputs change (each opening re-reads the targets).
 */
function useKeptTarget(n: number | null, deps: unknown[]): KeptTargetShown {
  const [read, setRead] = useState<{ n: number; kept: KeptTargetShown } | null>(null)
  useEffect(() => {
    let live = true
    if (n === null) return
    call('tasks:keptTarget', n)
      .then((kept) => live && setRead({ n, kept }))
      .catch(() => live && setRead({ n, kept: null }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, ...deps])
  return read && read.n === n ? read.kept : null
}
