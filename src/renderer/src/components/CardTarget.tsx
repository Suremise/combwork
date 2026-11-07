import { useEffect, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import type { LaneStartInfo, TaskCard } from '@shared/types'
import type { WorkBadge } from '@shared/workflow/workView'
import { call, errorMessage } from '../api'
import { loadTasks, notify, useLanguage } from '../store'
import { Icon, Tooltip, useBusy } from './ui'

// A card's Merges into in the window (HI-2556, SPEC §16.6.2 G7b): the branch its work is made from and merges into,
// the project's Work merges into or one of its Other branches work can merge into. Set when the card is made, or later
// while its branch has no work (main refuses it otherwise, saying why); shown on its tile when it isn't the project's.

const M = {
  field: msg({ id: 'board.target.field', defaultMessage: 'Merges into', description: 'HI-2556: a field label in the card dialog: the branch the card’s work is made from and merges into (Darren’s name for it).' }),
  own: msg({ id: 'board.target.own', defaultMessage: '{branch} (the project’s)', description: 'HI-2556: the first choice of the card dialog’s Merges into: the project’s Work merges into, {branch} its name.' }),
  mark: msg({ id: 'board.target.mark', defaultMessage: 'Into {branch}', description: 'HI-2556: a mark on a card’s tile: its work merges into {branch} (a branch name), not the project’s Work merges into.' }),
  markTip: msg({ id: 'board.target.markTip', defaultMessage: 'This card’s work is made from {branch} and merges into it, not the project’s Work merges into.', description: 'HI-2556: tooltip and accessible name of a card tile’s Merges into mark. {branch} is a branch name.' }),
  failed: msg({ id: 'board.target.failed', defaultMessage: 'Where the card merges wasn’t changed', description: 'HI-2556: an error toast’s title: setting a card’s Merges into failed. Its text says why.' })
}

/** The branches a project's lanes and cards may merge into (main's `lanes:startInfo`); null while unknown or none to pick. */
export function useProjectTargets(projectPath: string | null): LaneStartInfo['targets'] {
  const [targets, setTargets] = useState<LaneStartInfo['targets']>(null)
  useEffect(() => {
    let live = true
    setTargets(null)
    if (!projectPath) return
    call('lanes:startInfo', projectPath)
      .then((i) => live && setTargets(i.targets))
      .catch(() => live && setTargets(null))
    return () => {
      live = false
    }
  }, [projectPath])
  return targets
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
 * for a card made, its branch and a choice that saves at once while it is in Todo (main checks it has no work).
 */
export function TargetField(props: { card: TaskCard | null; b: WorkBadge | undefined; targets: LaneStartInfo['targets']; value: string; setValue: (v: string) => void; readOnly: boolean }) {
  const { card, b, targets, value, setValue, readOnly } = props
  const action = useBusy()
  useLanguage()
  const own = card ? (b?.target ?? '') : value
  if (!targets && !own) return null
  const open = !card || !b || b.stage === 'hold' || b.stage === 'todo'
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
    </>
  )
}
