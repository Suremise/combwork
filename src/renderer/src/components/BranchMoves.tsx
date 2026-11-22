import { useEffect, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import { MOVES_PAGE, type BranchMoves, type CommitLine, type MoveRow, type RestorePlan } from '@shared/gitMoves'
import { formatDateTime } from '@shared/dates'
import { msg, tr } from '@shared/i18n'
import { errorMessage } from '../api'
import { attempt } from '../actions'
import { cardNumberOf } from '../projectKeys'
import { offered, repoOp } from '../repoOps'
import { bumpGit, confirm, notify, set, useStore } from '../store'
import { useNow } from '../usage'
import { timeAgo } from '../util'
import { Pager } from './DataTable'
import { IconButton, Tooltip } from './ui'
import { CommitDialog } from './CommitDialog'

// HI-3469: History's Moves (SPEC §16.10.2, Moves): a local branch's moves as git's reflog keeps them, newest first, in
// plain words where Combwork knows them, each but the newest with Restore to here…, which asks first, showing what it
// would drop and bring back, and is checked again in main (gitMoves.ts).

export const MOVES_TEXT = {
  view: msg({ id: 'git.moves.view', defaultMessage: '{view, select, moves {Moves} other {Commits}}', description: "HI-3469: the two views of Version Control → History, a switch in its heading: the branch's commits, or its moves (git's reflog: each time the branch was moved, by a commit, a merge, a reset…). Keep the select keys." }),
  viewName: msg({ id: 'git.moves.viewName', defaultMessage: 'What History shows', description: "HI-3469: the name, for screen readers, of History's Commits | Moves switch." }),
  heading: msg({ id: 'git.moves.heading', defaultMessage: 'Moves of', description: "HI-3469: the heading of History's Moves, before the branch picker (a drop-down of the local branches)." }),
  branch: msg({ id: 'git.moves.branch', defaultMessage: 'Branch whose moves to show', description: "HI-3469: the name, for screen readers, of Moves' branch picker." }),
  option: msg({ id: 'git.moves.option', defaultMessage: '{kind, select, target {{branch} · target} folder {{branch} · project folder} other {{branch}}}', description: "HI-3469: a branch in Moves' picker: the project's target, the one the project folder has checked out, or another. Keep the select keys." }),
  reload: msg({ id: 'git.moves.reload', defaultMessage: 'Read the moves again', description: "HI-3469: the tooltip of Moves' refresh button." }),
  loadFailed: msg({ id: 'git.moves.loadFailed', defaultMessage: "Couldn't read the moves: {error}", description: 'HI-3469: in place of the moves when reading them failed. {error} is why.' }),
  about: msg({ id: 'git.moves.about', defaultMessage: "Each time the branch moved, newest first, as git's reflog keeps it (git forgets moves after about 90 days). Restore to here… moves it back to that commit.", description: "HI-3469: the hint atop History's Moves. Restore to here… is the button of that name." }),
  none: msg({ id: 'git.moves.none', defaultMessage: 'Git has no moves of this branch.', description: "HI-3469: Moves when the branch's reflog is empty (or git keeps none)." }),
  detached: msg({ id: 'git.moves.detached', defaultMessage: "The project folder is on a detached HEAD (no branch checked out): Moves shows a branch's moves once it is on one.", description: "HI-3469: Moves when the project folder has no branch checked out (git's detached HEAD)." }),
  noBranch: msg({ id: 'git.moves.noBranch', defaultMessage: 'The repository has no local branch yet.', description: 'HI-3469: Moves when there is no local branch to show.' }),
  what: msg({
    id: 'git.moves.what',
    defaultMessage:
      '{kind, select, commit {Committed} initial {First commit} amend {Amended the last commit} mergeCommit {Committed a merge} fastForward {Fast-forwarded to {name}} merge {Merged {name}} pull {Pulled} rebase {Rebased onto {name}} reset {Reset to {name}} created {Created from {name}} renamed {Renamed from {name}} cherryPick {Cherry-picked a commit} revert {Reverted a commit} combworkMerge {Combwork merged {name}} restored {Restored here with Combwork, from {name}} combwork {Combwork: {name}} unnamed {Moved (git noted no reason)} other {{name}}}',
    description: "HI-3469: what a move of a branch was, read from git's reflog. {name}: a branch, a commit's short id, a card's key (combworkMerge), Combwork's or git's own words (combwork, other: as they are, in English). Keep the select keys."
  }),
  now: msg({ id: 'git.moves.now', defaultMessage: 'now', description: "HI-3469: beside the newest move: where the branch is now." }),
  tip: msg({ id: 'git.moves.tip', defaultMessage: 'Git noted: {message}\n{commit}\n{when}', description: "HI-3469: the tooltip of a move: git's own words for it ({message}, English), the commit it left the branch at in full, and when." }),
  openCard: msg({ id: 'git.moves.openCard', defaultMessage: 'Open {card}', description: "HI-3469: the tooltip of a Combwork merge's card key in Moves: opens the card." }),
  restore: msg({ id: 'git.moves.restore', defaultMessage: 'Restore to here…', description: 'HI-3469: a move\'s button: moves the branch back to the commit of that move, after asking.' }),
  restoreTip: msg({ id: 'git.moves.restoreTip', defaultMessage: 'Moves {branch} back to {commit}, after showing what changes', description: "HI-3469: Restore to here…'s tooltip. {commit} is a short commit id." }),
  failed: msg({ id: 'git.moves.failed', defaultMessage: "Couldn't restore the branch", description: 'HI-3469: the title of the error notice when Restore to here… was refused or failed.' }),
  title: msg({ id: 'git.moves.title', defaultMessage: 'Restore {branch} to {commit}?', description: "HI-3469: the question of Restore to here…'s dialog. {commit} is a short commit id." }),
  cantTitle: msg({ id: 'git.moves.cantTitle', defaultMessage: "{branch} can't be restored now", description: "HI-3469: the title of Restore to here…'s dialog when something refuses it (said in the dialog)." }),
  confirm: msg({ id: 'git.moves.confirm', defaultMessage: 'Restore', description: "HI-3469: the confirm button of Restore to here…'s dialog." }),
  running: msg({ id: 'git.moves.running', defaultMessage: 'Restoring…', description: "HI-3469: Restore to here…'s button while it runs." }),
  moveLine: msg({ id: 'git.moves.moveLine', defaultMessage: '{branch} goes from {from} back to {to}.', description: 'HI-3469: the first line of Restore to here…\'s dialog. {from} and {to} are short commit ids.' }),
  whereProject: msg({ id: 'git.moves.whereProject', defaultMessage: 'The project folder has it checked out: its files follow (git reset --keep), and your uncommitted changes stay as they are.', description: "HI-3469: in Restore's dialog, for the project folder's own branch. Keep git reset --keep as it is: a command." }),
  whereNowhere: msg({ id: 'git.moves.whereNowhere', defaultMessage: "{branch} isn't checked out in any folder: only the branch moves.", description: "HI-3469: in Restore's dialog, for a branch checked out nowhere." }),
  dropped: msg({ id: 'git.moves.dropped', defaultMessage: '{n, plural, one {The commit it drops} other {The # commits it drops}}', description: "HI-3469: a heading in Restore's dialog: the commits the branch would no longer have (they stay in Moves, for a while)." }),
  back: msg({ id: 'git.moves.back', defaultMessage: '{n, plural, one {The commit it brings back} other {The # commits it brings back}}', description: "HI-3469: a heading in Restore's dialog: the commits the branch would have again." }),
  more: msg({ id: 'git.moves.more', defaultMessage: 'and {n, number} more', description: "HI-3469: under a list of commits in Restore's dialog: how many more are not listed." }),
  nothing: msg({ id: 'git.moves.nothing', defaultMessage: 'No commit is dropped or brought back: only where the branch points changes.', description: "HI-3469: in Restore's dialog when the two commits have the same history either way (rare)." }),
  pushed: msg({ id: 'git.moves.pushed', defaultMessage: '{n, plural, one {One of the dropped commits is} other {# of the dropped commits are}} on {upstream} already: a later Push is refused (Combwork never forces one), and Pull brings {n, plural, one {it} other {them}} back.', description: 'HI-3469: a warning in Restore\'s dialog: the branch\'s upstream ({upstream}, such as origin/main) has some of the commits it drops.' }),
  inTheWay: msg({ id: 'git.moves.inTheWay', defaultMessage: 'Uncommitted files the move would change', description: "HI-3469: a heading in Restore's dialog over the project folder's files with uncommitted changes that differ between the two commits: git refuses while there are any." }),
  wayBack: msg({ id: 'git.moves.wayBack', defaultMessage: 'The restore is itself a move: it shows at the top of Moves, and Restore to here… on the move below it undoes it.', description: "HI-3469: the last line of Restore's dialog: how to undo it." }),
  ok: msg({ id: 'git.moves.ok', defaultMessage: 'OK', description: "HI-3469: the button of Restore's dialog when it can't be done now." })
}
const T = MOVES_TEXT

/** A move's words. */
export const moveText = (m: Pick<MoveRow, 'kind' | 'name'>): string => tr(T.what, { kind: m.kind, name: m.name })

/** History's Commits | Moves switch. */
export function HistoryViewSwitch({ view, onView }: { view: 'commits' | 'moves'; onView: (v: 'commits' | 'moves') => void }) {
  if (!offered('git:moves')) return null
  return (
    <div className="segmented history-view" role="radiogroup" aria-label={tr(T.viewName)}>
      {(['commits', 'moves'] as const).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? 'active' : undefined} data-history-view={v} onClick={() => onView(v)}>
          {tr(T.view, { view: v })}
        </button>
      ))}
    </div>
  )
}

