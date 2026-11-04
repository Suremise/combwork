import { isReservedServerName } from '@shared/assistantTools'
import { basename } from './util'
import { call, errorMessage } from './api'
import { agentLimit } from './advanced'
import { cliReadyOf, firstReadyConnection, offeredConnections } from '@shared/connectionLabel'
import { agentOf, cancelDialog, agentProviderOf, cardLabelOf, choose, openVersionControl, paneCells, shownLayout, closeTile, confirm, findProject, focusAfterRemoving, focusAgent, runOnce, whileStarting, ADDING_AGENT, isAssistantPath, setAssistantOpen, focusedAgentId, get, notify, prompt, revealAgent, set, setActivity, setProjectTab, showAgent, showView, useStore } from './store'
import { AGENT_LIMIT_MAX, MANY_AGENTS, OPEN_WORKFLOW_OPTIONS, agentLimitText, chosenLayout, layoutColumns, layoutPanes, moveAgentTo, projectLayout, projectSessionView, sessionInAgentFolder, swapAgentsIn } from '@shared/defaults'
import { moveToCell, neighbourCell, orderByCells, type CellDirection } from '@shared/paneCells'
import { autoProvider, autoProviderPending, isKnownProvider, isProviderEnabled, providerName } from '@shared/providers'
import { agentsToResume, resumeAll, stalledOnSignIn, type ResumeAllResult } from '@shared/resumeAll'
import { holdShort, holdText } from '@shared/sessionResume'
import type { FreshRow } from '@shared/freshStarts'
import type { ResumeHold } from '@shared/agentFolders'
import { samePath } from '@shared/movePaths'
import { legacyOf, namedFolder } from './agentPlace'
import { eachAgent, sessionsToArchive, type BatchResult } from '@shared/startAll'
import { serverAddedIn } from '@shared/agentMcp'
import { shownText } from '@shared/advanced'
import { fmt, tr } from '@shared/i18n'
import { msg } from '@shared/i18n/msg'
import { HAND_OVER_TEXT } from '@shared/handOver'
import type { McpCatalogRow, McpServerInfo, ProjectInfo, ProviderId, SessionLayout, SessionListItem, SessionView, TemplateLoadPlan, ToastAction } from '@shared/types'
import type { TemplateWorkflow } from '@shared/workflow/templateOptions'
import { TEMPLATE_NAME_MAX, namesFollowKey, templateAgentNames, usesKey, type TemplateEntry, type TemplateScope } from '@shared/templates'
import { PLATFORM_NAME } from '@shared/platform/switching'
import { templateLoadDetail } from '@shared/templateLoad'
import { PRESET_TEXT } from '@shared/workflow/optionTexts'
import { WORKFLOW_ROLE_TEXT } from '@shared/workflow/roles'
import { agentNameProblem, nameTaken, nameTakenMessage, suggestTemplateAgentName, workspaceAgentList } from '@shared/agentNames'
import { formatTokens, type SessionAction } from './util'
import { movesShown } from './pendingMoves'
import { createElement } from 'react'
import { TemplateLoadNames } from './components/TemplateLoad'
import { ChooseConnectionsBody } from './components/TemplateConnections'
import { loadFallback, type ConnectionAnswers, type ConnectionsApplied } from '@shared/templateConnections'
import { McpProjectPicker } from './components/McpProjectPicker'
import { McpServerPicker } from './components/McpServerPicker'
import { AgentsDetail, batchAgentsData, projectAgentsData, tableText } from './components/AgentsTable'
import { clearEditorDraft, clearEditorDraftsUnder } from './editorDrafts'
import { keyProblemText, keysHeld } from './projectKeys'
import { cardLabel, normalKey, suggestKey } from '@shared/projectKeys'

/** Runs an async action and shows a toast if it fails. */
/**
 * A long conversation's Hand Over to… (the notice's button, the footer's size): the dialog, if the agent may still hand
 * over now (#1057; Hive checks, knowing the lanes and merge slots as they are: a notice can be old by then), else a notice
 * that it can when it has finished.
 */
export async function handOverLongConversation(path: string, agentId: string, sessionId?: string): Promise<void> {
  // From its notice, for the conversation it was about (HI-2320): another now, the notice says so, and nothing opens.
  const may = sessionId ? await call('session:handOverOffer', path, agentId, sessionId).catch(() => 'busy' as const) : (await call('session:mayHandOverNow', path, agentId).catch(() => false)) ? 'ok' : 'busy'
  if (may === 'stale') return
  if (may === 'ok') set({ handOverFor: { project: path, agentId } })
  else notify('info', tr(HAND_OVER_TEXT.notNow, { agent: findProject(get(), path)?.agents.find((a) => a.id === agentId)?.name ?? agentId }), tr(HAND_OVER_TEXT.notNowText))
}

export async function attempt<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    notify('error', title, errorMessage(e))
    return undefined
  }
}

/** What drops unsaved edits, as its callers name it (#801: each is a message's select key, not words in a sentence). */
export type UnsavedAction = 'switch workspace' | 'close the workspace' | 'reload the window'

/** The select key of an UnsavedAction. */
const unsavedKey = (a: UnsavedAction): 'switch' | 'close' | 'reload' => (a === 'switch workspace' ? 'switch' : a === 'close the workspace' ? 'close' : 'reload')

/** "Nothing to archive": a notification's title. */
const nothingToArchive = (): string => tr(msg({ id: 'actions.archive.nothing', defaultMessage: 'Nothing to archive', description: "A notification's title: the agent has no session to archive." }))

/** "Archive and start new": a button. */
const archiveAndStartNew = (): string => tr(msg({ id: 'actions.archive.confirm', defaultMessage: 'Archive and start new', description: 'Button: archives the session (or sessions) and starts a new one.' }))

/** "Could not list sessions": an error's title. */
const listFailed = (): string => tr(msg({ id: 'actions.session.listFailed', defaultMessage: 'Could not list sessions', description: "An error's title: reading a project's sessions failed." }))

/** Why a batch couldn't run an agent: its CLI is off or not installed (thrown, then listed in the batch's report). */
const providerOff = (cli: string): string => tr(msg({ id: 'actions.batch.providerOff', defaultMessage: '{cli} is turned off in Settings → Providers.', description: "Why an agent couldn't start or resume in a batch (Resume All, Start New All): its CLI ({cli}) is turned off. Settings → Providers is where: use its translated names." }), { cli })
const providerMissing = (cli: string): string => tr(msg({ id: 'actions.batch.providerMissing', defaultMessage: "{cli} isn't installed (Provider Setup).", description: "Why an agent couldn't start or resume in a batch: its CLI ({cli}) isn't installed. Provider Setup is a Help window: use its translated name." }), { cli })

/** A batch's report: each failure, then the agents it did ({done}: "Resumed: B1, B2"), one a line. */
function batchReport(failed: readonly { name: string; error: string }[], doneLine: string | null, trail: readonly string[] = []): string {
  return [...failed.map((f) => `• ${f.name}: ${f.error}`), ...(doneLine ? [doneLine] : []), ...trail].join('\n')
}

/** "Open Settings": a notification's button to Settings → Providers. */
const openSettingsLabel = (): string => tr(msg({ id: 'actions.provider.openSettings', defaultMessage: 'Open Settings', description: "A notification's button: opens Settings → Providers. Keep it short." }))

/**
 * Before something that drops unsaved edits (reloading the window, switching or closing the
 * workspace): offers to save them. False means stay (cancelled, or a file couldn't be saved).
 */
export async function saveUnsavedFirst(action: UnsavedAction): Promise<boolean> {
  const { saveAllDrafts, unsavedFiles } = await import('./components/FileView')
  const files = unsavedFiles()
  if (!files.length) return true
  const doing = unsavedKey(action)
  const ok = await confirm({
    title: tr(msg({ id: 'actions.unsaved.title', defaultMessage: 'Save your changes?', description: 'Title of the question before switching or closing the workspace, or reloading the window, while files have unsaved changes.' })),
    message: tr(
      msg({
        id: 'actions.unsaved.message',
        defaultMessage: '{n, plural, one {{file} has unsaved changes. Save it before you {action, select, switch {switch workspace} close {close the workspace} other {reload the window}}?} other {# files have unsaved changes. Save them before you {action, select, switch {switch workspace} close {close the workspace} other {reload the window}}?}}',
        description: 'The question before switching workspace (switch), closing the workspace (close) or reloading the window (other) while {n} files have unsaved changes; {file} is the one file\'s path when there is one.'
      }),
      { n: files.length, file: files[0].rel, action: doing }
    ),
    detail: files.length > 1 ? files.map((f) => f.rel).join('\n') : undefined,
    confirmLabel: tr(msg({ id: 'actions.unsaved.saveAll', defaultMessage: 'Save All', description: 'Button: saves every file with unsaved changes, then goes on.' }))
  })
  if (!ok) return false
  const r = await saveAllDrafts()
  if (r.failed.length) {
    notify('error', tr(msg({ id: 'actions.unsaved.saveFailed', defaultMessage: "Couldn't save {n, plural, one {a file} other {# files}}", description: "An error's title: saving files before switching or closing the workspace failed for {n} of them." }), { n: r.failed.length }), r.failed.map((f) => f.message).join('\n'))
    return false
  }
  // Edited while it was saving: those edits are unsaved again.
  if (unsavedFiles().length) {
    notify(
      'warning',
      tr(msg({ id: 'actions.unsaved.changedTitle', defaultMessage: 'Some files changed while they were being saved', description: "A warning's title: files were edited again while Save All saved them." })),
      tr(msg({ id: 'actions.unsaved.changedMessage', defaultMessage: 'Save them, then {action, select, switch {switch workspace} close {close the workspace} other {reload the window}} again.', description: 'Under the warning that files changed while they were saved: what to do (switch: switching workspace; close: closing it; other: reloading the window).' }), { action: doing })
    )
    return false
  }
  return true
}

export async function refreshWorkspace(): Promise<void> {
  const ws = await call('workspace:refresh')
  set({ workspace: movesShown.keep(ws) })
}

export async function openWorkspace(path?: string): Promise<void> {
  const current = get().workspace?.path
  if (current && path?.toLowerCase() !== current.toLowerCase() && !(await saveUnsavedFirst('switch workspace'))) return // i18n-ignore: an UnsavedAction key, not words shown
  const ws = await attempt(tr(msg({ id: 'actions.workspace.openFailed', defaultMessage: 'Could not open workspace', description: "An error's title: opening a workspace failed." })), () => call('workspace:open', path))
  if (ws === undefined) return
  set({ workspace: ws, recent: await call('workspace:recent') })
  if (ws && !ws.projects.some((p) => p.path === get().selectedProject)) {
    const first = ws.projects.find((p) => p.active) ?? ws.projects[0]
    set({ selectedProject: first?.path ?? null })
  }
  showView('projects')
}

/** This window's view of the recent workspaces, asked for again (whether each folder is there now; #144). */
export async function loadRecent(): Promise<void> {
  const recent = await call('workspace:recent').catch(() => null)
  if (recent) set({ recent })
}

/** Forgets a recent workspace (the folder is left alone); every window's list follows. */
export async function removeRecent(path: string): Promise<void> {
  const recent = await attempt(tr(msg({ id: 'actions.recent.removeFailed', defaultMessage: 'Could not remove it from the recent list', description: "An error's title: forgetting a recently opened workspace failed." })), () => call('workspace:removeRecent', path))
  if (recent) set({ recent })
}

/** Clears the recent workspaces, after asking; the ones open in a window stay. */
export async function clearRecent(): Promise<void> {
  const ok = await confirm({
    title: tr(msg({ id: 'actions.recent.clearTitle', defaultMessage: 'Clear recently opened workspaces?', description: 'Title of the question before forgetting the recently opened workspaces.' })),
    message: tr(msg({ id: 'actions.recent.clearMessage', defaultMessage: 'File → Open Recent and the welcome page forget them. The folders are left alone, and workspaces open in a window stay in the list.', description: 'The question before forgetting the recently opened workspaces. File → Open Recent is a menu: use its translated names.' })),
    confirmLabel: tr(msg({ id: 'actions.recent.clear', defaultMessage: 'Clear', description: 'Button: forgets the recently opened workspaces.' }))
  })
  if (!ok) return
  const recent = await attempt(tr(msg({ id: 'actions.recent.clearFailed', defaultMessage: 'Could not clear the recent list', description: "An error's title: forgetting the recently opened workspaces failed." })), () => call('workspace:clearRecent'))
  if (recent) set({ recent })
}

/**
 * Opens a recent workspace: one open in another window brings that window forward (workspace:open); one whose folder
 * can't be found (checked again now) says so and offers to forget it, rather than an error (#144).
 */
export async function openRecent(path: string): Promise<void> {
  await loadRecent()
  const entry = get().recent.find((r) => r.path.toLowerCase() === path.toLowerCase())
  if (entry && !entry.exists) {
    const remove = await confirm({
      title: tr(msg({ id: 'actions.recent.notFoundTitle', defaultMessage: 'Workspace folder not found', description: "Title of the question when a recent workspace's folder can't be found." })),
      message: tr(msg({ id: 'actions.recent.notFoundMessage', defaultMessage: "{path} can't be found. It may have been moved or deleted, or be on a drive that isn't connected.", description: "A recent workspace's folder ({path}) can't be found." }), { path }),
      confirmLabel: tr(msg({ id: 'actions.recent.removeFromRecent', defaultMessage: 'Remove from Recent', description: 'Button: forgets the recent workspace whose folder is gone.' })),
      cancelLabel: tr(msg({ id: 'actions.recent.keep', defaultMessage: 'Keep', description: 'Button: keeps the recent workspace in the list.' }))
    })
    if (remove) await removeRecent(path)
    return
  }
  await openWorkspace(path)
}

export async function createWorkspace(): Promise<void> {
  if (get().workspace && !(await saveUnsavedFirst('switch workspace'))) return // i18n-ignore: an UnsavedAction key, not words shown
  const ws = await attempt(tr(msg({ id: 'actions.workspace.createFailed', defaultMessage: 'Could not create workspace', description: "An error's title: creating a workspace failed." })), () => call('workspace:create'))
  if (ws === undefined) return
  set({ workspace: ws, recent: await call('workspace:recent'), selectedProject: ws?.projects[0]?.path ?? null })
  showView('projects')
}

export async function closeWorkspace(): Promise<void> {
  if (!(await saveUnsavedFirst('close the workspace'))) return // i18n-ignore: an UnsavedAction key, not words shown
  const ok = await attempt(tr(msg({ id: 'actions.workspace.closeFailed', defaultMessage: 'Could not close workspace', description: "An error's title: closing the workspace failed." })), () => call('workspace:close'))
  if (ok) set({ workspace: null, selectedProject: null })
}

export async function createProject(): Promise<void> {
  if (!get().workspace) return notify('warning', tr(msg({ id: 'actions.project.noWorkspace', defaultMessage: 'Open a workspace first', description: "A warning: a project can't be created without an open workspace." })))
  // Its key (#1221): suggested from the name as it is typed, until the user types one; checked as it changes.
  const held = keysHeld()
  let key = ''
  const name = await prompt({
    title: tr(msg({ id: 'actions.project.newTitle', defaultMessage: 'New Project', description: 'Title of the New Project dialog.' })),
    message: tr(msg({ id: 'actions.project.newMessage', defaultMessage: 'A new folder is created in the workspace. Combwork adds its .combwork metadata folder automatically.', description: 'The New Project dialog. Keep .combwork as it is.' })),
    placeholder: tr(msg({ id: 'actions.project.namePlaceholder', defaultMessage: 'project-name', description: "Placeholder of the New Project dialog's name box: an example folder name (lower case, a dash)." })),
    confirmLabel: tr(msg({ id: 'actions.project.create', defaultMessage: 'Create', description: 'Button: creates the project.' })),
    validate: (v) =>
      !v.trim()
        ? tr(msg({ id: 'actions.project.nameEmpty', defaultMessage: 'Enter a name', description: "Why a new project's name can't be used: it is empty." }))
        : /[<>:"/\\|?*]/.test(v)
          ? tr(msg({ id: 'actions.project.nameChars', defaultMessage: 'Names cannot contain {chars}', description: "Why a new project's name can't be used: it has a character Windows doesn't allow in a folder name ({chars}: the characters)." }), { chars: '< > : " / \\ | ? *' })
          : v.trim().startsWith('.')
            ? tr(msg({ id: 'actions.project.nameDot', defaultMessage: 'Names cannot start with "."', description: "Why a new project's name can't be used: it starts with a dot." }))
            : null,
    second: {
      label: tr(msg({ id: 'actions.project.key', defaultMessage: 'Key', description: "The New Project dialog: the label of the project's key box (2–4 letters, such as AM, that its cards are named by: AM-12)." })),
      hint: (k) => (normalKey(k) ? tr(msg({ id: 'actions.project.keyHint', defaultMessage: 'Its cards are named {first}, {second} and so on. You can change the key later in Project Settings.', description: 'Under the key box of the New Project dialog. {first} and {second} are the first two card names with the key typed, such as AM-1 and AM-2.' }), { first: `${normalKey(k)}-1`, second: `${normalKey(k)}-2` }) : ''),
      follow: (v) => (v.trim() ? suggestKey(v.trim(), '', held) : ''),
      // Left empty, Hive suggests one, as for a folder opened.
      validate: (k) => (k.trim() ? keyProblemText(k, '', held) : null),
      set: (k) => (key = k)
    }
  })
  if (!name) return
  const ws = await attempt(tr(msg({ id: 'actions.project.createFailed', defaultMessage: 'Could not create project', description: "An error's title: creating a project failed." })), () => call('project:create', name.trim(), normalKey(key) || null))
  if (!ws) return
  const created = ws.projects.find((p) => p.name === name.trim())
  set({ workspace: ws, selectedProject: created?.path ?? get().selectedProject })
  showView('projects')
  // Its Version Control tab, at "How do you work?" (#1423): no notice for it, the step is in front of the user.
  if (created) {
    set({ presetStepShown: [...get().presetStepShown, created.path] })
    openVersionControl(created.path, 'workflow')
  }
  notify('success', tr(msg({ id: 'actions.project.created', defaultMessage: 'Project "{name}" created', description: 'A notification: a new project ({name}) was created.' }), { name: name.trim() }))
}

export function selectProject(path: string): void {
  set({ selectedProject: path })
  if (get().activity !== 'projects') setActivity('projects')
}

const project = (path: string): ProjectInfo | undefined => findProject(get(), path) ?? undefined

export async function setProjectActive(path: string, active: boolean): Promise<void> {
  const failed = active
    ? tr(msg({ id: 'actions.project.activateFailed', defaultMessage: 'Could not activate project', description: "An error's title: marking a project active failed." }))
    : tr(msg({ id: 'actions.project.deactivateFailed', defaultMessage: 'Could not deactivate project', description: "An error's title: marking a project inactive failed." }))
  const ws = await attempt(failed, async () => {
    const p = project(path)
    const running = p?.agents.filter((a) => a.live).length ?? 0
    if (!active && running) {
      const ok = await confirm({
        title: tr(msg({ id: 'actions.project.deactivateTitle', defaultMessage: '{n, plural, one {Stop session and deactivate?} other {Stop agents and deactivate?}}', description: 'Title of the question before marking a project inactive while {n} of its agents run.' }), { n: running }),
        message: tr(msg({ id: 'actions.project.deactivateMessage', defaultMessage: '{n, plural, one {{project} has a running session.} other {{project} has # agents running.}}', description: 'The question before marking a project ({project}) inactive while {n} of its agents run.' }), { n: running, project: p!.name }),
        detail: tr(msg({ id: 'actions.project.deactivateDetail', defaultMessage: '{n, plural, one {The session is} other {They are}} stopped (and can be resumed later) and the project is marked inactive.', description: 'Under the question before marking a project inactive: what happens to its {n} running agents.' }), { n: running }),
        confirmLabel: tr(msg({ id: 'actions.project.stopAndDeactivate', defaultMessage: 'Stop and deactivate', description: "Button: stops the project's agents and marks it inactive." })),
        danger: true,
        action: 'stop'
      })
      if (!ok) return undefined
      await call('session:stop', path)
      await waitForStop(path)
    }
    return call('project:setActive', path, active)
  })
  if (ws) set({ workspace: movesShown.keep(ws) })
}

/** Waits until an agent's session (or, without agentId, every agent of the project) has stopped. */
export async function waitForStop(path: string, agentId?: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const live = await call('session:live')
    if (!live.some((l) => l.projectPath.toLowerCase() === path.toLowerCase() && (!agentId || l.agentId === agentId))) return
    await new Promise((r) => setTimeout(r, 150))
  }
}

