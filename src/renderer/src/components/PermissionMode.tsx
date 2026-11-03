import { agentLaunchSettings, canSwitchModeLive, modeBadgeLabel, modeOption, offeredModes, permissionLabel, providerDescriptor, shownText } from '@shared/providers'
import { modeInEffect } from '@shared/cliOwnMode'
import { msg, tr } from '@shared/i18n'
import { useState } from 'react'
import type { AgentInfo, AppSettings, Connection, PermissionMode, ProjectInfo, ProviderId } from '@shared/types'
import type { ConnectionsView } from '@shared/accounts'
import { useConnections } from './ConnectionChoice'
import { ConnectionDialog } from './ConnectionDefaults'
import * as actions from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { agentProviderOf, confirm, findProject, isAssistantPath, notify, set, useLanguage, useStore } from '../store'
import { cx, formatKeybinding } from '../util'
import { ContextMenu, Icon, Tooltip, type MenuEntry } from './ui'

/** The mode an agent's next session starts in: its connection's (HI-2106), else its CLI's default. */
export function configuredMode(project: ProjectInfo, a: AgentInfo | null | undefined, settings: AppSettings | null): PermissionMode {
  if (!settings) return providerDescriptor(agentProviderOf(a)).defaultPermissionMode
  const agent = a ?? project.agents[0]
  return agentLaunchSettings(agentProviderOf(agent), agent, settings).permissionMode
}

/** What the agent is in now if it runs (as its CLI reports it), else what it will start in. */
export function currentMode(project: ProjectInfo, a: AgentInfo | null | undefined, settings: AppSettings | null): PermissionMode {
  return a?.live?.permissionMode ?? configuredMode(project, a, settings)
}

/** Opens the permission mode menu for an agent, under an element (or at the window's centre). */
export function openModeMenu(projectPath: string, agentId: string, anchor?: Element | null): void {
  const r = anchor?.getBoundingClientRect()
  set({ modeMenu: { project: projectPath, agentId, x: r ? r.left : window.innerWidth / 2 - 150, y: r ? r.bottom + 4 : 120, above: r?.top } })
}

/**
 * Confirms choosing a provider's no-guardrails mode (Claude Code's Bypass, Codex's Full Access). `where`: what will run
 * in it, as the sentence's subject (an agent's name), or the whole question (`message`, "New sessions of hive will run
 * every command…"), in the window's language.
 */
export async function confirmDangerousMode(provider: ProviderId, mode: PermissionMode, where: string | { message: string }): Promise<boolean> {
  const m = modeOption(provider, mode)
  if (!m?.danger) return true
  const name = providerDescriptor(provider).name
  const label = shownText(m.label, m.text?.label, tr)
  return confirm({
    title: tr(msg({ id: 'agents.permission.dangerTitle', defaultMessage: 'Use {mode}?', description: "Title of the confirmation before choosing a provider's no-guardrails permission mode ({mode}: its name, Bypass permissions, Full access…)." }), { mode: label }),
    message: typeof where !== 'string' ? where.message : tr(msg({ id: 'agents.permission.dangerMessage', defaultMessage: '{where} will run every command, edit and network call without asking.', description: "The confirmation before choosing a no-guardrails permission mode. {where} is who will run in it: an agent's name, or \"The Assistant\"." }), { where }),
    detail: tr(msg({ id: 'agents.permission.dangerDetail', defaultMessage: 'Only use this for disposable work where mistakes cannot do harm. {provider} may show its own warning the first time; answer it in the terminal.', description: "Under the confirmation before choosing a no-guardrails permission mode: the CLI ({provider}: its name) may ask itself too." }), { provider: name }),
    confirmLabel: tr(msg({ id: 'agents.permission.dangerConfirm', defaultMessage: 'Use {mode}', description: "Button: chooses the no-guardrails permission mode ({mode}: its name)." }), { mode: label }),
    danger: true
  })
}

