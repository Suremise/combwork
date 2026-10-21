import { Children, useCallback, useEffect, useState } from 'react'
import type { MoveCards, MoveHostPlan, MoveOptions, MoveOwner, MovePlan, MoveReport, WorkspaceMoved } from '@shared/types'
import { providerName } from '@shared/providers'
import { moveHasWork } from '@shared/movePaths'
import { shortPath } from '@shared/shortPath'
import { call } from '../api'
import { cardLabelOf, get, set, useStore } from '../store'
import { BusyButton, Icon, IconButton, Modal, Tooltip, useBusy } from './ui'
import { ItemTable, ShortPath, type ItemGroup, type ItemRow } from './ItemTable'
import { cx } from '../util'
import { fmt, msg, tr, tRich, type Msg } from '@shared/i18n'

/**
 * A workspace (or project) moved to another folder since Hive last opened it (#146): a banner over the main area, and
 * Repair…, which shows what it will do (worktrees, session folders, Claude Code's conversations and memory, Open
 * Recent), does it on confirmation and says what it did. Main works it all out (workspaceMove.ts).
 */

const movedKey = (m: WorkspaceMoved): string => `${m.from ?? ''}|${m.projects.join('|')}|${m.pending.join('|')}|${(m.cards ?? []).map((c) => `${c.from}>${c.to}:${c.cards.length}`).join('|')}|${m.branches ?? 0}`

