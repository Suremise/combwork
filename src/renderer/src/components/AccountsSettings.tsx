import { ConnectionDefaultsEditor, MovedNoticeBanner } from './ConnectionDefaults'
import { useCallback, useEffect, useState } from 'react'
import type { ProviderId } from '@shared/types'
import { accountState, duplicateLogins, type ConnectionsView, type ConnectionState } from '@shared/accounts'
import { enabledProviders, providerDescriptor } from '@shared/providers'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { confirm, notify, prompt, useStore } from '../store'
import { Icon, Switch } from './ui'
import { timeAgo } from '../util'
import { TerminalView } from './TerminalView'
import { AddConnectionDialog, hasServers, MaskingBanner, ServerConnectionDetail, setUpConnection, setUpHint, setUpLabel } from './ServerConnections'

/**
 * Settings → Accounts (HI-980): Hive's accounts, each a CLI login in a folder of its own, signed in through the CLI's
 * own sign-in in one of Hive's terminals (nothing typed into it). Each row says who it is signed in as, from the CLI's
 * own status, and whether its login changed; this window's workspace turns accounts on and picks its default.
 */

const M = {
  none: msg({ id: 'settings.accounts.none', defaultMessage: 'No connections yet. Add one, then sign it in.', description: 'Settings → Connections when there are no connections.' }),
  ownLogin: msg({ id: 'settings.accounts.ownLogin', defaultMessage: '{cli} has no connections: it signs in once for the whole PC, in Help → Agent Setup, and its agents use that sign-in.', description: 'A line in Settings → Connections for a coding agent CLI that is on but has no connections ({cli}: "GitHub Copilot", whose sign-in is machine-wide, HI-1758). Help → Agent Setup names a dialog: use its name as Hive shows it.' }),
  noWorkspace: msg({ id: 'settings.accounts.noWorkspace', defaultMessage: 'Open a workspace to choose which connections are on in it.', description: 'Settings → Connections with no workspace open: the On and Default choices are per workspace.' }),
  loading: msg({ id: 'settings.accounts.loading', defaultMessage: 'Loading…', description: 'Settings → Connections while its list loads.' }),
  add: msg({ id: 'settings.accounts.add', defaultMessage: 'Add Connection…', description: 'Button in Settings → Connections: adds a connection (asks its name and where it gets its model), then opens its sign-in or sets up its server.' }),
  addTitle: msg({ id: 'settings.accounts.addTitle', defaultMessage: 'Add a {cli} sign-in connection', description: 'Title of the dialog asking a new connection\'s name (Settings → Connections). {cli} is a coding agent CLI ("Claude Code").' }),
  addMessage: msg({ id: 'settings.accounts.addMessage', defaultMessage: "A name for it, such as Anthropic · Max 1 or Work. Hive makes its folder, then opens {cli}'s sign-in in your browser.", description: "The message of the dialog asking a new connection's name (Settings → Connections). {cli} is a coding agent CLI." }),
  name: msg({ id: 'settings.accounts.name', defaultMessage: 'Name', description: "The label of the box for a connection's name (Settings → Connections)." }),
  addConfirm: msg({ id: 'settings.accounts.addConfirm', defaultMessage: 'Add and Sign In', description: "The confirm button of the dialog adding a connection (Settings → Connections)." }),
  needName: msg({ id: 'settings.accounts.needName', defaultMessage: 'Give it a name.', description: "Under the name box of a connection (Settings → Connections) while it's empty." }),
  addFailed: msg({ id: 'settings.accounts.addFailed', defaultMessage: "Couldn't add the connection", description: "An error's title: adding a connection failed (Settings → Connections)." }),
  rename: msg({ id: 'settings.accounts.rename', defaultMessage: 'Rename…', description: 'Button on a connection (Settings → Connections): changes its name only.' }),
  renameTitle: msg({ id: 'settings.accounts.renameTitle', defaultMessage: 'Rename {name}', description: "Title of the dialog renaming a connection ({name}, its name)." }),
  renameConfirm: msg({ id: 'settings.accounts.renameConfirm', defaultMessage: 'Rename', description: 'The confirm button of the dialog renaming a connection.' }),
  signIn: msg({ id: 'settings.accounts.signIn', defaultMessage: 'Sign In', description: "Button on a connection (Settings → Connections): opens the CLI's own sign-in for it, in a terminal of Hive's." }),
  signInAgain: msg({ id: 'settings.accounts.signInAgain', defaultMessage: 'Sign In Again', description: "Button on a connection (Settings → Connections) that is signed out, or whose login changed: opens the CLI's own sign-in for it again." }),
  signingIn: msg({ id: 'settings.accounts.signingIn', defaultMessage: "Signing in: finish in your browser, or in the terminal below. Hive doesn't type into it.", description: "Settings → Connections while a connection's sign-in terminal is open: the user signs in through the CLI's own flow." }),
  signingInElsewhere: msg({ id: 'settings.accounts.signingInElsewhere', defaultMessage: 'Signing in, in another window', description: "A connection's line in Settings → Connections while its sign-in is open in another of Hive's windows." }),
  signInFailed: msg({ id: 'settings.accounts.signInFailed', defaultMessage: "Couldn't open the sign-in", description: "An error's title: a connection's sign-in terminal couldn't be opened." }),
  close: msg({ id: 'settings.accounts.closeTerminal', defaultMessage: 'Close', description: "Button under a connection's ended sign-in terminal (Settings → Connections): hides it." }),
  keep: msg({ id: 'settings.accounts.keep', defaultMessage: 'Keep the New Login', description: 'Button on a connection whose login changed (Settings → Connections): takes on the login it is now signed in as.' }),
  keepRename: msg({ id: 'settings.accounts.keepRename', defaultMessage: 'Kept. Rename {name} to match?', description: 'After Keep the New Login on a connection ({name}): offers to rename it, since it is now another login.' }),
  keepFailed: msg({ id: 'settings.accounts.keepFailed', defaultMessage: "Couldn't keep the new login", description: "An error's title: Keep the New Login failed." }),
  remove: msg({ id: 'settings.accounts.remove', defaultMessage: 'Remove…', description: 'Button on a connection (Settings → Connections): removes it and deletes its folder (asks first).' }),
  removeTitle: msg({ id: 'settings.accounts.removeTitle', defaultMessage: 'Remove {name}?', description: "Title of the dialog confirming a connection's removal ({name}, its name)." }),
  removeMessage: msg({ id: 'settings.accounts.removeMessage', defaultMessage: "Its folder is deleted for good, with its login on this PC (it doesn't go to the Recycle Bin). Your conversations and Claude Code's memory are kept: they are shared with your other connections. The account itself stays yours at Anthropic.", description: "The message of the dialog confirming a connection's removal (Settings → Connections)." }),
  removeConfirm: msg({ id: 'settings.accounts.removeConfirm', defaultMessage: 'Remove', description: "The confirm button of the dialog removing a connection." }),
  removing: msg({ id: 'settings.accounts.removing', defaultMessage: 'Removing…', description: 'The confirm button of the dialog removing a connection, while it removes it.' }),
  onHere: msg({ id: 'settings.accounts.onHere', defaultMessage: 'On in this workspace', description: 'The switch on a connection (Settings → Connections): whether it is on in the open workspace.' }),
  default: msg({ id: 'settings.accounts.default', defaultMessage: 'Default', description: "The choice on a connection (Settings → Connections): the open workspace's default connection for its CLI." }),
  isDefault: msg({ id: 'settings.accounts.isDefault', defaultMessage: "This workspace's default", description: "Shown on the connection that is the open workspace's default (Settings → Connections)." }),
  makeDefault: msg({ id: 'settings.accounts.makeDefault', defaultMessage: 'Make Default', description: "Button on a connection (Settings → Connections): makes it the open workspace's default connection for its CLI (turning it on)." }),
  changeFailed: msg({ id: 'settings.accounts.changeFailed', defaultMessage: "Couldn't change the connection", description: "An error's title: renaming a connection, turning it on or off, or making it the default failed." }),
  removeFailed: msg({ id: 'settings.accounts.removeFailed', defaultMessage: "Couldn't remove the connection", description: "An error's title: removing a connection failed." }),
  sameLogin: msg({ id: 'settings.accounts.sameLogin', defaultMessage: 'Signed in to the same login as another connection: {names}', description: 'A warning on a connection (Settings → Connections): other connections are signed in as the same login. {names} is their names, listed.' }),
  leftover: msg({ id: 'settings.accounts.leftover', defaultMessage: "Not all removed: {what}. Remove tries again; nothing outside its folder was touched.", description: "A warning on a connection (Settings → Connections) whose removal stopped partway. {what} is what's left, in English." }),
  plan: msg({ id: 'settings.accounts.plan', defaultMessage: '{email} · {plan}', description: "A connection's identity in Settings → Connections: the email it is signed in as, and its plan as the CLI names it (\"max\")." }),
  changedTo: msg({ id: 'settings.accounts.changedTo', defaultMessage: 'Now signed in as {now}, was {was}', description: 'A warning on a connection (Settings → Connections): its login changed (a /login typed in a pane). {now} and {was} are emails.' }),
  affected: msg({ id: 'settings.accounts.affected', defaultMessage: '{n, plural, one {# running agent runs on another connection than the one chosen for it now.} other {# running agents run on another connection than the one chosen for them now.}}', description: 'Banner in Settings → Connections after a connection was turned off or the default changed (HI-1755): how many running agents are on a connection other than the one chosen now.' }),
  switchAffected: msg({ id: 'settings.accounts.switchAffected', defaultMessage: 'Switch Them When Their Turn Is Over', description: 'Button on that banner: each of those agents ends once its turn is over and carries on, on the connection chosen now.' }),
  checkedAt: msg({ id: 'settings.accounts.checkedAt', defaultMessage: 'Checked {when}', description: "The tooltip of a connection's state (Settings → Connections): when it was last checked. {when} is how long ago (\"5 min ago\")." })
}

