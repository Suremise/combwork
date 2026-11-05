import { useMemo, type ReactNode } from 'react'
import { AGENT_LIMIT_DEFAULT } from '@shared/defaults'
import type { ProjectInfo, TaskCard } from '@shared/types'
import { fmt, msg, tr, type Msg } from '@shared/i18n'
import { agentCardText, agentRowsText, laneOrder, type TableLane } from '@shared/agentTable'
import { watchText } from '@shared/agentWatch'
import { agentWorkflowRole, WORKFLOW_ROLE_TEXT } from '@shared/workflow/roles'
import { batchOutcome, removeWorktreeText, type BatchKind, type BatchWorktree } from '@shared/startAll'
import { statusText } from './ui'
import { ItemTable, type ItemGroup, type ItemRow } from './ItemTable'
import { cx } from '../util'
import { useLanes } from '../laneSource'
import { agentProviderOf, useLanguage, useStore } from '../store'
import { legacyOf, placeText } from '../agentPlace'
import { connectionCellText, useConnections } from './ConnectionChoice'
import type { ConnectionsView } from '@shared/accounts'

type Agent = ProjectInfo['agents'][number]

/** An agent's row: its state in a few words, the card it works on (or reviews), and what it waits for. */
export function agentRow(p: ProjectInfo, a: Agent, tasks: readonly TaskCard[]): { state: string; card: string; waits: string } {
  const card = agentCardText(tasks, p.name, a.id)
  const l = a.live
  if (!l) return { state: tr(msg({ id: 'panes.table.notRunning', defaultMessage: 'Not running', description: "An agents table's State column: the agent's session isn't running." })), card, waits: '' }
  if (l.status === 'watching' && l.watch) return { state: tr(msg({ id: 'panes.table.watching', defaultMessage: 'Watching', description: "An agents table's State column: the agent waits for cards or agents to change (a watch); the Waiting for column says what." })), card, waits: watchText(l.watch, tr, (x) => fmt.list(x), 'cell') }
  if (l.status === 'background') return { state: tr(msg({ id: 'panes.table.background', defaultMessage: 'Waiting on {n, plural, one {# background task} other {# background tasks}}', description: "An agents table's State column: the agent's turn ended but tasks it started in the background still run." }), { n: l.backgroundTasks ?? 0 }), card, waits: '' }
  return { state: statusText(l), card, waits: '' }
}

/** The agents, one line each, for an accessible description and wherever text is wanted: "HB1: Working… · #402 Coordinator…". */
export function agentsText(p: ProjectInfo, tasks: TaskCard[], lanes: readonly TableLane[]): string {
  return laneOrder(p.agents, lanes)
    .map((a) => {
      const r = agentRow(p, a, tasks)
      const what = r.waits ? tr(msg({ id: 'panes.table.waitingFor', defaultMessage: 'Waiting for {what}', description: "An agent in a line of text (a screen reader's description of a project's agents): what it waits for ({what}: \"#12 → Review\", \"B6 to finish\")." }), { what: r.waits }) : r.state
      return `${a.name}: ${what}${r.card ? ` · ${r.card}` : ''}`
    })
    .join('\n')
}

/**
 * A column of an agents table after Agent: its heading, its kind (a card's cell gets the most room; a short one, a state
 * or a project, never wraps in a dialog) and its cell in words in the plain text (`agentRowsText`).
 */
export interface AgentColumn {
  /** Its heading: a message (#799), or text a caller hasn't converted yet. */
  label: string | Msg
  kind?: 'card' | 'short' | 'role'
  /** Its cell in the plain text, a message with the cell as {value} ("card {value}"); none: the cell as it is. */
  cell?: Msg
}

/** A row: the agent (its name and status dot; `off` when it isn't running) and one cell per column. */
export interface AgentTableRow {
  key: string
  name: string
  /** Its status dot's class ('stopped' when it isn't running). */
  dot: string
  off?: boolean
  cells: { text: string; warn?: boolean }[]
  /** Extra attributes for tests and styling (`data-agent` is always the name). */
  className?: string
}

/** A heading row across the table (the quit dialog's agents under their workspace), and its words in the plain text. */
export interface AgentTableGroup {
  key: string
  group: ReactNode
  text: string
  title?: string
  className?: string
}

