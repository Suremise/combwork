import { useEffect, useId, useState } from 'react'
import { fmt, msg, tr } from '@shared/i18n'
import type { NextVersionPlan, RetargetResult, WorkflowForm } from '@shared/types'
import { call, errorMessage } from '../api'
import { confirm, notify } from '../store'
import { cx } from '../util'
import { RetargetDetails, retargetSkippedText } from './WorkflowOptions'

// HI-2807 (SPEC §16.6.2, §16.13.2): Start the next version, and a missing target's offer to create itself, in a
// project's Workflow section (Version Control → Workflow).

const M = {
  button: msg({ id: 'workflow.nextVersion.button', defaultMessage: 'Start the next version…', description: 'HI-2807: a button under Work merges into, while it is a version branch (1.3.0): opens the Start the next version dialog.' }),
  tip: msg({ id: 'workflow.nextVersion.tip', defaultMessage: 'A new branch from {from} for the next version: work merges into it from then on, and {from} stays a branch work can merge into.', description: 'HI-2807: tooltip of Start the next version…. {from} is the release branch (Work merges into now).' }),
  title: msg({ id: 'workflow.nextVersion.title', defaultMessage: 'Start the next version', description: 'HI-2807: the title of the Start the next version dialog.' }),
  message: msg({ id: 'workflow.nextVersion.message', defaultMessage: 'Work merges into {from} now. The next version gets a branch of its own, made from {from} as it is:', description: 'HI-2807: the Start the next version dialog’s first line. {from} is the release branch.' }),
  name: msg({ id: 'workflow.nextVersion.name', defaultMessage: 'Next version’s branch', description: 'HI-2807: the label of the box with the new branch’s name in the Start the next version dialog.' }),
  stepCreate: msg({ id: 'workflow.nextVersion.stepCreate', defaultMessage: 'Create {name} from {from} ({commit})', description: 'HI-2807: a step the Start the next version dialog lists: make the branch {name} at {from}’s head, the commit {commit} (short hash).' }),
  stepAdd: msg({ id: 'workflow.nextVersion.stepAdd', defaultMessage: 'Add {from} to Other branches work can merge into', description: 'HI-2807: a step the Start the next version dialog lists. Other branches work can merge into is an option’s name: as translated there.' }),
  stepListed: msg({ id: 'workflow.nextVersion.stepListed', defaultMessage: '{from} stays in Other branches work can merge into', description: 'HI-2807: a step the Start the next version dialog lists, when the release branch is listed there already.' }),
  stepTarget: msg({ id: 'workflow.nextVersion.stepTarget', defaultMessage: 'Work merges into: {from} → {name}', description: 'HI-2807: a step the Start the next version dialog lists: the option Work merges into (as translated there) moves from {from} to {name}.' }),
  stays: msg({ id: 'workflow.nextVersion.stays', defaultMessage: 'Running lanes and started cards stay on {from}.', description: 'HI-2807: under the steps in the Start the next version dialog: what doesn’t move.' }),
  noStart: msg({ id: 'workflow.nextVersion.noStart', defaultMessage: '{from} isn’t a branch in this repository, so nothing can start from it.', description: 'HI-2807: the Start the next version dialog when the release branch doesn’t exist.' }),
  enterName: msg({ id: 'workflow.nextVersion.enterName', defaultMessage: 'Name the next version’s branch', description: 'HI-2807: an error in the Start the next version dialog: the name box is empty.' }),
  start: msg({ id: 'workflow.nextVersion.start', defaultMessage: 'Start', description: 'HI-2807: the Start the next version dialog’s button.' }),
  starting: msg({ id: 'workflow.nextVersion.starting', defaultMessage: 'Starting…', description: 'HI-2807: the Start the next version dialog’s button while it runs.' }),
  done: msg({ id: 'workflow.nextVersion.done', defaultMessage: 'Started {name} from {from}: work merges into {name} now{added, select, yes {, and {from} is one of the other branches work can merge into} other {}}.', description: 'HI-2807: a notification after Start the next version. {name} the new branch, {from} the release.' }),
  doneMoved: msg({ id: 'workflow.nextVersion.doneMoved', defaultMessage: 'Started {name} from {from}: work merges into {name} now. Moved {cards, plural, one {# card} other {# cards}} and {slots, plural, one {# slot} other {# slots}} to it{skipped, plural, =0 {} other {; # left where they were}}.', description: 'HI-2807: a notification after Start the next version with Also retarget ticked.' }),
  planFailed: msg({ id: 'workflow.nextVersion.planFailed', defaultMessage: 'Couldn’t read what Start the next version would do', description: 'HI-2807: an error notification’s title.' }),
  missing: msg({ id: 'workflow.missing.line', defaultMessage: '{branch} doesn’t exist: create it from', description: 'HI-2807: under Work merges into or Other branches work can merge into, for a branch named there that the repository hasn’t got; a drop-down of branches and a Create button follow.' }),
  missingFrom: msg({ id: 'workflow.missing.from', defaultMessage: 'Where {branch} starts', description: 'HI-2807: the accessible name of the drop-down of branches a missing branch {branch} can be created from.' }),
  create: msg({ id: 'workflow.missing.create', defaultMessage: 'Create', description: 'HI-2807: the button beside a missing branch: creates it from the branch picked, without switching to it.' }),
  createFailed: msg({ id: 'workflow.missing.failed', defaultMessage: 'Couldn’t create {branch}', description: 'HI-2807: an error notification’s title.' })
}