/**
 * The agent's provider (for a resume, the conversation's: #506) is turned on and installed; otherwise says so (or opens
 * its setup) and returns false.
 */
async function ensureAgent(path: string, agentId: string, resumes?: ProviderId): Promise<boolean> {
  const a = (): ReturnType<typeof agentOf> => agentOf(project(path), agentId)
  // Automatic's pick matters only to an agent that follows it and isn't running (a running one has its provider).
  const provider = await detectedProvider(
    () => resumes ?? agentProviderOf(a()),
    () => !resumes && !a()?.live && !a()?.provider && autoProviderPending(get().settings)
  )
  if (!provider) return false
  const name = providerName(provider)
  if (!isProviderEnabled(get().settings, provider)) {
    notify(
      'warning',
      tr(msg({ id: 'actions.provider.offTitle', defaultMessage: '{cli} is turned off', description: "A warning's title: the agent's CLI ({cli}: \"Claude Code\") is turned off in Settings." }), { cli: name }),
      tr(msg({ id: 'actions.provider.offAgent', defaultMessage: 'Turn it on in Settings → Providers to run this agent, or give the agent another provider in its settings.', description: "Under the warning that an agent's CLI is turned off. Settings → Providers is where: use its translated names." })),
      [{ label: openSettingsLabel(), command: 'settings.providers' }]
    )
    return false
  }
  if (!get().providers[provider]?.found) {
    set({ setupOpen: provider })
    return false
  }
  return ensureWorktree(path, agentId)
}

/**
 * A provider once Hive has looked for the CLIs it depends on (#506), at most 20 s: at start, Automatic's pick (when
 * `auto` says it is used) and whether a CLI is installed aren't known yet, and deciding then would pick the wrong
 * provider or open Provider Setup. Null, said to the user, when Hive is still looking after that: nothing is decided from a guess.
 */
/**
 * The connection a new agent gets (firstReadyConnection), once Hive knows whether the CLIs before it are installed: null
 * (and said) when it still doesn't after 20 s.
 */
async function readyConnection(view: Parameters<typeof firstReadyConnection>[0], cli?: ProviderId): Promise<{ id?: string } | null> {
  const now = (): ReturnType<typeof firstReadyConnection> => firstReadyConnection(view, get().settings, cliReadyOf(get().providers), cli)
  if (!now().checking) return now()
  const ok = await new Promise<boolean>((done) => {
    const stop = (v: boolean): void => {
      clearTimeout(timer)
      unsubscribe()
      done(v)
    }
    const timer = setTimeout(() => stop(false), 20_000)
    const unsubscribe = useStore.subscribe(() => {
      if (!now().checking) stop(true)
    })
  })
  if (ok) return now()
  notify('warning', tr(LOOKING.title), tr(LOOKING.message))
  return null
}

async function detectedProvider(resolve: () => ProviderId, auto: () => boolean): Promise<ProviderId | null> {
  const settled = (): boolean => {
    const i = get().providers[resolve()]
    return !auto() && !!i && (i.found || !i.checking)
  }
  if (settled()) return resolve()
  const ok = await new Promise<boolean>((done) => {
    const stop = (v: boolean): void => {
      clearTimeout(timer)
      unsubscribe()
      done(v)
    }
    const timer = setTimeout(() => stop(false), 20_000)
    const unsubscribe = useStore.subscribe(() => {
      if (settled()) stop(true)
    })
  })
  if (ok) return resolve()
  notify('warning', tr(LOOKING.title), tr(LOOKING.message))
  return null
}

/** Said when Hive hasn't finished finding which CLIs are installed. */
const LOOKING = {
  title: msg({ id: 'actions.provider.lookingTitle', defaultMessage: 'Still looking for the coding agents', description: "A warning's title: Hive hasn't finished finding which coding agent CLIs are installed." }),
  message: msg({ id: 'actions.provider.lookingMessage', defaultMessage: 'Combwork is still finding out which coding agent CLIs are installed. Try again in a moment.', description: 'Under the warning that Hive is still looking for the coding agent CLIs.' })
}

/**
 * A slot the agent holds whose folder is gone (#1447): made again on its line, with its commits, and the agent started,
 * its lease kept; or released (the slot is made again at its next lease) when its line is gone or the user prefers.
 */
async function goneSlot(path: string, agentId: string, gone: { agentName: string; path: string; branch: string; branchExists: boolean; slot?: string }): Promise<boolean> {
  const release = { label: tr(msg({ id: 'actions.slot.release', defaultMessage: 'Release the Slot', description: "Button: the agent gives up the slot whose folder is gone; Hive makes the slot again the next time it lends it." })), value: 'release' }
  const choice = await choose({
    title: tr(msg({ id: 'actions.slot.goneTitle', defaultMessage: 'The slot is gone', description: "Title of the question when the folder of a slot an agent holds (a working folder Hive lends it for a card or lane) is missing." })),
    message: gone.branchExists
      ? tr(msg({ id: 'actions.slot.goneMessage', defaultMessage: "{agent}'s slot {slot} is missing its folder ({path}). Its branch {branch} is still in the repository: make the slot again on it, with its commits, and start?", description: "The question when a slot's ({slot}) folder ({path}) is missing; the agent ({agent}) holds it, and its branch ({branch}) is still there." }), { agent: gone.agentName, slot: gone.slot ?? '', path: gone.path, branch: gone.branch })
      : tr(msg({ id: 'actions.slot.goneNoBranch', defaultMessage: "{agent}'s slot {slot} is missing its folder ({path}), and its branch is gone too. Release the slot? Combwork makes it again the next time it lends it.", description: "The question when a slot's ({slot}) folder ({path}) and its branch are missing; the agent ({agent}) holds it." }), { agent: gone.agentName, slot: gone.slot ?? '', path: gone.path }),
    detail: tr(msg({ id: 'actions.slot.goneDetail', defaultMessage: 'If the workspace moved, Repair… in its banner can also locate the folder.', description: "Under the question when a slot's folder is missing: Repair… is a button in the workspace's banner." })),
    choices: gone.branchExists ? [release, { label: tr(msg({ id: 'actions.slot.recreate', defaultMessage: 'Recreate and Start', description: 'Button: makes the slot again on its branch and starts the agent.' })), value: 'recreate' }] : [release]
  })
  if (choice === 'release') {
    await attempt(tr(msg({ id: 'actions.slot.releaseFailed', defaultMessage: 'Could not release the slot', description: "An error's title: releasing a slot whose folder is gone failed." })), () => call('agents:unlinkWorktree', path, agentId))
    return false
  }
  if (choice !== 'recreate') return false
  return !!(await attempt(tr(msg({ id: 'actions.slot.recreateFailed', defaultMessage: 'Could not make the slot again', description: "An error's title: making a slot whose folder was gone again failed." })), () => call('agents:recreateWorktree', path, agentId)))
}

/**
 * A worktree agent whose folder is gone (#146): its branch lives in the repository, so the worktree can be made again
 * on it before the agent starts (or, with the branch gone too, made new from its base, or the link removed). An agent
 * whose 0.9 worktree was missing at the 1.0 upgrade isn't migrated (#1441), so this is still its way back; a slot it
 * holds is #1447's (`goneSlot`).
 */
async function ensureWorktree(path: string, agentId: string): Promise<boolean> {
  // Its 0.9 worktree, or a slot it holds (#1447): asked of main for every agent, since a slot isn't on the agent.
  if (!agentOf(project(path), agentId)) return true
  const gone = await call('agents:missingWorktree', path, agentId).catch(() => null)
  if (!gone) return true
  if (gone.slot) return goneSlot(path, agentId, gone)
  const setup = tr(msg({ id: 'actions.worktree.setup', defaultMessage: "Combwork copies in the files it copies into new worktrees, and the project's worktree setup command, if it has one, runs before the agent starts. Nothing is deleted.", description: "Under the question before recreating an agent's missing worktree: what making it again involves." }))
  if (gone.branchExists) {
    return confirm({
      title: tr(msg({ id: 'actions.worktree.recreateTitle', defaultMessage: 'Recreate the worktree?', description: "Title of the question when a worktree agent's folder is missing but its branch is there." })),
      message: tr(msg({ id: 'actions.worktree.recreateMessage', defaultMessage: "{agent}'s worktree folder is missing: {path}. Its branch {branch} is still in the repository: recreate the worktree on it, with its commits, and start?", description: "The question when a worktree agent's ({agent}) folder ({path}) is missing but its git branch ({branch}) is there." }), { agent: gone.agentName, path: gone.path, branch: gone.branch }),
      detail: setup,
      confirmLabel: tr(msg({ id: 'actions.worktree.recreate', defaultMessage: 'Recreate and Start', description: "Button: makes the agent's worktree again on its branch and starts the agent." })),
      action: 'start',
      busyLabel: tr(msg({ id: 'actions.worktree.recreating', defaultMessage: 'Recreating…', description: 'The Recreate and Start button while it works.' })),
      run: () => call('agents:recreateWorktree', path, agentId)
    })
  }
  const choice = await choose({
    title: tr(msg({ id: 'actions.worktree.goneTitle', defaultMessage: 'The worktree is gone', description: "Title of the question when a worktree agent's folder and branch are both gone." })),
    message: tr(msg({ id: 'actions.worktree.goneMessage', defaultMessage: "{agent}'s worktree folder is missing ({path}), and its branch {branch} is gone too. Create a new worktree on {branch} from {base}, or remove the agent's worktree link so it works in the project folder?", description: "The question when a worktree agent's ({agent}) folder ({path}) and git branch ({branch}) are gone: make a new worktree on that branch from {base}, or have the agent work in the project folder." }), { agent: gone.agentName, path: gone.path, branch: gone.branch, base: gone.base }),
    detail: tr(msg({ id: 'actions.worktree.goneDetail', defaultMessage: '{setup} If the workspace moved, Repair… in its banner can also locate the folder.', description: "Under the question when a worktree agent's folder and branch are gone: {setup} is what making it again involves; Repair… is a button in the workspace's banner." }), { setup }),
    choices: [
      { label: tr(msg({ id: 'actions.worktree.unlink', defaultMessage: 'Remove the Worktree Link', description: 'Button: the agent works in the project folder from now on.' })), value: 'unlink' },
      { label: tr(msg({ id: 'actions.worktree.createNew', defaultMessage: 'Create a New Worktree', description: 'Button: makes a new worktree for the agent.' })), value: 'create' }
    ]
  })
  if (choice === 'unlink') {
    await attempt(tr(msg({ id: 'actions.worktree.unlinkFailed', defaultMessage: 'Could not remove the worktree link', description: "An error's title: removing an agent's worktree link failed." })), () => call('agents:unlinkWorktree', path, agentId))
    return false
  }
  if (choice !== 'create') return false
  return !!(await attempt(tr(msg({ id: 'actions.worktree.createFailed', defaultMessage: 'Could not create the worktree', description: "An error's title: making an agent's worktree again failed." })), () => call('agents:recreateWorktree', path, agentId)))
}

/**
 * Add Agent's quick add: an agent with the project's default provider and default settings, in the project
 * folder. When that provider is off or not installed, opens the Add Agent dialog instead. Returns the new
 * agent's id, or null.
 */
export async function quickAddAgent(path: string | null = get().selectedProject, forProvider?: ProviderId): Promise<string | null> {
  if (!path) return null
  const p = project(path)
  const limit = agentLimit(p)
  if (p && p.agents.length >= limit) {
    // At its Maximum agents (HI-2058), the way to raise it; at the most any project has, removing one is the only way.
    const raise = limit < AGENT_LIMIT_MAX ? [{ label: tr(OPEN_WORKFLOW_OPTIONS), command: 'project.openVersionControl', args: [p.path, 'workflow'] }] : undefined
    notify('warning', tr(msg({ id: 'actions.agent.noRoom', defaultMessage: 'No room for another agent', description: "A warning's title: the project has as many agents as it may have." })), raise ? agentLimitText(tr, limit) : tr(msg({ id: 'actions.agent.noRoomMessage', defaultMessage: '{why} Remove one first.', description: 'Under the warning that a project has no room for another agent: {why} says the limit and where it is set.' }), { why: agentLimitText(tr) }), raise)
    return null
  }
  // Decision A (HI-2108): the first usable connection in the order of accounts (a session's CLI's, when resuming one),
  // its CLI on and installed, as main's firstUsableAccount: waited for while Hive still looks for a CLI before it. Its CLI
  // follows from it. Connections here but none on an installed CLI: the dialog, which says why. None usable here (no
  // account on, or a test copy on its CLI test home): the first CLI on and installed, as main's prepareAgent.
  const view = await call('connections:list').catch(() => null)
  const first = await readyConnection(view, forProvider)
  if (!first) return null
  if (!first.id && offeredConnections(view, get().settings, forProvider).length) {
    set({ addAgentFor: path })
    return null
  }
  const connection = first.id
  const provider = connection
    ? undefined
    : await detectedProvider(
        () => forProvider ?? autoProvider(get().settings),
        () => !forProvider && autoProviderPending(get().settings)
      )
  if (!connection && !provider) return null
  if (provider && (!isProviderEnabled(get().settings, provider) || !get().providers[provider]?.found)) {
    set({ addAgentFor: path })
    return null
  }
  const def = await attempt(tr(msg({ id: 'actions.agent.addFailed', defaultMessage: 'Could not add an agent', description: "An error's title: adding an agent failed." })), () => call('agents:add', path, connection ? { connection } : { provider: provider ?? undefined }))
  if (!def) return null
  await refreshWorkspace()
  noteManyAgents(path)
  const now = project(path)
  // Its pane; in the Tiles view its tile (#976), not its focus view.
  if (now) showAgent(now, def.id, 'select')
  return def.id
}

/** After adding an agent: the seventh brings a note that each agent is its own CLI process. */
export function noteManyAgents(path: string): void {
  const n = project(path)?.agents.length ?? 0
  if (n === MANY_AGENTS) notify('info', tr(msg({ id: 'actions.agent.manyTitle', defaultMessage: '{n} agents in this project', description: "A notification's title when a project gets its seventh agent ({n})." }), { n }), tr(msg({ id: 'actions.agent.manyMessage', defaultMessage: "Each agent runs its own copy of its CLI (roughly 200–500 MB of memory each), and they all share your plan's usage limits.", description: 'Under the notification that a project has many agents: what each costs.' })))
}

/** " (Agent 2)" in projects with several agents, else nothing — for dialog wording. */
/** The agent a question names (`named: 'yes'`) when its project has several, else none. */
function agentNamed(p: ProjectInfo | undefined, agentId: string): { named: string; agent: string } {
  const a = agentOf(p, agentId)
  return (p?.agents.length ?? 1) > 1 && a ? { named: 'yes', agent: a.name } : { named: 'no', agent: '' }
}

/** What stopIfRunning asks before: a new session, resuming one, or removing the agent (its name). */
type StopFor = { what: 'new' } | { what: 'resume' } | { what: 'remove'; agent: string }

async function stopIfRunning(path: string, agentId: string, action: StopFor, then: SessionAction): Promise<boolean> {
  const p = project(path)
  // Main's word, not the window's copy: just after a session stops, main saves its record before it tells the window,
  // so the copy can still show it running (Restart session then asked to stop a session already stopped, #218).
  const running = (await call('session:live')).some((l) => l.projectPath.toLowerCase() === path.toLowerCase() && l.agentId === agentId)
  if (!running) return true
  const values = { what: action.what, agent: action.what === 'remove' ? action.agent : '' }
  const ok = await confirm({
    title: tr(msg({ id: 'actions.stopFirst.title', defaultMessage: '{what, select, new {Start a new session?} resume {Resume this session?} other {Remove {agent}?}}', description: 'Title of the question before starting a new session (new), resuming one (resume) or removing an agent ({agent}; other) while it runs.' }), values),
    message: tr(msg({ id: 'actions.stopFirst.message', defaultMessage: '{named, select, yes {{agent} in {project} already has a running session.} other {{project} already has a running session.}}', description: 'The question before replacing or removing a running session: the project ({project}) and, when it has several agents, the agent ({agent}: its name; named: yes).' }), { project: p!.name, ...agentNamed(p, agentId) }),
    detail: tr(msg({ id: 'actions.stopFirst.detail', defaultMessage: 'It will be stopped first. Its conversation is kept and can be resumed from the Sessions tab.', description: 'Under the question before replacing or removing a running session.' })),
    confirmLabel: tr(msg({ id: 'actions.stopFirst.confirm', defaultMessage: '{what, select, new {Stop and start a new session} resume {Stop and resume this session} other {Stop and remove {agent}}}', description: 'Button: stops the running session, then starts a new one (new), resumes this one (resume), or removes the agent ({agent}; other).' }), values),
    // In the colour of what it goes on to do (#344).
    action: then
  })
  if (!ok) return false
  await call('session:stop', path, agentId)
  await waitForStop(path, agentId)
  return true
}

function reveal(path: string, agentId: string): void {
  // The Hive Assistant lives in its own panel.
  if (isAssistantPath(path)) return setAssistantOpen(true)
  setProjectTab(path, 'session')
  set({ selectedProject: path })
  const p = project(path)
  if (p) showAgent(p, agentId)
}

export async function newSession(path: string | null = get().selectedProject, agentId?: string, opts: { skipSetup?: boolean } = {}): Promise<void> {
  if (!path) return
  // Its buttons show it starting from the click until it runs (#1177), while a project without agents gets one (the
  // quick add) too.
  const what = { kind: 'start' as const, ...(opts.skipSetup ? { skipSetup: true } : {}) }
  const known = agentId ?? focusedAgentId(project(path))
  if (known) return void (await whileStarting(path, known, what, () => startNew(path, known, opts)))
  await whileStarting(path, ADDING_AGENT, what, async () => {
    const id = await quickAddAgent(path)
    if (id) await whileStarting(path, id, what, () => startNew(path, id, opts))
  })
}

async function startNew(path: string, id: string, opts: { skipSetup?: boolean }): Promise<void> {
  if (!(await ensureAgent(path, id))) return
  if (!(await stopIfRunning(path, id, { what: 'new' }, 'start'))) return
  const st = await attempt(tr(msg({ id: 'actions.session.startFailed', defaultMessage: 'Could not start session', description: "An error's title: starting a session failed." })), () => call('session:start', path, { agentId: id, skipSetup: opts.skipSetup }))
  if (st) reveal(path, id)
}

/**
 * Which agent resumes a session. A session runs in the folder it started in, and always in the provider that recorded
 * it, whatever the agent's provider is now (#506), so one from a worktree goes back to the agent working there (null if
 * none does). For the project folder: the agent asked for, else one that isn't running — the agent that last ran it,
 * the focused one, another of its provider, any other in the folder — else the agent that ran it.
 */
export function resumeTarget(p: ProjectInfo | undefined, item: Pick<SessionListItem, 'agentId' | 'cwd' | 'slot'> & { provider?: ProviderId }, preferred?: string): string | null {
  if (!p) return preferred ?? null
  // The Hive Assistant's sessions ran in the workspace folder, with its one agent.
  if (isAssistantPath(p.path)) return p.agents[0]?.id ?? null
  // One in a slot resumes with its own agent (#1434: one writer per slot), if it is still there.
  if (item.slot) return p.agents.find((a) => a.id === item.agentId)?.id ?? null
  // One in a 0.9 worktree resumes with the agent still working there; one in a retired home with its own agent (#1442).
  const cwd = item.cwd
  if (cwd && !samePath(cwd, p.path)) return p.agents.find((x) => { const l = legacyOf(x); return !!l && samePath(l.path, cwd) })?.id ?? (namedFolder(p, cwd)?.is === 'home' ? (p.agents.find((a) => a.id === item.agentId)?.id ?? null) : null)
  // An agent on its 0.9 worktree works only there; any other can resume a conversation of the project folder there.
  const inFolder = (id: string | undefined): boolean => !!id && p.agents.some((a) => a.id === id && !legacyOf(a))
  const free = (id: string | undefined): boolean => inFolder(id) && !agentOf(p, id!)?.live
  if (inFolder(preferred)) return preferred!
  const recorded = item.agentId
  const focused = focusedAgentId(p) ?? undefined
  if (free(recorded)) return recorded!
  if (free(focused)) return focused!
  const idle = p.agents.filter((a) => !legacyOf(a) && !a.live)
  const other = (idle.find((a) => item.provider && agentProviderOf(a) === item.provider) ?? idle[0])?.id
  return other ?? (inFolder(recorded) ? recorded! : (p.agents.find((a) => !legacyOf(a))?.id ?? null))
}

