import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentBranchStatus, MergeBranch, MergeBranchList, MergeResult } from '@shared/types'
import type { BranchQueueCard } from '@shared/workflow/queue'
import { msg, tr, tRich } from '@shared/i18n'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { projectMergeChoice } from '../mergeChoice'
import { confirm, notify, set, useLanguage, useStore } from '../store'
import { cx } from '../util'
import { MergeSlotNote, projectSlots, useMergeSlots } from './MergeSlots'
import { Icon, Modal } from './ui'

const CODE = (chunks: ReactNode[]): ReactNode => <code key={String(chunks)}>{chunks}</code>
const BOLD = (chunks: ReactNode[]): ReactNode => <strong key={String(chunks)}>{chunks}</strong>
/** The card a line is (tRich's <link>): opens it. */
const CARD_LINK =
  (c: { number: number; title: string }) =>
  (chunks: ReactNode[]): ReactNode => (
    <button key="card" type="button" className="link" data-open-card={c.number} title={c.title} onClick={() => set({ taskOpen: c.number })}>
      {chunks}
    </button>
  )

const M = {
  title: msg({ id: 'agents.branchMerge.title', defaultMessage: 'Merge a branch', description: 'Title of the Merge dialog for merges outside cards (#1450): it picks a branch and the branch to merge it into.' }),
  branch: msg({ id: 'agents.branchMerge.branch', defaultMessage: 'Branch', description: 'The Merge dialog for merges outside cards: the label of the branch to merge (a card\'s line in a slot, an old agent worktree\'s branch, any local branch).' }),
  into: msg({ id: 'agents.branchMerge.into', defaultMessage: 'Into', description: 'The Merge dialog for merges outside cards: the label of the branch to merge it into (the target).' }),
  inSlot: msg({ id: 'agents.branchMerge.inSlot', defaultMessage: '{branch} (in {slot})', description: 'A branch in the Merge dialog\'s list, checked out in one of Hive\'s slots ({slot}: its name, slot-a).' }),
  line: msg({ id: 'agents.branchMerge.group.line', defaultMessage: "Cards' lines", description: "A group in the Merge dialog's branch list: branches made for cards (their lines)." }),
  carried: msg({ id: 'agents.branchMerge.group.carried', defaultMessage: "Agents' old worktrees", description: "A group in the Merge dialog's branch list: branches of agents' 0.9 worktrees that Hive carried into its slots." }),
  other: msg({ id: 'agents.branchMerge.group.other', defaultMessage: 'Other branches', description: "A group in the Merge dialog's branch list: every other local branch." }),
  none: msg({ id: 'agents.branchMerge.none', defaultMessage: 'There is no other branch to merge.', description: 'The Merge dialog for merges outside cards when the repository has no branch but the one the project folder is on.' }),
  loading: msg({ id: 'agents.branchMerge.loading', defaultMessage: 'Reading the branches…', description: 'The Merge dialog for merges outside cards while it lists the branches.' }),
  cantList: msg({ id: 'agents.branchMerge.cantList', defaultMessage: "Couldn't list the branches: {error}", description: 'The Merge dialog for merges outside cards when listing the branches failed ({error}: why).' }),
  reading: msg({ id: 'agents.branchMerge.reading', defaultMessage: 'Reading {branch}…', description: 'The Merge dialog while it reads what the branch ({branch}) holds.' }),
  cardWork: msg({ id: 'agents.branchMerge.cardWork', defaultMessage: "This is <link>{card}</link>'s work: merge it through its card.", description: "A note in the Merge dialog: the branch picked is the line of a card ({card}: its key; <link> opens it) that isn't Done. Merging it here still works, after a confirmation. Keep the tags." }),
  cardWorkMore: msg({ id: 'agents.branchMerge.cardWorkMore', defaultMessage: 'Merging it here skips its rules, and the card is marked merged outside them.', description: "After the note that the branch is a card's work, in the Merge dialog: what merging it here instead means." }),
  confirmTitle: msg({ id: 'agents.branchMerge.confirmTitle', defaultMessage: "Merge {card}'s work outside its card?", description: "Title of the confirmation before merging an unfinished card's line ({card}: its key) from the Merge dialog." }),
  confirmMessage: msg({ id: 'agents.branchMerge.confirmMessage', defaultMessage: "{card} isn't Done. Merging {branch} into {into} here skips the card's rules (its review, its merge checks): Combwork marks the card merged outside the rules once it sees the merge.", description: "The confirmation before merging an unfinished card's line ({branch}) into {into} from the Merge dialog. Glossary: outside the rules." }),
  confirmButton: msg({ id: 'agents.branchMerge.confirmButton', defaultMessage: 'Merge Here', description: "The button of the confirmation before merging an unfinished card's line outside its card. Keep it short." }),
  nothing: msg({ id: 'agents.branchMerge.nothing', defaultMessage: 'There is nothing to merge: {branch} has no changes that aren\'t in {into}.', description: 'The Merge dialog when the branch picked ({branch}) has nothing new for the target ({into}).' }),
  commits: msg({ id: 'agents.branchMerge.commits', defaultMessage: 'Merges <b>{commits, plural, one {# commit} other {# commits}}</b> from <code>{branch}</code> into <code>{into}</code>.', description: 'The Merge dialog for merges outside cards: how many commits ({commits}) it merges from the branch ({branch}) into the target ({into}). Keep the tags.' }),
  uncommitted: msg({ id: 'agents.branchMerge.uncommitted', defaultMessage: "{files, plural, one {# file where {branch} is checked out isn't committed} other {# files where {branch} is checked out aren't committed}}: only committed work is merged.", description: 'A note in the Merge dialog: the folder that has the branch ({branch}) checked out has uncommitted files ({files}); they stay there.' }),
  merge: msg({ id: 'agents.branchMerge.merge', defaultMessage: 'Merge', description: "The Merge dialog's button (merges outside cards), and its choice of a git merge (not a squash). Keep it short." }),
  mergeNote: msg({ id: 'agents.branchMerge.mergeNote', defaultMessage: 'Keeps its commits and their messages, plus a merge commit.', description: 'Under the Merge choice (a git merge) in the Merge dialog for merges outside cards.' }),
  squash: msg({ id: 'agents.branchMerge.squash', defaultMessage: 'Squash', description: 'A choice in the Merge dialog: one commit with all the work (a git squash merge). Keep it short.' }),
  squashNote: msg({ id: 'agents.branchMerge.squashNote', defaultMessage: 'One commit with everything on it, with the message below.', description: 'Under the Squash choice in the Merge dialog for merges outside cards.' }),
  message: msg({ id: 'agents.branchMerge.message', defaultMessage: 'Commit message', description: "Label of the merge's commit message in the Merge dialog." }),
  cancel: msg({ id: 'agents.branchMerge.cancel', defaultMessage: 'Cancel', description: 'Button: closes the Merge dialog without merging.' }),
  close: msg({ id: 'agents.branchMerge.close', defaultMessage: 'Close', description: 'Button: closes the Merge dialog after a merge that would conflict.' }),
  anyway: msg({ id: 'agents.branchMerge.anyway', defaultMessage: 'Merge anyway…', description: "A button in the Merge dialog when Hive's merge queue merges the branch's card: merges it here all the same (asks first; recorded as an override)." }),
  anywayConfirm: msg({ id: 'agents.branchMerge.anywayConfirm', defaultMessage: 'Merge anyway', description: 'The button confirming Merge anyway (a merge outside the merge queue). Keep it short.' }),
  anywayTitle: msg({ id: 'agents.branchMerge.anywayTitle', defaultMessage: 'Merge {card} outside the merge queue?', description: "Title of the confirmation before Merge anyway: the card ({card}: its key) is one Hive's merge queue merges. Glossary 2.5: merge queue." }),
  anywayMessage: msg({ id: 'agents.branchMerge.anywayMessage', defaultMessage: 'Combwork merges this card through its queue, after its merge checks pass on the merged result. Merging it here skips them. It is recorded on the card as an override, and the queue takes its entry out once it sees the merge.', description: 'The confirmation before Merge anyway in the Merge dialog. Glossary 2.3: merge checks; 2.4: override.' }),
  conflict: msg({ id: 'agents.branchMerge.conflict', defaultMessage: 'Merging would conflict. Nothing was changed. These files were changed on both {branch} and {into}:', description: 'The Merge dialog after a merge that would conflict: Hive tried it and changed nothing; the files follow.' }),
  merged: msg({ id: 'agents.branchMerge.merged', defaultMessage: 'Merged {branch} into {into}', description: "A notification's title after a merge from the Merge dialog for merges outside cards." }),
  failed: msg({ id: 'agents.branchMerge.failed', defaultMessage: 'Could not merge', description: "An error's title: merging a branch from the Merge dialog failed." })
}

