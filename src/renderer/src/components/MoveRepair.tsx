import { Children, useCallback, useEffect, useState } from 'react'
import type { MoveCards, MoveOptions, MoveOwner, MovePlan, MoveReport, MoveWorktree, WorkspaceMoved } from '@shared/types'
import { providerName } from '@shared/providers'
import { moveHasWork } from '@shared/movePaths'
import { call } from '../api'
import { cardLabelOf, get, set, useStore } from '../store'
import { BusyButton, Icon, IconButton, Modal, useBusy } from './ui'
import { cx } from '../util'
import { fmt, msg, tr, tRich, type Msg } from '@shared/i18n'

/**
 * A workspace (or project) moved to another folder since Hive last opened it (#146): a banner over the main area, and
 * Repair…, which shows what it will do (worktrees, session folders, Claude Code's conversations and memory, Open
 * Recent), does it on confirmation and says what it did. Main works it all out (workspaceMove.ts).
 */

const movedKey = (m: WorkspaceMoved): string => `${m.from ?? ''}|${m.projects.join('|')}|${m.pending.join('|')}|${(m.cards ?? []).map((c) => `${c.from}>${c.to}:${c.cards.length}`).join('|')}`

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
  repair: msg({ id: 'workspace.move.repairButton', defaultMessage: 'Repair…', description: 'The banner over a moved workspace: opens Repair.' }),
  hide: msg({ id: 'workspace.move.hide', defaultMessage: 'Hide for now (Repair Moved Workspace… stays in the command palette)', description: "The banner's close button. Repair Moved Workspace… is the command's name." }),
  undo: msg({ id: 'workspace.move.undo', defaultMessage: 'Undo', description: "Repair's plan: takes back a choice made for a missing worktree." }),
  unlink: msg({ id: 'workspace.move.unlink', defaultMessage: "Remove <b>{agent}</b>'s worktree link (its folder, if it turns up, is left as it is).", description: "Repair's plan, a line. <b> is bold." }),
  recreate: msg({ id: 'workspace.move.recreate', defaultMessage: "Recreate <b>{agent}</b>'s worktree on its branch <mono>{branch}</mono>, with its commits, at <mono>{to}</mono>; its setup command runs at its next start.", description: "Repair's plan, a line. <b> is bold; <mono> a branch or folder." }),
  createNew: msg({ id: 'workspace.move.createNew', defaultMessage: 'Create a new worktree for <b>{agent}</b> on <mono>{branch}</mono> (its branch is gone too), at <mono>{to}</mono>; its setup command runs at its next start.', description: "Repair's plan, a line. <b> is bold; <mono> a branch or folder." }),
  missing: msg({ id: 'workspace.move.missing', defaultMessage: "<b>{agent}</b>'s worktree wasn't found (it was at <mono>{from}</mono>){gone, select, yes {, and its branch is gone too} other {}}.", description: "Repair's plan, a line; choices follow. <b> is bold; <mono> a folder." }),
  recreateButton: msg({ id: 'workspace.move.recreateButton', defaultMessage: 'Recreate worktree', description: "Repair's plan: a missing worktree's choice." }),
  createButton: msg({ id: 'workspace.move.createButton', defaultMessage: 'Create a new worktree', description: "Repair's plan: a missing worktree's choice when its branch is gone too." }),
  locate: msg({ id: 'workspace.move.locate', defaultMessage: 'Locate…', description: "Repair's plan: a missing worktree's choice (pick its folder)." }),
  unlinkButton: msg({ id: 'workspace.move.unlinkButton', defaultMessage: "Remove the agent's worktree link", description: "Repair's plan: a missing worktree's choice." }),
  original: msg({ id: 'workspace.move.original', defaultMessage: "<b>{agent}</b>'s worktree stays with the project at its old folder, which is still there (this looks like a copy).", description: "Repair's plan, a line. <b> is bold." }),
  found: msg({ id: 'workspace.move.found', defaultMessage: "<b>{agent}</b>'s worktree: {how, select, stayed {relink <mono>{to}</mono> to the moved project} other {now at <mono>{to}</mono>}}{located, select, yes { (located)} other {}} — <faint>git worktree repair</faint>", description: "Repair's plan, a line. <b> is bold; <mono> a folder; <faint> is the git command Repair runs (keep it as it is)." }),
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
  sessions: msg({ id: 'workspace.move.sessions', defaultMessage: '{count, plural, one {Point # session to the new folder, so it resumes where it ran.} other {Point # sessions to the new folders, so they resume where they ran.}}', description: "Repair's plan, a line." }),
  copy: msg({ id: 'workspace.move.copy', defaultMessage: "Copy {count, plural, one {# file} other {# files}} of {provider}'s conversations and memory for {hasOf, select, yes {{of}} other {the folder}} to its folder for the new path (<mono>{to}</mono>); the old one stays.", description: "Repair's plan, a line: a coding agent's ({provider}: Claude Code) own folder for a project. <mono> is a folder." }),
  copyNone: msg({ id: 'workspace.move.copyNone', defaultMessage: "{provider}'s conversations and memory for {hasOf, select, yes {{of}} other {the folder}}:", description: "Repair's plan, a line: a coding agent's own folder, when nothing is copied (why follows)." }),
  kept: msg({ id: 'workspace.move.kept', defaultMessage: "{count, plural, one {# file is} other {# files are}} already in <mono>{to}</mono> with other content and won't be overwritten: {files}{more, plural, =0 {} other { and # more}}.", description: "Repair's plan: files left as they are ({files}: up to five names)." }),
  unreadable: msg({ id: 'workspace.move.unreadable', defaultMessage: "{count, number} can't be read: {files}{more, plural, =0 {} other { and # more}}. Repair tries {count, plural, one {it} other {them}} again.", description: "Repair's plan: files that couldn't be read ({files}: up to five names)." }),
  board: msg({ id: 'workspace.move.board', defaultMessage: 'Board', description: "Repair's plan: the heading over the board's lines." }),
  give: msg({ id: 'workspace.move.give', defaultMessage: 'Give the {what} saved under <b>{from}</b>{hasCards, select, yes { ({cards})} other {}} to <b>{to}</b>, where cards show with their agents, archived ones too.', description: "Repair's plan, a line ({what}: \"9 cards and 1 lane\"; {cards}: their numbers). <b> is bold." }),
  recent: msg({ id: 'workspace.move.recent', defaultMessage: 'Open Recent: list <mono>{to}</mono> instead of the old folder.', description: "Repair's plan: File → Open Recent's entry. <mono> is a folder." }),
  workingOn: msg({ id: 'workspace.move.workingOn', defaultMessage: 'Working on: mark {projects} again, as at the old folder.', description: "Repair's plan: the projects marked as being worked on." }),
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