const STATE: Record<ConnectionState, ReturnType<typeof msg>> = {
  signedIn: msg({ id: 'settings.accounts.state.signedIn', defaultMessage: 'Signed in', description: "A connection's state (Settings → Connections)." }),
  signedOut: msg({ id: 'settings.accounts.state.signedOut', defaultMessage: 'Signed out', description: "A connection's state (Settings → Connections): the CLI says its folder isn't signed in." }),
  changed: msg({ id: 'settings.accounts.state.changed', defaultMessage: 'Login changed', description: "A connection's state (Settings → Connections): signed in as another login than the one it was added with." }),
  failed: msg({ id: 'settings.accounts.state.failed', defaultMessage: "Couldn't check", description: "A connection's state (Settings → Connections): Hive couldn't ask the CLI who it's signed in as (not the same as signed out)." }),
  missing: msg({ id: 'settings.accounts.state.missing', defaultMessage: 'Folder missing', description: "A connection's state (Settings → Connections): its folder isn't there, or isn't the one Hive made." }),
  unchecked: msg({ id: 'settings.accounts.state.unchecked', defaultMessage: 'Not checked yet', description: "A connection's state (Settings → Connections): Hive hasn't asked the CLI yet." })
}
const STATE_ICON: Record<ConnectionState, string> = { signedIn: 'pass-filled', signedOut: 'circle-slash', changed: 'warning', failed: 'question', missing: 'warning', unchecked: 'circle-outline' }

