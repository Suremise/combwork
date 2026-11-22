import { useEffect, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import type { GitLockFile, LockHeld, PrunableWorktree, RemotePrune } from '@shared/gitHealth'
import { fmt, msg, tr } from '@shared/i18n'
import { offered, repoOp } from '../repoOps'
import { gitRun, startGitRun } from '../gitRuns'
import { bumpGit, confirm, notify } from '../store'
import { Icon, IconButton, Tooltip } from './ui'
import { timeAgo } from '../util'
import { useGitRead } from '../views/GitTab'

// HI-3473: Branches & remotes' Repository health: three of git's own repairs, each listing what it finds first and done
// only on the user's confirm (main checks again, refusing while anything works on the repository): Prune worktrees
// (entries whose folder is gone), Remove stale lock (a lock file a git that died left), Fetch with prune (remote-tracking
// branches deleted on the remote). The first two are read as the section opens; the third reaches the remotes, so only
// on its click.

export const HEALTH_TEXT = {
  title: msg({ id: 'git.health.title', defaultMessage: 'Repository health', description: 'HI-3473: a section heading at the foot of Version Control → Branches & remotes: three repairs of the git repository (prune worktrees, remove a stale lock, fetch with prune).' }),
  about: msg({ id: 'git.health.about', defaultMessage: "Git's own repairs, for when something was left behind. Each lists what it finds and asks first, and none runs while an agent, a run or a merge works on the repository.", description: 'HI-3473: the sentence under the Repository health heading.' }),
  readAgain: msg({ id: 'git.health.readAgain', defaultMessage: 'Look again', description: 'HI-3473: the tooltip of the refresh button beside the Repository health heading.' }),
  readFailed: msg({ id: 'git.health.readFailed', defaultMessage: "Couldn't check the repository: {error}", description: 'HI-3473: under the Repository health heading when reading what it finds failed. {error} is why.' }),
  reading: msg({ id: 'git.health.reading', defaultMessage: 'Checking…', description: "HI-3473: in a Repository health row while it is being read." }),
  // Prune worktrees
  pruneHead: msg({ id: 'git.health.prune.head', defaultMessage: 'Worktree entries', description: "HI-3473: a Repository health row's name: git's records of worktrees whose folder is gone." }),
  pruneState: msg({ id: 'git.health.prune.state', defaultMessage: "{n, plural, =0 {None whose folder is gone.} one {# whose folder is gone.} other {# whose folders are gone.}}", description: "HI-3473: the Repository health row's state: how many of git's worktree entries have lost their folder ({n})." }),
  prune: msg({ id: 'git.health.prune.button', defaultMessage: 'Prune Worktrees…', description: 'HI-3473: the button of the worktree entries row: lists them to drop (git worktree prune, one entry at a time). Keep the …: it opens a dialog.' }),
  pruneTitle: msg({ id: 'git.health.prune.title', defaultMessage: 'Prune worktree entries', description: 'HI-3473: the title of the Prune Worktrees dialog.' }),
  pruneMessage: msg({ id: 'git.health.prune.message', defaultMessage: "Git still keeps an entry for each of these worktrees, whose folder is gone, and refuses a new worktree at the same place. Pruning drops the ticked entries, each only if git still lists it so: nothing on disk outside git's own folder changes.", description: 'HI-3473: the Prune Worktrees dialog: what it lists and does.' }),
  pruneConfirm: msg({ id: 'git.health.prune.confirm', defaultMessage: 'Prune Ticked', description: "HI-3473: the Prune Worktrees dialog's button: drops the ticked entries." }),
  pruneBusy: msg({ id: 'git.health.prune.busy', defaultMessage: 'Pruning…', description: "HI-3473: the Prune Worktrees dialog's button while it runs." }),
  pruneFailed: msg({ id: 'git.health.prune.failed', defaultMessage: "Couldn't prune the worktree entries", description: "HI-3473: an error's title: Prune Worktrees failed or was refused." }),
  noFolder: msg({ id: 'git.health.prune.noFolder', defaultMessage: '(entry {id}: git names no folder)', description: "HI-3473: in the Prune Worktrees dialog, an entry whose record doesn't say where its folder was; {id} is its name in git's folder." }),
  ownerSlot: msg({ id: 'git.health.prune.ownerSlot', defaultMessage: "{name}'s folder: Combwork makes a slot again by itself, so pruning is safe.", description: "HI-3473: beside an entry in the Prune Worktrees dialog: it was the folder of the slot {name} (such as slot-a; glossary: slot)." }),
  ownerAgent: msg({ id: 'git.health.prune.ownerAgent', defaultMessage: "{name}'s worktree: if it was moved, Repair can still find it by this entry, and pruning forgets it. Not ticked for you.", description: "HI-3473: beside an entry in the Prune Worktrees dialog: it was the 1.0-era worktree of the agent {name}; Repair (a command's name) locates a moved worktree by git's entry, which pruning drops." }),
  // Remove stale lock
  locksHead: msg({ id: 'git.health.locks.head', defaultMessage: 'Lock files', description: "HI-3473: a Repository health row's name: git's lock files (index.lock and the like)." }),
  locksState: msg({ id: 'git.health.locks.state', defaultMessage: '{n, plural, =0 {None.} other {{stale, plural, =0 {{n, number} in use or too new to call stale.} other {{stale, number} stale, of {n, number}.}}}}', description: "HI-3473: the Repository health row's state: how many of git's lock files there are ({n}) and how many are stale ({stale})." }),
  locks: msg({ id: 'git.health.locks.button', defaultMessage: 'Remove Stale Locks…', description: 'HI-3473: the button of the lock files row: lists them, to remove the stale ones. Keep the …: it opens a dialog.' }),
  locksTitle: msg({ id: 'git.health.locks.title', defaultMessage: 'Remove stale lock files', description: 'HI-3473: the title of the Remove Stale Locks dialog.' }),
  locksMessage: msg({ id: 'git.health.locks.message', defaultMessage: "A git that is ended or crashes can leave its lock file behind, and every git after it then refuses (\"index.lock: File exists\"). A lock is stale once it is at least {seconds, number} seconds old and no git that started before it still runs. Combwork removes only the ticked ones, each only while it is still that file and still stale, and never ends a process.", description: 'HI-3473: the Remove Stale Locks dialog: what a stale lock is and what removing does. The quoted text is git\'s own error: keep it. {seconds}: Settings → Advanced, Git: how old a lock must be to be stale.' }),
  locksConfirm: msg({ id: 'git.health.locks.confirm', defaultMessage: 'Remove Ticked', description: "HI-3473: the Remove Stale Locks dialog's button: removes the ticked lock files." }),
  locksBusy: msg({ id: 'git.health.locks.busy', defaultMessage: 'Removing…', description: "HI-3473: the Remove Stale Locks dialog's button while it runs." }),
  locksFailed: msg({ id: 'git.health.locks.failed', defaultMessage: "Couldn't remove the lock files", description: "HI-3473: an error's title: Remove Stale Locks failed or was refused." }),
  lockAge: msg({ id: 'git.health.locks.age', defaultMessage: 'written {when}', description: 'HI-3473: beside a lock file in the Remove Stale Locks dialog: when it was last written ({when}: a time ago, such as "5 minutes ago").' }),
  held: msg({
    id: 'git.health.locks.held',
    defaultMessage: '{why, select, young {Kept: less than {seconds, number} seconds old, a git may be using it.} process {Kept: {name} (process {pid, number}) started {when}, before this lock, and still runs.} other {Kept: Windows’ list of processes couldn’t be read.}}',
    description: "HI-3473: why a lock file in the Remove Stale Locks dialog can't be removed (select: translate each). {name} is a program's name (git.exe), {pid} its process id, {when} a time ago."
  }),
  // Fetch with prune
  fetchHead: msg({ id: 'git.health.fetch.head', defaultMessage: 'Remote-tracking branches', description: "HI-3473: a Repository health row's name: this repository's copies of the remotes' branches (origin/main…)." }),
  fetchState: msg({ id: 'git.health.fetch.state', defaultMessage: "{n, plural, =0 {No remote.} other {Those deleted on the remote stay here until a fetch prunes them.}}", description: "HI-3473: the Repository health row's state ({n}: how many remotes the repository has)." }),
  fetch: msg({ id: 'git.health.fetch.button', defaultMessage: 'Fetch with Prune…', description: "HI-3473: the button of the remote-tracking branches row: asks each remote which of its branches are gone, then fetches and drops them here (git fetch --prune). Keep the …: it opens a dialog." }),
  checking: msg({ id: 'git.health.fetch.checking', defaultMessage: 'Asking the remotes which branches are gone…', description: 'HI-3473: a notice while Fetch with Prune asks each remote (git remote prune --dry-run), with a Cancel.' }),
  checkFailed: msg({ id: 'git.health.fetch.checkFailed', defaultMessage: "Couldn't ask the remotes", description: "HI-3473: an error's title: Fetch with Prune's check of the remotes failed." }),
  fetchTitle: msg({ id: 'git.health.fetch.title', defaultMessage: 'Fetch with prune', description: 'HI-3473: the title of the Fetch with Prune dialog.' }),
  fetchMessage: msg({ id: 'git.health.fetch.message', defaultMessage: "{n, plural, =0 {No remote-tracking branch here is gone from its remote. Fetching with prune would drop none.} other {These remote-tracking branches are gone from their remote. Fetching with prune drops them here; the remote isn't changed, and no local branch is deleted.}}", description: 'HI-3473: the Fetch with Prune dialog: what it found ({n}: how many branches) and what fetching does.' }),
  fetchConfirm: msg({ id: 'git.health.fetch.confirm', defaultMessage: 'Fetch and Prune', description: "HI-3473: the Fetch with Prune dialog's button: git fetch --prune from the remotes listed." }),
  fetchBusy: msg({ id: 'git.health.fetch.busy', defaultMessage: 'Fetching…', description: "HI-3473: the Fetch with Prune dialog's button while it runs." }),
  fetching: msg({ id: 'git.health.fetch.fetching', defaultMessage: 'Fetching with prune from {remotes}…', description: 'HI-3473: a notice while Fetch with Prune runs, with a Cancel. {remotes} lists the remotes.' }),
  trackedBy: msg({ id: 'git.health.fetch.trackedBy', defaultMessage: '{branches} {n, plural, one {tracks} other {track}} it: {n, plural, one {its} other {their}} upstream then shows as gone.', description: 'HI-3473: beside a remote-tracking branch in the Fetch with Prune dialog: local branches ({branches}, their names; {n} of them) follow it; they stay, their upstream marked gone.' }),
  remoteError: msg({ id: 'git.health.fetch.remoteError', defaultMessage: "{remote} couldn't be asked: {why}", description: "HI-3473: in the Fetch with Prune dialog, a remote that couldn't be reached ({why}: git's error line); it isn't fetched." }),
  remoteHead: msg({ id: 'git.health.fetch.remote', defaultMessage: 'On {remote} ({n, number})', description: 'HI-3473: a heading in the Fetch with Prune dialog: the remote-tracking branches of the remote {remote} that are gone from it.' })
}
const T = HEALTH_TEXT

/** Why a lock is kept, as its row says it. */
const heldText = (h: LockHeld): string =>
  h.why === 'young' ? tr(T.held, { why: 'young', seconds: h.seconds, name: '', pid: 0, when: '' }) : h.why === 'process' ? tr(T.held, { why: 'process', seconds: 0, name: h.name, pid: h.pid, when: timeAgo(new Date(h.started).toISOString()) }) : tr(T.held, { why: 'unlisted', seconds: 0, name: '', pid: 0, when: '' }) // i18n-ignore: the select's keys, never shown

/** A list of tick boxes: `rows` each with its key, its label and an optional note; `on` those ticked to start with. */
function Ticks<R>({ rows, keyOf, label, note, on, enabled, onChange, data }: { rows: R[]; keyOf: (r: R) => string; label: (r: R) => string; note?: (r: R) => string | null; on: (r: R) => boolean; enabled?: (r: R) => boolean; onChange: (picked: R[]) => void; data: string }) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(rows.filter(on).map(keyOf)))
  // A block, never the call's value as the effect's: React would take a returned value for its cleanup.
  useEffect(() => {
    onChange(rows.filter((r) => ticked.has(keyOf(r))))
  }, [rows, ticked, keyOf, onChange])
  return (
    <div className="git-cleanup">
    <ul className="git-cleanup-list git-health-list">
      {rows.map((r) => {
        const k = keyOf(r)
        const can = enabled ? enabled(r) : true
        const n = note?.(r)
        return (
          <li key={k}>
            <label className="dialog-check">
              <input
                type="checkbox"
                className="checkbox"
                {...{ [`data-${data}`]: k }}
                disabled={!can}
                checked={can && ticked.has(k)}
                onChange={(e) => {
                  const next = new Set(ticked)
                  if (e.target.checked) next.add(k)
                  else next.delete(k)
                  setTicked(next)
                }}
              />
              <code>{label(r)}</code>
            </label>
            {n && <div className="faint git-health-note">{n}</div>}
          </li>
        )
      })}
    </ul>
    </div>
  )
}

