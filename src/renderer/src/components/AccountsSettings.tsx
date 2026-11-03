import { ConnectionDialog, MovedNoticeBanner, connectionSummary, connectionUsers, effortUnusableText } from './ConnectionDefaults'
import { useCallback, useEffect, useState } from 'react'
import type { Account, PlanLimit, ProviderId } from '@shared/types'
import { accountState, connectionReadiness, duplicateLogins, type AccountView, type ConnectionRow, type ConnectionsView, type ConnectionState } from '@shared/accounts'
import { COPILOT_ACCOUNT } from '@shared/connectionDefaults'
import { connectionOf } from '@shared/connectionLabel'
import { isProviderEnabled, providerDescriptor } from '@shared/providers'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { confirm, notify, prompt, set, useStore } from '../store'
import { Icon, IconButton, Switch, useContextMenu, type MenuEntry } from './ui'
import { cx, timeAgo } from '../util'
import { TerminalView } from './TerminalView'
import { ProviderIcon } from './ProviderIcon'
import { UsageMoveRuleRow } from './UsageMoveRule'
import { AddConnectionDialog, MaskingBanner, ServerConnectionDetail, setUpConnection, setUpHint, setUpLabel } from './ServerConnections'

/**
 * Settings → Accounts & Connections (HI-980; HI-2107, HI-2105's design). Accounts: Hive's sign-ins, each a CLI login in
 * a folder of its own signed in through the CLI's own sign-in (nothing typed into it), servers it reaches, and
 * Copilot's one sign-in for the PC; in one order for every CLI (decision A), each on or off in this window's workspace.
 * Under each, its connections: the setups agents and the Assistant choose, each with who uses it.
 */

