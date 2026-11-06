import { Children, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ProjectInfo } from '@shared/types'
import { fmt, msg, tr, tRich, type Msg } from '@shared/i18n'
import { GIT_VIEW_GUIDE, HISTORY_COMMITS, folderBusy, gitStatusText, gitStatusTip, headText, type GitFolderAction, type GitHistory, type GitRepoSummary } from '@shared/gitRepo'
import { gitFixText, gitProblemText } from '@shared/gitTool'
import type { CombworkRequests } from '@shared/api'
import { call, errorMessage } from '../api'
import { gitReader, type GitReadState } from '../gitReads'
import { attempt } from '../actions'
import { bumpGit, notify, set, showVersionControl, showView, useStore } from '../store'
import { awayFromProject } from '../agentPlace'
import { openGuideAt } from '../tips'
import { useNow } from '../usage'
import { cx, timeAgo } from '../util'
import { projectSlots, useMergeSlots } from '../components/MergeSlots'
import { BusyButton, Icon, IconButton, LoadFailed, Modal, StaleNote, Tooltip, useBusy } from '../components/ui'
import { InitRepoButton } from '../components/InitRepo'
import { Pager } from '../components/DataTable'

/** A message with markup, as React children (keyed, so a list of parts renders without warnings). */
export const rich = (m: Msg, values: Parameters<typeof tRich<React.ReactNode>>[1]): React.ReactNode[] => Children.toArray(tRich<React.ReactNode>(m, values))
const faint = (c: React.ReactNode[]): React.ReactNode => <span className="faint">{c}</span>

