import { ConnectionDefaultsEditor, MovedNoticeBanner } from './ConnectionDefaults'
import { useCallback, useEffect, useState } from 'react'
import type { ProviderId } from '@shared/types'
import { accountState, connectionReadiness, duplicateLogins, type ConnectionsView, type ConnectionState } from '@shared/accounts'
import { enabledProviders, providerDescriptor } from '@shared/providers'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { confirm, notify, prompt, useStore } from '../store'
import { Icon, Switch } from './ui'
import { cx, timeAgo } from '../util'
import { TerminalView } from './TerminalView'
import { ProviderIcon } from './ProviderIcon'
import { AddConnectionDialog, MaskingBanner, ServerConnectionDetail, setUpConnection, setUpHint, setUpLabel } from './ServerConnections'

/**
 * Settings → Accounts (HI-980): Hive's accounts, each a CLI login in a folder of its own, signed in through the CLI's
 * own sign-in in one of Hive's terminals (nothing typed into it). Each row says who it is signed in as, from the CLI's
 * own status, and whether its login changed; this window's workspace turns accounts on and picks its default.
 */

const M = {
  none: msg({ id: 'settings.accounts.none', defaultMessage: 'No connections yet. Add one, then sign it in.', description: 'Settings → Connections when there are no connections.' }),
  ownLogin: msg({ id: 'settings.accounts.ownLogin', defaultMessage: '{cli} has no connections: it signs in once for the whole PC, in Help → Provider Setup, and its agents use that sign-in.', description: 'A line in Settings → Connections for a coding agent CLI that is on but has no connections ({cli}: "GitHub Copilot", whose sign-in is machine-wide, HI-1758). Help → Provider Setup names a dialog: use its name as Hive shows it.' }),
  noWorkspace: msg({ id: 'settings.accounts.noWorkspace', defaultMessage: 'Open a workspace to choose which connections are on in it.', description: 'Settings → Connections with no workspace open: the On and Default choices are per workspace.' }),
  loading: msg({ id: 'settings.accounts.loading', defaultMessage: 'Loading…', description: 'Settings → Connections while its list loads.' }),
  add: msg({ id: 'settings.accounts.addOne', defaultMessage: 'Add a Connection…', description: 'Button under the list in Settings → Connections: adds a connection (asks which coding agent CLI, its name and where it gets its model), then opens its sign-in or sets up its server.' }),
  name: msg({ id: 'settings.accounts.name', defaultMessage: 'Name', description: "The label of the box for a connection's name (Settings → Connections)." }),
  needName: msg({ id: 'settings.accounts.needName', defaultMessage: 'Give it a name.', description: "Under the name box of a connection (Settings → Connections) while it's empty." }),
  rename: msg({ id: 'settings.accounts.rename', defaultMessage: 'Rename…', description: 'Button on a connection (Settings → Connections): changes its name only.' }),
  renameTitle: msg({ id: 'settings.accounts.renameTitle', defaultMessage: 'Rename {name}', description: "Title of the dialog renaming a connection ({name}, its name)." }),
  renameConfirm: msg({ id: 'settings.accounts.renameConfirm', defaultMessage: 'Rename', description: 'The confirm button of the dialog renaming a connection.' }),
  signIn: msg({ id: 'settings.accounts.signIn', defaultMessage: 'Sign In', description: "Button on a connection (Settings → Connections): opens the CLI's own sign-in for it, in a terminal of Hive's." }),
  signInAgain: msg({ id: 'settings.accounts.signInAgain', defaultMessage: 'Sign In Again', description: "Button on a connection (Settings → Connections) that is signed out, or whose login changed: opens the CLI's own sign-in for it again." }),
  signingIn: msg({ id: 'settings.accounts.signingIn', defaultMessage: "Signing in: finish in your browser, or in the terminal below. Hive doesn't type into it.", description: "Settings → Connections while a connection's sign-in terminal is open: the user signs in through the CLI's own flow." }),
  signingInElsewhere: msg({ id: 'settings.accounts.signingInElsewhere', defaultMessage: 'Signing in, in another window', description: "A connection's line in Settings → Connections while its sign-in is open in another of Hive's windows." }),
  signInFailed: msg({ id: 'settings.accounts.signInFailed', defaultMessage: "Couldn't open the sign-in", description: "An error's title: a connection's sign-in terminal couldn't be opened." }),
  close: msg({ id: 'settings.accounts.closeTerminal', defaultMessage: 'Close', description: "Button under a connection's sign-in or Set Up terminal (Settings → Connections): hides it, ending the CLI in it if it still runs (asks first then)." }),
  closeRunningTitle: msg({ id: 'settings.accounts.closeRunningTitle', defaultMessage: 'Close the terminal?', description: "Title of the dialog asked by Close under a connection's sign-in or Set Up terminal while the CLI in it still runs (Settings → Connections)." }),
  closeRunningMessage: msg({ id: 'settings.accounts.closeRunningMessage', defaultMessage: '{cli} is still running in it. Closing the terminal ends it.', description: "The message of that dialog ({cli}: the coding agent CLI, \"Codex\"): closing ends the CLI and what it started." }),
  closeRunningConfirm: msg({ id: 'settings.accounts.closeRunningConfirm', defaultMessage: 'Close Terminal', description: "The confirm button of that dialog: ends the CLI and hides its terminal." }),
  keep: msg({ id: 'settings.accounts.keep', defaultMessage: 'Keep the New Login', description: 'Button on a connection whose login changed (Settings → Connections): takes on the login it is now signed in as.' }),
  keepRename: msg({ id: 'settings.accounts.keepRename', defaultMessage: 'Kept. Rename {name} to match?', description: 'After Keep the New Login on a connection ({name}): offers to rename it, since it is now another login.' }),
  keepFailed: msg({ id: 'settings.accounts.keepFailed', defaultMessage: "Couldn't keep the new login", description: "An error's title: Keep the New Login failed." }),
  remove: msg({ id: 'settings.accounts.remove', defaultMessage: 'Remove…', description: 'Button on a connection (Settings → Connections): removes it and deletes its folder (asks first).' }),
  removeTitle: msg({ id: 'settings.accounts.removeTitle', defaultMessage: 'Remove {name}?', description: "Title of the dialog confirming a connection's removal ({name}, its name)." }),
  removeMessage: msg({ id: 'settings.accounts.removeMessage', defaultMessage: "Its folder is deleted for good, with its login on this PC (it doesn't go to the Recycle Bin). Your conversations and Claude Code's memory are kept: they are shared with your other connections. The account itself stays yours at Anthropic.", description: "The message of the dialog confirming a connection's removal (Settings → Connections)." }),
  removeConfirm: msg({ id: 'settings.accounts.removeConfirm', defaultMessage: 'Remove', description: "The confirm button of the dialog removing a connection." }),
  removeOpenTitle: msg({ id: 'settings.accounts.removeOpenTitle', defaultMessage: 'Close its terminal and remove {name}?', description: "Title of the dialog confirming a connection's removal ({name}, its name) while its sign-in or Set Up terminal is open: the terminal is closed first, ending the CLI in it." }),
  removeOpenConfirm: msg({ id: 'settings.accounts.removeOpenConfirm', defaultMessage: 'Close Terminal and Remove', description: "The confirm button of that dialog." }),
  removing: msg({ id: 'settings.accounts.removing', defaultMessage: 'Removing…', description: 'The confirm button of the dialog removing a connection, while it removes it.' }),
  onHere: msg({ id: 'settings.accounts.onHere', defaultMessage: 'On in this workspace', description: 'The switch on a connection (Settings → Connections): whether it is on in the open workspace.' }),
  default: msg({ id: 'settings.accounts.default', defaultMessage: 'Default', description: "Shown on the first connection in its coding agent CLI's order (Settings → Connections, HI-1875): a hint, Hive-wide. New agents use the first connection in the order that's on in the workspace." }),
  makeDefault: msg({ id: 'settings.accounts.makeDefault', defaultMessage: 'Make Default', description: "Button on a connection (Settings → Connections, HI-1875): moves it to the top of its coding agent CLI's order. It never turns a connection on or off." }),
  usedHere: msg({ id: 'settings.accounts.usedHere', defaultMessage: 'Used here', description: "Shown on the connection new agents use in the open workspace when the Default (the top of the order) is off there (Settings → Connections, HI-1875): the first one in the order that's on." }),
  usedHereTip: msg({ id: 'settings.accounts.usedHereTip', defaultMessage: "New agents in this workspace use it: the Default is off here, and it's the first in the order that's on.", description: 'The tooltip of "Used here" on a connection (Settings → Connections, HI-1875).' }),
  move: msg({ id: 'settings.accounts.move', defaultMessage: 'Drag to change the order of {name}, or press Alt+Up or Alt+Down', description: "The tooltip and label of a connection's drag handle (Settings → Connections, HI-1875): it moves the connection in its coding agent CLI's order. Alt+Up and Alt+Down name keys." }),
  moveFailed: msg({ id: 'settings.accounts.moveFailed', defaultMessage: "Couldn't change the order", description: "An error's title: moving a connection in its coding agent CLI's order failed (Settings → Connections)." }),
  changeFailed: msg({ id: 'settings.accounts.changeFailed', defaultMessage: "Couldn't change the connection", description: "An error's title: renaming a connection, turning it on or off, or making it the default failed." }),
  removeFailed: msg({ id: 'settings.accounts.removeFailed', defaultMessage: "Couldn't remove the connection", description: "An error's title: removing a connection failed." }),
  sameLogin: msg({ id: 'settings.accounts.sameLogin', defaultMessage: 'Signed in to the same login as another connection: {names}', description: 'A warning on a connection (Settings → Connections): other connections are signed in as the same login. {names} is their names, listed.' }),
  leftover: msg({ id: 'settings.accounts.leftover', defaultMessage: "Not all removed: {what}. Remove tries again; nothing outside its folder was touched.", description: "A warning on a connection (Settings → Connections) whose removal stopped partway. {what} is what's left, in English." }),
  plan: msg({ id: 'settings.accounts.plan', defaultMessage: '{email} · {plan}', description: "A connection's identity in Settings → Connections: the email it is signed in as, and its plan as the CLI names it (\"max\")." }),
  changedTo: msg({ id: 'settings.accounts.changedTo', defaultMessage: 'Now signed in as {now}, was {was}', description: 'A warning on a connection (Settings → Connections): its login changed (a /login typed in a pane). {now} and {was} are emails.' }),
  affected: msg({ id: 'settings.accounts.affected', defaultMessage: '{n, plural, one {# running agent runs on another connection than the one chosen for it now.} other {# running agents run on another connection than the one chosen for them now.}}', description: 'Banner in Settings → Connections after a connection was turned off or the default changed (HI-1755): how many running agents are on a connection other than the one chosen now.' }),
  switchAffected: msg({ id: 'settings.accounts.switchAffected', defaultMessage: 'Switch Them When Their Turn Is Over', description: 'Button on that banner: each of those agents ends once its turn is over and carries on, on the connection chosen now.' }),
  notTrusted: msg({ id: 'settings.accounts.notTrusted', defaultMessage: 'Not trusted yet in this workspace: {projects}', description: "Under a connection that needs set up (Settings → Connections, HI-1870): the projects of the open workspace whose folders its coding agent CLI hasn't been told to trust yet ({projects}: their names, listed). Set Up asks the CLI's trust question for each in turn." }),
  moreProjects: msg({ id: 'settings.accounts.moreProjects', defaultMessage: '{n, plural, one {# more} other {# more}}', description: 'The last item of that list when it names only the first projects: how many more there are.' }),
  setUpIn: msg({ id: 'settings.accounts.setUpIn', defaultMessage: "It opens in {project}'s folder, {folder}: answer {cli}'s question to trust it.", description: "Above a connection's Set Up terminal when it opens in a project's folder its coding agent CLI ({cli}) doesn't trust yet (HI-1870): {project} is the project's name, {folder} the folder." }),
  setUpChecking: msg({ id: 'settings.accounts.setUpChecking', defaultMessage: 'Checking…', description: "A connection's state (Settings → Connections, HI-1870): Hive is still reading whether its coding agent CLI trusts the open workspace's project folders, so it doesn't say yet whether it is set up." }),
  setUpNeeded: msg({ id: 'settings.accounts.setUpNeeded', defaultMessage: 'Needs set up', description: "A connection's state (Settings → Connections, HI-1870): its CLI's one-time first-run setup (Set Up, a button beside it) hasn't been done in its folder yet." }),
  setUpDone: msg({ id: 'settings.accounts.setUpDone', defaultMessage: 'Set up', description: "A connection's state (Settings → Connections, HI-1870): its CLI's one-time first-run setup is done. An adjective (\"is set up\"), not the button." }),
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
  const [terminal, setTerminal] = useState<{ id: string; key: string; ended: boolean; provider: ProviderId; setUp?: boolean; in?: { project: string; folder: string } } | null>(null)
  // Add a Connection's dialog (HI-1772), which asks its CLI first (HI-1870).
  const [adding, setAdding] = useState(false)
  // A connection being dragged to another place in its CLI's order (HI-1875), and the row it would drop on.
  const [dragging, setDragging] = useState<{ id: string; provider: ProviderId } | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  const load = useCallback((check: boolean) => {
    call('connections:list', check)
      .then(setView)
      .catch(() => undefined)
  }, [])
  // Each account checked again as the section is shown; read again whenever main says they changed.
  useEffect(() => load(true), [load, wsPath])
  useEffect(() => load(false), [load, changed])
  // The workspace's projects changed (one added, moved): its connections' trust of them is read again (HI-1870).
  const projectPaths = (projects ?? []).map((p) => p.path).join('|')
  useEffect(() => load(false), [load, projectPaths])

  if (!view) return <div className="faint">{tr(M.loading)}</div>
  // Agents running on a connection other than the one chosen for them now (HI-1755), not yet waiting to switch.
  const affected = (projects ?? []).flatMap((p) => p.agents).filter((a) => a.restartNeeded && a.live?.launchedConnection && !a.live.switchPending).length
  const dups = duplicateLogins(view.connections)
  const nameOf = (id: string): string => view.connections.find((a) => a.id === id)?.name ?? id
  // One list (HI-1870), grouped by CLI in Settings' order, each CLI's in its preference order (HI-1875: the list's
  // own order, Hive-wide); a CLI turned off hides its connections.
  const cliOrder = (p: ProviderId): number => view.providers.indexOf(p)
  const shown = view.connections.filter((a) => cliOrder(a.provider) >= 0).sort((a, b) => cliOrder(a.provider) - cliOrder(b.provider) || view.connections.indexOf(a) - view.connections.indexOf(b))
  // Its place among its own CLI's connections: what the order means.
  const placeOf = (a: { id: string; provider: ProviderId }): number => shown.filter((x) => x.provider === a.provider).findIndex((x) => x.id === a.id)
  const move = (id: string, index: number): Promise<void> => act(M.moveFailed, () => call('connections:move', id, Math.max(0, index)))
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
  const signIn = async (id: string, provider: ProviderId): Promise<void> => {
    try {
      const key = await call('connections:signIn', id)
      setTerminal({ id, key, ended: false, provider })
    } catch (e) {
      notify('error', tr(M.signInFailed), errorMessage(e))
    }
  }
  // Main opens it in the first folder the CLI doesn't trust yet here (HI-1870), the one the row names first.
  const setUp = async (id: string, provider: ProviderId): Promise<void> => {
    const first = view?.connections.find((a) => a.id === id)?.trust?.pending[0]
    const key = await setUpConnection(id)
    if (key) setTerminal({ id, key, ended: false, provider, setUp: true, ...(first ? { in: first } : {}) })
  }
  const rename = async (id: string, current: string, title = tr(M.renameTitle, { name: current })): Promise<void> => {
    const name = await prompt({ title, fieldLabel: tr(M.name), initial: current, confirmLabel: tr(M.renameConfirm), validate: (v) => (v.trim() ? null : tr(M.needName)) })
    if (name && name.trim() !== current) await act(M.changeFailed, () => call('connections:rename', id, name))
  }
  // Its sign-in or Set Up terminal open (in any window: HI-1870), Remove offers to close it first; agents on it still refuse.
  const remove = async (id: string, name: string, open: boolean): Promise<void> => {
    const run = async (): Promise<void> => {
      await call('connections:remove', id, open ? { closeTerminal: true } : undefined)
      setTerminal((t) => (t?.id === id ? null : t))
    }
    await confirm({ title: tr(open ? M.removeOpenTitle : M.removeTitle, { name }), message: tr(M.removeMessage), confirmLabel: tr(open ? M.removeOpenConfirm : M.removeConfirm), busyLabel: tr(M.removing), danger: true, run }).catch((e) => notify('error', tr(M.removeFailed), errorMessage(e)))
  }
  // Close is always there (HI-1870): while the CLI still runs it asks, then ends it (its console's processes with it).
  const close = async (): Promise<void> => {
    const t = terminal
    if (!t) return
    if (!t.ended) {
      const cli = providerDescriptor(t.provider).name
      const ok = await confirm({ title: tr(M.closeRunningTitle), message: tr(M.closeRunningMessage, { cli }), confirmLabel: tr(M.closeRunningConfirm), danger: true })
      if (!ok) return
      await call('pty:kill', t.key).catch(() => undefined)
    }
    setTerminal((x) => (x?.key === t.key ? null : x))
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
      {view.providers.length > 0 && (
        <div className="accounts-provider">
          {shown.length === 0 && <div className="faint">{tr(M.none)}</div>}
          {shown.map((a) => {
            const ws = view.workspace[a.provider]
            const server = a.kind === 'server'
            const state = accountState(a)
            const on = !!ws?.on.includes(a.id)
            // The top of its CLI's order wears Default (a hint, Hive-wide); the one new agents use here, when the
            // Default is off here, wears Used here (HI-1875).
            const place = placeOf(a)
            const top = place === 0
            const usedHere = !top && !!wsPath && ws?.default === a.id
            const o = a.observed
            const ident = o?.email ? (o.plan ? tr(M.plan, { email: o.email, plan: o.plan }) : o.email) : a.accepted?.email
            const same = dups.get(a.id)
            // Set up (HI-1870): its CLI's first-run setup and, on here, this workspace's folders trusted; once signed in (or a server's).
            const ready = !a.leftover && (server || state === 'signedIn') ? connectionReadiness(a) : null
            const needsSetUp = ready === 'needed'
            const pending = a.trust?.pending ?? []
            const setUpState = needsSetUp ? (
              <span className="account-setup-state needed" data-set-up-state="needed"><Icon name="warning" /> {tr(M.setUpNeeded)}</span>
            ) : ready === 'unknown' && a.trust?.checking ? (
              <span className="account-setup-state checking muted" data-set-up-state="checking"><Icon name="loading" /> {tr(M.setUpChecking)}</span>
            ) : ready === 'done' ? (
              <span className="account-setup-state done" data-set-up-state="done"><Icon name="pass-filled" /> {tr(M.setUpDone)}</span>
            ) : null
            return (
              <div
                key={a.id}
                className={cx('account-row', dragging?.id === a.id && 'dragging', dropAt === a.id && 'drop-target')}
                data-account={a.id}
                data-cli={a.provider}
                data-state={server ? 'server' : state}
                data-order={place + 1}
                onDragOver={(e) => {
                  // Only within its own CLI's order.
                  if (!dragging || dragging.provider !== a.provider) return
                  e.preventDefault()
                  setDropAt(a.id)
                }}
                onDragLeave={() => setDropAt((x) => (x === a.id ? null : x))}
                onDrop={(e) => {
                  e.preventDefault()
                  setDropAt(null)
                  if (dragging && dragging.provider === a.provider && dragging.id !== a.id) void move(dragging.id, place)
                  setDragging(null)
                }}
              >
                <button
                  className="account-handle"
                  draggable
                  title={tr(M.move, { name: a.name })}
                  aria-label={tr(M.move, { name: a.name })}
                  data-move-handle
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', a.id)
                    setDragging({ id: a.id, provider: a.provider })
                  }}
                  onDragEnd={() => {
                    setDragging(null)
                    setDropAt(null)
                  }}
                  onKeyDown={(e) => {
                    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
                    e.preventDefault()
                    void move(a.id, place + (e.key === 'ArrowUp' ? -1 : 1))
                  }}
                >
                  <Icon name="gripper" />
                </button>
                <div className="account-main">
                  <div className="account-name">
                    {a.name}
                    <span className="account-cli muted">
                      <ProviderIcon provider={a.provider} /> {providerDescriptor(a.provider).name}
                    </span>
                    {top && <span className="account-default" data-default-hint>{tr(M.default)}</span>}
                    {usedHere && <span className="account-used-here" data-used-here title={tr(M.usedHereTip)}>{tr(M.usedHere)}</span>}
                  </div>
                  {server ? (
                    <>
                      <ServerConnectionDetail c={a} keyLast4={a.key?.last4} needsSetUp={needsSetUp} onSetUp={(id) => void setUp(id, a.provider)} />
                      {setUpState && <div className="account-state">{setUpState}</div>}
                    </>
                  ) : (
                    <>
                      <div className="account-ident muted">{ident}</div>
                      <div className={`account-state state-${state}`} title={o?.at ? tr(M.checkedAt, { when: timeAgo(o.at) }) : undefined}>
                        <Icon name={STATE_ICON[state]} /> {tr(STATE[state])}
                        {setUpState && <span className="muted">·</span>}
                        {setUpState}
                        {a.signingIn && terminal?.id !== a.id && <span className="muted"> · {tr(M.signingInElsewhere)}</span>}
                      </div>
                    </>
                  )}
                  {needsSetUp && <div className="account-setup-note hint" data-set-up-note>{setUpHint(a.provider)}</div>}
                  {needsSetUp && pending.length > 0 && <div className="account-setup-note hint" data-not-trusted>{tr(M.notTrusted, { projects: fmt.list([...pending.slice(0, 3).map((x) => x.project), ...(pending.length > 3 ? [tr(M.moreProjects, { n: pending.length - 3 })] : [])]) })}</div>}
                  {state === 'changed' && a.accepted && o?.email && <div className="account-warning" data-warning="changed"><Icon name="warning" /> {tr(M.changedTo, { now: o.email, was: a.accepted.email })}</div>}
                  {same && <div className="account-warning" data-warning="duplicate"><Icon name="warning" /> {tr(M.sameLogin, { names: fmt.list(same.map(nameOf)) })}</div>}
                  {a.leftover && <div className="account-warning" data-warning="leftover"><Icon name="warning" /> {tr(M.leftover, { what: a.leftover })}</div>}
                  <ConnectionDefaultsEditor connection={a} />
                </div>
                <div className="account-actions">
                  <Switch checked={on} disabled={!wsPath || !!a.leftover} label={tr(M.onHere)} onChange={(v) => void act(M.changeFailed, () => call('connections:setOn', a.id, v))} />
                  {/* To the top of the order (HI-1875): never on or off, so it needs no workspace. */}
                  {!top && <button className="btn subtle" data-make-default disabled={!!a.leftover} onClick={() => void move(a.id, 0)}>{tr(M.makeDefault)}</button>}
                  {!server && state === 'changed' && <button className="btn subtle" onClick={() => void keep(a.id, a.name, o?.email)}>{tr(M.keep)}</button>}
                  {!server && !a.leftover && <button className="btn" onClick={() => void signIn(a.id, a.provider)}>{tr(state === 'signedOut' || state === 'changed' ? M.signInAgain : M.signIn)}</button>}
                  {/* Its first-run screens, which a browser sign-in leaves unanswered (HI-1826). */}
                  {!server && !a.leftover && state === 'signedIn' && <button className={needsSetUp ? 'btn primary' : 'btn subtle'} data-set-up onClick={() => void setUp(a.id, a.provider)}>{setUpLabel()}</button>}
                  <button className="btn subtle" disabled={!!a.leftover} onClick={() => void rename(a.id, a.name)}>{tr(M.rename)}</button>
                  <button className="btn subtle" onClick={() => void remove(a.id, a.name, a.signingIn || terminal?.id === a.id)}>{tr(M.remove)}</button>
                </div>
              </div>
            )
          })}
          <button className="btn" data-add onClick={() => setAdding(true)}>
            <Icon name="add" /> {tr(M.add)}
          </button>
        </div>
      )}
      {/* A CLI on without connections (Copilot: HI-1758) launches on its own login, shared by the whole PC. */}
      {withoutConnections.map((p) => (
        <p key={p.id} className="hint" data-no-connections={p.id}>
          {tr(M.ownLogin, { cli: p.name })}
        </p>
      ))}
      {adding && <AddConnectionDialog clis={view.providers} onClose={() => setAdding(false)} onSignIn={(id, cli) => void signIn(id, cli)} />}
      {terminal && (
        <div className="account-signin">
          <p className="hint">{terminal.setUp ? setUpHint(terminal.provider) : tr(M.signingIn)}</p>
          {terminal.in && <p className="hint" data-set-up-in>{tr(M.setUpIn, { project: terminal.in.project, folder: terminal.in.folder, cli: providerDescriptor(terminal.provider).name })}</p>}
          <div className="task-terminal">
            <TerminalView ptyKey={terminal.key} visible onExit={() => setTerminal((t) => (t?.key === terminal.key ? { ...t, ended: true } : t))} />
          </div>
          <div className="flex">
            {/* Set Up after Sign In (HI-1826): the CLI's first-run screens, answered once here rather than in an agent's pane. */}
            {terminal.ended && !terminal.setUp && signedInAfter && <button className="btn primary" data-set-up-after onClick={() => void setUp(signedInAfter.id, signedInAfter.provider)}>{setUpLabel()}</button>}
            <button className="btn" data-close-terminal onClick={() => void close()}>{tr(M.close)}</button>
          </div>
        </div>
      )}
    </div>
  )
}
