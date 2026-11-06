import { msg, type Msg } from './i18n/msg'
import { shortRevision } from './progress'
import type { Tr } from './tasks'
import type { ProgressRun } from './types'
import { RECENT_MAX, RETURN_SEEN_SHOWN_MS, type QueuePauseInfo, type QueuePauseLogged, type QueuePushState, type QueueRecent, type QueueView } from './workflow/queue'

export { RETURN_SEEN_SHOWN_MS }

/**
 * The merge queue in the Progress panel (#1356, SPEC §16.13's P5 line): which queues show, what each one's card says
 * (testing now with its step and an estimate, queued, just merged, returned until seen, paused), Pulse's line for it,
 * the Merges tab's badge and what is announced. One model of a target's queue (#1353's `queue:list`); the card's Git tab
 * section (#1357) reuses it.
 */

/** A merge shows on its queue's card this long (it stays in the card's facts). */
export const JUST_MERGED_MS = 8_000
/** The estimate is the median of this many of the target's last merge checks. */
export const ESTIMATE_OF = 5

const at = (iso: string): number => Date.parse(iso)

/**
 * The returns a queue's card shows: each card's newest outcome when it is a return and the card isn't queued or testing
 * again, until the user has seen it and a few seconds after.
 */
export function shownReturns(v: QueueView, now: number): QueueRecent[] {
  const again = new Set([...(v.testing ? [v.testing.card] : []), ...v.queued.map((q) => q.card)])
  const newest = new Set<number>()
  const out: QueueRecent[] = []
  // Main's list (the returns policy): each its card's newest outcome; a card queued or testing again since is left out.
  for (const r of v.returns) {
    if (newest.has(r.card) || again.has(r.card)) continue
    newest.add(r.card)
    if (!r.seen || now - at(r.seen) < RETURN_SEEN_SHOWN_MS) out.push(r)
  }
  return out
}

/**
 * The returns not seen yet that the card shows: what the panel marks seen once it shows them (open, in a focused window).
 * Those beyond the model's list (`returnsMore`) aren't among them: they come as the ones seen fold (`nextFold`).
 */
export const unseenReturns = (v: QueueView, now: number): QueueRecent[] => shownReturns(v, now).filter((r) => !r.seen)

/** A return this window showed and marked seen, kept here until its own 10 s are up (the queue it belongs to by key). */
export interface KeptReturn {
  /** `queueKey` of its queue. */
  queue: string
  row: QueueRecent
}

/** A queue's key for the rows a window keeps: its project folder (any case) and target. */
export const queueKey = (v: Pick<QueueView, 'projectPath' | 'target'>): string => `${v.projectPath.toLowerCase()}\n${v.target}`

/**
 * The rows this window showed and marked seen, added to main's list while their own 10 s last (#1356 round 6, the
 * Assistant's call: two windows marking different snapshots can leave main's bounded list without a row one of them
 * showed; that window still keeps it for its interval). A row main lists already is main's, except that a seen one shows
 * until the later of main's 10 s and this window's (#1427: another window saw it earlier); one main hasn't seen yet stays
 * unseen. `shownReturns` drops a kept row once its 10 s are up, or its card is queued or testing again.
 */
export function withKept(views: readonly QueueView[], kept: readonly KeptReturn[]): QueueView[] {
  if (!kept.length) return [...views]
  return views.map((v) => {
    const k = queueKey(v)
    const ours = new Map(kept.filter((x) => x.queue === k).map((x) => [x.row.entry, x.row.seen]))
    if (!ours.size) return v
    const returns = v.returns.map((r) => {
      const local = ours.get(r.entry)
      return r.seen && local && at(local) > at(r.seen) ? { ...r, seen: local } : r
    })
    const listed = new Set(v.returns.map((r) => r.entry))
    const mine = kept.filter((x) => x.queue === k && !listed.has(x.row.entry)).map((x) => x.row)
    return { ...v, returns: [...returns, ...mine] }
  })
}

/** The kept rows still within their 10 s (`now`): what a window holds on to. */
export const keptLive = (kept: readonly KeptReturn[], now: number): KeptReturn[] => kept.filter((x) => !!x.row.seen && now - at(x.row.seen) < RETURN_SEEN_SHOWN_MS)

/**
 * When the window should read a queue again to bring the returns beyond its list (`returnsMore`): just after the first
 * of those shown and seen folds, freeing its slot. Null when nothing waits beyond the list, or nothing shown is seen.
 */