async function switchLive(project: ProjectInfo, a: AgentInfo, mode: PermissionMode): Promise<void> {
  const live = a.live!
  const p = live.provider
  const desc = providerDescriptor(p)
  if (!(await confirmDangerousMode(p, mode, a.name))) return
  // Live whenever the provider can (#1014: Codex's Full Access too, after the confirmation); a restart only when it can't.
  if (canSwitchModeLive(desc, mode, live.permissionMode, null)) {
    const r = await actions.attempt(tr(msg({ id: 'agents.permission.switchFailed', defaultMessage: 'Could not switch the permission mode', description: "An error's title: switching a running agent's permission mode failed." })), () => call('session:setMode', project.path, a.id, mode))
    if (!r || r.ok) return
    if (!r.restart) return notify('warning', tr(msg({ id: 'agents.permission.notSwitched', defaultMessage: 'Permission mode not switched', description: "A notification's title: Hive couldn't switch a running agent's permission mode (the message says why)." })), r.message)
  }
  const working = live.status === 'working'
  const label = permissionLabel(p, mode, tr)
  const ok = await confirm({
    title: tr(msg({ id: 'agents.permission.restartTitle', defaultMessage: 'Restart in {mode}?', description: "Title of the confirmation before restarting an agent's session in another permission mode ({mode}: its name)." }), { mode: label }),
    message:
      project.agents.length > 1
        ? tr(msg({ id: 'agents.permission.restartAgent', defaultMessage: "{mode} can't be switched to inside a running session, so {agent} restarts in it. The conversation continues where it left off.", description: "The confirmation before restarting an agent ({agent}: its name) in another permission mode ({mode}: its name)." }), { mode: label, agent: a.name })
        : tr(msg({ id: 'agents.permission.restartSession', defaultMessage: "{mode} can't be switched to inside a running session, so the session restarts in it. The conversation continues where it left off.", description: "The confirmation before restarting the project's one agent in another permission mode ({mode}: its name)." }), { mode: label }),
    detail: working ? tr(msg({ id: 'agents.permission.restartWorking', defaultMessage: 'The agent is working and will be interrupted.', description: 'Under the confirmation before restarting an agent in another permission mode: it is mid-turn.' })) : undefined,
    confirmLabel: tr(msg({ id: 'agents.permission.restart', defaultMessage: 'Restart', description: "Button: restarts the agent's session in the chosen permission mode. Keep it short." }))
  })
  if (!ok) return
  await actions.attempt(tr(msg({ id: 'agents.permission.restartFailed', defaultMessage: 'Could not restart the session', description: "An error's title: restarting an agent's session in another permission mode failed." })), () => call('session:restartInMode', project.path, a.id, mode))
}

/**
 * Moves a stopped agent to another of its account's connections (HI-2122, the user's option 1): as Agent Settings does,
 * after confirming a no-guardrails mode the connection has.
 */
async function chooseConnection(project: ProjectInfo, a: AgentInfo, provider: ProviderId, c: Connection): Promise<void> {
  if (c.permissionMode && !(await confirmDangerousMode(provider, c.permissionMode, a.name))) return
  await actions.attempt(tr(msg({ id: 'agents.permission.saveFailed', defaultMessage: 'Could not save', description: "An error's title: saving an agent's permission mode for new sessions failed." })), () => call('agents:update', project.path, a.id, { connection: c.id }))
  await actions.refreshWorkspace()
}

