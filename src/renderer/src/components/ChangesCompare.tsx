import { useEffect, useState } from 'react'
import type { ProjectInfo, GitDiff } from '@shared/types'
import type { CompareLines, GitCommitRow, GitComparison } from '@shared/gitRepo'
import { COMPARE_COMMITS } from '@shared/gitRepo'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { cardLabelOf, useStore } from '../store'
import { at, useGitRead } from '../views/GitTab'
import { cx } from '../util'
import { languageFor } from '../monacoLang'
import { Pager } from './DataTable'
import { DiffView } from './Editors'
import { GitlinkDiff } from './GitlinkDiff'
import { PaneResizer } from './Resizer'
import { Icon, IconButton, LoadFailed, StaleNote, Tooltip } from './ui'

/**
 * The Changes tab's comparison of two branches (HI-1824): any two local branches, such as the project's integration line
 * and main, with no folder of their own (since slots, no agent keeps a worktree on a long-lived branch to compare from).
 * Read-only (gitCompare.ts): the commits each side has, the files head changes since it left base, and a file's diff,
 * read only when it is opened.
 */

const M = {
  group: msg({ id: 'project.compare.group', defaultMessage: 'Branches (compared, nothing checked out)', description: "A group of the Changes tab's picker: comparisons of two branches, read without checking anything out." }),
  option: msg({ id: 'project.compare.option', defaultMessage: '{head} ↔ {base}', description: "A comparison in the Changes tab's picker: the branch {head} against {base}." }),
  slotsGroup: msg({ id: 'project.compare.slotsGroup', defaultMessage: 'Slots (each one’s branch, compared)', description: "A group of the Changes tab's picker: the project's slots (working folders lent to cards), each opening its branch compared with where it merges." }),
  slotOption: msg({ id: 'project.compare.slotOption', defaultMessage: '{slot} · {card, select, none {free} other {{card}}} · {branch}', description: "A slot in the Changes tab's picker: its name {slot}, the card it is lent to ({card}; none: free, no card) and its branch {branch}." }),
  commitsHint: msg({ id: 'project.compare.commitsHint', defaultMessage: 'On the right: {head}’s commits that {base} hasn’t, then {base}’s that {head} hasn’t.', description: "The left caption of the Changes tab's comparison while it shows the commits: each side's commits are listed on the right." }),
  filesHint: msg({ id: 'project.compare.filesHint', defaultMessage: 'The files {head} changes since it left {base}. Swap to see {base}’s.', description: "Above the files in the Changes tab's comparison: they are only the branch's own changes, since the commit where it left the other." }),
  about: msg({ id: 'project.compare.about', defaultMessage: 'What {head} changes since it left {base}: its commits that {base} hasn’t, and the files they change. Read from git, nothing checked out.', description: "The sentence at the top of the Changes tab's comparison of two branches." }),
  head: msg({ id: 'project.compare.head', defaultMessage: 'Branch', description: "A label in the Changes tab's comparison: the branch whose changes are shown." }),
  base: msg({ id: 'project.compare.base', defaultMessage: 'Against', description: "A label in the Changes tab's comparison: the branch it is compared with." }),
  swap: msg({ id: 'project.compare.swap', defaultMessage: 'Swap the branches', description: "A button in the Changes tab's comparison: compares the other way round." }),
  counts: msg({ id: 'project.compare.counts', defaultMessage: '{head} has {ahead, plural, one {# commit} other {# commits}} {base} hasn’t; {base} has {behind, plural, one {# commit} other {# commits}} {head} hasn’t.', description: "The line under the branches in the Changes tab's comparison: how many commits each has that the other hasn't." }),
  parted: msg({ id: 'project.compare.parted', defaultMessage: 'They parted at {commit}.', description: "In the Changes tab's comparison: the commit where the two branches' histories split." }),
  unrelated: msg({ id: 'project.compare.unrelated', defaultMessage: 'They share no history: the files are {base} against {head}.', description: "In the Changes tab's comparison: the two branches have no commit in common." }),
  files: msg({ id: 'project.compare.files', defaultMessage: 'Files', description: "A switch in the Changes tab's comparison: the changed files." }),
  commits: msg({ id: 'project.compare.commits', defaultMessage: 'Commits', description: "A switch in the Changes tab's comparison: each side's commits." }),
  noFiles: msg({ id: 'project.compare.noFiles', defaultMessage: '{head} changes no files since it left {base}.', description: "The Changes tab's comparison when the branch changes nothing." }),
  moreFiles: msg({ id: 'project.compare.moreFiles', defaultMessage: 'Show more ({shown, number} of {total, number})', description: "A button under the Changes tab's comparison's files: lists more of them." }),
  cut: msg({ id: 'project.compare.cut', defaultMessage: 'Only the first {shown, number} of {total, number} files are listed.', description: "Under the Changes tab's comparison's files when there are more than Combwork lists." }),
  onlyHead: msg({ id: 'project.compare.onlyHead', defaultMessage: 'On {head}, not on {base}', description: "A heading in the Changes tab's comparison: the commits the branch {head} has that {base} hasn't." }),
  none: msg({ id: 'project.compare.none', defaultMessage: 'None.', description: "Under a heading of the Changes tab's comparison's commits: there are none." }),
  load: msg({ id: 'project.compare.load', defaultMessage: 'the comparison', description: "What couldn't be read, in an error in the Changes tab: the comparison of two branches." }),
  loading: msg({ id: 'project.compare.loading', defaultMessage: 'Comparing {head} with {base}…', description: "While the Changes tab compares two branches." }),
  refresh: msg({ id: 'project.compare.refresh', defaultMessage: 'Compare again', description: "A button in the Changes tab's comparison: reads both branches again." }),
  selectFile: msg({ id: 'project.compare.selectFile', defaultMessage: 'Select a file to see what {head} changed in it.', description: "The Changes tab's comparison with no file chosen." }),
  loadingDiff: msg({ id: 'project.compare.loadingDiff', defaultMessage: 'Loading the diff…', description: "While a file's diff in the Changes tab's comparison is read." }),
  diffFailed: msg({ id: 'project.compare.diffFailed', defaultMessage: "Couldn't show this file's changes: {error}", description: "An error in the Changes tab's comparison: a file's diff couldn't be read." }),
  retry: msg({ id: 'project.compare.retry', defaultMessage: 'Try again', description: 'A button after an error in the Changes tab.' }),
  sideBySide: msg({ id: 'project.compare.sideBySide', defaultMessage: 'Side by side', description: "A button in the Changes tab's comparison: shows a diff as two columns." }),
  binary: msg({ id: 'project.compare.binary', defaultMessage: 'A binary file: its changes can’t be shown.', description: "In place of a file's diff in the Changes tab's comparison: the file isn't text." }),
  inline: msg({ id: 'project.compare.inline', defaultMessage: 'Inline', description: "A button in the Changes tab's comparison: shows a diff in one column." }),
  status: msg({ id: 'project.compare.status', defaultMessage: '{status, select, M {Modified} A {Added} D {Deleted} T {Type changed} other {{status}}}: {path}', description: "Tooltip on a file in the Changes tab's comparison: how the branch changed it." }),
  commitTip: msg({ id: 'project.compare.commitTip', defaultMessage: '{hash}\n{author} <{email}>\n{when}', description: "Tooltip on a commit in the Changes tab's comparison: its whole hash, its author and when." })
}