export function nextFold(v: QueueView): number | null {
  if (!v.returnsMore) return null
  const times = v.returns.filter((r) => r.seen).map((r) => at(r.seen!) + RETURN_SEEN_SHOWN_MS)
  return times.length ? Math.min(...times) : null
}

/**
 * When what a queue shows next changes by time alone (#1416): the first future moment a seen return folds or a merge
 * stops being just merged. Null when nothing shown waits on the clock. The window renders again then, without another
 * queue event, so an old queue's section goes once its last outcome is seen.
 */
export function nextChange(views: readonly QueueView[], now: number): number | null {
  const times = views.flatMap((v) => [
    ...shownReturns(v, now).filter((r) => r.seen).map((r) => at(r.seen!) + RETURN_SEEN_SHOWN_MS),
    ...justMerged(v, now).map((r) => at(r.at) + JUST_MERGED_MS)
  ])
  const later = times.filter((t) => t > now)
  return later.length ? Math.min(...later) : null
}

/** The merges of the last few seconds, newest first. */
export const justMerged = (v: QueueView, now: number): QueueRecent[] => v.recent.filter((r) => r.outcome === 'merged' && now - at(r.at) < JUST_MERGED_MS)

/**
 * Whether a target's queue shows (#1356 item 0, round 2 of #1338): from its actual state, never the project's current
 * options alone. It shows while it has an entry testing or queued, a pause, a return not seen yet (or seen just now), a
 * merge of the last few seconds, a Combwork running it (a lease), or a card in flight whose own ruleset has Combwork merge into
 * it; and, empty, while the current options have Combwork merge into it. So after a switch to "The agent merges" (or Git →
 * None with an old Git ruleset's cards in flight) the old queue stays, controllable, until its last outcome is seen.
 */
export function queueShown(v: QueueView, now: number): boolean {
  return !!v.testing || v.queued.length > 0 || !!v.paused || !!v.runBy || v.inFlight.length > 0 || v.combworkMerges || shownReturns(v, now).length > 0 || justMerged(v, now).length > 0
}

/** The queues that show, by project (its name) then target. */
export function shownQueues(views: readonly QueueView[], now: number): QueueView[] {
  return views.filter((v) => queueShown(v, now)).sort((a, b) => a.project.localeCompare(b.project) || a.target.localeCompare(b.target))
}

/** A merge this recent keeps an inactive project's queue under All projects (HI-2165). */
export const BUSY_MERGE_MS = 60 * 60_000

/**
 * Whether a queue is doing something now (HI-2165): an entry testing or queued, a pause, a return not seen yet (or seen
 * just now), or a merge in the last hour. An idle queue that only shows because Combwork merges into it (or runs it) isn't.
 */
export function queueBusy(v: QueueView, now: number): boolean {
  return !!v.testing || v.queued.length > 0 || !!v.paused || shownReturns(v, now).length > 0 || v.recent.some((r) => r.outcome === 'merged' && now - at(r.at) < BUSY_MERGE_MS)
}

/**
 * The queues All projects shows (HI-2165): those of the projects being worked on (`active`: their folders, lower case),
 * and any other project's while it is busy. Choosing a project in the filter still shows all of its own.
 */
export const allProjectsQueues = (views: readonly QueueView[], active: ReadonlySet<string>, now: number): QueueView[] => views.filter((v) => active.has(v.projectPath.toLowerCase()) || queueBusy(v, now))

/** A queue's line on Pulse (#1356 item 4): only while it tests or is paused. */
export const onPulseLine = (v: QueueView): boolean => !!v.testing || !!v.paused

/** The Merges tab's badge (#1356 item 3): entries queued, plus agents waiting for a merge slot (counted by the caller). */
export const queuedCount = (views: readonly QueueView[]): number => views.reduce((n, v) => n + v.queued.length, 0)

/**
 * The estimate for the entry testing now (#1356 item 1): the median time of this target's last merge checks, from Combwork's
 * runs (#1349). A merge's checks are Combwork's runs in the project on its result revision (the test merge's, which the
 * checks ran on); only merges whose runs all passed count, the newest ESTIMATE_OF of them. Null when there are none.
 */