export const QUEUE_MERGES = msg({ id: 'agents.mergeDialog.queueMerges', defaultMessage: 'Combwork merges {card} through the merge queue. Merge anyway merges it here instead.', description: "Why Merge is disabled in the Merge dialog: the branch's card ({card}: its key) is merged by Hive's merge queue under its rules. Glossary 2.5: merge queue." })

/** The card on the branch when Hive merges it (#1357, OP-13): where it stands in the queue. */
export function QueueCardNote({ c }: { c: BranchQueueCard }) {
  const where =
    c.where === 'testing'
      ? tr(msg({ id: 'agents.mergeDialog.queueTesting', defaultMessage: 'The queue for {target} is testing it now.', description: "In the Merge dialog: the merge queue for the branch {target} is testing the card now (its merge checks)." }), { target: c.target })
      : c.where === 'queued'
        ? c.position
          ? tr(msg({ id: 'agents.mergeDialog.queueQueued', defaultMessage: 'It waits in the queue for {target}: {position, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} in line.', description: "In the Merge dialog: the card waits in the merge queue for the branch {target}, at place {position} (1st: next; the card testing counts)." }), { target: c.target, position: c.position })
          : tr(msg({ id: 'agents.mergeDialog.queueQueuedNoPlace', defaultMessage: 'It waits in the queue for {target}.', description: "In the Merge dialog: the card waits in the merge queue for the branch {target}." }), { target: c.target })
        : tr(msg({ id: 'agents.mergeDialog.queueNotYet', defaultMessage: 'It goes into the queue for {target} once it is approved.', description: "In the Merge dialog: the card isn't in the merge queue yet (in review, say); it is queued for the branch {target} once approved. Glossary 2.2: Approved." }), { target: c.target })
  return (
    <div className="banner info merge-queue-note" data-queue-card={c.card}>
      <Icon name="git-merge" />
      <span>
        <strong>{tr(QUEUE_MERGES, { card: c.key })}</strong> {where}
        {c.paused && <> {tr(msg({ id: 'agents.mergeDialog.queuePaused', defaultMessage: 'The queue is paused.', description: 'In the Merge dialog, after where the card stands in the merge queue: that queue is paused.' }))}</>}
      </span>
    </div>
  )
}

