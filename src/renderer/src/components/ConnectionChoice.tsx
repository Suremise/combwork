import { useEffect, useState, type ReactNode } from 'react'
import type { Connection, LiveSessionState, ProviderId } from '@shared/types'
import { resolveConnection, type ConnectionsView } from '@shared/accounts'
import { enabledProviders, providerDescriptor } from '@shared/providers'
import { fmt, msg, tr } from '@shared/i18n'
import { call } from '../api'
import { set, setActivity, useStore } from '../store'
import { connectionOf, type ConnectionShown } from '@shared/connectionLabel'
import { Icon, Tooltip } from './ui'

/**
 * Which connection an agent, a template's agent or the Assistant runs on (HI-1755): the workspace's default for its CLI,
 * or one of the CLI's connections on in this workspace. A saved choice that is off here or gone stays listed and says
 * so, so nothing changes silently. Shown only for a CLI that has connections.
 */

const M = {
  label: msg({ id: 'connections.choice.label', defaultMessage: 'Connection', description: "Label of the choice of connection an agent runs on (Agent Settings, Add Agent, Settings → Assistant): which login or service runs it." }),
  default: msg({ id: 'connections.choice.default', defaultMessage: "Workspace's default ({name})", description: 'The first choice of connection: the workspace\'s default connection for the CLI, named ({name}).' }),
  defaultNone: msg({ id: 'connections.choice.defaultNone', defaultMessage: "Workspace's default (none on)", description: 'The first choice of connection when the workspace has no connection on for the CLI: an agent on it is refused a start until one is.' }),
  off: msg({ id: 'connections.choice.off', defaultMessage: '{name} (off in this workspace: the default runs it)', description: "A choice of connection that is chosen but off in this workspace ({name}): the workspace's default runs the agent instead." }),
  gone: msg({ id: 'connections.choice.gone', defaultMessage: 'A removed connection (the agent is refused a start)', description: "A choice of connection that no longer exists: the agent can't start until another is chosen." }),
  otherCli: msg({ id: 'connections.choice.otherCli', defaultMessage: '{cli} connections', description: 'A group in the choice of connection: the connections of another coding agent CLI ({cli}: "Codex"). Picking one switches the agent to that CLI (it is asked first).' }),
  none: msg({ id: 'connections.choice.none', defaultMessage: 'No {cli} connection is on in this workspace. Add one in Settings → Connections.', description: 'Under the choice of connection when the workspace has none on for the CLI ({cli}: "Claude Code"). Settings → Connections names a section.' })
}

/**
 * The list as last read, by when it was asked (the workspace, its change count and the CLIs turned on: a change reads it
 * again, so the rows, choices and the load dialog follow at once): one read for every row asking.
 */
let listed: { key: string; view: Promise<ConnectionsView | null>; got?: ConnectionsView | null } | null = null
function listFor(key: string): NonNullable<typeof listed> {
  if (listed?.key !== key) {
    const entry: NonNullable<typeof listed> = { key, view: call('connections:list').catch(() => null) }
    void entry.view.then((v) => (entry.got = v))
    listed = entry
  }
  return listed
}

/** Hive's connections and this window's workspace's choice of them, read again as they change. */
export function useConnections(): ConnectionsView | null {
  const changed = useStore((s) => s.connectionsChanged)
  const wsPath = useStore((s) => s.workspace?.path ?? null)
  // The CLIs turned on (the view lists those with connections that are): a string, so the selector stays stable.
  const enabled = useStore((s) => enabledProviders(s.settings).map((p) => p.id).join())
  const key = `${wsPath ?? ''}\n${changed}\n${enabled}`
  const [view, setView] = useState<ConnectionsView | null>(() => listFor(key).got ?? null)
  useEffect(() => {
    let live = true
    const entry = listFor(key)
    if (entry.got !== undefined) setView(entry.got)
    else void entry.view.then((v) => live && setView(v))
    return () => {
      live = false
    }
  }, [key])
  return view
}