export function AccountsSettings() {
  const changed = useStore((s) => s.connectionsChanged)
  const wsPath = useStore((s) => s.workspace?.path ?? null)
  const projects = useStore((s) => s.workspace?.projects)
  const settings = useStore((s) => s.settings)
  const withoutConnections = enabledProviders(settings).filter((p) => !p.capabilities.connections)
  const [view, setView] = useState<ConnectionsView | null>(null)
  const [terminal, setTerminal] = useState<{ id: string; key: string; ended: boolean; setUp?: ProviderId } | null>(null)
  // Add Connection's dialog (HI-1772), for a CLI that can also get its model from a server.
  const [adding, setAdding] = useState<ProviderId | null>(null)
  const load = useCallback((check: boolean) => {
    call('connections:list', check)
      .then(setView)
      .catch(() => undefined)
  }, [])
  // Each account checked again as the section is shown; read again whenever main says they changed.
  useEffect(() => load(true), [load, wsPath])
  useEffect(() => load(false), [load, changed])

  if (!view) return <div className="faint">{tr(M.loading)}</div>
  // Agents running on a connection other than the one chosen for them now (HI-1755), not yet waiting to switch.
  const affected = (projects ?? []).flatMap((p) => p.agents).filter((a) => a.restartNeeded && a.live?.launchedConnection && !a.live.switchPending).length
  const dups = duplicateLogins(view.connections)
  const nameOf = (id: string): string => view.connections.find((a) => a.id === id)?.name ?? id
  // The connection an ended sign-in terminal signed in, offered its Set Up (HI-1826).
  const after = terminal?.ended && !terminal.setUp ? view.connections.find((a) => a.id === terminal.id) : undefined
  const signedInAfter = after && after.kind !== 'server' && !after.leftover && accountState(after) === 'signedIn' ? after : undefined
  const act = async (title: ReturnType<typeof msg>, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      notify('error', tr(title), errorMessage(e))
    }
  }
  const signIn = async (id: string): Promise<void> => {
    try {
      const key = await call('connections:signIn', id)
      setTerminal({ id, key, ended: false })
    } catch (e) {
      notify('error', tr(M.signInFailed), errorMessage(e))
    }
  }
  const setUp = async (id: string, provider: ProviderId): Promise<void> => {
    const key = await setUpConnection(id)
    if (key) setTerminal({ id, key, ended: false, setUp: provider })
  }
  const add = async (provider: ProviderId): Promise<void> => {
    if (hasServers(provider)) return setAdding(provider)
    const cli = providerDescriptor(provider).name
    const name = await prompt({ title: tr(M.addTitle, { cli }), message: tr(M.addMessage, { cli }), fieldLabel: tr(M.name), confirmLabel: tr(M.addConfirm), validate: (v) => (v.trim() ? null : tr(M.needName)) })
    if (!name) return
    try {
      const a = await call('connections:add', provider, name)
      await signIn(a.id)
    } catch (e) {
      notify('error', tr(M.addFailed), errorMessage(e))
    }
  }
  const rename = async (id: string, current: string, title = tr(M.renameTitle, { name: current })): Promise<void> => {
    const name = await prompt({ title, fieldLabel: tr(M.name), initial: current, confirmLabel: tr(M.renameConfirm), validate: (v) => (v.trim() ? null : tr(M.needName)) })
    if (name && name.trim() !== current) await act(M.changeFailed, () => call('connections:rename', id, name))
  }
  const remove = async (id: string, name: string): Promise<void> => {
    await confirm({ title: tr(M.removeTitle, { name }), message: tr(M.removeMessage), confirmLabel: tr(M.removeConfirm), busyLabel: tr(M.removing), danger: true, run: () => call('connections:remove', id) }).catch((e) => notify('error', tr(M.removeFailed), errorMessage(e)))
  }
  const keep = async (id: string, name: string, email?: string): Promise<void> => {
    try {
      await call('connections:keepLogin', id)
    } catch (e) {
      notify('error', tr(M.keepFailed), errorMessage(e))
      return
    }
    await rename(id, name, tr(M.keepRename, { name: email ?? name }))
  }

  return (
    <div className="accounts-settings">
      {!wsPath && <p className="hint">{tr(M.noWorkspace)}</p>}
      <MaskingBanner masking={view.masking} />
      <MovedNoticeBanner />
      {affected > 0 && (
        <div className="banner warn" data-switch-affected>
          <Icon name="refresh" /> {tr(M.affected, { n: affected })}
          <button className="btn small primary" onClick={() => void act(M.changeFailed, () => call('connections:switchAffected'))}>
            {tr(M.switchAffected)}
          </button>
        </div>
      )}
      {view.providers.map((p) => {
        const mine = view.connections.filter((a) => a.provider === p)
        const ws = view.workspace[p]
        return (
          <div key={p} className="accounts-provider" data-provider={p}>
            {mine.length === 0 && <div className="faint">{tr(M.none)}</div>}
            {mine.map((a) => {
              const server = a.kind === 'server'
              const state = accountState(a)
              const on = !!ws?.on.includes(a.id)
              const isDefault = ws?.default === a.id
              const o = a.observed
              const ident = o?.email ? (o.plan ? tr(M.plan, { email: o.email, plan: o.plan }) : o.email) : a.accepted?.email
              const same = dups.get(a.id)
              return (
                <div key={a.id} className="account-row" data-account={a.id} data-state={server ? 'server' : state}>
                  <div className="account-main">
                    <div className="account-name">{a.name}</div>
                    {server ? (
                      <ServerConnectionDetail c={a} keyLast4={a.key?.last4} onSetUp={(id) => void setUp(id, a.provider)} />
                    ) : (
                      <>
                        <div className="account-ident muted">{ident}</div>
                        <div className={`account-state state-${state}`} title={o?.at ? tr(M.checkedAt, { when: timeAgo(o.at) }) : undefined}>
                          <Icon name={STATE_ICON[state]} /> {tr(STATE[state])}
                          {a.signingIn && terminal?.id !== a.id && <span className="muted"> · {tr(M.signingInElsewhere)}</span>}
                        </div>
                      </>
                    )}
                    {state === 'changed' && a.accepted && o?.email && <div className="account-warning" data-warning="changed"><Icon name="warning" /> {tr(M.changedTo, { now: o.email, was: a.accepted.email })}</div>}
                    {same && <div className="account-warning" data-warning="duplicate"><Icon name="warning" /> {tr(M.sameLogin, { names: fmt.list(same.map(nameOf)) })}</div>}
                    {a.leftover && <div className="account-warning" data-warning="leftover"><Icon name="warning" /> {tr(M.leftover, { what: a.leftover })}</div>}
                    <ConnectionDefaultsEditor connection={a} />
                  </div>
                  <div className="account-actions">
                    <Switch checked={on} disabled={!wsPath || !!a.leftover} label={tr(M.onHere)} onChange={(v) => void act(M.changeFailed, () => call('connections:setOn', a.id, v))} />
                    {isDefault ? <span className="account-default">{tr(M.isDefault)}</span> : <button className="btn subtle" disabled={!wsPath || !!a.leftover} onClick={() => void act(M.changeFailed, () => call('connections:setDefault', a.id))}>{tr(M.makeDefault)}</button>}
                    {!server && state === 'changed' && <button className="btn subtle" onClick={() => void keep(a.id, a.name, o?.email)}>{tr(M.keep)}</button>}
                    {!server && !a.leftover && <button className="btn" onClick={() => void signIn(a.id)}>{tr(state === 'signedOut' || state === 'changed' ? M.signInAgain : M.signIn)}</button>}
                    {/* Its first-run screens, which a browser sign-in leaves unanswered (HI-1826). */}
                    {!server && !a.leftover && state === 'signedIn' && <button className="btn subtle" data-set-up onClick={() => void setUp(a.id, a.provider)}>{setUpLabel()}</button>}
                    <button className="btn subtle" disabled={!!a.leftover} onClick={() => void rename(a.id, a.name)}>{tr(M.rename)}</button>
                    <button className="btn subtle" onClick={() => void remove(a.id, a.name)}>{tr(M.remove)}</button>
                  </div>
                </div>
              )
            })}
            <button className="btn" data-add={p} onClick={() => void add(p)}>
              <Icon name="add" /> {tr(M.add)}
            </button>
          </div>
        )
      })}
      {/* A CLI on without connections (Copilot: HI-1758) launches on its own login, shared by the whole PC. */}
      {withoutConnections.map((p) => (
        <p key={p.id} className="hint" data-no-connections={p.id}>
          {tr(M.ownLogin, { cli: p.name })}
        </p>
      ))}
      {adding && <AddConnectionDialog cli={adding} onClose={() => setAdding(null)} onSignIn={(id) => void signIn(id)} />}
      {terminal && (
        <div className="account-signin">
          <p className="hint">{terminal.setUp ? setUpHint(terminal.setUp) : tr(M.signingIn)}</p>
          <div className="task-terminal">
            <TerminalView ptyKey={terminal.key} visible onExit={() => setTerminal((t) => (t?.key === terminal.key ? { ...t, ended: true } : t))} />
          </div>
          {terminal.ended && (
            <div className="flex">
              {/* Set Up after Sign In (HI-1826): the CLI's first-run screens, answered once here rather than in an agent's pane. */}
              {!terminal.setUp && signedInAfter && <button className="btn primary" data-set-up-after onClick={() => void setUp(signedInAfter.id, signedInAfter.provider)}>{setUpLabel()}</button>}
              <button className="btn" onClick={() => setTerminal(null)}>{tr(M.close)}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
