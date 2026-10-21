import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_PROJECT_CONFIG, ROLE_MAX, agentLimitText, effectiveModelLabel, mergeBlocked, projectAgents, slugify, transcriptWarnLimit } from '@shared/defaults'
import { handOverNow, onRunningLane } from '@shared/handOver'
import { useAgentLimit } from '../advanced'
import { shownText as inLanguage } from '@shared/advanced'
import { PROVIDERS, agentProvider, chosenDefaultProvider, defaultProviderPending, isProviderEnabled, modeCaveat, modeOption, offeredModes, projectDefaultProvider, projectProviderConfig, projectUse200k, providerDescriptor, providerName, providerSettings, shownText } from '@shared/providers'
import type { AddAgentOptions, AgentBranchStatus, EffortLevel, MergeResult, PermissionMode, ProjectConfig, ProjectGitInfo, ProjectInfo, ProviderId, WorktreeMatch } from '@shared/types'
import { serverOnIn } from '@shared/agentMcp'
import { reuseNote } from '@shared/unusedWorktrees'
import { hiveBranch, reusableBranches } from '@shared/hiveBranches'
import { agentNameProblem, nameTaken, nameTakenMessage, sameAgentName, suggestAgentName, workspaceAgentList } from '@shared/agentNames'
import type { TemplateAgent } from '@shared/templates'
import { gitFixText, gitProblemText } from '@shared/gitTool'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { agentProviderOf, bumpUnused, confirm, focusAfterRemoving, notify, projectKey, set, setActivity, showAgent, useLanguage, useStore } from '../store'
import { fmt, msg, tr, tRich } from '@shared/i18n'
import { confirmDangerousMode } from './PermissionMode'
import { ProviderIcon } from './ProviderIcon'
import { cx } from '../util'
import { formatSize } from '@shared/units'
import { MergeSlotNote, projectSlots, useMergeSlots } from './MergeSlots'
import { EffortPicker, ModelPicker } from './ModelPicker'
import { cliDefaultEffort, effortName, effortText, effortUnknown, modelCaps } from '@shared/models'
import { pasteIntoTerminal } from './TerminalView'
import { BusyButton, Icon, Modal, sentences, useBusy } from './ui'

/** Markup in messages (tRich): <code> and <b>, keyed by their text. */
const CODE = (chunks: ReactNode[]): ReactNode => <code key={String(chunks)}>{chunks}</code>
const BOLD = (chunks: ReactNode[]): ReactNode => <strong key={String(chunks)}>{chunks}</strong>
/** A link in a message (tRich), doing `onClick`. */
const LINK =
  (onClick: (e: React.MouseEvent) => void) =>
  (chunks: ReactNode[]): ReactNode => (
    <a key="link" onClick={onClick}>
      {chunks}
    </a>
  )

// Words several dialogs here use (#800): messages as data, shown with tr().
const CANCEL = msg({ id: 'agents.dialog.cancel', defaultMessage: 'Cancel', description: "Button: closes an agent dialog without changing anything." })
const NAME = msg({ id: 'agents.dialog.name', defaultMessage: 'Name', description: "Label of an agent's name (Add Agent, Agent Settings)." })
const CODING_AGENT = msg({ id: 'agents.dialog.codingAgent', defaultMessage: 'Coding agent', description: 'A heading in Add Agent and Agent Settings, above the choice of provider (Claude Code, Codex, GitHub Copilot).' })
const WORKTREE = msg({ id: 'agents.dialog.worktree', defaultMessage: 'Worktree', description: "Label of an agent's git worktree (a checkout of its own)." })
const SETTINGS = msg({ id: 'agents.dialog.settings', defaultMessage: 'Settings', description: "A heading in Add Agent and Agent Settings, above the agent's model, effort, mode and context." })
const PROJECTS = msg({ id: 'agents.overrides.projects', defaultMessage: "Project's", description: "An agent's model, effort, mode or context choice that follows the project's: the first choice of each, before the project's value in brackets (\"Project's (Opus 5.5)\"). Keep it short." })
const MCP_SERVERS = msg({ id: 'agents.dialog.mcpServers', defaultMessage: 'MCP servers', description: "A heading in Agent Settings, above the agent's MCP servers." })
const WORKS_IN = msg({ id: 'agents.dialog.worksIn', defaultMessage: 'Works in', description: 'Label of where an agent works (Agent Settings): its worktree or the project folder.' })
const PROJECT_FOLDER = msg({ id: 'agents.dialog.projectFolder', defaultMessage: 'The project folder', description: "Where an agent works: the project's own folder (not a worktree)." })
const MERGE = msg({ id: 'agents.dialog.merge', defaultMessage: 'Merge', description: "The Merge dialog's button, and its choice of a git merge (not a squash). Keep it short." })
const BUSY_AGENT = msg({ id: 'agents.dialog.busy', defaultMessage: 'Busy. Choose it once it has finished.', description: 'Under an agent in the Continue with… dialog: it is working, so it can\'t be chosen now.' })

/** A permission mode's name as the window shows it (#800): the provider's mode, else its id. */
const modeName = (provider: ProviderId, mode: PermissionMode): string => {
  const m = modeOption(provider, mode)
  return m ? shownText(m.label, m.text?.label, tr) : mode
}

