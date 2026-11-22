import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import { msg, tr } from '@shared/i18n'
import { mineIsTheirs, OPERATION_STEPS, operationCommand, pickCommand, submoduleUpdateCommand, type ConflictPick, type GitConflict, type OperationPanelState, type OperationRequest, type OperationStep } from '@shared/gitOperations'
import { call, errorMessage } from '../api'
import { attempt } from '../actions'
import { bumpGit, confirm, notify } from '../store'
import { Icon, Tooltip } from './ui'

// HI-3470: Changes' panel for a git operation left under way in the folder it shows (the project folder, an agent's
// slot, a free slot): the operation, Continue / Skip / Abort (a bisect: End bisect), and each conflicted file with Open,
// Use mine, Use theirs and Mark resolved. Every click is checked again in main (operationPanel.ts) before git runs: it
// refuses while a session, a process or one of Combwork's own steps is in the folder. A lent slot asks the user first,
// naming its card.

const T = {
  title: msg({ id: 'git.operation.title', defaultMessage: 'Unfinished git {what} in {folder}', description: "HI-3470: the heading of the panel in Version Control → Changes when a git operation was left under way in the folder shown. {what} is git's word for it (merge, rebase, am, cherry-pick, revert, bisect: keep it as it is); {folder} is a slot's name or the project folder (git.operation.projectFolder)." }),
  projectFolder: msg({ id: 'git.operation.projectFolder', defaultMessage: 'the project folder', description: 'HI-3470: {folder} in git.operation.title and the dialogs when the folder shown is the project folder.' }),
  at: msg({ id: 'git.operation.at', defaultMessage: 'Stopped at {commit} {subject}', description: 'HI-3470: under the panel\'s heading: the commit git stopped at ({commit}, a short commit id; {subject}, its first line), or for a merge the commit being merged.' }),
  step: msg({ id: 'git.operation.step', defaultMessage: 'Step {at, number} of {of, number}', description: "HI-3470: under the panel's heading, for a rebase or an am: which commit of the list git stopped at." }),
  continue: msg({ id: 'git.operation.continue', defaultMessage: 'Continue', description: "HI-3470: the panel's button: git goes on with the operation (git <op> --continue), taking its prepared message." }),
  skip: msg({ id: 'git.operation.skip', defaultMessage: 'Skip', description: "HI-3470: the panel's button: git drops the commit it stopped at and goes on (git <op> --skip). It is also the confirm button of the dialog that asks first, beside the dialog's Cancel (shell.dialog.cancel): it must read differently from it (HI-3504)." }),
  abort: msg({ id: 'git.operation.abort', defaultMessage: 'Abort', description: "HI-3470: the panel's button: git ends the operation and puts the folder back as it was (git <op> --abort). It is also the confirm button of the dialog that asks first, beside the dialog's Cancel (shell.dialog.cancel): it must read differently from it (HI-3504)." }),
  endBisect: msg({ id: 'git.operation.endBisect', defaultMessage: 'End bisect', description: "HI-3470: the panel's button for a bisect: git bisect reset (good and bad stay the user's, in a terminal). It is also the confirm button of the dialog that asks first, beside the dialog's Cancel (shell.dialog.cancel): it must read differently from it (HI-3504)." }),
  runs: msg({ id: 'git.operation.runs', defaultMessage: 'Runs {command}', description: 'HI-3470: a tooltip on the panel\'s buttons: the git command it runs ({command}, as it is).' }),
  unresolved: msg({ id: 'git.operation.unresolved', defaultMessage: '{count, plural, one {# file is} other {# files are}} still in conflict: settle {count, plural, one {it} other {them}} first.', description: 'HI-3470: why Continue is greyed out (its tooltip): files still in conflict.' }),
  conflicts: msg({ id: 'git.operation.conflicts', defaultMessage: 'In conflict ({count, number})', description: "HI-3470: the heading of the panel's list of conflicted files." }),
  open: msg({ id: 'git.operation.open', defaultMessage: 'Open', description: 'HI-3470: a conflicted file\'s button: opens it in the editor, to settle it by hand.' }),
  mine: msg({ id: 'git.operation.mine', defaultMessage: 'Use mine', description: "HI-3470: a conflicted file's button: takes the folder's own side of it (its tooltip says which that is)." }),
  theirs: msg({ id: 'git.operation.theirs', defaultMessage: 'Use theirs', description: "HI-3470: a conflicted file's button: takes the other side of it." }),
  resolved: msg({ id: 'git.operation.resolved', defaultMessage: 'Mark resolved', description: "HI-3470: a conflicted file's button: marks it settled as it is now in the folder (after editing it by hand: git add)." }),
  mineTip: msg({ id: 'git.operation.mineTip', defaultMessage: "{swap, select, yes {Your side: the commit being applied (git calls it theirs here).} other {Your side: this folder's branch (git calls it ours).}} {has, select, yes {Takes its version of the file.} submodule {Stages its commit of the submodule.} other {It deleted the file: deletes it.}} Runs {command}", description: "HI-3470: Use mine's tooltip. swap yes: a rebase, where git's names for the sides are swapped. has no: that side deleted the file; submodule (HI-3502): the file is a submodule, and that side's commit of it is staged. {command} is the git command, as it is." }),
  theirsTip: msg({ id: 'git.operation.theirsTip', defaultMessage: "{swap, select, yes {The other side: the branch being rebased onto (git calls it ours here).} other {The other side: what is being merged, picked or reverted (git calls it theirs).}} {has, select, yes {Takes its version of the file.} submodule {Stages its commit of the submodule.} other {It deleted the file: deletes it.}} Runs {command}", description: "HI-3470: Use theirs' tooltip, as git.operation.mineTip." }),
  submoduleStaged: msg({ id: 'git.operation.submoduleStaged', defaultMessage: "{path} is a submodule: its commit {commit} is staged. Its folder is left as it is: {command, select, none {to check that commit out there, run git submodule update for it in a terminal.} other {to check that commit out there, run {command}}}", description: "HI-3502: a notice after Use mine or Use theirs on a conflicted submodule: that side's commit ({commit}, a short commit id) is staged, and Combwork doesn't check it out in the submodule's own folder. {path} is the submodule's path. {command} is the git command that checks it out, quoted for a shell (keep it as it is); none: its path can't be quoted the same for every shell, so no command is shown ('git submodule update' is a git command: keep it as it is)." }),
  resolvedTip: msg({ id: 'git.operation.resolvedTip', defaultMessage: 'Marks the file settled as it is now, once you have edited it. Runs {command}', description: "HI-3470: Mark resolved's tooltip. {command} is the git command, as it is." }),
  abortTitle: msg({ id: 'git.operation.abortTitle', defaultMessage: '{what, select, bisect {End the bisect in {folder}?} other {Abort the git {what} in {folder}?}}', description: 'HI-3470: the question before Abort (or End bisect). {what} is git\'s word for the operation; {folder} a slot\'s name or git.operation.projectFolder.' }),
  abortMessage: msg({ id: 'git.operation.abortMessage', defaultMessage: "{what, select, rebase {The branch goes back to where it was before the rebase: the commits replayed so far and every conflict settled are dropped.} am {The branch goes back to where it was before the patches: those applied so far and every conflict settled are dropped.} bisect {Git checks out again the commit the bisect started from.} other {Git puts the folder back as it was before the {what} began: every conflict settled so far is dropped. Commits you made yourself since stay.}}", description: "HI-3470: what Abort loses, under git.operation.abortTitle. {what} is git's word for the operation (merge, cherry-pick, revert in other)." }),
  skipTitle: msg({ id: 'git.operation.skipTitle', defaultMessage: 'Skip {commit, select, none {this commit} other {{commit}}} of the git {what}?', description: 'HI-3470: the question before Skip. {commit} is the short id of the commit git stopped at (none: not known); {what} is git\'s word for the operation.' }),
  skipMessage: msg({ id: 'git.operation.skipMessage', defaultMessage: "Its changes are left out, with every conflict settled in it, and git goes on with the next one.", description: 'HI-3470: what Skip loses, under git.operation.skipTitle.' }),
  lentTitle: msg({ id: 'git.operation.lentTitle', defaultMessage: '{slot} is lent to {card, select, none {lane {lane}} other {{card}}}', description: "HI-3470: the question before the panel acts in a slot lent to a card ({card}, its key) or a lane ({lane}, its name) whose builder isn't running. Glossary: slot, lane." }),
  lentMessage: msg({ id: 'git.operation.lentMessage', defaultMessage: "Its builder, {agent}, finds the folder as you leave it. Act on its git {what} anyway?", description: "HI-3470: under git.operation.lentTitle. {agent} is the builder agent's name; {what} git's word for the operation." }),
  goOn: msg({ id: 'git.operation.goOn', defaultMessage: 'Go On', description: 'HI-3470: the button that confirms acting in a lent slot (git.operation.lentTitle).' }),
  done: msg({ id: 'git.operation.done', defaultMessage: "{step, select, continue {Git went on with the {what} in {folder}.} skip {Git skipped a commit of the {what} in {folder}.} other {{what, select, bisect {The bisect in {folder} is ended.} other {The git {what} in {folder} is aborted.}}}}", description: "HI-3470: a notice after the panel's step worked. {what} is git's word for the operation; {folder} a slot's name or git.operation.projectFolder." }),
  stoppedAgain: msg({ id: 'git.operation.stoppedAgain', defaultMessage: "{step, select, skip {Git skipped a commit of the {what} in {folder}, then stopped again.} other {Git went on with the {what} in {folder}, then stopped again.}} The panel shows where.", description: "HI-3503: a notice after Continue or Skip went through and git stopped at the next commit of the operation (in conflict, say): the panel shows the new stop. {what} is git's word for the operation (keep it as it is); {folder} a slot's name or git.operation.projectFolder." }),
  leftTitle: msg({ id: 'git.operation.leftTitle', defaultMessage: 'Files left in conflict in {folder}', description: "HI-3518: the heading of the panel in Version Control → Changes when files are left in conflict with no git operation under way (after a stash's Apply or Pop, say). {folder} is a slot's name or git.operation.projectFolder." }),
  leftFrom: msg({ id: 'git.operation.leftFrom', defaultMessage: '{from, select, stash {From applying the stash “{stash}”: settle each file below. The stash is kept.} other {No git operation is under way: settle each file below.}}', description: "HI-3518: under git.operation.leftTitle: where the conflicts came from. from stash: Combwork applied a stash ({stash}, its message as Stashes lists it), which git keeps when it conflicts; other: Combwork doesn't know (a terminal's command)." }),
  theirsStash: msg({ id: 'git.operation.theirsStash', defaultMessage: "Use the stash's", description: "HI-3518: a conflicted file's button, in place of git.operation.theirs, when the conflict came from applying a stash: takes the stash's side of it." }),
  leftTheirsTip: msg({ id: 'git.operation.leftTheirsTip', defaultMessage: "{from, select, stash {The other side: the stash's (“{stash}”).} other {The other side: what was brought in (git calls it theirs).}} {has, select, yes {Takes its version of the file.} submodule {Stages its commit of the submodule.} other {It deleted the file: deletes it.}} Runs {command}", description: "HI-3518: the tooltip of a conflicted file's other side when files are left in conflict with no git operation under way, as git.operation.theirsTip. from stash: it came from applying a stash ({stash}, its message); other: not known. {command} is the git command, as it is." }),
  failed: msg({ id: 'git.operation.failed', defaultMessage: "Git couldn't do that", description: "HI-3470: the title of the error notice when the panel's step or a conflicted file's button failed or was refused." }),
  unreadable: msg({ id: 'git.operation.unreadable', defaultMessage: "Combwork can't read where git stopped here, so it takes no step: finish it in a terminal.", description: "HI-3470 (a reviewer's round 2): under the panel's heading when git's files that say where the operation stopped can't be read; its buttons are greyed out." }),
  readFailed: msg({ id: 'git.operation.readFailed', defaultMessage: "Couldn't read the git operation under way: {error}", description: 'HI-3470: the panel, when reading the operation failed. {error} is why.' })
}

