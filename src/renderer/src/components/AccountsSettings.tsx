import { ConnectionDialog, MovedNoticeBanner, connectionSummary, connectionUsers, effortUnusableText } from './ConnectionDefaults'
import { connectionCells, currentLimits, planName, resetText, usageLevel, windowOf, type ConnectionCell } from './accountCard'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Account, PlanLimit, ProviderId } from '@shared/types'
import { accountState, connectionReadiness, duplicateLogins, type AccountView, type ConnectionRow, type ConnectionsView, type ConnectionState } from '@shared/accounts'
import { COPILOT_ACCOUNT } from '@shared/connectionDefaults'
import { connectionOf } from '@shared/connectionLabel'
import { isProviderEnabled, providerDescriptor } from '@shared/providers'
import { fmt, msg, tr } from '@shared/i18n'
import { formatDate } from '@shared/dates'
import { call, errorMessage } from '../api'
import { confirm, notify, prompt, set, useStore } from '../store'
import { Icon, IconButton, Modal, Switch, useContextMenu, type MenuEntry } from './ui'
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
  copilotNotSignedIn: msg({ id: 'settings.accounts.copilotNotSignedIn', defaultMessage: 'Not signed in: sign in from Provider Setup', description: "GitHub Copilot's account when it isn't signed in (HI-2107). Provider Setup names a dialog." }),
  providerSetup: msg({ id: 'settings.accounts.providerSetup', defaultMessage: 'Open Provider Setup', description: "The only entry of GitHub Copilot's account's ⋯ menu (HI-2107): opens the Provider Setup dialog, where its sign-in is." }),
  more: msg({ id: 'settings.accounts.more', defaultMessage: 'More for {name}', description: "The ⋯ button of an account or a connection (Settings → Accounts & Connections), for screen readers and its tooltip ({name}, its name)." }),
  move: msg({ id: 'settings.accounts.moveAccount', defaultMessage: 'Drag to change the order of {name}, or press Alt+Up or Alt+Down', description: "The tooltip and label of an account's drag handle (Settings → Accounts & Connections, HI-2107): it moves the account in the one order of accounts. Alt+Up and Alt+Down name keys." }),
  moveFailed: msg({ id: 'settings.accounts.moveFailed', defaultMessage: "Couldn't change the order", description: "An error's title: moving a connection in its coding agent CLI's order failed (Settings → Accounts & Connections)." }),
  changeFailed: msg({ id: 'settings.accounts.changeFailed', defaultMessage: "Couldn't change the connection", description: "An error's title: renaming a connection, turning it on or off, or making it the default failed." }),
  removeFailed: msg({ id: 'settings.accounts.removeFailed', defaultMessage: "Couldn't remove the connection", description: "An error's title: removing a connection failed." }),
  sameLogin: msg({ id: 'settings.accounts.sameLoginAccount', defaultMessage: 'Signed in to the same login as another account: {names}', description: 'A warning on an account (Settings → Accounts & Connections, HI-2107): other accounts are signed in as the same login. {names} is their names, listed.' }),
  leftover: msg({ id: 'settings.accounts.leftover', defaultMessage: "Not all removed: {what}. Remove tries again; nothing outside its folder was touched.", description: "A warning on a connection (Settings → Accounts & Connections) whose removal stopped partway. {what} is what's left, in English." }),
  changedTo: msg({ id: 'settings.accounts.changedTo', defaultMessage: 'Now signed in as {now}, was {was}', description: 'A warning on a connection (Settings → Accounts & Connections): its login changed (a /login typed in a pane). {now} and {was} are emails.' }),
  affected: msg({ id: 'settings.accounts.affected', defaultMessage: '{n, plural, one {# running agent runs on another connection than the one chosen for it now.} other {# running agents run on another connection than the one chosen for them now.}}', description: 'Banner in Settings → Accounts & Connections after a connection was turned off or the default changed (HI-1755): how many running agents are on a connection other than the one chosen now.' }),
  switchAffected: msg({ id: 'settings.accounts.switchAffected', defaultMessage: 'Switch Them When Their Turn Is Over', description: 'Button on that banner: each of those agents ends once its turn is over and carries on, on the connection chosen now.' }),
  notTrusted: msg({ id: 'settings.accounts.notTrusted', defaultMessage: 'Not trusted yet in this workspace: {projects}', description: "Under a connection that needs set up (Settings → Accounts & Connections, HI-1870): the projects of the open workspace whose folders its coding agent CLI hasn't been told to trust yet ({projects}: their names, listed). Set Up asks the CLI's trust question for each in turn." }),
  moreProjects: msg({ id: 'settings.accounts.moreProjects', defaultMessage: '{n, plural, one {# more} other {# more}}', description: 'The last item of that list when it names only the first projects: how many more there are.' }),
  setUpIn: msg({ id: 'settings.accounts.setUpIn', defaultMessage: "It opens in {project}'s folder, {folder}: answer {cli}'s question to trust it.", description: "Above a connection's Set Up terminal when it opens in a project's folder its coding agent CLI ({cli}) doesn't trust yet (HI-1870): {project} is the project's name, {folder} the folder." }),
  setUpInWorkspace: msg({ id: 'settings.accounts.setUpInWorkspace', defaultMessage: "It opens in this workspace's folder, {folder}: answer {cli}'s question to trust it, and with it every project in it that isn't a Git repository. A Git repository is asked in its own folder next.", description: "Above a connection's Set Up terminal when it opens in the open workspace's folder (HI-1871): the coding agent CLI ({cli}) asks once whether to trust that folder; trusting it covers the projects inside it that aren't Git repositories, and Set Up then asks in each Git repository's own folder (HI-2520). {folder} is the folder." }),
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
  tagTip: msg({ id: 'settings.accounts.connection.tagTip', defaultMessage: "Its tag: a usage move puts agents on another account's connection with the same tag.", description: "The tooltip of a connection's tag on its row (Settings → Accounts & Connections, HI-2530). The tag is a free-text label of the user's (\"Builders\")." }),
  baseTip: msg({ id: 'settings.accounts.connection.baseTip', defaultMessage: 'The first of its account: what a new agent gets when this account is first in the order and on here.', description: 'The tooltip of "First" on a connection (HI-2107).' }),
  // The tidied cards (HI-2528, Darren's approved mockup v2).
  factSignedInAs: msg({ id: 'settings.accounts.fact.signedInAs', defaultMessage: 'Signed in as', description: "A field's label on an account's card (Settings → Accounts & Connections, HI-2528): the email (or, for GitHub Copilot, the user name) it is signed in as. Keep it short." }),
  factPlan: msg({ id: 'settings.accounts.fact.plan', defaultMessage: 'Plan', description: "A field's label on an account's card (HI-2528): its plan as the coding agent CLI names it (\"Max\"). Keep it short." }),
  factState: msg({ id: 'settings.accounts.fact.state', defaultMessage: 'State', description: "A field's label on an account's card (HI-2528): whether it is signed in and set up, and when its sign-in expires. Keep it short." }),
  factSignIn: msg({ id: 'settings.accounts.fact.signIn', defaultMessage: 'Sign-in', description: "A field's label on GitHub Copilot's account card (HI-2528): whose sign-in it is (the PC's, every workspace's). Keep it short." }),
  expires: msg({ id: 'settings.accounts.expires', defaultMessage: 'Sign-in expires {date}', description: "Under an account's state (Settings → Accounts & Connections, HI-2528): when its sign-in expires, as the coding agent CLI says. {date} is the date." }),
  expired: msg({ id: 'settings.accounts.expired', defaultMessage: 'Sign-in expired {date}', description: "Under an account's state (HI-2528): its sign-in expired on that date ({date}), as the CLI last said; signing in again renews it." }),
  usageLabel: msg({ id: 'settings.accounts.usageLabel', defaultMessage: '{window, select, fiveHour {5-hour} weekly {Weekly} other {{label}}}', description: "The label of one plan-usage bar on an account's card (HI-2528): the 5-hour limit, the weekly one, or another the provider names ({label}, as it names it). Keep it short." }),
  usageNone: msg({ id: 'settings.accounts.usageNone', defaultMessage: 'Usage: not reported yet', description: "On an account's card (HI-2528) when its coding agent CLI hasn't reported any plan limits yet (they come with its sessions)." }),
  offHere: msg({ id: 'settings.accounts.offHere', defaultMessage: 'Off here', description: "A tag on an account's card (HI-2528) when it is turned off in the open workspace: its connections can't be used here. Keep it short." }),
  colConnection: msg({ id: 'settings.accounts.col.connection', defaultMessage: 'Connection', description: "A column heading of an account's connections table (Settings → Accounts & Connections, HI-2528): the connection's name. Keep it short." }),
  colTag: msg({ id: 'settings.accounts.col.tag', defaultMessage: 'Tag', description: "A column heading of an account's connections table (HI-2528): the connection's free-text tag (HI-2530), which a usage move matches by. Keep it short." }),
  colUsedBy: msg({ id: 'settings.accounts.col.usedBy', defaultMessage: 'Used by', description: "A column heading of an account's connections table (HI-2528): who uses the connection (agents, the Assistant). Keep it short." }),
  moveUp: msg({ id: 'settings.accounts.connection.moveUp', defaultMessage: 'Move {name} up', description: "The tooltip of a connection's up arrow (HI-2528): moves it one place up among its account's connections; the first is what a new agent gets. {name} is its name." }),
  moveDown: msg({ id: 'settings.accounts.connection.moveDown', defaultMessage: 'Move {name} down', description: "The tooltip of a connection's down arrow (HI-2528): moves it one place down among its account's connections. {name} is its name." }),
  editNamed: msg({ id: 'settings.accounts.connection.editNamed', defaultMessage: 'Edit {name}', description: "The tooltip of a connection's edit button (HI-2528): opens its dialog. {name} is its name." }),
  removeNamed: msg({ id: 'settings.accounts.connection.removeNamed', defaultMessage: 'Remove {name}', description: "The tooltip of a connection's remove button (HI-2528): removes it (asks first). {name} is its name." }),
  accountSettings: msg({ id: 'settings.accounts.accountSettings', defaultMessage: 'Account Settings…', description: "An entry of an account's ⋯ menu (Settings → Accounts & Connections, HI-2528): opens a dialog with the account's own settings (its usage move)." }),
  accountSettingsTitle: msg({ id: 'settings.accounts.accountSettingsTitle', defaultMessage: '{name}: Account Settings', description: "The title of an account's settings dialog (HI-2528); {name} is the account's name." })
}

