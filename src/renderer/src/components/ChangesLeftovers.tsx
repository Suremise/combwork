import { useMemo } from 'react'
import type { ProjectInfo } from '@shared/types'
import type { GitBranchRow, LeftoverInfo } from '@shared/gitRepo'
import { busyLines, leftoverBranches } from '@shared/branchCleanup'
import { branchCards } from '@shared/branchCards'
import { fmt, msg, tr } from '@shared/i18n'
import { useStore } from '../store'
import { useWorkBadges } from '../cardWork'
import { useProjectStages } from '../projectStages'
import { at } from '../views/GitTab'
import { BranchCards, deleteBranch } from '../views/GitBranches'
import { PaneResizer } from './Resizer'
import { Icon, IconButton, LoadFailed, StaleNote } from './ui'

/**
 * The Changes tab's leftover branches (HI-1823): the local branches nothing uses now (branchCleanup.ts's
 * leftoverBranches: a Done or archived card's, an agent's from before slots, one of no card), merged into the target or
 * not, each with Compare (HI-1824's comparison against the target) and Delete (Branches & remotes' own, #1642: one
 * confirm when merged, the commits it drops listed first when not; main checks each deletion again).
 */

const M = {
  entry: msg({ id: 'project.leftovers.entry', defaultMessage: 'Leftover branches ({n, number})', description: "An entry of the Changes tab's picker: the branches nothing uses now, {n} of them." }),
  heading: msg({ id: 'project.leftovers.heading', defaultMessage: 'Leftover branches', description: "The heading of the Changes tab's page of branches nothing uses now." }),
  about: msg({ id: 'project.leftovers.about', defaultMessage: 'Branches nothing uses now: not {target} or the default branch, not checked out in a worktree or slot, and no open card’s. A Done or archived card’s branch, an agent’s from before slots, or one of no card. Delete removes only the branch, and Combwork checks again first that nothing uses it.', description: "The sentence at the top of the Changes tab's leftover branches. {target} is the branch the project's work merges into." }),
  merged: msg({ id: 'project.leftovers.merged', defaultMessage: 'Merged into {target}', description: "A group of the Changes tab's leftover branches: those whose commits are all in {target}, so deleting them loses nothing." }),
  unmerged: msg({ id: 'project.leftovers.unmerged', defaultMessage: 'Not in {target}', description: "A group of the Changes tab's leftover branches: those with commits {target} hasn't." }),
  ahead: msg({ id: 'project.leftovers.ahead', defaultMessage: '{n, plural, one {# commit not in {target}} other {# commits not in {target}}}', description: "On a leftover branch in the Changes tab: how many of its commits {target} hasn't." }),
  notCounted: msg({ id: 'project.leftovers.notCounted', defaultMessage: 'commits not in {target}: not counted', description: "On a leftover branch in the Changes tab when Combwork didn't count its commits (too many)." }),
  compare: msg({ id: 'project.leftovers.compare', defaultMessage: 'Compare', description: "A button on a leftover branch in the Changes tab: compares it with the target before deciding." }),
  compareTip: msg({ id: 'project.leftovers.compareTip', defaultMessage: 'Compare {branch} with {target}', description: "Tooltip of a leftover branch's Compare button in the Changes tab." }),
  delete: msg({ id: 'project.leftovers.delete', defaultMessage: 'Delete…', description: "A button on a leftover branch in the Changes tab: deletes it, after a confirmation." }),
  none: msg({ id: 'project.leftovers.none', defaultMessage: 'None here.', description: "Under a group of the Changes tab's leftover branches that has none." }),
  load: msg({ id: 'project.leftovers.load', defaultMessage: 'the branches', description: "What couldn't be read, in an error on the Changes tab's leftover branches." }),
  refresh: msg({ id: 'project.leftovers.refresh', defaultMessage: 'Read the branches again', description: "A button on the Changes tab's leftover branches: reads them again (a branch changed outside Combwork)." }),
  loading: msg({ id: 'project.leftovers.loading', defaultMessage: 'Reading the branches…', description: "While the Changes tab's leftover branches are read." })
}

/** The page value of the picker's entry. */
export const LEFTOVERS_ROOT = 'leftovers'

type InfoRead = { data: LeftoverInfo | null; error: string | null; loading: boolean; at: number; reload: () => void }