/** A table's columns and rows: what it shows, and what its plain text says (`tableText`). */
export interface AgentTableData {
  columns: AgentColumn[]
  rows: (AgentTableRow | AgentTableGroup)[]
}

/** The table as plain text (#572): every cell it shows, a line an agent, for screen readers and a confirm's copy. */
export function tableText(d: AgentTableData): string {
  return agentRowsText(
    d.columns.map((c) => ({ cell: c.cell && ((text: string) => tr(c.cell!, { value: text })) })),
    d.rows.map((r) => ('group' in r ? { groupText: r.text } : r))
  )
}

/**
 * Agents as a table (#529, #572), for a tooltip or a dialog: Agent (with its status dot) and the columns given, each cell
 * one line cut with an ellipsis (an empty card "—"). The table never scrolls sideways: each column has a share of the
 * room its tooltip or dialog leaves (app.css, by the number of columns), and a longer cell, the agent's name too, is cut.
 * More agents than the default limit (up to 24, #562) take tighter rows, so they still fit a window's height.
 */
export function AgentRowsTable({ columns, rows, className, bodyClassName }: { columns: AgentColumn[]; rows: (AgentTableRow | AgentTableGroup)[]; className?: string; bodyClassName?: string }) {
  useLanguage()
  const agents = rows.filter((r): r is AgentTableRow => 'cells' in r).length
  // An ItemTable (#1317) whose item is the agent's name with its status dot, and whose cells are cut (app.css's shares).
  const items = rows.map((r): ItemRow | ItemGroup =>
    'group' in r
      ? { ...r, className: cx('agents-table-group', r.className) }
      : {
          key: r.key,
          item: (
            <span>
              <span className={cx('dot', r.dot)} />
              {r.name}
            </span>
          ),
          itemClassName: 'agents-table-cut agents-table-name', // i18n-ignore: class names
          text: r.name,
          cells: columns.map((c, i) => ({ content: <span>{r.cells[i]?.text || (c.kind === 'card' ? '—' : '')}</span>, text: r.cells[i]?.text ?? '', className: r.cells[i]?.warn ? 'agents-table-warn' : undefined })),
          className: cx(r.off && 'off', r.className),
          data: { agent: r.name }
        }
  )
  return (
    <ItemTable
      first={msg({ id: 'panes.table.agent', defaultMessage: 'Agent', description: "An agents table's first column heading: the agent's name and status dot." })}
      columns={columns.map((c) => ({ label: c.label, className: cx('agents-table-cut', c.kind === 'card' && 'agents-table-card', (c.kind === 'short' || c.kind === 'role') && 'agents-table-short', c.kind === 'role' && 'agents-table-role') }))}
      rows={items}
      className={cx('agents-table', `cols-${columns.length + 1}`, agents > AGENT_LIMIT_DEFAULT && 'many', className)}
      bodyClassName={bodyClassName}
      data={{ agents: String(agents) }}
    />
  )
}

