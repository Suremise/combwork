import { useEffect, useId, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import type { ResolvedStart, StartPoints } from '@shared/nextVersion'
import { call } from '../api'
import { cx } from '../util'

// HI-2807 (SPEC §16.13.2): New branch…'s form. Its name, checked as it is typed (git's rules, no branch or tag of that
// name); where it starts (a branch, a tag or a commit: the folder's by default), with what that resolves to; and Switch
// to it now, on only while it starts at the folder's own commit and the folder may move. The dialog's button creates it
// from the commit shown here (pinned: refused if the ref moved meanwhile).

const M = {
  name: msg({ id: 'git.newBranch.name', defaultMessage: 'Name', description: 'HI-2807: the label of the New branch form’s name box.' }),
  startsAt: msg({ id: 'git.newBranch.startsAt', defaultMessage: 'Starts at', description: 'HI-2807: the label of the New branch form’s box for where the branch starts: a branch, a tag or a commit.' }),
  startsAtHint: msg({ id: 'git.newBranch.startsAtHint', defaultMessage: 'A branch, a tag or a commit', description: 'HI-2807: the placeholder of the New branch form’s Starts at box.' }),
  resolved: msg({ id: 'git.newBranch.resolved', defaultMessage: '{kind, select, branch {Branch} tag {Tag} remote {Remote branch} other {Commit}} at {commit}: {subject}', description: 'HI-2807: under Starts at, what it names: its kind, the commit {commit} (short hash) and that commit’s subject {subject}. Keep the select keys.' }),
  noStart: msg({ id: 'git.newBranch.noStart', defaultMessage: 'No branch, tag or commit called {ref}', description: 'HI-2807: under Starts at, when the repository has nothing of the name typed ({ref}).' }),
  switchElsewhere: msg({ id: 'git.newBranch.switchElsewhere', defaultMessage: 'It starts somewhere other than the folder’s commit: switching moves the project folder there.', description: 'HI-2807: under Switch to it now, ticked while the branch starts at another commit than the project folder’s.' })
}

/** What the form holds, read by the dialog's button when it is pressed. */
export interface NewBranchDraft {
  name: string
  start: string
  resolved: ResolvedStart | null
  switchNow: boolean
}

export function NewBranchForm({ projectPath, onChange, initialStart, blocked, switchLabel, placeholder }: { projectPath: string; onChange: (draft: NewBranchDraft) => void; initialStart: string; blocked: string | null; switchLabel: string; placeholder: string }) {
  const id = useId()
  const [name, setName] = useState('')
  const [start, setStart] = useState(initialStart)
  const [resolved, setResolved] = useState<ResolvedStart | null | undefined>(undefined)
  const [folderCommit, setFolderCommit] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [points, setPoints] = useState<StartPoints | null>(null)
  const [touched, setTouched] = useState(false)
  const [switchNow, setSwitchNow] = useState(!blocked)

  useEffect(() => {
    let live = true
    void call('git:startPoints', projectPath).then((p) => live && setPoints(p), () => undefined)
    void call('git:resolveStart', projectPath, initialStart).then((r) => live && setFolderCommit(r?.commit ?? null), () => undefined)
    return () => {
      live = false
    }
  }, [projectPath, initialStart])
  // Where it starts, resolved as it is typed (after a pause): the commit the button creates it at.
  useEffect(() => {
    let live = true
    setResolved(undefined)
    const t = setTimeout(() => void call('git:resolveStart', projectPath, start).then((r) => live && setResolved(r), () => live && setResolved(null)), 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [projectPath, start])
  // Its name checked as it is typed: git's rules, and no branch or tag of that name already.
  useEffect(() => {
    let live = true
    const v = name.trim()
    if (!v) return setProblem(null)
    const t = setTimeout(() => void call('git:checkBranchName', projectPath, v).then((p) => live && setProblem(p), () => undefined), 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [projectPath, name])

  const atFolder = !!resolved && !!folderCommit && resolved.commit === folderCommit
  // Untouched, it switches only where it starts at the folder's own commit (and the folder may move).
  const shownSwitch = !blocked && (touched ? switchNow : atFolder)
  useEffect(() => {
    onChange({ name: name.trim(), start: start.trim(), resolved: resolved ?? null, switchNow: shownSwitch })
  }, [onChange, name, start, resolved, shownSwitch])
  const list = `${id}-points`
  return (
    <div className="new-branch-form" data-new-branch="">
      <label className="dialog-field-label" htmlFor={`${id}-name`}>
        {tr(M.name)}
      </label>
      <input id={`${id}-name`} className={cx('input', problem && 'invalid')} data-field="name" autoFocus placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} />
      {problem && <div className="s-desc error" data-problem="name">{problem}</div>}
      <label className="dialog-field-label" htmlFor={`${id}-start`}>
        {tr(M.startsAt)}
      </label>
      <input id={`${id}-start`} className={cx('input mono' /* i18n-ignore: class names */, resolved === null && 'invalid')} data-field="start" list={list} placeholder={tr(M.startsAtHint)} value={start} onChange={(e) => setStart(e.target.value)} />
      <datalist id={list}>{points && [...points.branches, ...points.tags, ...points.remote].map((p) => <option key={p} value={p} />)}</datalist>
      <div className={cx('s-desc', resolved === null && 'error')} data-resolved="">
        {resolved ? tr(M.resolved, { kind: resolved.kind, commit: resolved.short, subject: resolved.subject }) : resolved === null && start.trim() ? tr(M.noStart, { ref: start.trim() }) : ' '}
      </div>
      <label className="flex dialog-check">
        <input
          type="checkbox"
          data-field="switch"
          checked={shownSwitch}
          disabled={!!blocked}
          onChange={(e) => {
            setTouched(true)
            setSwitchNow(e.target.checked)
          }}
        />{' '}
        {switchLabel}
      </label>
      {shownSwitch && resolved && !atFolder && <div className="s-desc">{tr(M.switchElsewhere)}</div>}
    </div>
  )
}