/**
 * The note that a branch is an unfinished card's work (#1450), with a link to the card: both Merge dialogs show it.
 */
export function LineCardNote({ card }: { card: NonNullable<MergeBranch['card']> }) {
  return (
    <div className="banner info branch-merge-card" data-line-card={card.number}>
      <Icon name="info" />
      <span>
        <strong>{tRich<ReactNode>(M.cardWork, { card: card.key, link: CARD_LINK(card) })}</strong> {tr(M.cardWorkMore)}
      </span>
    </div>
  )
}

/** The confirmation before merging an unfinished card's line (#1450): both Merge dialogs ask it. */
export function confirmLineMerge(card: NonNullable<MergeBranch['card']>, branch: string, into: string): Promise<boolean> {
  return confirm({ title: tr(M.confirmTitle, { card: card.key }), message: tr(M.confirmMessage, { card: card.key, branch, into }), confirmLabel: tr(M.confirmButton), danger: true })
}

/**
 * The Merge dialog for merges outside cards (#1450, OP-13): a branch (a card's line in a slot, an old worktree's
 * branch carried into the slots, any other local branch) and a target, not an agent's worktree; merged as an agent's
 * merge is (one at a time, holding the target's merge slot, #350). A line whose card isn't Done is that card's work: it
 * says so, with a link to the card, and merges only after a confirmation (main checks it again); the card is then
 * marked merged outside the rules (§16.4.4). A card Hive's merge queue merges takes Merge anyway, as an agent's does.
 */
