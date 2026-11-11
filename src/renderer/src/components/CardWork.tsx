import { useEffect, useState } from 'react'
import { fmt, msg, tr } from '@shared/i18n'
import { formatDateTime } from '@shared/dates'
import { columnName } from '@shared/tasks'
import { revisionShort } from '@shared/platform/descriptors'
import type { ProjectInfo, StoredText, TaskCard } from '@shared/types'
import { checksOn, type WorkBadge, type WorkCheck, type WorkOverride, type WorkRevision, type WorkVerdict, type WorkView } from '@shared/workflow/workView'
import { RULE_NAMES, unreadWhy } from '@shared/workflow/texts'
import { refusalLines, type RuleId } from '@shared/workflow/refusals'
import { overrideNote, type OverrideNames } from '@shared/laneBar'
import { useCardWork } from '../cardWork'
import { openFileLink } from '../fileLinks'
import { notify, useStore } from '../store'
import { agentFolder, awayFromProject } from '../agentPlace'
import { cx, timeAgo } from '../util'
import { CardQueue, SHOW_QUEUE_WORK } from './CardQueue'
import { CardRoundCostTable } from './CardCost'
import { GitlinkRow } from './GitlinkDiff'
import { Icon, Tooltip } from './ui'

// A card's work (#1224, SPEC §16.4; #1223's work view): the dialog's Work section and the board card's badges. What the
// card's facts say, in the glossary's words (revision, verdict, check, stale, outside Combwork, before 1.0). Revisions are
// shown through the card's project's platform (revisionShort), never by switching on its id.