/** Which provider an agent runs: enabled providers, with what each still needs (install, sign-in). */
export function ProviderChoice({ value, current, onChange }: { value: ProviderId; current?: ProviderId; onChange: (v: ProviderId) => void }) {
  useLanguage()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
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

/** An agent's 200K-context choice in a form: '' follows the project. */
export type ContextChoice = '' | 'on' | 'off'
export const contextChoice = (v: boolean | undefined): ContextChoice => (v === undefined ? '' : v ? 'on' : 'off')
export const contextValue = (c: ContextChoice): boolean | null => (c ? c === 'on' : null)

/** The agent's own model, effort, permission mode and context for its provider; empty values follow the project (`inherit` names it). */
export function Overrides({
  project,
  provider,
  model,
  effort,
  permission,
  context,
  onModel,
  onEffort,
  onPermission,
  onContext,
  inherit,
  inheritIsDefault,
  assistant
}: {
  /** The Hive Assistant's: never the CLI's own setting (#1284). */
  assistant?: boolean
  /** What an empty choice is called (the project's, by default): the caller's own words. */
  inherit?: string
  /** That name says it is the default ("Default"): the effort then names the level alone, not "High, default" (#916). */
  inheritIsDefault?: boolean
  /** Whose settings an empty choice follows: the project's (a template's agent: the project it may be loaded into, or none). */
  project: Pick<ProjectInfo, 'config'>
  provider: ProviderId
  model: string
  effort: string
  permission: string
  context: ContextChoice
  onModel: (v: string) => void
  onEffort: (v: string) => void
  onPermission: (v: string) => void
  onContext: (v: ContextChoice) => void
}) {
  useLanguage()
  const settings = useStore((s) => s.settings)
  const info = useStore((s) => s.providers[provider])
  const cliDefault = info?.defaultModel ?? null
  if (!settings) return null
  const whose = inherit ?? tr(PROJECTS)
  /** The first choice of each: whose it is, and what that is now. */
  const inherited = (value: string): string => tr(msg({ id: 'agents.overrides.inherited', defaultMessage: '{whose} ({value})', description: "The first choice of an agent's model, effort, mode or context: whose setting it follows ({whose}: \"Project's\") and what that is now ({value}: \"Opus 5.5\")." }), { whose, value })
  const onOff = (on: boolean): string => (on ? tr(msg({ id: 'agents.overrides.on', defaultMessage: 'On', description: "A choice of an agent's Use 200K context setting. Keep it short." })) : tr(msg({ id: 'agents.overrides.off', defaultMessage: 'Off', description: "A choice of an agent's Use 200K context setting. Keep it short." })))
  const p = providerDescriptor(provider)
  const pc = projectProviderConfig(project.config, provider)
  const g = providerSettings(settings, provider)
  // The model's name alone: inherited() already says it is the project's (or the default), so "Default (Opus 5.5)",
  // not "Default (Opus 5.5 (default))" (#892).
  const projectModel = effectiveModelLabel(provider, (pc.model && pc.model !== 'inherit' ? pc.model : '') || g.defaultModel || cliDefault || undefined, '', info)
  const projectPermission = modeName(provider, pc.permissionMode === 'inherit' ? g.defaultPermissionMode : pc.permissionMode)
  // Never the CLI's own setting for the Assistant (#1284).
  const modes = offeredModes(provider, settings, assistant)
  // What would run: the choice here, else what it inherits.
  const runModel = model || (pc.model && pc.model !== 'inherit' ? pc.model : g.defaultModel) || cliDefault
  const runMode = permission || (pc.permissionMode !== 'inherit' ? pc.permissionMode : g.defaultPermissionMode)
  const chosenEffort = pc.effort !== 'inherit' ? pc.effort : g.defaultEffort
  // Default once (#916): the CLI's own default, when it hasn't said which level that is, alone ("Claude Code's default", not
  // "Default (Claude Code default)"); else the level, bare after "Default" ("Default (High)"), "Project's (High, default)" for an agent.
  const defaultLevel = chosenEffort && chosenEffort !== 'inherit' ? chosenEffort : modelCaps(provider, runModel, info, settings).defaultEffort
  const effortBase = effortUnknown(provider, chosenEffort, runModel, info, settings)
    ? cliDefaultEffort(provider, tr)
    : inherited(inheritIsDefault && defaultLevel ? effortName(provider, defaultLevel, settings, tr) : effortText(provider, chosenEffort, runModel, info, settings, tr))
  return (
    <div className="agent-form">
      <label>{tr(msg({ id: 'agents.overrides.model', defaultMessage: 'Model', description: "Label of an agent's model choice (Add Agent, Agent Settings)." }))}</label>
      <ModelPicker key={provider} provider={provider} value={model} base={{ value: '', label: inherited(projectModel) }} onChange={onModel} />
      <label>{tr(msg({ id: 'agents.overrides.effort', defaultMessage: 'Effort', description: "Label of an agent's effort (reasoning) choice (Add Agent, Agent Settings)." }))}</label>
      <EffortPicker provider={provider} model={runModel} value={effort} base={{ value: '', label: effortBase }} onChange={onEffort} />
      <label>{tr(msg({ id: 'agents.overrides.permission', defaultMessage: 'Permission mode', description: "Label of an agent's permission mode choice (Add Agent, Agent Settings)." }))}</label>
      <select className="select" value={permission} onChange={(e) => onPermission(e.target.value)}>
        <option value="">{inherited(projectPermission)}</option>
        {modes.map((m) => (
          <option key={m.value} value={m.value}>
            {shownText(m.label, m.text?.label, tr)}
          </option>
        ))}
      </select>
      <ModeCaveat provider={provider} mode={runMode} model={runModel} />
      {p.capabilities.contextLimit && (
        <>
          <label>{tr(msg({ id: 'agents.overrides.context', defaultMessage: 'Use 200K context (instead of 1M)', description: "Label of an agent's choice to hold its sessions to a 200K-token context window instead of the model's 1M one." }))}</label>
          <select className="select" value={context} onChange={(e) => onContext(e.target.value as ContextChoice)}>
            <option value="">{inherited(onOff(projectUse200k(pc, g)))}</option>
            <option value="on">{onOff(true)}</option>
            <option value="off">{onOff(false)}</option>
          </select>
        </>
      )}
    </div>
  )
}

/** Under a mode choice: the provider's warning when it may not run that mode with that model (as the CLI says, #125). */
export function ModeCaveat({ provider, mode, model }: { provider: ProviderId; mode: string | null | undefined; model: string | null | undefined }) {
  const info = useStore((s) => s.providers[provider])
  const settings = useStore((s) => s.settings)
  useLanguage()
  const caps = modelCaps(provider, model, info, settings)
  const text = modeCaveat(provider, mode as PermissionMode, model, { supportsAuto: caps.supportsAuto, label: caps.label }, tr)
  if (!text) return null
  return (
    <div className="mode-caveat">
      <Icon name="warning" /> <span>{text}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add agent
// ---------------------------------------------------------------------------

export function AddAgentDialog() {
  useLanguage()
  const path = useStore((s) => s.addAgentFor)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.addAgentFor) ?? null)
  const settings = useStore((s) => s.settings)
  const workspaceProjects = useStore((s) => s.workspace?.projects)
  const workspaceName = useStore((s) => s.workspace?.name ?? '')
  // `error`: git couldn't be read, which isn't the same as "not a repository".
  const [git, setGit] = useState<(ProjectGitInfo & { error?: string }) | null>(null)
  const [name, setName] = useState('')
  const [location, setLocation] = useState<AddAgentOptions['location']>('project')
  const [branch, setBranch] = useState('')
  const [branchEdited, setBranchEdited] = useState(false)
  const [base, setBase] = useState('')
  const [existing, setExisting] = useState('')
  // The unused worktree a new one on that branch would reuse (#456), as last checked; null: none.
  const [match, setMatch] = useState<WorktreeMatch | null>(null)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [permission, setPermission] = useState('')
  const [context, setContext] = useState<ContextChoice>('')
  const [provider, setProvider] = useState<ProviderId>('')
  // The provider is still the project's default (not one the user picked), and whether that waits on detection (#506).
  const [followDefault, setFollowDefault] = useState(true)
  const defaultPending = useStore((s) => !!s.addAgentFor && defaultProviderPending(s.workspace?.projects.find((p) => p.path === s.addAgentFor)?.config, s.settings))
  const [startNow, setStartNow] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!path || !project) return
    const agents = projectAgents(project.config)
    // Unique across the workspace (#702): numbered past every project's names.
    const everyone = workspaceAgentList(useStore.getState().workspace?.projects)
    let n = agents.length + 1
    // A name, kept as the agent's (agents and the Agent API read it): English, as Hive names agents everywhere.
    const named = (k: number): string => `Agent ${k}` // i18n-ignore: an agent's default name (stored, read by agents)
    while (everyone.some((a) => sameAgentName(a.name, named(n)))) n++
    setName(named(n))
    // hive/<workspace>/<project>/<agent> (#703).
    setBranch(hiveBranch({ workspace: useStore.getState().workspace?.name ?? '', project: project.name }, named(n)))
    setBranchEdited(false)
    setModel('')
    setEffort('')
    setPermission('')
    setContext('')
    // The project's default provider (#474): Automatic's pick is turned on; a provider the user chose stays chosen even
    // when it is off, and the dialog says so (Add waits until it is on, or another is chosen), as quick add does.
    const s = useStore.getState().settings
    setProvider(projectDefaultProvider(project.config, s))
    setFollowDefault(true)
    setStartNow(true)
    setBusy(false)
    setGit(null)
    setExisting('')
    // Opened to give an unused worktree to an agent (#353): Existing worktree, that one chosen once git lists it free.
    const preset = useStore.getState().addAgentPreset
    const wanted = preset?.project === path ? preset.worktreePath.toLowerCase() : null
    if (preset) set({ addAgentPreset: null })
    setLocation(wanted ? 'existing-worktree' : 'project')
    void call('agents:gitInfo', path)
      .then((g) => {
        setGit(g)
        setBase(g.current ?? g.branches[0] ?? '')
        const free = g.worktrees.filter((w) => !w.used)
        setExisting((wanted && free.find((w) => w.path.toLowerCase() === wanted)?.path) || (free[0]?.path ?? ''))
      })
      .catch((e) => setGit({ isRepo: false, current: null, branches: [], worktrees: [], worktreesRoot: '', error: errorMessage(e) }))
    // Only when the dialog opens for a project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // Where its branch is (#703): hive/<workspace>/<project>/<agent>, the workspace part as git info gives it for this
  // repository (clear of branches from before, `branchSpace`) once it is known.
  const home = { workspace: workspaceName, project: path?.split(/[\\/]/).pop() ?? '', spaces: git?.branchSpaces ?? [], ...(git?.branchSpace ? { space: git.branchSpace } : {}) }
  // Git info read: the default branch in the repository's own space, unless the user typed one.
  useEffect(() => {
    if (git?.branchSpace && !branchEdited) setBranch(hiveBranch({ ...home, space: git.branchSpace }, name))
    // Only when git info arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [git])

  // New worktree: whether an unused worktree is already on that branch (#456), looked at once the typing pauses: for its
  // default branch, also one on the branch Hive made for that name before (#703).
  useEffect(() => {
    setMatch(null)
    const b = branch.trim()
    const agent = name.trim()
    if (!path || location !== 'new-worktree' || !b || !base || !git?.worktrees.some((w) => !w.used && !!w.branch && reusableBranches(b, home, agent).includes(w.branch))) return
    let live = true
    const t = setTimeout(() => {
      void call('agents:worktreeMatch', path, b, base, agent)
        .then((m) => live && setMatch(m))
        .catch(() => undefined)
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
    // (home follows path, git and the workspace's name.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, location, branch, base, git, workspaceName, name])

  // Opened while Hive was still looking for the CLIs: Automatic's pick, once it is known (#506).
  useEffect(() => {
    const p = useStore.getState().workspace?.projects.find((x) => x.path === path)
    if (p && followDefault && !defaultPending) setProvider(projectDefaultProvider(p.config, useStore.getState().settings))
  }, [path, followDefault, defaultPending])
  const limit = useAgentLimit()

  if (!path || !project || !settings) return null
  const close = (): void => set({ addAgentFor: null })
  const full = project.agents.length >= limit
  const free = git?.worktrees.filter((w) => !w.used) ?? []
  const copy = project.config.worktreeCopy ?? settings.agents.worktreeCopy
  const setup = project.config.worktreeSetup.trim()
  const checking = followDefault && defaultPending
  // A name another agent of the workspace has (#702): refused, with a free one to use.
  const everyone = workspaceAgentList(workspaceProjects)
  const owner = name.trim() ? nameTaken(name, everyone) : null
  const suggestion = owner ? suggestAgentName(name.trim(), project.name, everyone.map((a) => a.name)) : ''
  const valid = !!name.trim() && !owner && !full && !checking && isProviderEnabled(settings, provider) && (location !== 'new-worktree' || (!!branch.trim() && !!base)) && (location !== 'existing-worktree' || !!existing)
  const chooseProvider = (v: ProviderId): void => {
    // Model, effort, mode and context are the provider's own: another provider starts from the project's.
    if (v === provider) return
    setFollowDefault(false)
    setProvider(v)
    setModel('')
    setEffort('')
    setPermission('')
    setContext('')
  }

  const rename = (v: string): void => {
    setName(v)
    if (!branchEdited) setBranch(hiveBranch(home, v))
  }

  const add = async (): Promise<void> => {
    if (permission && !(await confirmDangerousMode(provider, permission, name.trim()))) return
    setBusy(true)
    try {
      const def = await call('agents:add', project.path, {
        name: name.trim(),
        provider,
        location,
        branch: location === 'new-worktree' ? branch.trim() : undefined,
        base: location === 'new-worktree' ? base : undefined,
        worktreePath: location === 'existing-worktree' ? existing : undefined,
        reuseWorktree: true,
        model: model || undefined,
        effort: (effort || undefined) as EffortLevel | undefined,
        permissionMode: (permission || undefined) as PermissionMode | undefined,
        use200kContext: contextValue(context) ?? undefined
      })
      await actions.refreshWorkspace()
      close()
      // What happened to an unused worktree it could reuse (#456): "Reused hive/b4, brought up to main at 66ce11b".
      if (def.reuse) {
        // Why an unused worktree wasn't reused, in the window's language (#848): the English is the Agent API's.
        const reuse = def.reuse.notReusedText ? { ...def.reuse, notReused: inLanguage(def.reuse.notReusedText) } : def.reuse
        const note = reuseNote(reuse, tr)
        notify('info', tr(msg({ id: 'agents.add.worktreeNotice', defaultMessage: '{agent}: {reused, select, yes {worktree reused} other {new worktree}}', description: "A notification's title after adding a worktree agent ({agent}): whether it reused an unused worktree or made a new one. Its message says how." }), { agent: def.name, reused: def.reuse.reused ? 'yes' : 'no' }), note.charAt(0).toUpperCase() + note.slice(1))
      }
      actions.noteManyAgents(project.path)
      const p = useStore.getState().workspace?.projects.find((x) => x.path === project.path)
      // Show the new agent in a pane: a single-pane layout switches to it (in the Tiles view, its tile: #976).
      if (p) showAgent(p, def.id, 'select')
      if (startNow) await actions.newSession(project.path, def.id)
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
          <label className="flex muted" style={{ marginRight: 'auto' }}>
            <input type="checkbox" className="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} /> {tr(msg({ id: 'agents.add.startNow', defaultMessage: 'Start a session now', description: 'Checkbox in the Add Agent dialog: start the new agent at once.' }))}
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
      {full && <div className="banner warn">{tr(msg({ id: 'agents.add.full', defaultMessage: '{limit} Remove one first.', description: "The Add Agent dialog when the project has as many agents as it may: why ({limit}, a sentence), then what to do." }), { limit: agentLimitText(limit, tr) })}</div>}
      <div className="agent-form">
        <label>{tr(NAME)}</label>
        <input
          className="input"
          value={name}
          autoFocus
          onChange={(e) => rename(e.target.value)}
        />
        {owner && (
          <div className="field-error span2" data-name-taken>
            {owner.project === project.name
              ? tr(msg({ id: 'agents.add.nameTakenHere', defaultMessage: '{project} already has an agent called {agent}.', description: 'Under the name in the Add Agent dialog: an agent of this project ({project}) has that name ({agent}).' }), { project: project.name, agent: owner.name })
              : tr(msg({ id: 'agents.add.nameTaken', defaultMessage: '{project} already has an agent called {agent}: agent names are unique across the workspace.', description: 'Under the name in the Add Agent dialog: an agent of another project ({project}) has that name ({agent}).' }), { project: owner.project, agent: owner.name })}{' '}
            <a onClick={() => rename(suggestion)}>{tr(msg({ id: 'agents.add.useSuggestion', defaultMessage: 'Use {name}', description: 'Link after a taken name in the Add Agent dialog: uses a free name ({name}) instead.' }), { name: suggestion })}</a>
          </div>
        )}
      </div>
      <h3 className="agent-dialog-h">{tr(CODING_AGENT)}</h3>
      <ProviderChoice value={provider} onChange={chooseProvider} />
      {checking && (
        <div className="banner info" data-provider-checking>
          <Icon name="loading" spin />
          <span>{tr(msg({ id: 'agents.add.checking', defaultMessage: 'Checking which coding agents are installed, for the default provider (Automatic)…', description: "The Add Agent dialog while Hive looks for the installed CLIs, to pick the default provider. Automatic is that setting's name." }))}</span>
        </div>
      )}
      {!isProviderEnabled(settings, provider) && (
        <div className="banner warn" data-provider-off={provider}>
          <Icon name="warning" />
          <span>
            {tr(msg({ id: 'agents.add.providerOff', defaultMessage: '{cli} is turned off{whose, select, project {, and it is this project\'s default provider} yours {, and it is your default provider} other {}}. Turn it on in Settings → Providers, or choose another provider.', description: "The Add Agent dialog when the chosen provider ({cli}) is turned off; if it is the default provider, whose default it is: this project's (project) or the user's (yours); other: say nothing. Settings → Providers: use its translated names." }), { cli: providerName(provider), whose: chosenDefaultProvider(project.config, settings) === provider ? (project.config.defaultProvider === provider ? 'project' : 'yours') : 'none' })}
          </span>
        </div>
      )}
      <h3 className="agent-dialog-h">{tr(msg({ id: 'agents.add.where', defaultMessage: 'Where it works', description: 'A heading in the Add Agent dialog, above the choice of folder: the project folder, a new worktree or an existing one.' }))}</h3>
      <div className="choice-list">
        <label className={cx('choice', location === 'project' && 'selected')}>
          <input type="radio" checked={location === 'project'} onChange={() => setLocation('project')} />
          <div>
            <strong>{tr(msg({ id: 'agents.add.projectFolder', defaultMessage: 'Project folder', description: "A choice in the Add Agent dialog: the agent works in the project's own folder." }))}</strong>
            <div className="faint">{tr(msg({ id: 'agents.add.projectFolderNote', defaultMessage: "Shares the folder with the project's other agents. File locks stop two agents editing the same file at once.", description: 'Under the Project folder choice in the Add Agent dialog.' }))}</div>
          </div>
        </label>
        <label className={cx('choice', location === 'new-worktree' && 'selected', !git?.isRepo && 'disabled')}>
          <input type="radio" disabled={!git?.isRepo} checked={location === 'new-worktree'} onChange={() => setLocation('new-worktree')} />
          <div>
            <strong>{tr(msg({ id: 'agents.add.newWorktree', defaultMessage: 'New worktree', description: 'A choice in the Add Agent dialog: the agent works in a new git worktree (its own checkout on its own branch).' }))}</strong>
            <div className="faint">
              {git?.error
                ? tr(msg({ id: 'agents.add.gitError', defaultMessage: 'Could not read the git repository: {error}', description: "Under the New worktree choice: Hive couldn't read the project's git repository; {error} is why." }), { error: git.error })
                : git?.gitProblem
                  ? tr(msg({ id: 'agents.add.gitProblem', defaultMessage: '{problem}. Agent Setup says how to fix it.', description: "Under the New worktree choice: git can't be used ({problem}, a sentence without its full stop). Agent Setup is a Help window: use its translated name." }), { problem: git.gitProblem })
                  : git?.isRepo === false
                    ? tr(msg({ id: 'agents.add.needsRepo', defaultMessage: 'Needs a git repository.', description: "Under the New worktree choice: the project isn't a git repository." }))
                    : tr(msg({ id: 'agents.add.newWorktreeNote', defaultMessage: 'Its own checkout on its own branch. Review and merge its work when it is done.', description: 'Under the New worktree choice in the Add Agent dialog.' }))}
            </div>
            {location === 'new-worktree' && (
              <div className="agent-form nested">
                <label>{tr(msg({ id: 'agents.add.branch', defaultMessage: 'Branch', description: "Label of the new worktree's branch name in the Add Agent dialog." }))}</label>
                <input
                  className="input mono"
                  value={branch}
                  onChange={(e) => {
                    setBranch(e.target.value)
                    setBranchEdited(true)
                  }}
                />
                <div className="faint span2" data-branch-hint>
                  {tRich<ReactNode>(msg({ id: 'agents.add.branchHint', defaultMessage: '<code>hive/</code> marks branches Hive made, so it can reuse and tidy them up.', description: 'Under the branch name in the Add Agent dialog. Keep <code>hive/</code> as it is: it is the start of the branch name.' }), { code: CODE })}
                </div>
                <label>{tr(msg({ id: 'agents.add.basedOn', defaultMessage: 'Based on', description: "Label of the branch a new worktree's branch starts from (Add Agent dialog)." }))}</label>
                <select className="select" value={base} onChange={(e) => setBase(e.target.value)}>
                  {git?.branches.map((b) => (
                    <option key={b} value={b}>
                      {b === git.current ? tr(msg({ id: 'agents.add.currentBranch', defaultMessage: '{branch} (current)', description: 'A branch in the Based on list: the one checked out in the project folder now.' }), { branch: b }) : b}
                    </option>
                  ))}
                </select>
                {match && !match.reusable && (
                  <div className="banner info span2" data-worktree-match="held">
                    <Icon name="info" />
                    <span>
                      {tRich<ReactNode>(msg({ id: 'agents.add.heldWorktree', defaultMessage: '<code>{branch}</code> already has an unused worktree with work in it ({why}). Hive makes a new one, or <reuse>reuse it (it keeps its work)</reuse>.', description: 'Under the branch name in the Add Agent dialog: an unused worktree on that branch ({branch}) has work in it ({why}). <reuse> is a link that chooses that worktree instead. Keep the tags.' }), {
                        branch: match.branch,
                        why: match.why,
                        code: CODE,
                        reuse: LINK((e) => {
                          // Inside the New worktree choice's label: its click would choose New worktree again.
                          e.preventDefault()
                          setExisting(match.path)
                          setLocation('existing-worktree')
                        })
                      })}
                    </span>
                  </div>
                )}
                {match?.reusable ? (
                  <div className="faint span2" data-worktree-match="reuse">
                    {/* Sentences joined as the language does (#893: no space after 。). */}
                    {(() => {
                      const reuses = tRich<ReactNode>(msg({ id: 'agents.add.reuses', defaultMessage: 'Reuses <code>{path}</code>, the unused worktree already on <code>{branch}</code>: it is merged into {base} and clean, so Hive brings it up to {base}.', description: 'Under the branch name in the Add Agent dialog: the new agent reuses an unused worktree ({path}, on {branch}) that is merged into {base}. Keep the <code> tags.' }), { path: match.path, branch: match.branch, base: match.base, code: CODE })
                      return setup ? sentences(reuses, tRich<ReactNode>(msg({ id: 'agents.add.setupAgain', defaultMessage: '<code>{setup}</code> runs again only if a lockfile changed.', description: "Under a reused worktree in the Add Agent dialog: the project's setup command ({setup}) runs again only when a lockfile changed. Keep the <code> tags." }), { setup, code: CODE })) : reuses
                    })()}
                  </div>
                ) : (
                <div className="faint span2">
                  {sentences(
                    tRich<ReactNode>(msg({ id: 'agents.add.createdIn', defaultMessage: 'Created in <code>{folder}</code>{copied, select, none {} other {, with <code>{copied}</code> copied from the project folder}}.', description: "Under the branch name in the Add Agent dialog: where the new worktree goes ({folder}, a path), and the files copied into it from the project folder ({copied}, a list; none: leave that branch empty). Keep the <code> tags." }), { folder: `${git?.worktreesRoot ?? ''}\\${slugify(name)}`, copied: fmt.list(copy.split(/[\n,]/).map((s) => s.trim()).filter(Boolean), 'unit') || 'none', code: CODE }),
                    setup
                      ? tRich<ReactNode>(msg({ id: 'agents.add.setupRuns', defaultMessage: "<code>{setup}</code> runs in the agent's pane before {cli} starts.", description: "Under the branch name in the Add Agent dialog: the project's setup command ({setup}) runs in the new agent's pane before its CLI ({cli}) starts. Keep the <code> tags." }), { setup, cli: providerDescriptor(provider).name, code: CODE })
                      : tr(msg({ id: 'agents.add.setupNone', defaultMessage: 'Set a setup command (e.g. npm install) in Project Settings → Agents.', description: 'Under the branch name in the Add Agent dialog when the project has no setup command: where to set one. npm install is a command: keep it. Project Settings → Agents: use their translated names.' }))
                  )}
                </div>
                )}
              </div>
            )}
          </div>
        </label>
        <label className={cx('choice', location === 'existing-worktree' && 'selected', !free.length && 'disabled')}>
          <input type="radio" disabled={!free.length} checked={location === 'existing-worktree'} onChange={() => setLocation('existing-worktree')} />
          <div>
            <strong>{tr(msg({ id: 'agents.add.existingWorktree', defaultMessage: 'Existing worktree', description: "A choice in the Add Agent dialog: the agent works in one of the project's worktrees that no agent uses." }))}</strong>
            <div className="faint">
              {free.length
                ? tr(msg({ id: 'agents.add.existingNote', defaultMessage: 'A worktree of this project that no agent uses, e.g. one kept when an agent was removed.', description: 'Under the Existing worktree choice in the Add Agent dialog.' }))
                : tr(msg({ id: 'agents.add.noUnused', defaultMessage: 'This project has no unused worktrees.', description: 'Under the Existing worktree choice in the Add Agent dialog, when there is none to choose.' }))}
            </div>
            {location === 'existing-worktree' && (
              <div className="agent-form nested">
                <label>{tr(WORKTREE)}</label>
                <select className="select" value={existing} onChange={(e) => setExisting(e.target.value)}>
                  {free.map((w) => (
                    <option key={w.path} value={w.path}>
                      {w.branch ?? tr(msg({ id: 'agents.add.detached', defaultMessage: '(detached)', description: "An existing worktree in the Add Agent dialog's list whose checkout is on no branch (git's detached HEAD)." }))} — {w.path}
                    </option>
                  ))}
                </select>
                <div className="faint span2">
                  {git?.current
                    ? tr(msg({ id: 'agents.add.existingMerged', defaultMessage: 'One merged into {branch} and clean is brought up to it first; any other keeps its work as it is.', description: 'Under the Existing worktree list: what happens to the chosen worktree ({branch}: the branch checked out in the project folder).' }), { branch: git.current })
                    : tr(msg({ id: 'agents.add.existingMergedCurrent', defaultMessage: 'One merged into the current branch and clean is brought up to it first; any other keeps its work as it is.', description: "Under the Existing worktree list: what happens to the chosen worktree, when the project folder's branch isn't known." }))}
                </div>
              </div>
            )}
          </div>
        </label>
      </div>
      <h3 className="agent-dialog-h">{tr(SETTINGS)}</h3>
      <Overrides project={project} provider={provider} model={model} effort={effort} permission={permission} context={context} onModel={setModel} onEffort={setEffort} onPermission={setPermission} onContext={setContext} />
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Agent settings
// ---------------------------------------------------------------------------

/** Roles to suggest (#126): the usual ones, then those the agents already have (a project's, or a template's). */
function roleSuggestions(agents: readonly { role?: string }[]): string[] {
  const out = ['builder', 'reviewer']
  for (const a of agents) if (a.role && !out.some((r) => r.toLowerCase() === a.role!.toLowerCase())) out.push(a.role)
  return out
}

/** What the Agent Settings dialog edits: a project's agent, or a template's (#271), alike. */
interface AgentFields {
  name: string
  role: string
  provider: ProviderId
  model: string
  effort: string
  permission: string
  context: ContextChoice
  /** A template's agent: its own worktree (true) or the project folder. */
  worktree: boolean
  /** Only these of the project's MCP servers (#537); null: all of them. */
  mcp: string[] | null
}

/**
 * The MCP servers an agent can be given (#537): those on in the project (`project`, its MCP choices, #713), or for a
 * template's agent (null), which may be loaded anywhere, every server the workspace has. Null until they are read.
 */
function useMcpOffered(project: ProjectConfig['mcp'] | null): string[] | null {
  const version = useStore((s) => s.skillsVersion)
  const [list, setList] = useState<string[] | null>(null)
  const key = project ? JSON.stringify(project) : ''
  useEffect(() => {
    let live = true
    const mcp = key ? (JSON.parse(key) as ProjectConfig['mcp']) : null
    call('mcp:list')
      .then((l) => live && setList(l.filter((m) => (mcp ? serverOnIn(m, mcp) : !!m.def)).map((m) => m.name)))
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
          {tr(msg({ id: 'agents.mcp.all', defaultMessage: "All of the project's", description: "A choice of an agent's MCP servers (Agent Settings): every MCP server on in its project. Keep it short." }))}
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
          <p className="hint">{tr(msg({ id: 'agents.mcp.none', defaultMessage: '{where, select, workspace {No MCP servers are on in this workspace: it gets none.} other {No MCP servers are on in this project: it gets none.}}', description: "Agent Settings, Only these, when no MCP server is on where the agent is (its project, or, for a template's agent, the workspace)." }), { where })}</p>
        ) : (
          <div className="choice-list" role="group" aria-label={tr(msg({ id: 'agents.mcp.its', defaultMessage: 'Its MCP servers', description: "Accessible name of the list of MCP servers to tick for an agent (Agent Settings)." }))}>
            {names.map((n) => (
              <label key={n} className="flex">
                <input type="checkbox" className="checkbox" checked={value.includes(n)} onChange={(e) => onChange(e.target.checked ? [...value, n] : value.filter((x) => x !== n))} /> {n}
                {!offered.includes(n) && <span className="faint">{tr(msg({ id: 'agents.mcp.notOn', defaultMessage: '{where, select, workspace {not on in this workspace} other {not on in this project}}', description: "After an MCP server the agent was given that isn't on where it is now (its project, or the workspace). Lower case." }), { where })}</span>}
              </label>
            ))}
          </div>
        ))}
      <div className="faint">{tr(msg({ id: 'agents.mcp.note', defaultMessage: 'The built-in hive server is always given. A server enabled later reaches it only with All.', description: "Under an agent's MCP servers (Agent Settings). hive is the built-in server's name: keep it. All is the first choice above (\"All of the project's\")." }))}</div>
    </div>
  )
}

/**
 * The Agent Settings dialog (#126, #271): name, role, where it works, coding agent, model, effort, mode, context and
 * MCP servers (#537: those on in the project, `mcpProject` its MCP choices, or every server of the workspace for a
 * template's agent, null; `mcpWhere` says where they are on, in words).
 * `works`: what the agent works in, shown (a project's agent), or `choice` to pick it (a template's: its own worktree or
 * the project folder). `providerLocked`: why the coding agent can't change now (a running agent). `config`: whose
 * settings an empty choice follows. `nameProblem`: why a name can't be used. `confirmSave`: asked first (false keeps it
 * open); `save` runs with the dialog open, a failure staying in it.
 */
function AgentSettingsModal({
  title,
  resetKey,
  initial,
  config,
  roles,
  works,
  mcpProject,
  mcpWhere,
  providerLocked,
  note,
  nameProblem,
  confirmSave,
  save,
  onClose
}: {
  title: string
  resetKey: string
  initial: AgentFields
  config: Pick<ProjectInfo, 'config'>
  roles: string[]
  works: ReactNode | 'choice'
  mcpProject: ProjectConfig['mcp'] | null
  mcpWhere: 'project' | 'workspace'
  providerLocked?: ReactNode
  note?: ReactNode
  nameProblem?: (name: string) => string | null
  confirmSave?: (f: AgentFields) => Promise<boolean>
  save: (f: AgentFields) => Promise<void>
  onClose: () => void
}) {
  useLanguage()
  const [f, setF] = useState<AgentFields>(initial)
  const action = useBusy()
  // Read as the dialog opens (the dialogs stay mounted while closed, and the workspace may have changed).
  const mcpOffered = useMcpOffered(mcpProject)
  useEffect(() => {
    action.setError(null)
    setF(initial)
    // Reset when another agent's dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])
  const put = (patch: Partial<AgentFields>): void => setF((x) => ({ ...x, ...patch }))
  const chooseProvider = (v: ProviderId): void => put(v !== f.provider ? { provider: v, model: '', effort: '', permission: '', context: '' } : { provider: v })
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
        {/* What the agent is for, saved in templates (#126): free text, suggesting the usual ones and the agents' own. */}
        <label htmlFor="agent-role">{tr(msg({ id: 'agents.settings.role', defaultMessage: 'Role', description: "Label of an agent's role (Agent Settings): what it is for, in the user's words (builder, reviewer…)." }))}</label>
        <input id="agent-role" className="input" value={f.role} maxLength={ROLE_MAX} placeholder={tr(msg({ id: 'agents.settings.roleNone', defaultMessage: 'None (its name: {name})', description: "Placeholder of an agent's empty role (Agent Settings): no role, so its name ({name}) says what it is." }), { name: f.name.trim() || initial.name })} list="agent-role-suggestions" onChange={(e) => put({ role: e.target.value })} onKeyDown={enter} />
        <datalist id="agent-role-suggestions">
          {roles.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <label>{tr(WORKS_IN)}</label>
        {works === 'choice' ? (
          <div className="segmented works-in" role="radiogroup" aria-label={tr(WORKS_IN)}>
            <button type="button" role="radio" aria-checked={f.worktree} className={cx(f.worktree && 'active')} onClick={() => put({ worktree: true })}>
              <Icon name="worktree" /> {tr(msg({ id: 'agents.settings.ownWorktree', defaultMessage: 'Its own worktree', description: "A choice of where a template's agent works (Agent Settings): a worktree of its own. Keep it short." }))}
            </button>
            <button type="button" role="radio" aria-checked={!f.worktree} className={cx(!f.worktree && 'active')} onClick={() => put({ worktree: false })}>
              <Icon name="folder" /> {tr(PROJECT_FOLDER)}
            </button>
          </div>
        ) : (
          <div className="muted">{works}</div>
        )}
      </div>
      <h3 className="agent-dialog-h">{tr(CODING_AGENT)}</h3>
      {providerLocked ?? <ProviderChoice value={f.provider} current={initial.provider} onChange={chooseProvider} />}
      <h3 className="agent-dialog-h">{tr(SETTINGS)}</h3>
      <Overrides
        project={config}
        provider={f.provider}
        model={f.model}
        effort={f.effort}
        permission={f.permission}
        context={f.context}
        onModel={(model) => put({ model })}
        onEffort={(effort) => put({ effort })}
        onPermission={(permission) => put({ permission })}
        onContext={(context) => put({ context })}
      />
      <h3 className="agent-dialog-h">{tr(MCP_SERVERS)}</h3>
      <McpChoice value={f.mcp} offered={mcpOffered} where={mcpWhere} onChange={(mcp) => put({ mcp })} />
      {note && <div className="detail">{note}</div>}
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
  if (!target || !project || !agent) return null
  // Another agent of the workspace's name (#702); its own name stays, even one it shares from before names were unique.
  const nameProblem = (n: string): string | null => {
    if (sameAgentName(n, agent.name)) return null
    const everyone = workspaceAgentList(projects)
    const owner = nameTaken(n, everyone, { project: project.name, id: agent.id })
    return owner ? nameTakenMessage(n, owner, suggestAgentName(n, project.name, everyone.map((a) => a.name)), tr) : null
  }
  const current = agent.live?.provider ?? agentProvider(agent, project.config, settings)
  const close = (): void => set({ agentSettingsFor: null })
  const initial: AgentFields = { name: agent.name, role: agent.role ?? '', provider: current, model: agent.model ?? '', effort: agent.effort ?? '', permission: agent.permissionMode ?? '', context: contextChoice(agent.use200kContext), worktree: !!agent.worktree, mcp: agent.mcpServers ? [...agent.mcpServers] : null }
  return (
    <AgentSettingsModal
      title={tr(msg({ id: 'agents.settings.title', defaultMessage: '{agent} settings', description: 'Title of the Agent Settings dialog. {agent} is the agent.' }), { agent: agent.name })}
      resetKey={`${target.project}|${target.agentId}`}
      initial={initial}
      config={project}
      roles={roleSuggestions(project.agents)}
      mcpProject={project.config.mcp}
      mcpWhere="project"
      works={
        agent.worktree ? (
          <>
            {tRich<ReactNode>(msg({ id: 'agents.settings.worktreeOn', defaultMessage: 'Worktree on <code>{branch}</code> (from {base})', description: "Where an agent works (Agent Settings): its worktree's branch ({branch}) and the branch it started from ({base}). Keep the <code> tags." }), { branch: agent.worktree.branch, base: agent.worktree.base, code: CODE })}
            <div className="faint">{agent.worktree.path}</div>
          </>
        ) : (
          tr(PROJECT_FOLDER)
        )
      }
      providerLocked={
        agent.live ? (
          <div className="muted flex">
            <ProviderIcon provider={current} /> {providerDescriptor(current).name} <span className="faint">{tr(msg({ id: 'agents.settings.stopToChange', defaultMessage: '— stop {agent} to change it', description: "After a running agent's provider in Agent Settings ({agent}: its name): the provider can only change while it is stopped." }), { agent: agent.name })}</span>
          </div>
        ) : undefined
      }
      note={agent.live ? tr(msg({ id: 'agents.settings.appliesNext', defaultMessage: 'Changes apply the next time {agent} starts; the running session keeps its settings until then.', description: 'Under Agent Settings for a running agent ({agent}).' }), { agent: agent.name }) : undefined}
      nameProblem={nameProblem}
      confirmSave={async (f) => {
        if (f.provider !== current) {
          const ok = await confirm({
            title: tr(msg({ id: 'agents.switch.title', defaultMessage: 'Switch {agent} to {cli}?', description: "Title of the confirmation before an agent ({agent}) changes provider ({cli}: the new CLI's name)." }), { agent: agent.name, cli: providerDescriptor(f.provider).name }),
            message: tr(msg({ id: 'agents.switch.message', defaultMessage: "Its conversations stay in the Sessions tab, but {cli} can't resume {was} conversations, so {agent} starts fresh next time.", description: "The confirmation before an agent ({agent}) changes provider: the new CLI ({cli}) can't resume the old one's ({was}) conversations." }), { agent: agent.name, cli: providerDescriptor(f.provider).name, was: providerDescriptor(current).name }),
            detail: tr(msg({ id: 'agents.switch.detail', defaultMessage: 'To carry the work over, ask the agent for a handover before switching (Hive MCP: hive_create_handover), then ask the new agent to read it.', description: 'Under the confirmation before an agent changes provider. hive_create_handover is a tool name: keep it.' })),
            confirmLabel: tr(msg({ id: 'agents.switch.confirm', defaultMessage: 'Switch', description: "Button: changes the agent's provider. Keep it short." }))
          })
          if (!ok) return false
        }
        return !(f.permission && f.permission !== agent.permissionMode && !(await confirmDangerousMode(f.provider, f.permission, agent.name)))
      }}
      save={async (f) => {
        await call('agents:update', project.path, agent.id, {
          name: f.name,
          role: f.role,
          ...(f.provider !== current ? { provider: f.provider } : {}),
          model: f.model || undefined,
          effort: (f.effort || undefined) as EffortLevel | undefined,
          permissionMode: (f.permission || undefined) as PermissionMode | undefined,
          use200kContext: contextValue(f.context),
          mcpServers: f.mcp
        })
        await actions.refreshWorkspace()
      }}
      onClose={close}
    />
  )
}

/**
 * The same dialog for a template's agent (#271), from the template editor: what it saves goes back to the editor (which
 * saves the template with it, #510). An empty choice stays empty in the template (it follows the project it is loaded into).
 */
export function TemplateAgentDialog() {
  useLanguage()
  const req = useStore((s) => s.templateAgentFor)
  const settings = useStore((s) => s.settings)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.templateAgentFor?.project) ?? null)
  // The agent as saved, for when the dialog closes (null: cancelled).
  const result = useRef<TemplateAgent | null>(null)
  if (!req) return null
  const a = req.agent
  const close = (answer: TemplateAgent | null): void => {
    set({ templateAgentFor: null })
    req.resolve(answer)
    result.current = null
  }
  const provider = a?.provider ?? projectDefaultProvider(project?.config ?? DEFAULT_PROJECT_CONFIG, settings)
  const initial: AgentFields = { name: a?.name ?? req.suggestedName, role: a?.role ?? '', provider, model: a?.model ?? '', effort: a?.effort ?? '', permission: a?.permissionMode ?? '', context: contextChoice(a?.use200kContext), worktree: a?.worktree ?? false, mcp: a?.mcpServers ? [...a.mcpServers] : null }
  return (
    <AgentSettingsModal
      title={a ? tr(msg({ id: 'agents.template.title', defaultMessage: '{agent} settings (template)', description: "Title of Agent Settings for an agent of a template ({agent}), from the template editor." }), { agent: a.name }) : tr(msg({ id: 'agents.template.new', defaultMessage: 'New agent (template)', description: 'Title of Agent Settings for a new agent of a template, from the template editor.' }))}
      resetKey={`${req.key}`}
      initial={initial}
      config={project ?? { config: DEFAULT_PROJECT_CONFIG }}
      roles={roleSuggestions(req.others)}
      works="choice"
      mcpProject={null}
      mcpWhere="workspace"
      note={tr(msg({ id: 'agents.template.note', defaultMessage: 'For the template "{template}": Save saves it in the template. Settings left as "{projects}" follow the project it is loaded into.', description: "Under Agent Settings for a template's agent: Save (a button) saves it in the template ({template}); {projects} is the first choice of each setting (\"Project's\")." }), { template: req.template, projects: tr(PROJECTS) })}
      nameProblem={(n) => (req.others.some((o) => o.name.toLowerCase() === n.toLowerCase()) ? tr(msg({ id: 'agents.template.nameTaken', defaultMessage: 'Another agent of the template is called "{name}".', description: "Why a template's agent can't take a name ({name}): another agent of the template has it." }), { name: n }) : null)}
      confirmSave={async (f) => !(f.permission && f.permission !== a?.permissionMode && !(await confirmDangerousMode(f.provider, f.permission, f.name.trim())))}
      save={async (f) => {
        const role = f.role.replace(/\s+/g, ' ').trim()
        const ctx = contextValue(f.context)
        result.current = {
          name: f.name.replace(/\s+/g, ' ').trim(),
          ...(role ? { role } : {}),
          provider: f.provider,
          ...(f.model ? { model: f.model } : {}),
          ...(f.effort ? { effort: f.effort as EffortLevel } : {}),
          ...(f.permission ? { permissionMode: f.permission as PermissionMode } : {}),
          ...(ctx !== null ? { use200kContext: ctx } : {}),
          ...(f.mcp ? { mcpServers: f.mcp } : {}),
          worktree: f.worktree
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
 * so the source writes a handover (Hive's hive_create_handover tool) and the target reads it. The agent
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
    const first = project.agents.find((a) => a.id !== target.agentId && idle(a) && isProviderEnabled(settings, agentProviderOf(project, a)))
    const own = project.agents.find((a) => a.id === target.agentId)
    const mb = own?.live?.transcriptBytes ?? 0
    const limit = transcriptWarnLimit(project.config, settings?.sessions.transcriptWarnMB ?? 0)
    // A long conversation (from its footer or the notification) most likely wants a new one of its own.
    const ownFirst = !!own && !selfOff && limit > 0 && mb >= limit * 1024 * 1024
    setTo(ownFirst ? target.agentId : (first?.id ?? (own && !selfOff ? target.agentId : '')))
    // Again when whether it may end its own conversation changes (the window learns of a lane a moment after Hive does).
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
  const hiveTools = settings?.agentApi.provideHiveMcp !== false

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
          <button className="btn primary" disabled={!chosen || !hiveTools} onClick={go}>
            <Icon name="arrow-swap" /> {tr(msg({ id: 'agents.handOver.go', defaultMessage: 'Hand Over', description: "The Continue with… dialog's button: hands the work to the chosen agent." }))}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        {tr(msg({ id: 'agents.handOver.intro', defaultMessage: "Another agent picks up the work from a handover. It can use a different provider: the conversation itself stays with {agent}; the handover carries the goal, what's done and the next steps. Or {agent} carries on itself in a new conversation, which keeps a long one from slowing things down.", description: 'At the top of the Continue with… dialog ({agent}: the agent whose work is handed over). A handover is a note an agent writes for the next one.' }), { agent: from.name })}
      </p>
      {!hiveTools && (
        <div className="banner warn">
          <Icon name="warning" /> {tr(msg({ id: 'agents.handOver.needsTools', defaultMessage: 'This needs Hive\'s tools in sessions. Turn on "Provide Hive tools to sessions" in Settings → Agent API.', description: "The Continue with… dialog when sessions don't get Hive's tools: the setting to turn on (its name in quotes, and where: use their translated names)." }))}
        </div>
      )}
      <div className="choice-list">
        <label className={cx('choice', self && 'selected', selfOff && 'disabled')}>
          <input type="radio" disabled={selfOff} checked={self} onChange={() => setTo(from.id)} />
          <div>
            <strong>
              <ProviderIcon provider={agentProviderOf(project, from)} /> {tr(msg({ id: 'agents.handOver.self', defaultMessage: '{agent}, in a new conversation', description: 'A choice in the Continue with… dialog: the agent itself ({agent}) carries on in a new conversation.' }), { agent: from.name })}
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
          const p = agentProviderOf(project, a)
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
          ? tr(msg({ id: 'agents.handOver.writes', defaultMessage: "{who, select, self {{from} writes it with Hive's handover tool; {from} continues in a new conversation when it's done.} other {{from} writes it with Hive's handover tool; {other} starts when it's done.} none {{from} writes it with Hive's handover tool; the other agent starts when it's done.}}", description: "Under Ask … to write a handover first: the agent ({from}) writes the handover, then it carries on itself (self), the chosen agent ({other}) starts, or one not chosen yet (none)." }), names)
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

export function MergeDialog() {
  useLanguage()
  const target = useStore((s) => s.mergeFor)
  const settings = useStore((s) => s.settings)
  const project = useStore((s) => s.workspace?.projects.find((p) => p.path === s.mergeFor?.project) ?? null)
  const found = project?.agents.find((a) => a.id === target?.agentId) ?? null
  const [status, setStatus] = useState<AgentBranchStatus | null>(null)
  /** Why the branch couldn't be read (git missing, say, #346): shown instead of a merge that can't be checked. */
  const [readError, setReadError] = useState<string | null>(null)
  const gitTool = useStore((s) => s.gitTool)
  const [squash, setSquash] = useState(true)
  const [message, setMessage] = useState('')
  const [cleanup, setCleanup] = useState(false)
  const [moveBranch, setMoveBranch] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MergeResult | null>(null)
  const slots = useMergeSlots()
  // What is merged: an agent's worktree, or an unused worktree (#400), named by its branch, nobody working in it.
  const unused = target?.worktree ?? null
  const agent = found?.worktree ? found : unused ? { id: '', name: unused.branch, live: null, worktree: { path: unused.path, branch: unused.branch, base: status?.into ?? '' } } : null

  useEffect(() => {
    setStatus(null)
    setReadError(null)
    setResult(null)
    setBusy(false)
    if (!target || !agent?.worktree) return
    setSquash((settings?.agents.mergeStyle ?? 'merge') === 'squash')
    setMessage(unused ? `Work from ${unused.branch}` : `${agent.name}: work from ${agent.worktree.branch}`) // i18n-ignore: a commit message, kept in git's history (English, as agents read it)
    setCleanup(false)
    setMoveBranch(true)
    void (unused ? call('worktrees:unusedBranchStatus', target.project, unused.path) : call('agents:branchStatus', target.project, target.agentId))
      .then(setStatus)
      .catch((e) => setReadError(errorMessage(e)))
    // Reset when the dialog opens for another agent or worktree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.project, target?.agentId, target?.worktree?.path])

  if (!target || !project || !agent?.worktree) return null
  const close = (): void => set({ mergeFor: null })
  const running = !!agent.live
  // The agent started a task while the dialog was open.
  const blocked = mergeBlocked(agent.name, agent.live?.status, tr)
  const nothing = status && status.ahead === 0 && status.dirty === 0
  const folderAgent = project.agents.find((a) => !a.worktree && a.live && (a.live.status === 'ready' || a.live.status === 'finished'))
  // The branch it merges into is being merged into by an agent, or agents wait for it (#350): Merge waits until it is free.
  const slot = status?.into ? (projectSlots(slots, project.path).find((s) => s.branch === status.into) ?? null) : null
  const slotTaken = !!slot && (!!slot.holder || slot.waiting.length > 0)

  const merge = async (): Promise<void> => {
    setBusy(true)
    try {
      const removing = cleanup && !running
      const r = unused
        ? await call('worktrees:mergeUnused', project.path, unused.path, { squash, message, cleanup: removing })
        : await call('agents:merge', project.path, agent.id, { squash, message, cleanup: removing, moveBranch: squash && !removing && moveBranch })
      setResult(r)
      if (r.ok) {
        // Where it went: the branch the project folder is on, or the folder itself when git didn't say.
        const where = { branch: agent.worktree!.branch, into: status?.into ?? '', folder: status?.into ? 'no' : 'yes', agent: agent.name }
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
    }
    setBusy(false)
  }

  // Sent to an agent (or copied for one): agent-facing, English.
  const instructions = result?.conflicts
    ? `Merge branch ${agent.worktree.branch} into ${status?.into ?? 'the current branch'} and resolve the conflicts in: ${result.conflicts.join(', ')}. Keep the intent of both sides; ask me if it isn't clear which to keep. Commit the merge when done.` // i18n-ignore: agent-facing: instructions sent to an agent
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
          {!result?.conflicts && (
            <button className="btn primary" disabled={busy || !status || !!nothing || !status.into || !!blocked || slotTaken} onClick={() => void merge()}>
              <Icon name={busy ? 'loading' : 'git-merge'} spin={busy} /> {tr(MERGE)}
            </button>
          )}
        </>
      }
    >
      {readError ? (
        <div className="banner warn">
          <Icon name="warning" />
          <span>
            {readError}
            {gitProblemText(gitTool) ? ` ${gitFixText(gitTool)}` : ''} {tr(msg({ id: 'agents.mergeDialog.cantRead', defaultMessage: 'Nothing can be merged until Hive can read the branch.', description: "The Merge dialog when git couldn't read the worktree's branch; why comes before it." }))}
          </span>
        </div>
      ) : !status ? (
        <p className="muted">
          <Icon name="loading" spin /> {tr(msg({ id: 'agents.mergeDialog.reading', defaultMessage: 'Reading {branch}…', description: "The Merge dialog while it reads the worktree's branch ({branch})." }), { branch: agent.worktree.branch })}
        </p>
      ) : result?.conflicts ? (
        <>
          <div className="banner warn">
            <Icon name="warning" /> {tr(msg({ id: 'agents.mergeDialog.conflict', defaultMessage: 'Merging would conflict. Nothing was changed.', description: "The Merge dialog after a merge that would conflict: Hive tried it and changed nothing." }))}
          </div>
          <p>{tr(msg({ id: 'agents.mergeDialog.conflictFiles', defaultMessage: 'These files were changed on both {branch} and {into}:', description: 'Above the files that would conflict: both branches ({branch}, the worktree\'s; {into}, the project folder\'s) changed them.' }), { branch: agent.worktree.branch, into: status.into ?? '' })}</p>
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
              ? tr(msg({ id: 'agents.mergeDialog.nothing', defaultMessage: "There is nothing to merge: {branch} has no changes that aren't in {into}.", description: "The Merge dialog when the worktree's branch ({branch}) has nothing new for the project folder's branch ({into})." }), { branch: agent.worktree.branch, into: status.into ?? '' })
              : tRich<ReactNode>(msg({ id: 'agents.mergeDialog.merges', defaultMessage: 'Merges {parts, select, both {<b>{commits, plural, one {# commit} other {# commits}}</b> and <b>{changes, plural, one {# uncommitted change} other {# uncommitted changes}}</b>} commits {<b>{commits, plural, one {# commit} other {# commits}}</b>} other {<b>{changes, plural, one {# uncommitted change} other {# uncommitted changes}}</b>}} from <code>{branch}</code> into <code>{into}</code>, the branch checked out in the project folder.', description: "At the top of the Merge dialog: what it merges ({parts}: both, commits and uncommitted changes; commits, only commits; other, only uncommitted changes), how many of each ({commits}, {changes}), from the worktree's branch ({branch}) into the project folder's ({into}). Keep the tags." }), {
                  commits: status.ahead,
                  changes: status.dirty,
                  parts: status.ahead > 0 && status.dirty > 0 ? 'both' : status.ahead > 0 ? 'commits' : 'changes',
                  branch: agent.worktree.branch,
                  into: status.into ?? tr(msg({ id: 'agents.mergeDialog.noBranch', defaultMessage: '(no branch)', description: "In the Merge dialog, where the project folder's branch goes, when it isn't on one." })),
                  b: BOLD,
                  code: CODE
                })}
          </p>
          {blocked && (
            <div className="banner warn">
              <Icon name="warning" /> {blocked}
            </div>
          )}
          {!status.into && <div className="banner warn">{tr(msg({ id: 'agents.mergeDialog.noInto', defaultMessage: 'The project folder is not on a branch. Check one out first.', description: "The Merge dialog when the project folder isn't on a git branch (detached HEAD)." }))}</div>}
          <MergeSlotNote slot={slot} />
          {status.into && !unused && status.into !== agent.worktree.base && (
            <div className="banner warn">
              <Icon name="info" /> {tr(msg({ id: 'agents.mergeDialog.otherBase', defaultMessage: "{agent}'s branch started from {base}, but the project folder is on {into}.", description: "The Merge dialog when the agent's ({agent}) branch started from another branch ({base}) than the one the project folder is on now ({into})." }), { agent: agent.name, base: agent.worktree.base, into: status.into })}
            </div>
          )}
          {status.dirty > 0 && <div className="detail">{tr(msg({ id: 'agents.mergeDialog.commitsFirst', defaultMessage: 'The uncommitted changes are committed on {branch} first, with the message below.', description: "The Merge dialog when the worktree has uncommitted changes: they are committed on its branch ({branch}) before merging." }), { branch: agent.worktree.branch })}</div>}
          <div className="choice-list">
            <label className={cx('choice', !squash && 'selected')}>
              <input type="radio" checked={!squash} onChange={() => setSquash(false)} />
              <div>
                <strong>{tr(MERGE)}</strong>
                <div className="faint">{unused ? tr(msg({ id: 'agents.mergeDialog.mergeNoteUnused', defaultMessage: 'Keeps its commits and their messages, plus a merge commit.', description: "Under the Merge choice (a git merge) for an unused worktree's branch." })) : tr(msg({ id: 'agents.mergeDialog.mergeNote', defaultMessage: "Keeps the agent's commits and their messages, plus a merge commit. Its next merge brings only what is new.", description: "Under the Merge choice (a git merge) for an agent's work." }))}</div>
              </div>
            </label>
            <label className={cx('choice', squash && 'selected')}>
              <input type="radio" checked={squash} onChange={() => setSquash(true)} />
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
                {tr(msg({ id: 'agents.mergeDialog.move', defaultMessage: 'Move {branch} to {known, select, yes {{into}} other {the merged branch}} afterwards', description: "Checkbox in the Merge dialog (Squash): points the agent's branch ({branch}) at the merged branch ({into}; when it isn't known, the merged branch) once merged." }), { branch: agent.worktree.branch, into: status.into ?? '', known: status.into ? 'yes' : 'no' })}
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