/** The connections table's value columns (HI-2528): each heading, also the label of its value on a narrow card's row. */
const COLUMN = {
  model: msg({ id: 'settings.accounts.col.model', defaultMessage: 'Model', description: "A column heading of an account's connections table (HI-2528). Keep it short." }),
  effort: msg({ id: 'settings.accounts.col.effort', defaultMessage: 'Effort', description: "A column heading of an account's connections table (HI-2528): the reasoning effort. Keep it short." }),
  context: msg({ id: 'settings.accounts.col.context', defaultMessage: 'Context', description: "A column heading of an account's connections table (HI-2528): its context window (200K or the model's own). Keep it short." }),
  mode: msg({ id: 'settings.accounts.col.mode', defaultMessage: 'Mode', description: "A column heading of an account's connections table (HI-2528): the permission mode. Keep it short." }),
  args: msg({ id: 'settings.accounts.col.args', defaultMessage: 'Extra args', description: "A column heading of an account's connections table (HI-2528): extra command-line arguments for the CLI. Keep it short." })
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

/** Each limit as a small bar with its share and reset (HI-2528); "not reported yet" with none. */
function UsageBars({ limits }: { limits: readonly PlanLimit[] | undefined }) {
  const now = useNow()
  const shown = currentLimits(limits, now.getTime())
  if (!shown.length) return <div className="account-usage-none faint" data-usage="none">{tr(M.usageNone)}</div>
  return (
    <div className="account-usage" data-usage>
      {shown.map((l) => (
        <div key={l.id} className="account-usage-row" data-limit={l.id}>
          <span className="account-usage-label">{tr(M.usageLabel, { window: windowOf(l), label: l.label })}</span>
          <span className={cx('account-usage-bar', usageLevel(l.usedPercent))} role="meter" aria-label={tr(M.usageLabel, { window: windowOf(l), label: l.label })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(l.usedPercent)}>
            <i style={{ width: `${Math.max(0, Math.min(100, l.usedPercent))}%` }} />
          </span>
          <span className="account-usage-pct">{fmt.percent(l.usedPercent / 100)}</span>
          <span className="account-usage-reset faint" data-resets>{resetText(l.resetsAt, now)}</span>
        </div>
      ))}
    </div>
  )
}

/** The time now, a minute at a time: a reset passing drops its bar, and "at 23:00" turns into a weekday after midnight. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

/** One labelled field of an account's card (HI-2528): the same fields in the same place on every card. */
function Fact({ label, children, data }: { label: string; children: React.ReactNode; data?: string }) {
  return (
    <div className="account-fact" data-fact={data}>
      <span className="account-fact-label">{label}</span>
      <span className="account-fact-value">{children}</span>
    </div>
  )
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
  // The account whose Account Settings are open (HI-2528: its usage move, off the card at Darren's word, 21:40).
  const [accountDialog, setAccountDialog] = useState<string | null>(null)
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

  /**
   * An account's connections as a small table inside its card (HI-2528, Darren's 21:40 decision and approved mockup v2):
   * order, Connection (with First), Tag, Model, Effort, Context, Mode, Extra args, Used by, then Edit, Remove and ⋯
   * (Duplicate). Each value the CLI decides reads "CLI's own"; on a narrow card each row goes to two lines (CSS).
   */
  const connections = (a: AccountView | Account) => {
    const rows = view.connectionRows.filter((r) => r.account === a.id)
    const moveTo = (c: ConnectionRow, i: number): Promise<void> => act(M.moveFailed, () => call('connection:move', c.id, i))
    const cell = (k: 'model' | 'effort' | 'context' | 'mode' | 'args', v: ConnectionCell, extra?: React.ReactNode) => (
      <span className={cx('connection-cell', `connection-${k}`, v.own && 'cli-own', v.none && 'faint')} data-cell={k}>
        <span className="connection-cell-label">{tr(COLUMN[k])}</span>
        {v.text}
        {extra}
      </span>
    )
    return (
      <div className="connection-list" data-connections-of={a.id}>
        {rows.length > 0 && (
          <div className="connection-row connection-head" aria-hidden>
            <span />
            <span>{tr(M.colConnection)}</span>
            <span>{tr(M.colTag)}</span>
            <span>{tr(COLUMN.model)}</span>
            <span>{tr(COLUMN.effort)}</span>
            <span>{tr(COLUMN.context)}</span>
            <span>{tr(COLUMN.mode)}</span>
            <span>{tr(COLUMN.args)}</span>
            <span>{tr(M.colUsedBy)}</span>
            <span />
          </div>
        )}
        {rows.map((c, i) => {
          const assistant = c.users.some((u) => u.assistant)
          const agents = c.users.filter((u) => !u.assistant).length
          const v = connectionCells(c, a, settings)
          return (
            <div key={c.id} className="connection-row" data-connection={c.id} data-users={c.users.length}>
              <span className="connection-order">
                <IconButton icon="arrow-up" title={tr(M.moveUp, { name: c.name })} action="connection-up" disabled={i === 0} onClick={() => void moveTo(c, i - 1)} />
                <IconButton icon="arrow-down" title={tr(M.moveDown, { name: c.name })} action="connection-down" disabled={i === rows.length - 1} onClick={() => void moveTo(c, i + 1)} />
              </span>
              <span className="connection-name">
                {c.name}
                {i === 0 && rows.length > 1 && <span className="connection-base" title={tr(M.baseTip)}>{tr(M.base)}</span>}
              </span>
              <span className={cx('connection-cell', 'connection-tag-cell', !c.tag && 'faint')} data-cell="tag">
                <span className="connection-cell-label">{tr(M.colTag)}</span>
                {c.tag ? (
                  // Cut to its column with an ellipsis (HR1 on HI-2528): the whole tag in its tooltip, above what it is for.
                  <span className="connection-tag" data-tag title={`${c.tag}\n${tr(M.tagTip)}`}>
                    <Icon name="tag" /> <span className="connection-tag-text">{c.tag}</span>
                  </span>
                ) : (
                  '—' /* i18n-ignore: no tag, a dash */
                )}
              </span>
              {cell('model', v.model)}
              {cell(
                'effort',
                v.effort,
                c.effortUnusable && (
                  <span className="connection-warning" data-effort-unusable title={effortUnusableText(c, a.provider, settings)}>
                    <Icon name="warning" />
                  </span>
                )
              )}
              {cell('context', v.context)}
              {cell('mode', v.mode)}
              {cell('args', v.args)}
              {/* The whole summary, for a narrow card's second line and screen readers' sake. */}
              <span className="connection-summary muted" data-summary>
                {connectionSummary(c, a, settings)}
                {/* The compact row's values (HR1 on HI-2528): its effort warning too, where the Effort cell is hidden. */}
                {c.effortUnusable && (
                  <span className="connection-warning" data-effort-unusable-summary title={effortUnusableText(c, a.provider, settings)}>
                    <Icon name="warning" />
                    <span className="connection-cell-label">{effortUnusableText(c, a.provider, settings)}</span>
                  </span>
                )}
              </span>
              <span className={cx('connection-users', c.users.length ? 'muted' : 'faint')} data-used-by title={c.users.length ? connectionUsers(c) : undefined}>
                {tr(M.usedBy, { assistant: assistant ? 'yes' : 'no', n: agents })}
              </span>
              <span className="connection-actions">
                <IconButton icon="edit" title={tr(M.editNamed, { name: c.name })} action="connection-edit" onClick={() => setDialog({ account: a.id, connection: c.id })} />
                <IconButton icon="trash" title={tr(M.removeNamed, { name: c.name })} action="connection-remove" onClick={() => void removeConnection(c)} />
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
              </span>
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
            <div className="account-facts">
              <Fact label={tr(M.factSignedInAs)} data="email">
                <span data-copilot-identity>{who ?? (copilotInfo?.loggedIn === false ? tr(M.copilotNotSignedIn) : <span className="faint">—</span>) /* i18n-ignore: not read yet, a dash */}</span>
              </Fact>
              <Fact label={tr(M.factSignIn)} data="sign-in">
                {tr(M.thisPc)}
              </Fact>
            </div>
          </div>
          <div className="account-actions">
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

  // The one sign-in or Set Up terminal (a second replaces it), shown in its account's card (HI-2541): keyed by its
  // pty, so another account's opens fresh and scrolls into view, while the list re-rendering keeps it as it is.
  const terminalInCard = !!terminal && shown.some((x) => !x.home && x.id === terminal.id)
  const terminalPanel = (t: Terminal) => (
    <ScrollIntoView key={t.key}>
      <div className="account-signin" data-terminal-of={t.id}>
        <p className="hint">{t.setUp ? setUpHint(t.provider) : tr(M.signingIn)}</p>
        {t.in && (
          <p className="hint" data-set-up-in>
            {t.in.workspace ? tr(M.setUpInWorkspace, { folder: t.in.folder, cli: providerDescriptor(t.provider).name }) : tr(M.setUpIn, { project: t.in.project ?? '', folder: t.in.folder, cli: providerDescriptor(t.provider).name })}
          </p>
        )}
        <div className="task-terminal">
          <TerminalView ptyKey={t.key} visible onExit={() => setTerminal((x) => (x?.key === t.key ? { ...x, ended: true } : x))} />
        </div>
        <div className="flex">
          {/* Set Up after Sign In (HI-1826): the CLI's first-run screens, answered once here rather than in an agent's pane. */}
          {t.ended && !t.setUp && signedInAfter && <button className="btn primary" data-set-up-after onClick={() => void setUp(signedInAfter.id, signedInAfter.provider)}>{setUpLabel()}</button>}
          <button className="btn" data-close-terminal onClick={() => void close()}>{tr(M.close)}</button>
        </div>
      </div>
    </ScrollIntoView>
  )

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
          const email = o?.email ?? a.accepted?.email
          const same = dups.get(a.id)
          // Its usage move lives in its Account Settings (HI-2528, Darren 21:40): there when it could have one.
          const moveTargets = view.connections.filter((other) => other.id !== a.id && other.provider === a.provider && !other.leftover)
          const hasMove = !server && !a.leftover && (!!a.usageMove || moveTargets.length > 0)
          const expiry = !server && state === 'signedIn' ? o?.loginExpiresAt : undefined
          const expired = !!expiry && Date.parse(expiry) <= Date.now()
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
            ...(hasMove ? [{ label: tr(M.accountSettings), icon: 'settings-gear', onClick: () => setAccountDialog(a.id) }] : []),
            { label: tr(M.rename), icon: 'edit', disabled: !!a.leftover, onClick: () => void rename(a.id, a.name) },
            ...(!server && !a.leftover ? [{ label: signInLabel, icon: 'account', onClick: () => void signIn(a.id, a.provider) }] : []),
            ...(!server && !a.leftover && state === 'signedIn' ? [{ label: setUpLabel(), icon: 'tools', onClick: () => void setUp(a.id, a.provider) }] : []),
            { separator: true },
            { label: tr(M.remove), icon: 'trash', danger: true, onClick: () => void remove(a.id, a.name, a.signingIn || terminal?.id === a.id) }
          ]
          return (
            <div key={a.id} className={cx('account-block', wsPath && !on && 'off-here')} data-account={a.id} data-cli={a.provider} data-state={server ? 'server' : state} data-order={place + 1}>
              <div className={cx('account-row', dragging === a.id && 'dragging', dropAt === a.id && 'drop-target')} {...dropProps(a.id)}>
                {handle(a)}
                <div className="account-main">
                  <div className="account-name">
                    {a.name}
                    <span className="account-cli muted">
                      <ProviderIcon provider={a.provider} /> {providerDescriptor(a.provider).name}
                    </span>
                    {wsPath && !on && <span className="account-off-tag" data-off-here>{tr(M.offHere)}</span>}
                  </div>
                  {server ? (
                    <>
                      <ServerConnectionDetail c={a} keyLast4={a.key?.last4} needsSetUp={needsSetUp} onSetUp={(id) => void setUp(id, a.provider)} />
                      {setUpState && <div className="account-state">{setUpState}</div>}
                    </>
                  ) : (
                    <>
                      {/* The same fields in the same place on every card (HI-2528): who, plan, state. */}
                      <div className="account-facts">
                        <Fact label={tr(M.factSignedInAs)} data="email">
                          {email ?? <span className="faint">—</span> /* i18n-ignore: no email yet, a dash */}
                        </Fact>
                        <Fact label={tr(M.factPlan)} data="plan">
                          {o?.plan ? planName(o.plan) : <span className="faint">—</span> /* i18n-ignore: no plan reported, a dash */}
                        </Fact>
                        <Fact label={tr(M.factState)} data="state">
                          <span className={`account-state state-${state}`} title={o?.at ? tr(M.checkedAt, { when: timeAgo(o.at) }) : undefined}>
                            <Icon name={STATE_ICON[state]} /> {tr(STATE[state])}
                            {setUpState && <span className="muted">·</span>}
                            {setUpState}
                            {a.signingIn && terminal?.id !== a.id && <span className="muted"> · {tr(M.signingInElsewhere)}</span>}
                          </span>
                          {expiry && (
                            <span className={cx('account-expiry', expired ? 'expired' : 'faint')} data-expires={expiry}>
                              {tr(expired ? M.expired : M.expires, { date: formatDate(expiry) })}
                            </span>
                          )}
                        </Fact>
                      </div>
                      <UsageBars limits={usage[a.id]?.limits} />
                    </>
                  )}
                  {/* Said once: above its Set Up terminal while that is open (the Assistant, HI-1871). */}
                  {needsSetUp && !(terminal?.setUp && terminal.id === a.id) && <div className="account-setup-note hint" data-set-up-note>{setUpHint(a.provider)}</div>}
                  {needsSetUp && pending.length > 0 && <div className="account-setup-note hint" data-not-trusted>{tr(M.notTrusted, { projects: fmt.list([...pending.slice(0, 3).map((p) => p.project), ...(pending.length > 3 ? [tr(M.moreProjects, { n: pending.length - 3 })] : [])]) })}</div>}
                  {state === 'changed' && a.accepted && o?.email && <div className="account-warning" data-warning="changed"><Icon name="warning" /> {tr(M.changedTo, { now: o.email, was: a.accepted.email })}</div>}
                  {same && <div className="account-warning" data-warning="duplicate"><Icon name="warning" /> {tr(M.sameLogin, { names: fmt.list(same.map(nameOf)) })}</div>}
                  {a.leftover && <div className="account-warning" data-warning="leftover"><Icon name="warning" /> {tr(M.leftover, { what: a.leftover })}</div>}
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
              {/* Its sign-in or Set Up terminal, in its own card under its row (HI-2541), not under the whole list. */}
              {terminal?.id === a.id && terminalPanel(terminal)}
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
      {(() => {
        const a = accountDialog ? view.connections.find((x) => x.id === accountDialog) : undefined
        if (!a) return null
        return (
          <Modal
            title={tr(M.accountSettingsTitle, { name: a.name })}
            icon="settings-gear"
            wide
            onClose={() => setAccountDialog(null)}
            footer={
              <button className="btn primary" onClick={() => setAccountDialog(null)}>
                {tr(M.close)}
              </button>
            }
          >
            <div className="account-settings-dialog" data-account-settings={a.id}>
              {/* Its usage move (HI-2195): a sign-in's plan limits; to another account of its CLI. Saved as it changes. */}
              <UsageMoveRuleRow account={a} others={view.connections.filter((other) => other.id !== a.id && other.provider === a.provider && !other.leftover)} />
            </div>
          </Modal>
        )
      })()}
      {/* An account not in the list yet (just added, read again next): under the list until its card is there. */}
      {terminal && !terminalInCard && terminalPanel(terminal)}
    </div>
  )
}

/** Shows its element once, as it first appears (HI-2541: a Set Up terminal opened under a card further down). */
function ScrollIntoView({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  // A block, never its value: Electron's Chromium returns a promise from scrollIntoView, which React would call as the clean-up.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [])
  return <div ref={ref}>{children}</div>
}