const M = {
  cards: msg({ id: 'workspace.move.cards', defaultMessage: '{count, plural, one {# card} other {# cards}}', description: "Board items saved under a project's old name: cards (listed with lanes and card watches)." }),
  lanes: msg({ id: 'workspace.move.lanes', defaultMessage: '{count, plural, one {# lane} other {# lanes}}', description: "Board items saved under a project's old name: card loops' lanes." }),
  watches: msg({ id: 'workspace.move.watches', defaultMessage: '{count, plural, one {# card watch} other {# card watches}}', description: "Board items saved under a project's old name: agents' card watches." }),
  cardsLine: msg({ id: 'workspace.move.cardsLine', defaultMessage: '{total, plural, one {{what} of {from} belongs to {to}} other {{what} of {from} belong to {to}}}', description: 'What was left under a project\'s old name ({what}: "9 cards and 1 lane"; {from}: the old name; {to}: the project now). {total} counts them all.' }),
  fromWorkspace: msg({ id: 'workspace.move.fromWorkspace', defaultMessage: 'This workspace was moved from <mono>{from}</mono>.', description: 'The banner over a moved workspace. <mono> is the old folder, in a fixed-width font.' }),
  projects: msg({ id: 'workspace.move.projects', defaultMessage: '{count, plural, one {The project {name} was moved to another folder.} other {# projects were moved to another folder.}}', description: 'The banner when projects moved.' }),
  pending: msg({ id: 'workspace.move.pending', defaultMessage: 'A worktree of {projects} was made again at a new folder, and not everything has followed it yet.', description: 'The banner when a worktree was made again elsewhere.' }),
  stillPoint: msg({ id: 'workspace.move.stillPoint', defaultMessage: "Agents' worktrees, sessions and conversations still point to the old folder.", description: 'The banner over a moved workspace or project, after what moved.' }),
  cardsBanner: msg({ id: 'workspace.move.cardsBanner', defaultMessage: '{lines}, which was renamed or moved: the board still lists them under the old name.', description: 'The banner when cards are listed under a project\'s old name ({lines}: "9 cards of hive-website belong to website", several separated by ;).' }),
  branchesBanner: msg({ id: 'workspace.move.branchesBanner', defaultMessage: "{count, plural, one {An agent's branch is still named after an old folder; Repair renames it.} other {# agents' branches are still named after an old folder; Repair renames them.}}", description: "The banner when agents' git branches are named after where the workspace or project was (hive/<workspace>/<project>/<agent>)." }),
  repair: msg({ id: 'workspace.move.repairButton', defaultMessage: 'Repair…', description: 'The banner over a moved workspace: opens Repair.' }),
  hide: msg({ id: 'workspace.move.hide', defaultMessage: 'Hide for now (Repair Moved Workspace… stays in the command palette)', description: "The banner's close button. Repair Moved Workspace… is the command's name." }),
  undo: msg({ id: 'workspace.move.undo', defaultMessage: 'Undo', description: "Repair's plan: takes back a choice made for a missing worktree." }),
  recreateButton: msg({ id: 'workspace.move.recreateButton', defaultMessage: 'Recreate worktree', description: "Repair's plan: a missing worktree's choice." }),
  createButton: msg({ id: 'workspace.move.createButton', defaultMessage: 'Create a new worktree', description: "Repair's plan: a missing worktree's choice when its branch is gone too." }),
  locate: msg({ id: 'workspace.move.locate', defaultMessage: 'Locate…', description: "Repair's plan: a missing worktree's choice (pick its folder)." }),
  unlinkButton: msg({ id: 'workspace.move.unlinkButton', defaultMessage: "Remove the agent's worktree link", description: "Repair's plan: a missing worktree's choice." }),
  close: msg({ id: 'workspace.move.close', defaultMessage: 'Close', description: "Repair's button after it ran." }),
  cancel: msg({ id: 'workspace.move.cancel', defaultMessage: 'Cancel', description: "Repair's button that closes it." }),
  repairing: msg({ id: 'workspace.move.repairing', defaultMessage: 'Repairing…', description: "Repair's button while it works." }),
  repairConfirm: msg({ id: 'workspace.move.repair', defaultMessage: 'Repair', description: "Repair's button." }),
  title: msg({ id: 'workspace.move.title', defaultMessage: 'Repair a Moved Workspace', description: "Repair's dialog title." }),
  problems: msg({ id: 'workspace.move.problems', defaultMessage: 'Repair finished, with problems:', description: 'After Repair; what failed follows.' }),
  repaired: msg({ id: 'workspace.move.repaired', defaultMessage: 'Repaired. Everything now points to where the workspace is.', description: 'After Repair.' }),
  leftToDo: msg({ id: 'workspace.move.leftToDo', defaultMessage: 'Repair finished; something is left to do:', description: 'After Repair; what is left follows.' }),
  stays: msg({ id: 'workspace.move.stays', defaultMessage: "Repair… stays in the banner until it's done; running it again repeats nothing already done.", description: 'After Repair, when something is left to do.' }),
  working: msg({ id: 'workspace.move.working', defaultMessage: 'Working out what moved…', description: 'Repair while it reads what moved.' }),
  nothing: msg({ id: 'workspace.move.nothing', defaultMessage: 'Nothing to repair: everything already points to where the workspace is now.', description: 'Repair with nothing to do.' }),
  movedFromTo: msg({ id: 'workspace.move.movedFromTo', defaultMessage: 'The workspace moved from <mono>{from}</mono> to <mono>{to}</mono>. Repair will:', description: "Repair's plan, at the top; what it does follows. <mono> is a folder." }),
  projectsMoved: msg({ id: 'workspace.move.projectsMoved', defaultMessage: 'Projects moved to another folder. Repair will:', description: "Repair's plan, at the top; what it does follows." }),
  cardsOld: msg({ id: 'workspace.move.cardsOld', defaultMessage: "Cards are listed under a project's old name. Repair will:", description: "Repair's plan, at the top; what it does follows." }),
  unreadable: msg({ id: 'workspace.move.unreadable', defaultMessage: "{count, number} can't be read: {files}{more, plural, =0 {} other { and # more}}. Repair tries {count, plural, one {it} other {them}} again.", description: "Repair's plan: files that couldn't be read ({files}: up to five names)." }),
  untouched: msg({ id: 'workspace.move.untouched', defaultMessage: 'Nothing at the old location is moved or deleted.', description: "Repair's plan, at the bottom." }),
  stopFirst: msg({ id: 'workspace.move.stopFirst', defaultMessage: 'Stop the running agents first: {agents}.', description: "Repair's plan: why Repair can't run yet." })
}

const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>
const mono = (c: React.ReactNode[]): React.ReactNode => <span className="mono">{c}</span>
const faint = (c: React.ReactNode[]): React.ReactNode => <span className="faint">{c}</span>
const TAGS = { b: bold, mono, faint }
/** A message with markup (<b>, <mono>, <faint>), as React nodes. */
/** Whose folder a copy is for, in the window's language (#891); a record from before owners were kept says it in English. */
const ownerText = (f: { of?: string; owner?: MoveOwner }): string =>
  f.owner ? tr(msg({ id: 'workspace.move.owner', defaultMessage: "{owner, select, project {the project} assistant {the Assistant} other {{agent}'s worktree}}", description: "Repair's plan: whose folder a coding agent's conversations are copied for, put into its lines (\"… for {of}\", workspace.move.copy and copyNone): the project, the Hive Assistant, or an agent's worktree ({agent}: its name). Word it to fit there in your translation of those lines." }), { owner: f.owner.kind, agent: f.owner.kind === 'worktree' ? f.owner.agent : '' }) : (f.of ?? '')

