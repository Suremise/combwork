import { useEffect, useState } from 'react'
import type { McpServerInfo, ProjectInfo } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { useNow } from '../usage'
import { set, setAssistantOpen, useStore } from '../store'
import { cx, formatNumber, formatTokens } from '../util'
import { SessionsTab } from '../views/SessionsTab'
import { AttachmentsTab } from '../views/FilesTab'
import { PERIODS, costText, periodFrom, sumUsage, useSessions, type Period } from '../views/ProjectTabs'
import { MODES_TIP, ModeList, ModeView, createMode } from './Modes'
import { Section } from './Sidebar'
import { Icon, IconButton, InfoTip, OneLineDesc, Tooltip } from './ui'
import { JournalView } from './JournalView'
import { msg, tr } from '@shared/i18n'

/**
 * The Hive Assistant's view (activity bar): a summary of what it has used, then its modes, its MCP servers (HI-2059:
 * added and removed here, as a project's in its MCP tab), its conversations (the same tree as a project's Sessions tab),
 * its journal (#1033) and the files attached to them (a project's Attachments tab, for its home). Its settings are in
 * Settings → Assistant and its panel.
 */

const M = {
  summaryTip: msg({ id: 'assistant.view.summaryTip', defaultMessage: "What this workspace's Assistant has used across its conversations, in the period chosen (by calendar day: Today is since midnight). It isn't counted in any project's Overview. The cost is what the work would have cost at API prices: on a subscription you are not charged this.", description: "The Assistant view: tooltip on Used so far. Today and Overview as Combwork names them." }),
  title: msg({ id: 'assistant.view.title', defaultMessage: 'Assistant', description: "The Assistant view's heading in the sidebar. Combwork's name stays as it is." }),
  titleTip: msg({ id: 'assistant.view.titleTip', defaultMessage: "Your workspace's overseer: what it has used, its modes, its conversations and the files attached to them. Its panel is on the right (Ctrl+Alt+I); its defaults are in Settings → Assistant.", description: "The Assistant view: tooltip on its heading. Keep the shortcut as it is." }),
  showPanel: msg({ id: 'assistant.view.showPanel', defaultMessage: "Show the Assistant's panel", description: "The Assistant view: a button that opens the Assistant's panel on the right." }),
  noWorkspace: msg({ id: 'assistant.view.noWorkspace', defaultMessage: 'Open a workspace to see its Assistant.', description: 'The Assistant view with no workspace open.' }),
  modes: msg({ id: 'assistant.view.modes', defaultMessage: 'Modes', description: "The Assistant view: the section of the Assistant's modes (how it works: Advisor, Builder…)." }),
  newMode: msg({ id: 'assistant.view.newMode', defaultMessage: 'New Mode…', description: 'The Assistant view, Modes: a button that creates a mode.' }),
  refresh: msg({ id: 'assistant.view.refresh', defaultMessage: 'Refresh', description: 'The Assistant view, Modes: a button that reads the modes again.' }),
  openFolder: msg({ id: 'assistant.view.openFolder', defaultMessage: 'Open Modes Folder', description: "The Assistant view, Modes: a button that opens the modes' folder in Explorer." }),
  conversations: msg({ id: 'assistant.view.conversations', defaultMessage: 'Conversations', description: "The Assistant view: the section of the Assistant's conversations." }),
  allConversations: msg({ id: 'assistant.view.allConversations', defaultMessage: 'All Conversations', description: "The Assistant view: the row that shows the Assistant's conversations." }),
  attachments: msg({ id: 'assistant.view.attachments', defaultMessage: 'Attachments', description: 'The Assistant view: the section of the files attached to its conversations.' }),
  journal: msg({ id: 'assistant.view.journal', defaultMessage: 'Journal', description: "The Assistant view: the section of the Assistant's journal (its memory across sessions)." }),
  journalTip: msg({ id: 'assistant.view.journalTip', defaultMessage: "What the Assistant keeps in its journal (decisions, plans, what happened and why) and Combwork's own facts. Search it, correct it, or forget what you'd rather it didn't keep.", description: "The Assistant view: the info tip of its Journal section." }),
  timeline: msg({ id: 'assistant.view.timeline', defaultMessage: 'Timeline', description: "The Assistant view, Journal: the row that shows every journal entry, newest first." }),
  digests: msg({ id: 'assistant.view.digests', defaultMessage: 'Weekly Digests', description: "The Assistant view, Journal: the row that shows only the Assistant's weekly digests." }),
  allAttachments: msg({ id: 'assistant.view.allAttachments', defaultMessage: 'All Attachments', description: 'The Assistant view: the row that shows the files attached to its conversations.' }),
  usedSoFar: msg({ id: 'assistant.view.usedSoFar', defaultMessage: 'Used so far', description: "The Assistant view: the heading of what the Assistant has used (tokens, cost)." }),
  period: msg({ id: 'assistant.view.period', defaultMessage: 'Period', description: 'The Assistant view: the accessible name of the period buttons (Today, 7 days…).' }),
  conversationsStat: msg({ id: 'assistant.view.statConversations', defaultMessage: 'Conversations', description: 'The Assistant view, Used so far: how many conversations.' }),
  prompts: msg({ id: 'assistant.view.statPrompts', defaultMessage: 'Prompts', description: 'The Assistant view, Used so far: how many prompts were sent.' }),
  tokens: msg({ id: 'assistant.view.statTokens', defaultMessage: 'Tokens', description: 'The Assistant view, Used so far: tokens used.' }),
  cost: msg({ id: 'assistant.view.statCost', defaultMessage: 'Cost', description: 'The Assistant view, Used so far: what it cost at API prices.' }),
  unpriced: msg({ id: 'assistant.view.unpriced', defaultMessage: '{count, plural, one {# conversation without a price} other {# conversations without a price}}', description: "The Assistant view: tooltip on Cost when some conversations' models have no known price." }),
  mcp: msg({ id: 'assistant.view.mcp', defaultMessage: 'MCP Servers', description: "The Assistant view (HI-2059): the section of the workspace's MCP servers added for the Assistant. MCP is a protocol's name: keep it." }),
  mcpTip: msg({ id: 'assistant.view.mcpTip', defaultMessage: "The workspace's MCP servers the Assistant gets, as a project's MCP tab has them: add one with +, Remove takes it off the Assistant only. Applies from its next session.", description: "The Assistant view: the info tip of its MCP Servers section (HI-2059). \"MCP tab\" as Combwork names it; + is the add button." }),
  addMcp: msg({ id: 'assistant.view.addMcp', defaultMessage: 'Add Server…', description: "The Assistant view's MCP Servers section (HI-2059): the + button that opens the picker of the workspace's servers to add." }),
  noMcp: msg({ id: 'assistant.view.noMcp', defaultMessage: 'No servers added.', description: "The Assistant view's MCP Servers section (HI-2059) when none is added for the Assistant." }),
  removeMcp: msg({ id: 'assistant.view.removeMcp', defaultMessage: 'Remove {name} from the Assistant', description: "The Assistant view's MCP Servers section (HI-2059): the button on a server that removes it from the Assistant. {name} is the server." }),
  noWorkspaceMain: msg({ id: 'assistant.view.noWorkspaceMain', defaultMessage: "Open a workspace to see its Assistant's conversations.", description: "The Assistant view's main area with no workspace open." })
}