/** The columns the tables share, with their words in the plain text (#572). */
export const STATE_COLUMN: AgentColumn = { label: msg({ id: 'panes.table.state', defaultMessage: 'State', description: "An agents table's column heading: what the agent is doing." }), kind: 'short' }
export const CARD_COLUMN: AgentColumn = {
  label: msg({ id: 'panes.table.card', defaultMessage: 'Card', description: "An agents table's column heading: the card the agent works on or reviews." }),
  kind: 'card',
  cell: msg({ id: 'panes.table.cardPrefix', defaultMessage: 'card {value}', description: "The agent's card in a line of text (screen readers, a dialog's copy): {value} is the card (\"#12 Title\", \"reviewing #12 Title\"). Lower case." })
}
export const WAITING_COLUMN: AgentColumn = {
  label: msg({ id: 'panes.table.waiting', defaultMessage: 'Waiting for', description: "An agents table's column heading: what a watching agent waits for (cards, agents, lanes)." }),
  cell: msg({ id: 'panes.table.waitingPrefix', defaultMessage: 'waiting for {value}', description: "What a watching agent waits for, in a line of text (screen readers, a dialog's copy): {value} is what (\"#12 → Review\", \"B6 to finish\"). Lower case." })
}
/** An agent's role in the workflow (#1430): builder, reviewer or either. */
export const ROLE_COLUMN: AgentColumn = {
  label: msg({ id: 'panes.table.role', defaultMessage: 'Role', description: "An agents table's column heading: the agent's role in the workflow (Builder, Reviewer, Either). Glossary: workflow role." }),
  kind: 'role',
  cell: msg({ id: 'panes.table.rolePrefix', defaultMessage: 'role {value}', description: "The agent's role in the workflow in a line of text (screen readers): {value} is its name (\"Reviewer\"). Lower case." })
}
/** Where the agent works (#1442): "in slot-b", "carried: hb2", "home: hr4"; empty in the project folder. */
export const SLOT_COLUMN: AgentColumn = {
  label: msg({ id: 'panes.table.slot', defaultMessage: 'Slot', description: "An agents table's column heading: where the agent works (\"in slot-b\", \"carried: hb2\", \"home: hr4\"; empty in the project folder). Glossary: slot." }),
  kind: 'short',
  cell: msg({ id: 'panes.table.slotPrefix', defaultMessage: 'works {value}', description: "Where the agent works in a line of text (screen readers): {value} is agents.place.short (\"in slot-b\", \"carried: hb2\"). Lower case." })
}
/** The connection the agent runs on, or would start on (HI-1769): "Max 1", "Max 2 ⟳". */
export const CONNECTION_COLUMN: AgentColumn = {
  label: msg({ id: 'panes.table.connection', defaultMessage: 'Connection', description: "An agents table's column heading (HI-1769): the connection the agent runs on, or would start on (a login or service its coding agent CLI uses: \"Max 1\")." }),
  kind: 'short',
  cell: msg({ id: 'panes.table.connectionPrefix', defaultMessage: 'on {value}', description: "The agent's connection in a line of text (screen readers): {value} is its name (\"on Max 1\"). Lower case." })
}
export const PROJECT_COLUMN: AgentColumn = {
  label: msg({ id: 'panes.table.project', defaultMessage: 'Project', description: "An agents table's column heading: the agent's project." }),
  kind: 'short',
  cell: msg({ id: 'panes.table.projectPrefix', defaultMessage: 'in {value}', description: "The agent's project in a line of text (screen readers, a dialog's copy): {value} is its name (\"in hive\"). Lower case." })
}

/**
 * A project's agents (#529): Agent · Role (`role`: the hover's, #1430) · Slot (`place`: the hover's, only when one works
 * outside the project folder, #1442) · State · Card · Waiting for (only when one waits), in lane order (a builder, then
 * its reviewer). `only`: just these agents (ids), as Stop All lists the running ones (#572).
 */
export function projectAgentsData(p: ProjectInfo, tasks: readonly TaskCard[], lanes: readonly TableLane[], only?: readonly string[], opts: { role?: boolean; place?: boolean; connections?: ConnectionsView | null } = {}): AgentTableData {
  const rows = laneOrder(p.agents, lanes)
    .filter((a) => !only || only.includes(a.id))
    .map((a) => ({ a, ...agentRow(p, a, tasks) }))
  const waits = rows.some((r) => r.waits)
  const role = !!opts.role
  const place = !!opts.place && rows.some(({ a }) => placeText(a.place))
  // Each one's connection (HI-1769), where any agent here has one shown (Connections on, a CLI with them).
  const connection = (a: ProjectInfo['agents'][number]): string | null => connectionCellText(a.connection, agentProviderOf(a), a.live?.launchedConnection, opts.connections ?? null)
  const conn = !!opts.connections && rows.some(({ a }) => connection(a) !== null)
  return {
    columns: [...(role ? [ROLE_COLUMN] : []), ...(conn ? [CONNECTION_COLUMN] : []), ...(place ? [SLOT_COLUMN] : []), STATE_COLUMN, CARD_COLUMN, ...(waits ? [WAITING_COLUMN] : [])],
    rows: rows.map(({ a, state, card, waits: w }) => ({ key: a.id, name: a.name, dot: a.live?.status ?? 'stopped', off: !a.live, cells: [...(role ? [{ text: tr(WORKFLOW_ROLE_TEXT[agentWorkflowRole(a)].name) }] : []), ...(conn ? [{ text: connection(a) ?? '' }] : []), ...(place ? [{ text: placeText(a.place) ?? '' }] : []), { text: state }, { text: card }, ...(waits ? [{ text: w }] : [])] }))
  }
}

