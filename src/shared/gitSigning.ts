// How a repository signs its commits, and whether it could sign just now with nobody there (HI-1185, SPEC §16.9.5):
// what Version Control → Branches & remotes shows, and what the merge queue checks before a commit it signs.

/** Where git found a setting: its scope as `git config --show-scope` names it. */
export type GitScope = 'system' | 'global' | 'local' | 'worktree' | 'command' | 'unknown'

export interface ScopedValue {
  value: string
  scope: GitScope
}

/**
 * What a check of signing found: `off` (commits aren't signed); `unattended` (this signer, key and environment signed a
 * throwaway payload just now with nobody there); `needsSomeone` (the signer's own words: a passphrase, a pinentry, no
 * agent with it unlocked); `couldNotComplete` (it didn't finish within the check's bound: never taken as proof either
 * way); `cantSign` (anything else, its words with credentials removed); `notChecked` (a signer Combwork doesn't run by
 * itself, a key command, x509 or a hardware key: never invoked); `unreadable` (git couldn't read the settings).
 */
export type SigningStatus =
  | { kind: 'off' }
  | { kind: 'unattended' }
  | { kind: 'needsSomeone'; format: 'openpgp' | 'ssh'; detail: string }
  | { kind: 'couldNotComplete'; format: 'openpgp' | 'ssh' }
  | { kind: 'cantSign'; message: string }
  | { kind: 'notChecked'; why: 'program' | 'keyCommand' | 'x509' | 'hardware'; path?: string }
  | { kind: 'unreadable'; message: string }

/** The repository's signing as git resolves it in a folder, and the check's outcome. */
export interface SigningInfo {
  /** commit.gpgsign (null: not set anywhere, so off). */
  sign: ScopedValue | null
  format: 'openpgp' | 'ssh' | 'x509'
  formatScope: GitScope | null
  /** user.signingkey, shortened: never key material (null: not set; git's own default applies). */
  key: ScopedValue | null
  /** The signing program's full path, when Combwork found it. */
  program: string | null
  status: SigningStatus
  /** When it was checked (ISO). */
  at: string
}