const M = {
  title: msg({ id: 'board.work.title', defaultMessage: 'Work', description: "A heading in the card dialog (click to show or hide): what the card's facts say of its work (its branch, revisions, verdicts, checks, merge). Glossary: work." }),
  reading: msg({ id: 'board.work.reading', defaultMessage: 'Reading its work…', description: "The card dialog's Work section while the card's work is being read." }),
  failed: msg({ id: 'board.work.failed', defaultMessage: 'Couldn’t read the card’s work: {error}', description: "The card dialog's Work section when its work couldn't be read (the repository or the board). {error} is why, in the words of the error." }),
  retry: msg({ id: 'board.work.retry', defaultMessage: 'Retry', description: "A button in the card dialog's Work section after its work couldn't be read: reads it again." }),
  noRecord: msg({ id: 'board.work.noRecord', defaultMessage: 'No work record: its board isn’t upgraded to Combwork 1.0, or the card has no project.', description: "The card dialog's Work section when there is no work to show: the board hasn't had the 1.0 upgrade, or the card is the workspace's (no project)." }),
  preWorkflow: msg({ id: 'board.work.preWorkflow', defaultMessage: 'Before 1.0: this card has no work record.', description: "The card dialog's Work section for a card from before 1.0: Combwork records no work for it and invents none. Glossary: before 1.0." }),
  adopted: msg({ id: 'board.work.adopted', defaultMessage: 'Adopted at the upgrade, from {column}: its work starts from what its folder showed then.', description: "The card dialog's Work section for a card Combwork took on at the upgrade to 1.0 from what could be read. {column} is the board column it was in (Doing, Review, Passed)." }),
  none: msg({ id: 'board.work.none', defaultMessage: 'No revision submitted yet.', description: "The card dialog's Work section for a card whose builder hasn't submitted a revision for review yet. Glossary: revision." }),
  branch: msg({ id: 'board.work.branch', defaultMessage: 'Branch', description: "A label in the card dialog's Work section: the git branch the card's work is on follows." }),
  base: msg({ id: 'board.work.base', defaultMessage: 'Base', description: "A label in the card dialog's Work section: the revision the card's work started from follows (a short commit id, a3f2c1d)." }),
  folder: msg({ id: 'board.work.folder', defaultMessage: 'Folder', description: "A label in the card dialog's Work section: the folder the card's work is done in follows (the project folder, or its own folder)." }),
  projectFolder: msg({ id: 'board.work.projectFolder', defaultMessage: 'The project folder', description: "The card dialog's Work section, after Folder: the card's work is done in the project's own folder (not a folder of its own)." }),
  workspace: msg({ id: 'board.work.workspace', defaultMessage: 'Workspace', description: "A label in the card dialog's Work section (HI-2869): the jj workspace (a slot) a jj card's work is in follows. “workspace” is jj's term." }),
  notReady: msg({ id: 'board.work.notReady', defaultMessage: 'Not started in {slot} yet: {stale, select, yes {another jj workspace rewrote its working copy, so it is stale. Recover it under Version Control → Slots and copies, and the card is prepared there again.} other {Combwork couldn’t get it ready ({why}).}}', description: "The card dialog's Work section (HI-2913): the card's slot ({slot}, slot-a) couldn't be prepared for its start, so its work hasn't started there. {stale} yes: the slot is a stale jj workspace (another workspace rewrote the commit it works on), which the user mends with Recover… in the Slots and copies list; other: {why} is the reason, in English as its builder was told. Keep the select keys." }),
  change: msg({ id: 'board.work.change', defaultMessage: '{commits, plural, one {change {change}} other {change {change}, # commits}}', description: "Beside a jj card's revision in the card dialog's Work section (HI-2869): its jj change id (short), and how many commits its submitted work holds when more than one. “change” is jj's term." }),
  via: msg({ id: 'board.work.via', defaultMessage: '{via, select, ancestry {(found in its history)} replay {(its change found applied again)} sameTree {(the target already had it)} candidate {(from a prepared candidate)} other {}}', description: "After how a jj card went into its target, in the card dialog's Work section (HI-2869): how jj proved it was there. Keep the select keys; other stays empty." }),
  target: msg({ id: 'board.work.target', defaultMessage: 'Target', description: "A label in the card dialog's Work section: where the card's work goes once approved follows (the target branch, main). Glossary: target branch." }),
  revisions: msg({ id: 'board.work.revisions', defaultMessage: 'Revisions, newest first', description: "A heading in the card dialog's Work section, above the revisions the builder submitted for review. Glossary: revision." }),
  round: msg({ id: 'board.work.round', defaultMessage: 'Round {round, number}', description: "Beside a revision in the card dialog's Work section: the review round it was submitted in (1, 2…)." }),
  noCode: msg({ id: 'board.work.noCode', defaultMessage: 'Submitted without code', description: "In place of a revision in the card dialog's Work section: a no-code card's submission (design, investigation), which has no revision. Glossary: no-code card." }),
  noRevision: msg({ id: 'board.work.noRevision', defaultMessage: 'No revision recorded', description: "In place of a revision in the card dialog's Work section: the card's revision couldn't be read when it was submitted (a project without version control, before Combwork reads its revisions). Glossary: revision." }),
  notRead: msg({ id: 'board.work.notRead', defaultMessage: '{note, select, beforeChange {Not read when its work started} noTarget {Not read: there was no target branch to start from} other {Combwork couldn\'t read {why}}}', description: "In the card dialog's Work section, in place of a branch, base or target Combwork couldn't read when the card's work started. {note} picks why: Combwork read nothing as the work started (beforeChange), it had no target branch to find the base from (noTarget), or another reason, {why}: what Combwork couldn't read (such as \"the latest commit in …\", already translated). Keep the select keys. Glossary: target branch." }),
  revisionNotRead: msg({ id: 'board.work.revisionNotRead', defaultMessage: "{note, select, beforeChange {No revision recorded: Combwork didn't read one when the card went to Review.} other {Revision not read when it was submitted: Combwork couldn't read {why}.}} Its next submission reads it again.", description: "In place of a revision in the card dialog's Work section. {note} picks why: Combwork read nothing when the card was moved into Review (beforeChange; the card had no agent then, say), or it couldn't read the revision when the builder submitted it, {why}: what it couldn't read (such as \"the latest commit in …\", already translated). Then: the next submission reads it again. Keep the select keys. Glossary: revision." }),
  filesNotRead: msg({ id: 'board.work.filesNotRead', defaultMessage: '{note, select, beforeChange {Files not read} noBaseOrHead {Files not read: there was no base or revision to compare} other {Files not read: Combwork couldn\'t read {why}}}', description: "In the card dialog's Work section, in place of a revision's changed files: Combwork couldn't read which files changed when it was submitted. {note} picks why: Combwork read nothing then (beforeChange: the revision's line above says why), it had no base or revision to compare (noBaseOrHead), or another reason, {why}: what it couldn't read (already translated). Keep the select keys. Glossary: revision." }),
  folderGone: msg({ id: 'board.work.folderGone', defaultMessage: 'Its folder, {folder}, is no longer an agent’s worktree: its files can’t be opened here.', description: "Under a revision's files in the card dialog's Work section: the folder the work was done in ({folder}, a path) isn't any agent's worktree now, so its files aren't opened in another folder instead." }),
  files: msg({ id: 'board.work.files', defaultMessage: '{n, plural, =0 {No files changed} one {# file changed} other {# files changed}}', description: "A button in the card dialog's Work section: how many files the revision changed; a click shows them." }),
  openFile: msg({ id: 'board.work.openFile', defaultMessage: 'Open {path} in Files', description: "Tooltip of a file a revision changed (card dialog's Work section): opens it in the project's Files tab. {path} is the file's path." }),
  verdict: msg({ id: 'board.work.verdict', defaultMessage: '{reviewer}: {pass, select, yes {passed} other {failed}}{current, select, no { (no longer counts)} other {}}', description: "A verdict under a revision in the card dialog's Work section: who reviewed it ({reviewer}, an agent's name, then a colon) and whether it passed or failed; (no longer counts) when a newer revision or decision came since. Keep the select keys. Glossary: verdict, pass/fail." }),
  check: msg({ id: 'board.work.check', defaultMessage: '{name}: {result, select, passed {passed} failed {failed} other {stopped}}{counted, select, no { (not counted)} other {}}', description: "A check under a revision in the card dialog's Work section: its name (typecheck, as the project names it), then a colon and how it ended; (not counted) when it doesn't count for the revision (its hover says why). Keep the select keys. Glossary: check." }),
  integrated: msg({ id: 'board.work.integrated', defaultMessage: '{method, select, merge {Merged into {target} as {result}} squash {Squashed into {target} as {result}} fastForward {{target} moved forward to {result}} sameTree {Already in {target} at {result}} other {Committed in {target} as {result}}}', description: "The card dialog's Work section: how the card's work went into its target ({target}, a branch such as main) and the target's revision with it ({result}, a short commit id). Keep the select keys." }),
  outsideCombwork: msg({ id: 'board.work.outsideCombwork', defaultMessage: 'Merged outside Combwork.', description: "The card dialog's Work section, under how the card was merged: the merge was made outside Combwork (in a terminal or another tool). Glossary: outside Combwork." }),
  accepted: msg({ id: 'board.work.accepted', defaultMessage: 'Accepted {when}.', description: "The card dialog's Work section: the card's work was accepted (a project without version control, or a no-code card) at {when}, a date and time." }),
  staleChange: msg({ id: 'board.work.staleChange', defaultMessage: 'Stale: the pass was for {approved}; the card is now at {current}.', description: "A mark in the card dialog's Work section: the card's pass is for an older revision ({approved}, a short commit id) that isn't the same change as its revision now ({current}). Glossary: stale, pass." }),
  staleDecision: msg({ id: 'board.work.staleDecision', defaultMessage: 'Stale: a decision was recorded since the pass.', description: "A mark in the card dialog's Work section: the card's pass no longer counts because the user recorded a decision on the card after it. Glossary: stale, pass." }),
  staleNext: msg({ id: 'board.work.staleNext', defaultMessage: 'To move it on, its builder submits it again, or puts its branch back at {approved}: until then it isn’t merged.', description: "A mark in the card dialog's Work section under a stale pass, in Approved (Passed): what moves the card on. Its builder submits its work again (for a new review), or puts its branch back at the revision that passed ({approved}, a short commit id), which makes the pass count again. Glossary: stale, pass." }),
  backAtApproved: msg({ id: 'board.work.backAtApproved', defaultMessage: 'Its branch came back to {revision}, the revision that passed: the pass counts again.', description: "A mark in the card dialog's Work section: the card's branch changed after its pass (which made the pass stale), then came back to exactly the revision that passed ({revision}, a short commit id), so the pass counts again. Glossary: pass, revision." }),
  carriedOver: msg({ id: 'board.work.carriedOver', defaultMessage: 'The pass for {from} carries over to {to}: the same change.', description: "A mark in the card dialog's Work section: a pass for an earlier revision ({from}) still counts for a later one ({to}) with exactly the same changes. Glossary: carries over, same change." }),
  outsideRules: msg({ id: 'board.work.outsideRules', defaultMessage: 'Merged outside the rules: {rules}.', description: "A mark in the card dialog's Work section: the card was merged by hand before these rules passed ({rules}, the rules' names, joined). Glossary: rule." }),
  inTarget: msg({ id: 'board.work.inTarget', defaultMessage: 'Its code is already in {target}: it stays in Review, and is closed as merged once its review passes.', description: "HI-2709: a mark in the card dialog's Work section, for a card in Review: its submitted work is already in its target ({target}, a branch such as main), merged by hand or inside another card's merge. It isn't taken as merged yet: its own review still decides, and once that passes the card is closed as merged." }),
  mergedInPart: msg({ id: 'board.work.mergedInPart', defaultMessage: 'Merged in part: some of its work is already in {target}.', description: "A mark in the card dialog's Work section: part of the unfinished card's work was found in its target ({target}, a branch such as main)." }),
  leftTarget: msg({ id: 'board.work.leftTarget', defaultMessage: 'No longer in {target}: its revision {revision} was taken out.', description: "A mark in the card dialog's Work section: a Done card's revision ({revision}, a short commit id) is no longer in its target ({target}, a branch such as main)." }),
  overridden: msg({ id: 'board.work.overridden', defaultMessage: 'Moved past its review and approvals by an override.', description: "A mark in the card dialog's Work section: the card's latest revision was moved on by an override (the user's or the Assistant's exception to the rules). Glossary: override." }),
  badgeStale: msg({ id: 'board.work.badgeStale', defaultMessage: 'Stale: its pass no longer counts for its revision', description: "Tooltip and accessible name of a mark on a board card: the card's pass is stale (for an older revision, or before a decision). Glossary: stale." }),
  badgeOutside: msg({ id: 'board.work.badgeOutside', defaultMessage: 'Merged outside the rules', description: "Tooltip and accessible name of a mark on a board card: the card was merged by hand before its rules passed. Glossary: rule." })
}
// The lane hover's words for a card's revision, verdict and checks (#1225), the same on the board card.
const LANE = {
  revision: msg({ id: 'board.lane.workRevision', defaultMessage: "{review, select, yes {Under review: {revision}} other {Revision: {revision}}}", description: "A line in a lane segment's hover (Progress panel): the card's revision (a short commit id, a3f2c1d), the one under review when the card is in Review." }),
  verdict: msg({ id: 'board.lane.workVerdict', defaultMessage: "{pass, select, yes {Last verdict: passed} other {Last verdict: failed}}{revision, select, none {} other { on {revision}}}{current, select, no {, which no longer counts} other {}}", description: "A line in a lane segment's hover (Progress panel): the card's last review verdict, passed or failed, on which revision (a short commit id; none for a card without one: keep that branch empty), and whether it no longer counts (a newer change or decision since). Keep the select keys as they are." }),
  checks: msg({ id: 'board.lane.workChecks', defaultMessage: "Checks on it: {passed, number} passed, {failed, number} failed", description: "A line in a lane segment's hover (Progress panel): how many of the checks on the card's revision passed and failed (each check's latest run that counted)." })
}
const COPY = {
  copy: msg({ id: 'board.progress.copyRevision', defaultMessage: "Copy revision {revision}", description: "Tooltip of a run's revision in the Progress panel (under its agent): copies the whole commit id. {revision} is its short form (a3f2c1d)." }),
  copied: msg({ id: 'board.progress.revisionCopied', defaultMessage: "Revision {revision} copied", description: "A notification after copying a run's revision (a commit id) from the Progress panel. {revision} is its short form (a3f2c1d)." }),
  failed: msg({ id: 'board.progress.revisionCopyFailed', defaultMessage: "Could not copy the revision", description: "A notification: copying a run's revision (a commit id) from the Progress panel failed." })
}
const NOT_COUNTED = msg({ id: 'board.details.notCounted', defaultMessage: "Doesn't count as check {name}: {why, select, notCheck {it wasn't started as a check (cw-progress --check), and its command isn't one the project has for a check} notContained {what was checked out doesn't contain the card's revision} dirty {the folder had uncommitted changes when it started or ended} moved {something else was checked out when it ended} changed {files changed in the folder while it ran} revisionChanged {the card's files changed while it ran} other {it can't be told whether its files changed}}", description: "A run's details in the Progress panel: why the run doesn't count as the card's check named {name} (\"typecheck\", or the run's title when it wasn't a check). {why} picks the reason: keep each branch's key as it is." })