/** The draft the dialog's button reads. */
interface Draft {
  name: string
  retarget: Set<'on'>
}

function NextVersionForm({ projectPath, plan, retarget, onName }: { projectPath: string; plan: NextVersionPlan; retarget: Set<'on'>; onName: (name: string) => void }) {
  const id = useId()
  const [name, setName] = useState(plan.name)
  const [problem, setProblem] = useState<string | null>(null)
  const [, redraw] = useState(0)
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
  useEffect(() => onName(name.trim()), [onName, name])
  const shown = name.trim() || plan.name
  if (!plan.start) return <div className="s-desc error">{tr(M.noStart, { from: plan.from })}</div>
  return (
    <div className="next-version-form" data-next-version="">
      <label className="dialog-field-label" htmlFor={`${id}-name`}>
        {tr(M.name)}
      </label>
      <input id={`${id}-name`} className={cx('input mono' /* i18n-ignore: class names */, problem && 'invalid')} data-field="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      {problem && <div className="s-desc error" data-problem="name">{problem}</div>}
      <ul className="next-version-steps">
        <li data-step="create">{tr(M.stepCreate, { name: shown, from: plan.from, commit: plan.start.short })}</li>
        <li data-step="other">{tr(plan.listed ? M.stepListed : M.stepAdd, { from: plan.from })}</li>
        <li data-step="target">{tr(M.stepTarget, { from: plan.from, name: shown })}</li>
      </ul>
      <div className="s-desc">{tr(M.stays, { from: plan.from })}</div>
      {plan.retarget && <RetargetDetails preview={{ ...plan.retarget, to: shown }} choice={retarget} onChange={() => redraw((n) => n + 1)} />}
    </div>
  )
}

/**
 * Opens Start the next version (HI-2807): the plan read first, then the dialog; its button starts it in one call (the
 * branch, Other branches, Work merges into: main refuses if the release moved or the options changed since), then the
 * retarget as confirmed. `saved` gets the form as saved.
 */