export function AssistantSidePanel() {
  // Its path only (HI-1806): the workspace's every change would render the panel again.
  const wsPath = useStore((s) => s.workspace?.path)
  const a = useStore((s) => s.workspace?.assistant ?? null)
  const section = useStore((s) => s.assistantSection)
  return (
    <>
      <div className="pane-header">
        {tr(M.title)}
        <InfoTip text={tr(M.titleTip)} />
        <div className="actions">
          <IconButton icon="layout-sidebar-right" title={tr(M.showPanel)} disabled={!a} onClick={() => setAssistantOpen(true)} />
        </div>
      </div>
      <div className="pane-body">
        {!wsPath || !a ? (
          <div className="pane-empty">{tr(M.noWorkspace)}</div>
        ) : (
          <>
            <AssistantSummary assistant={a} />
            <Section
              title={tr(M.modes)}
              tip={tr(MODES_TIP)}
              buttons={
                <>
                  <IconButton icon="add" title={tr(M.newMode)} onClick={() => void createMode()} />
                  <IconButton icon="refresh" title={tr(M.refresh)} onClick={() => set((s) => ({ modesVersion: s.modesVersion + 1 }))} />
                  <IconButton icon="folder-opened" title={tr(M.openFolder)} onClick={() => void call('app:openPath', `${wsPath}\\.combwork\\modes`)} />
                </>
              }
            >
              <ModeList />
            </Section>
            <Section title={tr(M.mcp)} tip={tr(M.mcpTip)} buttons={<IconButton icon="add" title={tr(M.addMcp)} onClick={() => void actions.addMcpServer('assistant')} />}>
              <AssistantMcpList />
            </Section>
            <Section title={tr(M.conversations)}>
              <NavRow section="conversations" shown={section} icon="comment-discussion" label={tr(M.allConversations)} />
            </Section>
            <Section title={tr(M.journal)} tip={tr(M.journalTip)}>
              <NavRow section="journal" shown={section} icon="notebook" label={tr(M.timeline)} />
              <NavRow section="digests" shown={section} icon="calendar" label={tr(M.digests)} />
            </Section>
            <Section title={tr(M.attachments)}>
              <NavRow section="images" shown={section} icon="attach" label={tr(M.allAttachments)} />
            </Section>
          </>
        )}
      </div>
    </>
  )
}

 /** The workspace's MCP servers added for the Assistant (HI-2059), each with Remove. */