const rich = (m: Msg, values: Record<string, string | number>): React.ReactNode[] => Children.toArray(tRich<React.ReactNode>(m, { ...values, ...TAGS }))

/** What was saved under a project's old name (#508): "9 cards", "9 cards and 1 lane". */
const savedUnder = (m: MoveCards): string => fmt.list([m.cards.length ? tr(M.cards, { count: m.cards.length }) : '', m.lanes ? tr(M.lanes, { count: m.lanes }) : '', m.watches ? tr(M.watches, { count: m.watches }) : ''].filter(Boolean))
/** "9 cards of hive-website belong to website": what was left under a project's old name (#508). */
const cardsLine = (m: MoveCards): string => tr(M.cardsLine, { what: savedUnder(m), from: m.from, to: m.to, total: m.cards.length + (m.lanes ?? 0) + (m.watches ?? 0) })

export function MovedBanner() {
  const moved = useStore((s) => s.workspace?.moved ?? null)
  const hidden = useStore((s) => s.moveBannerHidden)
  if (!moved || hidden === movedKey(moved)) return null
  const what = moved.from ? (
    <>{rich(M.fromWorkspace, { from: moved.from })}</>
  ) : moved.projects.length ? (
    <>{tr(M.projects, { count: moved.projects.length, name: moved.projects[0] })}</>
  ) : moved.pending.length ? (
    <>{tr(M.pending, { projects: fmt.list(moved.pending, 'unit') })}</>
  ) : null
  const cards = moved.cards ?? []
  return (
    <div className="banner warn moved-banner">
      <Icon name="folder-opened" />{' '}
      <span className="grow">
        {what ? <>{what} {tr(M.stillPoint)}</> : null}
        {cards.length > 0 && <>{what ? ' ' : ''}{tr(M.cardsBanner, { lines: cards.map(cardsLine).join('; ') })}</>}
        {!what && !cards.length && !!moved.branches && tr(M.branchesBanner, { count: moved.branches })}
      </span>
      <button className="btn small primary" onClick={() => set({ moveRepairOpen: true })}>
        {tr(M.repair)}
      </button>
      <IconButton icon="close" title={tr(M.hide)} onClick={() => set({ moveBannerHidden: movedKey(moved) })} />
    </div>
  )
}

const key = (projectPath: string, agentId: string): string => `${projectPath}#${agentId}`

type Choice = 'unlink' | 'recreate'