export function queueEstimate(v: QueueView, runs: readonly ProgressRun[]): number | null {
  const results = new Map<string, number>()
  for (const r of v.recent) if (r.outcome === 'merged' && r.by === 'combwork' && r.result) results.set(r.result, at(r.at))
  if (!results.size) return null
  const project = v.projectPath.toLowerCase()
  const groups = new Map<string, ProgressRun[]>()
  for (const r of runs) {
    if (r.source !== 'combwork' || !r.revision || !results.has(r.revision) || r.projectPath?.toLowerCase() !== project) continue
    groups.set(r.revision, [...(groups.get(r.revision) ?? []), r])
  }
  const spans = [...groups.entries()]
    .filter(([, rs]) => rs.every((r) => r.state === 'passed' && r.finishedAt !== null))
    .sort((a, b) => results.get(b[0])! - results.get(a[0])!)
    .slice(0, ESTIMATE_OF)
    .map(([, rs]) => Math.max(...rs.map((r) => r.finishedAt!)) - Math.min(...rs.map((r) => r.startedAt)))
    .sort((a, b) => a - b)
  if (!spans.length) return null
  const mid = Math.floor(spans.length / 2)
  return spans.length % 2 ? spans[mid] : Math.round((spans[mid - 1] + spans[mid]) / 2)
}

/**
 * The Combwork run of a returned entry's failed check (its log is Show log's, #1349): the card's Combwork run in the project
 * whose log the outcome recorded, never another attempt's found by time (HI-1924, HR1's round 1). Null for a return no
 * check made (a conflict, a hook), an outcome that kept no log, or a run not kept.
 */
export function returnRun(v: QueueView, r: QueueRecent, runs: readonly ProgressRun[]): ProgressRun | null {
  if (r.reason !== 'checks' || !r.logPath) return null
  const project = v.projectPath.toLowerCase()
  const log = r.logPath.toLowerCase()
  return runs.find((x) => x.source === 'combwork' && x.card === r.card && x.projectPath?.toLowerCase() === project && x.logPath?.toLowerCase() === log) ?? null
}

/** The check a return names: the one its outcome recorded, else its run's (null: none known). */
export const returnCheck = (r: QueueRecent, run: ProgressRun | null): string | null => r.check ?? (run ? runCheckName(run) : null)

/** A Combwork run's check as its title names it ("HI-12 · unit · a3f2c1d": unit), or its counted check's name. */
export function runCheckName(r: ProgressRun): string {
  if (r.counts?.name) return r.counts.name
  const parts = r.title.split(' · ')
  return parts.length === 3 ? parts[1] : r.title
}

/** The step of the entry testing now, in a few words: the test merge, the check running (its name), the advance. */
export function stepText(v: QueueView, run: ProgressRun | null, tr: Tr): string {
  const t = v.testing!
  const step = t.step === 'checks' && run ? 'check' : (t.step ?? 'unknown')
  return tr(
    msg({
      id: 'board.queue.step',
      defaultMessage: '{step, select, testMerge {test merge} checks {merge checks} check {check: {check}} advance {merging into {target}} other {testing}}',
      description: "The step a merge queue's card is at now, in the Progress panel: the test merge, its merge checks (or the one running, {check}: its name, such as unit), merging into the target ({target}: a branch, such as main), or testing (step not known here). Lower case: it follows an arrow. Glossary 2.5: test merge; 2.3: merge checks. Keep the select keys."
    }),
    { step, check: run ? runCheckName(run) : '', target: v.target } // i18n-ignore: select keys, never shown
  )
}

/** What the entry testing now is: "HI-61 + main @ 1cd2592 → test merge". */
export function testingText(v: QueueView, run: ProgressRun | null, tr: Tr): string {
  const t = v.testing!
  const step = stepText(v, run, tr)
  if (!t.expected) return tr(msg({ id: 'board.queue.testingNoHead', defaultMessage: '{card} + {target} → {step}', description: "What a merge queue is testing now, on its card in the Progress panel: the card ({card}: its key, such as HI-61) merged with the target ({target}: a branch, such as main), and its step ({step}: test merge, check: unit…)." }), { card: t.key, target: v.target, step })
  return tr(msg({ id: 'board.queue.testing', defaultMessage: '{card} + {target} @ {head} → {step}', description: "What a merge queue is testing now, on its card in the Progress panel: the card ({card}: its key, such as HI-61) merged with the target ({target}: a branch, such as main) at its head ({head}: a short commit id), and its step ({step}: test merge, check: unit…)." }), { card: t.key, target: v.target, head: shortRevision(t.expected), step })
}