/** One worktree line of the plan: where it is now, or what to do about one that wasn't found. */
function WorktreeLine({ host, w, onLocate, onChoose }: { host: string; w: MoveWorktree; onLocate: (k: string, agentId: string) => void; onChoose: (k: string, choice: Choice | null) => void }) {
  const k = key(host, w.agentId)
  const undo = (
    <button className="btn small subtle" onClick={() => onChoose(k, null)}>
      {tr(M.undo)}
    </button>
  )
  if (w.how === 'unlink') {
    return (
      <li>
        {rich(M.unlink, { agent: w.agentName })} {undo}
      </li>
    )
  }
  if (w.how === 'recreate') {
    return (
      <li>
        {rich(w.branchExists ? M.recreate : M.createNew, { agent: w.agentName, branch: w.branch ?? '', to: w.to ?? '' })} {undo}
      </li>
    )
  }
  if (w.how === 'missing') {
    return (
      <li className="warn-text">
        {rich(M.missing, { agent: w.agentName, from: w.from, gone: w.branchExists ? 'no' : 'yes' })}{' '}
        <button className="btn small subtle" onClick={() => onChoose(k, 'recreate')}>
          {tr(w.branchExists ? M.recreateButton : M.createButton)}
        </button>{' '}
        <button className="btn small subtle" onClick={() => onLocate(k, w.agentId)}>
          {tr(M.locate)}
        </button>{' '}
        <button className="btn small subtle" onClick={() => onChoose(k, 'unlink')}>
          {tr(M.unlinkButton)}
        </button>
      </li>
    )
  }
  if (w.how === 'original') {
    return (
      <li className="faint">
        {rich(M.original, { agent: w.agentName })}
      </li>
    )
  }
  return (
    <li>
      {rich(M.found, { agent: w.agentName, how: w.how === 'stayed' ? 'stayed' : 'moved', to: w.to ?? '', located: w.how === 'located' ? 'yes' : 'no' })}
    </li>
  )
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
            <p>{plan.from ? rich(M.movedFromTo, { from: plan.from, to: plan.to }) : tr(plan.hosts.length ? M.projectsMoved : M.cardsOld)}</p>
            {plan.hosts.map((h) => {
              const copies = h.folders.filter((f) => f.copy > 0 || f.kept.length > 0 || !!f.failed?.length)
              if (!h.worktrees.length && !h.sessions && !copies.length) return null
              return (
                <section key={h.path}>
                  <h4>{h.name}</h4>
                  <ul>
                    {h.worktrees.map((w) => (
                      <WorktreeLine key={w.agentId} host={h.path} w={w} onLocate={(k, id) => void locate(k, id)} onChoose={pick} />
                    ))}
                    {h.sessions > 0 && (
                      <li>{tr(M.sessions, { count: h.sessions })}</li>
                    )}
                    {copies.map((f) => (
                      <li key={`${f.provider}:${f.from}`}>
                        {f.copy > 0 ? rich(M.copy, { count: f.copy, provider: providerName(f.provider), hasOf: ownerText(f) ? 'yes' : 'no', of: ownerText(f), to: f.to }) : tr(M.copyNone, { provider: providerName(f.provider), hasOf: ownerText(f) ? 'yes' : 'no', of: ownerText(f) })}
                        {f.kept.length > 0 && (
                          <span className="faint">
                            {' '}
                            {rich(M.kept, { count: f.kept.length, to: f.to, files: fmt.list(f.kept.slice(0, 5), 'unit'), more: Math.max(0, f.kept.length - 5) })}
                          </span>
                        )}
                        {!!f.failed?.length && (
                          <span className="warn-text">
                            {' '}
                            {tr(M.unreadable, { count: f.failed.length, files: fmt.list(f.failed.slice(0, 5), 'unit'), more: Math.max(0, f.failed.length - 5) })}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
            {(plan.cards ?? []).length > 0 && (
              <section>
                <h4>{tr(M.board)}</h4>
                <ul>
                  {plan.cards!.map((m) => (
                    <li key={m.from}>{rich(M.give, { what: savedUnder(m), from: m.from, to: m.to, hasCards: m.cards.length ? 'yes' : 'no', cards: fmt.list(m.cards.map((n) => cardLabelOf(get(), n)), 'unit') })}</li>
                  ))}
                </ul>
              </section>
            )}
            {plan.recent && (
              <p>{rich(M.recent, { to: plan.to })}</p>
            )}
            {plan.working.length > 0 && <p>{tr(M.workingOn, { projects: fmt.list(plan.working, 'unit') })}</p>}
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
