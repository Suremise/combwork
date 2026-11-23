import { useEffect, useRef, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import type { GhStatus, GithubLink as Link } from '@shared/githubRepo'
import * as actions from '../actions'
import { call } from '../api'
import { useStore } from '../store'
import { CodeText, Icon } from './ui'

/**
 * A Git project's GitHub link (HI-3550), atop Version Control → Workflow → GitHub: its repository on the GitHub host
 * (from its remotes, origin first, or the one chosen here when several are on the host) and the GitHub CLI's sign-in
 * there, with the command to run when gh is missing or signed out, and Check Again. No link: no GitHub feature shows.
 */

const T = {
  heading: msg({ id: 'github.link.heading', defaultMessage: 'Repository on GitHub', description: 'A heading in Version Control → Workflow → GitHub (HI-3550): the project’s repository on its GitHub host, and the GitHub CLI’s sign-in there. GitHub is a product name.' }),
  desc: msg({ id: 'github.link.desc', defaultMessage: 'Combwork works with GitHub through your own GitHub CLI (gh) and its sign-in, on the GitHub host below. It stores no token.', description: 'Under the heading “Repository on GitHub” (HI-3550): how Combwork reaches GitHub. GitHub CLI is a product name, gh a command: keep them.' }),
  repository: msg({ id: 'github.link.repository', defaultMessage: 'Repository', description: 'A row’s title in Version Control → Workflow → GitHub (HI-3550): the project’s repository on GitHub.' }),
  linked: msg({ id: 'github.link.linked', defaultMessage: 'On {host}, from the remote {remote}.', description: 'Under the repository’s name (HI-3550): its host and the git remote it was read from. {host} is a host name, {remote} a remote’s name (origin).' }),
  choose: msg({ id: 'github.link.choose', defaultMessage: 'Several remotes are on {host}: choose the project’s repository.', description: 'Under “Repository” (HI-3550) when more than one git remote points at a repository on the GitHub host and none is chosen yet. {host} is a host name.' }),
  remote: msg({ id: 'github.link.remote', defaultMessage: 'Remote', description: 'The accessible name of the list choosing which git remote’s repository is the project’s (HI-3550).' }),
  chooseOne: msg({ id: 'github.link.chooseOne', defaultMessage: 'Choose…', description: 'The first entry of the list choosing which git remote’s repository is the project’s (HI-3550), before one is chosen.' }),
  remoteOption: msg({ id: 'github.link.remoteOption', defaultMessage: '{remote}: {repo}', description: 'An entry of the list choosing the project’s repository (HI-3550): a git remote’s name and its repository (owner/name).' }),
  none: msg({ id: 'github.link.none', defaultMessage: 'No remote of this project is on {host}, so it has no GitHub link and Combwork’s GitHub features don’t show. Add one in Branches & remotes, or change the GitHub host below.', description: 'Under “Repository” (HI-3550) when no git remote points at a repository on the GitHub host. {host} is a host name. Branches & remotes is a Version Control section: as translated there.' }),
  cli: msg({ id: 'github.link.cli', defaultMessage: 'GitHub CLI', description: 'A row’s title in Version Control → Workflow → GitHub (HI-3550): the GitHub CLI (gh) and its sign-in. Product name.' }),
  checking: msg({ id: 'github.link.checking', defaultMessage: 'Checking…', description: 'Under “GitHub CLI” (HI-3550) while Combwork asks gh about its sign-in.' }),
  signedIn: msg({ id: 'github.link.signedIn', defaultMessage: 'Signed in on {host} as {login}.', description: 'Under “GitHub CLI” (HI-3550): gh is signed in on the host. {host} is a host name, {login} a GitHub user name.' }),
  version: msg({ id: 'github.link.version', defaultMessage: 'gh {version}', description: 'After the GitHub CLI’s state (HI-3550): its version. Keep gh.' }),
  missing: msg({ id: 'github.link.missing', defaultMessage: 'The GitHub CLI isn’t installed. Install it with `winget install GitHub.cli` in a terminal, then sign in and choose Check Again.', description: 'Under “GitHub CLI” (HI-3550): gh isn’t on the PATH. `…` marks a command: keep it exactly. Check Again is the button beside it: as translated there.' }),
  signedOut: msg({ id: 'github.link.signedOut', defaultMessage: 'The GitHub CLI isn’t signed in on {host}. Sign in with `gh auth login --hostname {host}` in a terminal, then choose Check Again. Combwork never signs in for you.', description: 'Under “GitHub CLI” (HI-3550): gh has no working sign-in on the host. {host} is a host name. `…` marks a command: keep it exactly. Check Again is the button beside it: as translated there.' }),
  timeout: msg({ id: 'github.link.timeout', defaultMessage: 'The GitHub CLI didn’t answer in time. Choose Check Again.', description: 'Under “GitHub CLI” (HI-3550): gh didn’t answer within Settings → Advanced’s limit. Check Again is the button beside it.' }),
  failed: msg({ id: 'github.link.failed', defaultMessage: 'The GitHub CLI couldn’t check its sign-in on {host}.', description: 'Under “GitHub CLI” (HI-3550): gh failed in another way; its own words follow. {host} is a host name.' }),
  gh: msg({ id: 'github.link.ghSays', defaultMessage: 'gh says: {error}', description: 'After a GitHub CLI problem (HI-3550): gh’s own words, in English as gh writes them. Keep gh.' }),
  again: msg({ id: 'github.link.again', defaultMessage: 'Check Again', description: 'A button in Version Control → Workflow → GitHub (HI-3550): asks the GitHub CLI about its sign-in again, after installing or signing in.' }),
  open: msg({ id: 'github.link.open', defaultMessage: 'Open {repo} on {host}', description: 'The tooltip and accessible name of the project’s repository name, a link (HI-3550): opens its page in the browser. {repo} is owner/name, {host} a host name.' }),
  chooseFailed: msg({ id: 'github.link.chooseFailed', defaultMessage: 'Couldn’t choose the repository', description: 'An error’s title (HI-3550): the remote chosen as the project’s repository couldn’t be saved; its message says why.' }),
  readFailed: msg({ id: 'github.link.readFailed', defaultMessage: 'Couldn’t read the project’s GitHub link: {error}', description: 'Under “Repository on GitHub” (HI-3550) when reading the link failed. {error} says why.' })
}

/** gh's state in words: signed in, or what to do. */
function GhState({ gh }: { gh: GhStatus }) {
  const ver = gh.version ? ` · ${tr(T.version, { version: gh.version })}` : ''
  if (gh.state === 'signedIn') return <span data-gh-state="signedIn">{tr(T.signedIn, { host: gh.host, login: gh.login ?? '' })}{ver}</span>
  const words = gh.state === 'missing' ? T.missing : gh.state === 'signedOut' ? T.signedOut : gh.state === 'timeout' ? T.timeout : T.failed
  return (
    <span className="warn-text" data-gh-state={gh.state}>
      <CodeText text={tr(words, { host: gh.host })} />
      {gh.error && <span className="faint"> {tr(T.gh, { error: gh.error })}</span>}
    </span>
  )
}

export function GithubLink({ projectPath }: { projectPath: string }) {
  const [link, setLink] = useState<Link | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Read again when the project's GitHub settings change (its host), from here or elsewhere; only the latest read counts.
  const github = useStore((s) => JSON.stringify([s.workspace?.config.github ?? null, s.workspace?.projects.find((p) => p.path === projectPath)?.config.github ?? null]))
  const latest = useRef(0)
  const read = (): void => {
    const n = ++latest.current
    setBusy(true)
    void call('github:link', projectPath).then(
      (l) => {
        if (n !== latest.current) return
        setLink(l)
        setError(null)
        setBusy(false)
      },
      (e: unknown) => {
        if (n !== latest.current) return
        setError(e instanceof Error ? e.message : String(e))
        setBusy(false)
      }
    )
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(read, [projectPath, github])
  useEffect(
    () => () => {
      latest.current++
    },
    []
  )
  const choose = async (remote: string | null): Promise<void> => {
    const n = ++latest.current
    const next = await actions.attempt(tr(T.chooseFailed), () => call('github:setRemote', projectPath, remote))
    if (next && n === latest.current) setLink(next)
  }
  const host = link?.host ?? ''
  const several = (link?.candidates.length ?? 0) > 1
  return (
    <section className="workflow-group workflow-github-link" data-group="githubLink" data-linked={link?.linked ? `${link.linked.owner}/${link.linked.repo}` : ''}>
      <h3 className="workflow-group-h">{tr(T.heading)}</h3>
      <div className="s-desc">{tr(T.desc)}</div>
      {error && <div className="s-desc error">{tr(T.readFailed, { error })}</div>}
      {link && (
        <div className="setting" data-github-link="repository">
          <div className="s-text">
            <div className="s-title">{tr(T.repository)}</div>
            {link.linked ? (
              <div className="s-desc">
                <a className="mono" href={link.linked.url} title={tr(T.open, { repo: `${link.linked.owner}/${link.linked.repo}`, host })} aria-label={tr(T.open, { repo: `${link.linked.owner}/${link.linked.repo}`, host })} onClick={(e) => (e.preventDefault(), void call('app:openExternal', link.linked!.url))}>
                  {link.linked.owner}/{link.linked.repo}
                </a>{' '}
                {tr(T.linked, { host, remote: link.linked.remote })}
              </div>
            ) : several ? (
              <div className="s-desc warn-text" data-github-link-state="choose">{tr(T.choose, { host })}</div>
            ) : (
              <div className="s-desc" data-github-link-state="none">{tr(T.none, { host })}</div>
            )}
          </div>
          {several && (
            <div className="s-control">
              <select className="input" aria-label={tr(T.remote)} data-github-remote={link.linked?.remote ?? ''} value={link.linked?.remote ?? ''} onChange={(e) => void choose(e.target.value || null)}>
                {!link.linked && <option value="">{tr(T.chooseOne)}</option>}
                {link.candidates.map((c) => (
                  <option key={c.remote} value={c.remote}>
                    {tr(T.remoteOption, { remote: c.remote, repo: `${c.owner}/${c.repo}` })}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
      <div className="setting" data-github-link="cli">
        <div className="s-text">
          <div className="s-title">{tr(T.cli)}</div>
          <div className="s-desc">{busy && !link ? tr(T.checking) : link ? <GhState gh={link.gh} /> : null}</div>
        </div>
        <div className="s-control">
          <button className="btn small" data-action="gh-check-again" disabled={busy} onClick={read}>
            <Icon name={busy ? 'loading' : 'refresh'} spin={busy} /> {tr(T.again)}
          </button>
        </div>
      </div>
    </section>
  )
}
