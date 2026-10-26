import { useCallback, useEffect, useState } from 'react'
import type { ProviderId } from '@shared/types'
import { accountState, duplicateLogins, type AccountsView, type AccountState } from '@shared/accounts'
import { providerDescriptor } from '@shared/providers'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { confirm, notify, prompt, useStore } from '../store'
import { Icon, Switch } from './ui'
import { timeAgo } from '../util'
import { TerminalView } from './TerminalView'

/**
 * Settings → Accounts (HI-980): Hive's accounts, each a CLI login in a folder of its own, signed in through the CLI's
 * own sign-in in one of Hive's terminals (nothing typed into it). Each row says who it is signed in as, from the CLI's
 * own status, and whether its login changed; this window's workspace turns accounts on and picks its default.
 */

const M = {
  none: msg({ id: 'settings.accounts.none', defaultMessage: 'No accounts yet. Add one, then sign it in.', description: 'Settings → Accounts when there are no accounts.' }),
  noWorkspace: msg({ id: 'settings.accounts.noWorkspace', defaultMessage: 'Open a workspace to choose which accounts are on in it.', description: 'Settings → Accounts with no workspace open: the On and Default choices are per workspace.' }),
  loading: msg({ id: 'settings.accounts.loading', defaultMessage: 'Loading…', description: 'Settings → Accounts while its list loads.' }),
  add: msg({ id: 'settings.accounts.add', defaultMessage: 'Add Account…', description: 'Button in Settings → Accounts: adds an account (asks its name), then opens its sign-in.' }),
  addTitle: msg({ id: 'settings.accounts.addTitle', defaultMessage: 'Add a {cli} account', description: 'Title of the dialog asking a new account\'s name (Settings → Accounts). {cli} is a coding agent CLI ("Claude Code").' }),
  addMessage: msg({ id: 'settings.accounts.addMessage', defaultMessage: "A name for it, such as Personal or Work. Hive makes its folder, then opens {cli}'s sign-in in your browser.", description: "The message of the dialog asking a new account's name (Settings → Accounts). {cli} is a coding agent CLI." }),
  name: msg({ id: 'settings.accounts.name', defaultMessage: 'Name', description: "The label of the box for an account's name (Settings → Accounts)." }),
  addConfirm: msg({ id: 'settings.accounts.addConfirm', defaultMessage: 'Add and Sign In', description: "The confirm button of the dialog adding an account (Settings → Accounts)." }),
  needName: msg({ id: 'settings.accounts.needName', defaultMessage: 'Give it a name.', description: "Under the name box of an account (Settings → Accounts) while it's empty." }),
  addFailed: msg({ id: 'settings.accounts.addFailed', defaultMessage: "Couldn't add the account", description: "An error's title: adding an account failed (Settings → Accounts)." }),
  rename: msg({ id: 'settings.accounts.rename', defaultMessage: 'Rename…', description: 'Button on an account (Settings → Accounts): changes its name only.' }),
  renameTitle: msg({ id: 'settings.accounts.renameTitle', defaultMessage: 'Rename {name}', description: "Title of the dialog renaming an account ({name}, its name)." }),
  renameConfirm: msg({ id: 'settings.accounts.renameConfirm', defaultMessage: 'Rename', description: 'The confirm button of the dialog renaming an account.' }),
  signIn: msg({ id: 'settings.accounts.signIn', defaultMessage: 'Sign In', description: "Button on an account (Settings → Accounts): opens the CLI's own sign-in for it, in a terminal of Hive's." }),
  signInAgain: msg({ id: 'settings.accounts.signInAgain', defaultMessage: 'Sign In Again', description: "Button on an account (Settings → Accounts) that is signed out, or whose login changed: opens the CLI's own sign-in for it again." }),
  signingIn: msg({ id: 'settings.accounts.signingIn', defaultMessage: "Signing in: finish in your browser, or in the terminal below. Hive doesn't type into it.", description: "Settings → Accounts while an account's sign-in terminal is open: the user signs in through the CLI's own flow." }),
  signingInElsewhere: msg({ id: 'settings.accounts.signingInElsewhere', defaultMessage: 'Signing in, in another window', description: "An account's line in Settings → Accounts while its sign-in is open in another of Hive's windows." }),
  signInFailed: msg({ id: 'settings.accounts.signInFailed', defaultMessage: "Couldn't open the sign-in", description: "An error's title: an account's sign-in terminal couldn't be opened." }),
  close: msg({ id: 'settings.accounts.closeTerminal', defaultMessage: 'Close', description: "Button under an account's ended sign-in terminal (Settings → Accounts): hides it." }),
  keep: msg({ id: 'settings.accounts.keep', defaultMessage: 'Keep the New Login', description: 'Button on an account whose login changed (Settings → Accounts): takes on the login it is now signed in as.' }),
  keepRename: msg({ id: 'settings.accounts.keepRename', defaultMessage: 'Kept. Rename {name} to match?', description: 'After Keep the New Login on an account ({name}): offers to rename it, since it is now another login.' }),
  keepFailed: msg({ id: 'settings.accounts.keepFailed', defaultMessage: "Couldn't keep the new login", description: "An error's title: Keep the New Login failed." }),
  remove: msg({ id: 'settings.accounts.remove', defaultMessage: 'Remove…', description: 'Button on an account (Settings → Accounts): removes it and deletes its folder (asks first).' }),
  removeTitle: msg({ id: 'settings.accounts.removeTitle', defaultMessage: 'Remove {name}?', description: "Title of the dialog confirming an account's removal ({name}, its name)." }),
  removeMessage: msg({ id: 'settings.accounts.removeMessage', defaultMessage: "Its folder is deleted for good, with its login on this PC (it doesn't go to the Recycle Bin). Your conversations and Claude Code's memory are kept: they are shared with your other accounts. The account itself stays yours at Anthropic.", description: "The message of the dialog confirming an account's removal (Settings → Accounts)." }),
  removeConfirm: msg({ id: 'settings.accounts.removeConfirm', defaultMessage: 'Remove', description: "The confirm button of the dialog removing an account." }),
  removing: msg({ id: 'settings.accounts.removing', defaultMessage: 'Removing…', description: 'The confirm button of the dialog removing an account, while it removes it.' }),
  onHere: msg({ id: 'settings.accounts.onHere', defaultMessage: 'On in this workspace', description: 'The switch on an account (Settings → Accounts): whether it is on in the open workspace.' }),
  default: msg({ id: 'settings.accounts.default', defaultMessage: 'Default', description: "The choice on an account (Settings → Accounts): the open workspace's default account for its CLI." }),
  isDefault: msg({ id: 'settings.accounts.isDefault', defaultMessage: "This workspace's default", description: "Shown on the account that is the open workspace's default (Settings → Accounts)." }),
  makeDefault: msg({ id: 'settings.accounts.makeDefault', defaultMessage: 'Make Default', description: "Button on an account (Settings → Accounts): makes it the open workspace's default account for its CLI (turning it on)." }),
  changeFailed: msg({ id: 'settings.accounts.changeFailed', defaultMessage: "Couldn't change the account", description: "An error's title: renaming an account, turning it on or off, or making it the default failed." }),
  removeFailed: msg({ id: 'settings.accounts.removeFailed', defaultMessage: "Couldn't remove the account", description: "An error's title: removing an account failed." }),
  sameLogin: msg({ id: 'settings.accounts.sameLogin', defaultMessage: 'Signed in to the same login as another account: {names}', description: 'A warning on an account (Settings → Accounts): other accounts are signed in as the same login. {names} is their names, listed.' }),
  leftover: msg({ id: 'settings.accounts.leftover', defaultMessage: "Not all removed: {what}. Remove tries again; nothing outside its folder was touched.", description: "A warning on an account (Settings → Accounts) whose removal stopped partway. {what} is what's left, in English." }),
  plan: msg({ id: 'settings.accounts.plan', defaultMessage: '{email} · {plan}', description: "An account's identity in Settings → Accounts: the email it is signed in as, and its plan as the CLI names it (\"max\")." }),
  changedTo: msg({ id: 'settings.accounts.changedTo', defaultMessage: 'Now signed in as {now}, was {was}', description: 'A warning on an account (Settings → Accounts): its login changed (a /login typed in a pane). {now} and {was} are emails.' }),
  checkedAt: msg({ id: 'settings.accounts.checkedAt', defaultMessage: 'Checked {when}', description: "The tooltip of an account's state (Settings → Accounts): when it was last checked. {when} is how long ago (\"5 min ago\")." })
}

