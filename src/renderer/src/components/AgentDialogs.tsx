import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AGENT_LIMIT_MAX, OPEN_WORKFLOW_OPTIONS, ROLE_MAX, agentLimitText, mergeBlocked, projectAgents, transcriptWarnLimit } from '@shared/defaults'
import { handOverNow, onRunningLane } from '@shared/handOver'
import { useAgentLimit } from '../advanced'
import { PROVIDERS, agentProvider, autoProvider, isProviderEnabled, providerDescriptor } from '@shared/providers'
import type { BranchQueueCard } from '@shared/workflow/queue'
import type { MergeBranch } from '@shared/types'
import type { AgentBranchStatus, AgentPatch, MergeResult, ProviderId } from '@shared/types'
import { serverAddedIn } from '@shared/agentMcp'
import { agentNameProblem, nameTaken, nameTakenMessage, sameAgentName, suggestAgentName, workspaceAgentList } from '@shared/agentNames'
import type { TemplateAgent } from '@shared/templates'
import { agentWorkflowRole, ROLE_IN_WORKFLOW, ROLE_NEEDS_TOOLS, WORKFLOW_ROLE_TEXT, WORKFLOW_ROLES, type WorkflowRole } from '@shared/workflow/roles'
import { launchesWithoutTools } from '@shared/launchPolicy'
import { confirmIndependent } from './LaunchSettings'
import { gitFixText, gitProblemText } from '@shared/gitTool'
import * as actions from '../actions'
import { agentFolder, awayFromProject, legacyOf, placeText } from '../agentPlace'
import { call, errorMessage } from '../api'
import { offered as opOffered, repoOp } from '../repoOps'
import { projectMergeChoice } from '../mergeChoice'
import { agentProviderOf, bumpUnused, choose as askChoice, confirm, focusAfterRemoving, notify, openVersionControl, projectKey, set, setActivity, showAgent, useLanguage, useStore } from '../store'
import { fmt, msg, tr, tRich } from '@shared/i18n'
import { ProviderIcon } from './ProviderIcon'
import { cliReadyOf, ConnectionChoice, connectionCli, firstReadyConnection, noAccountHere, noAccountText, offeredConnections, useConnections } from './ConnectionChoice'
import { ConnectionDialog } from './ConnectionDefaults'
import { cx } from '../util'
import { formatSize } from '@shared/units'
import { MergeSlotNote, projectSlots, useMergeSlots } from './MergeSlots'
import { confirmLineMerge, LineCardNote, QUEUE_MERGES, QueueCardNote } from './BranchMerge'
import { pasteIntoTerminal } from './TerminalView'
import { BusyButton, Icon, Modal, Tooltip, useBusy } from './ui'

/** Markup in messages (tRich): <code> and <b>, keyed by their text. */
const CODE = (chunks: ReactNode[]): ReactNode => <code key={String(chunks)}>{chunks}</code>
const BOLD = (chunks: ReactNode[]): ReactNode => <strong key={String(chunks)}>{chunks}</strong>

// Words several dialogs here use (#800): messages as data, shown with tr().
const CANCEL = msg({ id: 'agents.dialog.cancel', defaultMessage: 'Cancel', description: "Button: closes an agent dialog without changing anything." })
const NAME = msg({ id: 'agents.dialog.name', defaultMessage: 'Name', description: "Label of an agent's name (Add Agent, Agent Settings)." })
const CODING_AGENT = msg({ id: 'agents.dialog.codingAgent', defaultMessage: 'Coding agent', description: 'A heading in Add Agent and Agent Settings, above the choice of provider (Claude Code, Codex, GitHub Copilot).' })
const NOTE = msg({ id: 'agents.settings.note', defaultMessage: 'Note', description: "Label of an agent's note (Agent Settings): what it is for, in the user's own words. Not its role in the workflow, which is a separate choice." })
const NOTE_NONE = msg({ id: 'agents.settings.noteNone', defaultMessage: 'Optional: what it is for, in your words', description: "Placeholder of an agent's empty note (Agent Settings)." })
const MCP_SERVERS = msg({ id: 'agents.dialog.mcpServers', defaultMessage: 'MCP servers', description: "A heading in Agent Settings, above the agent's MCP servers." })
const WORKS_IN = msg({ id: 'agents.dialog.worksIn', defaultMessage: 'Works in', description: 'Label of where an agent works (Agent Settings): its slot, its worktree from before 1.0, or the project folder.' })
const PROJECT_FOLDER = msg({ id: 'agents.dialog.projectFolder', defaultMessage: 'The project folder', description: "Where an agent works: the project's own folder (not a worktree)." })
const MERGE = msg({ id: 'agents.dialog.merge', defaultMessage: 'Merge', description: "The Merge dialog's button, and its choice of a git merge (not a squash). Keep it short." })
const BUSY_AGENT = msg({ id: 'agents.dialog.busy', defaultMessage: 'Busy. Choose it once it has finished.', description: 'Under an agent in the Continue with… dialog: it is working, so it can\'t be chosen now.' })

/** Which provider an agent runs: enabled providers, with what each still needs (install, sign-in). */
export function ProviderChoice({ value, current, onChange }: { value: ProviderId; current?: ProviderId; onChange: (v: ProviderId) => void }) {
  useLanguage()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  // In Combwork's order (HI-2139), the one Automatic picks first among them.
  const shown = PROVIDERS.filter((p) => isProviderEnabled(settings, p.id) || p.id === value || p.id === current)
  if (!shown.length) {
    return (
      <div className="muted">
        {tr(msg({ id: 'agents.choice.noneOn', defaultMessage: 'No providers are turned on.', description: 'The Coding agent choice (Add Agent, Agent Settings) when no provider (CLI) is turned on. A link to Settings follows.' }))}{' '}
        <a
          onClick={() => {
            set({ addAgentFor: null, agentSettingsFor: null, settingsSection: 'providers', settingsQuery: '' })
            setActivity('settings')
          }}
        >
          {tr(msg({ id: 'agents.choice.chooseOne', defaultMessage: 'Choose one in Settings → Providers', description: 'Link under "No providers are turned on.": opens Settings → Providers. Use those translated names.' }))}
        </a>
      </div>
    )
  }
  return (
    <div className="provider-choice">
      {shown.map((p) => {
        const info = providers[p.id]
        const off = !isProviderEnabled(settings, p.id)
        const issue = off ? tr(msg({ id: 'agents.choice.turnedOff', defaultMessage: 'Turned off in Settings', description: 'Under a provider in the Coding agent choice: it is turned off in Settings → Providers.' })) : !info?.found ? tr(msg({ id: 'agents.choice.notInstalled', defaultMessage: 'Not installed', description: "Under a provider in the Coding agent choice: its CLI isn't installed." })) : info.readiness?.find((r) => r.level === 'error')?.message
        return (
          <label key={p.id} className={cx('choice', value === p.id && 'selected', off && 'disabled')}>
            <input type="radio" disabled={off} checked={value === p.id} onChange={() => onChange(p.id)} />
            <ProviderIcon provider={p.id} />
            <div>
              <strong>{p.name}</strong>
              <div className="faint">{issue ?? `${info?.version ?? ''}`}</div>
            </div>
          </label>
        )
      })}
    </div>
  )
}

/**
 * Role in the workflow (#1430): builder, reviewer or either, each with a sentence. On a connection that launches without
 * Combwork's tools (HI-2670, `toolsOff`), Independent is the only choice: the others greyed out, saying why.
 */
