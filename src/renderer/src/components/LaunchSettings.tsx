import { useState } from 'react'
import { advancedDef, CW_GUIDANCE, overrideId, shownText } from '@shared/advanced'
import { launchPolicy, MCP_ISOLATION, overrideKeys, plainness, terminalPreset, type LaunchImpact, type LaunchSwitch } from '@shared/launchPolicy'
import { providerDescriptor } from '@shared/providers'
import type { ConnectionRow } from '@shared/accounts'
import type { ConnectionLaunch, ProviderId } from '@shared/types'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { confirm, useLanguage } from '../store'
import { Modal } from './ui'

/**
 * A connection's launch settings (HI-2670, SPEC §5.6): what of Combwork's its sessions get, behind its ⋯ menu in
 * Settings → Accounts & Connections. "Launch as from a terminal" turns everything below it off; each switch on its own
 * makes it partly plain. Turning its tools off makes its agents Independent: asked first where that takes one off a
 * lane or from a card (confirmIndependent).
 */
const M = {
  title: msg({ id: 'settings.connections.launch.title', defaultMessage: '{name}: launch settings', description: "Title of a connection's Launch Settings dialog (HI-2670), opened from its ⋯ menu in Settings → Accounts & Connections. {name} is the connection's name." }),
  menu: msg({ id: 'settings.connections.launch.menu', defaultMessage: 'Launch Settings…', description: "An entry of a connection's ⋯ menu (Settings → Accounts & Connections, HI-2670): opens what of Combwork's the sessions it launches get." }),
  intro: msg({ id: 'settings.connections.launch.intro', defaultMessage: 'What Combwork adds to the sessions this connection launches. Whatever you turn off, Combwork still shows their pane, status, transcript, sessions and usage.', description: "The first line of a connection's Launch Settings dialog (HI-2670)." }),
  preset: msg({ id: 'settings.connections.launch.preset', defaultMessage: 'Launch as from a terminal', description: "The preset at the top of a connection's Launch Settings (HI-2670): turns off everything Combwork adds, so its sessions start as the coding agent CLI would in a terminal in that folder." }),
  presetText: msg({ id: 'settings.connections.launch.presetText', defaultMessage: "Its sessions get what {cli} started in a terminal in that folder would: none of Combwork's guidance, tools, MCP servers, overrides or typing. Its agents are Independent.", description: 'Under "Launch as from a terminal" in a connection\'s Launch Settings (HI-2670). {cli} is the coding agent CLI\'s name ("Claude Code"). Glossary: independent.' }),
  guidanceText: msg({ id: 'settings.connections.launch.guidanceText', defaultMessage: "How to work with Combwork, the project's latest handover and the Workspace notes note, at each launch.", description: 'Under "Combwork\'s guidance for agents" in a connection\'s Launch Settings (HI-2670). Workspace notes is the name of a note: use its translated name.' }),
  tools: msg({ id: 'settings.connections.launch.tools', defaultMessage: "Combwork's tools", description: "A switch in a connection's Launch Settings (HI-2670): its sessions get Combwork's MCP server (its tools), skills, the Agent API and cw-progress." }),
  toolsText: msg({ id: 'settings.connections.launch.toolsText', defaultMessage: "The combwork MCP server, Combwork's skills, the Agent API and cw-progress. Turned off, the agents on this connection are Independent: no lanes, reviews or cards, until their tools are back.", description: 'Under "Combwork\'s tools" in a connection\'s Launch Settings (HI-2670). combwork is an MCP server\'s name and cw-progress a command\'s: keep them. Glossary: independent.' }),
  typing: msg({ id: 'settings.connections.launch.typing', defaultMessage: 'Combwork types into the agent', description: "A switch in a connection's Launch Settings (HI-2670): Combwork may type wakes, inbox notices, messages and card prompts into its sessions." }),
  typingText: msg({ id: 'settings.connections.launch.typingText', defaultMessage: 'Wakes, inbox notices, messages and card prompts, and the replies of its hooks that add to its context. Its status hooks stay either way.', description: 'Under "Combwork types into the agent" in a connection\'s Launch Settings (HI-2670).' }),
  overrides: msg({ id: 'settings.connections.launch.overrides', defaultMessage: 'Overrides of {cli}', description: "A heading in a connection's Launch Settings (HI-2670), above Combwork's overrides of the coding agent CLI's own behaviour ({cli}: its name), each with a switch." }),
  assistant: msg({ id: 'settings.connections.launch.assistant', defaultMessage: "The Assistant uses this connection: it always launches with Combwork's guidance, tools and typing, whatever these say. They apply to the connection's other agents.", description: "A note in a connection's Launch Settings (HI-2670) when the Combwork Assistant uses it: its role needs them." }),
  restart: msg({ id: 'settings.connections.launch.restart', defaultMessage: 'Running sessions keep what they launched with until they restart. An agent made Independent gets nothing more of Combwork at once.', description: "A note at the foot of a connection's Launch Settings (HI-2670)." }),
  cancel: msg({ id: 'settings.connections.launch.cancel', defaultMessage: 'Cancel', description: "A button of a connection's Launch Settings dialog (HI-2670): closes it without saving." }),
  save: msg({ id: 'settings.connections.launch.save', defaultMessage: 'Save', description: "A button of a connection's Launch Settings dialog (HI-2670): saves them." }),
  plain: msg({ id: 'settings.connections.launch.plainBadge', defaultMessage: 'As from a terminal', description: "A badge on a connection's row in Settings → Accounts & Connections (HI-2670): it launches with none of Combwork's additions. Short." }),
  partly: msg({ id: 'settings.connections.launch.partlyBadge', defaultMessage: 'Partly plain', description: "A badge on a connection's row in Settings → Accounts & Connections (HI-2670): some of what Combwork adds to its sessions is turned off. Short." }),
  confirmTitle: msg({ id: 'agents.independent.confirmTitle', defaultMessage: '{n, plural, one {Make # agent Independent?} other {Make # agents Independent?}}', description: 'Title of the confirmation (HI-2670) before a change makes agents that are on lanes or hold cards Independent (no part in the workflow). Glossary: independent.' }),
  confirmText: msg({ id: 'agents.independent.confirmText', defaultMessage: 'Combwork gives them nothing more: their lanes pause until you give them another agent or end them, and their cards stay where they are for you to give to someone else.', description: 'The confirmation (HI-2670) before agents on lanes or holding cards are made Independent.' }),
  confirmLine: msg({ id: 'agents.independent.confirmLine', defaultMessage: '{agent} ({project}): {parts}', description: 'One line of the confirmation (HI-2670) before agents are made Independent: the agent, its project, and what it is part of ({parts}: its lanes and cards, listed).' }),
  laneLine: msg({ id: 'agents.independent.lane', defaultMessage: 'lane {lane}', description: 'One of what an agent is part of, in the confirmation before it is made Independent (HI-2670): a running lane, by its id.' }),
  cardLine: msg({ id: 'agents.independent.card', defaultMessage: '{card} in {column}', description: 'One of what an agent is part of, in the confirmation before it is made Independent (HI-2670): a card ({card}: its key, HI-12) and its board column ({column}: Doing or Review).' }),
  confirm: msg({ id: 'agents.independent.confirm', defaultMessage: 'Make Independent', description: 'The button of the confirmation (HI-2670) before agents on lanes or holding cards are made Independent. Short. Glossary: independent.' }),
  doing: msg({ id: 'agents.independent.doing', defaultMessage: 'Doing', description: 'A board column, in the confirmation before agents are made Independent (HI-2670).' }),
  review: msg({ id: 'agents.independent.review', defaultMessage: 'Review', description: 'A board column, in the confirmation before agents are made Independent (HI-2670).' })
}