/** The words of Changes, History and the shared forms; Branches & remotes has its own (GitBranches.tsx). */
export const GIT_TEXT = {
  notRepo: msg({ id: 'git.setup.notRepo', defaultMessage: "{project} isn't a git repository", description: "Heading on the Git tab of a project that isn't a git repository. {project} is its name." }),
  withoutGit: msg({ id: 'git.setup.withoutGit', defaultMessage: 'Without a repository, agents work in the project folder, and Combwork has no worktrees or merging for it.', description: "The Version Control tab of a Git project whose folder isn't a git repository." }),
  howTo: msg({ id: 'git.setup.howTo', defaultMessage: 'To use them, make it a repository: Initialise makes it one on a branch called main, keeps its .combwork out of git, and commits its files, so agents can work in worktrees at once. Then add a remote under Branches & remotes to push it.', description: "The Git tab of a project that isn't a git repository. Initialise and Branches & remotes are a button and a section: keep them as they are named there. Keep main (the branch name)." }),
  cantRead: msg({ id: 'git.problem.cantRead', defaultMessage: "{problem}, so Combwork can't read this repository.", description: 'The Git tab when git cannot run. {problem} says why, such as "Git isn\'t installed (or isn\'t on Combwork\'s PATH)".' }),
  learnMore: msg({ id: 'git.setup.learnMore', defaultMessage: 'Learn more', description: "Link on the Git tab of a project that isn't a git repository: opens the user guide's Git view section." }),
  agentSetup: msg({ id: 'git.problem.agentSetup', defaultMessage: 'Provider Setup', description: 'Button: opens Provider Setup, which checks git and says how to fix it.' }),
  retry: msg({ id: 'git.retry', defaultMessage: 'Retry', description: 'Button: reads git again.' }),
  reading: msg({ id: 'git.reading', defaultMessage: 'Reading git…', description: "A Git tab section while it reads git for the first time." }),
  historyLoad: msg({ id: 'git.history.loadTarget', defaultMessage: 'the history', description: 'What could not be read in Git → History: shown in "Could not load {what}: {error}" and "Could not refresh {what}; last updated …".' }),
  historyOf: msg({ id: 'git.history.headingOf', defaultMessage: 'History <faint>of {head}</faint>', description: 'Heading of Git → History. {head} is the branch shown, a drop-down to choose another (or "detached at abc1234"). <faint> is the part shown dimmed.' }),
  historyBranch: msg({ id: 'git.history.branch', defaultMessage: 'Branch to show', description: "The name, for screen readers, of Git → History's branch picker (in its heading)." }),
  historyLocal: msg({ id: 'git.history.local', defaultMessage: 'Branches', description: "A group in Git → History's branch picker: the repository's own branches." }),
  historyRemote: msg({ id: 'git.history.remote', defaultMessage: 'Remote branches', description: "A group in Git → History's branch picker: the remotes' branches (origin/x)." }),
  historyOption: msg({ id: 'git.history.option', defaultMessage: '{kind, select, target {{branch} · target} folder {{branch} · project folder} other {{branch}}}', description: "A branch in Git → History's branch picker: the branch the project's work merges into (target), the one the project folder has checked out, or another. Keep the select keys." }),
  historyHeading: msg({ id: 'git.history.heading', defaultMessage: 'History', description: 'Heading of Git → History, before the branch is known.' }),
  readHistoryAgain: msg({ id: 'git.history.reload', defaultMessage: 'Read the history again', description: 'Tooltip on the refresh button in Git → History.' }),
  noCommits: msg({ id: 'git.history.noCommits', defaultMessage: 'No commits yet.', description: 'Git → History when the repository has no commit.' }),
  tags: msg({ id: 'git.tags.heading', defaultMessage: 'Tags', description: 'Heading in Git → History, followed by how many tags there are.' }),
  createTag: msg({ id: 'git.tags.create', defaultMessage: 'Create tag…', description: 'Button in Git → History: opens the form that tags the commit checked out.' }),
  noTags: msg({ id: 'git.tags.none', defaultMessage: 'No tags. Create tag… tags the commit the project folder has checked out.', description: 'Git → History when there are no tags. Create tag… is the button of that name.' }),
  olderTags: msg({ id: 'git.tags.older', defaultMessage: 'and {count, number} older', description: 'Under the tags listed in Git → History: how many older tags are not listed.' }),
  enterName: msg({ id: 'git.form.enterName', defaultMessage: 'Enter a name', description: "Under a form's name box (a branch, a tag) while it is empty." }),
  cancel: msg({ id: 'git.cancel', defaultMessage: 'Cancel', description: "Button: closes the Git tab's dialog or form without doing anything." }),
  tagTitle: msg({ id: 'git.tags.title', defaultMessage: 'Tag {commit}', description: 'Title of the Create tag form. {commit} is the short hash of the commit checked out.' }),
  tagTheCommit: msg({ id: 'git.tags.titleNoCommit', defaultMessage: 'Tag the commit', description: 'Title of the Create tag form before the commit is known.' }),
  tagAbout: msg({ id: 'git.tags.about', defaultMessage: "{onBranch, select, yes {Tags the commit the project folder has checked out ({branch}). With a message, it's an annotated tag.} other {Tags the commit the project folder has checked out. With a message, it's an annotated tag.}}", description: 'The Create tag form. {branch} is the branch checked out ({onBranch} is no when HEAD is detached).' }),
  tagName: msg({ id: 'git.tags.name', defaultMessage: 'Name', description: "Field of the Create tag form: the new tag's name (v1.0.0, say)." }),
  message: msg({ id: 'git.tags.message',defaultMessage: 'Message', description: 'Field of the Create tag form.' }),
  optional: msg({ id: 'git.tags.optional', defaultMessage: 'Optional', description: "Placeholder in the Create tag form's message box." }),
  pushItTo: msg({ id: 'git.tags.pushTo', defaultMessage: 'Push it to', description: 'Field of the Create tag form: the remote to push the tag to.' }),
  dontPush: msg({ id: 'git.tags.dontPush', defaultMessage: "Don't push", description: 'The first choice of the Create tag form\'s Push it to drop-down.' }),
  createTagButton: msg({ id: 'git.tags.createButton', defaultMessage: 'Create tag', description: "The Create tag form's button." }),
  tagging: msg({ id: 'git.tags.busy', defaultMessage: 'Tagging…', description: "The Create tag form's button while it runs." }),
  tagNoSpaces: msg({ id: 'git.tags.noSpaces', defaultMessage: 'Tag names have no spaces', description: "Under the Create tag form's name box." }),
  statusBarTip: msg({ id: 'git.statusBar.tip', defaultMessage: 'Git branch of the selected project', description: "Tooltip on the status bar's git item before git has been read." })
}
const M = GIT_TEXT