function menuItems(project: ProjectInfo, a: AgentInfo, settings: AppSettings, view: ConnectionsView | null, onEdit: (account: string, connection: string) => void): MenuEntry[] {
  const provider = agentProviderOf(a)
  const desc = providerDescriptor(provider)
  const modes = offeredModes(provider, settings, isAssistantPath(project.path))
  const many = project.agents.length > 1
  const live = a.live
  if (live && !live.settingUp) {
    const cur = live.permissionMode
    const asking = live.status === 'waiting'
    // Started in the CLI's own setting (#1284): Hive doesn't know its mode, so every choice restarts the session.
    const cliOwn = !!modeOption(provider, cur)?.cliOwn
    return [
      { header: true, label: many ? tr(msg({ id: 'agents.permission.menuAgent', defaultMessage: 'Permission mode — {agent}', description: "The permission mode menu's heading, for one of several agents ({agent}: its name)." }), { agent: a.name }) : tr(msg({ id: 'agents.permission.menu', defaultMessage: 'Permission mode', description: "The permission mode menu's heading." })) },
      // A short line and its why under it, which wraps (the menu's details), so the menu keeps its width.
      ...(cliOwn
        ? [
            {
              label: tr(msg({ id: 'agents.permission.cliOwnNoSwitchTitle', defaultMessage: "Combwork can't switch this session's mode", description: "In a running agent's permission mode menu, for a session started in \"The CLI's own setting\" (Hive passed no mode): a short line saying no mode switches live. Keep it short." })),
              detail: tr(msg({ id: 'agents.permission.cliOwnNoSwitch', defaultMessage: "It started in the CLI's own setting, so Combwork doesn't know which mode it is in. A choice here restarts it.", description: "In a running agent's permission mode menu, under \"Hive can't switch this session's mode\" (a session started in \"The CLI's own setting\", Hive passed no mode): why, and what a choice does." })),
              icon: 'info',
              disabled: true
            }
          ]
        : []),
      ...(asking ? [{ label: tr(msg({ id: 'agents.permission.answerFirst', defaultMessage: 'The agent is asking you something: answer it first', description: 'In the permission mode menu, while the agent waits for an answer: its mode can be switched once it is answered.' })), icon: 'warning', disabled: true }] : []),
      ...modes.map((m): MenuEntry => {
        const liveOk = canSwitchModeLive(desc, m.value, cur, null)
        return {
          label: shownText(m.label, m.text?.label, tr),
          icon: m.value === cur ? 'check' : 'blank',
          detail: m.value === cur ? tr(msg({ id: 'agents.permission.current', defaultMessage: 'Current mode', description: "Under the permission mode the agent runs in now, in the mode menu." })) : liveOk ? shownText(m.description, m.text?.description, tr) : tr(msg({ id: 'agents.permission.restarts', defaultMessage: 'Restarts the session; the conversation continues', description: "Under a permission mode in the mode menu that a running session can't switch to without a restart." })),
          disabled: m.value === cur || (asking && liveOk),
          onClick: () => void switchLive(project, a, m.value)
        }
      }),
      ...(desc.capabilities.planModeToggle
        ? [
            { separator: true } as MenuEntry,
            {
              label: tr(msg({ id: 'agents.permission.planMode', defaultMessage: 'Plan mode', description: "In the permission mode menu (Codex): Plan mode, a toggle separate from the permission mode." })),
              icon: live.planMode ? 'check' : 'blank',
              detail: live.planMode
                ? tr(msg({ id: 'agents.permission.planOn', defaultMessage: 'On: the agent plans and asks before changing anything. Click to turn off.', description: 'Under Plan mode in the permission mode menu, while it is on.' }))
                : tr(msg({ id: 'agents.permission.planOff', defaultMessage: 'Plan first: the agent explores and proposes a plan without changing anything.', description: 'Under Plan mode in the permission mode menu, while it is off.' })),
              disabled: asking,
              onClick: () => void actions.attempt(tr(msg({ id: 'agents.permission.planFailed', defaultMessage: 'Could not switch Plan mode', description: "An error's title: turning a running agent's Plan mode on or off failed." })), () => call('session:setPlanMode', project.path, a.id, !live.planMode))
            } as MenuEntry
          ]
        : []),
      { separator: true },
      { label: tr(msg({ id: 'agents.permission.sessionOnly', defaultMessage: 'Switches this session only. Settings decide the mode new sessions start in.', description: "The last line of a running agent's permission mode menu." })), disabled: true }
    ]
  }
  // Stopped (HI-2122): its mode is its connection's (decision B), so the menu offers its account's connections, each with
  // its mode, the current one ticked; picking one moves it there (nothing is made for it), and the last item edits its own.
  const current = view?.connectionRows?.find((c) => c.id === a.connection)
  const rows = current ? (view?.connectionRows ?? []).filter((c) => c.account === current.account) : []
  const header: MenuEntry = { header: true, label: tr(msg({ id: 'agents.permission.connectionNewSessions', defaultMessage: '{agent}: connection for new sessions', description: "The heading of a stopped agent's permission mode menu (HI-2122): its mode is its connection's, so the menu lists its account's connections, each with its mode ({agent}: its name)." }), { agent: a.name }) }
  if (!current) return [header, { label: tr(msg({ id: 'agents.permission.noConnection', defaultMessage: 'No connection yet: choose one in Agent Settings', description: "In a stopped agent's permission mode menu (HI-2122) when it has no connection (its CLI has no account on here yet). Agent Settings names a dialog." })), icon: 'info', disabled: true }]
  return [
    header,
    ...rows.map((c): MenuEntry => ({
      label: c.name,
      icon: c.id === current.id ? 'check' : 'blank',
      detail: permissionLabel(provider, c.permissionMode ?? desc.defaultPermissionMode, tr),
      disabled: c.id === current.id,
      onClick: () => void chooseConnection(project, a, provider, c)
    })),
    { separator: true },
    {
      label: tr(msg({ id: 'agents.permission.editConnection', defaultMessage: 'Edit "{connection}"…', description: "The last item of a stopped agent's permission mode menu (HI-2122): opens the connection dialog for its connection ({connection}: its name), where its mode is changed for every agent on it. The … says a dialog opens: keep it." }), { connection: current.name }),
      icon: 'edit',
      onClick: () => onEdit(current.account, current.id)
    }
  ]
}