function CommitList({ commits, more }: { commits: CommitLine[]; more: number }) {
  return (
    <div className="restore-commits">
      {commits.map((c) => (
        <div key={c.hash} className="restore-commit">
          <code className="git-hash">{c.short}</code> <span>{c.subject}</span>
        </div>
      ))}
      {more > 0 && <div className="faint">{tr(T.more, { n: more })}</div>}
    </div>
  )
}

/** What Restore's dialog shows: where it runs, the commits either way, a pushed warning, the files in the way, the way back. */
function RestoreContent({ plan }: { plan: RestorePlan }) {
  const dropped = plan.dropped.length + plan.droppedMore
  const back = plan.back.length + plan.backMore
  return (
    <div className="restore-plan" data-restore-plan={plan.where} data-restore-blocked={plan.blocked ? '' : undefined}>
      {plan.blocked && <div className="banner warn" data-restore-why="">{plan.blocked}</div>}
      <p>{tr(T.moveLine, { branch: plan.branch, from: plan.from.slice(0, 7), to: plan.to.slice(0, 7) })}</p>
      <p className="faint">{plan.where === 'project' ? tr(T.whereProject) : tr(T.whereNowhere, { branch: plan.branch })}</p>
      {dropped > 0 && (
        <div data-restore-dropped={dropped}>
          <strong>{tr(T.dropped, { n: dropped })}</strong>
          <CommitList commits={plan.dropped} more={plan.droppedMore} />
        </div>
      )}
      {back > 0 && (
        <div data-restore-back={back}>
          <strong>{tr(T.back, { n: back })}</strong>
          <CommitList commits={plan.back} more={plan.backMore} />
        </div>
      )}
      {dropped === 0 && back === 0 && <p className="faint">{tr(T.nothing)}</p>}
      {plan.pushedDropped > 0 && plan.upstream && <div className="banner warn" data-restore-pushed={plan.pushedDropped}>{tr(T.pushed, { n: plan.pushedDropped, upstream: plan.upstream })}</div>}
      {plan.inTheWay.length > 0 && (
        <div data-restore-in-the-way={plan.inTheWay.length}>
          <strong>{tr(T.inTheWay)}</strong>
          <div className="restore-commits">
            {plan.inTheWay.map((f) => (
              <div key={f}>
                <code>{f}</code>
              </div>
            ))}
          </div>
        </div>
      )}
      {!plan.blocked && <p className="faint">{tr(T.wayBack)}</p>}
    </div>
  )
}