/** The plan's table (#1305): its columns' headings, and the words its rows use. */
const T = {
  what: msg({ id: 'workspace.repair.what', defaultMessage: 'What', description: "Repair's plan, a column heading: what a row is about (an agent's worktree, the sessions, Claude Code's conversations)." }),
  was: msg({ id: 'workspace.repair.was', defaultMessage: 'Was', description: "Repair's plan, a column heading: where it was before the move (a folder or a branch)." }),
  now: msg({ id: 'workspace.repair.now', defaultMessage: 'Now', description: "Repair's plan, a column heading: where it is now (a folder or a branch)." }),
  willDo: msg({ id: 'workspace.repair.willDo', defaultMessage: 'Will do', description: "Repair's plan, a column heading: what Repair will do about the row." }),
  worktree: msg({ id: 'workspace.repair.worktree', defaultMessage: "{agent}'s worktree", description: "Repair's plan, the What column: an agent's worktree ({agent}: its name)." }),
  branch: msg({ id: 'workspace.repair.branch', defaultMessage: "{agent}'s branch", description: "Repair's plan, the What column: an agent's git branch ({agent}: its name)." }),
  conversations: msg({ id: 'workspace.repair.conversations', defaultMessage: "{provider}'s conversations and memory", description: "Repair's plan, the What column: what a coding agent ({provider}: Claude Code) keeps per folder." }),
  workspace: msg({ id: 'workspace.repair.workspaceGroup', defaultMessage: 'Workspace', description: "Repair's plan: the heading over the rows about the whole workspace (Open Recent, Working on, the board)." }),
  notFound: msg({ id: 'workspace.repair.notFound', defaultMessage: 'not found', description: "Repair's plan, the Now column: an agent's worktree wasn't found." }),
  folders: msg({ id: 'workspace.repair.folders', defaultMessage: '{count, plural, one {# folder} other {# folders}}', description: "Repair's plan: how many of a coding agent's folders are copied (one per moved folder)." }),
  relink: msg({ id: 'workspace.repair.relink', defaultMessage: '{located, select, yes {located · } other {}}git worktree repair', description: "Repair's plan, the Will do column: Repair links a worktree with git's command (keep \"git worktree repair\" as it is); \"located\" when the user picked its folder." }),
  chooseShort: msg({ id: 'workspace.repair.chooseShort', defaultMessage: 'choose', description: "Repair's plan, the Will do column, in the warning colour: a missing worktree waits for one of the row's buttons (Recreate, Locate…, Remove link; its tooltip says so in full)." }),
  choose: msg({ id: 'workspace.repair.choose', defaultMessage: '{gone, select, yes {its branch is gone too: create, locate or remove its link} other {recreate, locate or remove its link}}', description: "Repair's plan, the Will do column, in the warning colour: a missing worktree waits for a choice (the row's buttons)." }),
  rename: msg({ id: 'workspace.repair.rename', defaultMessage: '{remote, select, none {rename} other {rename; {remote} keeps the old name}}', description: "Repair's plan, the Will do column: an agent's branch named after the old place is renamed ({remote}: the remote it tracks, which keeps the old name, or none)." }),
  untilDone: msg({ id: 'workspace.repair.untilDone', defaultMessage: '{n, plural, one {kept until {cards} is Done} other {kept until {cards} are Done}}', description: "Repair's plan, the Will do column: an agent's branch isn't renamed yet, because an unfinished card works on it ({cards}: the cards, #12; {n}: how many); the Repair after renames it." }),
  taken: msg({ id: 'workspace.repair.taken', defaultMessage: 'kept: the new name is taken', description: "Repair's plan, the Will do column: an agent's branch isn't renamed, because a branch with the new name exists." }),
  point: msg({ id: 'workspace.repair.point', defaultMessage: '{count, plural, one {point # session} other {point # sessions}}', description: "Repair's plan, the Will do column: the session records pointed to the new folder ({count}: how many)." }),
  nothingToCopy: msg({ id: 'workspace.repair.nothingToCopy', defaultMessage: 'nothing to copy', description: "Repair's plan, the Will do column: a coding agent's folder with nothing to copy (some files kept or unreadable, said after)." }),
  keptFiles: msg({ id: 'workspace.repair.keptFiles', defaultMessage: '{count, plural, one {# file kept} other {# files kept}}', description: "Repair's plan, after the Will do column's copy: files already there with other content, never overwritten (the full list in its tooltip)." }),
  keptTip: msg({ id: 'workspace.repair.keptTip', defaultMessage: "{count, plural, one {# file is} other {# files are}} already in the new folder with other content and won't be overwritten: {files}{more, plural, =0 {} other { and # more}}.", description: "Repair's plan: the tooltip of a coding agent's files left as they are ({files}: up to five names)." }),
  unreadableFiles: msg({ id: 'workspace.repair.unreadableFiles', defaultMessage: "{count, plural, one {# can't be read} other {# can't be read}}", description: "Repair's plan, after the Will do column's copy: files that couldn't be read (Repair tries them again; the list in its tooltip)." }),
  listNew: msg({ id: 'workspace.repair.listNew', defaultMessage: 'list the new folder', description: "Repair's plan, the Will do column of Open Recent: the new folder replaces the old one." }),
  markAgain: msg({ id: 'workspace.repair.markAgain', defaultMessage: 'mark {projects} again', description: "Repair's plan, the Will do column of Working on ({projects}: the projects)." }),
  showFolders: msg({ id: 'workspace.repair.showFolders', defaultMessage: 'Show the folders', description: "Repair's plan: the button that lists a coding agent's folders one by one under its row." }),
  hideFolders: msg({ id: 'workspace.repair.hideFolders', defaultMessage: 'Hide the folders', description: "Repair's plan: the button that folds a coding agent's folders back into one row." }),
  recreateShort: msg({ id: 'workspace.repair.recreateShort', defaultMessage: 'Recreate', description: "Repair's plan, a missing worktree's compact button (its tooltip says it in full: workspace.move.recreateButton)." }),
  createShort: msg({ id: 'workspace.repair.createShort', defaultMessage: 'Create', description: "Repair's plan, a missing worktree's compact button when its branch is gone too (its tooltip: workspace.move.createButton)." }),
  unlinkShort: msg({ id: 'workspace.repair.unlinkShort', defaultMessage: 'Remove link', description: "Repair's plan, a missing worktree's compact button (its tooltip says it in full: workspace.move.unlinkButton)." }),
  sessions: msg({ id: 'workspace.repair.sessions', defaultMessage: 'Sessions', description: "Repair's plan, the What column: the project's session records (each remembers the folder it ran in)." }),
  recent: msg({ id: 'workspace.repair.recent', defaultMessage: 'Open Recent', description: "Repair's plan, the What column: File → Open Recent's entry for the workspace. Use the menu's name as shown." }),
  workingOn: msg({ id: 'workspace.repair.workingOn', defaultMessage: 'Working on', description: "Repair's plan, the What column: the projects marked as being worked on in the sidebar. Use its name as shown." }),
  board: msg({ id: 'workspace.repair.board', defaultMessage: 'Board: {from}', description: "Repair's plan, the What column: what the board saved under a project's old name ({from})." }),
  recreate: msg({ id: 'workspace.repair.recreate', defaultMessage: '{exists, select, yes {recreate on {branch}} other {create new on {branch}}}', description: "Repair's plan, the Will do column: the worktree is made again on its branch, or new ({branch}: the branch)." }),
  unlink: msg({ id: 'workspace.repair.unlink', defaultMessage: 'remove the worktree link', description: "Repair's plan, the Will do column: the agent's link to its worktree is removed (its folder, if it turns up, stays)." }),
  original: msg({ id: 'workspace.repair.original', defaultMessage: 'stays with the project at its old folder (a copy)', description: "Repair's plan, the Will do column: the old project folder is still there, so its worktree stays linked to it." }),
  copy: msg({ id: 'workspace.repair.copy', defaultMessage: '{count, plural, one {copy # file} other {copy # files}}{stays, select, yes {; the old ones stay} other {}}', description: "Repair's plan, the Will do column: files copied to the folder for the new path, the old ones kept." }),
  give: msg({ id: 'workspace.repair.give', defaultMessage: 'give {what}{hasCards, select, yes { ({cards})} other {}} to {to}', description: "Repair's plan, the Will do column of the board's row ({what}: \"9 cards and 1 lane\"; {cards}: their numbers; {to}: the project now)." }),
  sentence: msg({ id: 'workspace.repair.sentence', defaultMessage: '{what}{hasWas, select, yes {: was {was}} other {}}{hasNow, select, yes {, now {now}} other {}}; will {does}', description: "Repair's plan, a row read by a screen reader as one sentence: what it is about, where it was and is (full paths), and what Repair will do. Each part comes from the row's columns." })
}

