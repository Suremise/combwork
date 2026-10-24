import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo, UnusedWorktree, UnusedWorktreePreview, UnusedWorktreeRemoval, UnusedWorktrees } from '@shared/types'
import { formatSize } from '@shared/units'
import { RecentCache } from '@shared/recentCache'
import { CHANGES_ABOUT, UNUSED_WORKTREES_GUIDE, holdsWork, isSlotRow, kindLabel, lostByRemoving, originLabel, unusedName, unusedState, unusedSummary, unusedWorkNotice } from '@shared/unusedWorktrees'
import { call, errorMessage } from '../api'
import { confirm, notify, showUnusedWorktrees, useStore } from '../store'
import { openGuideAt } from '../tips'
import { cx, timeAgo } from '../util'
import { BusyButton, Icon, InfoTip } from './ui'
import { ItemTable, ShortPath, type ItemRow } from './ItemTable'
import { useStorageRequests } from './Storage'
import { msg, tr } from '@shared/i18n'
import { agentFolder } from '../agentPlace'

const M = {
  loading: msg({ id: 'workspace.unusedList.loading', defaultMessage: 'Loading…', description: "The Changes tab's Unused worktrees while git lists them." }),
  gitProblem: msg({ id: 'workspace.unusedList.gitProblem', defaultMessage: "{problem}, so Hive can't list the unused worktrees.", description: "The Changes tab's Unused worktrees when git can't run ({problem}: what is wrong with git)." }),
  none: msg({ id: 'workspace.unusedList.none', defaultMessage: '{project} has no unused worktrees: every worktree belongs to an agent.', description: "The Changes tab's Unused worktrees with none." }),
  mainBranch: msg({ id: 'workspace.unusedList.mainBranch', defaultMessage: 'the main branch', description: "Unused worktrees: what they'd be merged into when git doesn't say which branch. Lower case." }),
  keptTitle: msg({ id: 'workspace.unusedList.keptTitle', defaultMessage: '{name} was kept', description: "A notice: an unused worktree ({name}: its branch or folder) wasn't removed; the reason follows." }),
  branchKept: msg({ id: 'workspace.unusedList.branchKept', defaultMessage: '{path} was removed, its branch kept', description: "A notice: an unused worktree's folder went but its branch stayed; the reason follows." }),
  removeFailed: msg({ id: 'workspace.unusedList.removeFailed', defaultMessage: "Couldn't remove the worktree", description: 'An error notice; the reason follows.' }),
  removeMergedTitle: msg({ id: 'workspace.unusedList.removeMergedTitle', defaultMessage: 'Remove {count, plural, one {# merged worktree} other {# merged worktrees}}?', description: 'Confirmation before Remove all merged.' }),
  removeMergedMessage: msg({ id: 'workspace.unusedList.removeMergedMessage', defaultMessage: 'Each is merged into {into} and clean: its folder and its branch are deleted. One that changed since is kept.', description: 'Confirmation before Remove all merged ({into}: the main branch). The worktrees follow, one a line.' }),
  remove: msg({ id: 'workspace.unusedList.remove', defaultMessage: 'Remove', description: "Remove all merged's confirmation, and a merged worktree's button." }),
  removing: msg({ id: 'workspace.unusedList.removing', defaultMessage: 'Removing…', description: 'A remove button while it works.' }),
  keptReason: msg({ id: 'workspace.unusedList.keptReason', defaultMessage: 'kept', description: "A line after Remove all merged, for a worktree kept with no reason given (it follows its branch and a colon). Lower case." }),
  keptMany: msg({ id: 'workspace.unusedList.keptMany', defaultMessage: '{count, plural, one {# worktree was kept} other {# worktrees were kept}}', description: 'A notice after Remove all merged: some stayed (why follows, one a line).' }),
  nothingRemoved: msg({ id: 'workspace.unusedList.nothingRemoved', defaultMessage: 'Nothing was removed', description: 'An error notice: Remove anyway checked the worktree again and that failed.' }),
  checkFailed: msg({ id: 'workspace.unusedList.checkFailed', defaultMessage: '{refused}. Checking it again failed: {error}', description: "Under Nothing was removed: why the first try was refused ({refused}), and why checking again failed ({error})." }),
  anywayAgainTitle: msg({ id: 'workspace.unusedList.anywayAgainTitle', defaultMessage: 'Checked again: remove it anyway?', description: 'Confirmation before Remove anyway, after a first try was refused because the worktree changed.' }),
  anywayTitle: msg({ id: 'workspace.unusedList.anywayTitle', defaultMessage: 'Remove the worktree anyway?', description: 'Confirmation before Remove anyway: the worktree holds work that is nowhere else.' }),
  anywayMessage: msg({ id: 'workspace.unusedList.anywayMessage', defaultMessage: '{again, select, yes {Nothing was removed: {refused}. As it is now, this} other {This}} deletes {path}{hasBranch, select, yes { and its branch {branch}} other {}}, with work that is nowhere else:', description: 'Confirmation before Remove anyway. What would be lost follows, one a line. {refused}: why the first try was refused.' }),
  anywayDetail: msg({ id: 'workspace.unusedList.anywayDetail', defaultMessage: "It can't be undone. If anything in it changes before you confirm (a file, its branch, its commit), nothing is removed.", description: 'Confirmation before Remove anyway.' }),
  removeAnyway: msg({ id: 'workspace.unusedList.removeAnyway', defaultMessage: 'Remove Anyway', description: "Remove anyway's confirmation: its button." }),
  changed: msg({ id: 'workspace.unusedList.changed', defaultMessage: 'what it holds changed', description: 'Why Remove anyway removed nothing, when Hive gave no other reason. Lower case: it follows "Nothing was removed:".' }),
  removeAllMerged: msg({ id: 'workspace.unusedList.removeAllMerged', defaultMessage: 'Remove all merged ({count})…', description: "The Changes tab's Unused worktrees: removes every merged, clean one." }),
  detached: msg({ id: 'workspace.unusedList.detached', defaultMessage: '(detached)', description: 'An unused worktree with no branch (a detached HEAD).' }),
  measuring: msg({ id: 'workspace.unusedList.measuring', defaultMessage: 'measuring…', description: "An unused worktree's size while Storage measures it. Lower case." }),
  openTip: msg({ id: 'workspace.unusedList.openTip', defaultMessage: "{work, select, yes {Show {branch}'s changes, and merge them} other {Show {branch}'s changes}}", description: "Tooltip on an unused worktree's Open." }),
  open: msg({ id: 'workspace.unusedList.open', defaultMessage: 'Open', description: "An unused worktree's button: shows its changes." }),
  checking: msg({ id: 'workspace.unusedList.checking', defaultMessage: 'Checking…', description: 'Remove anyway while it checks the worktree.' }),
  removeAnywayButton: msg({ id: 'workspace.unusedList.removeAnywayButton', defaultMessage: 'Remove anyway…', description: "An unused worktree's button when it holds work." }),
  heading: msg({ id: 'workspace.unusedList.heading', defaultMessage: 'Unused worktrees', description: "The Changes tab's Unused worktrees page: its heading (a count follows)." }),
  learnMore: msg({ id: 'workspace.unusedList.learnMore', defaultMessage: 'Learn more', description: 'Unused worktrees: opens the user guide there.' }),
  review: msg({ id: 'workspace.unusedList.review', defaultMessage: 'Review', description: "The Changes tab's notice on unused worktrees holding work: shows them." }),
  colBranch: msg({ id: 'workspace.unusedList.colBranch', defaultMessage: 'Branch', description: "Unused worktrees' table (#1314), a column heading: the worktree's branch." }),
  colState: msg({ id: 'workspace.unusedList.colState', defaultMessage: 'State', description: "Unused worktrees' table, a column heading: merged and clean, or the work it holds, and who made it." }),
  colFolder: msg({ id: 'workspace.unusedList.colFolder', defaultMessage: 'Folder', description: "Unused worktrees' table, a column heading: the worktree's folder (its name; the full path on hover)." }),
  colLast: msg({ id: 'workspace.unusedList.colLast', defaultMessage: 'Last commit', description: "Unused worktrees' table, a column heading: its branch's last commit, when and its subject." }),
  colSize: msg({ id: 'workspace.unusedList.colSize', defaultMessage: 'Size', description: "Unused worktrees' table, a column heading: the folder's size on disk." }),
  reviewInChanges: msg({ id: 'workspace.unusedList.reviewInChanges', defaultMessage: 'Review in Changes', description: "The Overview's line on unused worktrees: shows them in the Git tab's Changes." })
}