/** The Changes tab's page for a comparison: `compare:<base>:<head>` (a branch name never has a colon). */
export const COMPARE_ROOT = 'compare'
export const compareRoot = (base: string, head: string): string => `${COMPARE_ROOT}:${base}:${head}`
export function parseCompareRoot(id: string): { base: string; head: string } | null {
  const m = /^compare:([^:]+):([^:]+)$/.exec(id)
  return m ? { base: m[1], head: m[2] } : null
}

/** The other side a branch is compared with by default: the integration line, or main for it (and for none). */
export function defaultBase(lines: CompareLines, head: string): string | null {
  const base = head === lines.integration || !lines.integration ? lines.main : lines.integration
  return base && base !== head ? base : null
}

/** What the picker lists. */
export function useCompareLines(project: ProjectInfo): { lines: CompareLines | null; known: boolean } {
  const read = useGitRead('git:compareLines', project)
  return { lines: read.data, known: !!read.data || !!read.error }
}

/**
 * The picker's comparisons. **Branches:** the integration line against main first, then each local branch no slot has
 * checked out, against its default. **Slots:** each slot whose folder has a branch (a free one, one whose card is
 * blocked), its branch against the slot's target, else its default (the board's records, read without making the pool).
 * A branch is listed once.
 */
export function CompareGroup({ lines, value, last }: { lines: CompareLines; value: string; last?: React.ReactNode }) {
  const tasks = useStore((s) => s.tasks)
  const first = lines.integration && lines.main ? compareRoot(lines.main, lines.integration) : null
  const inSlot = new Set(lines.slots.map((s) => s.branch))
  const has = (b: string | null): b is string => !!b && lines.branches.some((x) => x.name === b)
  const rows = lines.branches.flatMap((b) => {
    const base = defaultBase(lines, b.name)
    const id = base ? compareRoot(base, b.name) : null
    return id && id !== first && !inSlot.has(b.name) ? [{ id, head: b.name, base: base! }] : []
  })
  const slots = lines.slots.flatMap((s) => {
    const base = has(s.target) && s.target !== s.branch ? s.target : defaultBase(lines, s.branch)
    return base ? [{ ...s, id: compareRoot(base, s.branch) }] : []
  })
  const picked = parseCompareRoot(value)
  // A pair chosen with the page's own pickers, not one of the defaults: listed too, so the picker shows it.
  const extra = picked && value !== first && !rows.some((r) => r.id === value) && !slots.some((r) => r.id === value) ? picked : null
  return (
    <>
      <optgroup label={tr(M.group)}>
        {first && <option value={first}>{tr(M.option, { head: lines.integration!, base: lines.main! })}</option>}
        {extra && <option value={value}>{tr(M.option, { head: extra.head, base: extra.base })}</option>}
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {tr(M.option, { head: r.head, base: r.base })}
          </option>
        ))}
        {last}
      </optgroup>
      {slots.length > 0 && (
        <optgroup label={tr(M.slotsGroup)}>
          {slots.map((s) => (
            <option key={s.name} value={s.id} data-slot={s.name}>
              {tr(M.slotOption, { slot: s.name, card: s.card !== null ? cardLabelOf({ tasks }, s.card) : 'none', branch: s.branch })}
            </option>
          ))}
        </optgroup>
      )}
    </>
  )
}