/** A project's agents as a table (#529), for a tooltip (`projectAgentsData`), with their roles in the workflow (#1430). */
export function AgentsTable({ project, tasks, lanes }: { project: ProjectInfo; tasks: readonly TaskCard[]; lanes: readonly TableLane[] }) {
  const connections = useConnections()
  return <AgentRowsTable {...projectAgentsData(project, tasks, lanes, undefined, { role: true, place: true, connections })} />
}

/**
 * Start New (All), Archive and Start New (All) and Remove All's agents (#572): Agent · State · Card · Worktree (its
 * branch; Remove All's says whether the box can delete it) · What happens (stopped first when it runs, in the warning
 * colour when that interrupts something), in the project's order.
 */
export function batchAgentsData(p: ProjectInfo, tasks: readonly TaskCard[], kind: BatchKind, agents: readonly Agent[], check?: (agentId: string) => BatchWorktree['check']): AgentTableData {
  // Agents still in their 0.9 worktrees (#1442: a project not migrated yet): Remove All says whether it can delete each.
  const trees = agents.some((a) => legacyOf(a))
  const rows = agents.map((a): AgentTableRow => {
    const r = agentRow(p, a, tasks)
    const outcome = batchOutcome(kind, a)
    const own = legacyOf(a)
    const tree = own ? (kind === 'remove' ? removeWorktreeText({ branch: own.branch, check: check?.(a.id) }) : own.branch) : ''
    return { key: a.id, name: a.name, dot: a.live?.status ?? 'stopped', off: !a.live, cells: [{ text: r.state }, { text: r.card }, ...(trees ? [{ text: tree }] : []), { text: outcome.text, warn: outcome.warn }] }
  })
  const worktree: AgentColumn = {
    label: msg({ id: 'panes.table.worktree', defaultMessage: 'Worktree', description: "An agents table's column heading (Start New All, Remove All…): the agent's worktree branch." }),
    cell: msg({ id: 'panes.table.worktreePrefix', defaultMessage: 'worktree {value}', description: "The agent's worktree in a line of text (screen readers, a dialog's copy): {value} is its branch (\"cw/b1\"). Lower case." })
  }
  const happens: AgentColumn = { label: msg({ id: 'panes.table.happens', defaultMessage: 'What happens', description: "An agents table's column heading (Start New All, Remove All…): what the action does to each agent." }) }
  return { columns: [STATE_COLUMN, CARD_COLUMN, ...(trees ? [worktree] : []), happens], rows }
}

/**
 * Agents in a dialog (#572): the table to see, hidden from screen readers, and its plain text (`tableText`, every cell
 * it shows) for them instead; a note under it.
 */
export function AgentsDetail({ data, note }: { data: AgentTableData; note?: string }) {
  return (
    <div className="agents-detail">
      <div aria-hidden="true">
        <AgentRowsTable {...data} />
      </div>
      <div className="visually-hidden">{tableText(data)}</div>
      {note && <div className="agents-detail-note">{note}</div>}
    </div>
  )
}

/** The table for one project, reading the board and the lanes itself (the project header's status, shown on hover). */
export function ProjectAgentsTable({ project }: { project: ProjectInfo }) {
  const tasks = useStore((s) => s.tasks)
  const lanes = useLanes(false)
  return <AgentsTable project={project} tasks={tasks} lanes={lanes.filter((l) => l.project.toLowerCase() === project.path.toLowerCase())} />
}

/** The project's agents as text (`agentsText`), for a trigger's accessible description where the board isn't at hand ('' without a project). */
export function useAgentsText(project: ProjectInfo | null): string {
  const lanes = useLanes(false)
  const path = project?.path.toLowerCase()
  const mine = useMemo(() => lanes.filter((l) => l.project.toLowerCase() === path), [lanes, path])
  return useStore((s) => (project ? agentsText(project, s.tasks, mine) : ''))
}