/**
 * Each project's unused worktrees as last listed (#476), with when: shown at once, while git is asked again, by every
 * list of them. The window's workspace's only (switching workspace empties it), and the 20 projects shown last.
 */
const lastListed = new RecentCache<{ data: UnusedWorktrees; at: number }>(20)

/**
 * The project's unused worktrees, as git says now: loaded again when its agents' worktrees change, when one changed
 * outside the list (a merge of one, `bumpUnused`), or on `reload`. Listing reads git for each worktree, which takes a
 * while: the last list shows meanwhile (`loading`; `at`, when it was read), and `error` says why the latest listing
 * failed (with or without a list from before).
 */
export function useUnusedWorktrees(project: ProjectInfo): { data: UnusedWorktrees | null; reload: () => void; loading: boolean; error: string | null; at: number } {
  const cacheKey = project.path.toLowerCase()
  const wsPath = useStore((s) => s.workspace?.path ?? null)
  const fromCache = useCallback(() => lastListed.scope(wsPath).get(cacheKey) ?? null, [wsPath, cacheKey])
  const [data, setData] = useState<UnusedWorktrees | null>(() => fromCache()?.data ?? null)
  const [at, setAt] = useState(() => fromCache()?.at ?? 0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loads = useRef(0)
  // The folders the agents work in (#1452: their place, a 0.9 worktree or a slot): one an agent leaves (removed, its
  // worktree kept, or a lease ended) changes the list.
  const trees = project.agents.map((a) => agentFolder(a)).join('|')
  const version = useStore((s) => s.unusedVersion[project.path] ?? 0)
  const reload = useCallback(() => {
    const n = ++loads.current
    setLoading(true)
    void call('worktrees:unused', project.path).then(
      (d) => {
        if (n !== loads.current) return
        const now = Date.now()
        lastListed.scope(wsPath).set(cacheKey, { data: d, at: now })
        setData(d)
        setAt(now)
        setError(null)
        setLoading(false)
      },
      (e) => {
        if (n !== loads.current) return
        setError(errorMessage(e))
        setLoading(false)
      }
    )
  }, [project.path, cacheKey, wsPath])
  useEffect(() => {
    const c = fromCache()
    setData(c?.data ?? null)
    setAt(c?.at ?? 0)
    setError(null)
    reload()
  }, [reload, trees, fromCache])
  // Changed elsewhere: the list stays shown while it loads again.
  useEffect(() => {
    if (version) reload()
  }, [version, reload])
  return { data, reload, loading, error, at }
}

/**
 * The Changes tab's "Unused worktrees (n)" (#353, moved there from the Overview by #400): worktrees no agent works in,
 * each merged and clean (Remove, with its branch) or holding work (what is at stake, Remove anyway…), with their last
 * commit and size, and Open to see its changes (and merge them) like an agent's worktree.
 * Removing is the user's: the Assistant can only see them.
 */
export function UnusedWorktreesSection({ project, data, reload, onOpen }: { project: ProjectInfo; data: UnusedWorktrees | null; reload: () => void; onOpen: (path: string) => void }) {
  const [sizes, setSizes] = useState<Record<string, number> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const request = useStorageRequests()
  const list = data?.worktrees ?? []
  const paths = list.map((w) => w.path).join('|')

  // Sizes as Storage measures them (once, cached there; cancelled when the Overview closes).
  useEffect(() => {
    setSizes(null)
    if (!paths) return
    const { result, current } = request((r) => call('storage:project', project.path, false, r))
    void result.then(
      (s) => current() && setSizes(Object.fromEntries((s.unusedWorktrees ?? []).map((w) => [w.path.toLowerCase(), w.bytes]))),
      () => undefined
    )
  }, [paths, project.path, request])

  if (!data) return <div className="empty-state"><Icon name="loading" spin />{tr(M.loading)}</div>
  if (!list.length)
    return (
      <div className="unused-worktrees">
        <UnusedHeading project={project} count={0} />
        <div className="empty-state">{data.gitProblem ? tr(M.gitProblem, { problem: data.gitProblem }) : tr(M.none, { project: project.name })}</div>
      </div>
    )
  const merged = list.filter((w) => w.check.removable)
  const into = list.find((w) => w.check.into)?.check.into ?? tr(M.mainBranch)

  const removeOne = async (w: UnusedWorktree): Promise<void> => {
    setBusy(w.path)
    try {
      const r = await call('worktrees:removeUnused', project.path, w.path, { expectInto: w.check.into })
      if (!r.deleted) notify('warning', tr(M.keptTitle, { name: w.slot ?? w.branch ?? w.path }), r.reason)
      else if (r.branchKept) notify('warning', tr(M.branchKept, { path: w.path }), r.reason)
    } catch (e) {
      notify('error', tr(M.removeFailed), errorMessage(e))
    } finally {
      setBusy(null)
      reload()
    }
  }

  const removeMerged = async (): Promise<void> => {
    const kept: string[] = []
    const ok = await confirm({
      title: tr(M.removeMergedTitle, { count: merged.length }),
      message: tr(M.removeMergedMessage, { into }),
      content: <ItemTable first={M.colBranch} columns={[{ label: M.colFolder }]} rows={merged.map((w) => ({ key: w.path, item: <strong title={w.branch ?? undefined}>{unusedName(w)}</strong>, text: unusedName(w), cells: [{ content: <ShortPath path={w.path} />, text: w.path }] }))} className="fill unused-merged-table" />,
      confirmLabel: tr(M.remove),
      busyLabel: tr(M.removing),
      run: async () => {
        for (const w of merged) {
          const r = await call('worktrees:removeUnused', project.path, w.path, { expectInto: w.check.into }).catch((e: unknown) => ({ deleted: false, reason: errorMessage(e) }))
          if (!r.deleted) kept.push(`${unusedName(w)}: ${r.reason ?? tr(M.keptReason)}`)
        }
      }
    })
    reload()
    if (ok && kept.length) notify('warning', tr(M.keptMany, { count: kept.length }), kept.join('\n'))
  }

  // What it loses, checked now in main (not the list's older counts), under a token the removal presents: main removes it
  // only if nothing in it changed since (#353), and spends the token whatever comes of it (#373). A refusal never leaves
  // the question offering to try that token again (#377): it closes, and when a new look settles it (expired, or the
  // worktree changed) a new preview is taken and asked about afresh, its own token and loss list, nothing removed meanwhile.
  const removeAnyway = async (w: UnusedWorktree): Promise<void> => {
    let refused: string | null = null
    for (;;) {
      setBusy(w.path)
      let preview: UnusedWorktreePreview
      try {
        preview = await call('worktrees:removalPreview', project.path, w.path)
      } catch (e) {
        notify('error', tr(M.nothingRemoved), refused ? tr(M.checkFailed, { refused, error: errorMessage(e) }) : errorMessage(e))
        break
      } finally {
        setBusy(null)
      }
      const outcome: { removal: UnusedWorktreeRemoval | null; error: string | null } = { removal: null, error: null }
      const ok = await confirm({
        title: tr(refused ? M.anywayAgainTitle : M.anywayTitle),
        message: tr(M.anywayMessage, { again: refused ? 'yes' : 'no', refused: refused ?? '', path: preview.path, hasBranch: preview.branch ? 'yes' : 'no', branch: preview.branch ?? '' }),
        list: preview.lost,
        detail: tr(M.anywayDetail),
        danger: true,
        confirmLabel: tr(M.removeAnyway),
        busyLabel: tr(M.removing),
        run: async () => {
          // Never thrown: a failed run would offer Try Again with this spent token.
          outcome.removal = await call('worktrees:removeUnused', project.path, w.path, { force: preview.token }).catch((e: unknown) => {
            outcome.error = errorMessage(e)
            return null
          })
        }
      })
      if (!ok) break
      const r = outcome.removal
      if (outcome.error || !r) {
        notify('error', tr(M.removeFailed), outcome.error ?? undefined)
        break
      }
      if (r.deleted) {
        if (r.branchKept) notify('warning', tr(M.branchKept, { path: w.path }), r.reason)
        break
      }
      if (!r.lookAgain) {
        notify('warning', tr(M.keptTitle, { name: w.slot ?? w.branch ?? w.path }), r.reason)
        break
      }
      // Looking again is what follows: the question says why the first try removed nothing (#848: main's reason is just that).
      refused = r.reason ?? tr(M.changed)
    }
    // Removed, kept or cancelled: the list as it is now.
    reload()
  }

  return (
    <div className="unused-worktrees">
      <UnusedHeading project={project} count={list.length} into={into}>
        {merged.length > 0 && (
          <button className="btn small" onClick={() => void removeMerged()}>
            {tr(M.removeAllMerged, { count: merged.length })}
          </button>
        )}
      </UnusedHeading>
      <ItemTable
        first={M.colBranch}
        columns={[{ label: M.colState }, { label: M.colFolder }, { label: M.colLast }, { label: M.colSize }]}
        rows={list.map((w): ItemRow => {
          const size = sizes?.[w.path.toLowerCase()]
          const last = w.lastCommit ? tr(msg({ id: 'workspace.unusedList.lastCommit', defaultMessage: '{when}: {subject}', description: "An unused worktree's last commit: when it was made ({when}: \"2 days ago\") and its subject line. Your language's punctuation goes around the colon." }), { when: timeAgo(w.lastCommit.at), subject: w.lastCommit.subject }) : ''
          const sized = size === undefined ? (sizes ? '' : tr(M.measuring)) : formatSize(size)
          return {
            key: w.path,
            className: 'unused-wt',
            data: { path: w.path, ...(w.kind ? { kind: w.kind } : {}), ...(w.slot ? { slot: w.slot } : {}) },
            item: (
              <span className="unused-wt-branch">
                <Icon name={isSlotRow(w) ? 'repo' : 'git-branch'} /> <strong title={w.branch ?? undefined}>{unusedName(w)}</strong>
              </span>
            ),
            text: unusedName(w),
            cells: [
              {
                content: (
                  <span className="unused-wt-badges">
                    <span className={cx('badge', w.check.removable ? 'success' : holdsWork(w) ? 'warn' : '')} title={w.check.reason && isSlotRow(w) ? `${unusedState(w)} (${w.check.reason})` : unusedState(w)}>
                      {unusedState(w)}
                    </span>
                    {w.kind ? (
                      <span className="badge accent" data-unused-kind={w.kind} title={kindLabel(w)}>
                        {kindLabel(w)}
                      </span>
                    ) : w.origin && (
                      <span className={cx('badge', w.origin.madeBy === 'other' && 'accent')} data-origin={w.origin.madeBy} title={originLabel(w)}>
                        {originLabel(w)}
                      </span>
                    )}
                  </span>
                ),
                text: [unusedState(w), kindLabel(w) || originLabel(w)].filter(Boolean).join(' · ')
              },
              { content: <ShortPath path={w.path} className="muted" />, text: w.path },
              { content: <span className="faint" title={last || undefined}>{last}</span>, text: last, className: 'unused-wt-last' },
              { content: <span className="faint">{sized}</span>, text: sized, className: 'unused-wt-size' }
            ],
            actions: (
              <>
                {(w.branch || isSlotRow(w)) && (
                  <button className="btn small subtle" title={tr(M.openTip, { branch: unusedName(w), work: holdsWork(w) && w.branch ? 'yes' : 'no' })} onClick={() => onOpen(w.path)}>
                    {tr(M.open)}
                  </button>
                )}
                {w.check.removable ? (
                  <BusyButton className="btn small" busy={busy === w.path} busyLabel={tr(M.removing)} disabled={!!busy} onClick={() => void removeOne(w)}>
                    {tr(M.remove)}
                  </BusyButton>
                ) : isSlotRow(w) ? null : (
                  // Its work is kept by Open (its changes, merged through the Merge dialog) or let go by Remove anyway…;
                  // no agent is given a worktree in 1.0 (#1555: slots are lent per card or lane, #1451).
                  lostByRemoving(w) && (
                    <BusyButton className="btn small danger-text" busy={busy === w.path} busyLabel={tr(M.checking)} disabled={!!busy} onClick={() => void removeAnyway(w)}>
                      {tr(M.removeAnywayButton)}
                    </BusyButton>
                  )
                )}
              </>
            )
          }
        })}
        className={cx(/* i18n-ignore: class names */ 'unused-wt-table', list.some((w) => !w.check.removable && !isSlotRow(w) && lostByRemoving(w)) && 'has-work')}
      />
    </div>
  )
}

/**
 * The unused worktrees page's header (#476): its title, count and actions, and the one sentence saying what the page
 * shows (the Changes tab's description of it, on the right, whether the list is loading, empty or listed).
 */
export function UnusedHeading({ project, count, into, children }: { project: ProjectInfo; count?: number; into?: string; children?: React.ReactNode }) {
  return (
    <>
      <h2 className="section" id="unused-worktrees">
        <span className="unused-title">{tr(M.heading)}</span> {count !== undefined && <span className="badge">{count}</span>}
        <InfoTip text={CHANGES_ABOUT.unusedTip(into ?? null)} />
        <div className="grow" />
        {children}
        <button className="btn small subtle" onClick={() => openGuideAt(UNUSED_WORKTREES_GUIDE)}>
          {tr(M.learnMore)}
        </button>
      </h2>
      <p className="hint changes-about" data-about="unused">
        {CHANGES_ABOUT.unused(project.name)}
      </p>
    </>
  )
}

/** The Changes tab's notice (#353): only when an unused worktree holds work that isn't on the main branch. */
export function UnusedWorkNotice({ project, data }: { project: ProjectInfo; data: UnusedWorktrees | null }) {
  const text = data ? unusedWorkNotice(data.worktrees) : null
  if (!text) return null
  return (
    <div className="unused-work-notice">
      <Icon name="git-branch" />
      <span>{text}</span>
      <a onClick={() => showUnusedWorktrees(project.path)}>{tr(M.review)}</a>
    </div>
  )
}

/** The Overview's one line (#400): "7 unused worktrees (7 merged) — Review in Changes". Nothing with none. */
export function UnusedWorktreesLine({ project }: { project: ProjectInfo }) {
  const { data } = useUnusedWorktrees(project)
  const text = data ? unusedSummary(data.worktrees) : null
  if (!text) return null
  return (
    <div className="unused-worktrees-line">
      <Icon name="git-branch" />
      <span>{text}</span>
      <span className="faint">—</span>
      <a onClick={() => showUnusedWorktrees(project.path)}>{tr(M.reviewInChanges)}</a>
    </div>
  )
}
