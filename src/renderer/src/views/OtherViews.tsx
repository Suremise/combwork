import { Children, useEffect, useRef, useState } from 'react'
import type { McpServerInfo, SkillInfo } from '@shared/types'
import { enabledProviders } from '@shared/providers'
import { APP_NAME } from '@shared/appName'
import { guideTarget } from '@shared/userGuide'
import iconUrl from '../assets/icon.svg'
import guideMd from '@docs/USER_GUIDE.md?raw'
import apiMd from '@docs/AGENT_API.md?raw'
import changelogMd from '@root/CHANGELOG.md?raw'
import licenseTxt from '@root/LICENSE?raw'
import noticesMd from '@root/THIRD_PARTY_NOTICES.md?raw'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { clearEditorDraft, editorDraft, onEditorDrafts, setEditorDraft } from '../editorDrafts'
import { runCommand, commandKeybinding } from '../commands'
import { DocEditor } from '../components/DocEditor'
import { workspaceNotesNotice, workspaceNotesTemplate, workspaceNotesTitle } from '../components/WorkspaceNotes'
import { workspaceNotesPath } from '@shared/workspaceNotes'
import { CodeEditor } from '../components/Editors'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import { Icon, IconButton, LoadFailed, Markdown, StaleNote, useContextMenu } from '../components/ui'
import { useScopedLoad } from '../scopedLoad'
import { SkillDetail } from '../components/Skills'
import { confirm, NO_PROJECTS, notify, set, useStore } from '../store'
import { basename, cx, formatKeybinding, recentNote, recentTip } from '../util'
import { tr, tRich, type Msg } from '@shared/i18n'
import { msg } from '@shared/i18n/msg'
import { McpCatalogDetail } from '../components/McpCatalog'

