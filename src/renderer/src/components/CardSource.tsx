import { useState } from 'react'
import { msg, tr } from '@shared/i18n'
import { outsideAuthor, prPushable } from '@shared/githubSource'
import type { TaskCard } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { set, showView } from '../store'
import { Icon } from './ui'

/**
 * A card's GitHub source in its dialog (HI-3551): the pull request or issue it is about, a link with GitHub's title (the
 * user's to read: outside text), and for a PR from a fork whose author didn't allow maintainer edits, that Combwork
 * can't push to it. While the card has never started (Todo, On Hold), the user sets it from an address or #number, or
 * removes it; main reads it from GitHub through gh and refuses anything else.
 */

const T = {
  label: msg({ id: 'board.dialog.source', defaultMessage: 'GitHub source', description: 'A field label in the card dialog (HI-3551): the GitHub pull request or issue the card is about.' }),
  kind: msg({ id: 'board.dialog.sourceKind', defaultMessage: '{kind, select, pr {Pull request} other {Issue}} #{number}', description: 'The card dialog’s GitHub source (HI-3551): its kind and number. Keep the select keys.' }),
  titled: msg({ id: 'board.dialog.sourceTitle', defaultMessage: 'On GitHub: “{title}”', description: 'The card dialog’s GitHub source (HI-3551): its title as GitHub has it (someone else’s words, quoted).' }),
  fork: msg({ id: 'board.dialog.sourceFork', defaultMessage: 'From a fork whose author doesn’t allow maintainer edits: Combwork can’t push fixes to it, so its findings go back as review comments.', description: 'Under a pull request source in the card dialog (HI-3551): the PR comes from a fork that doesn’t let maintainers push to it.' }),
  placeholder: msg({ id: 'board.dialog.sourcePlaceholder', defaultMessage: 'A pull request or issue: its address or #number', description: 'Placeholder of the card dialog’s GitHub source box (HI-3551).' }),
  set: msg({ id: 'board.dialog.sourceSet', defaultMessage: 'Set', description: 'A button beside the card dialog’s GitHub source box (HI-3551): reads the pull request or issue from GitHub and sets it as the card’s source.' }),
  remove: msg({ id: 'board.dialog.sourceRemove', defaultMessage: 'Remove', description: 'A button beside the card dialog’s GitHub source (HI-3551): removes it (only while the card hasn’t started).' }),
  open: msg({ id: 'board.dialog.sourceOpen', defaultMessage: 'Open on GitHub', description: 'Tooltip of the card dialog’s GitHub source link (HI-3551): opens the pull request or issue in the browser.' }),
  author: msg({ id: 'board.dialog.sourceAuthor', defaultMessage: 'Opened by {author}', description: 'The card dialog’s GitHub source (HI-3553): who opened the pull request or issue on GitHub. {author} is a GitHub user name.' }),
  outside: msg({ id: 'board.dialog.sourceOutside', defaultMessage: '{known, select, yes {{author} isn’t a member of {repo}} other {Combwork couldn’t tell whether {author} is a member of {repo}}}: this project’s checks run the pull request’s code on this PC, with your files and sign-ins. To run it apart from them, use Windows Sandbox: its server is in the MCP catalogue.', description: 'A warning under a pull request source in the card dialog (HI-3553, a warning, never a rule): its author isn’t one of the repository’s members (or GitHub couldn’t say), so its checks would run a stranger’s code. {author} a GitHub user name, {repo} owner/name. Keep the select keys. Windows Sandbox and MCP are product names.' }),
  outsideIssue: msg({ id: 'board.dialog.sourceOutsideIssue', defaultMessage: '{known, select, yes {{author} isn’t a member of {repo}} other {Combwork couldn’t tell whether {author} is a member of {repo}}}: what this issue says is someone else’s words, and reaches agents only quoted as such.', description: 'A warning under an issue source in the card dialog (HI-3555, a warning, never a rule): its author isn’t one of the repository’s members (or GitHub couldn’t say), so its text is a stranger’s. {author} a GitHub user name, {repo} owner/name. Keep the select keys.' }),
  catalogue: msg({ id: 'board.dialog.sourceCatalogue', defaultMessage: 'Open the MCP Catalogue', description: 'A button beside the card dialog’s outside-author warning (HI-3553): shows the MCP view’s Catalogue tab, where the Windows Sandbox server is.' }),
  failed: msg({ id: 'board.dialog.sourceFailed', defaultMessage: 'Couldn’t set the GitHub source', description: 'An error’s title (HI-3551): the card’s GitHub source couldn’t be set or removed; its message says why.' })
}

export function SourceField({ card, readOnly, onSet }: { card: TaskCard; readOnly: boolean; onSet?: (card: TaskCard) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const s = card.source
  // Only before its work starts (main checks again under the board's lock).
  const editable = !readOnly && (card.column === 'todo' || card.column === 'hold')
  const change = async (value: string | null): Promise<void> => {
    setBusy(true)
    const done = await actions.attempt(tr(T.failed), () => call('tasks:setSource', card.number, value))
    setBusy(false)
    if (done) {
      setText('')
      onSet?.(done)
    }
  }
  if (!s && !editable) return null
  // HI-3553 (HI-3541's decision: a warning, never a rule): a pull request whose author is outside the repository; HI-3555: an issue's.
  const outside = s ? outsideAuthor(s) : null
  return (
    <>
      <label>{tr(T.label)}</label>
      <div className="card-source" data-source={s ? `${s.kind}:${s.number}` : ''}>
        {s ? (
          <div className="card-source-now">
            <a href={s.url} title={tr(T.open)} onClick={(e) => (e.preventDefault(), void call('app:openExternal', s.url))}>
              <Icon name={s.kind === 'pr' ? 'git-pull-request' : 'issues'} /> {tr(T.kind, { kind: s.kind, number: s.number })} · {s.owner}/{s.repo}
            </a>
            {editable && (
              <button type="button" className="btn small subtle" data-action="source-remove" disabled={busy} onClick={() => void change(null)}>
                {tr(T.remove)}
              </button>
            )}
            {s.title && <div className="s-desc card-source-title">{tr(T.titled, { title: s.title })}</div>}
            {s.author && <div className="s-desc" data-source-author={s.author.login}>{tr(T.author, { author: s.author.login })}</div>}
            {!prPushable(s).ok && <div className="s-desc warn-text" data-source-note="fork">{tr(T.fork)}</div>}
            {outside && (
              <div className="s-desc warn-text" data-source-note="outside" data-outside={outside}>
                <Icon name="warning" /> {tr(s.kind === 'pr' ? T.outside : T.outsideIssue, { known: outside === 'outside' ? 'yes' : 'no', author: s.author?.login ?? '?', repo: `${s.owner}/${s.repo}` })}{' '}
                {s.kind === 'pr' && (
                  <button type="button" className="btn small subtle" data-action="open-mcp-catalogue" onClick={() => (showView('mcp'), set({ mcpTab: 'catalogue' }))}>
                    {tr(T.catalogue)}
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex">
            <input className="input" placeholder={tr(T.placeholder)} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && void change(text)} />
            <button type="button" className="btn small" data-action="source-set" disabled={busy || !text.trim()} onClick={() => void change(text)}>
              <Icon name={busy ? 'loading' : 'link'} spin={busy} /> {tr(T.set)}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