/**
 * The connection a choice would start on (HI-1770), for its defaults: undefined where connections don't apply (a CLI
 * without them, or turned off), null when none can be used.
 */
export function useLaunchConnection(own: string | undefined, provider: ProviderId): Connection | null | undefined {
  const view = useConnections()
  if (!view?.providers.includes(provider)) return undefined
  const r = resolveConnection({ connections: view.workspace }, provider, own || undefined, view.connections)
  return r.ok ? (view.connections.find((c) => c.id === r.id) ?? null) : null
}

/**
 * `value`: the connection's id, '' for the workspace's default. `onOtherCli` (Add Agent, Agent Settings: HI-1769) also
 * lists the connections on here of the other CLIs that have them, by CLI: picking one is a change of CLI, which the
 * caller makes (and asks about).
 */
export function ConnectionChoice({ provider, value, onChange, onOtherCli, id }: { provider: ProviderId; value: string; onChange: (v: string) => void; onOtherCli?: (provider: ProviderId, connection: string) => void; id?: string }) {
  const view = useConnections()
  if (!providerDescriptor(provider).capabilities.connections || !view) return null
  const onFor = (p: ProviderId) => view.connections.filter((c) => c.provider === p && view.workspace[p]?.on.includes(c.id))
  const ws = view.workspace[provider]
  const on = onFor(provider)
  const others = onOtherCli ? view.providers.filter((p) => p !== provider && onFor(p).length) : []
  const def = ws?.default ? view.connections.find((c) => c.id === ws.default) : undefined
  const chosen = value ? view.connections.find((c) => c.id === value) : undefined
  return (
    <>
      <label htmlFor={id}>{tr(M.label)}</label>
      <div>
        <select
          id={id}
          className="input"
          aria-label={tr(M.label)}
          value={value}
          onChange={(e) => {
            const c = view.connections.find((x) => x.id === e.target.value)
            if (c && c.provider !== provider && onOtherCli) onOtherCli(c.provider, c.id)
            else onChange(e.target.value)
          }}
        >
          <option value="">{def ? tr(M.default, { name: def.name }) : tr(M.defaultNone)}</option>
          {on.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          {value && !on.some((c) => c.id === value) && <option value={value}>{chosen && chosen.provider === provider ? tr(M.off, { name: chosen.name }) : tr(M.gone)}</option>}
          {others.map((p) => (
            <optgroup key={p} label={tr(M.otherCli, { cli: providerDescriptor(p).name })}>
              {onFor(p).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {!on.length && <div className="hint">{tr(M.none, { cli: providerDescriptor(provider).name })}</div>}
      </div>
    </>
  )
}

const MARK = {
  inherited: msg({ id: 'connections.mark.inherited', defaultMessage: "{name}: the workspace's default for {cli}, which it follows", description: "The hover of an agent's connection in its row (HI-1769): it has no connection of its own, so it runs on the workspace's default ({name}) for its CLI ({cli}: \"Claude Code\"), and follows it if the default changes." }),
  own: msg({ id: 'connections.mark.own', defaultMessage: '{name}: its own choice', description: "The hover of an agent's connection in its row (HI-1769): the connection ({name}) was chosen for it in its Agent Settings." }),
  offFallback: msg({ id: 'connections.mark.offFallback', defaultMessage: '{wanted} is off in this workspace: the default, {name}, runs it', description: "The hover of an agent's connection in its row (HI-1769): its own connection ({wanted}) is off in this workspace, so the workspace's default ({name}) runs it." }),
  deleted: msg({ id: 'connections.mark.deleted', defaultMessage: 'Connection removed', description: "An agent's row, in place of its connection (HI-1769): the connection chosen for it was removed, so it can't start until another is chosen. Short." }),
  deletedTip: msg({ id: 'connections.mark.deletedTip', defaultMessage: "The connection chosen for it was removed: it can't start until you choose another in its Agent Settings, or the workspace's default.", description: "The hover of an agent's row whose chosen connection was removed (HI-1769). Agent Settings names a dialog." }),
  otherProvider: msg({ id: 'connections.mark.otherProvider', defaultMessage: "Another CLI's connection", description: "An agent's row, in place of its connection (HI-1769): the connection chosen for it belongs to another coding agent CLI, so it can't start on it. Short." }),
  otherProviderTip: msg({ id: 'connections.mark.otherProviderTip', defaultMessage: "{wanted} is for another CLI than {cli}: it can't start until you choose one of its own in its Agent Settings.", description: "The hover of an agent's row whose chosen connection ({wanted}) belongs to another CLI than its own ({cli}) (HI-1769). Agent Settings names a dialog." }),
  offNoDefault: msg({ id: 'connections.mark.offNoDefault', defaultMessage: '{wanted} is off here', description: "An agent's row, in place of its connection (HI-1769): its own connection ({wanted}) is off in this workspace and no other is on to run it. Short." }),
  offNoDefaultTip: msg({ id: 'connections.mark.offNoDefaultTip', defaultMessage: "{wanted} is off in this workspace, and no other {cli} connection is on: it can't start until one is (Settings → Connections).", description: "The hover of an agent's row (HI-1769): its own connection ({wanted}) is off here and the workspace has no other connection on for its CLI ({cli}). Settings → Connections names a section." }),
  none: msg({ id: 'connections.mark.none', defaultMessage: 'No connection', description: "An agent's row, in place of its connection (HI-1769): the workspace has no connection on for its CLI, so it can't start. Short." }),
  noneTip: msg({ id: 'connections.mark.noneTip', defaultMessage: "No {cli} connection is on in this workspace: it can't start until one is (Settings → Connections).", description: "The hover of an agent's row (HI-1769): no connection is on in this workspace for its CLI ({cli}: \"Claude Code\"). Settings → Connections names a section." }),
  other: msg({ id: 'connections.mark.other', defaultMessage: 'Runs on {running} until it restarts. Chosen now: {chosen}', description: "The hover of a running agent's connection in its row (HI-1769, shown with a ⟳ mark): its run is on one connection ({running}) and the one it would start on now is another ({chosen}: a connection's name, or why none can run it). It keeps the one it runs on until it restarts." }),
  anotherMark: msg({ id: 'connections.mark.anotherMark', defaultMessage: 'Running on another connection than the one chosen', description: "Accessible label of the ⟳ mark beside a running agent's connection in its row (HI-1769)." })
}

/** Why none can run an agent, short (a row) or in full (its hover). */
function unusable(s: ConnectionShown, cli: string, full: boolean): string {
  const d = s.desired
  if (d.ok) return ''
  const wanted = d.wantedName ?? ''
  if (d.why === 'deleted') return tr(full ? MARK.deletedTip : MARK.deleted)
  if (d.why === 'otherProvider') return full ? tr(MARK.otherProviderTip, { wanted, cli }) : tr(MARK.otherProvider)
  if (d.why === 'offNoDefault') return tr(full ? MARK.offNoDefaultTip : MARK.offNoDefault, { wanted, cli })
  return full ? tr(MARK.noneTip, { cli }) : tr(MARK.none)
}

/** The desired connection in a hover: its name and how it was chosen, or why none can run it. */
function desiredText(s: ConnectionShown, wantedName: string | undefined, cli: string): string {
  const d = s.desired
  if (!d.ok) return unusable(s, cli, true)
  if (d.note === 'offFallback') return tr(MARK.offFallback, { wanted: wantedName ?? '', name: d.name })
  return s.inherited ? tr(MARK.inherited, { name: d.name, cli }) : tr(MARK.own, { name: d.name })
}

/** An agent's connection as a row's text (HI-1769: the agents' tables): its name (⟳ running on another), or why none. */
export function connectionCellText(own: string | undefined, provider: ProviderId, launched: LiveSessionState['launchedConnection'] | undefined, view: ConnectionsView | null): string | null {
  const s = connectionOf(own, provider, launched, view)
  if (!s) return null
  return s.shown ? `${s.shown.name}${s.other ? ' ⟳' : ''}` : unusable(s, providerDescriptor(provider).name, false)
}

/** Opens Settings → Connections. */
export function openConnections(): void {
  set({ settingsSection: 'accounts', settingsQuery: '' })
  setActivity('settings')
}

/**
 * Whether a CLI needs a connection before anything of it starts here (HI-1755's 1a, for everyone since S8): it has
 * connections and is on (the view lists it), none is on in this workspace, and this isn't a test copy on its CLI test
 * home. Copilot (none: its own login) never does.
 */
export const needsConnection = (view: ConnectionsView | null, cli: ProviderId): boolean => !!view && view.providers.includes(cli) && !view.testHome.includes(cli) && !view.workspace[cli]?.default

const SETUP = {
  text: msg({ id: 'project.banner.connectionSetup', defaultMessage: "No {cli} connection is on in this workspace, so its agents can't start. Add one and sign it in.", description: 'Banner in a project whose agents\' CLI ({cli}: "Claude Code") has no connection on in the workspace (HI-1755).' }),
  assistant: msg({ id: 'assistant.banner.connectionSetup', defaultMessage: "No {cli} connection is on in this workspace, so the Assistant can't start. Add one and sign it in.", description: 'Banner in the Assistant panel when its coding agent CLI ({cli}: "Claude Code") has no connection on in the workspace (HI-1774): it can\'t start until one is.' }),
  add: msg({ id: 'project.banner.connectionSetupAdd', defaultMessage: 'Add a Connection', description: 'Button on the banner asking for a connection: opens Settings → Connections.' }),
  setupLine: msg({ id: 'shell.setup.connections', defaultMessage: '{n, plural, =0 {{cli} signs in per connection, and none is on in this workspace yet: add one and sign it in.} one {{cli} signs in per connection: # is on in this workspace.} other {{cli} signs in per connection: # are on in this workspace.}}', description: 'Agent Setup, for a coding agent CLI ({cli}: "Claude Code") that signs in per connection (Settings → Connections) rather than here (HI-1774). {n} is how many of its connections are on in the open workspace.' }),
  open: msg({ id: 'shell.setup.openConnections', defaultMessage: 'Open Connections', description: "Agent Setup's button: opens Settings → Connections, where a coding agent CLI's connections are added and signed in." })
}

/**
 * Asks for a connection (HI-1755, Darren's 1a): where a CLI with connections has none on in the workspace, nothing of it
 * starts (never on the CLI's own login): Add a Connection opens Settings → Connections. `where`: a project's agents, or
 * the Assistant (HI-1774).
 */
export function NoConnectionBanner({ cli, where = 'project' }: { cli: ProviderId; where?: 'project' | 'assistant' }) {
  return (
    <div className="banner warn" data-connection-setup={where}>
      <Icon name="plug" /> {tr(where === 'assistant' ? SETUP.assistant : SETUP.text, { cli: providerDescriptor(cli).name })}
      <button className="btn small primary" onClick={openConnections}>
        {tr(SETUP.add)}
      </button>
    </div>
  )
}

const INTRO = {
  text: msg({ id: 'connections.intro.text', defaultMessage: "Agents now run on connections: add one for {clis} in Settings → Connections and sign it in there. Hive no longer uses the sign-in of your own terminal, which stays as it is.", description: 'A one-time banner in the main window (HI-1774): coding agents now each run on a connection (a sign-in Hive keeps, Settings → Connections) and none has been added yet. {clis} names the coding agent CLIs, joined ("Claude Code and Codex").' }),
  add: msg({ id: 'connections.intro.add', defaultMessage: 'Add a Connection', description: 'The one-time connections banner\'s button: opens Settings → Connections.' }),
  dismiss: msg({ id: 'connections.intro.dismiss', defaultMessage: 'Dismiss', description: 'The one-time connections banner\'s button: hides it for good.' })
}

/**
 * The one-time notice that agents run on connections (HI-1774): while none was ever added (an upgrade from 0.9, or a new
 * install) and it wasn't dismissed. Main decides (ConnectionsView.intro), so every window shows and hides it together.
 */
export function ConnectionsIntroBanner() {
  const view = useConnections()
  if (!view?.intro?.length) return null
  return (
    <div className="banner info wrap-banner" data-connections-intro>
      <span className="wrap-banner-text">
        <Icon name="plug" />
        <span className="grow">{tr(INTRO.text, { clis: fmt.list(view.intro.map((p) => providerDescriptor(p).name)) })}</span>
      </span>
      <span className="wrap-banner-actions">
        <button className="btn small primary" onClick={openConnections}>
          {tr(INTRO.add)}
        </button>
        <button className="btn small" data-dismiss-intro onClick={() => void call('connections:dismissIntro')}>
          {tr(INTRO.dismiss)}
        </button>
      </span>
    </div>
  )
}

/**
 * Agent Setup's line for a CLI that signs in per connection (HI-1774), in place of a sign-in of its own: how many are on
 * in this workspace, and Open Connections. Nothing for a CLI without connections, or a test copy on its CLI test home.
 */
export function ConnectionSetupLine({ cli, onOpen }: { cli: ProviderId; onOpen: () => void }) {
  const view = useConnections()
  if (!view?.providers.includes(cli) || view.testHome.includes(cli)) return null
  const n = view.workspace[cli]?.on.length ?? 0
  return (
    <div className={['banner', n ? 'info' : 'warn'].join(' ')} data-connection-setup-line={n} style={{ borderRadius: 6, marginBottom: 10 }}>
      <Icon name="plug" />
      <span className="grow">{tr(SETUP.setupLine, { cli: providerDescriptor(cli).name, n })}</span>
      <button className="btn small primary" data-open-connections onClick={() => {
          onOpen()
          openConnections()
        }}>
        {tr(SETUP.open)}
      </button>
    </div>
  )
}

/**
 * An agent's connection in its rows (HI-1769: the Agents list, the Overview, the agents' hover lists): the one it runs on
 * while it runs (⟳ when that isn't the one chosen now), else the one a start would use, or why none can. Nothing where
 * connections aren't shown (a CLI without them).
 */
export function ConnectionMark({ own, provider, launched, className, fallback = null }: { own: string | undefined; provider: ProviderId; launched?: LiveSessionState['launchedConnection']; className?: string; fallback?: ReactNode }) {
  const view = useConnections()
  const s = connectionOf(own, provider, launched, view)
  if (!s) return <>{fallback}</>
  const cli = providerDescriptor(provider).name
  const ownName = own ? view?.connections.find((c) => c.id === own)?.name : undefined
  const tip = s.other ? tr(MARK.other, { running: s.shown!.name, chosen: s.desired.ok ? s.desired.name : unusable(s, cli, false) }) : desiredText(s, ownName, cli)
  const state = s.desired.ok ? (s.inherited ? 'inherited' : (s.desired.note ?? 'own')) : s.desired.why
  return (
    <Tooltip content={tip}>
      <span className={['agent-connection', className].filter(Boolean).join(' ')} data-connection={s.shown?.id ?? ''} data-connection-state={state} data-connection-other={s.other ? '' : undefined}>
        {s.shown ? (
          s.shown.name
        ) : (
          <>
            <Icon name="warning" /> {unusable(s, cli, false)}
          </>
        )}
        {s.other && <span aria-label={tr(MARK.anotherMark)}> ⟳</span>}
      </span>
    </Tooltip>
  )
}