/** HI-3469: History's Moves: a local branch's moves, a page at a time, with Restore to here… on each but the newest. */
export function MovesSection({ project, view, onView }: { project: ProjectInfo; view: 'commits' | 'moves'; onView: (v: 'commits' | 'moves') => void }) {
  const [pick, setPick] = useState<{ for: string; branch: string | null; page: number }>({ for: project.path, branch: null, page: 1 })
  const mine = pick.for === project.path ? pick : { for: project.path, branch: null, page: 1 }
  const [state, setState] = useState<{ for: string; data: BranchMoves | null; error?: string } | null>(null)
  const [reads, setReads] = useState(0)
  // Read again when the project's git changes here (a commit, a merge), as History's commits are.
  const version = useStore((s) => s.gitVersion[project.path] ?? 0)
  const [busy, setBusy] = useState(false)
  // HI-3471: the commit whose dialog is open.
  const [shownCommit, setShownCommit] = useState<string | null>(null)
  useNow(60000)
  const key = JSON.stringify([project.path, mine.branch, mine.page])
  useEffect(() => {
    let live = true
    void repoOp('git:moves', project.path, mine.branch, mine.page).then(
      (data) => live && setState({ for: project.path, data }),
      (e) => live && setState({ for: project.path, data: null, error: errorMessage(e) })
    )
    return () => {
      live = false
    }
  }, [key, project.path, mine.branch, mine.page, reads, version])
  // The last answer stays while another page or branch is read; another project's never shows.
  const own = state?.for === project.path ? state : null
  const data = own?.data ?? null
  const reload = (): void => setReads((n) => n + 1)
  // What was done in a terminal meanwhile (a checkout, a reset) shows on coming back to the window, as History's commits.
  useEffect(() => {
    const again = (): void => setReads((n) => n + 1)
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [])
  const optionText = (m: BranchMoves, b: string): string => tr(T.option, { branch: b, kind: b === m.target ? 'target' : b === m.folderBranch ? 'folder' : 'other' /* i18n-ignore: a select's key, never shown */ })

  const restore = async (m: BranchMoves, row: MoveRow): Promise<void> => {
    if (busy || !m.branch || !m.head) return
    const req = { branch: m.branch, from: m.head, to: row.commit }
    setBusy(true)
    const plan = await attempt(tr(T.failed), () => repoOp('git:restorePlan', project.path, req))
    setBusy(false)
    if (!plan) return reload()
    if (plan.blocked) {
      await confirm({ title: tr(T.cantTitle, { branch: plan.branch }), message: '', content: <RestoreContent plan={plan} />, okOnly: true, confirmLabel: tr(T.ok) })
      return
    }
    await confirm({
      title: tr(T.title, { branch: plan.branch, commit: plan.to.slice(0, 7) }),
      message: '',
      content: <RestoreContent plan={plan} />,
      confirmLabel: tr(T.confirm),
      busyLabel: tr(T.running),
      danger: true,
      run: async () => notify('success', await repoOp('git:restore', project.path, req))
    })
    bumpGit(project.path)
    reload()
  }

  return (
    <div className="git-history git-moves" data-git-moves="" data-moves-branch={data?.branch ?? ''} data-moves-page={data?.page ?? 1}>
      <h2 className="section git-section-head">
        <HistoryViewSwitch view={view} onView={onView} />
        {data?.branch && (
          <>
            <span className="faint">{tr(T.heading)}</span>
            <select className="select git-history-branch" aria-label={tr(T.branch)} data-moves-picker="" value={data.branch} onChange={(e) => setPick({ for: project.path, branch: e.target.value, page: 1 })}>
              {data.branches.map((b) => (
                <option key={b} value={b}>
                  {optionText(data, b)}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="git-section-actions">
          <IconButton icon="refresh" title={tr(T.reload)} action="reload-moves" onClick={reload} />
        </span>
      </h2>
      {own?.error && !data ? (
        <p className="hint" data-moves-error="">
          {tr(T.loadFailed, { error: own.error })}
        </p>
      ) : !data ? null : data.detached ? (
        <p className="hint" data-moves-detached="">
          {tr(T.detached)}
        </p>
      ) : !data.branch ? (
        <p className="hint">{tr(T.noBranch)}</p>
      ) : data.moves.length === 0 ? (
        <p className="hint" data-moves-none="">
          {tr(T.none)}
        </p>
      ) : (
        <>
          <p className="hint">{tr(T.about)}</p>
          <div className="git-rows">
            {data.moves.map((row) => {
              const card = row.kind === 'combworkMerge' ? row.name : null
              const n = card ? cardNumberOf(card) : null
              const current = row.commit === data.head
              return (
                <div key={row.index} className="git-row git-move" data-move={row.index} data-move-kind={row.kind}>
                  <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{tr(T.tip, { message: row.message || '—', commit: row.commit, when: formatDateTime(row.at) })}</span>}>
                    <span className="git-move-what">{moveText(row)}</span>
                  </Tooltip>
                  {card && n !== null && (
                    <Tooltip content={tr(T.openCard, { card })}>
                      <button type="button" className="btn small subtle" data-action="move-card" onClick={() => set({ taskOpen: n })}>
                        {card}
                      </button>
                    </Tooltip>
                  )}
                  <span className="git-move-commit clickable" data-action="move-commit" onClick={() => offered('git:commitDetail') && setShownCommit(row.commit)}>
                    <code className="git-hash">{row.short}</code> <span className="git-subject faint">{row.subject}</span>
                  </span>
                  <span className="git-meta faint">{row.index === 0 ? tr(T.now) : row.at ? timeAgo(new Date(row.at).toISOString()) : ''}</span>
                  {!current && offered('git:restore') && (
                    <Tooltip content={tr(T.restoreTip, { branch: data.branch ?? '', commit: row.short })}>
                      <button type="button" className="btn small" data-action="move-restore" disabled={busy} onClick={() => void restore(data, row)}>
                        {tr(T.restore)}
                      </button>
                    </Tooltip>
                  )}
                </div>
              )
            })}
          </div>
          {data.pages > 1 && <Pager page={data.page} pages={data.pages} from={(data.page - 1) * MOVES_PAGE + 1} to={Math.min(data.page * MOVES_PAGE, data.total)} total={data.total} onPage={(page) => setPick({ ...mine, branch: data.branch, page })} />}
        </>
      )}
      {shownCommit && <CommitDialog project={project} commit={shownCommit} onClose={() => setShownCommit(null)} />}
    </div>
  )
}