/**
 * Git's sections of the Version Control tab (#607, #1416): Changes (whose changes, as the Changes tab had them) and
 * History (the project folder's last commits and its tags), with the helpers Branches & remotes (GitBranches.tsx)
 * shares. Every change here is the user's own (never an agent tool), in the project folder only: switching branch or
 * pulling is refused while an agent works there or holds its merge slot.
 */

/** A read with no arguments but the project (stable: it is in an effect's dependencies). */
const NO_ARGS: readonly (string | number | null)[] = []

export const at = (ms: number | null): string | null => (ms ? timeAgo(new Date(ms).toISOString()) : null)

/**
 * Reads a Git channel for the project: again when the project's git changes here, its agents work, the window gets
 * focus, or on `reload`; the last answer stays while it does.
 */
export function useGitRead<C extends 'git:summary' | 'git:info' | 'git:history' | 'git:compareLines' | 'git:compare' | 'git:leftovers'>(channel: C, project: ProjectInfo, args: readonly (string | number | null)[] = NO_ARGS): { data: Awaited<ReturnType<CombworkRequests[C]>> | null; error: string | null; loading: boolean; at: number; reload: () => void } {
  type T = Awaited<ReturnType<CombworkRequests[C]>>
  const version = useStore((s) => s.gitVersion[project.path] ?? 0)
  const usage = useStore((s) => s.usageVersion[project.path] ?? 0)
  // A read is the project's with its arguments (History's branch and page, #1643): another's answer never shows for it.
  const key = args.length ? JSON.stringify([project.path, ...args]) : project.path
  const [state, setState] = useState<GitReadState<T>>({ for: key, data: null, error: null, loading: true, at: 0 })
  // One read at a time, those asked meanwhile one more after it (#1366, gitReads.ts).
  const reader = useMemo(() => gitReader<T>((k) => (call as (c: C, ...a: unknown[]) => Promise<T>)(channel, ...(k.startsWith('[') ? (JSON.parse(k) as unknown[]) : [k])), setState, errorMessage), [channel])
  const reload = useCallback(() => reader(key), [reader, key])
  useEffect(reload, [reload, version, usage, project.branch])
  // What the user did in a terminal meanwhile (a commit, git init) shows on coming back to the window.
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])
  // Another project's answer never shows for this one.
  const mine = state.for === key
  return { data: mine ? state.data : null, error: mine ? state.error : null, loading: !mine || state.loading, at: mine ? state.at : 0, reload }
}

/** Why an action that moves the project folder is refused now (an agent works there, or its merge slot is held), or null. */
export function useFolderBusy(project: ProjectInfo): (action: GitFolderAction) => string | null {
  const slots = projectSlots(useMergeSlots(), project.path)
  const agents = project.agents.filter((a) => !awayFromProject(a)).map((a) => ({ name: a.name, status: a.live?.status ?? null }))
  const folder = slots.map((s) => ({ branch: s.branch, holder: s.holder && s.holder.kind !== 'user' ? s.holder.name : null, ...(s.holder?.kind === 'user' ? { byUser: true } : {}), waiting: s.waiting.map((w) => w.name) }))
  return (action) => folderBusy(agents, folder, action)
}

/** Runs a Git action from the window: its reply as a notice, its failure as an error, and the view read again either way. */
export async function gitAction(project: ProjectInfo, title: string, fn: () => Promise<string>): Promise<boolean> {
  const done = await attempt(title, fn)
  bumpGit(project.path)
  if (done === undefined) return false
  notify('success', done)
  return true
}

/** A Git project whose folder isn't a repository (#607): it says so, what that means, and how to start. */
export function GitSetupNotes({ project }: { project: ProjectInfo }) {
  return (
    <div className="scroll-page">
      <div className="page-narrow git-setup" data-git-setup="">
        <h2 className="section">
          <Icon name="source-control" /> {tr(M.notRepo, { project: project.name })}
        </h2>
        <p>{tr(M.withoutGit)}</p>
        <p className="hint">{tr(M.howTo)}</p>
        <p>
          <InitRepoButton project={project} />
        </p>
        <p className="hint">
          <a onClick={() => openGuideAt(GIT_VIEW_GUIDE)}>{tr(M.learnMore)}</a>
        </p>
      </div>
    </div>
  )
}