export async function startNextVersion(projectPath: string, saved: (form: WorkflowForm) => void): Promise<void> {
  let plan: NextVersionPlan
  try {
    plan = await call('workflow:nextVersionPlan', projectPath)
  } catch (e) {
    return notify('error', tr(M.planFailed), errorMessage(e))
  }
  const movable = plan.retarget ? plan.retarget.cards.move.length + plan.retarget.slots.move.length : 0
  const draft: Draft = { name: plan.name, retarget: new Set(movable ? ['on'] : []) }
  let said: { level: 'success' | 'warning'; text: string; detail?: string } | null = null
  await confirm({
    title: tr(M.title),
    message: tr(M.message, { from: plan.from }),
    wide: true,
    content: <NextVersionForm projectPath={projectPath} plan={plan} retarget={draft.retarget} onName={(n) => (draft.name = n)} />,
    confirmLabel: tr(M.start),
    busyLabel: tr(M.starting),
    run: async () => {
      if (!plan.start) throw new Error(tr(M.noStart, { from: plan.from }))
      if (!draft.name) throw new Error(tr(M.enterName))
      const problem = await call('git:checkBranchName', projectPath, draft.name)
      if (problem) throw new Error(problem)
      const r = await call('workflow:startNextVersion', projectPath, { name: draft.name, from: { ref: plan.from, commit: plan.start.commit }, base: plan.base })
      saved(r.form)
      said = { level: 'success', text: tr(M.done, { name: r.name, from: r.from, added: r.added ? 'yes' : 'no' }) }
      if (plan.retarget && draft.retarget.has('on')) {
        const moved: RetargetResult | null = await call('workflow:retarget', projectPath, { ...plan.retarget, to: r.name }).catch((e: unknown) => {
          said = { level: 'warning', text: tr(M.done, { name: r.name, from: r.from, added: r.added ? 'yes' : 'no' }), detail: errorMessage(e) }
          return null
        })
        if (moved) said = { level: moved.skipped.length ? 'warning' : 'success', text: tr(M.doneMoved, { name: r.name, from: r.from, cards: moved.moved.cards.length, slots: moved.moved.slots.length, skipped: moved.skipped.length }), detail: retargetSkippedText(moved) || undefined }
      }
    }
  })
  const s = said as { level: 'success' | 'warning'; text: string; detail?: string } | null
  if (s) notify(s.level, s.text, s.detail)
}

/** Start the next version…, under Work merges into while it reads as a version (and nothing is unsaved). */
export function NextVersionButton({ from, disabled, onStart }: { from: string; disabled: boolean; onStart: () => void }) {
  return (
    <div className="s-desc workflow-next-version">
      <button className="btn small" data-action="next-version" disabled={disabled} title={tr(M.tip, { from })} onClick={onStart}>
        {tr(M.button)}
      </button>
    </div>
  )
}

/**
 * HI-2807: branches newly named in Work merges into or Other branches that the repository hasn't got, each with an offer
 * to create it (from a branch picked, the project's target by default), switching nothing. `created` reads the branches
 * again.
 */
export function MissingBranches({ projectPath, missing, branches, from, created }: { projectPath: string; missing: string[]; branches: string[]; from: string; created: () => void }) {
  if (!missing.length) return null
  return (
    <>
      {missing.map((b) => (
        <MissingBranch key={b} projectPath={projectPath} branch={b} branches={branches} from={branches.includes(from) ? from : (branches[0] ?? '')} created={created} />
      ))}
    </>
  )
}

function MissingBranch({ projectPath, branch, branches, from, created }: { projectPath: string; branch: string; branches: string[]; from: string; created: () => void }) {
  const [pick, setPick] = useState(from)
  const [busy, setBusy] = useState(false)
  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const done = await call('git:createBranch', projectPath, branch, true, { ref: pick, commit: '' })
      notify('success', done)
      created()
    } catch (e) {
      notify('error', tr(M.createFailed, { branch }), errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="workflow-contradiction workflow-missing" role="alert" data-missing={branch}>
      <span>{tr(M.missing, { branch })}</span>{' '}
      <select className="select small" aria-label={tr(M.missingFrom, { branch })} value={pick} onChange={(e) => setPick(e.target.value)}>
        {branches.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>{' '}
      <button className="btn small" data-action="create-missing" disabled={busy || !pick} onClick={() => void create()}>
        {tr(M.create)}
      </button>
    </div>
  )
}

/** The branches named as targets in `options` that `before` didn't name. */
export const newlyNamed = (options: { target?: string; otherTargets?: string[] }, before: { target?: string; otherTargets?: string[] }): string[] => {
  const names = (o: { target?: string; otherTargets?: string[] }): string[] => [...new Set([o.target ?? '', ...(o.otherTargets ?? [])].map((b) => b.trim()).filter(Boolean))]
  const was = new Set(names(before))
  return names(options).filter((b) => !was.has(b))
}

export const MISSING_SAVE = msg({ id: 'workflow.missing.save', defaultMessage: 'Create {branches} first: {n, plural, one {it doesn’t} other {they don’t}} exist yet.', description: 'HI-2807: why Save is disabled in the Workflow section: branches named as targets ({branches}, {n} of them) don’t exist.' })
export const missingSaveText = (missing: string[]): string => tr(MISSING_SAVE, { n: missing.length, branches: fmt.list(missing) })