/** Why a field wasn't read (#1477), in the window's language. */
const unread = (field: string, of: { unknown: Record<string, string>; unknownText: Record<string, StoredText> }): { note: string; why: string } => unreadWhy(field, of, (m, values) => tr(m, values))

/** A card's project, and its revisions as that project's platform shows them. */
function useProjectOf(card: { project: string }): { project: ProjectInfo | null; short: (id: string) => string } {
  const project = useStore((s) => s.workspace?.projects.find((p) => p.name === card.project) ?? null)
  const platform = project?.platform?.id
  return { project, short: (id) => (platform ? revisionShort(platform, id) : id.slice(0, 7)) }
}

/** Two folder paths are the same folder (Windows: any case, either slash, no trailing one). */
const folderKey = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
const samePath = (a: string, b: string): boolean => folderKey(a) === folderKey(b)

/** A revision: short, a click copies it whole. */
function RevisionCode({ id, short }: { id: string; short: (id: string) => string }) {
  const s = short(id)
  return (
    <button
      type="button"
      className="card-work-rev-id"
      title={tr(COPY.copy, { revision: s })}
      onClick={() =>
        void navigator.clipboard.writeText(id).then(
          () => notify('success', tr(COPY.copied, { revision: s })),
          () => notify('error', tr(COPY.failed))
        )
      }
    >
      <code>{s}</code>
    </button>
  )
}