/** Renders the menu opened by openModeMenu. Mounted once in App. */
export function ModeMenuHost() {
  useLanguage()
  const menu = useStore((s) => s.modeMenu)
  const project = useStore((s) => findProject(s, s.modeMenu?.project))
  const settings = useStore((s) => s.settings)
  const view = useConnections()
  // The connection dialog its last item opens (HI-2122), kept open once the menu has closed.
  const [editing, setEditing] = useState<{ account: string; connection: string } | null>(null)
  const a = menu && project ? project.agents.find((x) => x.id === menu.agentId) : undefined
  return (
    <>
      {menu && project && settings && a && <ContextMenu x={menu.x} y={menu.y} above={menu.above} items={menuItems(project, a, settings, view, (account, connection) => setEditing({ account, connection }))} onClose={() => set({ modeMenu: null })} />}
      {editing && <ConnectionDialog account={editing.account} connection={editing.connection} onClose={() => setEditing(null)} />}
    </>
  )
}

/** The permission mode as a clickable badge (project header), chip (pane header) or status bar item. */
export function ModeBadge({ project, a, variant }: { project: ProjectInfo; a: AgentInfo | null | undefined; variant: 'header' | 'pane' | 'status' }) {
  const settings = useStore((s) => s.settings)
  useLanguage()
  if (!a) return null
  const provider = agentProviderOf(a)
  const mode = currentMode(project, a, settings)
  const option = modeOption(provider, mode)
  // Marked by the mode in effect: on the CLI's own setting, one without guardrails its CLI showed (#1284).
  const bypass = !!modeOption(provider, (a.live ? modeInEffect(a.live) : undefined) ?? mode)?.danger
  const label = a.live?.modeSwitching
    ? tr(msg({ id: 'agents.permission.switching', defaultMessage: 'Switching to {mode}…', description: "The permission mode badge while Hive switches the running session to another mode ({mode}: its name)." }), { mode: permissionLabel(provider, a.live.modeSwitching, tr) })
    : a.live?.planMode
      ? tr(msg({ id: 'agents.permission.withPlan', defaultMessage: '{mode} · Plan', description: "The permission mode badge of a running session with Plan mode on (Codex): its mode ({mode}: its name), then Plan. Keep it short." }), { mode: modeBadgeLabel(provider, mode, tr) })
      : modeBadgeLabel(provider, mode, tr)
  const kb = commandKeybinding('session.permissionMode')
  // Shift+Tab still cycles the CLI's modes in one on its own setting, but Hive can't say where it starts (#1284).
  const cycles = providerDescriptor(provider).capabilities.liveModeSwitch === 'cycle' && !option?.cliOwn
  const note = a.live && !a.live.modeSwitching && option?.cliNote ? shownText(option.cliNote, option.text?.cliNote, tr) : undefined
  const tip = tr(
    msg({ id: 'agents.permission.badgeTip', defaultMessage: '{live, select, yes {Permission mode of the running session} other {Permission mode new sessions start in}}: {mode}.{note, select, none {} other { {note}}} Click to change{key, select, none {} other { ({key})}}.{cycles, select, yes { You can also press Shift+Tab in the terminal.} other {}}{plan, select, yes { Shift+Tab in the terminal turns Plan mode on and off.} other {}}', description: "Tooltip of an agent's permission mode badge: whose mode it is (the running session's, or new sessions'), the mode ({mode}), why the CLI's own screen names it differently ({note}; none: leave that branch empty), the shortcut that opens the menu ({key}; none: empty), and whether Shift+Tab switches it in the terminal. Shift+Tab is a key: keep it." }),
    { live: a.live ? 'yes' : 'no', mode: label, note: note ?? 'none', key: kb ? formatKeybinding(kb) : 'none', cycles: a.live && cycles ? 'yes' : 'no', plan: a.live && providerDescriptor(provider).capabilities.planModeToggle ? 'yes' : 'no' }
  )
  const open = (e: React.MouseEvent): void => {
    e.stopPropagation()
    openModeMenu(project.path, a.id, e.currentTarget)
  }
  const icon = bypass ? 'warning' : mode === 'plan' ? 'debug-pause' : mode === 'auto' ? 'sparkle' : 'shield'
  if (variant === 'status') {
    return (
      <Tooltip content={tip}>
        <div className={cx('status-item', bypass && 'warn')} onClick={open}>
          <Icon name={icon} /> {label}
        </div>
      </Tooltip>
    )
  }
  return (
    <Tooltip content={tip}>
      <button type="button" className={cx('mode-badge', variant === 'header' ? 'badge' : 'mode-chip', bypass && 'error', a.live && 'live')} onClick={open}>
        <Icon name={icon} />
        <span className="mode-label fit-clip">{label}</span>
        <Icon name="chevron-down" className="mode-caret" />
      </button>
    </Tooltip>
  )
}