/** A plan row: its cells, and the sentence a screen reader reads for it (`presentation`). */
interface Cells {
  what: string
  was?: { path?: string; text?: string; other?: string }
  now?: { path?: string; text?: string; other?: string; warn?: boolean }
  does: string
  /** What it will do in full, when the cell says it shorter (the tooltip and the sentence). */
  said?: string
  doesNote?: { text: string; title?: string; warn?: boolean }
  warn?: boolean
  actions?: React.ReactNode
  /** Before the What text: a folded row's expander. */
  lead?: React.ReactNode
}

/** Where something was or is: a path as its part that differs (ShortPath), or a branch or a word, cut with an ellipsis. */
function Place({ p }: { p?: Cells['was'] & { warn?: boolean } }) {
  if (!p) return null
  if (p.path) return <ShortPath path={p.path} other={p.other} />
  return (
    <span className={cx('short-path', p.warn && 'warn-text')} title={p.text}>
      {p.text}
    </span>
  )
}

const said = (p?: Cells['was']): string => p?.path ?? p?.text ?? ''

function planRow(k: string, c: Cells, className?: string): ItemRow {
  const sentence = tr(T.sentence, { what: c.what, hasWas: said(c.was) ? 'yes' : 'no', was: said(c.was), hasNow: said(c.now) ? 'yes' : 'no', now: said(c.now), does: c.doesNote ? `${c.said ?? c.does}, ${c.doesNote.text}` : (c.said ?? c.does) })
  return {
    key: k,
    item: (
      <>
        <span className="visually-hidden">{sentence}</span>
        {c.lead}
        <span className="short-path" aria-hidden="true" title={c.what}>
          {c.what}
        </span>
      </>
    ),
    text: sentence,
    cells: [
      { content: <span aria-hidden="true">{<Place p={c.was} />}</span>, text: said(c.was) },
      { content: <span aria-hidden="true">{<Place p={c.now} />}</span>, text: said(c.now) },
      {
        content: (
          <span aria-hidden="true" className={cx('short-path', c.warn && 'warn-text')} title={c.doesNote ? `${c.said ?? c.does}; ${c.doesNote.title ?? c.doesNote.text}` : (c.said ?? c.does)}>
            {c.does}
            {c.doesNote && <span className={c.doesNote.warn ? 'warn-text' : 'faint'}> · {c.doesNote.text}</span>}
          </span>
        ),
        text: c.does
      }
    ],
    actions: c.actions,
    className
  }
}