export const LAUNCH_SETTINGS_MENU = M.menu

/** A connection row's badge (HI-2670): its sessions launch with less of Combwork's than everything. */
export function launchBadge(c: ConnectionRow, cli: ProviderId): string | null {
  const how = plainness(c, cli)
  return how === 'full' ? tr(M.plain) : how === 'partial' ? tr(M.partly) : null
}

/** Asks before agents on lanes or holding cards are made Independent (HI-2670), naming each and what it is part of. */
export function confirmIndependent(impact: LaunchImpact): Promise<boolean> {
  const column = (c: string): string => (c === 'doing' ? tr(M.doing) : c === 'review' ? tr(M.review) : c)
  return confirm({
    title: tr(M.confirmTitle, { n: impact.agents.length }),
    message: tr(M.confirmText),
    list: impact.agents.map((a) => tr(M.confirmLine, { agent: a.agent, project: a.project, parts: fmt.list([...a.lanes.map((l) => tr(M.laneLine, { lane: l })), ...a.cards.map((c) => tr(M.cardLine, { card: c.key ?? String(c.number), column: column(c.column) }))]) })),
    listOnly: true,
    confirmLabel: tr(M.confirm)
  })
}

/** One switch's row: its title, what it does, and its checkbox. */
function Switch({ id, title, text, on, onChange }: { id: string; title: string; text: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="launch-switch" data-launch-switch={id}>
      <input type="checkbox" className="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <div>
        <strong>{title}</strong>
        <div className="faint">{text}</div>
      </div>
    </label>
  )
}