export function GitProblem({ problem, retry }: { problem: string; retry: () => void }) {
  const tool = useStore((s) => s.gitTool)
  return (
    <div className="empty-state changes-git-missing" style={{ paddingTop: '15vh' }}>
      <Icon name="warning" />
      {/* Main's text is English (agents read it too): the window's own, in its language, while it knows git's state. */}
      {tr(M.cantRead, { problem: gitProblemText(tool) ?? problem })}
      <p className="hint">{gitFixText(tool)}</p>
      <div className="flex" style={{ justifyContent: 'center' }}>
        <button className="btn small" onClick={() => set({ setupOpen: true })}>
          <Icon name="hubot" /> {tr(M.agentSetup)}
        </button>
        <button className="btn small" onClick={retry}>
          <Icon name="refresh" /> {tr(M.retry)}
        </button>
      </div>
    </div>
  )
}

/** A section's first load: its spinner, or why it failed. */
export function Loading<T>({ read, what, children }: { read: { data: T | null; error: string | null; loading: boolean; at: number; reload: () => void }; what: string; children: (data: T) => React.ReactNode }) {
  if (!read.data) {
    return (
      <div className="scroll-page">
        <div className="page-narrow">{read.error && !read.loading ? <LoadFailed inline what={what} error={read.error} onRetry={read.reload} /> : <p className="hint"><Icon name="loading" spin /> {tr(M.reading)}</p>}</div>
      </div>
    )
  }
  return (
    <div className="scroll-page">
      <div className="page-narrow">
        {read.error && <StaleNote what={what} error={read.error} at={read.at} onRetry={read.reload} />}
        {children(read.data)}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function HistorySection({ project, summary }: { project: ProjectInfo; summary: GitRepoSummary | null }) {
  // The branch chosen (null: the default, the project's target) and the page, the project's own (#1643).
  const [pick, setPick] = useState<{ for: string; ref: string | null; page: number }>({ for: project.path, ref: null, page: 1 })
  const mine = pick.for === project.path ? pick : { for: project.path, ref: null, page: 1 }
  const raw = useGitRead('git:history', project, [mine.ref, mine.page])
  // The last page stays while another page or branch is read: no blank between them.
  const [last, setLast] = useState<{ for: string; data: GitHistory } | null>(null)
  useEffect(() => {
    if (raw.data) setLast({ for: project.path, data: raw.data })
  }, [raw.data, project.path])
  const read = { ...raw, data: raw.data ?? (last?.for === project.path ? last.data : null) }
  const [form, setForm] = useState<OpenForm | null>(null)
  useNow(60000)
  const optionText = (h: GitHistory, b: string): string => tr(M.historyOption, { branch: b, kind: b === h.target ? 'target' : b === summary?.branch ? 'folder' : 'other' /* i18n-ignore: a select's key, never shown */ })
  const picker = (h: GitHistory): React.ReactNode => (
    <select className="select git-history-branch" aria-label={tr(M.historyBranch)} data-history-branch="" value={h.ref ?? ''} onChange={(e) => setPick({ for: project.path, ref: e.target.value || null, page: 1 })}>
      {!h.ref && <option value="">{summary ? headText(summary) : ''}</option>}
      <optgroup label={tr(M.historyLocal)}>
        {h.branches.map((b) => (
          <option key={b} value={`refs/heads/${b}`}>
            {optionText(h, b)}
          </option>
        ))}
      </optgroup>
      {h.remoteBranches.length > 0 && (
        <optgroup label={tr(M.historyRemote)}>
          {h.remoteBranches.map((b) => (
            <option key={b} value={`refs/remotes/${b}`}>
              {b}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
  return (
    <Loading read={read} what={tr(M.historyLoad)}>
      {(h: GitHistory) => (
        <div className="git-history" data-git-history="" data-history-ref={h.ref ?? ''} data-history-page={h.page}>
          <h2 className="section git-section-head">
            {rich(M.historyOf, { head: picker(h), faint })}
            <span className="git-section-actions">
              <IconButton icon={read.loading ? 'loading' : 'refresh'} spin={read.loading} title={tr(M.readHistoryAgain)} action="reload-history" onClick={read.reload} />
            </span>
          </h2>
          {h.commits.length === 0 ? (
            <p className="hint">{tr(M.noCommits)}</p>
          ) : (
            <div className="git-rows">
              {h.commits.map((c) => (
                <Tooltip block key={c.hash} content={<span style={{ whiteSpace: 'pre-line' }}>{`${c.hash}\n${c.author} <${c.email}>\n${fmt.dateTime(c.date)}`}</span>}>
                  <div className="git-row git-commit" data-commit={c.short}>
                    <code className="git-hash">{c.short}</code>
                    <span className="git-subject">{c.subject}</span>
                    {c.refs.map((r) => (
                      <span key={r} className={cx('badge', 'git-ref', r.startsWith('tag: ') && 'git-tag', r.startsWith('HEAD') && 'git-headref')}>
                        {r.replace(/^tag: /, '')}
                      </span>
                    ))}
                    <span className="git-meta faint">
                      {c.author} · {at(c.date)}
                    </span>
                  </div>
                </Tooltip>
              ))}
            </div>
          )}
          {h.pages > 1 && <Pager page={h.page} pages={h.pages} from={(h.page - 1) * HISTORY_COMMITS + 1} to={Math.min(h.page * HISTORY_COMMITS, h.total)} total={h.total} onPage={(page) => setPick({ ...mine, page })} />}
          <h2 className="section git-section-head">
            {tr(M.tags)} <span className="badge">{h.tags.length + h.moreTags}</span>
            <span className="git-section-actions">
              <button className="btn small" data-action="create-tag" disabled={!summary?.head || !!summary.parentRepo} onClick={() => setForm({ make: () => tagForm(project, summary) })}>
                <Icon name="tag" /> {tr(M.createTag)}
              </button>
            </span>
          </h2>
          {h.tags.length === 0 ? (
            <p className="hint">{tr(M.noTags)}</p>
          ) : (
            <div className="git-rows">
              {h.tags.map((t) => (
                <div key={t.name} className="git-row git-tag-row" data-tag={t.name}>
                  <Icon name="tag" />
                  <span className="git-name">{t.name}</span>
                  <code className="git-hash">{t.commit}</code>
                  <span className="git-subject faint">{t.subject}</span>
                  <span className="git-meta faint">{at(t.date)}</span>
                </div>
              ))}
              {h.moreTags > 0 && <p className="hint">{tr(M.olderTags, { count: h.moreTags })}</p>}
            </div>
          )}
          {form && <GitForm make={form.make} onClose={() => setForm(null)} />}
        </div>
      )}
    </Loading>
  )
}

// ---------------------------------------------------------------------------
// Forms: Create tag here; Branches & remotes' in GitBranches.tsx
// ---------------------------------------------------------------------------

export interface FormField {
  key: string
  label: string
  initial?: string
  placeholder?: string
  /** A drop-down instead of a text box. */
  options?: { label: string; value: string }[]
}

export interface FormSpec {
  title: string
  icon: string
  about?: string
  fields: FormField[]
  confirm: string
  busyLabel: string
  validate: (v: Record<string, string>) => string | null
  /** What to know about the values as they are (Track…'s push first, #1385), under the fields; null for nothing. */
  note?: (v: Record<string, string>) => string | null
  submit: (v: Record<string, string>) => Promise<string>
  project: ProjectInfo
}

/**
 * An open form: how to make its spec, not the spec itself. Its text is formatted each time it renders, so an open form
 * follows a change of language (what was typed stays: it is the form's state).
 */
export interface OpenForm {
  make: () => FormSpec
}

export function GitForm({ make, onClose }: { make: () => FormSpec; onClose: () => void }) {
  const spec = make()
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(spec.fields.map((f) => [f.key, f.initial ?? ''])))
  const { busy, error, run } = useBusy()
  const problem = spec.validate(values)
  const submit = async (): Promise<void> => {
    if (problem) return
    const r = await run('submit', () => spec.submit(values))
    bumpGit(spec.project.path)
    if (!r) return
    // A reply of several lines (Push to…'s outcomes) is a notice with its first line as the title.
    const [head, ...rest] = r.value.split('\n')
    notify('success', head, rest.length ? rest.join('\n') : undefined)
    onClose()
  }
  return (
    <Modal
      title={spec.title}
      icon={spec.icon}
      onClose={onClose}
      busy={!!busy}
      error={error}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>
            {tr(M.cancel)}
          </button>
          <BusyButton className="primary" busy={!!busy} busyLabel={spec.busyLabel} disabled={!!problem} onClick={() => void submit()}>
            {spec.confirm}
          </BusyButton>
        </>
      }
    >
      {spec.about && <p className="hint">{gitCommandsWhole(spec.about)}</p>}
      <div className="agent-form git-form">
        {spec.fields.map((f, i) => (
          <FormRow key={f.key} field={f} value={values[f.key]} first={i === 0} onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))} onEnter={() => void submit()} />
        ))}
      </div>
      {problem && Object.values(values).some((v) => v.trim()) && <div className="field-error">{problem}</div>}
      {!problem && spec.note?.(values) && <p className="hint git-form-note">{spec.note(values)}</p>}
    </Modal>
  )
}

/** A form's hint with each git command in it ("git config --local") kept on one line, never split after a dash (#890). */
function gitCommandsWhole(text: string): ReactNode {
  return text.split(/(\bgit(?: --?[\w-]+| [a-z][\w-]*)+)/).map((part, i) =>
    i % 2 ? (
      <span key={i} className="git-command">
        {part}
      </span>
    ) : (
      part
    )
  )
}

function FormRow({ field, value, first, onChange, onEnter }: { field: FormField; value: string; first: boolean; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <>
      <label htmlFor={`git-form-${field.key}`}>{field.label}</label>
      {field.options ? (
        <select id={`git-form-${field.key}`} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input id={`git-form-${field.key}`} className="input" value={value} placeholder={field.placeholder} autoFocus={first} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onEnter()} />
      )}
    </>
  )
}

function tagForm(project: ProjectInfo, s: GitRepoSummary | null): FormSpec {
  const remotes = s?.remotes ?? []
  return {
    project,
    title: s?.head ? tr(M.tagTitle, { commit: s.head }) : tr(M.tagTheCommit),
    icon: 'tag',
    about: tr(M.tagAbout, { onBranch: s?.branch ? 'yes' : 'no', branch: s?.branch ?? '' }),
    fields: [
      // i18n-ignore: an example version
      { key: 'name', label: tr(M.tagName), placeholder: 'v1.0.0' },
      { key: 'message', label: tr(M.message), placeholder: tr(M.optional) },
      ...(remotes.length ? [{ key: 'push', label: tr(M.pushItTo), initial: '', options: [{ label: tr(M.dontPush), value: '' }, ...remotes.map((r) => ({ label: r, value: r }))] }] : [])
    ],
    confirm: tr(M.createTagButton),
    busyLabel: tr(M.tagging),
    validate: (v) => (!v.name.trim() ? tr(M.enterName) : /\s/.test(v.name.trim()) ? tr(M.tagNoSpaces) : null),
    submit: (v) => call('git:createTag', project.path, v.name.trim(), v.message ?? '', v.push || undefined)
  }
}

// ---------------------------------------------------------------------------
// The status bar
// ---------------------------------------------------------------------------

/**
 * The selected project's git in the status bar (#607): "main · origin · ↑2 ↓0", as of the last fetch. Read again when
 * its branch or agents change, after a Git action, when the window gets focus, and every minute; it opens Version
 * Control → Branches & remotes.
 */
export function GitStatusBarItem({ project }: { project: ProjectInfo }) {
  const read = useGitRead('git:summary', project)
  const reload = read.reload
  useNow(60000)
  useEffect(() => {
    const t = setInterval(reload, 60_000)
    return () => clearInterval(t)
  }, [reload])
  const s = read.data
  if (s && !s.isRepo) return null
  const text = s ? gitStatusText(s) : project.branch
  if (!text) return null
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{s ? gitStatusTip(s, at(s.fetchedAt)) : tr(M.statusBarTip)}</span>}>
      <div className={cx('status-item', s?.state && 'caution')} data-git-status="" onClick={() => {
          showView('projects')
          showVersionControl(project.path, 'branches')
        }}>
        <Icon name="git-branch" /> {text}
      </div>
    </Tooltip>
  )
}