/**
 * Agents that can run a session: those working in the folder it ran in (it runs in its own provider in any of them); one
 * in a slot only its own agent (#1434: one writer per slot).
 */
export function agentsForSession(p: ProjectInfo, item: Pick<SessionListItem, 'cwd' | 'slot' | 'agentId'>): ProjectInfo['agents'] {
  if (item.slot) return p.agents.filter((a) => a.id === item.agentId)
  return p.agents.filter((a) => sessionInAgentFolder(p.path, a, item))
}

type ResumeItem = Pick<SessionListItem, 'id' | 'recache' | 'title' | 'name' | 'agentId' | 'agentName' | 'cwd' | 'slot' | 'hold'> & { provider?: ProviderId }

export async function resumeSession(path: string, item: ResumeItem, agentId?: string): Promise<void> {
  // Its buttons show it resuming from the click until it runs (#1177): under its agent, or, with none to run it yet,
  // under the session itself while one is added for it.
  const target = resumeTarget(project(path), item, agentId)
  await whileStarting(path, target ?? `${ADDING_AGENT}:${item.id}`, { kind: 'resume', sessionId: item.id }, () => resume(path, item, target, agentId))
}

/** Resumes it in its agent; `held` is the agent already shown resuming (another one added for it is shown too). */
async function resume(path: string, item: ResumeItem, held: string | null, agentId?: string): Promise<void> {
  let p = project(path)
  let target = resumeTarget(p, item, agentId)
  // A session from the project folder, and the project has no agent there: add one of its provider.
  const inProjectFolder = !item.cwd || item.cwd.toLowerCase() === path.toLowerCase()
  if (!target && isAssistantPath(path)) return
  if (!target && inProjectFolder && item.provider && (p?.agents.length ?? 0) < agentLimit(p)) {
    target = await quickAddAgent(path, item.provider)
    if (!target) return
    p = project(path)
  }
  if (target && target !== held) {
    const added = target
    return void (await whileStarting(path, added, { kind: 'resume', sessionId: item.id }, () => resume(path, item, added, added)))
  }
  if (!target) {
    const inWorktree = item.cwd && p && item.cwd.toLowerCase() !== p.path.toLowerCase()
    notify(
      'warning',
      tr(msg({ id: 'actions.resume.cantTitle', defaultMessage: "Can't resume this session", description: "A warning's title: no agent can resume the session." })),
      inWorktree
        ? tr(msg({ id: 'actions.resume.cantWorktree', defaultMessage: 'It ran in a worktree no agent uses any more ({folder}). Add an agent for that worktree (Add Agent → existing worktree) to resume it.', description: "Why a session can't be resumed: no agent works in the worktree folder it ran in ({folder}). Add Agent → existing worktree is where: use the translated names." }), { folder: item.cwd ?? '' })
        : tr(msg({ id: 'actions.resume.cantFolder', defaultMessage: 'It ran in the project folder, and no agent works there. Add an agent to resume it (it runs in {cli, select, none {its provider} other {{cli}}}).', description: "Why a session can't be resumed: no agent works in the project folder; it runs in its CLI ({cli}: \"Claude Code\"; none when unknown)." }), { cli: item.provider ? providerName(item.provider) : 'none' })
    )
    return
  }
  if (!(await ensureAgent(path, target, item.provider))) return
  // One conversation can't run in two terminals: show the agent that has it open instead.
  const holder = p?.agents.find((a) => a.live?.sessionId === item.id)
  if (p && holder && holder.id !== target) {
    revealAgent(p, holder.id)
    notify('info', tr(msg({ id: 'actions.resume.alreadyOpen', defaultMessage: 'Already open', description: "A notification's title: the conversation is open in another agent." })), tr(msg({ id: 'actions.resume.alreadyOpenMessage', defaultMessage: 'This conversation is open in {agent}. An agent can only resume a session no other agent is running.', description: 'Under the notification that a conversation is open in another agent ({agent}).' }), { agent: holder.name }))
    return
  }
  if (item.recache && !item.recache.warm && item.recache.tokens > 20000) {
    // The Hive Assistant's are conversations; an agent's are sessions.
    const what = isAssistantPath(path) ? 'conversation' : 'session'
    const choice = await choose({
      title: tr(msg({ id: 'actions.recache.title', defaultMessage: '{what, select, conversation {Resume conversation?} other {Resume session?}}', description: "Title of the question before resuming a session (other) or an Assistant conversation whose prompt cache expired." }), { what }),
      message: tr(msg({ id: 'actions.recache.message', defaultMessage: '{what, select, conversation {The prompt cache for this conversation has expired.} other {The prompt cache for this session has expired.}} Resuming will re-cache about {tokens} tokens on the first message.', description: "The question before resuming a session whose prompt cache expired: resuming costs about {tokens} tokens (\"120K\") again." }), { what, tokens: formatTokens(item.recache.tokens) }),
      detail: tr(msg({ id: 'actions.recache.detail', defaultMessage: '{what, select, conversation {To save tokens, archive it and start a fresh conversation instead. The archived one stays readable.} other {To save tokens, archive it and start a fresh session instead. The archived one stays readable, and a handover note can carry the work on.}}', description: 'Under the question before resuming a session (other) or an Assistant conversation whose prompt cache expired.' }), { what }),
      choices: [
        { label: tr(msg({ id: 'actions.recache.fresh', defaultMessage: 'Archive and Start Fresh', description: 'Button: archives the session and starts a new one.' })), value: 'fresh', action: 'archive-start' },
        { label: tr(msg({ id: 'actions.recache.resume', defaultMessage: 'Resume', description: 'Button: resumes the session anyway.' })), value: 'resume', action: 'resume' }
      ]
    })
    if (!choice) return
    if (choice === 'fresh') {
      const archived = await attempt(tr(msg({ id: 'actions.recache.archiveFailed', defaultMessage: '{what, select, conversation {Could not archive conversation} other {Could not archive session}}', description: "An error's title: archiving a session (other) or an Assistant conversation failed." }), { what }), () => call('session:archive', path, item.id, true).then(() => true))
      if (archived) await startNew(path, target, {})
      return
    }
  }
  // Its slot holds other work, or isn't as it left it (#1434): said with what can be done instead, before anything stops.
  if (item.hold && item.hold.is !== 'byHand') return heldResume(path, item, item.hold, target)
  if (!(await stopIfRunning(path, target, { what: 'resume' }, 'resume'))) return
  const st = await attempt(tr(msg({ id: 'actions.session.resumeFailed', defaultMessage: 'Could not resume session', description: "An error's title: resuming a session failed." })), () => call('session:start', path, { resumeId: item.id, name: item.name, agentId: target }))
  if (st) reveal(path, target)
}

/**
 * A conversation that can't resume where it was made (#1434): why, with its transcript to read (the Sessions tab) or a
 * fresh start from a handover for its agent (Hand Over to…), whose new conversation starts where the agent works now.
 */
function heldResume(path: string, item: ResumeItem, hold: ResumeHold, agentId: string): void {
  const agent = agentOf(project(path), agentId)?.name ?? item.agentName ?? ''
  notify('warning', tr(msg({ id: 'actions.resume.heldTitle', defaultMessage: "Can't resume here now", description: "A warning's title (#1434): the conversation can't resume in the slot it ran in (the message says why: its slot holds other work, changed, or its agent builds elsewhere)." })), shownText(holdText(hold, agent)), [
    { label: tr(msg({ id: 'actions.resume.readTranscript', defaultMessage: 'Read Transcript', description: "A button in the warning that a conversation can't resume where it ran (#1434): opens it in the Sessions tab." })), command: 'session.showTranscript', args: [path, item.id] },
    { label: tr(msg({ id: 'actions.resume.startFresh', defaultMessage: 'Start Fresh with a Handover', description: "A button in the warning that a conversation can't resume where it ran (#1434): opens Hand Over to… for its agent, which starts a new conversation from a handover." })), command: 'session.handOverTo', args: [path, agentId] }
  ])
}

export async function resumeLast(path: string | null = get().selectedProject, agentId?: string): Promise<void> {
  if (!path) return
  // From the click, while it reads the sessions too (#1177), and while a project without agents gets one (the quick
  // add), which resumes the latest session it can.
  const known = agentId ?? focusedAgentId(project(path))
  const latest = (id: string): Promise<void | undefined> => whileStarting(path, id, { kind: 'resume', sessionId: agentOf(project(path), id)?.resume?.id }, () => resumeLatest(path, id))
  if (known) return void (await latest(known))
  await whileStarting(path, ADDING_AGENT, { kind: 'resume' }, async () => {
    const id = await quickAddAgent(path)
    if (id) await latest(id)
  })
}

async function resumeLatest(path: string, id: string): Promise<void> {
  const p = project(path)
  const a = agentOf(p, id)
  // Hive works out the session in the main process (AgentInfo.resume), skipping any open in another agent.
  const list = a?.resume ? await attempt(listFailed(), () => call('session:list', path)) : []
  const last = a?.resume ? (list ?? []).find((s) => s.id === a.resume!.id) ?? { id: a.resume.id, name: a.resume.name, title: null, recache: null, agentId: id, cwd: legacyOf(a)?.path, provider: agentProviderOf(a) } : null
  if (!last) {
    notify(
      'info',
      tr(msg({ id: 'actions.resume.noneTitle', defaultMessage: 'No previous session', description: "A notification's title: there is no session to resume." })),
      tr(msg({ id: 'actions.resume.noneMessage', defaultMessage: '{agent, select, none {There is no session to resume.} other {{agent} has no session to resume.}} Start a new one instead.', description: 'Under the notification that there is no session to resume: the agent ({agent}; none in a project with one agent).' }), { agent: (p?.agents.length ?? 1) > 1 && a ? a.name : 'none' })
    )
    return
  }
  await resume(path, last, id, id)
}

export async function stopSession(path: string | null = get().selectedProject, agentId?: string): Promise<void> {
  if (!path) return
  const p = project(path)
  const id = agentId ?? focusedAgentId(p)
  if (!id || !agentOf(p, id)?.live) return
  if (get().settings?.sessions.confirmStop) {
    const ok = await confirm({
      title: tr(msg({ id: 'actions.stop.title', defaultMessage: 'Stop session?', description: 'Title of the question before stopping a session.' })),
      message: tr(msg({ id: 'actions.stop.message', defaultMessage: '{named, select, yes {Stop the running session of {agent} in {project}?} other {Stop the running session in {project}?}}', description: 'The question before stopping a session: the project ({project}) and, when it has several agents, the agent ({agent}: its name; named: yes).' }), { project: p!.name, ...agentNamed(p, id) }),
      detail: tr(msg({ id: 'actions.stop.detail', defaultMessage: 'The conversation is kept and can be resumed later.', description: 'Under the question before stopping a session.' })),
      confirmLabel: tr(msg({ id: 'actions.stop.confirm', defaultMessage: 'Stop', description: 'Button: stops the session.' })),
      danger: true,
      action: 'stop'
    })
    if (!ok) return
  }
  await attempt(tr(msg({ id: 'actions.stop.failed', defaultMessage: 'Could not stop session', description: "An error's title: stopping a session failed." })), () => call('session:stop', path, id))
}

export async function stopAllAgents(path: string): Promise<void> {
  const p = project(path)
  const running = p?.agents.filter((a) => a.live) ?? []
  if (!running.length) return
  // Always asks, naming each agent that will stop, what it's doing and its card, as a table (#572).
  // The question stays open, with a spinner, until they have stopped.
  const data = projectAgentsData(p!, get().tasks, [], running.map((a) => a.id))
  const lines = tableText(data)
  const note = tr(msg({ id: 'actions.stopAll.note', defaultMessage: 'Their conversations are kept and can be resumed later.', description: 'Under the table of agents Stop All stops.' }))
  const n = running.length
  await confirm({
    title: tr(msg({ id: 'actions.stopAll.title', defaultMessage: '{n, plural, one {Stop the agent?} other {Stop all agents?}}', description: "Title of Stop All's question: {n} agents run." }), { n }),
    message: tr(msg({ id: 'actions.stopAll.message', defaultMessage: '{n, plural, one {This agent stops in {project}:} other {These # agents stop in {project}:}}', description: "Stop All's question, above the table of the {n} running agents of a project ({project})." }), { n, project: p!.name }),
    detail: `${lines}\n\n${note}`,
    content: createElement(AgentsDetail, { data, note }),
    wide: true,
    confirmLabel: tr(msg({ id: 'actions.stopAll.confirm', defaultMessage: '{n, plural, one {Stop} other {Stop all}}', description: "Stop All's button ({n} agents)." }), { n }),
    busyLabel: tr(msg({ id: 'actions.stopAll.busy', defaultMessage: 'Stopping…', description: "Stop All's button while the agents stop." })),
    danger: true,
    action: 'stop',
    run: async () => {
      await call('session:stop', path)
      await Promise.all(running.map((a) => waitForStop(path, a.id)))
    }
  })
}

/**
 * Resumes every stopped agent that has a conversation to resume, one after another; running agents are
 * left alone, except those a refused sign-in stopped, which are told to carry on (#309). Asks first only when some
 * caches have expired; one failure doesn't stop the rest, and the failures are reported together with their reasons.
 */
export function resumeAllAgents(path: string): Promise<void> {
  // A second click while it runs is ignored; the button shows a spinner.
  return runOnce(`resumeAll:${path}`, () => resumeAll_(path)).then(() => undefined)
}

/**
 * Resume All's report of the agents it left (#1434): their conversations can't resume where they were made now (their
 * slot is free, so only their own Resume takes it; or it holds other work), one line each with why ("• HB2: its slot is
 * free. Resume it by hand to take it"), and for each a Show that opens the Sessions tab on that conversation, where its
 * Resume, its transcript and Start Fresh with a Handover are.
 */
function heldReport(path: string, held: ResumeAllResult['held']): { title: string; lines: string; actions: ToastAction[] } {
  return {
    title: tr(msg({ id: 'actions.resumeAll.heldTitle', defaultMessage: '{n, plural, one {Resume All left one agent} other {Resume All left # agents}}', description: "A notification's title after Resume All (#1434): it left {n} agents stopped, whose conversations can't resume now where they ran (a slot that is free, so only their own Resume takes it, or holds other work); the lines below say why." }), { n: held.length }),
    lines: held.map((h) => tr(msg({ id: 'actions.resumeAll.heldLine', defaultMessage: '• {agent}: {why}', description: "A line of Resume All's report of the agents it left (#1434): the agent ({agent}) and why, in plain words ({why}: \"its slot is free. Resume it by hand to take it\", \"its slot now holds AM-14's work\", \"after AM-14\")." }), { agent: h.name, why: shownText(holdShort(h.hold)) })).join('\n'),
    actions: held.map((h) => ({ label: tr(msg({ id: 'actions.resumeAll.show', defaultMessage: 'Show {agent}', description: "A button in Resume All's report of the agents it left (#1434): opens the Sessions tab on that agent's ({agent}) conversation, where it can be resumed by hand, read, or started fresh with a handover." }), { agent: h.name }), command: 'session.showTranscript', args: [path, h.id] }))
  }
}

async function resumeAll_(path: string): Promise<void> {
  const p = project(path)
  if (!p) return
  const stopped = agentsToResume(p.agents)
  const left = p.agents.flatMap((a) => (!a.live && a.resume?.hold ? [{ name: a.name, hold: a.resume.hold, id: a.resume.id }] : []))
  if (!stopped.length && left.length) {
    const r = heldReport(path, left)
    return notify('info', r.title, r.lines, r.actions)
  }
  if (!stopped.length) return notify('info', tr(msg({ id: 'actions.resumeAll.nothing', defaultMessage: 'Nothing to resume', description: "A notification's title: Resume All found no agent to resume." })), tr(msg({ id: 'actions.resumeAll.nothingMessage', defaultMessage: 'No stopped agent has a session to resume.', description: 'Under the notification that Resume All found nothing to resume.' })))
  const list = (await attempt(listFailed(), () => call('session:list', path))) ?? []
  const cold = stopped.flatMap((a) => {
    if (a.live) return []
    const r = list.find((s) => s.id === a.resume!.id)?.recache
    return r && !r.warm && r.tokens > 20000 ? [tr(msg({ id: 'actions.resumeAll.coldLine', defaultMessage: '• {agent} — about {tokens} tokens', description: "A line of Resume All's question: an agent ({agent}) whose prompt cache expired, and about how many tokens ({tokens}: \"120K\") resuming re-caches." }), { agent: a.name, tokens: formatTokens(r.tokens) })] : []
  })
  if (cold.length) {
    const n = stopped.length
    const ok = await confirm({
      title: tr(msg({ id: 'actions.resumeAll.title', defaultMessage: '{n, plural, one {Resume the agent?} other {Resume all agents?}}', description: "Title of Resume All's question about expired prompt caches ({n} agents to resume)." }), { n }),
      message: tr(msg({ id: 'actions.resumeAll.message', defaultMessage: 'The prompt cache has expired for {who, select, all {all of them} other {{cold, plural, one {one agent} other {# agents}}}}. Resuming re-caches on the first message:', description: "Resume All's question, above the agents whose prompt cache expired: all of them (all), or how many ({cold})." }), { who: cold.length === n && cold.length > 1 ? 'all' : 'some', cold: cold.length }),
      detail: cold.join('\n'),
      confirmLabel: tr(msg({ id: 'actions.resumeAll.confirm', defaultMessage: '{n, plural, one {Resume} other {Resume all}}', description: "Resume All's button ({n} agents)." }), { n }),
      action: 'resume'
    })
    if (!ok) return
  }
  // The agents as they are now: one may have started while the dialog was open.
  const result = await resumeAll(project(path)?.agents ?? [], async (a) => {
    // Running, stopped mid-turn by a refused sign-in: a short "carry on" (its CLI resumes nothing itself).
    if (stalledOnSignIn(a.live)) return void (await call('session:carryOn', path, a.id))
    const provider = agentProviderOf(a)
    const name = providerName(provider)
    if (!isProviderEnabled(get().settings, provider)) throw new Error(providerOff(name))
    if (!get().providers[provider]?.found) throw new Error(providerMissing(name))
    try {
      await whileStarting(path, a.id, { kind: 'resume', sessionId: a.resume!.id }, () => call('session:start', path, { resumeId: a.resume!.id, name: a.resume!.name, agentId: a.id, auto: true }))
    } catch (e) {
      // Hive resuming that same conversation meanwhile (a card's placement, HI-1746): resumed once that start is, its
      // failure reported as Resume All's. Anything else it runs or starts: the refusal, as before.
      let joined: 'running' | 'other'
      try {
        joined = await call('session:joinResume', path, a.id, a.resume!.id)
      } catch (j) {
        throw new Error(errorMessage(j), { cause: j })
      }
      if (joined === 'running') return
      throw new Error(errorMessage(e), { cause: e })
    }
  })
  if (result.failed.length) {
    const tried = result.failed.length + result.resumed.length
    notify(
      'error',
      tr(msg({ id: 'actions.resumeAll.failed', defaultMessage: '{all, select, yes {{tried, plural, one {Could not resume the agent} other {Could not resume the agents}}} other {{failed} of {tried} agents could not resume}}', description: "An error's title after Resume All: none of the {tried} agents resumed (yes), or {failed} of them didn't." }), { all: result.failed.length === tried ? 'yes' : 'no', failed: result.failed.length, tried }),
      batchReport(result.failed, result.resumed.length ? tr(msg({ id: 'actions.resumeAll.resumed', defaultMessage: 'Resumed: {agents}', description: "Resume All's report: the agents that did resume ({agents}: their names, listed)." }), { agents: fmt.list(result.resumed, 'unit') }) : null, result.held.length ? [heldReport(path, result.held).lines] : []),
      result.held.length ? heldReport(path, result.held).actions : undefined
    )
  } else if (result.held.length) {
    const r = heldReport(path, result.held)
    notify('info', r.title, r.lines, r.actions)
  }
}

/**
 * Start New (All) (#216): after one confirmation listing every agent (busy ones flagged), running agents are stopped and
 * every agent starts a fresh session; old conversations stay resumable from the Sessions tab. With `archive` (Archive
 * and Start New (All)): each agent's current or last session is archived first, as Archive Session and Start New… does,
 * and only agents with one are listed. One at a time; failures are reported together. A second click while it runs is
 * ignored (the button shows a spinner).
 */