/** The cards waiting, in order: "HI-107, HI-108 waiting". */
export function queuedText(v: QueueView, tr: Tr, list: (items: string[]) => string): string {
  return tr(msg({ id: 'board.queue.queued', defaultMessage: '{n, plural, one {{cards} waiting} other {{cards} waiting}}', description: "The cards waiting in a merge queue, in order, on its card in the Progress panel: {cards} is their keys as a list (HI-107, HI-108), {n} how many." }), { cards: list(v.queued.map((q) => q.key)), n: v.queued.length })
}

/** A merge: "HI-61 merged as 9e1f0aa". */
export function mergedText(r: QueueRecent, tr: Tr): string {
  return tr(msg({ id: 'board.queue.merged', defaultMessage: '{card} merged as {result}', description: "A merge queue's card in the Progress panel, for a few seconds after a card merged: its key ({card}, such as HI-61) and the target's new commit ({result}: a short commit id)." }), { card: r.key, result: shortRevision(r.result ?? '') })
}

/** Why a card was returned, in a few words: "conflict in tasks.ts", "checks failed: unit". */
export function returnWhy(r: QueueRecent, check: string | null, target: string, tr: Tr, list: (items: string[]) => string): string {
  const files = r.files?.slice(0, 3) ?? []
  const more = (r.files?.length ?? 0) - files.length
  const reason = r.reason === 'conflict' || r.reason === 'checks' || r.reason === 'hook' || r.reason === 'folderBusy' || r.reason === 'notUpToDate' || r.reason === 'focused' ? r.reason : 'other'
  const why = tr(
    msg({
      id: 'board.queue.returnWhy',
      defaultMessage: '{reason, select, conflict {{files, select, none {conflict} other {conflict in {files}}}} checks {{check, select, none {checks failed} other {checks failed: {check}}}} hook {a hook failed} folderBusy {the folder {target} is checked out in was busy} notUpToDate {not up to date with {target}} focused {its focused tests couldn’t be chosen or proved} other {{why}}}',
      description: "Why the merge queue returned a card to its builder, in a few words after a colon: a conflict (in {files}: file names), its merge checks failed ({check}: the check, such as unit), a git hook failed, the folder the target ({target}: a branch) is checked out in was busy, or it wasn't up to date with the target, or its focused tests (G20: the tests its change needs) couldn't be chosen or proved by its review; else {why} as Combwork recorded it. Lower case. Keep the select keys and the word none."
    }),
    { reason, files: files.length ? (more > 0 ? list([...files, tr(msg({ id: 'board.queue.filesMore', defaultMessage: '{n, plural, one {# more} other {# more}}', description: 'The last item of a list of the files a merge conflict named, when there are more than shown: how many more ({n}). The list joins it to the first few as your language joins a list (HI-1585: no "and" written around a list).' }), { n: more })]) : list(files)) : 'none', check: check ?? 'none', target, why: r.reason ?? '' } // i18n-ignore: select keys, never shown
  )
  return r.transient ? tr(msg({ id: 'board.queue.transient', defaultMessage: '{why} (temporary)', description: "A merge queue return that was the environment's failure, not the work's (a check that couldn't start, a network error): its reason ({why}) and that it was temporary." }), { why }) : why
}

/** A return: "HI-108 returned to HB1: conflict in tasks.ts" (`builder` null: to no one Combwork knows). */
export function returnedText(r: QueueRecent, why: string, builder: string | null, tr: Tr): string {
  if (!builder) return tr(msg({ id: 'board.queue.returned', defaultMessage: '{card} returned: {why}', description: "A merge queue's card in the Progress panel: a card ({card}: its key) the queue returned (glossary 2.4: returned), and why ({why}: conflict in tasks.ts, checks failed: unit…)." }), { card: r.key, why })
  return tr(msg({ id: 'board.queue.returnedTo', defaultMessage: '{card} returned to builder {builder}: {why}', description: "A merge queue's card in the Progress panel: a card ({card}: its key) the queue returned to its builder ({builder}: an agent's name; glossary 2.4: returned), and why ({why}: conflict in tasks.ts, checks failed: unit…). A noun before the name (glossary §1 rule 4)." }), { card: r.key, builder, why })
}