/** The card dialog's Work section (#1224): its branch, base, folder and target, revisions newest first, marks and merge. */
export function CardWork({ card }: { card: TaskCard }) {
  const [open, setOpen] = useState(true)
  // For you's "Show the files and commands" (#1357): open, and bring the merge queue part into view (`reveal`).
  const [reveal, setReveal] = useState(0)
  useEffect(() => {
    const show = (): void => {
      setOpen(true)
      setReveal((n) => n + 1)
    }
    window.addEventListener(SHOW_QUEUE_WORK, show)
    return () => window.removeEventListener(SHOW_QUEUE_WORK, show)
  }, [])
  const { view, error, loaded, retry } = useCardWork(card.number)
  const { project, short } = useProjectOf(card)
  const agentName = (id: string | null): string => (id ? (project?.agents.find((a) => a.id === id)?.name ?? id) : '')
  return (
    <>
      <div className="task-section-h clickable" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} /> {tr(M.title)}
      </div>
      {open && (
        <div className="card-work" data-work={view ? (view.preWorkflow ? 'before-1.0' : 'recorded') : error ? 'failed' : loaded ? 'none' : 'reading'}>
          {error ? (
            <div className="card-work-note">
              <Icon name="warning" /> {tr(M.failed, { error })}{' '}
              <button type="button" className="btn small" onClick={retry}>
                {tr(M.retry)}
              </button>
            </div>
          ) : !loaded ? (
            <div className="faint">{tr(M.reading)}</div>
          ) : !view ? (
            <div className="faint">{tr(M.noRecord)}</div>
          ) : view.preWorkflow ? (
            <div className="faint">{tr(M.preWorkflow)}</div>
          ) : (
            <WorkDetails card={card} view={view} project={project} short={short} agentName={agentName} reveal={reveal} />
          )}
        </div>
      )}
    </>
  )
}

