import { useEffect, useRef, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import { COPILOT_GHES_PROXY, COPILOT_SAME_AS_REPO, GITHUB_COM, type GithubHostChange, type GithubHostKind, type GithubHostOrigin, type GithubHostsForm } from '@shared/githubHost'
import * as actions from '../actions'
import { call } from '../api'
import { useStore } from '../store'
import { ORIGIN_TEXT } from '../workflowOrigins'
import { OriginText } from './OriginText'

/**
 * The GitHub group (HI-2779, SPEC §11): where the repositories are (GitHub host) and where Copilot signs in, at the
 * workspace's level (Settings → Version Control → Workspace defaults) or a project's (its Version Control tab), each
 * showing its value as it resolves and where that comes from. Saved as changed; main parses every value again.
 */

const T = {
  heading: msg({ id: 'github.hosts.heading', defaultMessage: 'GitHub', description: 'A heading in the Version Control tab and in Settings → Version Control → Workspace defaults (HI-2779): the GitHub host settings. GitHub is a product name.' }),
  desc: msg({ id: 'github.hosts.desc', defaultMessage: 'Where the repositories are, and where Copilot signs in. Saved as you change them; running Copilot agents use a change when they restart.', description: 'Under the heading “GitHub” (HI-2779): what its two settings are, and that they save at once and apply at an agent’s restart.' }),
  host: msg({ id: 'github.hosts.host', defaultMessage: 'GitHub host', description: 'A setting (HI-2779): the host of the repositories: github.com, a GHE.com host (yourcompany.ghe.com) or a GitHub Enterprise Server.' }),
  hostDesc: msg({ id: 'github.hosts.hostDesc', defaultMessage: 'github.com, your GHE.com host (yourcompany.ghe.com) or your GitHub Enterprise Server’s name. Only the name: no path, port or token.', description: 'What the setting “GitHub host” takes (HI-2779). GHE.com is GitHub’s product name; keep the host names.' }),
  copilot: msg({ id: 'github.hosts.copilot', defaultMessage: 'Copilot signs in on', description: 'A setting (HI-2779): the GitHub host GitHub Copilot signs in on, which can differ from the repositories’ host.' }),
  copilotDesc: msg({ id: 'github.hosts.copilotDesc', defaultMessage: 'Usually the same as the GitHub host. With repositories on GitHub Enterprise Server, choose where your Copilot licence is: github.com or your GHE.com host.', description: 'What the setting “Copilot signs in on” is for (HI-2779). GHE.com is GitHub’s product name.' }),
  inherit: msg({ id: 'github.hosts.inherit', defaultMessage: 'Inherit', description: 'A button beside a GitHub setting set at this level (HI-2779): stop setting it here and use the inherited value.' }),
  inheritOption: msg({ id: 'github.hosts.inheritOption', defaultMessage: 'Inherit ({value})', description: 'An option of “Copilot signs in on” (HI-2779): use the inherited choice. {value} is what that gives (a host, or a note).' }),
  sameOption: msg({ id: 'github.hosts.sameOption', defaultMessage: 'Same as the GitHub host', description: 'An option of “Copilot signs in on” (HI-2779): Copilot signs in on the repositories’ host.' }),
  otherOption: msg({ id: 'github.hosts.otherOption', defaultMessage: 'A GHE.com host…', description: 'An option of “Copilot signs in on” (HI-2779): a host of GitHub Enterprise Cloud with data residency (yourcompany.ghe.com), typed in. GHE.com is GitHub’s product name.' }),
  noneChosen: msg({ id: 'github.hosts.noneChosen', defaultMessage: 'none chosen', description: 'In the option “Inherit (…)” of “Copilot signs in on” (HI-2779): what inheriting gives when the repositories are on GitHub Enterprise Server and nothing is chosen above (lower case, inside brackets).' }),
  proxyOption: msg({ id: 'github.hosts.proxyOption', defaultMessage: 'GitHub Enterprise Server’s Copilot proxy (not supported yet)', description: 'An option of “Copilot signs in on” (HI-2779): GitHub Enterprise Server’s Copilot proxy, a GitHub preview Combwork doesn’t support yet.' }),
  choose: msg({ id: 'github.hosts.choose', defaultMessage: '{host} is a GitHub Enterprise Server: choose where Copilot signs in. Copilot agents don’t start until you do.', description: 'Under “Copilot signs in on” (HI-2779): the repositories are on a GitHub Enterprise Server host ({host}), where cloud Copilot can’t sign in, and nothing is chosen.' }),
  proxy: msg({ id: 'github.hosts.proxy', defaultMessage: 'Not supported yet: Copilot agents don’t start. Choose github.com or your GHE.com host.', description: 'Under “Copilot signs in on” (HI-2779) when GitHub Enterprise Server’s Copilot proxy is chosen. GHE.com is GitHub’s product name.' }),
  environment: msg({ id: 'github.hosts.fromEnvironment', defaultMessage: 'From Combwork’s environment (GH_HOST, COPILOT_GH_HOST)', description: 'Where a GitHub host comes from (HI-2779): environment variables Combwork was started with. Keep the variable names.' }),
  saveFailed: msg({ id: 'github.hosts.saveFailed', defaultMessage: 'Couldn’t save the GitHub host', description: 'An error’s title (HI-2779): a GitHub host setting couldn’t be saved (its message says why).' }),
  kind: {
    github: msg({ id: 'github.hosts.kind.github', defaultMessage: 'github.com', description: 'The kind of a GitHub host (HI-2779): github.com itself.' }),
    'ghe-cloud': msg({ id: 'github.hosts.kind.gheCloud', defaultMessage: 'GitHub Enterprise Cloud with data residency', description: 'The kind of a GitHub host (HI-2779): a GHE.com host (GitHub product name).' }),
    ghes: msg({ id: 'github.hosts.kind.ghes', defaultMessage: 'GitHub Enterprise Server', description: 'The kind of a GitHub host (HI-2779): a company’s own GitHub Enterprise Server (GitHub product name).' })
  } satisfies Record<GithubHostKind, ReturnType<typeof msg>>
}

/** Where a value comes from, in the workflow options' words (environment: Combwork's own). */
function Origin({ origin }: { origin: GithubHostOrigin }) {
  if (origin === 'environment') return <>{tr(T.environment)}</>
  if (origin === 'default') return <>{tr(ORIGIN_TEXT.platform)}</>
  if (origin === 'project') return <>{tr(ORIGIN_TEXT.project)}</>
  return <OriginText origin="workspace" />
}

export function GithubHosts({ projectPath }: { projectPath: string | null }) {
  const [form, setForm] = useState<GithubHostsForm | null>(null)
  const [shown, setShown] = useState(0)
  const [other, setOther] = useState(false)
  // Read again when the workspace or the project changes, from here or elsewhere; only the latest read or save counts.
  const wsGithub = useStore((s) => s.workspace?.config.github)
  const projectGithub = useStore((s) => (projectPath ? s.workspace?.projects.find((p) => p.path === projectPath)?.config.github : undefined))
  const latest = useRef(0)
  useEffect(() => {
    const n = ++latest.current
    void call('github:form', projectPath).then(
      (f) => n === latest.current && setForm(f),
      () => n === latest.current && setForm(null)
    )
  }, [projectPath, wsGithub, projectGithub])
  useEffect(
    () => () => {
      latest.current++
    },
    []
  )
  const save = async (change: GithubHostChange): Promise<void> => {
    const n = ++latest.current
    const next = await actions.attempt(tr(T.saveFailed), () => call('github:set', projectPath, change))
    if (next && n === latest.current) setForm(next)
    else if (!next) setShown((x) => x + 1)
    await actions.refreshWorkspace()
  }
  if (!form) return null
  const level = projectPath ? 'project' : 'workspace'
  const ownHost = form.own.host
  const ownCop = form.own.copilotHost
  const inh = form.inherited
  const res = form.resolved
  const kindText = (k: GithubHostKind | null): string => (k ? tr(T.kind[k]) : '')
  const copValue = ownCop === undefined ? 'inherit' : ownCop === COPILOT_SAME_AS_REPO || ownCop === COPILOT_GHES_PROXY || ownCop === GITHUB_COM ? ownCop : 'other'
  const inheritedCop = inh.copilot.host ?? tr(inh.copilot.problem === 'ghesProxyUnsupported' ? T.proxyOption : T.noneChosen)
  return (
    <section className="workflow-group workflow-github" data-group="github" data-level={level}>
      <h3 className="workflow-group-h">{tr(T.heading)}</h3>
      <div className="s-desc">{tr(T.desc)}</div>
      <div className="setting" data-github-option="host">
        <div className="s-text">
          <div className="s-title">
            {ownHost !== undefined && <span className="modified" />}
            {tr(T.host)}
          </div>
          <div className="s-desc">{tr(T.hostDesc)}</div>
          <div className="s-desc workflow-origin" data-origin={ownHost !== undefined ? level : res.repo.origin} data-host={res.repo.host} data-kind={res.repo.kind}>
            {ownHost !== undefined ? tr(projectPath ? ORIGIN_TEXT.project : ORIGIN_TEXT.here) : <Origin origin={res.repo.origin} />}: {res.repo.host} · {kindText(res.repo.kind)}
            {ownHost !== undefined && (
              <button className="btn subtle small workflow-inherit" data-action="inherit-host" onClick={() => void save({ host: null })}>
                {tr(T.inherit)}
              </button>
            )}
          </div>
        </div>
        <div className="s-control">
          <HostField key={`host-${shown}`} value={ownHost ?? ''} placeholder={inh.repo.host} label={tr(T.host)} onCommit={(v) => void save({ host: v.trim() ? v : null })} />
        </div>
      </div>
      <div className="setting" data-github-option="copilot">
        <div className="s-text">
          <div className="s-title">
            {ownCop !== undefined && <span className="modified" />}
            {tr(T.copilot)}
          </div>
          <div className="s-desc">{tr(T.copilotDesc)}</div>
          <div className="s-desc workflow-origin" data-origin={ownCop !== undefined ? level : res.copilot.origin} data-host={res.copilot.host ?? ''} data-problem={res.copilot.problem ?? ''}>
            {res.copilot.problem === 'chooseCopilotHost' ? (
              <span className="warn-text">{tr(T.choose, { host: res.repo.host })}</span>
            ) : res.copilot.problem === 'ghesProxyUnsupported' ? (
              <span className="warn-text">{tr(T.proxy)}</span>
            ) : (
              <>
                {ownCop !== undefined ? tr(projectPath ? ORIGIN_TEXT.project : ORIGIN_TEXT.here) : <Origin origin={res.copilot.origin} />}: {res.copilot.host} · {kindText(res.copilot.kind)}
              </>
            )}
          </div>
        </div>
        <div className="s-control">
          <select
            className="input"
            aria-label={tr(T.copilot)}
            data-github-copilot={copValue}
            value={other && copValue !== 'other' ? 'other' : copValue}
            onChange={(e) => {
              const v = e.target.value
              setOther(v === 'other')
              if (v === 'inherit') void save({ copilotHost: null })
              else if (v !== 'other') void save({ copilotHost: v })
            }}
          >
            <option value="inherit">{tr(T.inheritOption, { value: inheritedCop })}</option>
            <option value={COPILOT_SAME_AS_REPO}>{tr(T.sameOption)}</option>
            <option value={GITHUB_COM}>{GITHUB_COM}</option>
            <option value="other">{tr(T.otherOption)}</option>
            <option value={COPILOT_GHES_PROXY}>{tr(T.proxyOption)}</option>
          </select>
          {(copValue === 'other' || other) && <HostField key={`cop-${shown}`} value={copValue === 'other' ? (ownCop ?? '') : ''} placeholder="yourcompany.ghe.com" label={tr(T.otherOption)} onCommit={(v) => v.trim() && void save({ copilotHost: v })} />} {/* i18n-ignore: an example host name */}
        </div>
      </div>
    </section>
  )
}

/** A host typed in, taken when it loses focus or on Enter. */
function HostField({ value, placeholder, label, onCommit }: { value: string; placeholder: string; label: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  const typed = useRef(false)
  useEffect(() => {
    if (!typed.current) setText(value)
  }, [value])
  const commit = (): void => {
    if (typed.current && text !== value) onCommit(text)
    typed.current = false
  }
  return (
    <input
      className="input mono"
      aria-label={label}
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => {
        typed.current = true
        setText(e.target.value)
      }}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}