const PAUSES: Record<string, Msg> = {
  pushRejected: msg({ id: 'board.queue.pause.pushRejected', defaultMessage: '{card} is merged, but its remote refused the push of {target}: it has commits {target} hasn’t (Combwork never forces a push). Pull them into {target}, then resume; or turn off “Push the target branch after merging” and resume to keep merging locally.', description: "Why a merge queue is paused, on its card in the Progress panel (G18): after merging a card ({card}: its key), pushing the target ({target}: a branch) was refused because the remote has newer commits. “Push the target branch after merging” is a workflow option's name: use its words." }),
  pushFailed: msg({ id: 'board.queue.pause.pushFailed', defaultMessage: '{card} is merged, but pushing {target} failed (git’s message follows). Fix it, then resume; or turn off “Push the target branch after merging” and resume to keep merging locally.', description: "Why a merge queue is paused, on its card in the Progress panel (G18): after merging a card ({card}: its key), pushing the target ({target}: a branch) failed, for a sign-in, the network or a time limit; git's own message follows. “Push the target branch after merging” is a workflow option's name: use its words." }),
  pushUnreadable: msg({ id: 'board.queue.pause.pushUnreadable', defaultMessage: '{card} is merged, and {target} still has to be pushed, but Combwork couldn’t read {target} to do it. Resume to try again; or turn off “Push the target branch after merging” and resume to keep merging locally.', description: "Why a merge queue is paused, on its card in the Progress panel (G18): after merging a card ({card}: its key), Combwork couldn't read the target ({target}: a branch) to push it (git didn't answer), so the push still waits. “Push the target branch after merging” is a workflow option's name: use its words." }),
  pushNoRemote: msg({ id: 'board.queue.pause.pushNoRemote', defaultMessage: '{card} is merged, but {target} has no remote to push to: it tracks none, and the repository has no origin or only remote. Add one or set what {target} tracks, then resume; or turn off “Push the target branch after merging” and resume.', description: "Why a merge queue is paused, on its card in the Progress panel (G18): after merging a card ({card}: its key), the target ({target}: a branch) had nowhere to be pushed. Origin is git's usual name for a remote: keep it. “Push the target branch after merging” is a workflow option's name: use its words." }),
  targetMovesFast: msg({ id: 'board.queue.pause.targetMovesFast', defaultMessage: '{target} kept moving during each test merge. Resume once it settles.', description: "Why a merge queue is paused, on its card in the Progress panel: the target ({target}: a branch) moved during every test merge. Glossary 2.5: test merge." }),
  folderBusy: msg({ id: 'board.queue.pause.folderBusy', defaultMessage: 'The folder {target} is checked out in was busy (an operation such as a merge or rebase was going on there).', description: "Why a merge queue is paused, on its card in the Progress panel: the folder where the target ({target}: a branch) is checked out was in the middle of a git operation." }),
  wrongBranch: msg({ id: 'board.queue.pause.wrongBranch', defaultMessage: 'The folder {target} was checked out in is on another branch now.', description: "Why a merge queue is paused, on its card in the Progress panel: the folder that had the target ({target}: a branch) checked out switched branch." }),
  staged: msg({ id: 'board.queue.pause.staged', defaultMessage: 'Changes are staged in the folder {target} is checked out in. Commit or unstage them, then resume.', description: "Why a merge queue is paused, on its card in the Progress panel: the folder where the target ({target}: a branch) is checked out has staged changes." }),
  unstagedChanges: msg({ id: 'board.queue.pause.unstagedChanges', defaultMessage: '{files, select, none {Files the merge changes} other {{files}}} have changes in the folder {target} is checked out in. Commit or undo them, then resume.', description: "Why a merge queue is paused, on its card in the Progress panel: files the merge would change ({files}: a list of names) have changes in the folder where the target ({target}: a branch) is checked out. Keep the select keys and the word none." }),
  identity: msg({ id: 'board.queue.pause.identity', defaultMessage: "The repository has no commit identity, so Combwork can't make its merge commit. Set one in Version Control → Branches & remotes, then resume.", description: "Why a merge queue is paused, on its card in the Progress panel: git has no user name and email for the repository. Version Control → Branches & remotes is a place in Combwork." }),
  needsYou: msg({ id: 'board.queue.pause.needsYou', defaultMessage: 'Needs you: Combwork stopped part way and changes nothing more on its own. Open the card for its state and the commands that finish or undo it.', description: "Why a merge queue is paused, on its card in the Progress panel: something Combwork couldn't settle by itself (a merge stopped part way, or what an earlier run left). Open the card: a button beside it." }),
  uncounted: msg({ id: 'board.queue.pause.uncounted', defaultMessage: "The merge checks passed but didn't count for the merge, several times in a row. The card's Work section says why.", description: "Why a merge queue is paused, on its card in the Progress panel: its checks passed but didn't count (the folder changed during them, say). Glossary 2.3: merge checks; 2.4: work." }),
  checkedOut: msg({ id: 'board.queue.pause.checkedOut', defaultMessage: '{target} is checked out in a folder. Combwork merges into it there now: resume to carry on.', description: "Why a merge queue is paused, on its card in the Progress panel: an older pause, from before Combwork could merge into a checked-out branch ({target})." }),
  rulesOff: msg({ id: 'board.queue.pause.rulesOff', defaultMessage: "The workflow's rules are off (Settings → Advanced), so the queue doesn't merge.", description: "Why a merge queue is paused, on its card in the Progress panel: the workflow rules are turned off in Settings → Advanced." }),
  signingWaits: msg({ id: 'board.queue.pause.signingWaits', defaultMessage: 'Signing the merge commit waits for you (a passphrase or a PIN). Unlock your signing key, then resume.', description: "Why a merge queue is paused, on its card in the Progress panel: git's commit signing asked for a passphrase or PIN, which Combwork can't type." }),
  signing: msg({ id: 'board.queue.pause.signing', defaultMessage: 'Signing the merge commit failed.', description: "Why a merge queue is paused, on its card in the Progress panel: git's commit signing failed (its message follows)." }),
  hookTimedOut: msg({ id: 'board.queue.pause.hookTimedOut', defaultMessage: "A hook of the merge commit was still running when signing's time ran out.", description: "Why a merge queue is paused, on its card in the Progress panel: a git hook kept running past the time limit." }),
  subfolderTarget: msg({ id: 'board.queue.pause.subfolderTarget', defaultMessage: 'This project is inside a larger repository, so the queue merges only into a branch the card’s options name. Name it in Version Control → Workflow, apply it to {card} when you save, then resume; or remove {card} from the queue.', description: "Why a merge queue is paused, on its card in the Progress panel (OP-29): the project is a subfolder of a bigger Git repository and the card's options name no target branch. {card} is the card's key. Version Control → Workflow is a place in Combwork (glossary 2.1); saving the options there can apply them to cards already started." }),
  mergeChoice: msg({ id: 'board.queue.pause.mergeChoice', defaultMessage: '{card} is the first card to merge since the upgrade to Combwork 1.0: choose how Combwork merges this project (merge style and commit message) in For you, or in Version Control → Workflow.', description: "Why a merge queue is paused, on its card in the Progress panel (HI-1697): a project from before 1.0 reached the merge queue for the first time ({card}: its key), and nobody chose its merge style and commit message (workflow options' names, glossary 2.6), so it waits for the user. For you is the list of what waits on the user (glossary 2.3); Version Control → Workflow is a place in Combwork." }),
  approval: msg({ id: 'board.queue.pause.approval', defaultMessage: '{card} is ready to merge into {target}, which is checked out: it waits for your OK in For you.', description: "Why a merge queue is paused, on its card in the Progress panel: a card ({card}: its key) waits for the user's approval to update the checked-out target ({target}: a branch). For you is the list of what waits on the user (glossary 2.3)." })
}