const M = {
  none: msg({ id: 'settings.accounts.noneYet', defaultMessage: 'No accounts yet. Add one, then sign it in.', description: 'Settings → Accounts & Connections when there are no accounts (HI-2107).' }),
  noWorkspace: msg({ id: 'settings.accounts.noWorkspace2', defaultMessage: 'Open a workspace to choose which accounts are on in it.', description: 'Settings → Accounts & Connections with no workspace open: whether an account is on is per workspace (HI-2107).' }),
  loading: msg({ id: 'settings.accounts.loading', defaultMessage: 'Loading…', description: 'Settings → Accounts & Connections while its list loads.' }),
  add: msg({ id: 'settings.accounts.addAccount', defaultMessage: 'Add Account…', description: 'Button in Settings → Accounts & Connections (HI-2107): adds an account (asks which coding agent CLI, its name and where it gets its model), then opens its sign-in or sets up its server. It comes with its first connection.' }),
  addConnection: msg({ id: 'settings.accounts.addConnection', defaultMessage: 'Add Connection', description: "Button under an account's connections (Settings → Accounts & Connections, HI-2107): adds a connection on it (a dialog)." }),
  name: msg({ id: 'settings.accounts.name', defaultMessage: 'Name', description: "The label of the box for a connection's name (Settings → Accounts & Connections)." }),
  needName: msg({ id: 'settings.accounts.needName', defaultMessage: 'Give it a name.', description: "Under the name box of a connection (Settings → Accounts & Connections) while it's empty." }),
  rename: msg({ id: 'settings.accounts.rename', defaultMessage: 'Rename…', description: 'Button on a connection (Settings → Accounts & Connections): changes its name only.' }),
  renameTitle: msg({ id: 'settings.accounts.renameTitle', defaultMessage: 'Rename {name}', description: "Title of the dialog renaming a connection ({name}, its name)." }),
  renameConfirm: msg({ id: 'settings.accounts.renameConfirm', defaultMessage: 'Rename', description: 'The confirm button of the dialog renaming a connection.' }),
  signIn: msg({ id: 'settings.accounts.signIn', defaultMessage: 'Sign In', description: "Button on a connection (Settings → Accounts & Connections): opens the CLI's own sign-in for it, in a terminal of Hive's." }),
  signInAgain: msg({ id: 'settings.accounts.signInAgain', defaultMessage: 'Sign In Again', description: "Button on a connection (Settings → Accounts & Connections) that is signed out, or whose login changed: opens the CLI's own sign-in for it again." }),
  signingIn: msg({ id: 'settings.accounts.signingIn', defaultMessage: "Signing in: finish in your browser, or in the terminal below. Combwork doesn't type into it.", description: "Settings → Accounts & Connections while a connection's sign-in terminal is open: the user signs in through the CLI's own flow." }),
  signingInElsewhere: msg({ id: 'settings.accounts.signingInElsewhere', defaultMessage: 'Signing in, in another window', description: "A connection's line in Settings → Accounts & Connections while its sign-in is open in another of Hive's windows." }),
  signInFailed: msg({ id: 'settings.accounts.signInFailed', defaultMessage: "Couldn't open the sign-in", description: "An error's title: a connection's sign-in terminal couldn't be opened." }),
  close: msg({ id: 'settings.accounts.closeTerminal', defaultMessage: 'Close', description: "Button under a connection's sign-in or Set Up terminal (Settings → Accounts & Connections): hides it, ending the CLI in it if it still runs (asks first then)." }),
  closeRunningTitle: msg({ id: 'settings.accounts.closeRunningTitle', defaultMessage: 'Close the terminal?', description: "Title of the dialog asked by Close under a connection's sign-in or Set Up terminal while the CLI in it still runs (Settings → Accounts & Connections)." }),
  closeRunningMessage: msg({ id: 'settings.accounts.closeRunningMessage', defaultMessage: '{cli} is still running in it. Closing the terminal ends it.', description: "The message of that dialog ({cli}: the coding agent CLI, \"Codex\"): closing ends the CLI and what it started." }),
  closeRunningConfirm: msg({ id: 'settings.accounts.closeRunningConfirm', defaultMessage: 'Close Terminal', description: "The confirm button of that dialog: ends the CLI and hides its terminal." }),
  keep: msg({ id: 'settings.accounts.keep', defaultMessage: 'Keep the New Login', description: 'Button on a connection whose login changed (Settings → Accounts & Connections): takes on the login it is now signed in as.' }),
  keepRename: msg({ id: 'settings.accounts.keepRename', defaultMessage: 'Kept. Rename {name} to match?', description: 'After Keep the New Login on a connection ({name}): offers to rename it, since it is now another login.' }),
  keepFailed: msg({ id: 'settings.accounts.keepFailed', defaultMessage: "Couldn't keep the new login", description: "An error's title: Keep the New Login failed." }),
  remove: msg({ id: 'settings.accounts.remove', defaultMessage: 'Remove…', description: 'Button on a connection (Settings → Accounts & Connections): removes it and deletes its folder (asks first).' }),
  removeTitle: msg({ id: 'settings.accounts.removeTitle', defaultMessage: 'Remove {name}?', description: "Title of the dialog confirming a connection's removal ({name}, its name)." }),
  removeMessage: msg({ id: 'settings.accounts.removeAccountMessage', defaultMessage: "Its folder is deleted for good, with its login on this PC (it doesn't go to the Recycle Bin), and its connections with it. Your conversations and the CLI's memory are kept: they are shared with your other accounts. The account itself stays yours with its provider.", description: "The message of the dialog confirming an account's removal (Settings → Accounts & Connections, HI-2107)." }),
  removeConfirm: msg({ id: 'settings.accounts.removeConfirm', defaultMessage: 'Remove', description: "The confirm button of the dialog removing a connection." }),
  removeOpenTitle: msg({ id: 'settings.accounts.removeOpenTitle', defaultMessage: 'Close its terminal and remove {name}?', description: "Title of the dialog confirming a connection's removal ({name}, its name) while its sign-in or Set Up terminal is open: the terminal is closed first, ending the CLI in it." }),
  removeOpenConfirm: msg({ id: 'settings.accounts.removeOpenConfirm', defaultMessage: 'Close Terminal and Remove', description: "The confirm button of that dialog." }),
  removing: msg({ id: 'settings.accounts.removing', defaultMessage: 'Removing…', description: 'The confirm button of the dialog removing a connection, while it removes it.' }),
  onHere: msg({ id: 'settings.accounts.onHereShort', defaultMessage: 'On here', description: 'The switch on an account (Settings → Accounts & Connections, HI-2107): whether it is on in the open workspace. Keep it short.' }),
  onHereTip: msg({ id: 'settings.accounts.onHere', defaultMessage: 'On in this workspace', description: 'The switch on a connection (Settings → Accounts & Connections): whether it is on in the open workspace.' }),
  thisPc: msg({ id: 'settings.accounts.thisPc', defaultMessage: 'Signed in for this PC', description: "On GitHub Copilot's account (Settings → Accounts & Connections, HI-2107): its one sign-in is the PC's, used in every workspace." }),
  copilotAs: msg({ id: 'settings.accounts.copilotAs', defaultMessage: 'Signed in: {account}', description: "GitHub Copilot's account (HI-2107): who its PC-wide sign-in is ({account}, a GitHub user name)." }),
  copilotNotSignedIn: msg({ id: 'settings.accounts.copilotNotSignedIn', defaultMessage: 'Not signed in: sign in from Provider Setup', description: "GitHub Copilot's account when it isn't signed in (HI-2107). Provider Setup names a dialog." }),
  providerSetup: msg({ id: 'settings.accounts.providerSetup', defaultMessage: 'Open Provider Setup', description: "The only entry of GitHub Copilot's account's ⋯ menu (HI-2107): opens the Provider Setup dialog, where its sign-in is." }),
  more: msg({ id: 'settings.accounts.more', defaultMessage: 'More for {name}', description: "The ⋯ button of an account or a connection (Settings → Accounts & Connections), for screen readers and its tooltip ({name}, its name)." }),
  move: msg({ id: 'settings.accounts.moveAccount', defaultMessage: 'Drag to change the order of {name}, or press Alt+Up or Alt+Down', description: "The tooltip and label of an account's drag handle (Settings → Accounts & Connections, HI-2107): it moves the account in the one order of accounts. Alt+Up and Alt+Down name keys." }),
  moveFailed: msg({ id: 'settings.accounts.moveFailed', defaultMessage: "Couldn't change the order", description: "An error's title: moving a connection in its coding agent CLI's order failed (Settings → Accounts & Connections)." }),
  changeFailed: msg({ id: 'settings.accounts.changeFailed', defaultMessage: "Couldn't change the connection", description: "An error's title: renaming a connection, turning it on or off, or making it the default failed." }),
  removeFailed: msg({ id: 'settings.accounts.removeFailed', defaultMessage: "Couldn't remove the connection", description: "An error's title: removing a connection failed." }),
  sameLogin: msg({ id: 'settings.accounts.sameLoginAccount', defaultMessage: 'Signed in to the same login as another account: {names}', description: 'A warning on an account (Settings → Accounts & Connections, HI-2107): other accounts are signed in as the same login. {names} is their names, listed.' }),
  leftover: msg({ id: 'settings.accounts.leftover', defaultMessage: "Not all removed: {what}. Remove tries again; nothing outside its folder was touched.", description: "A warning on a connection (Settings → Accounts & Connections) whose removal stopped partway. {what} is what's left, in English." }),
  plan: msg({ id: 'settings.accounts.plan', defaultMessage: '{email} · {plan}', description: "A connection's identity in Settings → Accounts & Connections: the email it is signed in as, and its plan as the CLI names it (\"max\")." }),
  changedTo: msg({ id: 'settings.accounts.changedTo', defaultMessage: 'Now signed in as {now}, was {was}', description: 'A warning on a connection (Settings → Accounts & Connections): its login changed (a /login typed in a pane). {now} and {was} are emails.' }),
  usage: msg({ id: 'settings.accounts.usage', defaultMessage: '{window, select, fiveHour {5-hour} weekly {weekly} other {{label}}} {used, number, percent}', description: "An account's plan usage in Settings → Accounts & Connections (HI-2107), once per account: a limit's window (the 5-hour one, the weekly one, or the provider's own name for another) and how much of it is used." }),
  affected: msg({ id: 'settings.accounts.affected', defaultMessage: '{n, plural, one {# running agent runs on another connection than the one chosen for it now.} other {# running agents run on another connection than the one chosen for them now.}}', description: 'Banner in Settings → Accounts & Connections after a connection was turned off or the default changed (HI-1755): how many running agents are on a connection other than the one chosen now.' }),
  switchAffected: msg({ id: 'settings.accounts.switchAffected', defaultMessage: 'Switch Them When Their Turn Is Over', description: 'Button on that banner: each of those agents ends once its turn is over and carries on, on the connection chosen now.' }),
  notTrusted: msg({ id: 'settings.accounts.notTrusted', defaultMessage: 'Not trusted yet in this workspace: {projects}', description: "Under a connection that needs set up (Settings → Accounts & Connections, HI-1870): the projects of the open workspace whose folders its coding agent CLI hasn't been told to trust yet ({projects}: their names, listed). Set Up asks the CLI's trust question for each in turn." }),
  moreProjects: msg({ id: 'settings.accounts.moreProjects', defaultMessage: '{n, plural, one {# more} other {# more}}', description: 'The last item of that list when it names only the first projects: how many more there are.' }),
  setUpIn: msg({ id: 'settings.accounts.setUpIn', defaultMessage: "It opens in {project}'s folder, {folder}: answer {cli}'s question to trust it.", description: "Above a connection's Set Up terminal when it opens in a project's folder its coding agent CLI ({cli}) doesn't trust yet (HI-1870): {project} is the project's name, {folder} the folder." }),
  setUpInWorkspace: msg({ id: 'settings.accounts.setUpInWorkspace', defaultMessage: "It opens in this workspace's folder, {folder}: answer {cli}'s question to trust it, and every project in it with it.", description: "Above a connection's Set Up terminal when it opens in the open workspace's folder (HI-1871): the coding agent CLI ({cli}) asks once whether to trust that folder, and trusting it covers every project inside it. {folder} is the folder." }),
  setUpChecking: msg({ id: 'settings.accounts.setUpChecking', defaultMessage: 'Checking…', description: "A connection's state (Settings → Accounts & Connections, HI-1870): Hive is still reading whether its coding agent CLI trusts the open workspace's project folders, so it doesn't say yet whether it is set up." }),
  setUpNeeded: msg({ id: 'settings.accounts.setUpNeeded', defaultMessage: 'Needs set up', description: "A connection's state (Settings → Accounts & Connections, HI-1870): its CLI's one-time first-run setup (Set Up, a button beside it) hasn't been done in its folder yet." }),
  setUpDone: msg({ id: 'settings.accounts.setUpDone', defaultMessage: 'Set up', description: "A connection's state (Settings → Accounts & Connections, HI-1870): its CLI's one-time first-run setup is done. An adjective (\"is set up\"), not the button." }),
  checkedAt: msg({ id: 'settings.accounts.checkedAt', defaultMessage: 'Checked {when}', description: "The tooltip of a connection's state (Settings → Accounts & Connections): when it was last checked. {when} is how long ago (\"5 min ago\")." }),
  // A connection's row (HI-2107).
  usedBy: msg({ id: 'settings.accounts.usedBy', defaultMessage: '{assistant, select, yes {{n, plural, =0 {Assistant} one {Assistant and # agent} other {Assistant and # agents}}} other {{n, plural, =0 {Not used here} one {# agent} other {# agents}}}}', description: "Who uses a connection, on its row (Settings → Accounts & Connections, HI-2107): the Assistant (assistant is yes) and how many agents ({n}) of the open workspaces. Its tooltip names them. \"Not used here\": none in the open workspaces." }),
  edit: msg({ id: 'settings.accounts.connection.edit', defaultMessage: 'Edit…', description: "An entry of a connection's ⋯ menu (Settings → Accounts & Connections, HI-2107): opens its dialog." }),
  duplicate: msg({ id: 'settings.accounts.connection.duplicate', defaultMessage: 'Duplicate', description: "An entry of a connection's ⋯ menu: adds a copy of it, named \"<name> (2)\"." }),
  removeConnection: msg({ id: 'settings.accounts.connection.remove', defaultMessage: 'Remove…', description: "An entry of a connection's ⋯ menu: removes it (asks first; refused while something uses it)." }),
  removeConnectionTitle: msg({ id: 'settings.accounts.connection.removeTitle', defaultMessage: 'Remove the connection {name}?', description: "Title of the dialog confirming a connection's removal ({name}, its name; HI-2107)." }),
  removeConnectionMessage: msg({ id: 'settings.accounts.connection.removeMessage', defaultMessage: 'Only this setup goes: its account and its other connections stay.', description: "The message of the dialog confirming a connection's removal (HI-2107)." }),
  connectionFailed: msg({ id: 'settings.accounts.connection.failed', defaultMessage: "Couldn't change the connection", description: "An error's title: duplicating or removing a connection failed (Settings → Accounts & Connections, HI-2107)." }),
  base: msg({ id: 'settings.accounts.connection.base', defaultMessage: 'First', description: "A mark on an account's first connection (HI-2107): the one a new agent on that account gets first. Keep it short." }),
  baseTip: msg({ id: 'settings.accounts.connection.baseTip', defaultMessage: 'The first of its account: what a new agent gets when this account is first in the order and on here.', description: 'The tooltip of "First" on a connection (HI-2107).' })
}

