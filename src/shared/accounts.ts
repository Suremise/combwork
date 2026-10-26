import type { Account, ProviderId, WorkspaceAccounts, WorkspaceConfig } from './types'

/**
 * Hive's accounts (HI-980): what an account's state is from its two identities, which accounts share a login, and a
 * workspace's choice of them per provider. Pure, for main and the window alike.
 */

/** What Settings → Accounts shows (accounts:list): the accounts, and the asking window's workspace's choice of them. */
export interface AccountsView {
  /** Settings → Advanced's Accounts (preview): off, the section and everything about accounts are hidden. */
  preview: boolean
  /** The providers that can have accounts (capabilities.accounts) and are on in Settings. */
  providers: ProviderId[]
  accounts: (Account & { signingIn: boolean; folder: string })[]
  /** Per provider, as it applies (workspaceAccounts); absent: not set up in this workspace. */
  workspace: Partial<Record<ProviderId, WorkspaceAccounts>>
}

/**
 * An account's state, from `accepted` (who the user took it on as) and `observed` (the latest check), never merged: a
 * check can't clear a change the user hasn't answered.
 * - `missing`: its folder isn't there (or was replaced by something Hive didn't make).
 * - `unchecked`: never checked yet.
 * - `failed`: the latest check couldn't tell (a timeout, output it couldn't read): never counted as signed out.
 * - `signedOut`: the CLI said it is signed out.
 * - `changed`: signed in, but not as the accepted login (a /login typed in a pane).
 * - `signedIn`: signed in as accepted (or none accepted yet, with an identity).
 */
export type AccountState = 'missing' | 'unchecked' | 'failed' | 'signedOut' | 'changed' | 'signedIn'

export function accountState(a: Pick<Account, 'accepted' | 'observed'>): AccountState {
  const o = a.observed
  if (!o) return 'unchecked'
  if (o.missing) return 'missing'
  if (o.loggedIn === null) return 'failed'
  if (!o.loggedIn) return 'signedOut'
  if (a.accepted && !sameLogin(a.accepted, o)) return 'changed'
  return 'signedIn'
}

/** Whether two identities are the same login: the same email (any case) in the same organisation. */
export function sameLogin(a: { email?: string; orgId?: string }, b: { email?: string; orgId?: string }): boolean {
  return !!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase() && (a.orgId ?? '') === (b.orgId ?? '')
}

/** Per account id, the other accounts of its provider signed in as the same login (from their latest checks). */
export function duplicateLogins(accounts: readonly Account[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const a of accounts) {
    if (!a.observed?.loggedIn || !a.observed.email) continue
    const same = accounts.filter((b) => b.id !== a.id && b.provider === a.provider && !!b.observed?.loggedIn && sameLogin(a.observed!, b.observed!)).map((b) => b.id)
    if (same.length) out.set(a.id, same)
  }
  return out
}

/** The identity a successful check gives, to accept: only signed in, with both its email and organisation. */
export function acceptable(o: Account['observed']): { email: string; orgId: string } | null {
  return o && !o.missing && o.loggedIn === true && o.email && o.orgId ? { email: o.email, orgId: o.orgId } : null
}

/**
 * A workspace's accounts for a provider as they apply: ids of accounts that no longer exist (or are another
 * provider's) dropped, and its default replaced when it isn't one of those on. `undefined`: not set up yet.
 */
export function workspaceAccounts(cfg: Pick<WorkspaceConfig, 'accounts'> | null | undefined, provider: ProviderId, accounts: readonly Account[]): WorkspaceAccounts | undefined {
  const w = cfg?.accounts?.[provider]
  if (!w) return undefined
  const ids = new Set(accounts.filter((a) => a.provider === provider).map((a) => a.id))
  const on = w.on.filter((id, i) => ids.has(id) && w.on.indexOf(id) === i)
  return { on, default: w.default && on.includes(w.default) ? w.default : replacementDefault(on, accounts) }
}

/** The default when the last one is off or gone: the first account of the provider that's on, in the list's order; else none. */
export function replacementDefault(on: readonly string[], accounts: readonly Account[]): string | null {
  return accounts.find((a) => on.includes(a.id))?.id ?? null
}

/**
 * A workspace's accounts for a provider after turning one on or off (on: it becomes the default if there is none),
 * from how they apply now (`current`; undefined: not set up yet, so this sets it up).
 */
export function switchedOn(current: WorkspaceAccounts | undefined, id: string, on: boolean, accounts: readonly Account[]): WorkspaceAccounts {
  const was = current ?? { on: [], default: null }
  const ids = on ? (was.on.includes(id) ? was.on : [...was.on, id]) : was.on.filter((x) => x !== id)
  // In the account list's order, so the replacement default is the same in every window.
  const ordered = accounts.filter((a) => ids.includes(a.id)).map((a) => a.id)
  const keep = was.default && ordered.includes(was.default) ? was.default : null
  return { on: ordered, default: keep ?? (on && !was.default ? id : replacementDefault(ordered, accounts)) }
}