function WorkflowRoleChoice({ value, onChange, toolsOff = false }: { value: WorkflowRole; onChange: (v: WorkflowRole) => void; toolsOff?: boolean }) {
  useLanguage()
  const shown: WorkflowRole = toolsOff ? 'independent' : value
  return (
    <>
      <h3 className="agent-dialog-h" id="agent-workflow-role">
        {tr(ROLE_IN_WORKFLOW)}
      </h3>
      <div className="workflow-role">
        <div className="workflow-role-choice" role="radiogroup" aria-labelledby="agent-workflow-role">
          {WORKFLOW_ROLES.map((r) => {
            const off = toolsOff && r !== 'independent'
            return (
              <label key={r} className={cx('choice', shown === r && 'selected', off && 'disabled')} data-workflow-role={r} data-needs-tools={off || undefined} title={off ? tr(ROLE_NEEDS_TOOLS) : undefined}>
                <input type="radio" disabled={off} checked={shown === r} onChange={() => onChange(r)} />
                <div>
                  <strong>{tr(WORKFLOW_ROLE_TEXT[r].name)}</strong>
                  <div className="faint">{off ? tr(ROLE_NEEDS_TOOLS) : tr(WORKFLOW_ROLE_TEXT[r].text)}</div>
                </div>
              </label>
            )
          })}
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Add agent
// ---------------------------------------------------------------------------

/**
 * Add Agent (HI-2108; HI-2105's design): its name, its connection (grouped by account, the first usable in the order of
 * accounts chosen: decision A; New Connection… makes another setup on the chosen one's account), its role, note and MCP
 * servers. No provider, model, effort, mode or context: those are its connection's, and its CLI follows from it.
 */
export function AddAgentDialog() {
  useLanguage()
  const path = useStore((s) => s.addAgentFor)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.addAgentFor) ?? null)
  const settings = useStore((s) => s.settings)
  const workspaceProjects = useStore((s) => s.workspace?.projects)
  const view = useConnections()
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [mcp, setMcp] = useState<string[] | null>(null)
  // Its connection's id; '' until one is chosen (none usable yet: the first usable when it is added).
  const [connection, setConnection] = useState('')
  // Chosen by the user (the first usable isn't put back over it as the list changes).
  const [chosen, setChosen] = useState(false)
  // New Connection…'s account while its dialog is open.
  const [newOn, setNewOn] = useState<string | null>(null)
  const [startNow, setStartNow] = useState(true)
  const [busy, setBusy] = useState(false)
  // The role chosen (#1430); null: the guess from its name, as an agent from before 1.0 reads.
  const [roleChosen, setRoleChosen] = useState<WorkflowRole | null>(null)
  const mcpOffered = useMcpOffered(path)

  useEffect(() => {
    if (!path || !project) return
    const agents = projectAgents(project.config)
    // Unique across the workspace (#702): numbered past every project's names.
    const everyone = workspaceAgentList(useStore.getState().workspace?.projects)
    let n = agents.length + 1
    // A name, kept as the agent's (agents and the Agent API read it): English, as Combwork names agents everywhere.
    const named = (k: number): string => `Agent ${k}` // i18n-ignore: an agent's default name (stored, read by agents)
    while (everyone.some((a) => sameAgentName(a.name, named(n)))) n++
    setName(named(n))
    setNote('')
    setMcp(null)
    setConnection('')
    setChosen(false)
    setNewOn(null)
    setStartNow(true)
    setBusy(false)
    setRoleChosen(null)
    // Only when the dialog opens for a project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // The first usable connection in the order (decision A), until the user chooses one; read again as the list changes.
  // On and installed (decision A, as main's firstUsableAccount): none chosen while detection may still change it.
  const providers = useStore((s) => s.providers)
  const ready = firstReadyConnection(view, settings, cliReadyOf(providers))
  const first = ready.id
  useEffect(() => {
    if (path && !chosen) setConnection(first ?? '')
  }, [path, chosen, first])
  const limit = useAgentLimit(project)

  if (!path || !project || !settings) return null
  const close = (): void => set({ addAgentFor: null })
  // Its connection launches without Combwork's tools (HI-2670): Independent is the only role it can have.
  const toolsOff = launchesWithoutTools(view?.connectionRows.find((c) => c.id === connection))
  const workflowRole = toolsOff ? 'independent' : (roleChosen ?? agentWorkflowRole({ name: name.trim() }))
  const full = project.agents.length >= limit
  // A name another agent of the workspace has (#702): refused, with a free one to use.
  const everyone = workspaceAgentList(workspaceProjects)
  const owner = name.trim() ? nameTaken(name, everyone) : null
  const suggestion = owner ? suggestAgentName(name.trim(), project.name, everyone.map((a) => a.name)) : ''
  // An automatic choice not made yet (HI-2108 round 2): Add waits for one while connections are offered here (still
  // finding which CLIs are installed, or none of theirs is); with none offered at all, main picks as before accounts.
  const unresolved = !connection && offeredConnections(view, settings).length > 0
  const valid = !!name.trim() && !owner && !full && !unresolved
  // No account on here (the Assistant's ask, HI-2108): nothing could start, so a session can't be asked for, saying why.
  const noAccount = noAccountHere(view, settings)
  const choose = (id: string): void => {
    setChosen(true)
    setConnection(id)
  }

  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      const def = await call('agents:add', project.path, {
        name: name.trim(),
        workflowRole,
        ...(note.trim() ? { role: note.trim() } : {}),
        ...(mcp ? { mcpServers: mcp } : {}),
        ...(connection ? { connection } : {})
      })
      await actions.refreshWorkspace()
      close()
      actions.noteManyAgents(project.path)
      const p = useStore.getState().workspace?.projects.find((x) => x.path === project.path)
      // Show the new agent in a pane: a single-pane layout switches to it (in the Tiles view, its tile: #976).
      if (p) showAgent(p, def.id, 'select')
      if (startNow && !noAccount) await actions.newSession(project.path, def.id)
    } catch (e) {
      notify('error', tr(msg({ id: 'agents.add.failed', defaultMessage: 'Could not add agent', description: "An error's title: adding an agent to a project failed." })), errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={tr(msg({ id: 'agents.add.title', defaultMessage: 'Add an agent to {project}', description: 'Title of the Add Agent dialog. {project} is the project.' }), { project: project.name })}
      icon="person-add"
      onClose={close}
      wide
      footer={
        <>
          <label className="flex muted" style={{ marginRight: 'auto' }} title={noAccount ? noAccountText(view, providers) : undefined} data-start-now={noAccount ? 'no-account' : undefined}>
            <input type="checkbox" className="checkbox" checked={startNow && !noAccount} disabled={noAccount} aria-description={noAccount ? noAccountText(view, providers) : undefined} onChange={(e) => setStartNow(e.target.checked)} /> {tr(msg({ id: 'agents.add.startNow', defaultMessage: 'Start a session now', description: 'Checkbox in the Add Agent dialog: start the new agent at once.' }))}
            {noAccount && <span className="faint" data-start-now-why> — {tr(msg({ id: 'agents.add.noAccountStart', defaultMessage: 'No account is on here yet', description: "After Add Agent's \"Start a session now\", greyed out (HI-2127): why it can't start a session: no account (a sign-in or server a coding agent CLI uses) is on in this workspace. The agent can still be added, for later. Short." }))}</span>}
          </label>
          <button className="btn subtle" onClick={close}>
            {tr(CANCEL)}
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={() => void add()}>
            <Icon name={busy ? 'loading' : 'add'} spin={busy} /> {tr(msg({ id: 'agents.add.add', defaultMessage: 'Add Agent', description: 'The Add Agent dialog\'s button: adds the agent.' }))}
          </button>
        </>
      }
    >
      {full &&
        (limit < AGENT_LIMIT_MAX ? (
          // At its Maximum agents (HI-2058): raised in Version Control → Workflow, which the link opens.
          <div className="banner warn" data-limit="workflow">
            <span>{agentLimitText(tr, limit)}</span>{' '}
            <button className="btn small" onClick={() => (close(), openVersionControl(project.path, 'workflow'))}>
              {tr(OPEN_WORKFLOW_OPTIONS)}
            </button>
          </div>
        ) : (
          <div className="banner warn">{tr(msg({ id: 'agents.add.full', defaultMessage: '{limit} Remove one first.', description: "The Add Agent dialog when the project has as many agents as it may: why ({limit}, a sentence), then what to do." }), { limit: agentLimitText(tr) })}</div>
        ))}
      <div className="agent-form">
        <label>{tr(NAME)}</label>
        <input
          className="input"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        {owner && (
          <div className="field-error span2" data-name-taken>
            {owner.project === project.name
              ? tr(msg({ id: 'agents.add.nameTakenHere', defaultMessage: '{project} already has an agent called {agent}.', description: 'Under the name in the Add Agent dialog: an agent of this project ({project}) has that name ({agent}).' }), { project: project.name, agent: owner.name })
              : tr(msg({ id: 'agents.add.nameTaken', defaultMessage: '{project} already has an agent called {agent}: agent names are unique across the workspace.', description: 'Under the name in the Add Agent dialog: an agent of another project ({project}) has that name ({agent}).' }), { project: owner.project, agent: owner.name })}{' '}
            <a onClick={() => setName(suggestion)}>{tr(msg({ id: 'agents.add.useSuggestion', defaultMessage: 'Use {name}', description: 'Link after a taken name in the Add Agent dialog: uses a free name ({name}) instead.' }), { name: suggestion })}</a>
          </div>
        )}
        {/* Its connection holds its model, effort, context and mode; its CLI follows from it (HI-2108). */}
        <ConnectionChoice id="add-agent-connection" value={connection} onChange={choose} onNew={setNewOn} />
        {!connection && ready.checking && (
          <div className="hint span2" data-connection-checking>
            <Icon name="loading" spin /> {tr(msg({ id: 'agents.add.checkingConnection', defaultMessage: 'Finding out which coding agents are installed, to choose the first connection that can run…', description: 'Under the choice of connection in Add Agent (HI-2108) while Combwork still looks for the installed coding agent CLIs: the first usable connection is chosen once it knows; Add waits until then.' }))}
          </div>
        )}
        <label htmlFor="add-agent-note">{tr(NOTE)}</label>
        <input id="add-agent-note" className="input" value={note} maxLength={ROLE_MAX} placeholder={tr(NOTE_NONE)} list="add-agent-note-suggestions" onChange={(e) => setNote(e.target.value)} />
        <datalist id="add-agent-note-suggestions">
          {roleSuggestions(project.agents).map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </div>
      <WorkflowRoleChoice value={workflowRole} onChange={setRoleChosen} toolsOff={toolsOff} />
      <h3 className="agent-dialog-h">{tr(MCP_SERVERS)}</h3>
      <McpChoice value={mcp} offered={mcpOffered} where="project" onChange={setMcp} />
      <h3 className="agent-dialog-h">{tr(msg({ id: 'agents.add.where', defaultMessage: 'Where it works', description: 'A heading in the Add Agent dialog, above where the new agent works.' }))}</h3>
      <div className="faint agent-dialog-note" data-where-note>
        {tr(msg({ id: 'agents.add.whereNote', defaultMessage: "In the project folder. A builder takes one of the project's slots for each card it builds and works there until the card is done; Version Control → Branches & remotes lists them.", description: "The Add Agent dialog, under Where it works: agents have no worktree of their own (1.0); a builder works in a slot (a working folder Combwork lends to a card) while it builds a card. Version Control → Branches & remotes: use their translated names. Glossary: slot." }))}
      </div>
      {newOn && (
        <ConnectionDialog
          account={newOn}
          projectPath={path}
          onClose={(saved) => {
            setNewOn(null)
            if (saved) choose(saved.id)
          }}
        />
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Agent settings
// ---------------------------------------------------------------------------

/** Notes to suggest (#126): those the agents already have (a project's, or a template's). */
function roleSuggestions(agents: readonly { role?: string }[]): string[] {
  const out: string[] = []
  for (const a of agents) if (a.role && !out.some((r) => r.toLowerCase() === a.role!.toLowerCase())) out.push(a.role)
  return out
}

/** What the Agent Settings dialog edits: a project's agent, or a template's (#271), alike. */
interface AgentFields {
  name: string
  /** The agent's note (`AgentDef.role`, #126: free text). */
  role: string
  /** Its role in the workflow (#1430; a template's agent's too, #1436). */
  workflowRole: WorkflowRole
  /** A template's agent: the CLI it suggests (HI-2109's decision G). A project's agent: its CLI, its connection's. */
  provider: ProviderId
  /** Only these of the project's MCP servers (#537); null: all of them. */
  mcp: string[] | null
  /** The connection it runs on (HI-2108): its id. A template's agent has none. */
  connection: string
  /** Its Dialect setting (HI-2444): a file of its CLI's dialects folder, '' for Auto. A template's agent has none. */
  dialect?: string
}

const DIALECT = {
  label: msg({ id: 'agents.dialect.label', defaultMessage: 'Dialect', description: "Agent Settings (HI-2444): the choice of the dialect file that fills the agent's model slot. Glossary: dialect." }),
  auto: msg({ id: 'agents.dialect.auto', defaultMessage: 'Auto (the file for the model it runs)', description: "Agent Settings' Dialect choice: Combwork picks the model file whose model ID is the one the agent runs. Glossary: dialect." }),
  model: msg({ id: 'agents.dialect.model', defaultMessage: '{name} (model {model})', description: "Agent Settings' Dialect choice: a model file, {name}, for model ID {model}. Glossary: dialect." }),
  copy: msg({ id: 'agents.dialect.copy', defaultMessage: '{name} (test copy)', description: "Agent Settings' Dialect choice: a test copy (a dialect file with no model), {name}, for trying wording on one agent. Glossary: test copy." }),
  missing: msg({ id: 'agents.dialect.missing', defaultMessage: '{path} (not there: Auto is used)', description: "Agent Settings' Dialect choice: the file chosen before is gone, so the agent uses Auto. {path} is its path. Glossary: dialect." }),
  hint: msg({ id: 'agents.dialect.hint', defaultMessage: "Which dialect file adjusts the wording Combwork gives this agent, over its CLI's and the workspace's. Pick a test copy to try a change on this agent alone.", description: "Under Agent Settings' Dialect choice (HI-2444). Glossary: dialect, test copy." })
}

/** Agent Settings' Dialect (HI-2444): Auto, or a file of the agent's CLI folder, read from the workspace's dialects. */
function DialectChoice({ cli, value, onChange }: { cli: ProviderId; value: string; onChange: (v: string) => void }) {
  const version = useStore((s) => s.dialectsVersion)
  const [choices, setChoices] = useState<{ path: string; name: string; model?: string }[] | null>(null)
  useEffect(() => {
    let live = true
    call('dialects:choices', cli)
      .then((c) => live && setChoices(c))
      .catch(() => live && setChoices([]))
    return () => {
      live = false
    }
  }, [cli, version])
  const known = !value || !choices || choices.some((c) => c.path === value)
  return (
    <>
      <label htmlFor="agent-dialect">{tr(DIALECT.label)}</label>
      <select id="agent-dialect" className="input" data-agent-dialect value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{tr(DIALECT.auto)}</option>
        {(choices ?? []).map((c) => (
          <option key={c.path} value={c.path}>
            {c.model ? tr(DIALECT.model, { name: c.name, model: c.model }) : tr(DIALECT.copy, { name: c.name })}
          </option>
        ))}
        {!known && <option value={value}>{tr(DIALECT.missing, { path: value })}</option>}
      </select>
      <div className="hint span2">{tr(DIALECT.hint)}</div>
    </>
  )
}

/**
 * The MCP servers an agent can be given (#537): those added to the project (`projectPath`, HI-2059), or for a template's
 * agent (null), which may be loaded anywhere, every server the workspace has. Null until they are read.
 */
function useMcpOffered(projectPath: string | null): string[] | null {
  const version = useStore((s) => s.skillsVersion)
  const [list, setList] = useState<string[] | null>(null)
  const key = projectPath ?? ''
  useEffect(() => {
    let live = true
    call('mcp:list')
      .then((l) => live && setList(l.filter((m) => (key ? serverAddedIn(m, key) : !!m.def)).map((m) => m.name)))
      .catch(() => live && setList([]))
    return () => {
      live = false
    }
  }, [version, key])
  return list
}

/**
 * Which of the project's MCP servers the agent gets (#537): all of them (the default) or only those ticked. Choosing
 * Only these starts with every server offered ticked, so nothing changes until one is unticked. A name chosen that isn't
 * offered here stays listed, ticked, so saving keeps it.
 */
function McpChoice({ value, offered, where, onChange }: { value: string[] | null; offered: string[] | null; where: 'project' | 'workspace'; onChange: (v: string[] | null) => void }) {
  const names = [...(offered ?? []), ...(value ?? []).filter((n) => !offered?.includes(n))]
  return (
    <div className="mcp-choice">
      <div className="segmented works-in" role="radiogroup" aria-label={tr(MCP_SERVERS)}>
        <button type="button" role="radio" aria-checked={value === null} className={cx(value === null && 'active')} onClick={() => onChange(null)}>
          {tr(msg({ id: 'agents.mcp.all', defaultMessage: "All of the project's", description: "A choice of an agent's MCP servers (Agent Settings): every MCP server added to its project. Keep it short." }))}
        </button>
        <button type="button" role="radio" aria-checked={value !== null} className={cx(value !== null && 'active')} disabled={value === null && offered === null} onClick={() => value === null && offered && onChange(offered)}>
          {tr(msg({ id: 'agents.mcp.only', defaultMessage: 'Only these', description: "A choice of an agent's MCP servers (Agent Settings): only the ones ticked below. Keep it short." }))}
        </button>
      </div>
      {value !== null &&
        (offered === null ? (
          <p className="hint">
            <Icon name="loading" spin /> {tr(msg({ id: 'agents.mcp.loading', defaultMessage: 'Loading…', description: "Agent Settings while the list of MCP servers is read." }))}
          </p>
        ) : names.length === 0 ? (
          <p className="hint">{tr(msg({ id: 'agents.mcp.noneAdded', defaultMessage: '{where, select, workspace {This workspace has no MCP servers: it gets none.} other {No MCP servers are added to this project: it gets none.}}', description: "Agent Settings, Only these, when no MCP server is added where the agent is (its project, HI-2059), or, for a template's agent, the workspace has none." }), { where })}</p>
        ) : (
          <div className="choice-list" role="group" aria-label={tr(msg({ id: 'agents.mcp.its', defaultMessage: 'Its MCP servers', description: "Accessible name of the list of MCP servers to tick for an agent (Agent Settings)." }))}>
            {names.map((n) => (
              <label key={n} className="flex">
                <input type="checkbox" className="checkbox" checked={value.includes(n)} onChange={(e) => onChange(e.target.checked ? [...value, n] : value.filter((x) => x !== n))} /> {n}
                {!offered.includes(n) && <span className="faint">{tr(msg({ id: 'agents.mcp.notAdded', defaultMessage: '{where, select, workspace {not in this workspace} other {not added to this project}}', description: "After an MCP server the agent was given that isn't added to its project now (HI-2059), or isn't in the workspace. Lower case." }), { where })}</span>}
              </label>
            ))}
          </div>
        ))}
      <div className="faint">{tr(msg({ id: 'agents.mcp.noteAdded', defaultMessage: 'The built-in combwork server is always given. A server added to the project later reaches it only with All.', description: "Under an agent's MCP servers (Agent Settings). combwork is the built-in server's name: keep it. All is the first choice above (\"All of the project's\")." }))}</div>
    </div>
  )
}

/**
 * The Agent Settings dialog (#126, #271; HI-2108): name, note, where it works, role in the workflow, its connection (with
 * a summary of its values) and MCP servers (#537: those added to the project, `mcpProject` its path, HI-2059, or every
 * server of the workspace for a template's agent, null; `mcpWhere` says where they are added, in words).
 * `works`: what the agent works in (a project's agent; a template's has none, #1436). `cliLocked`: the CLI a running
 * agent's connection must stay on, and why (another CLI's connection only while it is stopped). `suggestOnly`: a
 * template's agent (HI-2109): no connection, but the CLI it suggests. `nameProblem`: why a name can't be used.
 * `confirmSave`: asked first (false keeps it open); `save` runs with the dialog open, a failure staying in it.
 */
function AgentSettingsModal({
  title,
  resetKey,
  initial,
  roles,
  works,
  mcpProject,
  mcpWhere,
  cliLocked,
  suggestOnly,
  dialectCli,
  note,
  nameProblem,
  confirmSave,
  save,
  onClose
}: {
  title: string
  resetKey: string
  initial: AgentFields
  roles: string[]
  works?: ReactNode
  mcpProject: string | null
  mcpWhere: 'project' | 'workspace'
  cliLocked?: { cli: ProviderId; why: ReactNode }
  suggestOnly?: boolean
  /** A project's agent: the CLI whose dialect files its Dialect setting offers (HI-2444); none for a template's agent. */
  dialectCli?: ProviderId
  note?: ReactNode
  nameProblem?: (name: string) => string | null
  confirmSave?: (f: AgentFields) => Promise<boolean>
  save: (f: AgentFields) => Promise<void>
  onClose: () => void
}) {
  useLanguage()
  const [f, setF] = useState<AgentFields>(initial)
  const action = useBusy()
  // New Connection…'s account while its dialog is open.
  const [newOn, setNewOn] = useState<string | null>(null)
  // Read as the dialog opens (the dialogs stay mounted while closed, and the workspace may have changed).
  const mcpOffered = useMcpOffered(mcpProject)
  // Its connection launches without Combwork's tools (HI-2670): Independent is its only role while it is on it.
  const connections = useConnections()
  const toolsOff = !suggestOnly && launchesWithoutTools(connections?.connectionRows.find((c) => c.id === f.connection))
  useEffect(() => {
    action.setError(null)
    setF(initial)
    setNewOn(null)
    // Reset when another agent's dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])
  const put = (patch: Partial<AgentFields>): void => setF((x) => ({ ...x, ...patch }))
  const problem = agentNameProblem(f.name, tr) ?? (nameProblem?.(f.name.trim()) ?? null)
  const submit = async (): Promise<void> => {
    if (problem) return
    if (confirmSave && !(await confirmSave(f))) return
    if (await action.run('save', () => save(f))) onClose()
  }
  const enter = (e: React.KeyboardEvent): void => void (e.key === 'Enter' && submit())
  return (
    <Modal
      title={title}
      icon="settings"
      onClose={onClose}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>
            {tr(CANCEL)}
          </button>
          <BusyButton className="primary" disabled={!!problem} busy={action.busy === 'save'} busyLabel={tr(msg({ id: 'agents.settings.saving', defaultMessage: 'Saving…', description: "Agent Settings' Save button while it saves." }))} onClick={() => void submit()}>
            {tr(msg({ id: 'agents.settings.save', defaultMessage: 'Save', description: "Agent Settings' button: saves the agent's settings." }))}
          </BusyButton>
        </>
      }
    >
      <div className="agent-form">
        <label>{tr(NAME)}</label>
        <input className="input" aria-label={tr(NAME)} value={f.name} maxLength={60} autoFocus onChange={(e) => put({ name: e.target.value })} onKeyDown={enter} />
        {problem && f.name.trim() && <div className="field-error span2">{problem}</div>}
        {/* A note on what the agent is for, saved in templates (#126): free text, suggesting the agents' own. Its role in the workflow is apart (#1430). */}
        <label htmlFor="agent-role">{tr(NOTE)}</label>
        <input id="agent-role" className="input" value={f.role} maxLength={ROLE_MAX} placeholder={tr(NOTE_NONE)} list="agent-role-suggestions" onChange={(e) => put({ role: e.target.value })} onKeyDown={enter} />
        <datalist id="agent-role-suggestions">
          {roles.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        {works !== undefined && (
          <>
            <label>{tr(WORKS_IN)}</label>
            <div className="muted">{works}</div>
          </>
        )}
        {/* Its connection holds its model, effort, context and mode; its CLI follows from it (HI-2108). */}
        {!suggestOnly && <ConnectionChoice id="agent-connection" value={f.connection} cli={cliLocked?.cli} onChange={(connection) => put({ connection })} onNew={setNewOn} />}
        {!suggestOnly && cliLocked && <div className="hint span2" data-cli-locked>{cliLocked.why}</div>}
        {dialectCli && <DialectChoice cli={dialectCli} value={f.dialect ?? ''} onChange={(dialect) => put({ dialect })} />}
      </div>
      <WorkflowRoleChoice value={f.workflowRole} onChange={(workflowRole) => put({ workflowRole })} toolsOff={toolsOff} />
      {suggestOnly && (
        <>
          <h3 className="agent-dialog-h">{tr(CODING_AGENT)}</h3>
          <ProviderChoice value={f.provider} current={initial.provider} onChange={(provider) => put({ provider })} />
        </>
      )}
      <h3 className="agent-dialog-h">{tr(MCP_SERVERS)}</h3>
      <McpChoice value={f.mcp} offered={mcpOffered} where={mcpWhere} onChange={(mcp) => put({ mcp })} />
      {note && <div className="detail">{note}</div>}
      {newOn && (
        <ConnectionDialog
          account={newOn}
          projectPath={mcpProject}
          onClose={(saved) => {
            setNewOn(null)
            if (saved) put({ connection: saved.id })
          }}
        />
      )}
    </Modal>
  )
}

export function AgentSettingsDialog() {
  useLanguage()
  const target = useStore((s) => s.agentSettingsFor)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.agentSettingsFor?.project) ?? null)
  const agent = project?.agents.find((a) => a.id === target?.agentId) ?? null
  const settings = useStore((s) => s.settings)
  const projects = useStore((s) => s.workspace?.projects)
  const view = useConnections()
  // What the user confirmed this save takes out of the workflow (HI-2670: agents:impact's fingerprint), for main to check.
  const confirmed = useRef<string | null>(null)
  if (!target || !project || !agent) return null
  // Another agent of the workspace's name (#702); its own name stays, even one it shares from before names were unique.
  const nameProblem = (n: string): string | null => {
    if (sameAgentName(n, agent.name)) return null
    const everyone = workspaceAgentList(projects)
    const owner = nameTaken(n, everyone, { project: project.name, id: agent.id })
    return owner ? nameTakenMessage(n, owner, suggestAgentName(n, project.name, everyone.map((a) => a.name)), tr) : null
  }
  const current = agent.live?.provider ?? agentProvider(agent, settings)
  const close = (): void => set({ agentSettingsFor: null })
  const own = legacyOf(agent)
  // Its role as it reads now (the guess, for an agent from before 1.0), stored once the user saves (#1430): its own, not
  // the Independent its connection may make it (HI-2670), which is kept for the connection's tools coming back.
  const initial: AgentFields = { name: agent.name, role: agent.role ?? '', workflowRole: agent.workflowRole ?? agentWorkflowRole({ name: agent.name, role: agent.role }), provider: current, mcp: agent.mcpServers ? [...agent.mcpServers] : null, connection: agent.connection ?? '', dialect: agent.dialect ?? '' }
  // Its role and connection as saved (HI-2670): no role sent while its connection makes it Independent, so its own stays.
  const roleAndConnection = (f: AgentFields): AgentPatch => ({
    ...(launchesWithoutTools(view?.connectionRows.find((c) => c.id === f.connection)) ? {} : { workflowRole: f.workflowRole }),
    ...(f.connection !== initial.connection ? { connection: f.connection || null } : {})
  })
  return (
    <AgentSettingsModal
      title={tr(msg({ id: 'agents.settings.title', defaultMessage: '{agent} settings', description: 'Title of the Agent Settings dialog. {agent} is the agent.' }), { agent: agent.name })}
      resetKey={`${target.project}|${target.agentId}`}
      initial={initial}
      roles={roleSuggestions(project.agents)}
      mcpProject={project.path}
      mcpWhere="project"
      dialectCli={current}
      works={
        // Where it works now (#1442): its 0.9 worktree, a slot, carried slot or home, or the project folder.
        own ? (
          <>
            {tRich<ReactNode>(msg({ id: 'agents.settings.worktreeOn', defaultMessage: 'Worktree on <code>{branch}</code> (from {base})', description: "Where an agent works (Agent Settings): its worktree's branch ({branch}) and the branch it started from ({base}). Keep the <code> tags." }), { branch: own.branch, base: own.base, code: CODE })}
            <div className="faint">{own.path}</div>
          </>
        ) : placeText(agent.place) ? (
          <>
            {placeText(agent.place)}
            <div className="faint">{agentFolder(agent)}</div>
          </>
        ) : (
          tr(PROJECT_FOLDER)
        )
      }
      cliLocked={agent.live ? { cli: current, why: tr(msg({ id: 'agents.settings.otherCliStopped', defaultMessage: "Another CLI's connection can be chosen once {agent} is stopped: its conversations stay with {cli}.", description: "Under the connection in Agent Settings of a running agent ({agent}) (HI-2108): only its own CLI's ({cli}: \"Claude Code\") connections are offered while it runs." }), { agent: agent.name, cli: providerDescriptor(current).name }) } : undefined}
      note={agent.live ? tr(msg({ id: 'agents.settings.appliesNext', defaultMessage: 'Changes apply the next time {agent} starts; the running session keeps its settings until then.', description: 'Under Agent Settings for a running agent ({agent}).' }), { agent: agent.name }) : undefined}
      nameProblem={nameProblem}
      confirmSave={async (f) => {
        // Made Independent while on a lane or holding cards (HI-2670): asked first, naming them.
        confirmed.current = null
        const impact = await call('agents:impact', project.path, agent.id, roleAndConnection(f))
        if (impact) {
          if (!(await confirmIndependent(impact))) return false
          confirmed.current = impact.fingerprint
        }
        // Another CLI's connection is a change of CLI: its conversations can't come along.
        const cli = connectionCli(view, f.connection) ?? current
        if (cli === current) return true
        return confirm({
          title: tr(msg({ id: 'agents.switch.title', defaultMessage: 'Switch {agent} to {cli}?', description: "Title of the confirmation before an agent ({agent}) changes provider ({cli}: the new CLI's name)." }), { agent: agent.name, cli: providerDescriptor(cli).name }),
          message: tr(msg({ id: 'agents.switch.message', defaultMessage: "Its conversations stay in the Sessions tab, but {cli} can't resume {was} conversations, so {agent} starts fresh next time.", description: "The confirmation before an agent ({agent}) changes provider: the new CLI ({cli}) can't resume the old one's ({was}) conversations." }), { agent: agent.name, cli: providerDescriptor(cli).name, was: providerDescriptor(current).name }),
          detail: tr(msg({ id: 'agents.switch.detail', defaultMessage: 'To carry the work over, ask the agent for a handover before switching (Combwork MCP: cw_create_handover), then ask the new agent to read it.', description: 'Under the confirmation before an agent changes provider. cw_create_handover is a tool name: keep it.' })),
          confirmLabel: tr(msg({ id: 'agents.switch.confirm', defaultMessage: 'Switch', description: "Button: changes the agent's provider. Keep it short." }))
        })
      }}
      save={async (f) => {
        await call(
          'agents:update',
          project.path,
          agent.id,
          {
            name: f.name,
            role: f.role,
            mcpServers: f.mcp,
            ...roleAndConnection(f),
            // Its Dialect (HI-2444), when changed: '' is Auto. A change of CLI clears it in main unless one is picked here.
            ...(f.dialect !== initial.dialect ? { dialect: f.dialect || null } : {})
          },
          confirmed.current
        )
        await actions.refreshWorkspace()
        // A new role gives it another side's tools (HI-2664, Darren's decision): restarted to load them, at once if it is
        // idle; busy, asked first (restart when its turn is over, or later: it keeps its old tools until it restarts).
        if (f.workflowRole !== initial.workflowRole) {
          const r = await call('session:restartForTools', project.path, agent.id, 'ifIdle').catch(() => 'same' as const)
          if (r === 'busy') {
            const choice = await askChoice({
              title: tr(msg({ id: 'agents.side.restartTitle', defaultMessage: 'Restart {agent} for its new role?', description: "Title of the question after an agent's workflow role was changed while it is working (HI-2664): it needs a restart to get its new role's tools. {agent} is its name." }), { agent: agent.name }),
              message: tr(msg({ id: 'agents.side.restartMessage', defaultMessage: "{agent} is working. Its new role's tools load when it restarts; it carries on in the same conversation.", description: "The question after an agent's role was changed while it is working (HI-2664). {agent} is its name." }), { agent: agent.name }),
              choices: [
                { label: tr(msg({ id: 'agents.side.restartWhenDone', defaultMessage: 'Restart When Its Turn Is Over', description: 'Button (HI-2664): the agent restarts once its turn is over, in the same conversation, with its new role\'s tools.' })), value: 'restart' },
                { label: tr(msg({ id: 'agents.side.later', defaultMessage: 'Later', description: 'Button (HI-2664): the agent keeps its old tools until it restarts.' })), value: 'later' }
              ]
            })
            if (choice === 'restart') await call('session:restartForTools', project.path, agent.id, 'atSafePoint').catch(() => undefined)
          }
        }
      }}
      onClose={close}
    />
  )
}

/**
 * The same dialog for a template's agent (#271), from the template editor: what it saves goes back to the editor (which
 * saves the template with it, #510). Its role in the workflow and note (#1436), never where it works: that is the card's
 * or lane's. No connection (HI-2109: the user picks connections when loading it), but the CLI it suggests.
 */
/**
 * Busy agents whose tools a workflow change changes (HI-2694, Darren's decision: as a role change, HI-2664): asked once
 * whether to restart them when their turn is over, in the same conversation, or later (they keep their old tools until
 * they restart, and are given no work that needs the new ones meanwhile). Idle ones were restarted already.
 */
export async function askWorkflowToolsRestart(projectPath: string, agents: readonly { id: string; name: string }[]): Promise<void> {
  if (!agents.length) return
  const names = fmt.list(agents.map((a) => a.name))
  const choice = await askChoice({
    title: tr(msg({ id: 'agents.workflowTools.restartTitle', defaultMessage: 'Restart {agents} for the new workflow?', description: "Title of the question after a project's workflow settings changed the Combwork tools of agents that are working (HI-2694): they need a restart to get them. {agents} is their names as a list." }), { agents: names }),
    message: tr(msg({ id: 'agents.workflowTools.restartMessage', defaultMessage: '{count, plural, one {{agents} is working. The tools its project’s workflow now allows load when it restarts; it carries on in the same conversation.} other {{agents} are working. The tools their project’s workflow now allows load when they restart; each carries on in the same conversation.}}', description: "The question after a project's workflow settings changed the Combwork tools of agents that are working (HI-2694). {agents} is their names as a list; {count} how many." }), { agents: names, count: agents.length }),
    choices: [
      { label: tr(msg({ id: 'agents.workflowTools.restartWhenDone', defaultMessage: '{count, plural, one {Restart When Its Turn Is Over} other {Restart When Their Turns Are Over}}', description: 'Button (HI-2694): each agent restarts once its turn is over, in the same conversation, with the tools its new workflow allows.' }), { count: agents.length }), value: 'restart' },
      { label: tr(msg({ id: 'agents.workflowTools.later', defaultMessage: 'Later', description: 'Button (HI-2694): the agents keep their old tools until they restart.' })), value: 'later' }
    ]
  })
  if (choice === 'restart') for (const a of agents) await call('session:restartForTools', projectPath, a.id, 'atSafePoint').catch(() => undefined)
}

export function TemplateAgentDialog() {
  useLanguage()
  const req = useStore((s) => s.templateAgentFor)
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const view = useConnections()
  // The agent as saved, for when the dialog closes (null: cancelled).
  const result = useRef<TemplateAgent | null>(null)
  if (!req) return null
  const a = req.agent
  const close = (answer: TemplateAgent | null): void => {
    set({ templateAgentFor: null })
    req.resolve(answer)
    result.current = null
  }
  // A new one suggests the CLI a new agent gets (decision A): the first usable connection's, as Add Agent's.
  const provider = a?.provider ?? connectionCli(view, firstReadyConnection(view, settings, cliReadyOf(providers)).id) ?? autoProvider(settings)
  const initial: AgentFields = { name: a?.name ?? req.suggestedName, role: a?.note ?? '', workflowRole: a?.role ?? agentWorkflowRole({ name: req.suggestedName }), provider, mcp: a?.mcpServers ? [...a.mcpServers] : null, connection: '' }
  return (
    <AgentSettingsModal
      title={a ? tr(msg({ id: 'agents.template.title', defaultMessage: '{agent} settings (template)', description: "Title of Agent Settings for an agent of a template ({agent}), from the template editor." }), { agent: a.name }) : tr(msg({ id: 'agents.template.new', defaultMessage: 'New agent (template)', description: 'Title of Agent Settings for a new agent of a template, from the template editor.' }))}
      resetKey={`${req.key}`}
      initial={initial}
      roles={roleSuggestions(req.others.map((o) => ({ role: o.note })))}
      mcpProject={null}
      mcpWhere="workspace"
      suggestOnly
      note={tr(msg({ id: 'agents.template.noteSuggest', defaultMessage: 'For the template "{template}": Save saves it in the template. Its coding agent is only a suggestion: the connection each agent runs on is chosen when the template is loaded.', description: "Under Agent Settings for a template's agent (HI-2109): Save (a button) saves it in the template ({template}). A template keeps no connection, model or effort: its coding agent CLI only preselects a connection in the Load template dialog." }), { template: req.template })}
      nameProblem={(n) => (!n.includes('{n}') && req.others.some((o) => o.name.toLowerCase() === n.toLowerCase()) ? tr(msg({ id: 'agents.template.nameTaken', defaultMessage: 'Another agent of the template is called "{name}".', description: "Why a template's agent can't take a name ({name}): another agent of the template has it." }), { name: n }) : null)}
      save={async (f) => {
        const note = f.role.replace(/\s+/g, ' ').trim()
        result.current = {
          name: f.name.replace(/\s+/g, ' ').trim(),
          role: f.workflowRole,
          ...(note ? { note } : {}),
          provider: f.provider,
          ...(f.mcp ? { mcpServers: f.mcp } : {})
        }
      }}
      onClose={() => close(result.current)}
    />
  )
}

// ---------------------------------------------------------------------------
// Hand Over to…
// ---------------------------------------------------------------------------

/**
 * Hands one agent's work to another, of any provider. Conversations can't move between providers,
 * so the source writes a handover (Combwork's cw_create_handover tool) and the target reads it. The agent
 * itself can be the target: it carries on in a new conversation (a long transcript made short again).
 */
export function HandOverDialog() {
  useLanguage()
  const target = useStore((s) => s.handOverFor)
  const settings = useStore((s) => s.settings)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.handOverFor?.project) ?? null)
  const from = project?.agents.find((a) => a.id === target?.agentId) ?? null
  const [to, setTo] = useState('')
  const [handover, setHandover] = useState(true)

  const idle = (a: { live?: { status: string } | null }): boolean => !a.live || a.live.status === 'ready' || a.live.status === 'finished'
  const fromReady = !!from?.live && idle(from)
  // Ending its own conversation only while it may (#1057): not while it merges or is on a running lane's card.
  const lanes = useStore((s) => s.lanes)
  const selfOff = !!target && !!project && !!from && (!idle(from) || !handOverNow(from.live, onRunningLane(lanes, project.name, from.id)))
  useEffect(() => {
    if (!target || !project) return
    setHandover(fromReady)
    const first = project.agents.find((a) => a.id !== target.agentId && idle(a) && isProviderEnabled(settings, agentProviderOf(a)))
    const own = project.agents.find((a) => a.id === target.agentId)
    const mb = own?.live?.transcriptBytes ?? 0
    const limit = transcriptWarnLimit(project.config, settings?.sessions.transcriptWarnMB ?? 0)
    // A long conversation (from its footer or the notification) most likely wants a new one of its own.
    const ownFirst = !!own && !selfOff && limit > 0 && mb >= limit * 1024 * 1024
    setTo(ownFirst ? target.agentId : (first?.id ?? (own && !selfOff ? target.agentId : '')))
    // Again when whether it may end its own conversation changes (the window learns of a lane a moment after Combwork does).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.project, target?.agentId, selfOff])

  if (!target || !project || !from) return null
  const close = (): void => set({ handOverFor: null })
  const others = project.agents.filter((a) => a.id !== from.id)
  const self = to === from.id
  const chosen = self ? from : others.find((a) => a.id === to)
  // Who carries on: the agent itself (self), the chosen one (other), or one not chosen yet (none).
  const who = self ? 'self' : chosen ? 'other' : 'none'
  const names = { from: from.name, other: chosen?.name ?? '', who }
  const combworkTools = settings?.agentApi.provideCombworkMcp !== false

  const go = (): void => {
    if (!chosen) return
    close()
    showAgent(project, chosen.id)
    void call('session:handOver', project.path, from.id, chosen.id, { handover: handover && fromReady }).catch((e) => notify('error', tr(msg({ id: 'agents.handOver.failed', defaultMessage: 'Could not hand over to {agent}', description: "An error's title: handing an agent's work to another ({agent}) failed." }), { agent: chosen.name }), errorMessage(e)))
  }

  return (
    <Modal
      title={tr(msg({ id: 'agents.handOver.title', defaultMessage: "Hand over {agent}'s work to…", description: "Title of the Continue with… dialog: which agent takes over this agent's ({agent}) work." }), { agent: from.name })}
      icon="arrow-swap"
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {tr(CANCEL)}
          </button>
          <button className="btn primary" disabled={!chosen || !combworkTools} onClick={go}>
            <Icon name="arrow-swap" /> {tr(msg({ id: 'agents.handOver.go', defaultMessage: 'Hand Over', description: "The Continue with… dialog's button: hands the work to the chosen agent." }))}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        {tr(msg({ id: 'agents.handOver.intro', defaultMessage: "Another agent picks up the work from a handover. It can use a different provider: the conversation itself stays with {agent}; the handover carries the goal, what's done and the next steps. Or {agent} carries on itself in a new conversation, which keeps a long one from slowing things down.", description: 'At the top of the Continue with… dialog ({agent}: the agent whose work is handed over). A handover is a note an agent writes for the next one.' }), { agent: from.name })}
      </p>
      {!combworkTools && (
        <div className="banner warn">
          <Icon name="warning" /> {tr(msg({ id: 'agents.handOver.needsTools', defaultMessage: 'This needs Combwork\'s tools in sessions. Turn on "Provide Combwork tools to sessions" in Settings → Agent API.', description: "The Continue with… dialog when sessions don't get Combwork's tools: the setting to turn on (its name in quotes, and where: use their translated names)." }))}
        </div>
      )}
      <div className="choice-list">
        <label className={cx('choice', self && 'selected', selfOff && 'disabled')}>
          <input type="radio" disabled={selfOff} checked={self} onChange={() => setTo(from.id)} />
          <div>
            <strong>
              <ProviderIcon provider={agentProviderOf(from)} /> {tr(msg({ id: 'agents.handOver.self', defaultMessage: '{agent}, in a new conversation', description: 'A choice in the Continue with… dialog: the agent itself ({agent}) carries on in a new conversation.' }), { agent: from.name })}
            </strong>
            <div className="faint">
              {!idle(from)
                ? tr(BUSY_AGENT)
                : selfOff
                  ? tr(msg({ id: 'agents.handOver.selfLater', defaultMessage: "It merges or is on a card loop's card: it can carry on in a new conversation when it has finished.", description: "Under the agent's own choice (disabled) in the Continue with… dialog: it holds the merge slot or works on a running card loop's card." }))
                  : tr(msg({ id: 'agents.handOver.selfNote', defaultMessage: 'Its conversation ends here (it stays in the Sessions tab) and a new one continues from the handover.{size, select, none {} other { Its transcript is {size}.}}', description: "Under the agent's own choice in the Continue with… dialog; then how big its conversation's file is ({size}: \"6.1 MB\"; none: leave that branch empty)." }), { size: from.live?.transcriptBytes ? formatSize(from.live.transcriptBytes) : 'none' })}
            </div>
          </div>
        </label>
        {others.map((a) => {
          const p = agentProviderOf(a)
          const enabled = isProviderEnabled(settings, p)
          const free = idle(a)
          return (
            <label key={a.id} className={cx('choice', to === a.id && 'selected', (!enabled || !free) && 'disabled')}>
              <input type="radio" disabled={!enabled || !free} checked={to === a.id} onChange={() => setTo(a.id)} />
              <div>
                <strong>
                  <ProviderIcon provider={p} /> {a.name}
                </strong>
                <div className="faint">
                  {!enabled
                    ? tr(msg({ id: 'agents.handOver.off', defaultMessage: '{cli} is turned off.', description: "Under an agent in the Continue with… dialog: its provider ({cli}) is turned off, so it can't be chosen." }), { cli: providerDescriptor(p).name })
                    : !free
                      ? tr(BUSY_AGENT)
                      : a.live
                        ? tr(msg({ id: 'agents.handOver.running', defaultMessage: 'Running: gets the message in its current session.', description: 'Under a running agent in the Continue with… dialog.' }))
                        : tr(msg({ id: 'agents.handOver.starts', defaultMessage: 'Starts a new {cli} session.', description: "Under a stopped agent in the Continue with… dialog: it starts a new session of its CLI ({cli})." }), { cli: providerDescriptor(p).name })}
                </div>
              </div>
            </label>
          )
        })}
      </div>
      <label className="flex muted" style={{ marginTop: 10 }}>
        <input type="checkbox" className="checkbox" disabled={!fromReady} checked={handover && fromReady} onChange={(e) => setHandover(e.target.checked)} />{' '}
        {tr(msg({ id: 'agents.handOver.askFirst', defaultMessage: 'Ask {agent} to write a handover first', description: 'Checkbox in the Continue with… dialog: the agent ({agent}) writes a handover before the next one starts.' }), { agent: from.name })}
      </label>
      <div className="detail">
        {fromReady
          ? tr(msg({ id: 'agents.handOver.writes', defaultMessage: "{who, select, self {{from} writes it with Combwork's handover tool; {from} continues in a new conversation when it's done.} other {{from} writes it with Combwork's handover tool; {other} starts when it's done.} none {{from} writes it with Combwork's handover tool; the other agent starts when it's done.}}", description: "Under Ask … to write a handover first: the agent ({from}) writes the handover, then it carries on itself (self), the chosen agent ({other}) starts, or one not chosen yet (none)." }), names)
          : from.live
            ? tr(msg({ id: 'agents.handOver.busy', defaultMessage: '{who, select, self {{from} is busy, so it continues from the latest handover.} other {{from} is busy, so {other} continues from the latest handover.} none {{from} is busy, so the other agent continues from the latest handover.}}', description: "Under Ask … to write a handover first, when the agent ({from}) is busy: the next one (itself: self; the chosen agent {other}; none chosen yet) carries on from the latest handover." }), names)
            : tr(msg({ id: 'agents.handOver.stopped', defaultMessage: "{who, select, self {{from} isn't running, so a new conversation continues from the latest handover.} other {{from} isn't running, so {other} continues from the latest handover.} none {{from} isn't running, so the other agent continues from the latest handover.}} Resume {from} first to have it write a new one.", description: "Under Ask … to write a handover first, when the agent ({from}) isn't running: the next one (a new conversation of its own: self; the chosen agent {other}; none chosen yet) carries on from the latest handover; Resume (a button) starts it again." }), names)}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const QUEUE_LOOKUP = msg({ id: 'agents.mergeDialog.queueLookup', defaultMessage: 'Checking whether Combwork merges this branch’s card through the merge queue…', description: "Why Merge is off for a moment in the Merge dialog: Combwork is reading whether its merge queue merges the branch's card. Glossary 2.5: merge queue." })
const QUEUE_LOOKUP_FAILED = msg({ id: 'agents.mergeDialog.queueLookupFailed', defaultMessage: "Couldn't read whether Combwork merges this branch's card through the merge queue, so Merge stays off: {why}", description: "The Merge dialog when Combwork couldn't read whether its merge queue merges the branch's card ({why}: the error). Merge is a button: keep it as Combwork shows it." })

export function MergeDialog() {
  useLanguage()
  const target = useStore((s) => s.mergeFor)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.mergeFor?.project) ?? null)
  const found = project?.agents.find((a) => a.id === target?.agentId) ?? null
  const [status, setStatus] = useState<AgentBranchStatus | null>(null)
  /** Why the branch couldn't be read (git missing, say, #346): shown instead of a merge that can't be checked. */
  const [readError, setReadError] = useState<string | null>(null)
  const gitTool = useStore((s) => s.gitTool)
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
  const [cleanup, setCleanup] = useState(false)
  const [moveBranch, setMoveBranch] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MergeResult | null>(null)
  /** The card on this branch when Combwork merges it (#1357, OP-13): its queue state; Merge waits for Merge anyway. */
  const [queueCard, setQueueCard] = useState<BranchQueueCard | null>(null)
  /** The card whose line the branch is, while it isn't Done (#1450): merged here only after asking. */
  const [lineCard, setLineCard] = useState<MergeBranch['card'] | null>(null)
  /** Whether that is known yet (HR3's round 1 finding 1): Merge stays off until it is, and when it can't be read. */
  const [lookup, setLookup] = useState<{ state: 'pending' | 'done' | 'failed'; error?: string }>({ state: 'pending' })
  const [lookups, setLookups] = useState(0)
  const slots = useMergeSlots()
  // What is merged: an agent's 0.9 worktree (#1442: while it still works there), or an unused worktree (#400), named
  // by its branch, nobody working in it.
  const unused = target?.worktree ?? null
  const own = found ? legacyOf(found) : null
  const agent = found && own ? { id: found.id, name: found.name, live: found.live, tree: own } : unused ? { id: '', name: unused.branch, live: null, tree: { path: unused.path, branch: unused.branch, base: status?.into ?? '' } } : null

  useEffect(() => {
    setStatus(null)
    setReadError(null)
    setResult(null)
    setBusy(false)
    if (!target || !agent?.tree) return
    // The project's own merge style (HI-1765), once read: a merge commit until then, and never over the user's choice.
    chosenStyle.current = false
    setSquash(false)
    setStyleRead(false)
    let live = true
    void projectMergeChoice(target.project).then((style) => {
      if (!live) return
      setStyleRead(true)
      if (!chosenStyle.current) setSquash(style === 'squash')
    })
    setMessage(unused ? `Work from ${unused.branch}` : `${agent.name}: work from ${agent.tree.branch}`) // i18n-ignore: a commit message, kept in git's history (English, as agents read it)
    setCleanup(false)
    setMoveBranch(true)
    void (unused ? call('worktrees:unusedBranchStatus', target.project, unused.path) : call('agents:branchStatus', target.project, target.agentId))
      .then(setStatus)
      .catch((e) => setReadError(errorMessage(e)))
    return () => {
      live = false
    }
    // Reset when the dialog opens for another agent or worktree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.project, target?.agentId, target?.worktree?.path])

  // Whether Combwork merges the branch's card, read when the dialog opens and on Retry; only the latest read counts.
  useEffect(() => {
    setQueueCard(null)
    setLineCard(null)
    const branch = unused?.branch ?? own?.branch
    if (!target || !branch) return void setLookup({ state: 'done' })
    setLookup({ state: 'pending' })
    let live = true
    // Both cards (#1450): the one the queue merges (Merge anyway), else the unfinished card whose line it is (asks first).
    void call('worktrees:branchCards', target.project, branch).then(
      (c) => {
        if (!live) return
        setQueueCard(c.queue)
        setLineCard(c.line)
        setLookup({ state: 'done' })
      },
      (e) => live && setLookup({ state: 'failed', error: errorMessage(e) })
    )
    return () => {
      live = false
    }
    // Read again when the dialog opens for another agent or worktree, and on Retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.project, target?.agentId, target?.worktree?.path, lookups])

  if (!target || !project || !agent?.tree) return null
  const close = (): void => set({ mergeFor: null })
  // Which merge this is (HR3's HI-2788 round 1): an unused worktree's or an agent's, each offered by the one map.
  const mergeChannel = unused ? 'worktrees:mergeUnused' : 'agents:merge'
  const running = !!agent.live
  // The agent started a task while the dialog was open.
  const blocked = mergeBlocked(agent.name, agent.live?.status, tr)
  const nothing = status && status.ahead === 0 && status.dirty === 0
  const folderAgent = project.agents.find((a) => !awayFromProject(a) && a.live && (a.live.status === 'ready' || a.live.status === 'finished'))
  // The branch it merges into is being merged into by an agent, or agents wait for it (#350): Merge waits until it is free.
  const slot = status?.into ? (projectSlots(slots, project.path).find((s) => s.branch === status.into) ?? null) : null
  const slotTaken = !!slot && (!!slot.holder || slot.waiting.length > 0)

  const merge = async (anyway = false): Promise<void> => {
    if (anyway && queueCard) {
      const ok = await confirm({
        title: tr(msg({ id: 'agents.mergeDialog.anywayTitle', defaultMessage: 'Merge {card} outside the merge queue?', description: "Title of the confirmation before Merge anyway: the card ({card}: its key) is one Combwork's merge queue merges. Glossary 2.5: merge queue." }), { card: queueCard.key }),
        message: tr(msg({ id: 'agents.mergeDialog.anywayMessage', defaultMessage: "Combwork merges this card through its queue, after its merge checks pass on the merged result. Merging it here skips them. It is recorded on the card as an override, and the queue takes its entry out once it sees the merge.", description: "The confirmation before Merge anyway in the Merge dialog. Glossary 2.3: merge checks; 2.4: override." })),
        confirmLabel: tr(msg({ id: 'agents.mergeDialog.anywayConfirm', defaultMessage: 'Merge anyway', description: 'The button confirming Merge anyway (a merge outside the merge queue). Keep it short.' })),
        danger: true
      })
      if (!ok) return
    } else if (lineCard && !(await confirmLineMerge(lineCard, agent.tree!.branch, status?.into ?? ''))) return
    setBusy(true)
    try {
      const removing = cleanup && !running
      const confirmed = lineCard && !queueCard ? { card: lineCard.number } : {}
      const r = unused
        ? await repoOp('worktrees:mergeUnused', project.path, unused.path, { squash, message, cleanup: removing, ...confirmed, ...(anyway && queueCard ? { outsideQueue: { card: queueCard.card, reason: '' } } : {}) })
        : await repoOp('agents:merge', project.path, agent.id, { squash, message, cleanup: removing, moveBranch: squash && !removing && moveBranch, ...confirmed, ...(anyway && queueCard ? { outsideQueue: { card: queueCard.card, reason: '' } } : {}) })
      setResult(r)
      if (r.ok) {
        // Where it went: the branch the project folder is on, or the folder itself when git didn't say.
        const where = { branch: agent.tree!.branch, into: status?.into ?? '', folder: status?.into ? 'no' : 'yes', agent: agent.name }
        notify(
          'success',
          tr(msg({ id: 'agents.merged.title', defaultMessage: 'Merged {branch} into {folder, select, yes {the project folder} other {{into}}}', description: "A notification's title after a merge: a worktree's branch ({branch}) merged into the project folder's branch ({into}; or the project folder, when its branch isn't known)." }), where),
          r.cleanedUp
            ? unused
              ? tr(msg({ id: 'agents.merged.removedUnused', defaultMessage: 'Its worktree and branch were removed.', description: 'After merging an unused worktree: it and its branch were removed.' }))
              : tr(msg({ id: 'agents.merged.removed', defaultMessage: "{agent}'s worktree and branch were removed.", description: "After merging an agent's work: its worktree and branch were removed ({agent}: the agent, removed too)." }), where)
            : r.branchMoved
              ? tr(msg({ id: 'agents.merged.moved', defaultMessage: "{branch} was moved to {folder, select, yes {the project folder} other {{into}}}, ready for {agent}'s next task.", description: "After a squash merge: the agent's branch ({branch}) now points at the merged branch ({into}), so its next merge brings only new work." }), where)
              : undefined
        )
        if (r.moveError) notify('warning', tr(msg({ id: 'agents.merged.notMoved', defaultMessage: '{branch} was not moved to {folder, select, yes {the project folder} other {{into}}}', description: "A warning's title after a squash merge: the agent's branch ({branch}) couldn't be moved to the merged branch ({into})." }), where), tr(msg({ id: 'agents.merged.notMovedWhy', defaultMessage: "{why} Its old commits are still on it, so its next merge may conflict with them: {folder, select, yes {ask {agent} to rebase its branch on the project folder's branch} other {ask {agent} to run git rebase {into}}}.", description: "Why the agent's branch wasn't moved ({why}: git's error, a sentence), and what to ask the agent ({agent}) to do: rebase on the project folder's branch ({into}: its name; folder: yes when it isn't known). git rebase is a command: keep it." }), { ...where, why: r.moveError }))
        if (r.cleanupKept) notify('warning', tr(msg({ id: 'agents.merged.kept', defaultMessage: '{branch} was merged, its worktree kept', description: "A warning's title after a merge: the branch ({branch}) was merged but its worktree couldn't be removed; the message says why." }), where), r.cleanupKept)
        if (r.cleanedUp && !unused) focusAfterRemoving(project, agent.id)
        // The project's unused worktrees, as they are now.
        if (unused) bumpUnused(project.path)
        await actions.refreshWorkspace()
        close()
      }
    } catch (e) {
      notify('error', tr(msg({ id: 'agents.merged.failed', defaultMessage: 'Could not merge', description: "An error's title: merging a worktree's branch failed." })), errorMessage(e))
      // Refused for a card Combwork merges (the dialog's state out of date): read it again, so the dialog says so.
      setLookups((n) => n + 1)
    }
    setBusy(false)
  }

  // Sent to an agent (or copied for one): agent-facing, English.
  const instructions = result?.conflicts
    ? `Merge branch ${agent.tree.branch} into ${status?.into ?? 'the current branch'} and resolve the conflicts in: ${result.conflicts.join(', ')}. Keep the intent of both sides; ask me if it isn't clear which to keep. Commit the merge when done.` // i18n-ignore: agent-facing: instructions sent to an agent
    : ''

  return (
    <Modal
      title={unused ? tr(msg({ id: 'agents.mergeDialog.titleUnused', defaultMessage: 'Merge {branch}', description: "Title of the Merge dialog for an unused worktree, named by its branch ({branch})." }), { branch: unused.branch }) : tr(msg({ id: 'agents.mergeDialog.title', defaultMessage: "Merge {agent}'s work", description: "Title of the Merge dialog for a worktree agent's work ({agent})." }), { agent: agent.name })}
      icon="git-merge"
      onClose={close}
      wide
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {result?.conflicts ? tr(msg({ id: 'agents.mergeDialog.close', defaultMessage: 'Close', description: 'Button: closes the Merge dialog after a merge that would conflict.' })) : tr(CANCEL)}
          </button>
          {!result?.conflicts && queueCard && opOffered(mergeChannel) && (
            <button className="btn subtle" data-action="merge-anyway" disabled={busy || !status || !!nothing || status.dirty > 0 || !status.into || !!blocked || slotTaken} onClick={() => void merge(true)}>
              {tr(msg({ id: 'agents.mergeDialog.anyway', defaultMessage: 'Merge anyway…', description: "A button in the Merge dialog when Combwork's merge queue merges the branch's card: merges it here all the same (asks first; recorded as an override)." }))}
            </button>
          )}
          {!result?.conflicts && opOffered(mergeChannel) && (
            <Tooltip content={queueCard ? tr(QUEUE_MERGES, { card: queueCard.key }) : lookup.state === 'pending' ? tr(QUEUE_LOOKUP) : lookup.state === 'failed' ? tr(QUEUE_LOOKUP_FAILED, { why: lookup.error ?? '' }) : null}>
              {/* While Combwork merges the card (or that isn't known yet), Merge is plainly off, Merge anyway the action (the Assistant's #1357 review); its reason on hover. */}
              <button className={cx('btn', queueCard || lookup.state !== 'done' ? 'merge-held' : 'primary')} data-action="merge" disabled={busy || !status || !!nothing || status.dirty > 0 || !status.into || !!blocked || slotTaken || !!queueCard || lookup.state !== 'done'} onClick={() => void merge()}>
                <Icon name={busy ? 'loading' : 'git-merge'} spin={busy} /> {tr(MERGE)}
              </button>
            </Tooltip>
          )}
        </>
      }
    >
      {queueCard && <QueueCardNote c={queueCard} />}
      {lineCard && !queueCard && <LineCardNote card={lineCard} />}
      {lookup.state === 'failed' && (
        <div className="banner warn merge-queue-note" data-queue-lookup="failed">
          <Icon name="warning" />
          <span>{tr(QUEUE_LOOKUP_FAILED, { why: lookup.error ?? '' })}</span>
          <button type="button" className="btn small" onClick={() => setLookups((n) => n + 1)}>
            {tr(msg({ id: 'agents.mergeDialog.queueRetry', defaultMessage: 'Retry', description: "A button in the Merge dialog after Combwork couldn't read whether its merge queue merges the branch's card: reads it again." }))}
          </button>
        </div>
      )}
      {readError ? (
        <div className="banner warn">
          <Icon name="warning" />
          <span>
            {readError}
            {gitProblemText(gitTool) ? ` ${gitFixText(gitTool)}` : ''} {tr(msg({ id: 'agents.mergeDialog.cantRead', defaultMessage: 'Nothing can be merged until Combwork can read the branch.', description: "The Merge dialog when git couldn't read the worktree's branch; why comes before it." }))}
          </span>
        </div>
      ) : !status ? (
        <p className="muted">
          <Icon name="loading" spin /> {tr(msg({ id: 'agents.mergeDialog.reading', defaultMessage: 'Reading {branch}…', description: "The Merge dialog while it reads the worktree's branch ({branch})." }), { branch: agent.tree.branch })}
        </p>
      ) : result?.conflicts ? (
        <>
          <div className="banner warn">
            <Icon name="warning" /> {tr(msg({ id: 'agents.mergeDialog.conflict', defaultMessage: 'Merging would conflict. Nothing was changed.', description: "The Merge dialog after a merge that would conflict: Combwork tried it and changed nothing." }))}
          </div>
          <p>{tr(msg({ id: 'agents.mergeDialog.conflictFiles', defaultMessage: 'These files were changed on both {branch} and {into}:', description: 'Above the files that would conflict: both branches ({branch}, the worktree\'s; {into}, the project folder\'s) changed them.' }), { branch: agent.tree.branch, into: status.into ?? '' })}</p>
          <ul className="conflict-list">
            {result.conflicts.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
          <p className="muted">{tr(msg({ id: 'agents.mergeDialog.conflictHelp', defaultMessage: 'An agent in the project folder can do the merge and resolve the conflicts. Send it these instructions, or copy them:', description: "The Merge dialog after a conflict, above the instructions for an agent (they stay in English: agents read them)." }))}</p>
          <pre className="instructions">{instructions}</pre>
          <div className="flex">
            <button className="btn subtle" onClick={() => void navigator.clipboard.writeText(instructions).then(() => notify('success', tr(msg({ id: 'agents.mergeDialog.copied', defaultMessage: 'Instructions copied', description: "A notification: the merge instructions for an agent were copied to the clipboard." }))))}>
              <Icon name="copy" /> {tr(msg({ id: 'agents.mergeDialog.copy', defaultMessage: 'Copy', description: 'Button: copies the merge instructions to the clipboard.' }))}
            </button>
            {folderAgent && (
              <button
                className="btn primary"
                onClick={() => {
                  const key = projectKey(project.path, folderAgent.id)
                  if (!pasteIntoTerminal(key, instructions)) void call('pty:write', key, instructions)
                  setTimeout(() => void call('pty:write', key, '\r'), 300)
                  close()
                  showAgent(project, folderAgent.id)
                }}
              >
                <Icon name="send" /> {tr(msg({ id: 'agents.mergeDialog.send', defaultMessage: 'Send to {agent}', description: 'Button: types the merge instructions into an agent of the project folder ({agent}).' }), { agent: folderAgent.name })}
              </button>
            )}
          </div>
          {!folderAgent && <div className="detail">{tr(msg({ id: 'agents.mergeDialog.noFolderAgent', defaultMessage: 'Start an agent in the project folder (and let it finish what it is doing) to send it the instructions from here.', description: 'The Merge dialog after a conflict when no agent of the project folder is ready to take the instructions.' }))}</div>}
        </>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            {nothing
              ? tr(msg({ id: 'agents.mergeDialog.nothing', defaultMessage: "There is nothing to merge: {branch} has no changes that aren't in {into}.", description: "The Merge dialog when the worktree's branch ({branch}) has nothing new for the project folder's branch ({into})." }), { branch: agent.tree.branch, into: status.into ?? '' })
              : status.ahead > 0
                ? tRich<ReactNode>(msg({ id: 'agents.mergeDialog.mergesCommits', defaultMessage: 'Merges <b>{commits, plural, one {# commit} other {# commits}}</b> from <code>{branch}</code> into <code>{into}</code>, the branch checked out in the project folder.', description: "At the top of the Merge dialog: how many commits ({commits}) it merges from the worktree's branch ({branch}) into the project folder's ({into}). Keep the tags." }), {
                    commits: status.ahead,
                    branch: agent.tree.branch,
                    into: status.into ?? tr(msg({ id: 'agents.mergeDialog.noBranch', defaultMessage: '(no branch)', description: "In the Merge dialog, where the project folder's branch goes, when it isn't on one." })),
                    b: BOLD,
                    code: CODE
                  })
                : tRich<ReactNode>(msg({ id: 'agents.mergeDialog.onlyUncommitted', defaultMessage: '<code>{branch}</code> has no commits to merge yet, only uncommitted changes.', description: "At the top of the Merge dialog when the worktree's branch ({branch}) has nothing committed to merge, only uncommitted files. Keep the tags." }), { branch: agent.tree.branch, code: CODE })}
          </p>
          {blocked && (
            <div className="banner warn">
              <Icon name="warning" /> {blocked}
            </div>
          )}
          {!status.into && <div className="banner warn">{tr(msg({ id: 'agents.mergeDialog.noInto', defaultMessage: 'The project folder is not on a branch. Check one out first.', description: "The Merge dialog when the project folder isn't on a git branch (detached HEAD)." }))}</div>}
          <MergeSlotNote slot={slot} />
          {status.into && !unused && status.into !== agent.tree.base && (
            <div className="banner warn">
              <Icon name="info" /> {tr(msg({ id: 'agents.mergeDialog.otherBase', defaultMessage: "{agent}'s branch started from {base}, but the project folder is on {into}.", description: "The Merge dialog when the agent's ({agent}) branch started from another branch ({base}) than the one the project folder is on now ({into})." }), { agent: agent.name, base: agent.tree.base, into: status.into })}
            </div>
          )}
          {status.dirty > 0 && (
            <div className="banner warn" data-testid="merge-uncommitted">
              <Icon name="warning" /> {tr(msg({ id: 'agents.mergeDialog.uncommitted', defaultMessage: "{files, plural, one {# file in the worktree isn't committed} other {# files in the worktree aren't committed}}, and Combwork merges only committed work. Commit or stash {files, plural, one {it} other {them}} in the worktree, then merge.", description: "The Merge dialog when the worktree has uncommitted files ({files}: how many): Merge is off until they are committed or stashed (git stash) in the worktree." }), { files: status.dirty })}
            </div>
          )}
          <div className="choice-list" data-merge-style={styleRead ? 'read' : 'reading'}>
            <label className={cx('choice', !squash && 'selected')}>
              <input type="radio" checked={!squash} onClick={() => chooseSquash(false)} onChange={() => chooseSquash(false)} />
              <div>
                <strong>{tr(MERGE)}</strong>
                <div className="faint">{unused ? tr(msg({ id: 'agents.mergeDialog.mergeNoteUnused', defaultMessage: 'Keeps its commits and their messages, plus a merge commit.', description: "Under the Merge choice (a git merge) for an unused worktree's branch." })) : tr(msg({ id: 'agents.mergeDialog.mergeNote', defaultMessage: "Keeps the agent's commits and their messages, plus a merge commit. Its next merge brings only what is new.", description: "Under the Merge choice (a git merge) for an agent's work." }))}</div>
              </div>
            </label>
            <label className={cx('choice', squash && 'selected')}>
              <input type="radio" checked={squash} onClick={() => chooseSquash(true)} onChange={() => chooseSquash(true)} />
              <div>
                <strong>{tr(msg({ id: 'agents.mergeDialog.squash', defaultMessage: 'Squash', description: 'A choice in the Merge dialog: one commit with all the work (a git squash merge). Keep it short.' }))}</strong>
                <div className="faint">{unused ? tr(msg({ id: 'agents.mergeDialog.squashNoteUnused', defaultMessage: 'One commit with everything on it, with the message below.', description: "Under the Squash choice for an unused worktree's branch." })) : tr(msg({ id: 'agents.mergeDialog.squashNote', defaultMessage: 'One commit with everything the agent did, with the message below.', description: "Under the Squash choice for an agent's work." }))}</div>
              </div>
            </label>
          </div>
          <label className="compact-focus" style={{ marginTop: 10 }}>
            <span>{tr(msg({ id: 'agents.mergeDialog.message', defaultMessage: 'Commit message', description: "Label of the merge's commit message in the Merge dialog." }))}</span>
            <textarea className="input" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <label className="flex muted" style={{ marginTop: 10 }}>
            <input type="checkbox" className="checkbox" disabled={running} checked={cleanup && !running} onChange={(e) => setCleanup(e.target.checked)} />{' '}
            {unused ? tr(msg({ id: 'agents.mergeDialog.removeUnused', defaultMessage: 'Remove the worktree and branch afterwards', description: 'Checkbox in the Merge dialog for an unused worktree: removes it and its branch once merged.' })) : tr(msg({ id: 'agents.mergeDialog.remove', defaultMessage: 'Remove the worktree and branch afterwards (and the agent)', description: "Checkbox in the Merge dialog for an agent's work: removes its worktree, its branch and the agent once merged." }))}
          </label>
          {running && <div className="detail">{tr(msg({ id: 'agents.mergeDialog.running', defaultMessage: '{agent} is running, so its worktree stays. Stop it first to remove the worktree after merging.', description: "The Merge dialog while the agent ({agent}) runs: its worktree can't be removed." }), { agent: agent.name })}</div>}
          {/* A squashed branch that stays would bring its old commits to its next merge: move it to the squash. */}
          {squash && !unused && !(cleanup && !running) && (
            <>
              <label className="flex muted" style={{ marginTop: 6 }}>
                <input type="checkbox" className="checkbox" checked={moveBranch} onChange={(e) => setMoveBranch(e.target.checked)} />{' '}
                {tr(msg({ id: 'agents.mergeDialog.move', defaultMessage: 'Move {branch} to {known, select, yes {{into}} other {the merged branch}} afterwards', description: "Checkbox in the Merge dialog (Squash): points the agent's branch ({branch}) at the merged branch ({into}; when it isn't known, the merged branch) once merged." }), { branch: agent.tree.branch, into: status.into ?? '', known: status.into ? 'yes' : 'no' })}
              </label>
              <div className="detail">
                {moveBranch
                  ? tr(msg({ id: 'agents.mergeDialog.moveNote', defaultMessage: "Its work is all in the squash commit, so {agent}'s next merge brings only what is new.", description: "Under Move … afterwards, ticked: why it helps the agent's ({agent}) next merge." }), { agent: agent.name })
                  : tr(msg({ id: 'agents.mergeDialog.noMoveNote', defaultMessage: 'Its old commits stay on it, and its next merge may conflict with them.', description: 'Under Move … afterwards, not ticked: what that means for the next merge.' }))}
              </div>
            </>
          )}
          {result?.error && <div className="field-error">{result.error}</div>}
        </>
      )}
    </Modal>
  )
}