/**
 * Start Fresh (Idle Agents) (#1437, #1086): one confirmed step giving each idle running agent of the project a new
 * conversation (its old one stays in the Sessions tab). The question lists who will and who won't, with why: busy,
 * waiting, watching, with background tasks, with a card's slot in flight, or stopped (left stopped). Each is checked
 * again as it starts (main), so one that started work meanwhile is left as it is, and said so.
 */
export function startFreshIdle(path: string): Promise<void> {
  return runOnce(`startFreshIdle:${path}`, () => startFreshIdle_(path)).then(() => undefined)
}

/** Why an agent doesn't start fresh, in a few words, for Start Fresh's question and report. */
function freshWhyText(r: FreshRow): string {
  switch (r.why) {
    case 'stopped':
      return tr(msg({ id: 'actions.startFresh.why.stopped', defaultMessage: 'stopped: left stopped', description: "Start Fresh (Idle Agents)' list (#1437): this agent isn't running, and stays stopped." }))
    case 'working':
    case 'starting':
      return tr(msg({ id: 'actions.startFresh.why.working', defaultMessage: 'working: left as it is', description: "Start Fresh (Idle Agents)' list (#1437): this agent is in a turn (or starting), so it keeps its conversation." }))
    case 'waiting':
      return tr(msg({ id: 'actions.startFresh.why.waiting', defaultMessage: 'waiting for you: left as it is', description: "Start Fresh (Idle Agents)' list (#1437): this agent is asking the user something, so it keeps its conversation." }))
    case 'watching':
      return tr(msg({ id: 'actions.startFresh.why.watching', defaultMessage: 'watching cards: left as it is', description: "Start Fresh (Idle Agents)' list (#1437): this agent waits on a card watch, so it keeps its conversation." }))
    case 'background':
      return tr(msg({ id: 'actions.startFresh.why.background', defaultMessage: 'background tasks running: left as it is', description: "Start Fresh (Idle Agents)' list (#1437): this agent has background tasks running, so it keeps its conversation." }))
    case 'pending':
      return tr(msg({ id: 'actions.startFresh.why.pending', defaultMessage: 'a prompt not taken yet: left as it is', description: "Start Fresh (Idle Agents)' list (#1437): Hive typed a prompt this agent's CLI hasn't taken yet, so it keeps its conversation." }))
    case 'lease':
      return tr(msg({ id: 'actions.startFresh.why.lease', defaultMessage: '{card, select, none {its lane is still in flight} other {{card} is still in flight}}: left as it is', description: "Start Fresh (Idle Agents)' list (#1437): this agent holds a slot for a card ({card}: \"AM-12\") or a lane (none) whose work isn't finished, so it keeps its conversation." }), { card: r.card ? cardLabelOf(get(), r.card) : 'none' })
    default:
      return tr(msg({ id: 'actions.startFresh.why.fresh', defaultMessage: 'idle: starts fresh', description: "Start Fresh (Idle Agents)' list (#1437): this agent is idle and gets a new conversation." }))
  }
}

async function startFreshIdle_(path: string): Promise<void> {
  const p = project(path)
  if (!p?.agents.length) return notify('info', tr(msg({ id: 'actions.startAll.noAgents', defaultMessage: 'No agents', description: "A notification's title: the project has no agents to start." })), tr(msg({ id: 'actions.startAll.noAgentsMessage', defaultMessage: 'Add an agent first.', description: 'Under the notification that the project has no agents.' })))
  const plan = await attempt(listFailed(), () => call('session:freshPlan', path))
  if (!plan) return
  const fresh = plan.filter((r) => !r.why)
  const line = (r: FreshRow): string => tr(msg({ id: 'actions.startFresh.line', defaultMessage: '• {agent}: {why}', description: "A line of Start Fresh (Idle Agents)' question (#1437): an agent ({agent}) and what happens to it ({why}: \"idle: starts fresh\", \"working: left as it is\")." }), { agent: r.name, why: freshWhyText(r) })
  if (!fresh.length) return notify('info', tr(msg({ id: 'actions.startFresh.noneTitle', defaultMessage: 'No idle agent to start fresh', description: "A notification's title (#1437): Start Fresh (Idle Agents) found no idle running agent." })), plan.map(line).join('\n'))
  const ok = await confirm({
    title: tr(msg({ id: 'actions.startFresh.title', defaultMessage: '{n, plural, one {Start the idle agent fresh?} other {Start # idle agents fresh?}}', description: "Title of Start Fresh (Idle Agents)' question (#1437): {n} idle agents get new conversations." }), { n: fresh.length }),
    message: tr(msg({ id: 'actions.startFresh.message', defaultMessage: 'Idle agents in {project} start new conversations; their old ones stay in the Sessions tab. The others are left as they are:', description: "Start Fresh (Idle Agents)' question (#1437), above the list of the project's ({project}) agents and what happens to each." }), { project: p.name }),
    detail: plan.map(line).join('\n'),
    confirmLabel: tr(msg({ id: 'actions.startFresh.confirm', defaultMessage: 'Start Fresh', description: "Start Fresh (Idle Agents)' button (#1437)." })),
    action: 'start'
  })
  if (!ok) return
  const left: FreshRow[] = []
  const result = await eachAgent(
    fresh.map((r) => ({ ...agentOf(project(path), r.agentId)!, row: r })).filter((a) => a.id),
    async (a) => {
      const why = await whileStarting(path, a.id, { kind: 'start' }, () => call('session:startFresh', path, a.id))
      // Busy again (or stopped) since the question: left as it is.
      if (why) left.push({ ...a.row, why })
    }
  )
  if (result.failed.length || left.length) {
    notify(
      result.failed.length ? 'error' : 'info',
      tr(msg({ id: 'actions.startFresh.reportTitle', defaultMessage: '{n, plural, one {Started one agent fresh} other {Started # agents fresh}}', description: "A notification's title after Start Fresh (Idle Agents) (#1437): {n} agents got new conversations; the lines say which didn't, and why." }), { n: result.done.length - left.length }),
      batchReport(result.failed, null, left.map(line))
    )
  }
}

export function startNewAll(path: string, archive = false): Promise<void> {
  return runOnce(`${archive ? 'archiveAll' : 'startNewAll'}:${path}`, () => startNewAll_(path, archive)).then(() => undefined)
}

async function startNewAll_(path: string, archive: boolean): Promise<void> {
  const p = project(path)
  if (!p?.agents.length) return notify('info', tr(msg({ id: 'actions.startAll.noAgents', defaultMessage: 'No agents', description: "A notification's title: the project has no agents to start." })), tr(msg({ id: 'actions.startAll.noAgentsMessage', defaultMessage: 'Add an agent first.', description: 'Under the notification that the project has no agents.' })))
  const list = archive ? await attempt(listFailed(), () => call('session:list', path)) : []
  if (!list) return
  const archives = archive ? sessionsToArchive(p.agents, list) : []
  if (archive && !archives.length) return notify('info', nothingToArchive(), tr(msg({ id: 'actions.startAll.nothingToArchive', defaultMessage: 'No agent has a session to archive.', description: 'Under the notification that Archive and Start New (All) found nothing to archive.' })))
  const agents = archive ? archives.map((x) => x.agent) : p.agents
  const running = agents.filter((a) => a.live)
  const data = batchAgentsData(p, get().tasks, archive ? 'archive' : 'start', agents)
  const lines = tableText(data)
  const note = tr(msg({ id: 'actions.startAll.note', defaultMessage: "{running, select, yes {Running agents are stopped first. } other {}}{archive, select, yes {The transcripts are kept in the project's .combwork/archive folder.} other {Their conversations are kept and can be resumed from the Sessions tab.}}", description: 'Under the table of Start New (All) (archive: no) or Archive and Start New (All) (archive: yes): running agents stop first (running: yes), and where the old conversations are. Keep .combwork/archive as it is.' }), { running: running.length ? 'yes' : 'no', archive: archive ? 'yes' : 'no' })
  const kind = archive ? 'archive' : 'start'
  const ok = await confirm({
    title: tr(msg({ id: 'actions.startAll.title', defaultMessage: '{kind, select, archive {{n, plural, one {Archive and start new?} other {Archive and start new for all agents?}}} other {{n, plural, one {Start a new session?} other {Start new sessions for all agents?}}}}', description: 'Title of the question before Start New (All) or Archive and Start New (All) (archive) for {n} agents.' }), { kind, n: agents.length }),
    message: archive
      ? tr(msg({ id: 'actions.startAll.archiveMessage', defaultMessage: "{n, plural, one {{agent}'s session is archived in {project}, and each starts a fresh one:} other {The sessions of these # agents are archived in {project}, and each starts a fresh one:}}", description: "Archive and Start New (All)'s question, above the table of {n} agents ({agent}: the one's name) of a project ({project})." }), { n: agents.length, agent: agents[0].name, project: p.name })
      : tr(msg({ id: 'actions.startAll.startMessage', defaultMessage: '{n, plural, one {This agent starts a fresh session:} other {Every agent in {project} starts a fresh session:}}', description: "Start New (All)'s question, above the table of {n} agents of a project ({project})." }), { n: agents.length, project: p.name }),
    detail: [lines, '', note].join('\n'),
    // The agents as a table (#572): state, card, worktree and what happens to each.
    content: createElement(AgentsDetail, { data, note }),
    wide: true,
    confirmLabel: archive ? archiveAndStartNew() : tr(msg({ id: 'actions.startAll.start', defaultMessage: 'Start new', description: "Start New (All)'s button." })),
    action: archive ? 'archive-start' : 'start'
  })
  if (!ok) return
  // As they are now: one may have stopped or started while the dialog was open.
  const now = (id: string) => agentOf(project(path), id)
  for (const a of agents) if (now(a.id)?.live) await call('session:stop', path, a.id).catch(() => undefined)
  await Promise.all(agents.map((a) => waitForStop(path, a.id)))
  const result = await eachAgent(agents, async (a) => {
    const provider = agentProviderOf(a)
    const name = providerName(provider)
    if (!isProviderEnabled(get().settings, provider)) throw new Error(providerOff(name))
    if (!get().providers[provider]?.found) throw new Error(providerMissing(name))
    try {
      const target = archives.find((x) => x.agent.id === a.id)
      if (target) await call('session:archive', path, target.sessionId, true)
      await whileStarting(path, a.id, { kind: 'start' }, () => call('session:start', path, { agentId: a.id }))
    } catch (e) {
      throw new Error(errorMessage(e), { cause: e })
    }
  })
  if (result.failed.length) {
    const tried = result.failed.length + result.done.length
    notify(
      'error',
      tr(msg({ id: 'actions.startAll.failed', defaultMessage: '{all, select, yes {{tried, plural, one {Could not start the agent} other {Could not start the agents}}} other {{failed} of {tried} agents could not start}}', description: "An error's title after Start New (All): none of the {tried} agents started (yes), or {failed} of them didn't." }), { all: result.failed.length === tried ? 'yes' : 'no', failed: result.failed.length, tried }),
      batchReport(result.failed, result.done.length ? tr(msg({ id: 'actions.startAll.started', defaultMessage: 'Started: {agents}', description: "Start New (All)'s report: the agents that did start ({agents}: their names, listed)." }), { agents: fmt.list(result.done, 'unit') }) : null)
    )
  }
}

export async function archiveCurrent(path: string | null = get().selectedProject, agentId?: string): Promise<void> {
  if (!path) return
  const p = project(path)
  const id = agentId ?? focusedAgentId(p)
  if (!id) return notify('info', nothingToArchive())
  const a = agentOf(p, id)
  const live = a?.live
  const list = await call('session:list', path)
  const target = live ? list.find((s) => s.id === live.sessionId) : list.find((s) => s.id === (a?.lastSessionId ?? a?.resume?.id) && !s.archived)
  if (!target) return notify('info', nothingToArchive())
  const ok = await confirm({
    title: tr(msg({ id: 'actions.archive.title', defaultMessage: 'Archive session and start fresh?', description: 'Title of the question before archiving the session and starting a new one.' })),
    message: tr(msg({ id: 'actions.archive.message', defaultMessage: 'Archive "{session}" and start a new session?', description: 'The question before archiving a session ({session}: its name or title) and starting a new one.' }), { session: target.name || target.title || target.id.slice(0, 8) }),
    detail: tr(msg({ id: 'actions.archive.detail', defaultMessage: "The transcript is preserved in the project's .combwork/archive folder. A new session starts with an empty context, which avoids re-caching the old conversation.", description: 'Under the question before archiving a session. Keep .combwork/archive as it is.' })),
    confirmLabel: archiveAndStartNew(),
    action: 'archive-start'
  })
  if (!ok) return
  if (live) {
    await call('session:stop', path, id)
    await waitForStop(path, id)
  }
  const archived = await attempt(tr(msg({ id: 'actions.archive.failed', defaultMessage: 'Could not archive session', description: "An error's title: archiving a session failed." })), () => call('session:archive', path, target.id, true).then(() => true))
  if (archived) await newSession(path, id)
}

/** Where a server is added (HI-2059): a project, or the Hive Assistant. */
export type McpPlace = Pick<ProjectInfo, 'path' | 'name'> | 'assistant'

const MCP_UPDATE_FAILED = msg({ id: 'actions.mcp.updateFailedAdded', defaultMessage: 'Could not update the server', description: "An error's title: adding an MCP server to a project or the Hive Assistant, or removing it, failed." })

/**
 * Add server… (HI-2059): a picker of the workspace's servers not yet added to a project or the Hive Assistant, the one
 * chosen showing what it runs (#550) before Add. Refused, in the dialog, if its definition was replaced or edited since
 * it was listed. It runs there from their next session.
 */
export async function addMcpServer(place: McpPlace): Promise<boolean> {
  const servers = await attempt(tr(msg({ id: 'actions.mcp.listFailedPicker', defaultMessage: 'Could not list the servers', description: "An error's title: reading the workspace's MCP servers for the Add server picker failed." })), () => call('mcp:list'))
  if (!servers) return false
  const can = servers.filter((m) => !!m.def && !(place === 'assistant' ? m.assistant : serverAddedIn(m, place.path)))
  let picked: McpServerInfo | null = null
  const ok = await confirm({
    title:
      place === 'assistant'
        ? tr(msg({ id: 'mcp.add.titleAssistant', defaultMessage: 'Add a server for the Assistant', description: "Title of the Add server picker (HI-2059) in the Hive Assistant's view." }))
        : tr(msg({ id: 'mcp.add.title', defaultMessage: 'Add a server to {project}', description: "Title of the Add server picker (HI-2059) in a project's MCP tab. {project} is the project." }), { project: place.name }),
    message: tr(msg({ id: 'mcp.add.message', defaultMessage: 'The workspace’s servers not added here yet. Sessions started from now on get the one you add.', description: 'The Add server picker (HI-2059), above its search and list: the workspace servers not added to this project (or the Hive Assistant); new sessions start the one added.' })),
    content: createElement(McpServerPicker, { servers: can, onPick: (m: McpServerInfo | null) => (picked = m) }),
    wide: true,
    confirmLabel: tr(msg({ id: 'mcp.add.button', defaultMessage: 'Add', description: 'The Add server picker (HI-2059): the button that adds the chosen server.' })),
    busyLabel: tr(msg({ id: 'mcp.add.busy', defaultMessage: 'Adding…', description: 'The Add server picker’s Add button while it works.' })),
    run: async () => {
      const m = picked
      if (m) await call('mcp:add', place === 'assistant' ? 'assistant' : place.path, m.name, { def: m.def, revision: m.revision })
    }
  })
  set((s) => ({ skillsVersion: s.skillsVersion + 1 }))
  if (ok) await refreshWorkspace()
  return ok
}

/** Removes a server from a project or the Hive Assistant (HI-2059), at once: it is one Add away. */
export async function removeMcpServer(place: McpPlace, server: Pick<McpServerInfo, 'name'>): Promise<boolean> {
  const done = await attempt(tr(MCP_UPDATE_FAILED), async () => {
    await call('mcp:remove', place === 'assistant' ? 'assistant' : place.path, server.name)
    return true
  })
  set((s) => ({ skillsVersion: s.skillsVersion + 1 }))
  await refreshWorkspace()
  return !!done
}

/**
 * Add to… (the MCP view, HI-2059): which projects, and the Hive Assistant, a server is added to, showing what it runs
 * (#550): those it is added to are ticked; unticking one removes it there. Files are written one by one, so a failure
 * midway says what changed and what didn't.
 */
export async function chooseMcpPlaces(server: Pick<McpServerInfo, 'name' | 'def' | 'revision' | 'runs' | 'secretWarnings' | 'assistant' | 'projects'>): Promise<boolean> {
  const projects = get().workspace?.projects ?? []
  const initial = projects.filter((p) => serverAddedIn(server, p.path)).map((p) => p.path)
  let picks: Record<string, boolean> = Object.fromEntries(projects.map((p) => [p.path, initial.includes(p.path)]))
  let forAssistant = server.assistant
  const ok = await confirm({
    title: tr(msg({ id: 'mcp.places.title', defaultMessage: 'Add {name} to…', description: 'Title of the dialog in the MCP view (HI-2059) that chooses the projects, and the Hive Assistant, an MCP server is added to. {name} is the server.' }), { name: server.name }),
    message: tr(msg({ id: 'mcp.places.message', defaultMessage: 'Sessions started from now on get it wherever it is ticked; unticking removes it there. It runs:', description: 'The MCP view’s Add to… dialog (HI-2059), above the command the server runs and the projects (and the Hive Assistant) to tick.' })),
    list: server.runs,
    content: createElement(McpProjectPicker, {
      projects,
      initial,
      assistant: server.assistant,
      warnings: server.secretWarnings,
      onChange: (now: Record<string, boolean>, assistant: boolean) => {
        picks = now
        forAssistant = assistant
      }
    }),
    confirmLabel: tr(msg({ id: 'mcp.places.button', defaultMessage: 'Save', description: 'The MCP view’s Add to… dialog (HI-2059): the button that adds the server where ticked and removes it where unticked.' }))
  })
  if (!ok) return false
  // The definition shown: if it was replaced or edited meanwhile, Hive refuses before changing anything.
  const r = await attempt(tr(MCP_UPDATE_FAILED), () => call('mcp:places', server.name, server.def ? { def: server.def, revision: server.revision } : undefined, picks, forAssistant))
  if (r?.failed.length) {
    const place = (p: string): string => (p === 'assistant' ? tr(MCP_ASSISTANT) : (projects.find((x) => samePath(x.path, p))?.name ?? basename(p)))
    const lines = [
      ...(r.added.length ? [tr(msg({ id: 'mcp.places.addedIn', defaultMessage: 'Added: {places}', description: 'After Add to… (HI-2059) failed in part: the places the server was added to. {places} lists projects (and the Hive Assistant).' }), { places: fmt.list(r.added.map(place)) })] : []),
      ...(r.removed.length ? [tr(msg({ id: 'mcp.places.removedFrom', defaultMessage: 'Removed: {places}', description: 'After Add to… (HI-2059) failed in part: the places the server was removed from. {places} lists projects (and the Hive Assistant).' }), { places: fmt.list(r.removed.map(place)) })] : []),
      ...r.failed.map((f) => tr(msg({ id: 'mcp.places.failedIn', defaultMessage: 'Not changed in {place}: {error}', description: 'After Add to… (HI-2059) failed in part: a place where the change could not be written, and why ({error}, as Hive or Windows said it).' }), { place: place(f.place), error: f.error }))
    ]
    notify('warning', tr(msg({ id: 'mcp.places.partial', defaultMessage: '{name} was changed in only some places', description: "A warning's title after the MCP view's Add to… (HI-2059): some of the places could not be written; the message says which changed and which didn't. {name} is the server." }), { name: server.name }), lines.join('\n'))
  }
  set((s) => ({ skillsVersion: s.skillsVersion + 1 }))
  await refreshWorkspace()
  return !!r && !r.failed.length
}

/** "Hive Assistant", where a server is added. */
const MCP_ASSISTANT = msg({ id: 'mcp.where.assistantName', defaultMessage: 'the Assistant', description: 'Where an MCP server is added (HI-2059), in a list of places beside project names.' })

// ---------------------------------------------------------------------------
// MCP catalogues (HI-545): Install and Update, each shown before anything is written.
// ---------------------------------------------------------------------------

const CATALOG_FAILED = msg({ id: 'mcp.catalog.failed', defaultMessage: 'Could not get {name}', description: "An error's title (HI-545): downloading or checking a server from an MCP catalogue for Install or Update failed. {name} is the server." })