const FILES_STEP = 200

/** The comparison's page: the branches, their counts, the files (or the commits) and a file's diff. */
export function ComparePage({ project, base, head, lines, selector, listWidth, onPick }: { project: ProjectInfo; base: string; head: string; lines: CompareLines | null; selector: React.ReactNode; listWidth: number; onPick: (base: string, head: string) => void }) {
  const [page, setPage] = useState(1)
  const [view, setView] = useState<'files' | 'commits'>('files')
  const [shown, setShown] = useState(FILES_STEP)
  const [file, setFile] = useState<string | null>(null)
  const [inline, setInline] = useState(false)
  const pair = `${base}\n${head}`
  // From the first page turn until Refresh, the commits the comparison read: each page is of them, never of a branch
  // that has moved since (and so are the counts, the files and a file's diff).
  const [pin, setPin] = useState<{ for: string; base: string; head: string } | null>(null)
  const pinned = pin?.for === pair ? pin : null
  useEffect(() => {
    setPage(1)
    setShown(FILES_STEP)
    setFile(null)
    setPin(null)
  }, [pair])
  const raw = useGitRead('git:compare', project, [base, head, page, pinned?.base ?? '', pinned?.head ?? ''])
  // The last answer for this pair stays while another page is read.
  const [last, setLast] = useState<{ for: string; data: GitComparison } | null>(null)
  useEffect(() => {
    if (raw.data) setLast({ for: pair, data: raw.data })
  }, [raw.data, pair])
  const c = raw.data ?? (last?.for === pair ? last.data : null)
  const turn = (n: number): void => {
    if (c && !pinned) setPin({ for: pair, base: c.baseCommit, head: c.headCommit })
    setPage(n)
  }
  // Refresh reads the branches as they are now (unpinned): the counts, files and pages of their new tips.
  const refresh = (): void => (pinned ? setPin(null) : raw.reload())

  // A file no longer listed (the branches moved and a refresh read them again) isn't shown.
  useEffect(() => {
    if (c && file && !c.files.some((f) => f.path === file)) setFile(null)
  }, [c, file])

  // A file's diff, read when it is opened, of the commits the comparison listed (pinned: never the branches' tips
  // then, so it matches the counts and files shown); an answer for another file, pair or pair of commits never shows.
  const baseCommit = c?.baseCommit ?? ''
  const headCommit = c?.headCommit ?? ''
  const wanted = `${pair}\n${baseCommit}:${headCommit}\n${file ?? ''}`
  const [diffOf, setDiffOf] = useState<{ for: string; diff: GitDiff } | null>(null)
  const [diffErrorOf, setDiffErrorOf] = useState<{ for: string; error: string } | null>(null)
  const [diffTry, setDiffTry] = useState(0)
  useEffect(() => {
    if (!file || !baseCommit) return
    const asked = `${pair}\n${baseCommit}:${headCommit}\n${file}`
    let current = true
    void call('git:compareDiff', project.path, base, head, file, { base: baseCommit, head: headCommit }).then(
      (d) => current && (setDiffOf({ for: asked, diff: d }), setDiffErrorOf(null)),
      (e) => current && setDiffErrorOf({ for: asked, error: errorMessage(e) })
    )
    return () => {
      current = false
    }
  }, [project.path, base, head, file, pair, baseCommit, headCommit, diffTry])
  const diff = diffOf?.for === wanted ? diffOf.diff : null
  const diffError = diffErrorOf?.for === wanted ? diffErrorOf.error : null

  const names = lines?.branches.map((b) => b.name) ?? [base, head]
  const branchSelect = (label: string, value: string, other: string, set: (v: string) => void, which: string): React.ReactNode => (
    <label className="compare-side">
      <span className="faint">{label}</span>
      <select className="select root-select" data-compare={which} value={value} onChange={(e) => set(e.target.value)}>
        {names.map((n) => (
          <option key={n} value={n} disabled={n === other}>
            {n}
          </option>
        ))}
      </select>
    </label>
  )
  const commitRows = (rows: GitCommitRow[]): React.ReactNode =>
    rows.length === 0 ? (
      <p className="hint">{tr(M.none)}</p>
    ) : (
      <div className="git-rows">
        {rows.map((r) => (
          <Tooltip block key={r.hash} content={<span style={{ whiteSpace: 'pre-line' }}>{tr(M.commitTip, { hash: r.hash, author: r.author, email: r.email, when: fmt.dateTime(r.date) })}</span>}>
            <div className="git-row git-commit" data-commit={r.short}>
              <code className="git-hash">{r.short}</code>
              <span className="git-subject">{r.subject}</span>
              <span className="git-meta faint">
                {r.author} · {at(r.date)}
              </span>
            </div>
          </Tooltip>
        ))}
      </div>
    )

  const failed = !c && raw.error
  // A read that failed while an earlier result stays on screen (a refresh, another page): said, with Retry, never
  // passed off as current.
  const stale = !!c && !!raw.error && !raw.loading
  return (
    <div className="changes-split" style={{ '--list-width': `${listWidth}px` } as React.CSSProperties}>
      <div className="split" data-compare-page="" data-compare-base={base} data-compare-head={head}>
        <div className="split-list">
          <PaneResizer paneKey="changes" />
          <div className="pane-header" style={{ paddingLeft: 14 }}>
            {view === 'commits' ? tr(M.commits) : tr(M.files)} {c && (view === 'commits' ? <span className="badge" style={{ marginLeft: 6 }}>{fmt.number(c.ahead + c.behind)}</span> : <span className="badge" style={{ marginLeft: 6 }} data-compare-files={c.filesTotal}>{fmt.number(c.filesTotal)}</span>)}
            <div className="actions">
              <IconButton icon={raw.loading ? 'loading' : 'refresh'} spin={raw.loading} title={tr(M.refresh)} disabled={raw.loading} onClick={refresh} />
            </div>
          </div>
          {selector}
          <div className="compare-sides">
            {branchSelect(tr(M.head), head, base, (h) => onPick(base, h), 'head')}
            <IconButton icon="arrow-swap" title={tr(M.swap)} action="compare-swap" onClick={() => onPick(head, base)} />
            {branchSelect(tr(M.base), base, head, (b) => onPick(b, head), 'base')}
          </div>
          {c && (
            <div className="segmented compare-view" role="radiogroup">
              <button type="button" role="radio" aria-checked={view === 'files'} className={cx(view === 'files' && 'active')} data-compare-view="files" onClick={() => setView('files')}>
                {tr(M.files)}
              </button>
              <button type="button" role="radio" aria-checked={view === 'commits'} className={cx(view === 'commits' && 'active')} data-compare-view="commits" onClick={() => setView('commits')}>
                {tr(M.commits)} <span className="faint">↑{fmt.number(c.ahead)} ↓{fmt.number(c.behind)}</span>
              </button>
            </div>
          )}
          {c && view === 'commits' && (
            <div className="hint compare-files-hint" data-compare-commits-hint="">
              {tr(M.commitsHint, { head, base })}
            </div>
          )}
          {c && view === 'files' && c.files.length > 0 && (
            <div className="hint compare-files-hint" data-compare-files-hint="">
              {tr(M.filesHint, { head, base })}
            </div>
          )}
          <div className="pane-body" hidden={view === 'commits'}>
            {c && c.files.length === 0 && <div className="pane-empty">{tr(M.noFiles, { head, base })}</div>}
            {c?.files.slice(0, shown).map((f) => (
              <Tooltip block key={f.path} content={tr(M.status, { status: f.status, path: f.path })}>
                <div className={cx('row', view === 'files' && file === f.path && 'selected')} style={{ width: '100%' }} data-compare-file={f.path} onClick={() => (setFile(f.path), setView('files'))}>
                  <span className="label">{f.path.split('/').pop()}</span>
                  <span className="desc" style={{ flex: 1, minWidth: 0 }}>{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
                  <span className={cx('git-status', f.status)}>{f.status /* i18n-ignore: git's status letter */}</span>
                </div>
              </Tooltip>
            ))}
            {c && shown < c.files.length && (
              <button className="btn small subtle compare-more" onClick={() => setShown((n) => n + FILES_STEP)}>
                {tr(M.moreFiles, { shown, total: c.files.length })}
              </button>
            )}
            {c && c.filesTotal > c.files.length && <p className="hint" style={{ padding: '0 14px' }}>{tr(M.cut, { shown: c.files.length, total: c.filesTotal })}</p>}
          </div>
        </div>
        <div className="split-main">
          <div className="changes-about changes-page-head" data-about="compare">
            {tr(M.about, { head, base })}
            {c && (
              <div className="faint" data-compare-ahead={c.ahead} data-compare-behind={c.behind}>
                {tr(M.counts, { head, base, ahead: c.ahead, behind: c.behind })} {c.mergeBase ? tr(M.parted, { commit: c.mergeBase.slice(0, 7) }) : tr(M.unrelated, { head, base })}
              </div>
            )}
          </div>
          {stale && (
            <div data-compare-stale="">
              <StaleNote what={tr(M.load)} error={raw.error!} at={raw.at} onRetry={raw.reload} />
            </div>
          )}
          {failed ? (
            <LoadFailed what={tr(M.load)} error={raw.error!} onRetry={raw.reload} />
          ) : !c ? (
            <div className="empty-state">
              <Icon name="loading" spin /> {tr(M.loading, { head, base })}
            </div>
          ) : view === 'commits' ? (
            <div className="compare-commits" data-compare-commits="">
              <h2 className="section">
                {tr(M.onlyHead, { head, base })} <span className="badge">{fmt.number(c.ahead)}</span>
              </h2>
              {commitRows(c.aheadCommits)}
              <h2 className="section">
                {tr(M.onlyHead, { head: base, base: head })} <span className="badge">{fmt.number(c.behind)}</span>
              </h2>
              {commitRows(c.behindCommits)}
              {c.pages > 1 && <Pager page={c.page} pages={c.pages} from={(c.page - 1) * COMPARE_COMMITS + 1} to={Math.min(c.page * COMPARE_COMMITS, Math.max(c.ahead, c.behind))} total={Math.max(c.ahead, c.behind)} onPage={turn} />}
            </div>
          ) : diff ? (
            <>
              <div className="editor-toolbar">
                <Icon name="git-compare" />
                <span className="path">
                  <strong>{diff.path}</strong> <span className="faint">{`${base} ↔ ${head}`}</span>
                </span>
                <IconButton icon={inline ? 'split-horizontal' : 'list-flat'} title={tr(inline ? M.sideBySide : M.inline)} onClick={() => setInline(!inline)} />
              </div>
              <div className="editor-host" data-compare-diff={diff.path}>
                {diff.gitlink ? <GitlinkDiff diff={diff} change={diff.gitlink} inline={inline} /> : diff.binary ? <div className="empty-state">{diff.modified || tr(M.binary)}</div> : <DiffView original={diff.original} modified={diff.modified} language={languageFor(diff.path)} inline={inline} />}
              </div>
            </>
          ) : diffError ? (
            <div className="empty-state">
              <Icon name="error" /> {tr(M.diffFailed, { error: diffError })}
              <button className="btn small" style={{ marginTop: 10 }} onClick={() => setDiffTry((n) => n + 1)}>
                <Icon name="refresh" /> {tr(M.retry)}
              </button>
            </div>
          ) : file ? (
            <div className="empty-state">
              <Icon name="loading" spin /> {tr(M.loadingDiff)}
            </div>
          ) : (
            <div className="empty-state">{tr(M.selectFile, { head })}</div>
          )}
        </div>
      </div>
    </div>
  )
}