/** A compact choice: an icon and a short label, the full label its tooltip and accessible name. */
function ChoiceButton({ icon, label, full, onClick }: { icon: string; label: string; full: string; onClick: () => void }) {
  return (
    <Tooltip content={full}>
      <button type="button" className="btn small subtle repair-choice" aria-label={full} onClick={onClick}>
        <Icon name={icon} /> {label}
      </button>
    </Tooltip>
  )
}

/** One project's rows (#1305): its worktrees, branches, sessions, and each coding agent's copies folded into one row. */
function hostRows(h: MoveHostPlan, open: ReadonlySet<string>, toggle: (k: string) => void, onLocate: (k: string, agentId: string) => void, onChoose: (k: string, choice: Choice | null) => void): ItemRow[] {
  const rows: ItemRow[] = []
  const undo = (k: string) => <ChoiceButton icon="discard" label={tr(M.undo)} full={tr(M.undo)} onClick={() => onChoose(k, null)} />
  for (const w of h.worktrees) {
    const k = key(h.path, w.agentId)
    const what = tr(T.worktree, { agent: w.agentName })
    const was = { path: w.from, other: w.to ?? undefined }
    if (w.how === 'missing') {
      rows.push(
        planRow(k, {
          what,
          was: { path: w.from },
          now: { text: tr(T.notFound), warn: true },
          does: tr(T.chooseShort),
          said: tr(T.choose, { gone: w.branchExists ? 'no' : 'yes' }),
          warn: true,
          actions: (
            <>
              <ChoiceButton icon="refresh" label={tr(w.branchExists ? T.recreateShort : T.createShort)} full={tr(w.branchExists ? M.recreateButton : M.createButton)} onClick={() => onChoose(k, 'recreate')} />
              <ChoiceButton icon="folder-opened" label={tr(M.locate)} full={tr(M.locate)} onClick={() => onLocate(k, w.agentId)} />
              <ChoiceButton icon="close" label={tr(T.unlinkShort)} full={tr(M.unlinkButton)} onClick={() => onChoose(k, 'unlink')} />
            </>
          )
        }, 'repair-missing')
      )
    } else if (w.how === 'recreate') rows.push(planRow(k, { what, was: { path: w.from }, now: w.to ? { path: w.to, other: w.from } : undefined, does: tr(T.recreate, { exists: w.branchExists ? 'yes' : 'no', branch: w.branch ?? '' }), actions: undo(k) }))
    else if (w.how === 'unlink') rows.push(planRow(k, { what, was: { path: w.from }, does: tr(T.unlink), actions: undo(k) }))
    else if (w.how === 'original') rows.push(planRow(k, { what, was: { path: w.from }, does: tr(T.original) }, 'faint'))
    else rows.push(planRow(k, { what, was, now: { path: w.to ?? '', other: w.from }, does: tr(T.relink, { located: w.how === 'located' ? 'yes' : 'no' }) }))
  }
  for (const b of h.branches ?? []) rows.push(planRow(`${h.path}#branch#${b.agentId}`, { what: tr(T.branch, { agent: b.agentName }), was: { text: b.from }, now: { text: b.to }, does: b.kept === 'card' ? tr(T.untilDone, { cards: fmt.list((b.cards ?? []).map((c) => cardLabelOf(get(), c)), 'unit'), n: b.cards?.length ?? 0 }) : b.kept ? tr(T.taken) : tr(T.rename, { remote: b.remote ?? 'none' }), warn: b.kept === 'exists' }))
  if (h.sessions > 0) rows.push(planRow(`${h.path}#sessions`, { what: tr(T.sessions), was: { path: h.from, other: h.folder }, now: { path: h.folder, other: h.from }, does: tr(T.point, { count: h.sessions }) }))
  const copies = h.folders.filter((f) => f.copy > 0 || f.kept.length > 0 || !!f.failed?.length)
  for (const provider of [...new Set(copies.map((f) => f.provider))]) {
    const mine = copies.filter((f) => f.provider === provider)
    const k = `${h.path}#copies#${provider}`
    const shown = open.has(k)
    const files = mine.reduce((n, f) => n + f.copy, 0)
    const kept = mine.flatMap((f) => f.kept)
    const failed = mine.flatMap((f) => f.failed ?? [])
    const note = (keptFiles: string[], failedFiles: string[]): Cells['doesNote'] =>
      failedFiles.length
        ? { text: tr(T.unreadableFiles, { count: failedFiles.length }), title: tr(M.unreadable, { count: failedFiles.length, files: fmt.list(failedFiles.slice(0, 5), 'unit'), more: Math.max(0, failedFiles.length - 5) }), warn: true }
        : keptFiles.length
          ? { text: tr(T.keptFiles, { count: keptFiles.length }), title: tr(T.keptTip, { count: keptFiles.length, files: fmt.list(keptFiles.slice(0, 5), 'unit'), more: Math.max(0, keptFiles.length - 5) }) }
          : undefined
    const toggleButton = (
      <IconButton icon={shown ? 'chevron-down' : 'chevron-right'} className="repair-expand" title={tr(shown ? T.hideFolders : T.showFolders)} expanded={shown} onClick={() => toggle(k)} />
    )
    rows.push(
      planRow(k, {
        what: tr(T.conversations, { provider: providerName(provider) }),
        was: { text: tr(T.folders, { count: mine.length }) },
        does: files > 0 ? tr(T.copy, { count: files, stays: 'yes' }) : tr(T.nothingToCopy),
        doesNote: note(kept, failed),
        lead: toggleButton
      }, 'repair-folded')
    )
    if (shown)
      for (const f of mine)
        rows.push(
          planRow(`${k}#${f.from}`, { what: ownerText(f) || providerName(f.provider), was: { path: f.from, other: f.to }, now: { path: f.to, other: f.from }, does: f.copy > 0 ? tr(T.copy, { count: f.copy, stays: 'no' }) : tr(T.nothingToCopy), doesNote: note(f.kept, f.failed ?? []) }, 'repair-sub')
        )
  }
  return rows
}