/** The project's leftover branches (every local branch, `git:leftovers`), by the window's cards (an open card's branch is in use). */
export function useLeftovers(project: ProjectInfo, info: LeftoverInfo | null): { merged: GitBranchRow[]; unmerged: GitBranchRow[]; count: number; onBranch: ReturnType<typeof branchCards> } {
  const tasks = useStore((s) => s.tasks)
  const badges = useWorkBadges()
  const onBranch = useMemo(() => branchCards(project.name, tasks, badges), [project.name, tasks, badges])
  return useMemo(() => {
    // An open card's lines, earlier cycles' too (one back from Done may have started again elsewhere), as main reads them.
    const mine = new Set(tasks.filter((t) => t.project.toLowerCase() === project.name.toLowerCase()).map((t) => t.number))
    const earlier = [...badges.values()].filter((b) => mine.has(b.card) && !b.noCode && b.stage !== 'done').flatMap((b) => b.lines ?? [])
    const busy = new Set([...busyLines(onBranch), ...earlier])
    const l = info ? leftoverBranches(info, busy) : { merged: [], unmerged: [] }
    return { ...l, count: l.merged.length + l.unmerged.length, onBranch }
  }, [info, onBranch, tasks, badges, project.name])
}

/** The picker's entry, at the end of its Branches group. */
export function LeftoversOption({ count }: { count: number }) {
  return <option value={LEFTOVERS_ROOT}>{tr(M.entry, { n: count })}</option>
}

export function LeftoversPage({ project, read, selector, listWidth, onCompare }: { project: ProjectInfo; read: InfoRead; selector: React.ReactNode; listWidth: number; onCompare: (base: string, head: string) => void }) {
  const info = read.data
  const { merged, unmerged, count, onBranch } = useLeftovers(project, info)
  const names = useProjectStages().get(project.path.toLowerCase())?.names
  const target = info?.target ?? null
  const row = (b: GitBranchRow): React.ReactNode => (
    <div key={b.name} className="git-row git-branch leftover-branch" data-leftover={b.name} data-merged={b.toTarget === 0 ? 'yes' : 'no'}>
      <Icon name="git-branch" />
      <span className="git-name">{b.name}</span>
      <BranchCards cards={onBranch.get(b.name) ?? []} project={project} names={names} inTarget={b.toTarget === 0} />
      {b.toTarget !== 0 && <span className="badge leftover-ahead">{b.toTarget == null ? tr(M.notCounted, { target: target ?? '' }) : tr(M.ahead, { n: b.toTarget, target: target ?? '' })}</span>}
      <span className="git-subject faint">{b.subject}</span>
      <span className="git-meta faint">{at(b.date)}</span>
      <button className="btn small subtle" data-action="compare-leftover" title={tr(M.compareTip, { branch: b.name, target: target ?? '' })} onClick={() => target && onCompare(target, b.name)}>
        <Icon name="git-compare" /> {tr(M.compare)}
      </button>
      <button className="btn small subtle" data-action="delete-leftover" onClick={() => target && void deleteBranch(project, b, target)}>
        <Icon name="trash" /> {tr(M.delete)}
      </button>
    </div>
  )
  return (
    <div className="changes-split" style={{ '--list-width': `${listWidth}px` } as React.CSSProperties}>
      <div className="split" data-leftovers-page="">
        <div className="split-list">
          <PaneResizer paneKey="changes" />
          <div className="pane-header" style={{ paddingLeft: 14 }}>
            {tr(M.heading)} {info && <span className="badge" style={{ marginLeft: 6 }}>{fmt.number(count)}</span>}
            <div className="actions">
              <IconButton icon={read.loading ? 'loading' : 'refresh'} spin={read.loading} title={tr(M.refresh)} action="refresh-leftovers" disabled={read.loading} onClick={read.reload} />
            </div>
          </div>
          {selector}
        </div>
        <div className="split-main leftovers-pane">
          {info && read.error && !read.loading && <StaleNote what={tr(M.load)} error={read.error} at={read.at} onRetry={read.reload} />}
          {!info ? (
            read.error ? (
              <LoadFailed what={tr(M.load)} error={read.error} onRetry={read.reload} />
            ) : (
              <div className="empty-state">
                <Icon name="loading" spin /> {tr(M.loading)}
              </div>
            )
          ) : (
            <div className="leftovers">
              <div className="changes-about changes-page-head" data-about="leftovers">
                {tr(M.about, { target: target ?? '' })}
              </div>
              <h2 className="section" data-leftover-group="merged">
                {tr(M.merged, { target: target ?? '' })} <span className="badge">{fmt.number(merged.length)}</span>
              </h2>
              {merged.length ? <div className="git-rows">{merged.map(row)}</div> : <p className="hint">{tr(M.none)}</p>}
              <h2 className="section" data-leftover-group="unmerged">
                {tr(M.unmerged, { target: target ?? '' })} <span className="badge">{fmt.number(unmerged.length)}</span>
              </h2>
              {unmerged.length ? <div className="git-rows">{unmerged.map(row)}</div> : <p className="hint">{tr(M.none)}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