/** Why a queue is paused, in a sentence (#1356 item 1): each pause reason a message, the user's and the Assistant's too. */
export function pauseText(p: QueuePauseInfo, target: string, tr: Tr, list: (items: string[]) => string): string {
  if (p.reason === 'user') return p.by === 'assistant' ? tr(msg({ id: 'board.queue.pause.byAssistant', defaultMessage: 'Paused by the Assistant. The queue merges nothing until it is resumed.', description: "Why a merge queue is paused, on its card in the Progress panel: the Combwork Assistant paused it (Pause queue)." })) : tr(msg({ id: 'board.queue.pause.byYou', defaultMessage: 'Paused by you. The queue merges nothing until you resume it.', description: "Why a merge queue is paused, on its card in the Progress panel: the user paused it (Pause queue)." }))
  const m = PAUSES[p.reason]
  if (!m) return tr(msg({ id: 'board.queue.pause.other', defaultMessage: 'Paused ({reason}).', description: "Why a merge queue is paused, on its card in the Progress panel, for a reason this window has no words for ({reason}: Combwork's code for it)." }), { reason: p.reason })
  const text = tr(m, { target, card: p.card ?? '', files: p.files.length ? list(p.files.slice(0, 5)) : 'none' }) // i18n-ignore: a select key, never shown
  return p.message ? `${text}\n${p.message}` : text // i18n-ignore: git's own message on the line after
}