const STATE: Record<ConnectionState, ReturnType<typeof msg>> = {
  signedIn: msg({ id: 'settings.accounts.state.signedIn', defaultMessage: 'Signed in', description: "A connection's state (Settings → Accounts & Connections)." }),
  signedOut: msg({ id: 'settings.accounts.state.signedOut', defaultMessage: 'Signed out', description: "A connection's state (Settings → Accounts & Connections): the CLI says its folder isn't signed in." }),
  changed: msg({ id: 'settings.accounts.state.changed', defaultMessage: 'Login changed', description: "A connection's state (Settings → Accounts & Connections): signed in as another login than the one it was added with." }),
  failed: msg({ id: 'settings.accounts.state.failed', defaultMessage: "Couldn't check", description: "A connection's state (Settings → Accounts & Connections): Hive couldn't ask the CLI who it's signed in as (not the same as signed out)." }),
  missing: msg({ id: 'settings.accounts.state.missing', defaultMessage: 'Folder missing', description: "A connection's state (Settings → Accounts & Connections): its folder isn't there, or isn't the one Hive made." }),
  unchecked: msg({ id: 'settings.accounts.state.unchecked', defaultMessage: 'Not checked yet', description: "A connection's state (Settings → Accounts & Connections): Hive hasn't asked the CLI yet." })
}
const STATE_ICON: Record<ConnectionState, string> = { signedIn: 'pass-filled', signedOut: 'circle-slash', changed: 'warning', failed: 'question', missing: 'warning', unchecked: 'circle-outline' }