/**
 * Install (HI-545): the catalogue server downloaded and checked against its catalogue (size, sha256) first, then #550's
 * Add dialog: what it runs, and its name, another one when it is taken, or Replace only if the user says so. Installed,
 * it is added to no project yet (HI-2059): its view opens, for Add to….
 */
export async function installCatalogServer(row: Pick<McpCatalogRow, 'source' | 'name' | 'version'>): Promise<boolean> {
  const p = await attempt(tr(CATALOG_FAILED, { name: row.name }), () => call('mcp:catalogPrepare', row.source, row.name))
  if (!p) return false
  // #550's Add: what it runs, the name (another if it is taken, or Replace).
  const picked = await chooseServerName({
    title: tr(msg({ id: 'mcp.catalog.installTitle', defaultMessage: 'Install {name} {version}?', description: 'Title of the question before installing a server from an MCP catalogue (HI-545). {name} is the server, {version} its version.' }), { name: p.server.name, version: p.server.version }),
    message: tr(msg({ id: 'mcp.catalog.installMessageName', defaultMessage: 'Downloaded and checked against its catalogue. It is added to the workspace under this name, and to no project yet. It runs:', description: 'The question before installing a catalogue server (HI-545), above the name box and what it runs: its download matched its catalogue; installed, it runs nowhere until added.' })),
    list: p.runs,
    detail: p.secretWarnings.join('\n') || undefined,
    initial: p.server.name,
    initialTaken: p.nameTaken,
    confirmLabel: tr(msg({ id: 'mcp.catalog.installButton', defaultMessage: 'Install', description: 'Button (HI-545): installs the catalogue server.' }))
  })
  if (!picked) {
    void call('mcp:catalogDrop', p.id).catch(() => undefined)
    return false
  }
  const done = await attempt(tr(CATALOG_FAILED, { name: row.name }), () => call('mcp:catalogInstall', p.id, picked.name, picked.replace).then(() => true))
  if (!done) return false
  set((s) => ({ skillsVersion: s.skillsVersion + 1, mcpCatalogVersion: s.mcpCatalogVersion + 1, mcpTab: 'installed', selectedMcp: picked.name }))
  notify('success', tr(msg({ id: 'mcp.catalog.installed', defaultMessage: 'Installed {name}', description: "A notification's title (HI-545): a catalogue server was installed." }), { name: picked.name }), tr(msg({ id: 'mcp.catalog.installedNext', defaultMessage: 'It runs nowhere yet: Add to… in its view adds it to the projects (and the Assistant) that need it.', description: 'Under "Installed {name}" (HI-545): what to do next. Add to… is the button in the server\'s view in the MCP view.' })))
  await refreshWorkspace()
  return true
}

/**
 * Update (HI-545): never automatic. The new version downloaded and checked first; the dialog says the versions, where
 * it is added (those places keep it) and what it runs, the changed lines marked. If the definition or the places
 * change before it is applied, Hive writes nothing and the dialog opens again from what is there now.
 */
export async function updateCatalogServer(row: Pick<McpCatalogRow, 'source' | 'name' | 'version'>, again = 0): Promise<boolean> {
  const p = await attempt(tr(CATALOG_FAILED, { name: row.name }), () => call('mcp:catalogPrepare', row.source, row.name))
  if (!p) return false
  const ex = p.existing
  if (!ex) {
    void call('mcp:catalogDrop', p.id).catch(() => undefined)
    return installCatalogServer(row)
  }
  const now = new Set(ex.runs)
  const next = new Set(p.runs)
  const changed = [...ex.runs.filter((l) => !next.has(l)).map((l) => `− ${l}`), ...p.runs.filter((l) => !now.has(l)).map((l) => `+ ${l}`)]
  const where = mcpWhereText({ def: ex.def ?? {}, projects: ex.projects, assistant: ex.assistant }, get().workspace?.projects ?? [])
  const ok = await confirm({
    title: tr(msg({ id: 'mcp.catalog.updateTitle', defaultMessage: 'Update {name} from {from} to {to}?', description: 'Title of the question before updating a catalogue server (HI-545). {from} and {to} are its versions.' }), { name: p.server.name, from: ex.version, to: p.server.version }),
    message: changed.length
      ? tr(msg({ id: 'mcp.catalog.updateMessage', defaultMessage: '{where}: those places keep it, your values for its environment and headers too. What it runs changes (− now, + after):', description: 'The question before updating a catalogue server (HI-545), above the lines of what it runs that change. {where} says where it is added ("Added in hive", "Not added anywhere").' }), { where })
      : tr(msg({ id: 'mcp.catalog.updateSame', defaultMessage: '{where}: those places keep it, your values for its environment and headers too. What it runs stays the same:', description: 'The question before updating a catalogue server (HI-545) whose command stays the same, above what it runs. {where} says where it is added.' }), { where }),
    list: changed.length ? changed : p.runs,
    detail: p.secretWarnings.join('\n') || undefined,
    confirmLabel: tr(msg({ id: 'mcp.catalog.updateButton', defaultMessage: 'Update', description: 'Button (HI-545): updates the catalogue server to the new version.' }))
  })
  if (!ok) {
    void call('mcp:catalogDrop', p.id).catch(() => undefined)
    return false
  }
  const r = await attempt(tr(CATALOG_FAILED, { name: row.name }), () => call('mcp:catalogUpdate', p.id, { def: ex.def, revision: ex.revision }, { projects: ex.projects, assistant: ex.assistant }))
  set((s) => ({ skillsVersion: s.skillsVersion + 1, mcpCatalogVersion: s.mcpCatalogVersion + 1 }))
  if (!r) return false
  if (r.stale) {
    // Changed while the dialog was open: shown again from what is there now (twice at most).
    notify('info', r.stale)
    return again < 2 ? updateCatalogServer(row, again + 1) : false
  }
  notify('success', tr(msg({ id: 'mcp.catalog.updated', defaultMessage: 'Updated {name} to {version}', description: "A notification's title (HI-545): a catalogue server was updated." }), { name: p.server.name, version: p.server.version }))
  await refreshWorkspace()
  return true
}

/** Why a workspace MCP server can't be used, in the window's language (#849): Hive's own words, else the JSON reader's as it gave them. */
export const mcpErrorText = (server: Pick<McpServerInfo, 'error' | 'errorText'>): string | undefined => (server.errorText ? shownText(server.errorText) : server.error)

/**
 * Where a workspace MCP server is added (HI-2059), in words, from the projects as the window has them: "Added in
 * Ambrosia", "Added in Ambrosia and for the Hive Assistant", "Added for the Hive Assistant only" or "Not added
 * anywhere". A hidden project it is added to counts, unnamed.
 */
export function mcpWhereText(server: Pick<McpServerInfo, 'def' | 'projects' | 'assistant'>, projects: readonly ProjectInfo[]): string {
  const named = projects.filter((p) => serverAddedIn(server, p.path)).map((p) => p.name)
  const hidden = server.projects.filter((p) => !projects.some((x) => samePath(x.path, p))).length
  const on = hidden ? [...named, tr(msg({ id: 'mcp.where.hidden', defaultMessage: '{n, plural, one {# hidden project} other {# hidden projects}}', description: 'Where an MCP server is added (HI-2059), after the projects named: the hidden projects it is added to.' }), { n: hidden })] : named
  const assistant = !!server.def && server.assistant
  if (on.length && assistant) return tr(msg({ id: 'mcp.where.addedSomeAndAssistant', defaultMessage: 'Added in {projects} and for the Assistant', description: 'Where an MCP server is added (HI-2059), under it in the MCP view: in some projects and for the Hive Assistant. {projects} lists the projects.' }), { projects: fmt.list(on) })
  if (assistant) return tr(msg({ id: 'mcp.where.addedAssistantOnly', defaultMessage: 'Added for the Assistant only', description: 'Where an MCP server is added (HI-2059), under it in the MCP view: for the Hive Assistant, in no project.' }))
  return on.length
    ? tr(msg({ id: 'mcp.where.addedSome', defaultMessage: 'Added in {projects}', description: 'Where an MCP server is added (HI-2059), under it in the MCP view. {projects} lists the projects.' }), { projects: fmt.list(on) })
    : tr(msg({ id: 'mcp.where.addedNone', defaultMessage: 'Not added anywhere', description: 'Where an MCP server is added (HI-2059), under it in the MCP view: no project and not the Hive Assistant, so it runs nowhere.' }))
}


/**
 * Add MCP Server from File (#550): a .json definition, or a .zip of a server folder. The dialog shows what it runs and
 * the name it gets (the file's, editable); a name in use asks to replace it or choose another. It is added to no project
 * (HI-2059): a project's MCP tab, the Assistant's view or Add to… adds it where it runs.
 */
export async function addMcpServerFromFile(): Promise<McpServerInfo | null> {
  const file = await attempt(tr(msg({ id: 'actions.mcp.openFailed', defaultMessage: 'Could not open the file', description: "An error's title: picking an MCP server's file failed." })), () => call('mcp:pickFile'))
  if (!file) return null
  const server = await attempt(addServerFailed(), () => call('mcp:previewFile', file))
  if (!server) return null
  const picked = await chooseServerName({
    title: tr(msg({ id: 'actions.mcp.addTitle', defaultMessage: 'Add MCP Server from File', description: 'Title of the Add MCP Server from File dialog (the command of the same name). MCP is a name: keep it.' })),
    message: tr(
      msg({
        id: 'mcp.addFile.messageAdded',
        defaultMessage: 'Adds {file} to the workspace (.combwork/mcp){files, plural, =0 {} one {, with its file in a folder of its own} other {, with its # files in a folder of its own}}, added to no project yet. Add it where it should run: a project’s MCP tab, the Assistant’s view, or Add to… here. It runs:',
        description: 'Add MCP Server from File (HI-2059), above the command the server runs. {file} is the file added; {files} how many files a .zip brings. Keep .combwork/mcp as it is; "MCP tab" and "Add to…" as Hive shows them.'
      }),
      { file: basename(file), files: server.files }
    ),
    list: server.runs,
    detail: server.secretWarnings.length ? server.secretWarnings.join('\n') : undefined,
    initial: server.name,
    initialTaken: server.exists,
    confirmLabel: tr(msg({ id: 'actions.mcp.add', defaultMessage: 'Add', description: 'Button: adds the MCP server to the workspace.' }))
  })
  if (!picked) return null
  const added = await attempt(addServerFailed(), () => call('mcp:addFromFile', file, picked.name, picked.replace))
  if (!added) return null
  set((s) => ({ skillsVersion: s.skillsVersion + 1, selectedMcp: added.name }))
  await refreshWorkspace()
  return added
}

/**
 * The name a server is added under (#550, HI-545's Install): the prompt shows what it runs, with the name to change; a
 * name in use asks to Replace that server or choose another. `initialTaken`: whether the name offered is in use. Null
 * when cancelled.
 */
async function chooseServerName(o: { title: string; message: string; list: string[]; detail?: string; initial: string; initialTaken: boolean; confirmLabel: string }): Promise<{ name: string; replace: boolean } | null> {
  let name = o.initial
  for (;;) {
    const picked = await prompt({
      title: o.title,
      message: o.message,
      list: o.list,
      detail: o.detail,
      placeholder: tr(msg({ id: 'actions.mcp.namePlaceholder', defaultMessage: 'server-name', description: "Placeholder of the server's name box: an example name (lower case, a dash)." })),
      initial: name,
      confirmLabel: o.confirmLabel,
      validate: (v) => (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v.trim()) && !isReservedServerName(v) ? null : tr(msg({ id: 'actions.mcp.badName', defaultMessage: 'Use letters, numbers, "-" and "_". "combwork" and "hive" are reserved.', description: "Why an MCP server's name can't be used. Keep \"combwork\" and \"hive\" as they are: the built-in server's name and its old one (HI-2463)." })))
    })
    if (!picked) return null
    name = picked.trim()
    const taken = name === o.initial ? o.initialTaken : ((await attempt(tr(msg({ id: 'actions.mcp.listFailed', defaultMessage: 'Could not list the servers', description: "An error's title: reading the workspace's MCP servers failed." })), () => call('mcp:list'))) ?? []).some((m) => m.name.toLowerCase() === name.toLowerCase())
    if (!taken) return { name, replace: false }
    const choice = await choose({
      title: tr(msg({ id: 'actions.mcp.replaceTitle', defaultMessage: 'Replace {name}?', description: 'Title of the question when the workspace already has an MCP server of that name ({name}).' }), { name }),
      message: tr(msg({ id: 'actions.mcp.replaceMessage', defaultMessage: 'The workspace has a server named {name}.', description: 'The question when the workspace already has an MCP server of that name ({name}).' }), { name }),
      detail: tr(msg({ id: 'mcp.addFile.replaceDetailAdded', defaultMessage: 'Replace moves it (and the folder of one added from a .zip) to the Recycle Bin and adds this one to no project yet: projects and the Assistant that had the old one lose it. Or choose another name.', description: 'When a server of that name exists, under Replace or Choose Another Name (HI-2059).' })),
      danger: true,
      choices: [
        { label: tr(msg({ id: 'actions.mcp.rename', defaultMessage: 'Choose Another Name', description: 'Button: goes back to choose another name for the MCP server.' })), value: 'rename' },
        { label: tr(msg({ id: 'actions.mcp.replace', defaultMessage: 'Replace', description: 'Button: replaces the MCP server of that name.' })), value: 'replace' }
      ]
    })
    if (!choice) return null
    if (choice === 'rename') continue
    return { name, replace: true }
  }
}

/** "Could not add the server": an error's title. */
const addServerFailed = (): string => tr(msg({ id: 'actions.mcp.addFailed', defaultMessage: 'Could not add the server', description: "An error's title: adding an MCP server from a file failed." }))

/** "Delete" and "Deleting…": a delete confirmation's button. */
const deleteLabel = (): string => tr(msg({ id: 'actions.delete.confirm', defaultMessage: 'Delete', description: 'Button: moves it to the Recycle Bin.' }))
const deletingLabel = (): string => tr(msg({ id: 'actions.delete.busy', defaultMessage: 'Deleting…', description: 'The Delete button while it works.' }))

/**
 * Deletes a workspace MCP server after asking, saying where it is added (HI-2059): deleting removes it there too. True
 * when it was deleted.
 */
export async function deleteMcpServer(server: Pick<McpServerInfo, 'name' | 'def' | 'projects' | 'assistant'>): Promise<boolean> {
  const name = server.name
  const added = server.projects.length > 0 || server.assistant
  const ok = await confirm({
    title: tr(msg({ id: 'actions.mcp.deleteTitle', defaultMessage: 'Delete MCP server?', description: 'Title of the question before deleting a workspace MCP server.' })),
    message: tr(msg({ id: 'actions.mcp.deleteMessage', defaultMessage: 'Move {name}.json to the Recycle Bin, with its folder if it was added from a .zip? Projects will no longer be able to use it.', description: "The question before deleting a workspace MCP server: its file ({name}.json) goes to the Recycle Bin (Windows' name for it)." }), { name }),
    detail: added ? tr(msg({ id: 'actions.mcp.deleteAdded', defaultMessage: '{where}: deleting it removes it there too.', description: 'The question before deleting a workspace MCP server (HI-2059), when it is added somewhere: {where} says where, such as "Added in hive and for the Hive Assistant".' }), { where: mcpWhereText({ ...server, def: server.def ?? {} }, get().workspace?.projects ?? []) }) : undefined,
    confirmLabel: deleteLabel(),
    busyLabel: deletingLabel(),
    danger: true,
    run: () => call('mcp:delete', name)
  })
  if (!ok) return false
  clearEditorDraft(`mcp:${name}`)
  set((s) => ({ skillsVersion: s.skillsVersion + 1, ...(s.selectedMcp === name ? { selectedMcp: null } : {}) }))
  return true
}

/** Deletes a shared note or folder after asking. */
export async function deleteNote(path: string, label: string, isDir: boolean): Promise<void> {
  const ok = await confirm({
    title: tr(msg({ id: 'actions.delete.title', defaultMessage: 'Delete?', description: 'Title of the question before deleting a shared note or folder.' })),
    message: tr(msg({ id: 'actions.delete.message', defaultMessage: '{folder, select, yes {Move "{name}" and everything in it to the Recycle Bin?} other {Move "{name}" to the Recycle Bin?}}', description: "The question before deleting a shared note or folder ({name}; folder: yes when it is a folder). The Recycle Bin is Windows' name for it." }), { name: label, folder: isDir ? 'yes' : 'no' }),
    confirmLabel: deleteLabel(),
    busyLabel: deletingLabel(),
    danger: true,
    run: () => call('notes:delete', path)
  })
  if (!ok) return
  // Unsaved edits of it would otherwise bring it back (Save All, or saving before quitting).
  clearEditorDraftsUnder(path)
  const gone = (p: string | null): boolean => !!p && (p === path || p.toLowerCase().startsWith(`${path.toLowerCase()}\\`))
  set((s) => ({ notesVersion: s.notesVersion + 1, ...(gone(s.selectedNote) ? { selectedNote: null } : {}) }))
}

/**
 * The agent's open cards: asks whether to take them back (nobody has them; Doing ones go to Todo) or leave them
 * (they show the agent as removed, and Doing ones as stalled). Null: cancelled, keep the agent.
 */
function cardsOfRemovedAgent(p: ProjectInfo, agentId: string, name: string): Promise<boolean | null> {
  return cardsOfRemovedAgents(p, [{ id: agentId, name }])
}

/** The same, asked once for several agents' cards together (Remove All, #291). */
async function cardsOfRemovedAgents(p: ProjectInfo, agents: readonly { id: string; name: string }[]): Promise<boolean | null> {
  const ids = new Set(agents.map((a) => a.id))
  const open = get().tasks.filter((c) => !c.archived && c.column !== 'done' && !!c.agent && ids.has(c.agent) && c.project.toLowerCase() === p.name.toLowerCase())
  if (!open.length) return false
  const shown = fmt.list(open.slice(0, 5).map((c) => `${cardLabel(c)} ${c.title}`), 'unit')
  const list = open.length > 5 ? tr(msg({ id: 'actions.cards.andMore', defaultMessage: '{cards} and {n} more', description: "A removed agent's open cards, cut short: the first five ({cards}: \"#3 Title, #4 Title\") and how many more ({n})." }), { cards: shown, n: open.length - 5 }) : shown
  const one = agents.length === 1
  const values = { cards: open.length, agents: agents.length, agent: one ? agents[0].name : 'none' }
  const choice = await choose({
    title: tr(msg({ id: 'actions.cards.title', defaultMessage: '{agents, plural, one {{agent} has} other {The # agents have}} {cards, plural, one {# open card} other {# open cards}}', description: 'Title of the question about the open cards of an agent being removed ({agent}: its name), or of {agents} agents (Remove All).' }), values),
    message: list,
    detail: tr(msg({ id: 'actions.cards.detail', defaultMessage: '{cards, plural, one {Move it back: nobody has it, and if it is in Active it goes to Todo, ready to start on another agent. Leave it: it keeps showing {agent, select, none {its agent} other {{agent}}} (removed), and in Active shows as stalled.} other {Move them back: nobody has them, and those in Active go to Todo, ready to start on another agent. Leave them: they keep showing {agent, select, none {their agent} other {{agent}}} (removed), and those in Active show as stalled.}}', description: "Under the question about a removed agent's open cards: what Move back and Leave do. Active and Todo are board columns; {agent} is the agent's name (none when several agents are removed)." }), values),
    choices: [
      { label: tr(msg({ id: 'actions.cards.leave', defaultMessage: '{cards, plural, one {Leave it} other {Leave them}}', description: "Button: leaves a removed agent's open cards as they are." }), values), value: 'leave' },
      { label: tr(msg({ id: 'actions.cards.release', defaultMessage: '{cards, plural, one {Move it back} other {Move them back}}', description: "Button: takes a removed agent's open cards back (nobody has them; Active ones go to Todo)." }), values), value: 'release' }
    ]
  })
  return choice === null ? null : choice === 'release'
}

/** "Could not move the agent": an error's title. */
const moveFailed = (): string => tr(msg({ id: 'actions.agent.moveFailed', defaultMessage: 'Could not move the agent', description: "An error's title: moving an agent in the project's order failed." }))

/**
 * Moves an agent to `index` in the project's order (its position afterwards): the strip, its pages and the panes
 * follow. Shown at once, then saved; the agent keeps focus, so the view goes to its page (`focus` false: the focus stays
 * where it is, as in the Tiles view's focus view, whose pane shows another agent, #1053).
 */