const STATE: Record<AccountState, ReturnType<typeof msg>> = {
  signedIn: msg({ id: 'settings.accounts.state.signedIn', defaultMessage: 'Signed in', description: "An account's state (Settings → Accounts)." }),
  signedOut: msg({ id: 'settings.accounts.state.signedOut', defaultMessage: 'Signed out', description: "An account's state (Settings → Accounts): the CLI says its folder isn't signed in." }),
  changed: msg({ id: 'settings.accounts.state.changed', defaultMessage: 'Login changed', description: "An account's state (Settings → Accounts): signed in as another login than the one it was added with." }),
  failed: msg({ id: 'settings.accounts.state.failed', defaultMessage: "Couldn't check", description: "An account's state (Settings → Accounts): Hive couldn't ask the CLI who it's signed in as (not the same as signed out)." }),
  missing: msg({ id: 'settings.accounts.state.missing', defaultMessage: 'Folder missing', description: "An account's state (Settings → Accounts): its folder isn't there, or isn't the one Hive made." }),
  unchecked: msg({ id: 'settings.accounts.state.unchecked', defaultMessage: 'Not checked yet', description: "An account's state (Settings → Accounts): Hive hasn't asked the CLI yet." })
}
const STATE_ICON: Record<AccountState, string> = { signedIn: 'pass-filled', signedOut: 'circle-slash', changed: 'warning', failed: 'question', missing: 'warning', unchecked: 'circle-outline' }