/** An account's plan limits that haven't reset yet, in a line ("5-hour 42% · weekly 18%"); empty with none. */
function usageLine(limits: readonly PlanLimit[] | undefined): string {
  const now = Date.now()
  const current = (limits ?? []).filter((l) => !l.resetsAt || Date.parse(l.resetsAt) > now)
  const windowOf = (l: PlanLimit): string => (l.windowMinutes === 300 ? 'fiveHour' : l.windowMinutes === 7 * 24 * 60 ? 'weekly' : 'other')
  return current.map((l) => tr(M.usage, { window: windowOf(l), label: l.label, used: l.usedPercent / 100 })).join(' · ')
}

type Terminal = { id: string; key: string; ended: boolean; provider: ProviderId; setUp?: boolean; in?: { folder: string; project?: string; workspace?: true } }

export function AccountsSettings() {
  const changed = useStore((s) => s.connectionsChanged)
  const wsPath = useStore((s) => s.workspace?.path ?? null)
  const projects = useStore((s) => s.workspace?.projects)
  const settings = useStore((s) => s.settings)
  const usage = useStore((s) => s.connectionPlanUsage)
  const copilotInfo = useStore((s) => s.providers.copilot)
  const menu = useContextMenu()
  const [view, setView] = useState<ConnectionsView | null>(null)
  const [terminal, setTerminal] = useState<Terminal | null>(null)
  // Add Account's dialog (HI-1772), which asks its CLI first (HI-1870).
  const [adding, setAdding] = useState(false)
  // The connection dialog (HI-2107): on an account, a connection given to edit.
  const [dialog, setDialog] = useState<{ account: string; connection?: string } | null>(null)
  // An account being dragged to another place in the one order (HI-2107), and the row it would drop on.
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  const load = useCallback((check: boolean) => {
    call('connections:list', check)
      .then(setView)
      .catch(() => undefined)
  }, [])
  // Each account checked again as the section is shown; read again whenever main says they changed.
  useEffect(() => load(true), [load, wsPath])
  useEffect(() => load(false), [load, changed])
  // The workspace's projects changed (one added, moved), or which agent runs on which connection: the projects each
  // account would be used in, and so its trust of them, are read again (HI-1870; HI-1871), and who uses each connection.
  const projectsKey = (projects ?? []).map((p) => `${p.path}:${p.agents.map((a) => `${a.id}=${a.provider ?? ''}/${a.connection ?? ''}`).join(',')}`).join('|')
  const assistantKey = useStore((s) => (s.workspace?.assistant?.agents ?? []).map((a) => `${a.provider ?? ''}/${a.connection ?? ''}`).join(','))
  useEffect(() => load(false), [load, projectsKey, assistantKey])

  if (!view) return <div className="faint">{tr(M.loading)}</div>
  // Agents running on a connection other than the one chosen for them now (HI-1755), not yet waiting to switch: by
  // connection, as the switch and the window's ⟳ mark judge it (HI-2413: another on the same account too), not by any
  // restart its settings ask for, which the button wouldn't make.
  const affected = (projects ?? []).flatMap((p) => p.agents).filter((a) => a.live?.launchedConnection && !a.live.switchPending && connectionOf(a.connection, a.live.provider, a.live.launchedConnection, view)?.other).length
  const dups = duplicateLogins(view.connections)
  const nameOf = (id: string): string => view.connections.find((a) => a.id === id)?.name ?? id
  // One list in the one order (decision A): Hive's accounts of the CLIs turned on, and Copilot's sign-in while it is on.
  const byId = new Map<string, AccountView | Account>([...view.connections, ...view.homes].map((a) => [a.id, a]))
  const shown = view.order.map((id) => byId.get(id)).filter((a): a is AccountView | Account => !!a && (a.home ? a.id === COPILOT_ACCOUNT && isProviderEnabled(settings, a.provider) : view.providers.includes(a.provider)))
  // Its place in the one order, every account counted (those hidden here too): what a move names.
  const placeOf = (id: string): number => view.order.indexOf(id)
  const move = (id: string, index: number): Promise<void> => act(M.moveFailed, () => call('connections:move', id, Math.max(0, index)))
  // The account an ended sign-in terminal signed in, offered its Set Up (HI-1826).
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
  // Main opens it where the CLI's trust question covers the most (HI-1870, HI-1871), read as it opens: the hint names
  // the place it says it used, never the one this window last showed (HI-1871 round 1).
  const setUp = async (id: string, provider: ProviderId): Promise<void> => {
    const opened = await setUpConnection(id)
    if (opened) setTerminal({ id, key: opened.key, ended: false, provider, setUp: true, ...(opened.in ? { in: opened.in } : {}) })
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
  const removeConnection = async (c: ConnectionRow): Promise<void> => {
    await confirm({ title: tr(M.removeConnectionTitle, { name: c.name }), message: tr(M.removeConnectionMessage), confirmLabel: tr(M.removeConfirm), busyLabel: tr(M.removing), danger: true, run: () => call('connection:remove', c.id) }).catch((e) => notify('error', tr(M.connectionFailed), errorMessage(e)))
  }
  const openMenu = (e: React.MouseEvent, items: MenuEntry[]): void => {
    const r = e.currentTarget.getBoundingClientRect()
    menu.openAt(r.left, r.bottom + 2, items, e.detail === 0)
  }

  /** An account's connections, each with its summary, who uses it and its ⋯ (Edit, Duplicate, Remove). */
  const connections = (a: AccountView | Account) => {
    const rows = view.connectionRows.filter((r) => r.account === a.id)
    return (
      <div className="connection-list" data-connections-of={a.id}>
        {rows.map((c, i) => {
          const assistant = c.users.some((u) => u.assistant)
          const agents = c.users.filter((u) => !u.assistant).length
          return (
            <div key={c.id} className="connection-row" data-connection={c.id} data-users={c.users.length}>
              <span className="connection-name">
                {c.name}
                {i === 0 && rows.length > 1 && <span className="connection-base" title={tr(M.baseTip)}>{tr(M.base)}</span>}
              </span>
              <span className="connection-summary muted" data-summary>
                {connectionSummary(c, a, settings)}
                {c.effortUnusable && (
                  <span className="connection-warning" data-effort-unusable title={effortUnusableText(c, a.provider, settings)}>
                    <Icon name="warning" />
                  </span>
                )}
              </span>
              <span className={cx('connection-users', c.users.length ? 'muted' : 'faint')} data-used-by title={c.users.length ? connectionUsers(c) : undefined}>
                {tr(M.usedBy, { assistant: assistant ? 'yes' : 'no', n: agents })}
              </span>
              <IconButton
                icon="ellipsis"
                title={tr(M.more, { name: c.name })}
                action="connection-menu"
                onClick={(e) =>
                  openMenu(e, [
                    { label: tr(M.edit), icon: 'edit', onClick: () => setDialog({ account: a.id, connection: c.id }) },
                    { label: tr(M.duplicate), icon: 'copy', onClick: () => void act(M.connectionFailed, () => call('connection:duplicate', c.id)) },
                    { separator: true },
                    { label: tr(M.removeConnection), icon: 'trash', danger: true, onClick: () => void removeConnection(c) }
                  ])
                }
              />
            </div>
          )
        })}
        <button className="btn subtle small connection-add" data-new-connection={a.id} disabled={!!(a as AccountView).leftover} onClick={() => setDialog({ account: a.id })}>
          <Icon name="add" /> {tr(M.addConnection)}
        </button>
      </div>
    )
  }

  /** GitHub Copilot's one sign-in for the PC (decision C): no folder, sign-in or removal of Hive's; its ⋯ opens Provider Setup. */
  const copilotRow = (a: Account) => {
    const who = copilotInfo?.account
    return (
      <div key={a.id} className="account-block" data-account={a.id} data-cli={a.provider} data-home>
        <div className={cx('account-row', dragging === a.id && 'dragging', dropAt === a.id && 'drop-target')} {...dropProps(a.id)}>
          {handle(a)}
          <div className="account-main">
            <div className="account-name">
              {a.name}
              <span className="account-cli muted">
                <ProviderIcon provider={a.provider} /> {providerDescriptor(a.provider).name}
              </span>
            </div>
            <div className="account-ident muted" data-copilot-identity>
              {who ? tr(M.copilotAs, { account: who }) : copilotInfo?.loggedIn === false ? tr(M.copilotNotSignedIn) : null}
            </div>
          </div>
          <div className="account-actions">
            <span className="muted small">{tr(M.thisPc)}</span>
            <IconButton icon="ellipsis" title={tr(M.more, { name: a.name })} action="account-menu" onClick={(e) => openMenu(e, [{ label: tr(M.providerSetup), icon: 'gear', onClick: () => set({ setupOpen: a.provider }) }])} />
          </div>
        </div>
        {connections(a)}
      </div>
    )
  }

  // Dropped on: the dragged account takes this one's place in the one order.
  const dropProps = (id: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragging) return
      e.preventDefault()
      setDropAt(id)
    },
    onDragLeave: () => setDropAt((x) => (x === id ? null : x)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDropAt(null)
      if (dragging && dragging !== id) void move(dragging, placeOf(id))
      setDragging(null)
    }
  })
  // The drag handle; Alt+Up and Alt+Down move it one place among those shown.
  const handle = (a: AccountView | Account) => {
    const at = shown.findIndex((x) => x.id === a.id)
    return (
      <button
        className="account-handle"
        draggable
        title={tr(M.move, { name: a.name })}
        aria-label={tr(M.move, { name: a.name })}
        data-move-handle
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', a.id)
          setDragging(a.id)
        }}
        onDragEnd={() => {
          setDragging(null)
          setDropAt(null)
        }}
        onKeyDown={(e) => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
          e.preventDefault()
          const to = shown[at + (e.key === 'ArrowUp' ? -1 : 1)]
          if (to) void move(a.id, placeOf(to.id))
        }}
      >
        <Icon name="gripper" />
      </button>
    )
  }

  return (
    <div className="accounts-settings">
      {menu.element}
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
      <div className="accounts-provider">
        {shown.length === 0 && <div className="faint">{tr(M.none)}</div>}
        {shown.map((x, place) => {
          if (x.home) return copilotRow(x)
          const a = x as AccountView
          const ws = view.workspace[a.provider]
          const server = a.kind === 'server'
          const state = accountState(a)
          const on = !!ws?.on.includes(a.id)
          const o = a.observed
          const ident = o?.email ? (o.plan ? tr(M.plan, { email: o.email, plan: o.plan }) : o.email) : a.accepted?.email
          const used = usageLine(usage[a.id]?.limits)
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
          const signInLabel = tr(state === 'signedOut' || state === 'changed' ? M.signInAgain : M.signIn)
          const items: MenuEntry[] = [
            { label: tr(M.rename), icon: 'edit', disabled: !!a.leftover, onClick: () => void rename(a.id, a.name) },
            ...(!server && !a.leftover ? [{ label: signInLabel, icon: 'account', onClick: () => void signIn(a.id, a.provider) }] : []),
            ...(!server && !a.leftover && state === 'signedIn' ? [{ label: setUpLabel(), icon: 'tools', onClick: () => void setUp(a.id, a.provider) }] : []),
            { separator: true },
            { label: tr(M.remove), icon: 'trash', danger: true, onClick: () => void remove(a.id, a.name, a.signingIn || terminal?.id === a.id) }
          ]
          return (
            <div key={a.id} className="account-block" data-account={a.id} data-cli={a.provider} data-state={server ? 'server' : state} data-order={place + 1}>
              <div className={cx('account-row', dragging === a.id && 'dragging', dropAt === a.id && 'drop-target')} {...dropProps(a.id)}>
                {handle(a)}
                <div className="account-main">
                  <div className="account-name">
                    {a.name}
                    <span className="account-cli muted">
                      <ProviderIcon provider={a.provider} /> {providerDescriptor(a.provider).name}
                    </span>
                  </div>
                  {server ? (
                    <>
                      <ServerConnectionDetail c={a} keyLast4={a.key?.last4} needsSetUp={needsSetUp} onSetUp={(id) => void setUp(id, a.provider)} />
                      {setUpState && <div className="account-state">{setUpState}</div>}
                    </>
                  ) : (
                    <>
                      <div className="account-ident muted">
                        {ident}
                        {used && (
                          <span className="account-usage" data-usage>
                            {ident && <span className="muted"> · </span>}
                            {used}
                          </span>
                        )}
                      </div>
                      <div className={`account-state state-${state}`} title={o?.at ? tr(M.checkedAt, { when: timeAgo(o.at) }) : undefined}>
                        <Icon name={STATE_ICON[state]} /> {tr(STATE[state])}
                        {setUpState && <span className="muted">·</span>}
                        {setUpState}
                        {a.signingIn && terminal?.id !== a.id && <span className="muted"> · {tr(M.signingInElsewhere)}</span>}
                      </div>
                    </>
                  )}
                  {/* Said once: above its Set Up terminal while that is open (the Assistant, HI-1871). */}
                  {needsSetUp && !(terminal?.setUp && terminal.id === a.id) && <div className="account-setup-note hint" data-set-up-note>{setUpHint(a.provider)}</div>}
                  {needsSetUp && pending.length > 0 && <div className="account-setup-note hint" data-not-trusted>{tr(M.notTrusted, { projects: fmt.list([...pending.slice(0, 3).map((p) => p.project), ...(pending.length > 3 ? [tr(M.moreProjects, { n: pending.length - 3 })] : [])]) })}</div>}
                  {state === 'changed' && a.accepted && o?.email && <div className="account-warning" data-warning="changed"><Icon name="warning" /> {tr(M.changedTo, { now: o.email, was: a.accepted.email })}</div>}
                  {same && <div className="account-warning" data-warning="duplicate"><Icon name="warning" /> {tr(M.sameLogin, { names: fmt.list(same.map(nameOf)) })}</div>}
                  {a.leftover && <div className="account-warning" data-warning="leftover"><Icon name="warning" /> {tr(M.leftover, { what: a.leftover })}</div>}
                  {/* Its usage move (HI-2195): a sign-in's plan limits; to another account of its CLI. */}
                  {!server && !a.leftover && <UsageMoveRuleRow account={a} others={view.connections.filter((other) => other.id !== a.id && other.provider === a.provider && !other.leftover)} />}
                </div>
                <div className="account-actions">
                  {/* What it needs now stays a button; the rest is in its ⋯. */}
                  {!server && state === 'changed' && <button className="btn subtle" onClick={() => void keep(a.id, a.name, o?.email)}>{tr(M.keep)}</button>}
                  {!server && !a.leftover && (state === 'signedOut' || state === 'changed' || state === 'unchecked') && <button className="btn" data-sign-in onClick={() => void signIn(a.id, a.provider)}>{signInLabel}</button>}
                  {!server && !a.leftover && state === 'signedIn' && needsSetUp && <button className="btn primary" data-set-up onClick={() => void setUp(a.id, a.provider)}>{setUpLabel()}</button>}
                  <span className="account-on-here muted" title={tr(M.onHereTip)} data-on-here>
                    {tr(M.onHere)}
                    <Switch checked={on} disabled={!wsPath || !!a.leftover} label={tr(M.onHere)} onChange={(v) => void act(M.changeFailed, () => call('connections:setOn', a.id, v))} />
                  </span>
                  <IconButton icon="ellipsis" title={tr(M.more, { name: a.name })} action="account-menu" onClick={(e) => openMenu(e, items)} />
                </div>
              </div>
              {connections(a)}
            </div>
          )
        })}
        {view.providers.length > 0 && (
          <button className="btn" data-add onClick={() => setAdding(true)}>
            <Icon name="add" /> {tr(M.add)}
          </button>
        )}
      </div>
      {adding && <AddConnectionDialog clis={view.providers} onClose={() => setAdding(false)} onSignIn={(id, cli) => void signIn(id, cli)} />}
      {dialog && <ConnectionDialog account={dialog.account} connection={dialog.connection} onClose={() => setDialog(null)} />}
      {terminal && (
        <div className="account-signin">
          <p className="hint">{terminal.setUp ? setUpHint(terminal.provider) : tr(M.signingIn)}</p>
          {terminal.in && (
            <p className="hint" data-set-up-in>
              {terminal.in.workspace ? tr(M.setUpInWorkspace, { folder: terminal.in.folder, cli: providerDescriptor(terminal.provider).name }) : tr(M.setUpIn, { project: terminal.in.project ?? '', folder: terminal.in.folder, cli: providerDescriptor(terminal.provider).name })}
            </p>
          )}
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
