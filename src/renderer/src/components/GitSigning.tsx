// Version Control → Branches & remotes: how the project's commits are signed, and whether its signer could sign just now
// with nobody there (HI-1185, SPEC §16.9.5). Read-only: Combwork never changes git, ssh or gpg configuration; a check
// that would need someone shows how to set signing up so the merge queue's commits sign unattended.

import { useCallback, useEffect, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import type { GitScope, SigningInfo } from '@shared/gitSigning'
import { msg, tr } from '@shared/i18n'
import { call } from '../api'
import { Icon } from './ui'

const M = {
  heading: msg({ id: 'git.signing.heading', defaultMessage: 'Signing', description: 'Heading in Version Control → Branches & remotes (HI-1185), under Commit identity: how commits are signed.' }),
  checkAgain: msg({ id: 'git.signing.checkAgain', defaultMessage: 'Check again', description: 'Button in the Signing section: checks once more whether commits can be signed with nobody there.' }),
  checking: msg({ id: 'git.signing.checking', defaultMessage: 'Checking…', description: 'The Signing section while its check runs (a few seconds at most).' }),
  signs: msg({ id: 'git.signing.signs', defaultMessage: 'Signs commits', description: 'Row of the Signing table: whether git signs commits (commit.gpgsign).' }),
  format: msg({ id: 'git.signing.format', defaultMessage: 'Format', description: 'Row of the Signing table: how commits are signed (gpg.format: OpenPGP, SSH or X.509).' }),
  key: msg({ id: 'git.signing.key', defaultMessage: 'Key', description: 'Row of the Signing table: the signing key (user.signingkey), shortened.' }),
  program: msg({ id: 'git.signing.program', defaultMessage: 'Program', description: 'Row of the Signing table: the signing program git runs, as a path.' }),
  yes: msg({ id: 'git.signing.yes', defaultMessage: 'Yes', description: 'In the Signing table: commits are signed.' }),
  no: msg({ id: 'git.signing.no', defaultMessage: 'No', description: 'In the Signing table: commits are not signed.' }),
  defaultKey: msg({ id: 'git.signing.defaultKey', defaultMessage: 'Not set (git’s default)', description: 'In the Signing table: no signing key is set, so git uses its own default (the committer’s identity for OpenPGP).' }),
  scope: msg({ id: 'git.signing.scope', defaultMessage: '{scope, select, system {set for the computer} global {set for you} local {set in this repository} worktree {set in this folder} command {set for this command} other {}}', description: 'After a setting in the Signing table, where git found it (git config scopes). Keep the select keys.' }),
  formatName: msg({ id: 'git.signing.formatName', defaultMessage: '{format, select, ssh {SSH} x509 {X.509} other {OpenPGP (gpg)}}', description: 'A signing format’s name in the Signing table. Keep the select keys.' }),
  off: msg({ id: 'git.signing.off', defaultMessage: 'Commits aren’t signed.', description: 'The Signing section when git doesn’t sign commits.' }),
  unattended: msg({ id: 'git.signing.unattended', defaultMessage: 'Signs without asking: this signer and key signed a test just now with nobody there. The merge queue’s commits sign unattended while that holds.', description: 'The Signing check’s result: signing worked with no prompt (at the moment of the check; a cache can expire).' }),
  needsSomeone: msg({ id: 'git.signing.needsSomeone', defaultMessage: 'Would ask for a passphrase: signing needs someone there now, so the merge queue pauses before each signed merge until you unlock the key.', description: 'The Signing check’s result: the signer needs a passphrase, a PIN or an unlocked agent.' }),
  couldNotComplete: msg({ id: 'git.signing.couldNotComplete', defaultMessage: 'Couldn’t sign unattended: the signer didn’t finish within a few seconds with nobody there (it may be waiting for someone).', description: 'The Signing check’s result: the signer was still running at the check’s time limit; never proof that it asked.' }),
  cantSign: msg({ id: 'git.signing.cantSign', defaultMessage: 'Can’t sign: {message}', description: 'The Signing check’s result: signing failed, with the signer’s own words ({message}, in English).' }),
  notChecked: msg({ id: 'git.signing.notChecked', defaultMessage: '{why, select, program {Not checked: Combwork runs only the signing programs of Git for Windows, GnuPG and Windows’ OpenSSH by itself, not {path}.} keyCommand {Not checked: the key comes from a command (gpg.ssh.defaultKeyCommand), which Combwork doesn’t run by itself.} x509 {Not checked: Combwork can’t check X.509 signing.} other {Not checked: a hardware key asks for a touch, which Combwork can’t check.}} The merge queue’s commits still sign as usual, and pause if signing waits.', description: 'The Signing section when Combwork didn’t run the check: a program it doesn’t run by itself ({path}: its path), a key command, X.509, or a hardware key. Keep the select keys.' }),
  unreadable: msg({ id: 'git.signing.unreadable', defaultMessage: 'Combwork couldn’t read how this repository signs: {message}', description: 'The Signing section when git couldn’t read its settings; {message} is git’s own words.' }),
  howSsh: msg({ id: 'git.signing.howSsh', defaultMessage: 'To sign unattended with SSH, keep the key in the Windows OpenSSH agent: set the OpenSSH Authentication Agent service to start automatically and start it, run ssh-add with your key once, point user.signingkey at its .pub file, and set gpg.ssh.program to C:/Windows/System32/OpenSSH/ssh-keygen.exe (Git for Windows’ own ssh-keygen can’t reach that agent).', description: 'How-to under a Signing check that needs someone, for SSH signing. Keep ssh-add, user.signingkey, .pub, gpg.ssh.program and the path as they are; OpenSSH Authentication Agent is the Windows service’s name. HI-3110: Git for Windows’ ssh-keygen (its default) reads only SSH_AUTH_SOCK, never the Windows agent, so Windows’ own ssh-keygen must be the program.' }),
  howGpg: msg({ id: 'git.signing.howGpg', defaultMessage: 'To sign unattended with gpg, let gpg-agent keep the passphrase: set default-cache-ttl and max-cache-ttl in gpg-agent.conf, then sign once by hand (a commit of your own) to unlock it for that long.', description: 'How-to under a Signing check that needs someone, for OpenPGP signing. Keep gpg-agent, default-cache-ttl, max-cache-ttl and gpg-agent.conf as they are.' }),
  limits: msg({ id: 'git.signing.limits', defaultMessage: 'A check that succeeds says only that this signer signed just now. An agent already running, a smartcard or a hardware key may still ask in its own way.', description: 'A note under the Signing check: what a successful check means, and what Combwork can’t control.' })
}

/** The Signing section (read-only), checked when shown, at most once a minute unless Check again. */
export function GitSigning({ project }: { project: ProjectInfo }) {
  const [info, setInfo] = useState<SigningInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const check = useCallback(
    (force: boolean) => {
      setBusy(true)
      call('git:signing', project.path, force)
        .then((i) => {
          setInfo(i)
          setError(null)
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false))
    },
    [project.path]
  )
  useEffect(() => check(false), [check])
  if (!info && !error && !busy) return null
  const scope = (s: GitScope | null | undefined) => (s && s !== 'unknown' ? <span className="faint"> ({tr(M.scope, { scope: s })})</span> : null)
  const st = info?.status
  return (
    <div className="git-signing" data-git-signing={st?.kind ?? ''}>
      <h2 className="section git-section-head">
        {tr(M.heading)}
        {info && info.status.kind !== 'off' && (
          <span className="git-section-actions">
            <button className="btn small" data-action="signing-check" disabled={busy} onClick={() => check(true)}>
              <Icon name="refresh" /> {tr(busy ? M.checking : M.checkAgain)}
            </button>
          </span>
        )}
      </h2>
      {error && <div className="banner warn">{error}</div>}
      {info && (
        <table className="kv git-signing-table">
          <tbody>
            <tr>
              <td>{tr(M.signs)}</td>
              <td>
                {tr(info.sign?.value === 'true' ? M.yes : M.no)}
                {scope(info.sign?.scope)}
              </td>
            </tr>
            {info.sign?.value === 'true' && (
              <>
                <tr>
                  <td>{tr(M.format)}</td>
                  <td>
                    {tr(M.formatName, { format: info.format })}
                    {scope(info.formatScope)}
                  </td>
                </tr>
                <tr>
                  <td>{tr(M.key)}</td>
                  <td>
                    {info.key ? <code>{info.key.value}</code> : <span className="faint">{tr(M.defaultKey)}</span>}
                    {scope(info.key?.scope)}
                  </td>
                </tr>
                {info.program && (
                  <tr>
                    <td>{tr(M.program)}</td>
                    <td className="git-url">{info.program}</td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      )}
      {st && (
        <div className={st.kind === 'unattended' ? 'git-signing-status banner success' : st.kind === 'off' ? 'git-signing-status faint' : st.kind === 'notChecked' ? 'git-signing-status banner info' : 'git-signing-status banner warn'} data-signing-status={st.kind}>
          {st.kind === 'off' && tr(M.off)}
          {st.kind === 'unattended' && tr(M.unattended)}
          {st.kind === 'needsSomeone' && tr(M.needsSomeone)}
          {st.kind === 'couldNotComplete' && tr(M.couldNotComplete)}
          {st.kind === 'cantSign' && tr(M.cantSign, { message: st.message })}
          {st.kind === 'notChecked' && tr(M.notChecked, { why: st.why, path: st.path ?? '' })}
          {st.kind === 'unreadable' && tr(M.unreadable, { message: st.message })}
        </div>
      )}
      {st && (st.kind === 'needsSomeone' || st.kind === 'couldNotComplete') && <p className="faint git-signing-how">{tr(st.format === 'ssh' ? M.howSsh : M.howGpg)}</p>}
      {st && st.kind !== 'off' && st.kind !== 'unreadable' && <p className="faint git-signing-limits">{tr(M.limits)}</p>}
    </div>
  )
}