export function AccountsSettings() {
  const changed = useStore((s) => s.accountsChanged)
  const wsPath = useStore((s) => s.workspace?.path ?? null)
  const [view, setView] = useState<AccountsView | null>(null)
  const [terminal, setTerminal] = useState<{ id: string; key: string; ended: boolean } | null>(null)
  const load = useCallback((check: boolean) => {
    call('accounts:list', check)
      .then(setView)
      .catch(() => undefined)
  }, [])
  // Each account checked again as the section is shown; read again whenever main says they changed.
  useEffect(() => load(true), [load, wsPath])
  useEffect(() => load(false), [load, changed])

  if (!view) return <div className="faint">{tr(M.loading)}</div>
  const dups = duplicateLogins(view.accounts)
  const nameOf = (id: string): string => view.accounts.find((a) => a.id === id)?.name ?? id
  const act = async (title: ReturnType<typeof msg>, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      notify('error', tr(title), errorMessage(e))
    }
  }
  const signIn = async (id: string): Promise<void> => {
    try {
      const key = await call('accounts:signIn', id)
      setTerminal({ id, key, ended: false })
    } catch (e) {
      notify('error', tr(M.signInFailed), errorMessage(e))
    }
  }
  const add = async (provider: ProviderId): Promise<void> => {
    const cli = providerDescriptor(provider).name
    const name = await prompt({ title: tr(M.addTitle, { cli }), message: tr(M.addMessage, { cli }), fieldLabel: tr(M.name), confirmLabel: tr(M.addConfirm), validate: (v) => (v.trim() ? null : tr(M.needName)) })
    if (!name) return
    try {
      const a = await call('accounts:add', provider, name)
      await signIn(a.id)
    } catch (e) {
      notify('error', tr(M.addFailed), errorMessage(e))
    }
  }
  const rename = async (id: string, current: string, title = tr(M.renameTitle, { name: current })): Promise<void> => {
    const name = await prompt({ title, fieldLabel: tr(M.name), initial: current, confirmLabel: tr(M.renameConfirm), validate: (v) => (v.trim() ? null : tr(M.needName)) })
    if (name && name.trim() !== current) await act(M.changeFailed, () => call('accounts:rename', id, name))
  }
  const remove = async (id: string, name: string): Promise<void> => {
    await confirm({ title: tr(M.removeTitle, { name }), message: tr(M.removeMessage), confirmLabel: tr(M.removeConfirm), busyLabel: tr(M.removing), danger: true, run: () => call('accounts:remove', id) }).catch((e) => notify('error', tr(M.removeFailed), errorMessage(e)))
  }
  const keep = async (id: string, name: string, email?: string): Promise<void> => {
    try {
      await call('accounts:keepLogin', id)
    } catch (e) {
      notify('error', tr(M.keepFailed), errorMessage(e))
      return
    }
    await rename(id, name, tr(M.keepRename, { name: email ?? name }))
  }

  return (
    <div className="accounts-settings">
      {!wsPath && <p className="hint">{tr(M.noWorkspace)}</p>}
      {view.providers.map((p) => {
        const mine = view.accounts.filter((a) => a.provider === p)
        const ws = view.workspace[p]
        return (
          <div key={p} className="accounts-provider" data-provider={p}>
            {mine.length === 0 && <div className="faint">{tr(M.none)}</div>}
            {mine.map((a) => {
              const state = accountState(a)
              const on = !!ws?.on.includes(a.id)
              const isDefault = ws?.default === a.id
              const o = a.observed
              const ident = o?.email ? (o.plan ? tr(M.plan, { email: o.email, plan: o.plan }) : o.email) : a.accepted?.email
              const same = dups.get(a.id)
              return (
                <div key={a.id} className="account-row" data-account={a.id} data-state={state}>
                  <div className="account-main">
                    <div className="account-name">{a.name}</div>
                    <div className="account-ident muted">{ident}</div>
                    <div className={`account-state state-${state}`} title={o?.at ? tr(M.checkedAt, { when: timeAgo(o.at) }) : undefined}>
                      <Icon name={STATE_ICON[state]} /> {tr(STATE[state])}
                      {a.signingIn && terminal?.id !== a.id && <span className="muted"> · {tr(M.signingInElsewhere)}</span>}
                    </div>
                    {state === 'changed' && a.accepted && o?.email && <div className="account-warning" data-warning="changed"><Icon name="warning" /> {tr(M.changedTo, { now: o.email, was: a.accepted.email })}</div>}
                    {same && <div className="account-warning" data-warning="duplicate"><Icon name="warning" /> {tr(M.sameLogin, { names: fmt.list(same.map(nameOf)) })}</div>}
                    {a.leftover && <div className="account-warning" data-warning="leftover"><Icon name="warning" /> {tr(M.leftover, { what: a.leftover })}</div>}
                  </div>
                  <div className="account-actions">
                    <Switch checked={on} disabled={!wsPath || !!a.leftover} label={tr(M.onHere)} onChange={(v) => void act(M.changeFailed, () => call('accounts:setOn', a.id, v))} />
                    {isDefault ? <span className="account-default">{tr(M.isDefault)}</span> : <button className="btn subtle" disabled={!wsPath || !!a.leftover} onClick={() => void act(M.changeFailed, () => call('accounts:setDefault', a.id))}>{tr(M.makeDefault)}</button>}
                    {state === 'changed' && <button className="btn subtle" onClick={() => void keep(a.id, a.name, o?.email)}>{tr(M.keep)}</button>}
                    {!a.leftover && <button className="btn" onClick={() => void signIn(a.id)}>{tr(state === 'signedOut' || state === 'changed' ? M.signInAgain : M.signIn)}</button>}
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
      {terminal && (
        <div className="account-signin">
          <p className="hint">{tr(M.signingIn)}</p>
          <div className="task-terminal">
            <TerminalView ptyKey={terminal.key} visible onExit={() => setTerminal((t) => (t?.key === terminal.key ? { ...t, ended: true } : t))} />
          </div>
          {terminal.ended && <button className="btn" onClick={() => setTerminal(null)}>{tr(M.close)}</button>}
        </div>
      )}
    </div>
  )
}