export async function moveAgent(path: string, agentId: string, index: number, focus = true): Promise<void> {
  const p = project(path)
  if (!p || isAssistantPath(path) || !agentOf(p, agentId)) return
  const agents = moveAgentTo(p.agents, agentId, index)
  if (agents.every((a, i) => a.id === p.agents[i].id)) return
  // The panes follow the order (#134): what's on screen changes with it.
  set((s) => ({ workspace: s.workspace && { ...s.workspace, projects: s.workspace.projects.map((x) => (x.path === path ? { ...x, agents } : x)) } }))
  if (focus) focusAgent(path, agentId)
  // Kept as shown until saved (#1229): a refresh that read the order before the save doesn't put it back meanwhile.
  const end = movesShown.begin(path, { order: agents.map((a) => a.id) })
  const saved = await attempt(moveFailed(), () => call('agents:move', path, agentId, index))
  // Puts the tabs back as saved (refused, or the last of quick moves, one refused); the move's own error was already
  // shown, and the next refresh catches up anyway.
  if (end(!!saved) || !saved) await refreshWorkspace().catch(() => undefined)
}

/**
 * Swaps two agents' places (#135: one dropped on another's pane), across pages too: the panes follow the order, so they
 * swap on screen at once, then it is saved. The dragged agent keeps focus, so the view stays on the page it was dropped
 * on. Running or not, their sessions and terminals are untouched.
 */
export async function swapAgents(path: string, agentId: string, otherId: string): Promise<void> {
  const p = project(path)
  if (!p || isAssistantPath(path) || agentId === otherId || !agentOf(p, agentId) || !agentOf(p, otherId)) return
  const agents = swapAgentsIn(p.agents, agentId, otherId)
  set((s) => ({ workspace: s.workspace && { ...s.workspace, projects: s.workspace.projects.map((x) => (x.path === path ? { ...x, agents } : x)) } }))
  focusAgent(path, agentId)
  const end = movesShown.begin(path, { order: agents.map((a) => a.id) })
  const saved = await attempt(moveFailed(), () => call('agents:swap', path, agentId, otherId))
  if (end(!!saved) || !saved) await refreshWorkspace().catch(() => undefined)
}

/** Moves the focused agent (or `agentId`) one place left or right, across pages at their edges. */
/**
 * The Tiles view's move (#993, set by AgentTiles while its grid can be reordered): Move Agent Left/Right with the keyboard
 * on a tile moves that tile's agent, not the agent focused before. Returns whether it took the move.
 */
let tileNudge: ((delta: -1 | 1) => boolean) | null = null

/** Sets the Tiles view's move; returns its removal. */
export function onTileNudge(fn: (delta: -1 | 1) => boolean): () => void {
  tileNudge = fn
  return () => {
    if (tileNudge === fn) tileNudge = null
  }
}

export function nudgeAgent(delta: -1 | 1, path: string | null = get().selectedProject, agentId?: string): void {
  if (!agentId && tileNudge?.(delta)) return
  const p = path ? project(path) : undefined
  const id = agentId ?? (p ? focusedAgentId(p) : null)
  if (!p || !id) return
  // Panes side by side (#762): to the next cell, empty or not, rather than the next place in the order; a lone agent too.
  if (panesPlaced(p)) return void moveAgentPane(delta < 0 ? 'left' : 'right', p.path, id)
  if (p.agents.length < 2) return
  const i = p.agents.findIndex((a) => a.id === id)
  if (i < 0 || i + delta < 0 || i + delta >= p.agents.length) return
  void moveAgent(p.path, id, i + delta)
}

/** Whether a project's agents are shown in panes side by side, which the user places cell by cell (#762). */
export function panesPlaced(p: ProjectInfo): boolean {
  return !isAssistantPath(p.path) && projectSessionView(p.config, get().settings) === 'panes' && shownLayout(p) !== 'single'
}

/**
 * Moves an agent's pane to cell `target` of the layout shown (#762), across pages too: onto an empty cell it moves there,
 * onto another agent's the two swap. Shown at once, then saved for that layout, with the agents' order as the cells read
 * (an automatic layout becomes the one shown, chosen); the agent keeps focus, so the view goes to its page. Returns whether it moved.
 */
export function placeAgent(path: string, agentId: string, target: number): boolean {
  const p = project(path)
  if (!p || !agentOf(p, agentId) || !panesPlaced(p)) return false
  const layout = shownLayout(p)
  const before = paneCells(p)
  const cells = moveToCell(before, agentId, target, layoutPanes(layout))
  if (cells.length === before.length && cells.every((c, k) => c === before[k])) return false
  const config = { ...p.config, placement: { ...p.config.placement, [layout]: cells }, ...(p.config.layout === 'auto' ? { layout: projectLayout(p.config) } : {}) }
  const agents = orderByCells(p.agents, cells)
  set((s) => ({ workspace: s.workspace && { ...s.workspace, projects: s.workspace.projects.map((x) => (x.path === path ? { ...x, config, agents } : x)) } }))
  focusAgent(path, agentId)
  const end = movesShown.begin(path, { order: agents.map((a) => a.id), placement: config.placement, layout: config.layout })
  void attempt(moveFailed(), () => call('agents:place', path, layout, cells)).then((saved) => {
    // Puts the panes back as saved (refused, or the last of quick moves, one refused); the move's own error was already shown.
    if (end(!!saved) || !saved) void refreshWorkspace()
  })
  return true
}

/** "Agent B1: page 1, row 2, column 1", said when a pane moves from the keyboard (#762). */
const PANE_SAID = msg({ id: 'actions.pane.moved', defaultMessage: '{agent}: {pages, select, one {} other {page {page}, }}row {row}, column {column}{other, select, none {} other {, swapped with {other}}}', description: "Said to screen readers when an agent's pane is moved from the keyboard (Move Agent Left/Right/Up/Down): where it is now ({pages}: one when the project has a single page, so the page isn't said), and the agent it swapped places with ({other}; none: nothing)." })
const PANE_EDGE = msg({ id: 'actions.pane.edge', defaultMessage: "{agent} can't move further {dir, select, left {left} right {right} up {up} other {down}}", description: "Said to screen readers when an agent's pane is moved from the keyboard but is already at that edge of the layout." })

/**
 * Moves an agent's pane (the focused one, or `agentId`) to the next cell left, right, up or down (#762): left and right
 * across pages at their ends, up and down within the page. Said to screen readers. Panes side by side only.
 */
export function moveAgentPane(dir: CellDirection, path: string | null = get().selectedProject, agentId?: string): void {
  const p = path ? project(path) : undefined
  const id = agentId ?? (p ? focusedAgentId(p) : null)
  const a = p && id ? agentOf(p, id) : null
  if (!p || !a || !panesPlaced(p)) return
  const layout = shownLayout(p)
  const cells = paneCells(p)
  const target = neighbourCell(cells.indexOf(a.id), dir, layout, cells.length)
  const other = target === null ? null : agentOf(p, cells[target] ?? '')
  const said = (text: string): void => set((s) => ({ paneSaid: { text, n: (s.paneSaid?.n ?? 0) + 1 } }))
  if (target === null || !placeAgent(p.path, a.id, target)) return said(tr(PANE_EDGE, { agent: a.name, dir }))
  const now = paneCells(project(p.path) ?? p)
  const k = now.indexOf(a.id)
  const n = layoutPanes(layout)
  const cols = layoutColumns(layout)
  said(tr(PANE_SAID, { agent: a.name, pages: Math.ceil(now.length / n) > 1 ? 'many' : 'one', page: Math.floor(k / n) + 1, row: Math.floor((k % n) / cols) + 1, column: (k % n) % cols + 1, other: other?.name ?? 'none' }))
}

// ---------------------------------------------------------------------------
// Agent templates (#126)
// ---------------------------------------------------------------------------

/** What a save says it did with the template's workflow (HI-1910): saved for the project's version control, kept from before. */
const TW = {
  saved: msg({ id: 'actions.template.workflowSaved', defaultMessage: "It holds this project's workflow for {platform}.", description: "Under the notification that a template was saved (HI-1910): it holds the project's workflow options for its version control ({platform}: None or Git, as Hive names them)." }),
  kept: msg({ id: 'actions.template.workflowKept', defaultMessage: "{count, plural, one {The workflow for {platforms} it had is kept.} other {The workflows for {platforms} it had are kept.}}", description: "Under the notification that a template was saved over one of the same name (HI-1910): the workflow sections it had for {platforms} (None, Git: a list) are kept, {count} of them." }),
  changed: msg({ id: 'actions.template.workflowChanged', defaultMessage: 'The template "{template}" changed while it loaded, so its workflow wasn’t filled in. Load it again to see its workflow as it is now.', description: "A warning after loading a template (HI-1910): its workflow section changed between the Load dialog's preview and the load ({template}: its name), so the Workflow form isn't filled in with it." }),
  none: msg({ id: 'actions.template.workflowNone', defaultMessage: 'It holds no workflow.', description: "Under the notification that a template was saved (HI-1910): saved without the project's workflow, and it had none." })
}

/**
 * Save Template…: the project's agents and layout under a name, in the project (private) or, ticked, the workspace (for
 * every project). A name already there asks before it is replaced. HI-1910: ticked (by default), the project's workflow
 * too, as its section for the project's version control; the notice says what it holds, and what it kept from before.
 */
export async function saveTemplate(path: string): Promise<void> {
  const p = project(path)
  if (!p?.agents.length) return notify('info', tr(msg({ id: 'actions.template.noAgents', defaultMessage: 'No agents to save', description: "A notification's title: the project has no agents to save as a template." })), tr(msg({ id: 'actions.template.noAgentsMessage', defaultMessage: 'Add the agents first, then save them as a template.', description: 'Under the notification that there are no agents to save as a template.' })))
  let workspaceScope = false
  // Names that follow the project's key (HI-B1…) can be kept as patterns (#1440), so the template names its agents from
  // the key of whichever project it is loaded into; Darren's HB1-style names aren't the key and stay as they are.
  const key = get().projectKeys.find((k) => k.projectPath.toLowerCase() === path.toLowerCase())?.key ?? null
  const offerPatterns = namesFollowKey(p.agents.map((a) => a.name), key)
  let usePatterns = offerPatterns
  let includeWorkflow = true
  const platform = p.platform?.id ?? 'none'
  const name = await prompt({
    title: tr(msg({ id: 'actions.template.saveTitle', defaultMessage: 'Save as template', description: 'Title of the Save as Template dialog.' })),
    message: tr(msg({ id: 'actions.template.saveMessage2', defaultMessage: "A template keeps the project's {n, plural, one {agent} other {# agents}} (settings, roles and notes), its layout and, ticked below, its workflow, to load into any project later. Sessions and worktrees aren't saved.", description: "The Save as Template dialog: what a template keeps of the project's {n} agents (HI-1910: its workflow options, when the box below is ticked). Glossary: workflow." }), { n: p.agents.length }),
    placeholder: tr(msg({ id: 'actions.template.namePlaceholder', defaultMessage: 'Template name', description: "Placeholder of the Save as Template dialog's name box." })),
    confirmLabel: tr(msg({ id: 'actions.template.save', defaultMessage: 'Save', description: 'Button: saves the template.' })),
    validate: (v) => (!v.trim() ? tr(msg({ id: 'actions.template.nameEmpty', defaultMessage: 'Enter a name.', description: "Why a template's name can't be used: it is empty." })) : v.trim().length > TEMPLATE_NAME_MAX ? tr(msg({ id: 'actions.template.nameTooLong', defaultMessage: 'At most {max} characters.', description: "Why a template's name can't be used: it is longer than {max} characters." }), { max: TEMPLATE_NAME_MAX }) : null),
    check: { label: tr(msg({ id: 'actions.template.everyProject', defaultMessage: 'For every project in the workspace (else for this project only)', description: "A tick box in the Save as Template dialog: the template is the workspace's (ticked) or this project's." })), initial: false, set: (v) => (workspaceScope = v) },
    check2: offerPatterns ? { label: tr(msg({ id: 'actions.template.usePatterns', defaultMessage: 'Use the project key in names ({example} becomes {pattern}, named from the key of the project it is loaded into)', description: "A tick box in the Save as Template dialog (#1440): agent names that start with this project's key ({example}, e.g. HI-B1) are saved as a pattern ({pattern}: {key}-B{n}), so a project loading the template names them with its own key. Keep {key} and {n} as they are." }), { example: p.agents.map((a) => a.name).find((n) => n.toUpperCase().startsWith(`${key}-`)) ?? `${key}-B1`, pattern: '{key}-B{n}' }), initial: true, set: (v) => (usePatterns = v) } : undefined,
    check3: { label: tr(msg({ id: 'actions.template.includeWorkflow', defaultMessage: "Include this project's workflow (its rules for {platform}: review, checks by name, merging, stages; never its target branch, check commands or identity's name)", description: "A tick box in the Save as Template dialog (HI-1910), ticked by default: the template keeps the project's workflow options for its version control ({platform}: None or Git, as Hive names them), the rules only. Glossary: workflow, check, target branch, identity." }), { platform: tr(PLATFORM_NAME[platform]) }), initial: true, set: (v) => (includeWorkflow = v) }
  })
  if (name === null) return
  const scope: TemplateScope = workspaceScope ? 'workspace' : 'project'
  const saveFailed = (): string => tr(msg({ id: 'actions.template.saveFailed', defaultMessage: 'Could not save the template', description: "An error's title: saving a template failed." }))
  let r = await attempt(saveFailed(), () => call('templates:save', path, scope, name, false, usePatterns, includeWorkflow))
  if (r && 'exists' in r) {
    const ok = await confirm({
      title: tr(msg({ id: 'actions.template.replaceTitle', defaultMessage: 'Replace the template?', description: 'Title of the question when a template of that name exists.' })),
      message: tr(msg({ id: 'actions.template.replaceMessage', defaultMessage: '{scope, select, workspace {The workspace already has a template called "{name}".} other {This project already has a template called "{name}".}}', description: "The question when the workspace's (workspace) or this project's (other) templates already have one called {name}." }), { scope, name: name.trim() }),
      detail: tr(msg({ id: 'actions.template.replaceDetail', defaultMessage: 'Saving replaces it with these agents and this layout.', description: 'Under the question when a template of that name exists.' })),
      confirmLabel: tr(msg({ id: 'actions.template.replace', defaultMessage: 'Replace', description: 'Button: replaces the template of that name.' }))
    })
    if (!ok) return
    r = await attempt(saveFailed(), () => call('templates:save', path, scope, name, true, usePatterns, includeWorkflow))
  }
  if (r && 'saved' in r) set((s) => ({ templatesVersion: s.templatesVersion + 1 }))
  if (r && 'saved' in r) {
    // What it holds of the workflow (HI-1910): the section saved now, those kept from the template it replaced, or none.
    const w = r.workflow
    const lines = [
      tr(msg({ id: 'actions.template.savedMessage', defaultMessage: '"{name}" ({n, plural, one {# agent} other {# agents}}), for {scope, select, workspace {the workspace} other {this project}}.', description: "Under the notification that a template ({name}) of {n} agents was saved for the workspace (workspace) or this project (other)." }), { name: r.saved.name, n: r.saved.agents.length, scope }),
      ...(w.saved ? [tr(TW.saved, { platform: tr(PLATFORM_NAME[w.saved]) })] : []),
      ...(w.kept.length ? [tr(TW.kept, { count: w.kept.length, platforms: fmt.list(w.kept.map((k) => tr(PLATFORM_NAME[k]))) })] : []),
      ...(!w.saved && !w.kept.length ? [tr(TW.none)] : [])
    ]
    notify('success', tr(msg({ id: 'actions.template.saved', defaultMessage: 'Template saved', description: "A notification's title: the template was saved." })), lines.join(' '))
  }
}

/**
 * Loads a template into a project: it replaces every agent, so it says first who goes and who comes. Refused, saying
 * why, while an agent runs, a worktree has uncommitted work or a provider it needs is off or not installed (with a way
 * into Provider Setup or Settings). `from`: the project a project's template is kept in, when it isn't this one (the Templates
 * view loads any template into any project). A preset it suggests that the project's options didn't start from is
 * offered (#1436): ticked, the Version Control tab's Workflow section opens with it chosen, not saved, so what it changes
 * shows before anything is. HI-1910: a template's workflow for the project's version control is shown, and applied the
 * same way (ticked by default): the Workflow section opens with it laid over the project's options as it reads them, to
 * save there. A Git-only workflow in a project with no version control waits for Git: Set Up Git… closes the dialog and
 * opens Version Control on Git's page (`templatePending`), and the dialog opens again once the project is Git.
 */
export async function loadTemplate(path: string, entry: Pick<TemplateEntry, 'scope' | 'file' | 'name'>, from?: string): Promise<void> {
  const plan = await attempt(tr(msg({ id: 'actions.template.readFailed', defaultMessage: 'Could not read the template', description: "An error's title: reading a template failed." })), () => call('templates:plan', path, entry.scope, entry.file, from))
  if (!plan) return
  if (plan.blocked.length) {
    const where = project(path)?.name
    await choose({
      title: tr(msg({ id: 'actions.template.blockedTitle', defaultMessage: 'Can\'t load "{name}" yet', description: "Title of the message when a template ({name}) can't be loaded now (an agent runs, a provider is off…)." }), { name: plan.name }),
      message: tr(msg({ id: 'actions.template.blockedMessage', defaultMessage: "It can't be loaded into {project, select, none {this project} other {{project}}} yet:", description: "Above the reasons a template can't be loaded into a project ({project}; none when unknown)." }), { project: where ?? 'none' }),
      detail: plan.blocked.map((b) => `• ${b}`).join('\n'),
      choices: [{ label: tr(msg({ id: 'actions.template.ok', defaultMessage: 'OK', description: "Button: closes the message that a template can't be loaded yet." })), value: 'ok' }]
    })
    return
  }
  const p = project(path)
  if (!p) return
  const expected = p.agents.map((a) => a.id)
  // The names its agents get (#702): chosen in the dialog, which greys out its button while one clashes.
  let names = plan.create.map((a) => a.name)
  // The Connections section's answers (HI-2109), by the names chosen: none for an agent, its role's preselected one.
  let connections: ConnectionAnswers = {}
  // Its workflow (HI-1910) replaces the suggestion: shown and applied where it has a section for this project's version
  // control, waiting for Git where it has only Git's, said where one can't be used (never replaced by the suggestion).
  const wf = plan.workflow
  const suggested = wf ? null : plan.suggestedPreset
  let switchPreset = false
  let applyWorkflow = true
  let setUpGit = false
  // Over its Maximum agents without its workflow (HI-2058): the dialog's link closes it for Version Control → Workflow.
  let openWorkflow = false
  // The plan the dialog shows last, and what the load read (HR5's round 1: never a workflow other than the one shown).
  let shown = plan
  const got: { loaded: { workflow: TemplateWorkflow | null; maxAgents?: number } | null } = { loaded: null }
  const ok = await confirm({
    title: tr(msg({ id: 'actions.template.loadTitle', defaultMessage: 'Load "{name}"?', description: 'Title of the question before loading a template ({name}) into a project.' }), { name: plan.name }),
    message: plan.remove.length
      ? tr(msg({ id: 'actions.template.loadReplaces', defaultMessage: 'It replaces every agent of {project}.', description: 'The question before loading a template: its agents replace every agent of the project ({project}).' }), { project: p.name })
      : tr(msg({ id: 'actions.template.loadAdds', defaultMessage: 'It adds its agents to {project}.', description: 'The question before loading a template into a project ({project}) with no agents.' }), { project: p.name }),
    // Who goes and who comes, each on the connection its role starts on (HI-2109), as a table (#511), with their names to
    // choose (#702) and the Connections section.
    detail: templateLoadDetail(plan, (i) => plan.options.find((o) => o.id === loadFallback(plan.create, plan.options)(plan.create[i])) ?? null, get().settings),
    content: createElement(TemplateLoadNames, {
      path,
      scope: entry.scope,
      file: entry.file,
      from,
      initial: plan,
      onChange: (now: string[]) => void (names = now),
      onConnections: (now: ConnectionAnswers) => void (connections = now),
      onWorkflow: (v: boolean) => void (applyWorkflow = v),
      onOpenWorkflow: () => {
        openWorkflow = true
        cancelDialog()
      },
      onPlan: (now: TemplateLoadPlan) => void (shown = now),
      // Closes this dialog (nothing loaded) for Version Control's Git page: never a dialog over a dialog.
      onSetUpGit: () => {
        setUpGit = true
        cancelDialog()
      }
    }),
    wide: true,
    scrollDetail: true,
    confirmLabel: tr(msg({ id: 'actions.template.load', defaultMessage: 'Load template', description: 'Button: loads the template into the project.' })),
    busyLabel: tr(msg({ id: 'actions.template.loading', defaultMessage: 'Loading…', description: 'The Load template button while it works.' })),
    danger: plan.remove.length > 0,
    // The preset it suggests (#1436): off by default, and only ever chosen in the form, never saved from here.
    check: suggested ? { label: tr(msg({ id: 'actions.template.switchPreset', defaultMessage: 'Also switch this project to {preset}… (opens Version Control → Workflow with it chosen, to save there)', description: "A tick box when loading a template that suggests a preset ({preset}: Solo, Pair or Team, as the presets are named): after loading, the project's Version Control tab opens at Workflow with that preset chosen but not saved. Glossary: preset." }), { preset: tr(PRESET_TEXT[suggested]) }), initial: false, set: (v) => (switchPreset = v) } : undefined,
    run: async () => {
      // Its workflow ticked: its Maximum agents is saved with its agents (HI-2058), the rest filled in below.
      got.loaded = await call('templates:load', path, entry.scope, entry.file, expected, from, names, connections, applyWorkflow && !!shown.workflow?.section)
    }
  })
  if (!ok) {
    if (openWorkflow) openVersionControl(path, 'workflow')
    if (setUpGit) {
      set({ templatePending: { path, entry: { scope: entry.scope, file: entry.file, name: entry.name }, ...(from ? { from } : {}) }, vcGitPreview: path })
      openVersionControl(path, 'workflow')
    }
    return
  }
  await refreshWorkspace()
  const seen = shown.workflow
  if (applyWorkflow && seen?.section) {
    // The section the load read, only if it is the one shown: changed meanwhile, it is said, never filled in.
    const section = got.loaded?.workflow ?? null
    if (JSON.stringify(section) !== JSON.stringify(seen.section)) notify('warning', tr(TW.changed, { template: plan.name }))
    else {
      // Laid over the project's options as the Workflow form reads them, and left for the user to save (HR5: never here).
      // Its Maximum agents isn't: the load saved it with the agents (HI-2058), and the form reads it as the project's own.
      const { maxAgents: _saved, ...rules } = seen.section.options
      // The Maximum agents it saved, if it did (HI-2083: the form's note says what is saved already).
      const savedMax = got.loaded?.maxAgents
      set({ workflowPrefill: { path, preset: seen.section.preset, template: { name: plan.name, platform: seen.platform, section: { ...seen.section, options: rules }, ...(savedMax !== undefined ? { savedMax } : {}) } } })
      openVersionControl(path, 'workflow')
    }
  } else if (suggested && switchPreset) {
    // Filled in once the form has read the project's options (#1423's way), and left for the user to save.
    set({ workflowPrefill: { path, preset: suggested } })
    openVersionControl(path, 'workflow')
  }
}