/** Pulse's line for a queue (#1356 item 4): "main: testing HI-61 · 2 queued", "main: paused · 2 queued". */
export function pulseLine(v: QueueView, project: string | null, tr: Tr): string {
  const state = v.paused ? 'paused' : 'testing'
  const line = tr(
    msg({
      id: 'board.queue.pulse',
      defaultMessage: '{target}: {state, select, paused {paused} other {testing {card}}}{n, plural, =0 {} other { · {n, number} queued}}',
      description: "A merge queue's line on the Progress panel's Pulse tab (a click shows the Merges tab): its target ({target}: a branch), paused or the card it tests ({card}: its key), and how many cards wait ({n}). Keep the select keys."
    }),
    { target: v.target, state, card: v.testing?.key ?? '', n: v.queued.length } // i18n-ignore: select keys, never shown
  )
  return project ? `${project} · ${line}` : line // i18n-ignore: a project's name before its line
}

/**
 * What changed between two models of the same queue that is worth announcing (#1356 item 8, a polite live region): a
 * card merged, a card returned, the queue paused or resumed. Each once: an outcome by its entry and kind, a pause by
 * its time.
 */
export function queueNews(before: QueueView | undefined, after: QueueView, now: number, tr: Tr, why: (r: QueueRecent) => string): { key: string; text: string }[] {
  if (!before) return []
  const out: { key: string; text: string }[] = []
  const had = new Set(before.recent.map((r) => `${r.entry}\n${r.outcome}`))
  for (const r of [...after.recent].reverse()) {
    if (had.has(`${r.entry}\n${r.outcome}`) || now - at(r.at) > 60_000) continue
    if (r.outcome === 'merged') out.push({ key: `${r.entry}:merged`, text: tr(msg({ id: 'board.queue.saidMerged', defaultMessage: '{card} merged', description: "Announced to screen readers (politely) when the merge queue merged a card ({card}: its key, such as HI-61)." }), { card: r.key }) })
    if (r.outcome === 'returned') out.push({ key: `${r.entry}:returned`, text: tr(msg({ id: 'board.queue.saidReturned', defaultMessage: '{card} returned: {why}', description: "Announced to screen readers (politely) when the merge queue returned a card ({card}: its key) to its builder, and why ({why}: conflict, checks failed: unit…). Glossary 2.4: returned." }), { card: r.key, why: why(r) }) })
  }
  if (after.paused && (!before.paused || before.paused.at !== after.paused.at)) out.push({ key: `${after.projectPath}\n${after.target}:paused:${after.paused.at ?? ''}`, text: tr(msg({ id: 'board.queue.saidPaused', defaultMessage: 'Merge queue for {target} paused', description: "Announced to screen readers (politely) when a merge queue paused ({target}: its branch). Glossary 2.5: merge queue." }), { target: after.target }) })
  if (before.paused && !after.paused) out.push({ key: `${after.projectPath}\n${after.target}:resumed:${before.paused.at ?? ''}`, text: tr(msg({ id: 'board.queue.saidResumed', defaultMessage: 'Merge queue for {target} resumed', description: "Announced to screen readers (politely) when a merge queue resumed ({target}: its branch). Glossary 2.5: merge queue." }), { target: after.target }) })
  return out
}

/**
 * A row of a queue's Recent merges (HI-1924, the Merges tab): an outcome (merged, returned, taken out) or a pause, by its
 * time, newest first.
 */
export type HistoryRow = { kind: 'outcome'; at: string; key: string; r: QueueRecent } | { kind: 'pause'; at: string; key: string; p: QueuePauseLogged }

/** How many rows a queue's Recent merges shows: the outcomes its model keeps. */
export const HISTORY_SHOWN = RECENT_MAX

/**
 * A queue's Recent merges (HI-1924): its latest outcomes and pauses, newest first, at most HISTORY_SHOWN, of the cards
 * `keep` keeps (the panel's agent filter: by number for an outcome, by key for a pause; a pause of the queue itself, on
 * no card, always shows). `more`: Version Control has older ones (the model holds as many as it keeps).
 */
export function historyRows(v: QueueView, keep?: { number: (n: number) => boolean; key: (k: string) => boolean }): { rows: HistoryRow[]; more: boolean } {
  const outcomes: HistoryRow[] = v.recent.filter((r) => !keep || keep.number(r.card)).map((r) => ({ kind: 'outcome', at: r.at, key: `${r.entry}:${r.outcome}`, r }))
  const pauses: HistoryRow[] = v.pauses.filter((p) => !keep || !p.card || keep.key(p.card)).map((p) => ({ kind: 'pause', at: p.at, key: `pause:${p.at}:${p.reason}`, p }))
  const rows = [...outcomes, ...pauses].sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1))
  return { rows: rows.slice(0, HISTORY_SHOWN), more: rows.length > HISTORY_SHOWN || v.recent.length >= RECENT_MAX }
}