const M = {
  tagline: msg({ id: 'workspace.welcome.tagline', defaultMessage: 'Run AI coding agents across your projects, side by side.', description: "The welcome page (no workspace open), under Hive's name." }),
  start: msg({ id: 'workspace.welcome.start', defaultMessage: 'Start', description: 'The welcome page: a heading.' }),
  open: msg({ id: 'workspace.welcome.open', defaultMessage: 'Open Workspace…', description: 'The welcome page: a link.' }),
  create: msg({ id: 'workspace.welcome.create', defaultMessage: 'New Workspace…', description: 'The welcome page: a link.' }),
  choose: msg({ id: 'workspace.welcome.choose', defaultMessage: 'Choose your coding agents (Claude Code, …)', description: 'The welcome page, with no coding agent turned on: opens Settings → Providers.' }),
  install: msg({ id: 'workspace.welcome.install', defaultMessage: 'Install {provider}…', description: 'The welcome page: a coding agent turned on but not installed ({provider}: Claude Code).' }),
  recent: msg({ id: 'workspace.welcome.recent', defaultMessage: 'Recent', description: 'The welcome page: the heading over recent workspaces.' }),
  noRecent: msg({ id: 'workspace.welcome.noRecent', defaultMessage: 'No recent workspaces.', description: 'The welcome page with no recent workspaces.' }),
  removeRecentMenu: msg({ id: 'workspace.welcome.removeRecentMenu', defaultMessage: 'Remove from Recent', description: "A recent workspace's right-click menu." }),
  removeRecentLabel: msg({ id: 'workspace.welcome.removeRecentLabel', defaultMessage: 'Remove {name} from recent', description: "A recent workspace's ✕ button, for screen readers." }),
  removeRecentTip: msg({ id: 'workspace.welcome.removeRecentTip', defaultMessage: 'Remove from recent', description: "Tooltip on a recent workspace's ✕ button." }),
  help: msg({ id: 'workspace.welcome.help', defaultMessage: 'Help', description: 'The welcome page: a heading.' }),
  guide: msg({ id: 'workspace.welcome.guide', defaultMessage: 'User guide', description: 'The welcome page: a link to the user guide.' }),
  apiReference: msg({ id: 'workspace.welcome.apiReference', defaultMessage: 'Agent API reference', description: "The welcome page: a link to the Agent API's documentation." }),
  shortcuts: msg({ id: 'workspace.welcome.shortcuts', defaultMessage: 'Keyboard shortcuts', description: 'The welcome page: a link.' }),
  howItWorks: msg({ id: 'workspace.welcome.howItWorks', defaultMessage: 'How Combwork works', description: 'The welcome page: a heading.' }),
  workspace: msg({ id: 'workspace.welcome.workspace', defaultMessage: 'Workspace', description: 'The welcome page, How Hive works: a heading.' }),
  workspaceText: msg({ id: 'workspace.welcome.workspaceText', defaultMessage: 'A folder of projects. Combwork adds a <code>.combwork</code> folder for shared notes, skills and MCP servers — commit it to share with your team.', description: 'The welcome page, How Hive works. <code> is a folder name: keep .combwork as it is.' }),
  projects: msg({ id: 'workspace.welcome.projects', defaultMessage: 'Projects', description: 'The welcome page, How Hive works: a heading.' }),
  projectsText: msg({ id: 'workspace.welcome.projectsText', defaultMessage: "Each subfolder is a project. Toggle the ones you're working on; each gets its own coding agents, running side by side.", description: 'The welcome page, How Hive works.' }),
  skills: msg({ id: 'workspace.welcome.skills', defaultMessage: 'Skills & MCP', description: 'The welcome page, How Hive works: a heading.' }),
  skillsText: msg({ id: 'workspace.welcome.skillsText', defaultMessage: 'Combwork skills in the workspace reach the agents of every project (and the Assistant, for those written for it); each project also shows its own and your user skills. An MCP server is on only where you turn it on: in one project, or in all of them. Changes apply to new sessions.', description: 'The welcome page, How Hive works.' }),
  flow: msg({ id: 'workspace.welcome.flow', defaultMessage: 'Stay in flow', description: 'The welcome page, How Hive works: a heading.' }),
  flowText: msg({ id: 'workspace.welcome.flowText', defaultMessage: 'Combwork chimes and notifies you when an agent finishes or needs input — even from the system tray.', description: 'The welcome page, How Hive works.' }),
  selectNote: msg({ id: 'workspace.notes.select', defaultMessage: 'Select a note, or create one. Shared notes live in <code>.combwork/shared</code> and are available to every project and agent.', description: "The Shared Notes view with no note selected. <code> is a folder: keep .combwork/shared as it is." }),
  deleteNote: msg({ id: 'workspace.notes.delete', defaultMessage: 'Delete note', description: "A button over an open shared note." }),
  skillLoadTarget: msg({ id: 'workspace.skillView.loadTarget', defaultMessage: 'the skill', description: 'What could not be loaded: shown in "Could not load {what}: {error}", with Retry.' }),
  skillRefreshTarget: msg({ id: 'workspace.skillView.refreshTarget', defaultMessage: 'the skill', description: 'What could not be refreshed while the skill stays open: shown in "Could not refresh {what}; last updated …", with Retry.' }),
  selectSkill: msg({ id: 'workspace.skillView.select', defaultMessage: 'Select a Combwork skill to view or edit it. The agents in every project of this workspace get these skills, except those marked for the Assistant and those switched off beside them (Delivered to agents).', description: 'The Skills view with no skill selected.' }),
  skillGone: msg({ id: 'workspace.skillView.gone', defaultMessage: 'The skill <b>{name}</b> no longer exists in this workspace. It may have been deleted or renamed.', description: 'The Skills view, for a skill deleted or renamed since it was chosen. <b> is bold.' }),
  ok: msg({ id: 'workspace.skillView.ok', defaultMessage: 'OK', description: 'The Skills view, under a skill that no longer exists: closes it.' }),
  mcpFormat: msg({ id: 'workspace.mcpView.format', defaultMessage: "**Format** — one server per file, in Claude Code's .mcp.json format (Combwork converts it for other providers) plus an optional `description`:", description: "An MCP server's view, beside its editor (Markdown: keep ** and the backticks). An example follows." }),
  mcpRemote: msg({ id: 'workspace.mcpView.remote', defaultMessage: 'Remote servers use `"type": "http"` and `"url"`. Reference secrets as environment variables — this folder is meant to be committed.', description: "An MCP server's view, beside its editor (Markdown: keep the backticks and what is in them)." }),
  mcpDir: msg({ id: 'workspace.mcpView.dir', defaultMessage: 'Use {variable} to point at server code stored in `.combwork/mcp`.', description: "An MCP server's view, beside its editor (Markdown). {variable} is ${CW_MCP_DIR}." }),
  selectMcp: msg({ id: 'workspace.mcpView.select', defaultMessage: 'Select an MCP server to edit its definition.', description: 'The MCP view with no server selected.' }),
  builtIn: msg({ id: 'workspace.mcpView.builtIn', defaultMessage: 'Built-in Combwork MCP server', description: "The heading of the built-in hive server's page." }),
  builtInText: msg({ id: 'workspace.mcpView.builtInText', defaultMessage: 'Every session started from Combwork gets a <code>combwork</code> MCP server that connects to the Agent API{hasUrl, select, yes { at {url}} other {}}. Turn it off in Settings → Agent API.', description: "The built-in server's page. <code> is the server's name: keep combwork as it is (HI-2463)." }),
  tool: msg({ id: 'workspace.mcpView.tool', defaultMessage: 'Tool', description: "The built-in server's tools table: a column (the tool's name)." }),
  whatItDoes: msg({ id: 'workspace.mcpView.whatItDoes', defaultMessage: 'What it does', description: "The built-in server's tools table: a column." }),
  toolListProjects: msg({ id: 'workspace.mcpView.toolListProjects', defaultMessage: 'List projects and their session status', description: "What the built-in server's cw_list_projects tool does." }),
  toolProjectStatus: msg({ id: 'workspace.mcpView.toolProjectStatus', defaultMessage: 'Status and settings of one project', description: "What the built-in server's cw_project_status tool does." }),
  toolSessionUsage: msg({ id: 'workspace.mcpView.toolSessionUsage', defaultMessage: 'Token use, cache and compactions for a session', description: "What the built-in server's cw_session_usage tool does." }),
  toolListNotes: msg({ id: 'workspace.mcpView.toolListNotes', defaultMessage: 'List notes in .combwork/shared', description: "What the built-in server's cw_list_shared_notes tool does." }),
  toolReadNote: msg({ id: 'workspace.mcpView.toolReadNote', defaultMessage: 'Read a shared note', description: "What the built-in server's cw_read_shared_note tool does." }),
  toolWriteNote: msg({ id: 'workspace.mcpView.toolWriteNote', defaultMessage: 'Create, overwrite or append to a shared note', description: "What the built-in server's cw_write_shared_note tool does." }),
  toolHandover: msg({ id: 'workspace.mcpView.toolHandover', defaultMessage: 'Write a handover note for a future session', description: "What the built-in server's cw_create_handover tool does." }),
  toolNotify: msg({ id: 'workspace.mcpView.toolNotify', defaultMessage: 'Show a notification to you in Combwork', description: "What the built-in server's cw_notify tool does." }),
  toolListSkills: msg({ id: 'workspace.mcpView.toolListSkills', defaultMessage: 'List skills available to a project', description: "What the built-in server's cw_list_skills tool does." }),
  tryAsking: msg({ id: 'workspace.mcpView.tryAsking', defaultMessage: 'Try asking an agent: *"Write a handover for the next session using the hive tools."*', description: "The built-in server's page, under its tools (Markdown: keep the * around the example prompt)." }),
  invalidJson: msg({ id: 'workspace.mcpView.invalidJson', defaultMessage: 'Invalid JSON: {error}', description: "An MCP server's view: what was typed isn't JSON ({error}: the parser's message)." }),
  saveFailed: msg({ id: 'workspace.mcpView.saveFailed', defaultMessage: 'Could not save', description: "An error notice: an MCP server's definition." }),
  overwriteTitle: msg({ id: 'workspace.mcpView.overwriteTitle', defaultMessage: 'Overwrite the changes on disk?', description: "Confirmation before saving over a server's file changed elsewhere." }),
  overwriteMessage: msg({ id: 'workspace.mcpView.overwriteMessage', defaultMessage: '{file} has changed on disk since you opened it. Save your version over it?', description: "Confirmation before saving over a server's file changed elsewhere ({file}: github.json)." }),
  overwriteDetail: msg({ id: 'workspace.mcpView.overwriteDetail', defaultMessage: 'Cancel keeps your edits here unsaved.', description: "Confirmation before saving over a server's file changed elsewhere." }),
  overwrite: msg({ id: 'workspace.mcpView.overwrite', defaultMessage: 'Overwrite', description: "That confirmation's button." }),
  deleteServer: msg({ id: 'workspace.mcpView.deleteServer', defaultMessage: 'Delete server', description: "A button over an MCP server's definition." }),
  save: msg({ id: 'workspace.mcpView.save', defaultMessage: 'Save', description: "A button over an MCP server's definition." }),
  whatItRuns: msg({ id: 'workspace.mcpView.whatItRuns', defaultMessage: 'What it runs', description: "An MCP server's view: the command it runs, for screen readers." }),
  docGuide: msg({ id: 'workspace.docs.guide', defaultMessage: 'User Guide', description: 'The Documentation view: a page.' }),
  docApi: msg({ id: 'workspace.docs.api', defaultMessage: 'Agent API', description: "The Documentation view: the Agent API's page." }),
  docChangelog: msg({ id: 'workspace.docs.changelog', defaultMessage: 'Release Notes', description: 'The Documentation view: a page.' }),
  docLicense: msg({ id: 'workspace.docs.license', defaultMessage: 'License', description: "The Documentation view: Hive's licence page, and its heading." }),
  docNotices: msg({ id: 'workspace.docs.notices', defaultMessage: 'Third-Party Notices', description: 'The Documentation view: a page (the licences of what Hive includes).' }),
  seeAlso: msg({ id: 'workspace.docs.seeAlso', defaultMessage: 'See also the [third-party notices]({file}).', description: "Under Hive's licence (Markdown: a link, its words in the brackets; {file} is the page it opens)." }),
  documentation: msg({ id: 'workspace.docs.title', defaultMessage: 'Documentation', description: "The Documentation view's heading." }),
  docShortcuts: msg({ id: 'workspace.docs.shortcuts', defaultMessage: 'Keyboard Shortcuts', description: 'The Documentation view: opens the keyboard shortcuts.' }),
  about: msg({ id: 'workspace.docs.about', defaultMessage: 'About {app}', description: "The Documentation view: opens About ({app}: Hive's name)." })
}

