import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppSettings, Connection, LiveSessionState, ProviderId } from '@shared/types'
import { connectionSummary } from './ConnectionDefaults'
import { connectionsOn, type ConnectionsView } from '@shared/accounts'
import { enabledProviders, providerDescriptor, providerName, providersInUse, providerWarnings } from '@shared/providers'
import { fmt, msg, tr } from '@shared/i18n'
import { call } from '../api'
import { set, setActivity, useStore } from '../store'
import { cliReadyOf, connectionCli, connectionOf, firstReadyConnection, firstUsableConnection, offeredConnections, orderedAccounts, type ConnectionShown } from '@shared/connectionLabel'

export { cliReadyOf, connectionCli, firstReadyConnection, firstUsableConnection, offeredConnections }
import { Icon, Tooltip } from './ui'

/**
 * Which connection an agent or the Assistant runs on (HI-2108; HI-2105's design): a named setup on an account (model,
 * effort, context, mode), grouped by account, only those usable in this workspace (an account on here, or the CLI's own
 * home), in the one order (decision A). The CLI follows from it. A saved choice that is off here or gone stays listed and
 * says so, so nothing changes silently.
 */

const M = {
  label: msg({ id: 'connections.choice.label', defaultMessage: 'Connection', description: "Label of the choice of connection an agent runs on (Agent Settings, Add Agent, Settings → Assistant): which login or service runs it." }),
  account: msg({ id: 'connections.choice.account', defaultMessage: '{account} ({cli})', description: 'A group in the choice of connection (HI-2108): the account the connections under it are on ({account}: its name, "Personal") and its coding agent CLI ({cli}: "Claude Code").' }),
  off: msg({ id: 'connections.choice.offHere', defaultMessage: "{name} (its account is off here: its CLI's first usable connection runs it)", description: "A choice of connection that is chosen but on an account turned off in this workspace ({name}: the connection's name) (HI-2108): the agent runs on its CLI's first usable connection instead." }),
  gone: msg({ id: 'connections.choice.removed', defaultMessage: "A removed connection (its CLI's first usable one runs it)", description: "A choice of connection that no longer exists (HI-2108): the agent runs on its CLI's first usable connection until another is chosen." }),
  pick: msg({ id: 'connections.choice.pick', defaultMessage: 'Choose a connection', description: 'The first choice of connection when none is chosen yet (HI-2108).' }),
  notInstalled: msg({ id: 'connections.choice.notInstalled', defaultMessage: "{cli} isn't installed", description: "Why a connection is greyed out in the choice of connection (HI-2108 round 1): its coding agent CLI ({cli}: \"Codex\") isn't installed on this PC. A short clause, lower case after the name." }),
  unavailable: msg({ id: 'connections.choice.unavailable', defaultMessage: '{name} — {why}', description: "A choice of connection that can't be chosen here (HI-2108), greyed out: its name ({name}) and why ({why}, a short clause)." }),
  newConnection: msg({ id: 'connections.choice.new', defaultMessage: 'New Connection…', description: "Button beside the choice of connection (Add Agent, HI-2108): opens the connection dialog to make another setup (model, effort, mode) on the chosen connection's account." }),
  none: msg({ id: 'connections.choice.noneHere', defaultMessage: 'No account is on in this workspace. Add one in Settings → Accounts & Connections.', description: 'Under the choice of connection when no account is on in this workspace (HI-2108). Settings → Accounts & Connections names a section.' }),
  noneCli: msg({ id: 'connections.choice.noneCli', defaultMessage: 'No {cli} account is on in this workspace. Add one in Settings → Accounts & Connections.', description: 'Under the choice of connection when no account of the coding agent CLI it is limited to ({cli}: "Claude Code") is on in this workspace (HI-2108). Settings → Accounts & Connections names a section.' }),
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
 * Which providers' problems this window shows (#474): none of those turned on installed, or else those turned on that
 * this workspace's agents (the Assistant's too) use, or that a new agent would (decision A: the first usable
 * connection's CLI). Recomputed when settings, what's installed, the workspace or its connections change.
 */
export function useProviderWarnings(): ReturnType<typeof providerWarnings> {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const workspace = useStore((s) => s.workspace)
  const view = useConnections()
  return useMemo(() => {
    const hosts = [...(workspace?.projects ?? []), ...(workspace?.assistant ? [workspace.assistant] : [])]
    const first = connectionCli(view, firstReadyConnection(view, settings, cliReadyOf(providers)).id)
    return providerWarnings(settings, (id) => providers[id], providersInUse(settings, hosts, first))
  }, [settings, providers, workspace, view])
}

/** A connection's values in a line (Settings' connection rows' own: connectionSummary), with its account found in the view. */
export function connectionLine(view: ConnectionsView | null, c: Connection, settings: AppSettings | null): string | null {
  const account = view ? orderedAccounts(view).find((a) => a.id === c.account) : undefined
  return account ? connectionSummary(c, account, settings) : null
}

/**
 * The choice of connection (HI-2108): `value` its id ('' while none is chosen); grouped by account, only accounts usable
 * here; `cli` limits it to one CLI's. `unavailable` greys one out, saying why (the Assistant: one in the CLI's own mode).
 * `onNew` shows New Connection…, given the account of the one chosen (else the first offered). `summary` (default on): its
 * values under it. `label` false: no label (the caller has one). `empty`: a first choice of '' with that text, always
 * there (HI-2118: the template dialogs' "Keep each one's", "Same as its role"); `ariaLabel` names it in place of "Connection".
 */
export function ConnectionChoice({ id, value, onChange, cli, unavailable, onNew, summary = true, label = true, empty, ariaLabel }: { id?: string; value: string; onChange: (id: string) => void; cli?: ProviderId; unavailable?: (c: Connection) => string | null; onNew?: (account: string) => void; summary?: boolean; label?: boolean; empty?: string; ariaLabel?: string }) {
  const view = useConnections()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  if (!view) return null
  const offered = offeredConnections(view, settings, cli)
  const ready = cliReadyOf(providers)
  // Greyed out: its CLI isn't installed (decision A), or what the caller says (the one chosen stays choosable, to keep it).
  const why = (c: Connection): string | null => {
    const cliOfIt = connectionCli(view, c.id)
    if (cliOfIt && ready(cliOfIt) === 'no') return tr(M.notInstalled, { cli: providerName(cliOfIt) })
    return unavailable?.(c) ?? null
  }
  const accounts = orderedAccounts(view).filter((a) => offered.some((c) => c.account === a.id))
  const chosen = value ? view.connectionRows?.find((c) => c.id === value) : undefined
  const chosenOffered = offered.some((c) => c.id === value)
  const newOn = chosen && chosenOffered ? chosen.account : offered[0]?.account
  return (
    <>
      {label && <label htmlFor={id}>{tr(M.label)}</label>}
      <div className="connection-choice">
        <div className="flex">
          <select id={id} className="input grow" aria-label={ariaLabel ?? tr(M.label)} value={value} data-connection-choice={value} onChange={(e) => onChange(e.target.value)}>
            {empty !== undefined ? <option value="">{empty}</option> : !value && <option value="">{tr(M.pick)}</option>}
            {value && !chosenOffered && <option value={value}>{chosen ? tr(M.off, { name: chosen.name }) : tr(M.gone)}</option>}
            {accounts.map((a) => (
              <optgroup key={a.id} label={tr(M.account, { account: a.name, cli: providerName(a.provider) })}>
                {connectionsOn(a.id, offered).map((c) => {
                  const off = why(c)
                  return (
                    <option key={c.id} value={c.id} disabled={!!off && c.id !== value} data-unavailable={off ? '' : undefined}>
                      {off ? tr(M.unavailable, { name: c.name, why: off }) : c.name}
                    </option>
                  )
                })}
              </optgroup>
            ))}
          </select>
          {onNew && newOn && (
            <button type="button" className="btn small subtle" data-new-connection onClick={() => onNew(newOn)}>
              <Icon name="add" /> {tr(M.newConnection)}
            </button>
          )}
        </div>
        {summary && chosen && (
          <div className="hint" data-connection-summary>
            {connectionLine(view, chosen, settings)}
          </div>
        )}
        {/* None usable (not for a test copy on its CLI test home, whose account is made as its first agent needs it). */}
        {!offered.length && !view.testHome.length && (
          <div className="hint" data-no-account>
            {cli ? tr(M.noneCli, { cli: providerName(cli) }) : tr(M.none)}{' '}
            <a onClick={openConnections}>{tr(SETUP.open)}</a>
          </div>
        )}
      </div>
    </>
  )
}

const MARK = {
  own: msg({ id: 'connections.mark.own', defaultMessage: '{name}: its own choice', description: "The hover of an agent's connection in its row (HI-1769): the connection ({name}) was chosen for it in its Agent Settings." }),
  offFallback: msg({ id: 'connections.mark.offHere', defaultMessage: "{wanted} is on an account that's off in this workspace: {name}, its CLI's first usable connection, runs it", description: "The hover of an agent's connection in its row (HI-2108): its own connection ({wanted}) is on an account turned off in this workspace, so its CLI's first usable connection ({name}) runs it." }),
  missing: msg({ id: 'connections.mark.removed', defaultMessage: "The connection chosen for it was removed: {name}, its CLI's first usable connection, runs it until you choose another in its Agent Settings", description: "The hover of an agent's connection in its row (HI-2108): its connection was removed, so its CLI's first usable connection ({name}) runs it. Agent Settings names a dialog." }),
  offNoDefault: msg({ id: 'connections.mark.offNoDefault', defaultMessage: '{wanted} is off here', description: "An agent's row, in place of its connection (HI-1769): its own connection ({wanted}) is off in this workspace and no other is on to run it. Short." }),
  offNoDefaultTip: msg({ id: 'connections.mark.offNoDefaultUsable', defaultMessage: "{wanted} is off in this workspace, and no other {cli} account is on: it can't start until one is (Settings → Accounts & Connections).", description: "The hover of an agent's row (HI-2108): its own connection ({wanted}) is on an account off here and no other account of its CLI ({cli}) is on in this workspace. Settings → Accounts & Connections names a section." }),
  none: msg({ id: 'connections.mark.none', defaultMessage: 'No connection', description: "An agent's row, in place of its connection (HI-1769): the workspace has no connection on for its CLI, so it can't start. Short." }),
  noneTip: msg({ id: 'connections.mark.noneUsable', defaultMessage: "No {cli} account is on in this workspace: it can't start until one is (Settings → Accounts & Connections).", description: "The hover of an agent's row (HI-2108): no account of its CLI ({cli}: \"Claude Code\") is on in this workspace. Settings → Accounts & Connections names a section." }),
  other: msg({ id: 'connections.mark.other', defaultMessage: 'Runs on {running} until it restarts. Chosen now: {chosen}', description: "The hover of a running agent's connection in its row (HI-1769, shown with a ⟳ mark): its run is on one connection ({running}) and the one it would start on now is another ({chosen}: a connection's name, or why none can run it). It keeps the one it runs on until it restarts." }),
  anotherMark: msg({ id: 'connections.mark.anotherMark', defaultMessage: 'Running on another connection than the one chosen', description: "Accessible label of the ⟳ mark beside a running agent's connection in its row (HI-1769)." })
}

/** Why none can run an agent, short (a row) or in full (its hover). */
function unusable(s: ConnectionShown, cli: string, full: boolean): string {
  const d = s.desired
  if (d.ok) return ''
  const wanted = d.wantedName ?? ''
  if (d.why === 'offNoDefault') return tr(full ? MARK.offNoDefaultTip : MARK.offNoDefault, { wanted, cli })
  return full ? tr(MARK.noneTip, { cli }) : tr(MARK.none)
}

/** The desired connection in a hover: its name and how it was chosen, or why none can run it. */
function desiredText(s: ConnectionShown, wantedName: string | undefined, cli: string): string {
  const d = s.desired
  if (!d.ok) return unusable(s, cli, true)
  if (d.note === 'offFallback') return tr(MARK.offFallback, { wanted: wantedName ?? '', name: d.name })
  if (d.note === 'missing') return tr(MARK.missing, { name: d.name })
  return tr(MARK.own, { name: d.name })
}

/** An agent's connection as a row's text (HI-1769: the agents' tables): its name (⟳ running on another), or why none. */
export function connectionCellText(own: string | undefined, provider: ProviderId, launched: LiveSessionState['launchedConnection'] | undefined, view: ConnectionsView | null): string | null {
  const s = connectionOf(own, provider, launched, view)
  if (!s) return null
  return s.shown ? `${s.shown.name}${s.other ? ' ⟳' : ''}` : unusable(s, providerDescriptor(provider).name, false)
}

/** Why nothing can start here (HI-2108): no account is on in this workspace, as the choice says it. */
export const noAccountText = (): string => tr(M.none)

/**
 * Whether no account is on in this workspace for a choice to offer (HI-2108): none offered, and this isn't a test copy
 * on its CLI test home (whose account is made as its first agent needs it).
 */
export const noAccountHere = (view: ConnectionsView | null, settings: Parameters<typeof offeredConnections>[1]): boolean => !!view && !offeredConnections(view, settings).length && !view.testHome.length

/** Opens Settings → Accounts & Connections. */
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
  text: msg({ id: 'project.banner.connectionSetup', defaultMessage: "No {cli} account is on in this workspace, so its agents can't start. Add one and sign it in.", description: 'Banner in a project whose agents\' CLI ({cli}: "Claude Code") has no account (a sign-in or server) on in the workspace (HI-1755; HI-2108).' }),
  assistant: msg({ id: 'assistant.banner.connectionSetup', defaultMessage: "No {cli} account is on in this workspace, so the Assistant can't start. Add one and sign it in.", description: 'Banner in the Assistant panel when its coding agent CLI ({cli}: "Claude Code") has no account (a sign-in or server) on in the workspace (HI-1774; HI-2108): it can\'t start until one is.' }),
  add: msg({ id: 'project.banner.connectionSetupAdd', defaultMessage: 'Add an Account', description: 'Button on the banner asking for an account (HI-2108): opens Settings → Accounts & Connections.' }),
  setupLine: msg({ id: 'shell.setup.connections', defaultMessage: '{n, plural, =0 {{cli} signs in per account, and none is on in this workspace yet: add one and sign it in.} one {{cli} signs in per account: # is on in this workspace.} other {{cli} signs in per account: # are on in this workspace.}}', description: 'Provider Setup, for a coding agent CLI ({cli}: "Claude Code") that signs in per account (Settings → Accounts & Connections) rather than here (HI-1774; HI-2108). {n} is how many of its accounts are on in the open workspace.' }),
  open: msg({ id: 'shell.setup.openConnections', defaultMessage: 'Open Accounts & Connections', description: "Provider Setup's button (HI-2108): opens Settings → Accounts & Connections, where a coding agent CLI's accounts are added and signed in." })
}