/** An outcome of Recent merges in a few words: "Merged", "Returned: conflict in tasks.ts", "Taken out: Remove from queue". */
export function historyOutcome(r: QueueRecent, why: string, tr: Tr): string {
  if (r.outcome === 'merged') return tr(msg({ id: 'board.queue.recent.merged', defaultMessage: 'Merged', description: "An outcome in the Progress panel's Recent merges (Merges tab): the merge queue merged the card. Its merge commit follows, as a short commit id." }))
  if (r.outcome === 'returned') return tr(msg({ id: 'board.queue.recent.returned', defaultMessage: 'Returned: {why}', description: "An outcome in the Progress panel's Recent merges (Merges tab): the merge queue returned the card to its builder, and why ({why}: conflict in tasks.ts, checks failed: unit…). Glossary 2.4: returned." }), { why })
  return tr(msg({ id: 'board.queue.recent.cancelled', defaultMessage: 'Taken out: {reason, select, removed {Remove from queue} stale {its pass no longer counted} hold {put On Hold} decision {a decision} integratedOutside {merged outside Combwork} followUp {a follow-up} other {cancelled}}', description: "An outcome in the Progress panel's Recent merges (Merges tab): the card's entry was taken out of the merge queue, and why (Remove from queue is a button's name; On Hold a column's). Keep the select keys." }), { reason: r.reason ?? 'other' }) // i18n-ignore: a select key, never shown
}

/** Why a queue paused, in a few words (HI-1924, Recent merges; the whole sentence, pauseText, is its tooltip). */
export function pauseWhyShort(p: Pick<QueuePauseLogged, 'reason' | 'by'>, tr: Tr): string {
  const reason = p.reason === 'user' ? (p.by === 'assistant' ? 'assistant' : 'user') : p.reason // i18n-ignore: select keys, never shown
  return tr(
    msg({
      id: 'board.queue.recent.paused',
      defaultMessage:
        'Paused: {reason, select, user {by you} assistant {by the Assistant} pushRejected {the remote refused the push} pushFailed {the push failed} pushNoRemote {no remote to push to} pushUnreadable {couldn’t read the branch to push it} targetMovesFast {the branch kept moving} folderBusy {its folder was busy} wrongBranch {its folder changed branch} staged {changes staged in its folder} unstagedChanges {changes in its folder} identity {no commit identity} needsYou {needs you} uncounted {the checks didn’t count} checkedOut {the branch was checked out} rulesOff {the rules were off} signingWaits {signing waited for you} signing {signing failed} hookTimedOut {a hook ran too long} subfolderTarget {no target branch named} mergeChoice {waiting for how to merge} approval {waiting for your OK} focusedSkip {waiting for your OK to skip focused tests} other {{code}}}',
      description: "A pause in the Progress panel's Recent merges (Merges tab): the merge queue paused, and why in a few words (by the user or the Assistant; the push of the target branch refused, failed, with no remote or unreadable (G18); the branch moving, its checked-out folder busy, on another branch, with staged or other changes; no git identity; needs the user; checks that didn't count; rules off; commit signing; a git hook; no target branch for a project in a subfolder; the merge style choice after the upgrade; the user's approval; skipping focused tests). Else {code}, Combwork's code for it. Lower case after the colon. Keep the select keys."
    }),
    { reason, code: p.reason }
  )
}

/** A merge's push (G18) in Recent merges, or null when there is nothing to say. */
export function pushStateText(state: QueuePushState | undefined, tr: Tr): string | null {
  if (!state) return null
  return tr(
    msg({
      id: 'board.queue.recent.push',
      defaultMessage: '{state, select, pushed {Pushed} pending {Not pushed yet} off {Not pushed: pushing was turned off} reset {Not pushed: the branch no longer had it} other {Push not recorded}}',
      description: "Beside a merge in the Progress panel's Recent merges (Merges tab), when the workflow pushes the target branch after merging (G18): pushed; not pushed yet; not pushed because the option was turned off, or because the branch was reset and no longer had the merge; or Combwork has no record of its push (an older merge). Keep the select keys."
    }),
    { state }
  )
}