const code = (c: React.ReactNode[]): React.ReactNode => <code>{c}</code>
const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>
const rich = (m: Msg, values: Record<string, string> = {}): React.ReactNode[] => Children.toArray(tRich<React.ReactNode>(m, { ...values, code, b: bold }))

// ---------------------------------------------------------------------------
// Welcome (no workspace open)
// ---------------------------------------------------------------------------

export function WelcomeView() {
  const recent = useStore((s) => s.recent)
  const recentMenu = useContextMenu()
  // Whether each folder is there now (#144): when shown, and when Hive comes back to the front (a folder deleted meanwhile).
  useEffect(() => {
    void actions.loadRecent()
    const again = (): void => void actions.loadRecent()
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [])
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const on = enabledProviders(settings)
  const missing = on.filter((p) => providers[p.id] && !providers[p.id].checking && !providers[p.id].found)
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-hero">
          <img src={iconUrl} alt="" />
          <div>
            <h1>{APP_NAME}</h1>
            <p>{tr(M.tagline)}</p>
          </div>
        </div>
        <div className="welcome-cols">
          <div>
            <h3>{tr(M.start)}</h3>
            <div className="welcome-link" onClick={() => runCommand('workspace.open')}>
              <Icon name="folder-opened" /> {tr(M.open)} <span className="muted">{formatKeybinding(commandKeybinding('workspace.open') ?? '')}</span>
            </div>
            <div className="welcome-link" onClick={() => runCommand('workspace.create')}>
              <Icon name="new-folder" /> {tr(M.create)}
            </div>
            {settings && !on.length && (
              <div className="welcome-link" onClick={() => runCommand('settings.providers')}>
                <Icon name="hubot" /> {tr(M.choose)}
              </div>
            )}
            {missing.map((p) => (
              <div key={p.id} className="welcome-link" onClick={() => set({ setupOpen: p.id })}>
                <Icon name="cloud-download" /> {tr(M.install, { provider: p.name })}
              </div>
            ))}
            <h3 style={{ marginTop: 28 }}>{tr(M.recent)}</h3>
            {recent.length === 0 && <div className="muted">{tr(M.noRecent)}</div>}
            {recent.map((r) => (
              <div
                key={r.path}
                className={cx('welcome-link', 'recent-item', !r.exists && 'missing')}
                title={recentTip(r)}
                tabIndex={0}
                onClick={() => void actions.openRecent(r.path)}
                // The row's own Enter only: one on its ✕ removes the entry (the button's own activation), never opens it.
                onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && void actions.openRecent(r.path)}
                onContextMenu={(e) => recentMenu.open(e, [{ label: tr(M.removeRecentMenu), icon: 'close', onClick: () => void actions.removeRecent(r.path) }])}
              >
                <Icon name={r.exists ? 'root-folder' : 'warning'} /> <span className="recent-name">{basename(r.path)}</span> <span className="muted recent-note">{recentNote(r)}</span>
                <button
                  className="recent-remove"
                  aria-label={tr(M.removeRecentLabel, { name: basename(r.path) })}
                  title={tr(M.removeRecentTip)}
                  onClick={(e) => {
                    e.stopPropagation()
                    void actions.removeRecent(r.path)
                  }}
                >
                  <Icon name="close" />
                </button>
              </div>
            ))}
            {recentMenu.element}
            <h3 style={{ marginTop: 28 }}>{tr(M.help)}</h3>
            <div className="welcome-link" onClick={() => runCommand('help.docs')}>
              <Icon name="book" /> {tr(M.guide)}
            </div>
            <div className="welcome-link" onClick={() => runCommand('help.api')}>
              <Icon name="plug" /> {tr(M.apiReference)}
            </div>
            <div className="welcome-link" onClick={() => runCommand('help.shortcuts')}>
              <Icon name="keyboard" /> {tr(M.shortcuts)}
            </div>
          </div>
          <div>
            <h3>{tr(M.howItWorks)}</h3>
            <div className="walkthrough">
              <Icon name="root-folder" />
              <div>
                <strong>{tr(M.workspace)}</strong>
                <p>{rich(M.workspaceText)}</p>
              </div>
            </div>
            <div className="walkthrough">
              <Icon name="folder" />
              <div>
                <strong>{tr(M.projects)}</strong>
                <p>{tr(M.projectsText)}</p>
              </div>
            </div>
            <div className="walkthrough">
              <Icon name="sparkle" />
              <div>
                <strong>{tr(M.skills)}</strong>
                <p>{tr(M.skillsText)}</p>
              </div>
            </div>
            <div className="walkthrough">
              <Icon name="bell" />
              <div>
                <strong>{tr(M.flow)}</strong>
                <p>{tr(M.flowText)}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared notes
// ---------------------------------------------------------------------------

export function NotesView() {
  const selected = useStore((s) => s.selectedNote)
  const workspace = useStore((s) => s.workspace)
  if (!workspace) return <WelcomeView />
  if (!selected) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="notebook" />
        {rich(M.selectNote)}
      </div>
    )
  }
  // Workspace notes (#1433): titled, started from a template, and saying as you type who gets it and whether it is cut.
  if (selected.toLowerCase() === workspaceNotesPath(workspace.path).toLowerCase()) {
    return (
      <div className="split">
        <DocEditor key={selected} path={selected} title={workspaceNotesTitle()} createIfMissing={workspaceNotesTemplate()} notice={workspaceNotesNotice} toolbarExtra={<IconButton icon="trash" title={tr(M.deleteNote)} onClick={() => void actions.deleteNote(selected, basename(selected), false)} />} />
      </div>
    )
  }
  return (
    <div className="split">
      <DocEditor key={selected} path={selected} toolbarExtra={<IconButton icon="trash" title={tr(M.deleteNote)} onClick={() => void actions.deleteNote(selected, basename(selected), false)} />} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skill detail
// ---------------------------------------------------------------------------

export function SkillView() {
  const selected = useStore((s) => s.selectedSkill)
  const version = useStore((s) => s.skillsVersion)
  const workspace = useStore((s) => s.workspace)
  // This workspace's skills. A failed read isn't "this skill no longer exists".
  const wsPath = workspace?.path ?? ''
  const loaded = useScopedLoad<SkillInfo[]>(wsPath)
  const list = loaded.data
  const error = loaded.error
  const { load } = loaded

  useEffect(() => load(wsPath, () => call('skills:workspace')), [version, wsPath, load])

  const skill = selected ? list?.find((s) => s.path === selected) : undefined
  // Read again everywhere the skills show, the sidebar too (#841).
  const retry = (): void => set((s) => ({ skillsVersion: s.skillsVersion + 1 }))
  // Not read, or not found in a list that failed to refresh: unknown, so not "no longer exists".
  if (selected && error && !list?.some((s) => s.path === selected)) return <LoadFailed what={tr(M.skillLoadTarget)} error={error} onRetry={retry} />
  if (!selected || !list) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="sparkle" />
        {tr(M.selectSkill)}
      </div>
    )
  }
  if (!skill) {
    // E.g. "Edit in workspace" from a project, for a skill deleted or renamed since.
    const name = selected.split(/[\\/]/).pop()
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="warning" />
        <div>{rich(M.skillGone, { name: name ?? '' })}</div>
        <button className="btn subtle" style={{ marginTop: 12 }} onClick={() => set({ selectedSkill: null, skillEdit: null })}>
          {tr(M.ok)}
        </button>
      </div>
    )
  }
  // A refresh that failed: the skill stays open, as last read, under the note. The same tree either way, so the
  // editor (and any edits in it) stays.
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {error && <StaleNote what={tr(M.skillRefreshTarget)} error={error} at={loaded.at} onRetry={retry} />}
      <div style={{ position: 'relative', flex: 1 }}>
        <div className="split">
          <SkillDetail skill={skill} where="workspace" onDeleted={() => set({ selectedSkill: null })} onRestored={(r) => set({ selectedSkill: r.path })} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MCP server detail