/** The workspace's rows: Open Recent, Working on, and what the board saved under a project's old name. */
function workspaceRows(plan: MovePlan): ItemRow[] {
  const rows: ItemRow[] = []
  if (plan.recent && plan.from) rows.push(planRow('ws#recent', { what: tr(T.recent), was: { path: plan.from, other: plan.to }, now: { path: plan.to, other: plan.from }, does: tr(T.listNew) }))
  if (plan.working.length) rows.push(planRow('ws#working', { what: tr(T.workingOn), does: tr(T.markAgain, { projects: fmt.list(plan.working, 'unit') }) }))
  for (const m of plan.cards ?? [])
    rows.push(planRow(`ws#cards#${m.from}`, { what: tr(T.board, { from: m.from }), does: tr(T.give, { what: savedUnder(m), hasCards: m.cards.length ? 'yes' : 'no', cards: fmt.list(m.cards.map((n) => cardLabelOf(get(), n)), 'unit'), to: m.to }) }))
  return rows
}

/** The plan as one table (#1305), the project hover's agent table's look: a group a project, then the workspace's. */
function PlanTable({ plan, onLocate, onChoose }: { plan: MovePlan; onLocate: (k: string, agentId: string) => void; onChoose: (k: string, choice: Choice | null) => void }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (k: string): void => setOpen((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])))
  const rows: (ItemRow | ItemGroup)[] = []
  for (const h of plan.hosts) {
    const mine = hostRows(h, open, toggle, onLocate, onChoose)
    if (mine.length) rows.push({ key: `group#${h.path}`, group: h.name, text: h.name }, ...mine)
  }
  const ws = workspaceRows(plan)
  if (ws.length) rows.push({ key: 'group#ws', group: tr(T.workspace), text: tr(T.workspace) }, ...ws)
  const choices = plan.hosts.some((h) => h.worktrees.some((w) => w.how === 'missing' || w.how === 'recreate' || w.how === 'unlink'))
  return <ItemTable first={T.what} columns={[{ label: T.was }, { label: T.now }, { label: T.willDo }]} rows={rows} className={cx(/* i18n-ignore: class names */ 'fill repair-plan', choices && 'has-choices')} presentation />
}