export function BranchMergeDialog() {
  useLanguage()
  const open = useStore((s) => s.branchMergeFor)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.branchMergeFor?.project) ?? null)
  const [list, setList] = useState<MergeBranchList | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [branch, setBranch] = useState('')
  const [target, setTarget] = useState('')
  const [status, setStatus] = useState<AgentBranchStatus | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [cards, setCards] = useState<{ queue: BranchQueueCard | null; line: MergeBranch['card'] | null } | null>(null)
  const [squash, setSquash] = useState(false)
  // Whether the user has picked a merge style in this opening (a click on the one shown too, which changes nothing): the
  // project's, read after, never overrides it.
  const chosenStyle = useRef(false)
  const [styleRead, setStyleRead] = useState(false)
  const chooseSquash = (v: boolean): void => {
    chosenStyle.current = true
    setSquash(v)
  }
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MergeResult | null>(null)
  const slots = useMergeSlots()

  // The branches, when the dialog opens.
  useEffect(() => {
    setList(null)
    setListError(null)
    setResult(null)
    setBusy(false)
    if (!open) return
    let live = true
    // The project's own merge style (HI-1765), once read: a merge commit until then, and never over the user's choice.
    chosenStyle.current = false
    setSquash(false)
    setStyleRead(false)
    void projectMergeChoice(open.project).then((style) => {
      if (!live) return
      setStyleRead(true)
      if (!chosenStyle.current) setSquash(style === 'squash')
    })
    void call('worktrees:mergeBranches', open.project).then(
      (l) => {
        if (!live) return
        setList(l)
        const first = l.branches.find((b) => b.name === open.branch) ?? l.branches[0]
        setBranch(first?.name ?? '')
        setTarget(l.checkedOut ?? l.targets.find((t) => t !== first?.name) ?? '')
      },
      (e) => live && setListError(errorMessage(e))
    )
    return () => {
      live = false
    }
    // Read again when it opens for another project or branch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.project, open?.branch])

  // What the branch holds that the target doesn't, and its cards; only the latest read counts.
  useEffect(() => {
    setStatus(null)
    setReadError(null)
    setCards(null)
    setResult(null)
    if (!open || !branch || !target || branch === target) return
    setMessage(`Merge ${branch}`) // i18n-ignore: a commit message, kept in git's history (English, as agents read it)
    let live = true
    void call('worktrees:branchMergeStatus', open.project, branch, target).then(
      (s) => live && setStatus(s),
      (e) => live && setReadError(errorMessage(e))
    )
    void call('worktrees:branchCards', open.project, branch).then(
      (c) => live && setCards(c),
      (e) => live && setReadError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [open, branch, target])

  if (!open || !project) return null
  const close = (): void => set({ branchMergeFor: null })
  const picked = list?.branches.find((b) => b.name === branch) ?? null
  const nothing = !!status && status.ahead === 0
  const slot = target ? (projectSlots(slots, project.path).find((s) => s.branch === target) ?? null) : null
  const slotTaken = !!slot && (!!slot.holder || slot.waiting.length > 0)
  const queueCard = cards?.queue ?? null
  const lineCard = cards?.line ?? null
  const ready = !!status && !!cards && !nothing && !busy && !slotTaken

  const merge = async (anyway = false): Promise<void> => {
    if (anyway && queueCard) {
      const ok = await confirm({ title: tr(M.anywayTitle, { card: queueCard.key }), message: tr(M.anywayMessage), confirmLabel: tr(M.anywayConfirm), danger: true })
      if (!ok) return
    } else if (lineCard && !(await confirmLineMerge(lineCard, branch, target))) return
    setBusy(true)
    try {
      const r = await call('worktrees:mergeBranch', project.path, branch, { target, squash, message, ...(lineCard && !queueCard ? { card: lineCard.number } : {}), ...(anyway && queueCard ? { outsideQueue: { card: queueCard.card, reason: '' } } : {}) })
      setResult(r)
      if (r.ok) {
        notify('success', tr(M.merged, { branch, into: target }))
        await actions.refreshWorkspace()
        close()
      }
    } catch (e) {
      notify('error', tr(M.failed), errorMessage(e))
    }
    setBusy(false)
  }

  const groups: { label: string; kind: MergeBranch['kind'] }[] = [
    { label: tr(M.line), kind: 'line' },
    { label: tr(M.carried), kind: 'carried' },
    { label: tr(M.other), kind: 'branch' }
  ]
  return (
    <Modal
      title={tr(M.title)}
      icon="git-merge"
      onClose={close}
      wide
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {tr(result?.conflicts ? M.close : M.cancel)}
          </button>
          {!result?.conflicts && queueCard && (
            <button className="btn subtle" data-action="merge-anyway" disabled={!ready} onClick={() => void merge(true)}>
              {tr(M.anyway)}
            </button>
          )}
          {!result?.conflicts && (
            <button className={cx('btn', queueCard ? 'merge-held' : 'primary')} data-action="merge" disabled={!ready || !!queueCard} onClick={() => void merge()}>
              <Icon name={busy ? 'loading' : 'git-merge'} spin={busy} /> {tr(M.merge)}
            </button>
          )}
        </>
      }
    >
      <div className="branch-merge" data-branch-merge="">
        {listError ? (
          <div className="banner warn">
            <Icon name="warning" /> {tr(M.cantList, { error: listError })}
          </div>
        ) : !list ? (
          <p className="muted">
            <Icon name="loading" spin /> {tr(M.loading)}
          </p>
        ) : !list.branches.length ? (
          <p className="muted">{tr(M.none)}</p>
        ) : (
          <>
            <div className="branch-merge-pick">
              <label className="compact-focus">
                <span>{tr(M.branch)}</span>
                <select className="select" data-pick="branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
                  {groups.map((g) => {
                    const of = list.branches.filter((b) => b.kind === g.kind)
                    return of.length ? (
                      <optgroup key={g.kind} label={g.label}>
                        {of.map((b) => (
                          <option key={b.name} value={b.name}>
                            {b.slot ? tr(M.inSlot, { branch: b.name, slot: b.slot }) : b.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null
                  })}
                </select>
              </label>
              <label className="compact-focus">
                <span>{tr(M.into)}</span>
                <select className="select" data-pick="target" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {list.targets
                    .filter((t) => t !== branch)
                    .map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {queueCard && <QueueCardNote c={queueCard} />}
            {lineCard && !queueCard && <LineCardNote card={lineCard} />}
            {readError ? (
              <div className="banner warn">
                <Icon name="warning" /> {readError}
              </div>
            ) : !status ? (
              <p className="muted">
                <Icon name="loading" spin /> {tr(M.reading, { branch })}
              </p>
            ) : result?.conflicts ? (
              <>
                <div className="banner warn">
                  <Icon name="warning" /> {tr(M.conflict, { branch, into: target })}
                </div>
                <ul className="conflict-list">
                  {result.conflicts.map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <p style={{ marginTop: 0 }}>{nothing ? tr(M.nothing, { branch, into: target }) : tRich<ReactNode>(M.commits, { commits: status.ahead, branch, into: target, b: BOLD, code: CODE })}</p>
                {status.dirty > 0 && picked?.folder && (
                  <div className="banner warn" data-testid="merge-uncommitted">
                    <Icon name="warning" /> {tr(M.uncommitted, { files: status.dirty, branch })}
                  </div>
                )}
                <MergeSlotNote slot={slot} />
                <div className="choice-list" data-merge-style={styleRead ? 'read' : 'reading'}>
                  <label className={cx('choice', !squash && 'selected')}>
                    <input type="radio" checked={!squash} onClick={() => chooseSquash(false)} onChange={() => chooseSquash(false)} />
                    <div>
                      <strong>{tr(M.merge)}</strong>
                      <div className="faint">{tr(M.mergeNote)}</div>
                    </div>
                  </label>
                  <label className={cx('choice', squash && 'selected')}>
                    <input type="radio" checked={squash} onClick={() => chooseSquash(true)} onChange={() => chooseSquash(true)} />
                    <div>
                      <strong>{tr(M.squash)}</strong>
                      <div className="faint">{tr(M.squashNote)}</div>
                    </div>
                  </label>
                </div>
                <label className="compact-focus" style={{ marginTop: 10 }}>
                  <span>{tr(M.message)}</span>
                  <textarea className="input" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
                </label>
                {result?.error && <div className="field-error">{result.error}</div>}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