/**
 * Adds one agent of a template (#1440): a dialog with what it is (its role, and the CLI it suggests) and its name to
 * choose, starting as the template's (made with this project's key), or a free one when another agent of the workspace
 * has it; a name taken is refused there, with a free one to use. It runs on its role's preselected connection (HI-2109:
 * the first on the CLI it suggests), changed afterwards in Agent Settings or with Choose Connections….
 */
export async function addAgentFromTemplate(path: string, entry: Pick<TemplateEntry, 'scope' | 'file' | 'agents'>, index: number): Promise<void> {
  const p = project(path)
  const a = entry.agents[index]
  if (!p || !a) return
  const key = get().projectKeys.find((k) => k.projectPath.toLowerCase() === path.toLowerCase())?.key ?? null
  const failed = tr(msg({ id: 'actions.template.addAgentFailed', defaultMessage: 'Could not add the agent', description: "An error's title: adding an agent from a template failed." }))
  // Names made from the project's key that isn't known here: Hive says why (never a guessed key).
  if (!key && usesKey(entry.agents)) {
    if (await attempt(failed, () => call('templates:addAgent', path, entry.scope, entry.file, index))) await refreshWorkspace()
    return
  }
  const everyone = workspaceAgentList(get().workspace?.projects)
  const own = templateAgentNames(entry.agents, key ?? '')[index]
  const initial = nameTaken(own, everyone) ? suggestTemplateAgentName(own, p.name, key, everyone.map((x) => x.name)) : own
  const name = await prompt({
    title: tr(msg({ id: 'actions.template.addTitle', defaultMessage: 'Add an agent from a template', description: 'Title of the dialog that adds one agent of a template to the project (#1440).' })),
    message: tr(msg({ id: 'actions.template.addSuggests', defaultMessage: '{role}{hasCli, select, yes { · suggests {cli}} other {}}', description: "The dialog adding one agent of a template (HI-2109): what it is: its role in the workflow ({role}: Builder, Reviewer, Either) and the coding agent CLI the template suggests ({cli}), which picks the connection it starts on. Lower case after the dot." }), { role: tr(WORKFLOW_ROLE_TEXT[a.role].name), hasCli: a.provider && isKnownProvider(a.provider) ? 'yes' : 'no', cli: a.provider && isKnownProvider(a.provider) ? providerName(a.provider) : '' }),
    fieldLabel: tr(msg({ id: 'actions.template.addName', defaultMessage: 'Its name', description: 'The dialog adding one agent of a template: the label of its name box.' })),
    initial,
    confirmLabel: tr(msg({ id: 'actions.template.addConfirm', defaultMessage: 'Add Agent', description: "The dialog adding one agent of a template: its button." })),
    validate: (v) => {
      const why = agentNameProblem(v, tr)
      if (why) return why
      const owner = nameTaken(v.trim(), everyone)
      return owner ? nameTakenMessage(v.trim(), owner, suggestTemplateAgentName(v.trim(), p.name, key, everyone.map((x) => x.name)), tr) : null
    }
  })
  if (name === null) return
  const def = await attempt(failed, () => call('templates:addAgent', path, entry.scope, entry.file, index, undefined, name.trim()))
  if (!def) return
  await refreshWorkspace()
  const now = project(path)
  if (now) showAgent(now, def.id, 'select')
}

/**
 * Choose Connections… (HI-2109, on the project's Agents page): the Load template dialog's picker over the project's
 * existing agents, by their roles; it changes only their connections, nothing loaded or replaced ("high effort for every
 * builder here"). Each choice starts at "keep each one's". Running agents keep their old connection until they restart:
 * offered once it's done, as a change of connection is in Settings (each switches once its turn is over).
 */
export async function chooseConnections(path: string): Promise<void> {
  const failed = tr(msg({ id: 'actions.chooseConnections.failed', defaultMessage: 'Could not change the connections', description: "An error's title (HI-2109): Choose Connections failed to read or change the agents' connections." }))
  const plan = await attempt(failed, () => call('templates:connectionsPlan', path))
  if (!plan) return
  const p = project(path)
  if (!p || !plan.agents.length) return
  let answers: ConnectionAnswers = {}
  let done: ConnectionsApplied | null = null
  const ok = await confirm({
    title: tr(msg({ id: 'actions.chooseConnections.title', defaultMessage: 'Choose connections for {project}', description: "Title of the Choose Connections dialog (HI-2109): chooses the connections (named setups on accounts: model, effort, mode) of a project's ({project}) agents, by role or one by one." }), { project: p.name }),
    message: tr(msg({ id: 'actions.chooseConnections.message', defaultMessage: 'Only their connections change: no agent is replaced, and their conversations stay.', description: 'The Choose Connections dialog (HI-2109), under its title: it changes nothing but the agents\' connections.' })),
    content: createElement(ChooseConnectionsBody, { plan, onAnswers: (now: ConnectionAnswers) => void (answers = now) }),
    wide: true,
    confirmLabel: tr(msg({ id: 'actions.chooseConnections.confirm', defaultMessage: 'Apply', description: 'The Choose Connections dialog\'s button (HI-2109): gives the agents the connections chosen.' })),
    busyLabel: tr(msg({ id: 'actions.chooseConnections.busy', defaultMessage: 'Applying…', description: "The Choose Connections dialog's button while it works (HI-2109)." })),
    run: async () => {
      // Bound to the agents the dialog showed (HR3's round 2): changed since, it is refused, nothing changed.
      done = await call('templates:applyConnections', path, answers, plan.agents.map((a) => a.id))
    }
  })
  if (!ok || !done) return
  await refreshWorkspace()
  const r: ConnectionsApplied = done
  if (r.skipped.length) notify('warning', tr(msg({ id: 'actions.chooseConnections.skipped', defaultMessage: '{count, plural, one {# agent kept its connection} other {# agents kept their connections}}', description: "A warning's title after Choose Connections (HI-2109): some agents ({count}) couldn't be changed." }), { count: r.skipped.length }), r.skipped.map((s) => tr(msg({ id: 'actions.chooseConnections.skippedWhy', defaultMessage: '{agent}: {why, select, running {it runs, and that connection is another coding agent’s: stop it first} other {it was removed meanwhile}}.', description: "Under that warning (HI-2109), one line per agent ({agent}): why its connection didn't change." }), { agent: s.name, why: s.why })).join('\n'))
  if (!r.restart.length) return
  const choice = await choose({
    title: tr(msg({ id: 'actions.chooseConnections.restartTitle', defaultMessage: 'Switch the running agents?', description: 'Title of the question after Choose Connections (HI-2109) changed the connection of agents that are running.' })),
    message: tr(msg({ id: 'actions.chooseConnections.restartMessage', defaultMessage: '{agents} {count, plural, one {runs on its old connection until it restarts.} other {run on their old connections until they restart.}}', description: 'That question (HI-2109): the running agents ({agents}, a list; {count} of them) keep their old connection until they restart.' }), { agents: fmt.list(r.restart.map((a) => a.name)), count: r.restart.length }),
    choices: [
      { label: tr(msg({ id: 'actions.chooseConnections.switch', defaultMessage: 'Switch Them When Their Turn Is Over', description: 'Button (HI-2109): each running agent ends once its turn is over and carries on, on the connection chosen now.' })), value: 'switch' },
      { label: tr(msg({ id: 'actions.chooseConnections.later', defaultMessage: 'Later', description: 'Button (HI-2109): leaves the running agents on their old connections until they restart.' })), value: 'later' }
    ]
  })
  if (choice === 'switch') await attempt(failed, () => call('connections:switchAffected'))
}

/** Removes an agent; for a worktree agent, asks whether to keep its worktree and branch. */
export async function removeAgent(path: string, agentId: string): Promise<void> {
  const p = project(path)
  const a = agentOf(p, agentId)
  if (!p || !a) return
  if (a.live && !(await stopIfRunning(path, agentId, { what: 'remove', agent: a.name }, 'remove'))) return
  let deleteWorktree = false
  const removeTitle = (): string => tr(msg({ id: 'actions.remove.title', defaultMessage: 'Remove {agent}?', description: 'Title of the question before removing an agent ({agent}).' }), { agent: a.name })
  // Its 0.9 worktree (#1442: slots are the pool's, never the agent's): kept or deleted with it.
  const own = legacyOf(a)
  if (own) {
    const keep = await confirm({
      title: removeTitle(),
      message: tr(msg({ id: 'actions.remove.worktreeMessage', defaultMessage: '{agent} works in its own worktree on branch {branch}.', description: 'The question before removing a worktree agent ({agent}): its git branch ({branch}).' }), { agent: a.name, branch: own.branch }),
      detail: tr(msg({ id: 'actions.remove.worktreeDetail', defaultMessage: 'Keep the worktree and branch to merge them later, or delete both. Its sessions stay in the Sessions tab either way.', description: 'Under the question before removing an agent that works in its own worktree from before 1.0.' })),
      confirmLabel: tr(msg({ id: 'actions.remove.keepWorktree', defaultMessage: 'Keep worktree and branch', description: "Button: removes the agent and keeps its worktree and branch." })),
      cancelLabel: tr(msg({ id: 'actions.remove.deleteThem', defaultMessage: 'Delete them…', description: "Button: goes on to delete the agent's worktree and branch (asks again)." })),
      action: 'remove'
    })
    if (!keep) {
      const del = await confirm({
        title: tr(msg({ id: 'actions.remove.deleteTitle', defaultMessage: 'Delete the worktree and branch?', description: "Title of the question before deleting a removed agent's worktree and branch." })),
        message: tr(msg({ id: 'actions.remove.deleteMessage', defaultMessage: 'Delete {path} and branch {branch}?', description: "The question before deleting a removed agent's worktree folder ({path}) and git branch ({branch})." }), { path: own.path, branch: own.branch }),
        detail: tr(msg({ id: 'actions.remove.deleteDetail', defaultMessage: "Anything on {branch} that hasn't been merged is lost. Cancel keeps the agent.", description: "Under the question before deleting a worktree and branch ({branch}). Cancel is the dialog's other button." }), { branch: own.branch }),
        confirmLabel: tr(msg({ id: 'actions.remove.deleteConfirm', defaultMessage: 'Delete worktree and branch', description: "Button: deletes the agent's worktree and branch and removes it." })),
        danger: true
      })
      if (!del) return
      deleteWorktree = true
    }
  } else if (!(await confirm({ title: removeTitle(), message: tr(msg({ id: 'actions.remove.message', defaultMessage: '{agent} is removed from {project}. Its sessions stay in the Sessions tab.', description: 'The question before removing an agent ({agent}) from a project ({project}).' }), { agent: a.name, project: p.name }), confirmLabel: tr(msg({ id: 'actions.remove.confirm', defaultMessage: 'Remove', description: 'Button: removes the agent.' })), action: 'remove' }))) return
  const releaseCards = await cardsOfRemovedAgent(p, agentId, a.name)
  if (releaseCards === null) return
  // Its tab shows a spinner while it goes (deleting a worktree takes a moment); a second Remove is ignored.
  const ok = await runOnce(`removeAgent:${path}#${agentId}`, () => attempt(tr(msg({ id: 'actions.remove.failed', defaultMessage: 'Could not remove agent', description: "An error's title: removing an agent failed." })), () => call('agents:remove', path, agentId, { deleteWorktree, releaseCards }).then(() => true)))
  if (!ok) return
  focusAfterRemoving(p, agentId)
  await refreshWorkspace()
  // Kept, it is an unused worktree now (#353): said once, with where to tidy it.
  if (own && !deleteWorktree) notify('info', tr(msg({ id: 'actions.remove.keptTitle', defaultMessage: "{agent}'s worktree is kept", description: "A notification's title: a removed agent's ({agent}) worktree was kept." }), { agent: a.name }), tr(msg({ id: 'actions.remove.keptMessage', defaultMessage: "{branch} in {path}. Version Control → Changes lists the project's unused worktrees, merged or not.", description: "Under the notification that a removed agent's worktree was kept: its branch ({branch}) and folder ({path}). Version Control → Changes is a project tab: use its translated names." }), { branch: own.branch, path: own.path }), [reviewUnused(path)])
}

/** A notification's button to the project's unused worktrees (#353). */
const reviewUnused = (path: string): ToastAction => ({ label: tr(msg({ id: 'actions.remove.reviewUnused', defaultMessage: 'Review unused worktrees', description: "A notification's button: shows the project's unused worktrees." })), command: 'project.unusedWorktrees', args: [path] })

/**
 * Remove All (#291): every agent of the project after one question (danger style) listing them, running ones flagged
 * and worktrees marked; running agents are stopped first. Worktrees and branches are kept, unless the box is ticked:
 * then only those merged into the repository's main branch (the one named in the question) with no uncommitted changes
 * are deleted, main checking again and guarding the deletion (`removeCheckedWorktree`); unmerged or changed work is
 * never deleted. Their cards are asked about once. One agent at a time, each
 * tab showing the spinner until it has gone; failures and kept worktrees are reported together. Sessions stay.
 */
export function removeAllAgents(path: string): Promise<void> {
  return runOnce(`removeAll:${path}`, () => removeAllAgents_(path)).then(() => undefined)
}

async function removeAllAgents_(path: string): Promise<void> {
  const p = project(path)
  if (!p || isAssistantPath(path) || !p.agents.length) return
  const checks = p.agents.some((a) => legacyOf(a)) ? await attempt(tr(msg({ id: 'actions.removeAll.checkFailed', defaultMessage: 'Could not check the worktrees', description: "An error's title: checking whether the agents' worktrees are merged failed (Remove All)." })), () => call('agents:worktreeChecks', path)) : []
  if (!checks) return
  const checkOf = (id: string) => checks.find((c) => c.agentId === id)
  const agents = p.agents
  const trees = agents.filter((a) => legacyOf(a))
  const removable = trees.filter((a) => checkOf(a.id)?.removable)
  const into = checks.find((c) => c.into)?.into
  let deleteMerged = false
  const data = batchAgentsData(p, get().tasks, 'remove', agents, (id: string) => checkOf(id))
  const lines = tableText(data)
  const note = tr(
    msg({
      id: 'actions.removeAll.note',
      defaultMessage: '{running, select, yes {Running agents are stopped first. } other {}}Their sessions stay in the Sessions tab.{trees, select, tick { Worktrees and branches are kept unless you tick the box; unmerged or changed ones are kept either way.} kept { Their worktrees and branches are kept.} other {}}',
      description: "Under Remove All's table: running agents stop first (running: yes); sessions stay; worktrees are kept unless the box is ticked (tick), always kept (kept), or there are none (other)."
    }),
    { running: agents.some((a) => a.live) ? 'yes' : 'no', trees: trees.length ? (removable.length ? 'tick' : 'kept') : 'none' }
  )
  const ok = await confirm({
    title: tr(msg({ id: 'actions.removeAll.title', defaultMessage: '{n, plural, one {Remove {agent}?} other {Remove all # agents?}}', description: "Title of Remove All's question: {n} agents ({agent}: the one's name)." }), { n: agents.length, agent: agents[0].name }),
    message: tr(msg({ id: 'actions.removeAll.message', defaultMessage: '{n, plural, one {{agent} is removed from {project}:} other {Every agent of {project} is removed:}}', description: "Remove All's question, above the table of a project's ({project}) {n} agents ({agent}: the one's name)." }), { n: agents.length, agent: agents[0].name, project: p.name }),
    detail: [lines, '', note].join('\n'),
    // The agents as a table (#572): state, card, worktree (whether the box can delete it) and what happens to each.
    content: createElement(AgentsDetail, { data, note }),
    wide: true,
    check: removable.length
      ? { label: tr(msg({ id: 'actions.removeAll.deleteMerged', defaultMessage: 'Also delete the worktrees and branches fully merged into {into} with no uncommitted changes: {branches}', description: "Remove All's tick box: also delete the agents' worktrees and branches merged into a branch ({into}) with no changes. {branches} lists them." }), { into: into ?? '', branches: removable.map((a) => legacyOf(a)?.branch ?? '').join(', ') }), initial: false, set: (v) => (deleteMerged = v) }
      : undefined,
    confirmLabel: tr(msg({ id: 'actions.removeAll.confirm', defaultMessage: '{n, plural, one {Remove} other {Remove # agents}}', description: "Remove All's button ({n} agents)." }), { n: agents.length }),
    danger: true,
    action: 'remove'
  })
  if (!ok) return
  const releaseCards = await cardsOfRemovedAgents(p, agents)
  if (releaseCards === null) return
  // Every tab shows the spinner until its agent has gone; a Remove on one meanwhile is ignored.
  const key = (id: string) => `removeAgent:${path}#${id}`
  const done = (ids: string[]) => set((s) => ({ running: Object.fromEntries(Object.entries(s.running).filter(([k]) => !ids.some((id) => k === key(id)))) }))
  set((s) => ({ running: { ...s.running, ...Object.fromEntries(agents.map((a) => [key(a.id), true])) } }))
  const deleted: string[] = []
  const kept: string[] = []
  // Worktrees left without an agent (#353's hint).
  let unused = 0
  let result: BatchResult
  try {
    for (const a of agents) if (agentOf(project(path), a.id)?.live) await call('session:stop', path, a.id).catch(() => undefined)
    await Promise.all(agents.map((a) => waitForStop(path, a.id)))
    result = await eachAgent(agents, async (a) => {
      try {
        const r = await call('agents:remove', path, a.id, { deleteWorktree: deleteMerged ? 'merged-clean' : false, mergedInto: into ?? null, releaseCards })
        const w = r.worktree
        if (w && !w.deleted) unused++
        if (w?.deleted && w.branchKept) kept.push(tr(msg({ id: 'actions.removeAll.branchKept', defaultMessage: 'branch {branch} ({why}; its worktree was deleted)', description: "Remove All's report, in the list of worktrees kept: a branch ({branch}) kept, and why ({why}), though its worktree was deleted. Lower case: listed after \"Worktrees kept:\"." }), { branch: w.branch, why: w.reason ?? '' }))
        else if (w?.deleted) deleted.push(w.branch)
        else if (deleteMerged && w) kept.push(w.reason ? tr(msg({ id: 'actions.removeAll.worktreeKept', defaultMessage: '{branch} ({why})', description: "Remove All's report, in the list of worktrees kept: a branch ({branch}) and why it was kept ({why})." }), { branch: w.branch, why: w.reason }) : tr(msg({ id: 'actions.removeAll.notChecked', defaultMessage: '{branch} (not checked)', description: "Remove All's report, in the list of worktrees kept: a branch ({branch}) Hive couldn't check." }), { branch: w.branch }))
      } catch (e) {
        throw new Error(errorMessage(e), { cause: e })
      } finally {
        done([a.id])
      }
    })
  } finally {
    done(agents.map((a) => a.id))
  }
  await refreshWorkspace()
  const trail = [
    deleted.length ? tr(msg({ id: 'actions.removeAll.deleted', defaultMessage: 'Worktrees deleted: {branches}', description: "Remove All's report: the worktrees it deleted ({branches}: their branches, listed)." }), { branches: deleted.join(', ') }) : '',
    kept.length ? tr(msg({ id: 'actions.removeAll.kept', defaultMessage: 'Worktrees kept: {branches}', description: "Remove All's report: the worktrees it kept, each with why ({branches}, listed)." }), { branches: kept.join(', ') }) : ''
  ].filter(Boolean)
  if (result.failed.length) {
    const tried = result.failed.length + result.done.length
    notify(
      'error',
      tr(msg({ id: 'actions.removeAll.failed', defaultMessage: '{all, select, yes {{tried, plural, one {Could not remove the agent} other {Could not remove the agents}}} other {{failed} of {tried} agents could not be removed}}', description: "An error's title after Remove All: none of the {tried} agents was removed (yes), or {failed} of them weren't." }), { all: result.failed.length === tried ? 'yes' : 'no', failed: result.failed.length, tried }),
      batchReport(result.failed, result.done.length ? tr(msg({ id: 'actions.removeAll.removedList', defaultMessage: 'Removed: {agents}', description: "Remove All's report: the agents it removed ({agents}: their names, listed)." }), { agents: fmt.list(result.done, 'unit') }) : null, trail),
      unused ? [reviewUnused(path)] : undefined
    )
  } else if (deleteMerged) notify('success', tr(msg({ id: 'actions.removeAll.removed', defaultMessage: '{n, plural, one {Removed {agent}} other {Removed # agents}}', description: "A notification's title after Remove All removed {n} agents ({agent}: the one's name)." }), { n: agents.length, agent: agents[0].name }), trail.join('\n'), unused ? [reviewUnused(path)] : undefined)
  // One notice for all of them: the worktrees kept are unused now (#353).
  else if (unused) notify('info', tr(msg({ id: 'actions.removeAll.keptTitle', defaultMessage: '{n, plural, one {Its worktree is kept} other {# worktrees are kept}}', description: "A notification's title after Remove All: {n} worktrees were kept and are unused now." }), { n: unused }), tr(msg({ id: 'actions.removeAll.keptMessage', defaultMessage: "The Overview lists the project's unused worktrees, merged or not.", description: "Under the notification that Remove All kept worktrees. The Overview is a project tab: use its translated name." })), [reviewUnused(path)])
}