export function MoveRepairDialog() {
  const open = useStore((s) => s.moveRepairOpen)
  const [plan, setPlan] = useState<MovePlan | null | undefined>(undefined)
  const [opts, setOpts] = useState<MoveOptions>({})
  const [report, setReport] = useState<MoveReport | null>(null)
  const action = useBusy()
  const { run, setError } = action
  const load = useCallback(
    (o: MoveOptions) => {
      void run('plan', async () => setPlan(await call('workspace:movePlan', o)))
    },
    [run]
  )
  useEffect(() => {
    if (!open) return
    setPlan(undefined)
    setOpts({})
    setReport(null)
    setError(null)
    load({})
  }, [open, load, setError])
  if (!open) return null
  const close = (): void => set({ moveRepairOpen: false })
  const choose = (next: MoveOptions): void => {
    setOpts(next)
    load(next)
  }
  const locate = async (k: string, agentId: string): Promise<void> => {
    const r = await action.run('locate', () => call('workspace:moveLocate', k.slice(0, k.lastIndexOf('#')), agentId))
    if (r?.value) choose({ ...opts, locate: { ...opts.locate, [k]: r.value }, unlink: opts.unlink?.filter((x) => x !== k), recreate: opts.recreate?.filter((x) => x !== k) })
  }
  /** A missing worktree's way out: its link removed, or the worktree made again; null takes the choice back. */
  const pick = (k: string, c: Choice | null): void => {
    const unlink = (opts.unlink ?? []).filter((x) => x !== k)
    const recreate = (opts.recreate ?? []).filter((x) => x !== k)
    choose({ ...opts, unlink: c === 'unlink' ? [...unlink, k] : unlink, recreate: c === 'recreate' ? [...recreate, k] : recreate })
  }
  const repair = async (): Promise<void> => {
    const r = await action.run('repair', () => call('workspace:moveRepair', opts))
    if (r) setReport(r.value)
  }
  const nothing = plan !== undefined && (!plan || !moveHasWork(plan))
  const footer = report ? (
    <button className="btn primary" onClick={close} autoFocus>
      {tr(M.close)}
    </button>
  ) : (
    <>
      <button className="btn" onClick={close}>
        {tr(M.cancel)}
      </button>
      <BusyButton className="primary" busy={action.busy === 'repair'} busyLabel={tr(M.repairing)} disabled={!plan || nothing || plan.running.length > 0 || action.busy === 'plan'} onClick={() => void repair()}>
        {tr(M.repairConfirm)}
      </BusyButton>
    </>
  )
  return (
    <Modal title={tr(M.title)} icon="folder-opened" onClose={close} footer={footer} wide busy={action.busy === 'repair'} error={action.error}>
      <div className="move-repair">
        {report ? (
          <>
            <p>{tr(report.failed.length ? M.problems : report.complete ? M.repaired : M.leftToDo)}</p>
            {report.failed.length > 0 && <ReportList icon="error" className="warn-text" lines={report.failed} />}
            {report.done.length > 0 && <ReportList icon="check" lines={report.done} />}
            {report.skipped.length > 0 && <ReportList icon="info" className="faint" lines={report.skipped} />}
            {!report.complete && <p className="hint">{tr(M.stays)}</p>}
          </>
        ) : plan === undefined ? (
          <p className="faint">
            <Icon name="loading" spin /> {tr(M.working)}
          </p>
        ) : !plan || nothing ? (
          <p>{tr(M.nothing)}</p>
        ) : (
          <>
            <p>{plan.from ? rich(M.movedFromTo, { from: shortPath(plan.from, plan.to), to: shortPath(plan.to, plan.from) }) : tr(plan.hosts.length ? M.projectsMoved : M.cardsOld)}</p>
            <PlanTable plan={plan} onLocate={(k, id) => void locate(k, id)} onChoose={pick} />
            <p className="hint">{tr(M.untouched)}</p>
            {plan.running.length > 0 && (
              <p className="warn-text">
                <Icon name="warning" /> {tr(M.stopFirst, { agents: fmt.list(plan.running, 'unit') })}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

function ReportList({ icon, lines, className }: { icon: string; lines: string[]; className?: string }) {
  return (
    <ul className={cx('move-report', className)}>
      {lines.map((l, i) => (
        <li key={i}>
          <Icon name={icon} /> {l}
        </li>
      ))}
    </ul>
  )
}