// ---------------------------------------------------------------------------

/** The example server beside an MCP server's editor: a definition, not text to translate. */
// i18n-ignore: an example definition (JSON), not text to translate
const MCP_EXAMPLE = `\`\`\`json
{
  "description": "GitHub issues and pull requests",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" }
}
\`\`\``

/** The format help beside an MCP server's editor, worded when shown. */
// Each its own paragraph: a single line break is a space in Markdown, which Chinese and Japanese don't put between sentences (#893).
const mcpHelp = (): string => [tr(M.mcpFormat), MCP_EXAMPLE, tr(M.mcpRemote), tr(M.mcpDir, { variable: '`${CW_MCP_DIR}`' })].join('\n\n')

export function McpView() {
  const selected = useStore((s) => s.selectedMcp)
  // One editor per server (and workspace): a load or save still running for one can't land in another's.
  const ws = useStore((s) => s.workspace?.path ?? '')
  // The Catalogue tab (HI-545) shows the catalogue server chosen in it.
  const tab = useStore((s) => s.mcpTab)
  if (tab === 'catalogue') return <McpCatalogDetail />
  return <McpServerView key={`${ws}|${selected ?? ''}`} selected={selected} />
}

function McpServerView({ selected }: { selected: string | null }) {
  const version = useStore((s) => s.skillsVersion)
  const api = useStore((s) => s.api)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [info, setInfo] = useState<McpServerInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The editor's share of the width; the format help beside it takes the rest (drag the edge between them).
  const editorShare = usePaneSize('mcpHelp', 0.68)

  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!selected || selected === '__hive') return
    // Another server selected before this one loaded: its text must not show (and be saved) under that one.
    let current = true
    void call('mcp:read', selected).then((t) => {
      if (!current) return
      // Edits left unsaved earlier come back, still based on the text they were made to.
      const draft = editorDraft(`mcp:${selected}`)
      setText(draft ? draft.text : t)
      setSaved(draft ? draft.base : t)
      setError(null)
    })
    return () => {
      current = false
    }
  }, [selected, reload])
  // Saved or discarded from elsewhere (Save All before closing the workspace…): show the file as it now is.
  const dirtyNow = useRef(false)
  dirtyNow.current = text !== saved
  // The editor's text right now (a save in progress compares it with what it wrote).
  const latest = useRef(text)
  latest.current = text
  useEffect(() => onEditorDrafts(() => void (selected && dirtyNow.current && !editorDraft(`mcp:${selected}`) && setReload((n) => n + 1))), [selected])
  useEffect(() => {
    if (!selected || selected === '__hive') return
    let current = true
    void call('mcp:list').then((l) => current && setInfo(l.find((m) => m.name === selected) ?? null))
    return () => {
      current = false
    }
  }, [selected, version])

  if (!selected) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="plug" />
        {tr(M.selectMcp)}
      </div>
    )
  }
  if (selected === '__hive') {
    return (
      <div className="scroll-page">
        <div className="page-narrow">
          <h2 className="section">
            <Icon name="hubot" /> {tr(M.builtIn)}
          </h2>
          <p className="hint">{rich(M.builtInText, { hasUrl: api?.url ? 'yes' : 'no', url: api?.url ?? '' })}</p>
          <Markdown source={hiveToolsTable()} />
        </div>
      </div>
    )
  }

  const dirty = text !== saved
  const draftKey = `mcp:${selected}`
  // Saved as written to disk (with a final newline), so the next save compares with what is really there.
  const asWritten = (content: string): string => (content.endsWith('\n') ? content : content + '\n')
  const baseText = (): string => editorDraft(draftKey)?.base ?? saved
  const writeMcp = async (content: string, base: string): Promise<string> => {
    await call('mcp:save', selected, asWritten(content), base)
    return asWritten(content)
  }
  const edit = (v: string): void => {
    setText(v)
    setEditorDraft({ key: draftKey, label: /* i18n-ignore: a file's name */ `${selected}.json`, abs: info?.path ?? `${selected}.json`, text: v, base: baseText(), save: writeMcp })
  }
  const save = async (): Promise<void> => {
    try {
      JSON.parse(text)
    } catch (e) {
      setError(tr(M.invalidJson, { error: errorMessage(e) }))
      return
    }
    let r: McpServerInfo | undefined
    const written = asWritten(text)
    try {
      r = await call('mcp:save', selected, written, baseText())
    } catch (e) {
      if (!errorMessage(e).includes('CONFLICT')) return notify('error', tr(M.saveFailed), errorMessage(e))
      const overwrite = await confirm({
        title: tr(M.overwriteTitle),
        message: tr(M.overwriteMessage, { file: `${selected}.json` }),
        detail: tr(M.overwriteDetail),
        confirmLabel: tr(M.overwrite),
        danger: true
      })
      if (!overwrite) return
      r = await actions.attempt(tr(M.saveFailed), () => call('mcp:save', selected, written))
    }
    if (r) {
      // Typed into while it was saving (even back to what it was before): the newer text stays a draft, now of what was written.
      if (latest.current !== text) setEditorDraft({ key: draftKey, label: /* i18n-ignore: a file's name */ `${selected}.json`, abs: info?.path ?? `${selected}.json`, text: latest.current, base: written, save: writeMcp })
      else {
        clearEditorDraft(draftKey)
        setText(written)
      }
      setSaved(written)
      setError(null)
      setInfo(r)
    }
  }
  const remove = (): Promise<boolean> => actions.deleteMcpServer(info ?? { name: selected, def: null, projects: [], assistant: false })

  return (
    <div className="split">
      <div className="split-main">
        <div className="editor-toolbar">
          <Icon name="plug" />
          <span className="path">
            <strong>{selected}</strong>
            {dirty && ' ●'} <span className="faint">{info?.path}</span>
          </span>
          {info && (
            <>
              {!info.error && <span className="faint mcp-where">{actions.mcpWhereText(info, projects)}</span>}
              <button className="btn small" data-action="mcp-places" disabled={!!info.error} onClick={() => void actions.chooseMcpPlaces(info).then(() => call('mcp:list')).then((l) => setInfo((was) => l.find((m) => m.name === selected) ?? was))}>
                <Icon name="add" /> {tr(msg({ id: 'mcp.view.addTo', defaultMessage: 'Add to…', description: "A button in an MCP server's view (HI-2059): chooses the projects, and the Hive Assistant, it is added to." }))}
              </button>
            </>
          )}
          <IconButton icon="trash" title={tr(M.deleteServer)} onClick={() => void remove()} />
          <button className="btn small primary" disabled={!dirty} onClick={() => void save()}>
            <Icon name="save" /> {tr(M.save)}
          </button>
        </div>
        {(error || info?.error) && (
          <div className="banner danger">
            <Icon name="error" /> {error ?? info?.error}
          </div>
        )}
        {info?.secretWarnings.map((w) => (
          <div key={w} className="banner warn">
            <Icon name="warning" /> {w}
          </div>
        ))}
        {!!info?.runs.length && (
          <div className="banner info mcp-runs" aria-label={tr(M.whatItRuns)}>
            <Icon name="terminal" />
            <div>
              {info.runs.map((r) => (
                <div key={r}>{r}</div>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div className="editor-host" style={{ flex: `0 0 ${editorShare * 100}%`, position: 'relative' }}>
            <CodeEditor value={text} language="json" onChange={edit} onSave={() => void save()} wordWrap={false} />
            <PaneResizer paneKey="mcpHelp" ratio />
          </div>
          <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid var(--border-subtle)', overflow: 'auto', padding: '14px 16px', fontSize: 12 }}>
            <Markdown source={mcpHelp()} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

/** The built-in hive server's tools, as a table (the tools' names are theirs; what they do is window text). */
function hiveToolsTable(): string {
  const tools: [string, Msg][] = [
    ['cw_list_projects', M.toolListProjects],
    ['cw_project_status', M.toolProjectStatus],
    ['cw_session_usage', M.toolSessionUsage],
    ['cw_list_shared_notes', M.toolListNotes],
    ['cw_read_shared_note', M.toolReadNote],
    ['cw_write_shared_note', M.toolWriteNote],
    ['cw_create_handover', M.toolHandover],
    ['cw_notify', M.toolNotify],
    ['cw_list_skills', M.toolListSkills]
  ]
  return [`| ${tr(M.tool)} | ${tr(M.whatItDoes)} |`, '|---|---|', ...tools.map(([name, what]) => `| \`${name}\` | ${tr(what)} |`), '', tr(M.tryAsking)].join('\n')
}

/** The Documentation view's pages: their labels are the window's; the documents themselves are English until D2. */
const DOCS: { id: string; label: Msg; icon: string; source: () => string; file: string }[] = [
  { id: 'guide', label: M.docGuide, icon: 'book', source: () => guideMd, file: 'USER_GUIDE.md' },
  { id: 'api', label: M.docApi, icon: 'plug', source: () => apiMd, file: 'AGENT_API.md' },
  { id: 'changelog', label: M.docChangelog, icon: 'history', source: () => changelogMd, file: 'CHANGELOG.md' },
  // i18n-ignore: the Markdown around the licence's own text (English, as the licence is) and its messages
  { id: 'license', label: M.docLicense, icon: 'law', source: () => `# ${tr(M.docLicense)}\n\n\`\`\`text\n${licenseTxt.trim()}\n\`\`\`\n\n${tr(M.seeAlso, { file: 'THIRD_PARTY_NOTICES.md' })}\n`, file: 'LICENSE' },
  { id: 'notices', label: M.docNotices, icon: 'references', source: () => noticesMd, file: 'THIRD_PARTY_NOTICES.md' }
]

export function DocsView() {
  const page = useStore((s) => s.docsPage)
  const listWidth = usePaneSize('docs', 220)
  const doc = DOCS.find((d) => d.id === page) ?? DOCS[0]
  const api = useStore((s) => s.api)
  const source = api?.url ? doc.source().replace(/http:\/\/127\.0\.0\.1:47821/g, api.url) : doc.source()
  // Opened at a heading by its id (a tip's Learn more, #1535): scroll to it once the page has rendered, and mark it briefly.
  const anchor = useStore((s) => s.docsAnchor)
  const pageRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!anchor) return
    const t = setTimeout(() => {
      // Resolved as card references and cw_read_section resolve a heading: an id none or several carry goes nowhere.
      const slug = guideTarget(source, anchor)
      if (!slug) console.warn(`Docs: no single heading has the id "${anchor}"`) // i18n-ignore: a developer's console line
      const h = slug ? [...(pageRef.current?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? [])].find((x) => x.id === slug) : undefined
      if (h) {
        h.scrollIntoView({ block: 'start' })
        h.classList.add('docs-target')
        setTimeout(() => h.classList.remove('docs-target'), 2000)
      }
      set({ docsAnchor: null })
    }, 50)
    return () => clearTimeout(t)
  }, [anchor, doc.id, source])
  return (
    <div className="split">
      <div className="split-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="docs" max={500} />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          {tr(M.documentation)}
        </div>
        <div className="pane-body">
          {DOCS.map((d) => (
            <div key={d.id} className={cx('row', d.id === doc.id && 'selected')} onClick={() => set({ docsPage: d.id })}>
              <Icon name={d.icon} /> <span className="label">{tr(d.label)}</span>
            </div>
          ))}
          <div className="row" onClick={() => set({ shortcutsOpen: true })}>
            <Icon name="keyboard" /> <span className="label">{tr(M.docShortcuts)}</span>
          </div>
          <div className="row" onClick={() => set({ aboutOpen: true })}>
            <Icon name="info" /> <span className="label">{tr(M.about, { app: APP_NAME })}</span>
          </div>
        </div>
      </div>
      <div className="split-main">
        <div ref={pageRef} className="scroll-page" style={{ position: 'relative', flex: 1 }}>
          <Markdown
            source={source}
            onLink={(href) => {
              const target = DOCS.find((d) => href === d.file || href.endsWith(`/${d.file}`))
              if (target) {
                set({ docsPage: target.id })
                return true
              }
              return false
            }}
          />
        </div>
      </div>
    </div>
  )
}