/** Removes a worktree agent together with its worktree and branch. */
/**
 * Release Slot… (#1441): an agent's adopted worktree (its carried slot) no longer kept for it, asked first. The folder
 * and its branch stay; Hive lends it to new work once it is clean, and may rename it to a slot's name.
 */
export async function releaseCarriedSlot(path: string, agentId: string): Promise<void> {
  const a = agentOf(project(path), agentId)
  if (!a?.carriedSlot) return
  const ok = await confirm({
    title: tr(msg({ id: 'actions.releaseSlot.title', defaultMessage: "Release {agent}'s slot {slot}?", description: "Title of the question before releasing an agent's ({agent}) slot ({slot}, such as hb2): its own worktree from before 1.0, kept for it as a slot since the upgrade." }), { agent: a.name, slot: a.carriedSlot }),
    message: tr(msg({ id: 'actions.releaseSlot.message', defaultMessage: '{slot} stops being kept for {agent}. Its folder and branch stay; Combwork lends it to new work once it is clean, and may rename its folder to a slot name.', description: "The question before releasing an agent's ({agent}) slot ({slot}): what happens to it after." }), { agent: a.name, slot: a.carriedSlot }),
    detail: tr(msg({ id: 'actions.releaseSlot.detail', defaultMessage: "{agent}'s conversations there can be resumed while nothing else uses the slot.", description: "Under the question before releasing an agent's ({agent}) slot." }), { agent: a.name }),
    confirmLabel: tr(msg({ id: 'actions.releaseSlot.confirm', defaultMessage: 'Release', description: "Button: releases the agent's slot." }))
  })
  if (!ok) return
  await attempt(tr(msg({ id: 'actions.releaseSlot.failed', defaultMessage: "Could not release the slot", description: "An error's title: releasing an agent's slot failed." })), () => call('slots:releaseCarried', path, agentId))
  await refreshWorkspace()
}

/**
 * Release Slot… on a held writer (#1506): a slot an agent's run that is over still holds, its processes not known to have
 * ended (Hive quit or closed with it running, its processes kept running, or not tracked). Shows who held it and what
 * Hive lists of its processes, offers to end those first, and releases it once the user confirms; main refuses while
 * its Hive or run still lives, or when the slot changed meanwhile (the refusal stays in the dialog).
 */
export async function releaseHeldSlot(path: string, slot: string): Promise<void> {
  const w = await attempt(tr(msg({ id: 'actions.releaseHeld.readFailed', defaultMessage: "Could not read the slot's writer", description: "An error's title: Hive couldn't read who holds a slot, before Release Slot…'s question." })), () => call('slots:heldWriter', path, slot))
  if (!w) return
  const agent = agentOf(project(path), w.agent)?.name ?? w.agent
  // Only Windows' own idle Sandbox broker left (HI-2309): releasing is safe, and it is left running unless asked.
  const idle = !!w.idleBrokers && !!w.processes?.list.length
  let end = !!w.processes?.list.length && !idle
  const names = idle ? fmt.list(w.processes!.list.map((p) => p.name.replace(/\.exe$/i, '')), 'unit') : ''
  const ok = await confirm({
    title: tr(msg({ id: 'actions.releaseHeld.title', defaultMessage: "Release {agent}'s slot {slot}?", description: "Title of the question before releasing a slot ({slot}, such as slot-b) that an agent's ({agent}) last session there still holds: it has ended, but Hive doesn't know that everything it started has." }), { agent, slot }),
    message: idle
      ? tr(msg({ id: 'actions.releaseHeld.messageIdleBroker', defaultMessage: "{slot} is held by {names}, Windows' idle Sandbox broker, left by {agent}'s last session there (run {run}). No Sandbox is running, so releasing it is safe.", description: "Release Slot… (HI-2309): the slot ({slot}) is held only by Windows' own idle Windows Sandbox broker ({names}: its process names, such as WindowsSandboxServer), which the agent's ({agent}) last session left; no Sandbox runs, so nothing can write in the slot through it. {run} is the session's run id (a code such as 3f9a1c…)." }), { slot, names, agent, run: w.run })
      : w.hive.self
      ? tr(msg({ id: 'actions.releaseHeld.messageSelf', defaultMessage: "{agent}'s last session in {slot} (run {run}) has ended in this Combwork (process {pid}, running), but Combwork doesn't know that everything it started there has: until you release it, nothing else uses the slot.", description: "Release Slot…: why the slot ({slot}) is held. The session of the agent ({agent}) ended in this Hive; its processes were kept running or Hive could not follow them. {run} is the session's run id (a code such as 3f9a1c…), {pid} this Hive's process id: they tell one launch from another." }), { agent, slot, run: w.run, pid: w.hive.pid })
      : tr(msg({ id: 'actions.releaseHeld.messageGone', defaultMessage: "{slot} is held by a session of agent {agent} (run {run}) in a Combwork that is no longer running (process {pid}). Combwork can't tell whether what it started still runs: until you release it, nothing else uses the slot.", description: "Release Slot…: why the slot ({slot}) is held. The agent ({agent}) ran there in a copy of Hive that quit or closed unexpectedly; {run} is the session's run id (a code such as 3f9a1c…), {pid} that Hive's process id: they tell one launch from another. A noun before the name (glossary §1 rule 4)." }), { agent, slot, run: w.run, pid: w.hive.pid }),
    ...(w.processes?.list.length ? { list: w.processes.list.map((p) => tr(msg({ id: 'actions.releaseHeld.process', defaultMessage: '{label} (process {pid})', description: "Release Slot…: one process the agent's session left running, as listed: what it runs ({label}, such as node serve.js) and its process id ({pid})." }), { label: p.label, pid: p.pid })), listOnly: true } : {}),
    detail: idle
      ? tr(msg({ id: 'actions.releaseHeld.detailIdleBroker', defaultMessage: 'Released, the broker is left running: it is Windows’ own, and closes by itself.', description: "Release Slot… (HI-2309), under the question about a slot held only by Windows' idle Sandbox broker: releasing doesn't end it unless the box below is ticked." }))
      : w.processes?.list.length
      ? tr(msg({ id: 'actions.releaseHeld.detailListed', defaultMessage: '{n, plural, one {Combwork lists # process its session left running.} other {Combwork lists # processes its session left running.}} Released while they run, they may still write in the slot as other work uses it.', description: "Release Slot…: under the list of processes the agent's session left running ({n}: how many)." }), { n: w.processes.list.length + w.processes.more })
      : tr(msg({ id: 'actions.releaseHeld.detailUnknown', defaultMessage: "Combwork doesn't know which of the processes its session started still run. Release it once you know nothing of it still writes in the slot.", description: "Release Slot…: Hive lists no processes the agent's session left running, so it can't say whether any still run." })),
    ...(w.processes?.list.length ? { check: { label: tr(msg({ id: 'actions.releaseHeld.endFirst', defaultMessage: 'End these processes first', description: "Release Slot…: a tick box, on by default: Hive ends the listed processes before releasing the slot." })), initial: !idle, set: (v: boolean) => (end = v) } } : {}),
    confirmLabel: tr(msg({ id: 'actions.releaseHeld.confirm', defaultMessage: 'Release', description: 'Button: releases the slot.' })),
    danger: true,
    run: () => call('slots:releaseWriter', path, slot, w.run, end)
  })
  if (ok) await refreshWorkspace()
}

export async function discardAgent(path: string, agentId: string): Promise<void> {
  const p = project(path)
  const a = agentOf(p, agentId)
  const own = a ? legacyOf(a) : null
  if (!p || !a || !own) return
  const ok = await confirm({
    title: tr(msg({ id: 'actions.discard.title', defaultMessage: "Discard {agent}'s work?", description: "Title of the question before deleting a worktree agent's ({agent}) worktree and branch and removing it." }), { agent: a.name }),
    message: tr(msg({ id: 'actions.discard.message', defaultMessage: 'Delete the worktree {path} and branch {branch}, and remove {agent}?', description: "The question before discarding a worktree agent's ({agent}) work: its worktree folder ({path}) and git branch ({branch})." }), { agent: a.name, path: own.path, branch: own.branch }),
    detail: tr(msg({ id: 'actions.discard.detail', defaultMessage: "Everything on the branch that hasn't been merged is lost. Its sessions stay in the Sessions tab.", description: "Under the question before discarding a worktree agent's work." })),
    confirmLabel: tr(msg({ id: 'actions.discard.confirm', defaultMessage: 'Discard', description: "Button: deletes the agent's worktree and branch and removes it." })),
    danger: true
  })
  if (!ok) return
  const releaseCards = await cardsOfRemovedAgent(p, agentId, a.name)
  if (releaseCards === null) return
  const done = await runOnce(`removeAgent:${path}#${agentId}`, async () => {
    if (a.live) {
      await call('session:stop', path, agentId)
      await waitForStop(path, agentId)
    }
    return attempt(tr(msg({ id: 'actions.discard.failed', defaultMessage: 'Could not discard agent', description: "An error's title: discarding a worktree agent failed." })), () => call('agents:remove', path, agentId, { deleteWorktree: true, releaseCards }).then(() => true))
  })
  if (!done) return
  focusAfterRemoving(p, agentId)
  await refreshWorkspace()
}

/** Chooses the project's layout (#134: one for the project; the one that shows its agents makes it automatic again). */
export async function setLayout(path: string, layout: SessionLayout): Promise<void> {
  const p = project(path)
  if (!p) return
  await attempt(tr(msg({ id: 'actions.layout.failed', defaultMessage: 'Could not change layout', description: "An error's title: changing the project's layout failed." })), () => call('project:updateConfig', path, { layout: chosenLayout(p.config, layout) }))
  await refreshWorkspace()
}

/** The Session tab's view for a project (#975): Panes or Tiles, remembered in its project.json. */
export async function setSessionView(path: string, view: SessionView): Promise<void> {
  const p = project(path)
  if (!p) return
  // Panes leaves the focus view (#976): Tiles shows its grid again.
  if (view === 'panes') closeTile(p)
  await attempt(tr(msg({ id: 'actions.sessionView.failed', defaultMessage: 'Could not change the view', description: "An error's title: switching a project's Session tab between Panes and Tiles failed." })), () => call('project:updateConfig', path, { sessionView: view }))
  await refreshWorkspace()
}

export async function toggleActiveSelected(): Promise<void> {
  const p = get().workspace?.projects.find((x) => x.path === get().selectedProject)
  if (p) await setProjectActive(p.path, !p.active)
}

export function cycleProject(delta: number): void {
  const ws = get().workspace
  if (!ws?.projects.length) return
  const list = ws.projects.filter((p) => p.active).length ? ws.projects.filter((p) => p.active) : ws.projects
  const i = list.findIndex((p) => p.path === get().selectedProject)
  const next = list[(i + delta + list.length) % list.length]
  selectProject(next.path)
}

/** Looks for the enabled providers' CLIs again and reports what it found. */
export async function refreshProviders(): Promise<void> {
  const all = await attempt(tr(msg({ id: 'actions.providers.checkFailed', defaultMessage: 'Could not check the providers', description: "An error's title: looking for the coding agent CLIs again failed." })), () => call('provider:refresh'))
  if (!all) return
  set({ providers: all })
  const enabled = Object.values(all).filter((i) => isProviderEnabled(get().settings, i.provider))
  if (!enabled.length) return notify('info', tr(msg({ id: 'actions.providers.noneOn', defaultMessage: 'No providers are turned on', description: "A notification's title: no coding agent CLI is turned on in Settings." })), tr(msg({ id: 'actions.providers.noneOnMessage', defaultMessage: 'Turn on Claude Code or another provider in Settings → Providers.', description: 'Under the notification that no provider is on. Claude Code is a name; Settings → Providers is where: use its translated names.' })), [{ label: openSettingsLabel(), command: 'settings.providers' }])
  for (const info of enabled) {
    const name = providerName(info.provider)
    if (!info.found) notify('warning', tr(msg({ id: 'actions.providers.notInstalled', defaultMessage: '{cli} not installed', description: "A warning's title: a coding agent CLI ({cli}: \"Codex\") isn't installed." }), { cli: name }), tr(msg({ id: 'actions.providers.notInstalledMessage', defaultMessage: 'Open Help → Provider Setup to install it.', description: "Under the warning that a CLI isn't installed. Help → Provider Setup is a menu command: use its translated names." })), [{ label: tr(msg({ id: 'actions.providers.agentSetup', defaultMessage: 'Provider Setup', description: "A notification's button: opens Provider Setup (a Help window). Keep it short." })), command: 'help.agentSetup' }])
    else if (info.updateAvailable) notify('info', tr(msg({ id: 'actions.providers.updateTitle', defaultMessage: '{cli} {version} is available', description: "A notification's title: a newer version ({version}) of a CLI ({cli}) is out." }), { cli: name, version: info.latestVersion ?? '' }), tr(msg({ id: 'actions.providers.youHave', defaultMessage: 'You have {version}.', description: 'Under the notification that a newer CLI is out: the installed version ({version}).' }), { version: info.version ?? '' }), [{ label: tr(msg({ id: 'actions.providers.update', defaultMessage: 'Update', description: "A notification's button: opens Provider Setup to update the CLI. Keep it short." })), command: 'help.agentSetup', args: [info.provider] }])
    else notify('success', tr(msg({ id: 'actions.providers.upToDate', defaultMessage: '{cli} is up to date', description: "A notification's title: a CLI ({cli}) is the latest version." }), { cli: name }), tr(msg({ id: 'actions.providers.version', defaultMessage: 'Version {version}', description: 'Under the notification that a CLI is up to date: its version ({version}).' }), { version: info.version ?? '' }))
  }
}

/**
 * Copies servers a project defines in its own config (.mcp.json…) to the workspace, after showing what each runs, and
 * turns them on in that project (#713: added from the project, they are on there straight away).
 */
export async function importProjectMcp(path: string, names: string[]): Promise<void> {
  const from = findProject(get(), path)
  const where = from?.name ?? basename(path)
  const servers = ((await attempt(tr(msg({ id: 'mcp.import.readFailed', defaultMessage: 'Could not read the servers', description: "An error's title: reading the MCP servers a project defines in its own config failed." })), () => call('mcp:projectServers', path))) ?? []).filter((s) => names.includes(s.name))
  if (!servers.length) return
  const many = servers.length > 1
  const ok = await confirm({
    title: tr(msg({ id: 'mcp.import.confirmTitle', defaultMessage: '{count, plural, one {Copy {name} to the workspace?} other {Copy # MCP servers to the workspace?}}', description: "Title of Copy to workspace's confirmation. {count} servers a project defines in its own config; {name} the one when there is one." }), { count: servers.length, name: servers[0].name }),
    message: tr(
      msg({
        id: 'mcp.import.confirmMessageAdded',
        defaultMessage: '{count, plural, one {It is added to {project} straight away; other projects can add it in their MCP tab. It runs:} other {They are added to {project} straight away; other projects can add them in their MCP tab. They run:}}',
        description: "Copy to workspace's confirmation, above what the servers run. {count} is how many; {project} the project they come from."
      }),
      { count: servers.length, project: where }
    ),
    list: servers.flatMap((s) => (many ? s.runs.map((r) => `${s.name}: ${r}`) : s.runs)),
    detail: servers.flatMap((s) => s.secretWarnings).join('\n') || undefined,
    confirmLabel: tr(msg({ id: 'mcp.import.confirmButtonAdded', defaultMessage: 'Copy and Add', description: "Button (HI-2059): copies the project's MCP servers to the workspace and adds them to the project." }))
  })
  if (!ok) return
  const shown = Object.fromEntries(servers.map((s) => [s.name, s.def]))
  const r = await attempt(tr(msg({ id: 'actions.mcp.copyFailed', defaultMessage: 'Could not copy MCP servers', description: "An error's title: copying a project's MCP servers to the workspace failed." })), () => call('mcp:importFromProject', path, servers.map((s) => s.name), shown))
  if (!r?.copied.length) return
  set((s) => ({ skillsVersion: s.skillsVersion + 1 }))
  const off = r.copied.filter((n) => !r.on.includes(n))
  notify(
    off.length ? 'warning' : 'success',
    tr(msg({ id: 'actions.mcp.copied', defaultMessage: 'Copied {names} to the workspace', description: "A notification's title after Copy to workspace: the MCP servers copied ({names}, listed)." }), { names: fmt.list(r.copied, 'unit') }),
    off.length
      ? tr(
          msg({
            id: 'mcp.import.changedAdded',
            defaultMessage: "{count, plural, one {{names} changed in the project's config after you saw it, so it was copied but not added: check what it runs and add it in the project's MCP tab.} other {{names} changed in the project's config after you saw them, so they were copied but not added: check what they run and add them in the project's MCP tab.}}",
            description: 'After Copy to workspace, when servers changed between the confirmation and the copy. {names} lists them, {count} how many.'
          }),
          { count: off.length, names: fmt.list(off) }
        )
      : tr(msg({ id: 'mcp.import.added', defaultMessage: 'Added to {project} for new sessions.', description: 'After Copy to workspace (HI-2059): where the copied servers are added.' }), { project: where })
  )
}

export { basename }