/** The Launch Settings dialog for a connection (HI-2670). */
export function LaunchSettingsDialog({ row, cli, onClose }: { row: ConnectionRow; cli: ProviderId; onClose: () => void }) {
  useLanguage()
  const [launch, setLaunch] = useState<ConnectionLaunch>(() => structuredClone(row.launch ?? {}))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const p = launchPolicy({ launch }, cli)
  const keys = overrideKeys(cli)
  const full = plainness({ launch }, cli) === 'full'
  const name = providerDescriptor(cli).name
  const assistant = row.users.some((u) => u.assistant)
  const setSwitch = (s: LaunchSwitch, on: boolean): void => setLaunch((l) => ({ ...l, [s]: on ? undefined : false }))
  const setOverride = (k: string, on: boolean): void => setLaunch((l) => ({ ...l, overrides: { ...l.overrides, [k]: on } }))
  const text = (id: string): { title: string; desc: string } => {
    const d = advancedDef(id)
    return { title: d ? shownText(d.text.title) : id, desc: d ? shownText(d.text.desc) : '' }
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const impact = await call('connection:launchImpact', row.id, launch)
      if (impact && !(await confirmIndependent(impact))) return setBusy(false)
      await call('connection:setLaunch', row.id, launch, impact?.fingerprint ?? null)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  const guidance = text(CW_GUIDANCE)
  const isolation = text(overrideId(cli, MCP_ISOLATION))
  return (
    <Modal
      title={tr(M.title, { name: row.name })}
      icon="terminal"
      onClose={onClose}
      busy={busy}
      error={error}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={onClose}>
            {tr(M.cancel)}
          </button>
          <button className="btn primary" disabled={busy} data-save-launch onClick={() => void save()}>
            {tr(M.save)}
          </button>
        </>
      }
    >
      <div className="launch-settings" data-launch-settings={row.id}>
        <p className="hint">{tr(M.intro)}</p>
        <Switch id="preset" title={tr(M.preset)} text={tr(M.presetText, { cli: name })} on={full} onChange={(on) => setLaunch(on ? terminalPreset(cli) : {})} />
        <div className="launch-switches">
          <Switch id="guidance" title={guidance.title} text={tr(M.guidanceText)} on={p.guidance} onChange={(on) => setSwitch('guidance', on)} />
          <Switch id="tools" title={tr(M.tools)} text={tr(M.toolsText)} on={p.tools} onChange={(on) => setSwitch('tools', on)} />
          <Switch id="typing" title={tr(M.typing)} text={tr(M.typingText)} on={p.typing} onChange={(on) => setSwitch('typing', on)} />
          {keys.includes(MCP_ISOLATION) && <Switch id={MCP_ISOLATION} title={isolation.title} text={isolation.desc} on={p.overrides[overrideId(cli, MCP_ISOLATION)]} onChange={(on) => setOverride(MCP_ISOLATION, on)} />}
          {assistant && <div className="hint" data-launch-assistant>{tr(M.assistant)}</div>}
          {keys.some((k) => k !== MCP_ISOLATION) && <h4 className="launch-overrides-h">{tr(M.overrides, { cli: name })}</h4>}
          {keys
            .filter((k) => k !== MCP_ISOLATION)
            .map((k) => {
              const t = text(overrideId(cli, k))
              return <Switch key={k} id={k} title={t.title} text={t.desc} on={p.overrides[overrideId(cli, k)]} onChange={(on) => setOverride(k, on)} />
            })}
        </div>
        <p className="hint">{tr(M.restart)}</p>
      </div>
    </Modal>
  )
}