function AssistantMcpList() {
  const ws = useStore((s) => s.workspace?.path ?? null)
  const version = useStore((s) => s.skillsVersion)
  const [servers, setServers] = useState<McpServerInfo[] | null>(null)
  useEffect(() => {
    let current = true
    if (ws) void call('mcp:list').then((l) => current && setServers(l), () => current && setServers([]))
    return () => void (current = false)
  }, [ws, version])
  if (!servers) return null
  const added = servers.filter((m) => m.assistant)
  if (!added.length) return <div className="pane-empty" data-assistant-mcp-none="">{tr(M.noMcp)}</div>
  return (
    <>
      {added.map((m) => (
        <div key={m.name} className="row tall" data-mcp={m.name}>
          <Icon name={m.error ? 'error' : m.def?.url ? 'globe' : 'plug'} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="label">{m.name}</div>
            <OneLineDesc text={actions.mcpErrorText(m) ?? m.def?.description ?? m.def?.command ?? m.def?.url} />
          </div>
          <div className="row-actions">
            <IconButton icon="close" title={tr(M.removeMcp, { name: m.name })} onClick={() => void actions.removeMcpServer('assistant', m)} />
          </div>
        </div>
      ))}
    </>
  )
}

type ViewSection = 'conversations' | 'modes' | 'images' | 'journal' | 'digests'

/** A row that shows a section in the main area: a tab stop, Enter or Space shows it, the one shown is the current page (#1033 round 2). */
function NavRow({ section, shown, icon, label }: { section: ViewSection; shown: ViewSection; icon: string; label: string }) {
  const show = (): void => set({ assistantSection: section })
  return (
    <div
      className={cx('row', shown === section && 'selected')}
      data-section={section}
      role="button"
      tabIndex={0}
      aria-current={shown === section ? 'page' : undefined}
      onClick={show}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        show()
      }}
    >
      <Icon name={icon} />
      <span className="label">{label}</span>
    </div>
  )
}

/** Tokens, cost and conversations of the Assistant, for a period (by calendar day) or all time. */
function AssistantSummary({ assistant }: { assistant: ProjectInfo }) {
  const { items, kept } = useSessions(assistant)
  const [period, setPeriod] = useState<Period>('all')
  const now = useNow(60000)
  const hive = [...(items ?? []).filter((i) => i.source === 'hive'), ...kept]
  const t = sumUsage(hive, periodFrom(period, now))
  const tokens = t.input + t.cached + t.cacheWrite + t.output
  return (
    <div className="assistant-summary">
      <div className="assistant-summary-title">
        {tr(M.usedSoFar)}
        <InfoTip text={tr(M.summaryTip)} />
      </div>
      <div className="segmented assistant-periods" role="group" aria-label={tr(M.period)}>
        {PERIODS.map((p) => (
          <button key={p.value} className={cx(period === p.value && 'active')} onClick={() => setPeriod(p.value)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="assistant-summary-grid">
        <Stat label={tr(M.conversationsStat)} value={items ? String(t.sessions) : '…'} />
        <Stat label={tr(M.prompts)} value={items ? formatNumber(t.prompts) : '…'} />
        <Stat label={tr(M.tokens)} value={items ? formatTokens(tokens) : '…'} />
        <Stat label={tr(M.cost)} value={items ? costText(t) : '…'} tip={t.unpriced ? tr(M.unpriced, { count: t.unpriced }) : undefined} />
      </div>
    </div>
  )
}

function Stat({ label, value, tip }: { label: string; value: string; tip?: string }) {
  const body = (
    <div className="assistant-stat">
      <span className="faint">{label}</span>
      <strong>{value}</strong>
    </div>
  )
  return tip ? <Tooltip content={tip}>{body}</Tooltip> : body
}

/** The main area: the conversation browser, the attachments, the journal (#1033), or the selected mode. */
export function AssistantMain() {
  const a = useStore((s) => s.workspace?.assistant ?? null)
  const section = useStore((s) => s.assistantSection)
  if (section === 'modes') return <ModeView />
  if (section === 'journal' || section === 'digests') return <JournalView key={section} digests={section === 'digests'} />
  if (section === 'images' && a) return <AttachmentsTab project={a} assistant />
  if (!a) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="comment-discussion" />
        {tr(M.noWorkspaceMain)}
      </div>
    )
  }
  return <SessionsTab project={a} assistant />
}