function WorkDetails({ card, view: v, project, short, agentName, reveal }: { card: TaskCard; view: WorkView; project: ProjectInfo | null; short: (id: string) => string; agentName: (id: string | null) => string; reveal: number }) {
  const rows: [string, React.ReactNode][] = []
  // A field that couldn't be read when the work started says so, with why (never shown as none).
  const notRead = (field: string): React.ReactNode => <span className="card-work-unread">{tr(M.notRead, unread(field, v))}</span>
  // A jj card (HI-2869): its slot workspace in its line's place (the line is a key, never shown).
  if (v.workspace) rows.push([tr(M.workspace), <code key="line">{v.workspace}</code>])
  else if (v.line) rows.push([tr(M.branch), <code key="line">{v.line}</code>])
  else if (v.unknown.line) rows.push([tr(M.branch), notRead('line')])
  if (v.base) rows.push([tr(M.base), <RevisionCode key="base" id={v.base} short={short} />])
  else if (v.unknown.base) rows.push([tr(M.base), notRead('base')])
  if (v.folder) rows.push([tr(M.folder), v.folder === 'project' ? tr(M.projectFolder) : <code key="folder">{v.folder}</code>])
  if (v.target) rows.push([tr(M.target), <code key="target">{v.target}</code>])
  else if (v.unknown.target) rows.push([tr(M.target), notRead('target')])
  const marks = workMarks(v, short)
  return (
    <>
      {v.adopted && <div className="faint card-work-adopted">{tr(M.adopted, { column: columnName(v.adoptedFrom ?? 'doing', tr) })}</div>}
      {v.notReady && (
        <div className="card-work-note" data-work-not-ready={v.notReady.stale ? 'stale' : ''}>
          <Icon name="warning" /> {tr(M.notReady, { slot: v.notReady.slot, why: v.notReady.why, stale: v.notReady.stale ? 'yes' : 'no' })}
        </div>
      )}
      {rows.length > 0 && (
        <dl className="card-work-facts">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {marks.length > 0 && (
        <ul className="card-work-marks">
          {marks.map((m) => (
            <li key={m}>
              <Icon name="warning" /> {m}
            </li>
          ))}
        </ul>
      )}
      <CardQueue card={card} view={v} projectPath={project?.path ?? null} short={short} reveal={reveal} />
      {v.integration && (
        <div className="card-work-merged">
          <Icon name="git-merge" /> {tr(M.integrated, { method: v.integration.method, target: v.integration.target, result: short(v.integration.result) })}
          {v.integration.by === 'outside' && <> {tr(M.outsideCombwork)}</>}
          {v.integration.via && <span className="faint"> {tr(M.via, { via: v.integration.via })}</span>}
        </div>
      )}
      {v.accepted && (
        <div className="card-work-merged">
          <Icon name="pass" /> {tr(M.accepted, { when: formatDateTime(v.accepted.at) })}
        </div>
      )}
      {v.revisions.length === 0 ? (
        !v.integration && !v.accepted && <div className="faint">{tr(M.none)}</div>
      ) : (
        <>
          <div className="card-work-sub">{tr(M.revisions)}</div>
          {[...v.revisions].reverse().map((r) => (
            <RevisionRow key={r.submission} r={r} noCode={v.kind === 'no-code'} verdicts={v.verdicts.filter((x) => x.submission === r.submission)} checks={r.revision ? checksOn(v, r.revision) : []} project={project} folder={v.folder} short={short} agentName={agentName} />
          ))}
        </>
      )}
      <CardRoundCostTable card={card} />
    </>
  )
}

/** What a card's marks say, a sentence each (stale, carried over, outside the rules, merged in part, left its target, an override). */
function workMarks(v: WorkView, short: (id: string) => string): string[] {
  const out: string[] = []
  const st = v.marks.stale
  if (st) out.push(st.why === 'decision' || !st.approved || !st.current ? tr(M.staleDecision) : tr(M.staleChange, { approved: short(st.approved), current: short(st.current) }))
  // What moves a stale pass on (#1623): nothing queues it until then.
  if (st?.approved && st.why !== 'decision' && v.stage === 'approved' && v.line) out.push(tr(M.staleNext, { approved: short(st.approved) }))
  for (const c of v.marks.carriedOver) out.push(c.how === 'sameRevision' ? tr(M.backAtApproved, { revision: short(c.to) }) : tr(M.carriedOver, { from: short(c.from), to: short(c.to) }))
  if (v.marks.outsideRules.length) out.push(tr(M.outsideRules, { rules: fmt.list(v.marks.outsideRules) }))
  if (v.marks.mergedInPart) out.push(tr(M.mergedInPart, { target: v.marks.mergedInPart.target }))
  if (v.marks.inTarget) out.push(tr(M.inTarget, { target: v.marks.inTarget.target }))
  if (v.marks.leftTarget) out.push(tr(M.leftTarget, { target: v.marks.leftTarget.target, revision: short(v.marks.leftTarget.revision) }))
  if (v.marks.overridden) out.push(tr(M.overridden))
  return out
}

function RevisionRow({ r, noCode, verdicts, checks, project, folder, short, agentName }: { r: WorkRevision; noCode: boolean; verdicts: WorkVerdict[]; checks: WorkCheck[]; project: ProjectInfo | null; folder: string | null; short: (id: string) => string; agentName: (id: string | null) => string }) {
  const [files, setFiles] = useState(false)
  // Its files open in the folder it was made in (#1224 round 1, finding 1): the project folder, or the slot or worktree
  // at the recorded path, whichever agent works there now (#1442); never another tree. A folder no agent has now: its
  // files show as text.
  const agentAt = folder && folder !== 'project' ? (project?.agents.find((a) => awayFromProject(a) && samePath(agentFolder(a), folder))?.id ?? null) : null
  const openable = !!project && (folder === 'project' || folder === null || agentAt !== null)
  const open = (path: string): void => {
    if (!project || !openable) return
    openFileLink({ project: project.path, agentId: agentAt, root: agentAt && folder ? folder : project.path, rel: path })
  }
  return (
    <div className="card-work-rev" data-submission={r.submission}>
      {/* A revision not read says so on a line of its own (its reason can be long). */}
      {!r.revision && r.unknown.revision && <div className="card-work-unread">{tr(M.revisionNotRead, unread('revision', r))}</div>}
      <div className="card-work-rev-head">
        {/* Its parts with middle dots between them; the time relative, the date and time in full on hover, as elsewhere. */}
        {r.revision ? <RevisionCode id={r.revision} short={short} /> : !r.unknown.revision && <span>{tr(noCode ? M.noCode : M.noRevision)}</span>}
        {r.change && (
          <span className="faint mono" title={r.change} data-change={r.change}>
            {' '}
            {tr(M.change, { change: r.change.slice(0, 12), commits: r.chain ?? 1 })}
          </span>
        )}
        <span className="faint card-work-dot">{tr(M.round, { round: r.round })}</span>
        {r.by && <span className="faint card-work-dot">{agentName(r.by)}</span>}
        <span className="faint card-work-dot" title={formatDateTime(r.at)}>
          {timeAgo(r.at)}
        </span>
        <span className="grow" />
        {r.files.length ? (
          <button type="button" className="btn small subtle" aria-expanded={files} onClick={() => setFiles(!files)}>
            <Icon name={files ? 'chevron-down' : 'chevron-right'} /> {tr(M.files, { n: r.files.length })}
          </button>
        ) : r.unknown.files ? (
          // Never read: not "no files changed" (#1224 round 1, finding 2).
          <span className="card-work-unread">{tr(M.filesNotRead, unread('files', r))}</span>
        ) : (
          <span className="faint">{tr(M.files, { n: 0 })}</span>
        )}
      </div>
      {files && (
        <ul className="card-work-files">
          {r.files.map((f) => (
            <li key={f.path}>
              <span className="card-work-file-status">{f.status}</span>
              {openable ? (
                <button type="button" className="link" title={tr(M.openFile, { path: f.path })} onClick={() => open(f.path)}>
                  {f.gitlink ? <GitlinkRow path={f.path} change={f.gitlink} className="gitlink-file" /> : f.path}
                </button>
              ) : f.gitlink ? (
                <GitlinkRow path={f.path} change={f.gitlink} className="gitlink-file" />
              ) : (
                <span>{f.path}</span>
              )}
            </li>
          ))}
          {!openable && folder && <li className="faint card-work-gone">{tr(M.folderGone, { folder })}</li>}
        </ul>
      )}
      {(verdicts.length > 0 || checks.length > 0) && (
        <ul className="card-work-results">
          {verdicts.map((x, i) => (
            <li key={`v${i}`} className={cx(x.pass ? 'pass' : 'fail', !x.current && 'old')}>
              <Icon name={x.pass ? 'pass' : 'error'} /> {tr(M.verdict, { reviewer: agentName(x.reviewer), pass: x.pass ? 'yes' : 'no', current: x.current ? 'yes' : 'no' })}
            </li>
          ))}
          {checks.map((c, i) => {
            const line = (
              <li key={`c${i}`} className={cx(c.result === 'passed' ? 'pass' : 'fail', !c.counted && 'old')}>
                <Icon name={c.result === 'passed' ? 'check' : 'close'} /> {tr(M.check, { name: c.name, result: c.result, counted: c.counted ? 'yes' : 'no' })}
              </li>
            )
            return c.counted ? line : (
              <Tooltip key={`c${i}`} content={tr(NOT_COUNTED, { name: c.name, why: c.whyNot ?? 'other' /* i18n-ignore: a select's key, never shown */ })}>
                {line}
              </Tooltip>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** How the window names the rules a move skipped (a rule this Combwork has no name for: its id). */
export const OVERRIDE_NAMES: OverrideNames = {
  list: (items, type) => fmt.list(items, type),
  ruleName: (r) => (RULE_NAMES[r] ? tr(RULE_NAMES[r]) : r),
  // A refusal in the window's language, names (stages, moves, rules) by their messages, as the board says it (#1279).
  refusal: (rule, values) => refusalLines(rule as RuleId, values, { one: (m, v) => tr(m, v), list: (items) => fmt.list(items, 'unit'), names: true })
}

/** A card moved past its rules (#1275, §16.8.4): who did it, which rules and why, in its tooltip and accessible name. */
function OverrideMark({ o }: { o: WorkOverride }) {
  const text = overrideNote(o, tr, OVERRIDE_NAMES)
  return (
    <Tooltip content={text}>
      <span className="task-work-badge override" aria-label={text} data-badge="override">
        <Icon name="unlock" />
      </span>
    </Tooltip>
  )
}

/**
 * A board card's work badges (#1224): the revision under review, the last verdict and on which revision, the checks on
 * it, and a stale or outside-the-rules mark. Quiet, on one line, each with an icon and an accessible name (colour never
 * alone). Nothing for a card with no work recorded, or from before 1.0.
 */
export function WorkBadges({ b, card }: { b: WorkBadge | undefined; card: { project: string; column: string } }) {
  const { short } = useProjectOf(card)
  if (!b || b.preWorkflow) return null
  const shown = b.revision || b.verdict || b.checks.passed + b.checks.failed > 0 || b.stale || b.outsideRules || b.override
  if (!shown) return null
  const revisionText = b.revision ? tr(LANE.revision, { review: card.column === 'review' ? 'yes' : 'no', revision: short(b.revision) }) : ''
  const verdictText = b.verdict ? tr(LANE.verdict, { pass: b.verdict.pass ? 'yes' : 'no', revision: b.verdict.revision ? short(b.verdict.revision) : 'none', current: b.verdict.current ? 'yes' : 'no' }) : '' // i18n-ignore: select keys, never shown
  const checksText = tr(LANE.checks, { passed: b.checks.passed, failed: b.checks.failed })
  return (
    <div className="task-work">
      {b.revision && (
        <Tooltip content={revisionText}>
          <span className="task-work-badge" aria-label={revisionText}>
            <Icon name="git-commit" />
            <code>{short(b.revision)}</code>
          </span>
        </Tooltip>
      )}
      {b.verdict && (
        <Tooltip content={verdictText}>
          <span className={cx('task-work-badge', b.verdict.pass ? 'pass' : 'fail', !b.verdict.current && 'old')} aria-label={verdictText}>
            <Icon name={b.verdict.pass ? 'pass' : 'error'} />
          </span>
        </Tooltip>
      )}
      {b.checks.passed + b.checks.failed > 0 && (
        <Tooltip content={checksText}>
          <span className={cx('task-work-badge', b.checks.failed ? 'fail' : 'pass')} aria-label={checksText}>
            <Icon name="beaker" />
            {b.checks.passed}
            {b.checks.failed > 0 && (
              <>
                <Icon name="close" />
                {b.checks.failed}
              </>
            )}
          </span>
        </Tooltip>
      )}
      {b.stale && (
        <Tooltip content={tr(M.badgeStale)}>
          <span className="task-work-badge warn" aria-label={tr(M.badgeStale)}>
            <Icon name="history" />
          </span>
        </Tooltip>
      )}
      {b.override && <OverrideMark o={b.override} />}
      {b.outsideRules && (
        <Tooltip content={tr(M.badgeOutside)}>
          <span className="task-work-badge warn" aria-label={tr(M.badgeOutside)}>
            <Icon name="shield" />
          </span>
        </Tooltip>
      )}
    </div>
  )
}