const STEP_LABEL = { continue: T.continue, skip: T.skip, abort: T.abort } as const

/**
 * The panel, atop Changes' right side above the diff, for the folder `root` shows (`folder`: its name, null for the project folder).
 * Read again whenever `reloadKey` changes (each new status of the folder) and after each of its own steps.
 */
export function OperationPanel({ project, root, folder, reloadKey, onChanged }: { project: ProjectInfo; root: string; folder: string | null; reloadKey: unknown; onChanged: () => void }) {
  const [state, setState] = useState<{ for: string; op: OperationPanelState | null; error?: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const reads = useRef(0)
  const read = useCallback(() => {
    const n = ++reads.current
    void call('git:operation', root).then(
      (op) => n === reads.current && setState({ for: root, op }),
      (e) => n === reads.current && setState({ for: root, op: null, error: errorMessage(e) })
    )
  }, [root])
  useEffect(read, [read, reloadKey])
  const shown = state?.for === root ? state : null
  // The lent slot the user confirmed, for the panel's next steps (asked once while it shows the same lease).
  const confirmed = useRef<string | null>(null)
  if (shown?.error) return <div className="banner warn operation-panel" data-operation-error="">{tr(T.readFailed, { error: shown.error })}</div>
  const op = shown?.op
  if (!op) return null
  const where = folder ?? tr(T.projectFolder)
  const agentName = (id: string): string => project.agents.find((a) => a.id === id)?.name ?? id

  /** The user's go-ahead for a lent slot (once per lease), then the step; refreshed either way. */
  const act = async (key: string, req: OperationRequest, done?: string): Promise<void> => {
    if (busy) return
    if (op.lent && confirmed.current !== op.lent.lease) {
      const ok = await confirm({ title: tr(T.lentTitle, { slot: op.lent.slot, card: op.lent.card ?? 'none', lane: op.lent.lane ?? '' }), message: tr(T.lentMessage, { agent: agentName(op.lent.agent), what: op.what }), confirmLabel: tr(T.goOn) })
      if (!ok) return
      confirmed.current = op.lent.lease
    }
    setBusy(key)
    const r = await attempt(tr(T.failed), () => call('git:operationStep', root, { ...req, ...(op.lent ? { lease: op.lent.lease } : {}) }))
    setBusy(null)
    bumpGit(project.path)
    read()
    onChanged()
    // HI-3503: a Continue or Skip that went through and stopped at the next commit is said so, never as refused.
    if (r?.stoppedAgain && 'step' in req) notify('info', tr(T.stoppedAgain, { step: req.step, what: op.what, folder: where }))
    else if (r !== undefined && done) notify('success', done)
  }

  const step = async (s: OperationStep): Promise<void> => {
    if (s !== 'continue') {
      const ok = await confirm(
        s === 'skip'
          ? { title: tr(T.skipTitle, { commit: op.at?.commit ?? 'none', what: op.what }), message: tr(T.skipMessage), confirmLabel: tr(T.skip), danger: true }
          : { title: tr(T.abortTitle, { what: op.what, folder: where }), message: tr(T.abortMessage, { what: op.what }), confirmLabel: tr(op.what === 'bisect' ? T.endBisect : T.abort), danger: true }
      )
      if (!ok) return
    }
    if (id) await act(s, { what: op.what, id, step: s }, tr(T.done, { step: s, what: op.what, folder: where }))
  }
  const pick = async (c: GitConflict, p: ConflictPick): Promise<void> => {
    // HI-3502: a submodule's side is its commit staged, its folder left as it is: said once it is done.
    const link = p === 'resolved' ? undefined : c.submodule?.[p]
    if (id) await act(`${p}:${c.path}`, { what: op.what, id, file: c.path, pick: p }, link ? tr(T.submoduleStaged, { path: c.path, commit: link.slice(0, 7), command: submoduleUpdateCommand(c.path) ?? 'none' }) : undefined)
  }
  /** A side's word for its tooltip: it has the file, it is a submodule's commit, or it deleted it. */
  const sideHas = (c: GitConflict, side: 'mine' | 'theirs'): string => (c.submodule?.[side] ? 'submodule' : c[side] ? 'yes' : 'no')
  const swap = mineIsTheirs(op.what) ? 'yes' : 'no'
  // Where git stopped can't be read (HR1's round 2): no step is offered, as main would refuse it.
  const id = op.id
  const off = !!busy || !id
  const left = op.conflicts.length
  // HI-3518: the operation under way, or null for files left in conflict with none (no step, only their files).
  const operation = op.what === 'conflicts' ? null : op.what

  return (
    <div className="banner warn operation-panel" data-operation={op.what}>
      <div className="operation-head">
        <Icon name="warning" /> <strong>{operation ? tr(T.title, { what: operation, folder: where }) : tr(T.leftTitle, { folder: where })}</strong>
      </div>
      {!operation && (
        <div className="hint operation-at" data-operation-from={op.from ? 'stash' : ''}>
          {tr(T.leftFrom, { from: op.from ? 'stash' : 'other', stash: op.from?.stash ?? '' })}
        </div>
      )}
      {(op.at || op.step) && (
        <div className="hint operation-at">
          {op.step && tr(T.step, { at: op.step.at, of: op.step.of })}
          {op.step && op.at && ' · '}
          {op.at && tr(T.at, { commit: op.at.commit, subject: op.at.subject })}
        </div>
      )}
      {!id && (
        <div className="hint" data-operation-unreadable="">
          {tr(T.unreadable)}
        </div>
      )}
      {operation && (
        <div className="flex operation-steps">
          {OPERATION_STEPS[operation].map((s) => {
            const blocked = s === 'continue' && left > 0
            return (
              <Tooltip key={s} content={blocked ? tr(T.unresolved, { count: left }) : tr(T.runs, { command: operationCommand(operation, s) })}>
                <button className={s === 'continue' ? 'btn small primary' : 'btn small'} data-step={s} disabled={off || blocked} onClick={() => void step(s)}>
                  {busy === s && <Icon name="loading" spin />} {tr(operation === 'bisect' ? T.endBisect : STEP_LABEL[s])}
                </button>
              </Tooltip>
            )
          })}
        </div>
      )}
      {left > 0 && (
        <div className="operation-conflicts">
          <div className="faint">{tr(T.conflicts, { count: left })}</div>
          {op.conflicts.map((c) => (
            <div key={c.path} className="operation-conflict" data-conflict={c.path}>
              <span className="label" title={c.path}>
                {c.path}
              </span>
              <span className="operation-picks">
                <button className="btn small" data-pick="open" onClick={() => void attempt(tr(T.failed), () => call('changes:openFile', root, c.path))}>
                  {tr(T.open)}
                </button>
                <Tooltip content={tr(T.mineTip, { swap, has: sideHas(c, 'mine'), command: pickCommand(op.what, c, 'mine') })}>
                  <button className="btn small" data-pick="mine" disabled={off} onClick={() => void pick(c, 'mine')}>
                    {tr(T.mine)}
                  </button>
                </Tooltip>
                <Tooltip content={operation ? tr(T.theirsTip, { swap, has: sideHas(c, 'theirs'), command: pickCommand(op.what, c, 'theirs') }) : tr(T.leftTheirsTip, { from: op.from ? 'stash' : 'other', stash: op.from?.stash ?? '', has: sideHas(c, 'theirs'), command: pickCommand(op.what, c, 'theirs') })}>
                  <button className="btn small" data-pick="theirs" disabled={off} onClick={() => void pick(c, 'theirs')}>
                    {tr(op.from ? T.theirsStash : T.theirs)}
                  </button>
                </Tooltip>
                <Tooltip content={tr(T.resolvedTip, { command: pickCommand(op.what, c, 'resolved') })}>
                  <button className="btn small" data-pick="resolved" disabled={off} onClick={() => void pick(c, 'resolved')}>
                    {tr(T.resolved)}
                  </button>
                </Tooltip>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