/**
 * Asks for a connection (HI-1755, Darren's 1a): where a CLI with connections has none on in the workspace, nothing of it
 * starts (never on the CLI's own login): Add an Account opens Settings → Accounts & Connections. `where`: a project's agents, or
 * the Assistant (HI-1774).
 */
export function NoConnectionBanner({ cli, where = 'project' }: { cli: ProviderId; where?: 'project' | 'assistant' }) {
  return (
    // The wrap-banner layout (HI-2535): in a narrow pane the button goes under the message, not beside a thin column of it.
    <div className="banner warn wrap-banner" data-connection-setup={where}>
      <span className="wrap-banner-text">
        <Icon name="plug" />
        <span className="grow">{tr(where === 'assistant' ? SETUP.assistant : SETUP.text, { cli: providerDescriptor(cli).name })}</span>
      </span>
      <span className="wrap-banner-actions">
        <button className="btn small primary" onClick={openConnections}>
          {tr(SETUP.add)}
        </button>
      </span>
    </div>
  )
}

const INTRO = {
  text: msg({ id: 'connections.intro.text', defaultMessage: "Agents now run on accounts: add one for {clis} in Settings → Accounts & Connections and sign it in there. Combwork no longer uses the sign-in of your own terminal, which stays as it is.", description: 'A one-time banner in the main window (HI-1774; HI-2108): coding agents now each run on an account (a sign-in Combwork keeps, Settings → Accounts & Connections) and none has been added yet. {clis} names the coding agent CLIs, joined ("Claude Code and Codex").' }),
  add: msg({ id: 'connections.intro.add', defaultMessage: 'Add an Account', description: 'The one-time accounts banner\'s button (HI-2108): opens Settings → Accounts & Connections.' }),
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
 * Provider Setup's line for a CLI that signs in per account (HI-1774), in place of a sign-in of its own: how many are on
 * in this workspace, and Open Accounts & Connections. Nothing for a CLI without connections, or a test copy on its CLI test home.
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
  const ownName = own ? view?.connectionRows?.find((c) => c.id === own)?.name : undefined
  const tip = s.other ? tr(MARK.other, { running: s.shown!.name, chosen: s.desired.ok ? s.desired.name : unusable(s, cli, false) }) : desiredText(s, ownName, cli)
  const state = s.desired.ok ? (s.desired.note ?? 'own') : s.desired.why
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