/** HI-3473: Repository health, at the foot of Branches & remotes. `off`: another action runs, or the folder is another repository's (read only). */
export function RepoHealth({ project, off, remotes }: { project: ProjectInfo; off: boolean; remotes: readonly string[] }) {
  const read = useGitRead('git:health', project)
  const [busy, setBusy] = useState(false)
  if (!offered('git:health')) return null
  const h = read.data
  const disabled = off || busy || read.loading
  const after = (): void => {
    bumpGit(project.path)
    read.reload()
  }

  const prune = async (rows: PrunableWorktree[]): Promise<void> => {
    let picked: PrunableWorktree[] = []
    await confirm({
      title: tr(T.pruneTitle),
      message: tr(T.pruneMessage),
      wide: true,
      content: (
        <Ticks
          rows={rows}
          data="health-prune"
          keyOf={(r) => r.id}
          label={(r) => r.folder ?? tr(T.noFolder, { id: r.id })}
          note={(r) => [r.reason, r.owner?.kind === 'slot' ? tr(T.ownerSlot, { name: r.owner.name }) : r.owner?.kind === 'agent' ? tr(T.ownerAgent, { name: r.owner.name }) : ''].filter(Boolean).join(' · ') || null}
          on={(r) => r.owner?.kind !== 'agent'}
          onChange={(p) => (picked = p)}
        />
      ),
      confirmLabel: tr(T.pruneConfirm),
      busyLabel: tr(T.pruneBusy),
      danger: true,
      run: async () => {
        if (!picked.length) return
        try {
          notify('success', await repoOp('git:pruneWorktrees', project.path, picked.map((r) => ({ id: r.id, folder: r.folder }))))
        } finally {
          after()
        }
      }
    })
  }

  const removeLocks = async (rows: GitLockFile[], seconds: number): Promise<void> => {
    let picked: GitLockFile[] = []
    await confirm({
      title: tr(T.locksTitle),
      message: tr(T.locksMessage, { seconds }),
      wide: true,
      content: (
        <Ticks
          rows={rows}
          data="health-lock"
          keyOf={(r) => r.path}
          label={(r) => r.path}
          note={(r) => [tr(T.lockAge, { when: timeAgo(new Date(r.at).toISOString()) }), r.held ? heldText(r.held) : ''].filter(Boolean).join(' · ')}
          on={(r) => !r.held}
          enabled={(r) => !r.held}
          onChange={(p) => (picked = p)}
        />
      ),
      confirmLabel: tr(T.locksConfirm),
      busyLabel: tr(T.locksBusy),
      danger: true,
      run: async () => {
        if (!picked.length) return
        try {
          notify('success', await repoOp('git:removeLocks', project.path, picked.map((r) => ({ path: r.path, stamp: r.stamp }))))
        } finally {
          after()
        }
      }
    })
  }

  const fetchPrune = async (): Promise<void> => {
    setBusy(true)
    let found: RemotePrune[] | undefined
    try {
      found = await gitRun(project.path, tr(T.checkFailed), (op) => repoOp('git:remotePrunePreview', project.path, op), { running: tr(T.checking) })
    } finally {
      setBusy(false)
    }
    if (!found) return
    const reached = found.filter((r) => !r.error).map((r) => r.remote)
    const n = found.reduce((a, r) => a + r.branches.length, 0)
    await confirm({
      title: tr(T.fetchTitle),
      message: tr(T.fetchMessage, { n }),
      wide: true,
      content: (
        <div className="git-cleanup" data-health-fetch="">
          {found.map((r) =>
            r.error ? (
              <div key={r.remote} className="banner warn" data-health-fetch-error={r.remote}>
                <Icon name="warning" /> {tr(T.remoteError, { remote: r.remote, why: r.error })}
              </div>
            ) : r.branches.length ? (
              <div key={r.remote}>
                <div className="git-cleanup-h">{tr(T.remoteHead, { remote: r.remote, n: r.branches.length })}</div>
                <ul className="git-cleanup-list git-health-list">
                  {r.branches.map((b) => (
                    <li key={b.name} data-health-fetch-branch={b.name}>
                      <code>{b.name}</code>
                      {b.trackedBy.length > 0 && <div className="faint git-health-note">{tr(T.trackedBy, { branches: fmt.list(b.trackedBy, 'unit'), n: b.trackedBy.length })}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          )}
        </div>
      ),
      ...(reached.length ? { confirmLabel: tr(T.fetchConfirm), busyLabel: tr(T.fetchBusy) } : { okOnly: true }),
      run: reached.length
        ? async () => {
            const going = startGitRun(project.path, tr(T.fetching, { remotes: fmt.list(reached) }))
            try {
              notify('success', await repoOp('git:fetchPrune', project.path, reached, going.op))
            } finally {
              going.end()
              after()
            }
          }
        : undefined
    })
  }

  const stale = h ? h.locks.filter((l) => !l.held) : []
  const state = (text: string | null): string => (read.error && !h ? tr(T.readFailed, { error: read.error }) : text === null ? tr(T.reading) : text)
  return (
    <>
      <h2 className="section git-section-head">
        {tr(T.title)}
        <span className="git-section-actions">
          <IconButton icon={read.loading ? 'loading' : 'refresh'} spin={read.loading} title={tr(T.readAgain)} action="reload-health" onClick={read.reload} />
        </span>
      </h2>
      <p className="hint">{tr(T.about)}</p>
      <table className="kv git-health" data-git-health="">
        <tbody>
          <tr data-health-row="worktrees">
            <td>{tr(T.pruneHead)}</td>
            <td data-health-state="worktrees">{state(h ? tr(T.pruneState, { n: h.worktrees.length }) : null)}</td>
            <td>
              <button className="btn small" data-action="health-prune" disabled={disabled || !h?.worktrees.length} onClick={() => h && void prune(h.worktrees)}>
                {tr(T.prune)}
              </button>
            </td>
          </tr>
          <tr data-health-row="locks">
            <td>{tr(T.locksHead)}</td>
            <td data-health-state="locks">{state(h ? tr(T.locksState, { n: h.locks.length, stale: stale.length }) : null)}</td>
            <td>
              <Tooltip content={h?.locks.length && !stale.length ? h.locks.map((l) => `${l.path}: ${l.held ? heldText(l.held) : ''}`).join('\n') : null}>
                <span>
                  <button className="btn small" data-action="health-locks" disabled={disabled || !h?.locks.length} onClick={() => h && void removeLocks(h.locks, h.staleSeconds)}>
                    {tr(T.locks)}
                  </button>
                </span>
              </Tooltip>
            </td>
          </tr>
          {offered('git:fetchPrune') && (
            <tr data-health-row="fetch">
              <td>{tr(T.fetchHead)}</td>
              <td data-health-state="fetch">{tr(T.fetchState, { n: remotes.length })}</td>
              <td>
                <button className="btn small" data-action="health-fetch" disabled={disabled || !remotes.length} onClick={() => void fetchPrune()}>
                  {busy && <Icon name="loading" spin />} {tr(T.fetch)}
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  )
}
