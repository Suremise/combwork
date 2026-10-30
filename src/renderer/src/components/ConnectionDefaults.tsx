import { useCallback, useEffect, useState } from 'react'
import type { AccountView } from '@shared/accounts'
import type { MovedNotice } from '@shared/connectionDefaults'
import { providerDescriptor } from '@shared/providers'
import { effortName, modelCaps } from '@shared/models'
import { serverDefaultModel } from '@shared/serverConnection'
import { modelLabel } from '@shared/defaults'
import { msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { notify, useStore } from '../store'
import { EffortPicker, ModelPicker } from './ModelPicker'
import { Icon } from './ui'

/**
 * A connection's defaults for the agents on it (HI-1770: model, effort and context belong to the connection), in
 * Settings → Connections, and the one-time notice of values moved onto agents that their connection can't use.
 */

const M = {
  defaults: msg({ id: 'settings.accounts.defaults', defaultMessage: 'Defaults for agents on it', description: "A button opening a connection's defaults (Settings → Connections; HI-1770): the model, effort and context an agent on it runs with when it has none of its own." }),
  model: msg({ id: 'settings.accounts.defaults.model', defaultMessage: 'Model', description: "Label of a connection's default model (Settings → Connections → Defaults for agents on it)." }),
  effort: msg({ id: 'settings.accounts.defaults.effort', defaultMessage: 'Effort', description: "Label of a connection's default effort (reasoning) (Settings → Connections → Defaults for agents on it)." }),
  context: msg({ id: 'settings.accounts.defaults.context', defaultMessage: 'Use 200K context (instead of 1M)', description: "Label of a connection's default context choice (Settings → Connections → Defaults for agents on it): hold sessions to a 200K-token window instead of the model's 1M one." }),
  cliDefault: msg({ id: 'settings.provider.cliDefault', defaultMessage: '{provider} default', description: "The first choice of a model or effort list: the CLI's own default. {provider} is its name." }),
  cliDefaultIs: msg({ id: 'settings.provider.cliDefaultIs', defaultMessage: '{provider} default ({which})', description: "The first choice of a model or effort list: the CLI's own default, and which model or level that is. {provider} is its name." }),
  on: msg({ id: 'agents.overrides.on', defaultMessage: 'On', description: "A choice of an agent's Use 200K context setting. Keep it short." }),
  off: msg({ id: 'agents.overrides.off', defaultMessage: 'Off', description: "A choice of an agent's Use 200K context setting. Keep it short." }),
  copied: msg({ id: 'settings.accounts.defaults.copied', defaultMessage: "Copied from Settings → {cli} when it was added. Change them here.", description: "Under a connection's defaults (Settings → Connections; HI-1770) while they are still the CLI's as copied ({cli}: \"Claude Code\"). Settings → {cli} names a section." }),
  failed: msg({ id: 'settings.accounts.defaults.failed', defaultMessage: "Couldn't change the connection's defaults", description: "An error's title (Settings → Connections; HI-1770): saving a connection's default model, effort or context failed." }),
  noticeTitle: msg({ id: 'settings.accounts.notice.title', defaultMessage: "Some settings moved onto agents can't be used by their connection", description: "A notice's title (Settings → Connections; HI-1770): a project's own model, effort or context settings were moved onto its agents (connections hold the defaults now), and some of them the agent's connection can't use: they are kept on the agent but not used." }),
  noticeLine: msg({ id: 'settings.accounts.notice.line', defaultMessage: '{project} · {agent}: {setting}', description: "A line of the notice of moved settings a connection can't use (Settings → Connections; HI-1770): the project, the agent and the setting with its value (\"Effort: high\")." }),
  effortIs: msg({ id: 'settings.accounts.notice.effort', defaultMessage: "Effort {value} (its model doesn't take it)", description: "A moved setting in the notice (Settings → Connections; HI-1770): an effort level ({value}) the agent's model doesn't offer, kept on the agent but not used." }),
  contextIs: msg({ id: 'settings.accounts.notice.context', defaultMessage: "Use 200K context: {value} (its CLI has no such choice)", description: "A moved setting in the notice (Settings → Connections; HI-1770): a context choice the agent's CLI doesn't have, kept on the agent but not used. {value} is On or Off." }),
  modelIs: msg({ id: 'settings.accounts.notice.model', defaultMessage: 'Model {value}', description: "A moved setting in the notice (Settings → Connections; HI-1770): a model, kept on the agent." }),
  noticeHint: msg({ id: 'settings.accounts.notice.hint', defaultMessage: "They stay on the agents, unused. Change them in each agent's Agent Settings.", description: "Under the notice of moved settings a connection can't use (Settings → Connections; HI-1770). Agent Settings names a dialog." }),
  dismiss: msg({ id: 'settings.accounts.notice.dismiss', defaultMessage: 'Dismiss', description: "Button (Settings → Connections; HI-1770): hides the notice of moved settings for good." })
}

/** A connection's defaults, opened from its row: model, effort and context (each hidden where its CLI or model has none). */
export function ConnectionDefaultsEditor({ connection: c }: { connection: AccountView }) {
  const [open, setOpen] = useState(false)
  const settings = useStore((s) => s.settings)
  const info = useStore((s) => s.providers[c.provider])
  const p = providerDescriptor(c.provider)
  const d = c.defaults ?? {}
  const save = (patch: { model?: string | null; effort?: string | null; use200kContext?: boolean | null }): void => {
    call('connections:setDefaults', c.id, patch).catch((e) => notify('error', tr(M.failed), errorMessage(e)))
  }
  // A server connection's (HI-1772): its own models, its default the one standing in for Opus; no effort or context.
  const server = c.kind === 'server'
  const cliModel = server ? (serverDefaultModel(c.server?.models ?? []) ?? null) : (info?.defaultModel ?? null)
  const runModel = d.model || cliModel
  const defEffort = modelCaps(c.provider, runModel, info, settings).defaultEffort
  if (server)
    return (
      <div className="connection-defaults" data-defaults={c.id}>
        <button className="btn subtle small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} /> {tr(M.defaults)}
        </button>
        {open && (
          <div className="agent-form connection-defaults-form">
            <label>{tr(M.model)}</label>
            <ModelPicker provider={c.provider} connection={c} value={d.model ?? ''} base={{ value: '', label: cliModel ? tr(M.cliDefaultIs, { provider: c.name, which: cliModel }) : tr(M.cliDefault, { provider: c.name }) }} onChange={(v) => save({ model: v || null })} />
          </div>
        )}
      </div>
    )
  return (
    <div className="connection-defaults" data-defaults={c.id}>
      <button className="btn subtle small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} /> {tr(M.defaults)}
      </button>
      {open && (
        <div className="agent-form connection-defaults-form">
          <label>{tr(M.model)}</label>
          <ModelPicker provider={c.provider} connection={c} value={d.model ?? ''} base={{ value: '', label: cliModel ? tr(M.cliDefaultIs, { provider: p.name, which: modelLabel(cliModel, c.provider) }) : tr(M.cliDefault, { provider: p.name }) }} onChange={(v) => save({ model: v || null })} />
          <label>{tr(M.effort)}</label>
          <EffortPicker provider={c.provider} connection={c} model={runModel} value={d.effort ?? ''} base={{ value: '', label: defEffort ? tr(M.cliDefaultIs, { provider: p.name, which: effortName(c.provider, defEffort, settings, tr) }) : tr(M.cliDefault, { provider: p.name }) }} onChange={(v) => save({ effort: v || null })} />
          {p.capabilities.contextLimit && (
            <>
              <label>{tr(M.context)}</label>
              <select className="select" aria-label={tr(M.context)} value={d.use200kContext === undefined ? '' : d.use200kContext ? 'on' : 'off'} onChange={(e) => save({ use200kContext: e.target.value ? e.target.value === 'on' : null })}>
                <option value="">{tr(M.cliDefaultIs, { provider: p.name, which: tr(M.off) })}</option>
                <option value="on">{tr(M.on)}</option>
                <option value="off">{tr(M.off)}</option>
              </select>
            </>
          )}
          {c.defaultsFrom === 'cli' && <div className="hint span2">{tr(M.copied, { cli: p.name })}</div>}
        </div>
      )}
    </div>
  )
}

/** The moved settings this window's workspace's agents can't use on their connection: listed once, until dismissed. */
export function MovedNoticeBanner() {
  const changed = useStore((s) => s.connectionsChanged)
  const wsPath = useStore((s) => s.workspace?.path ?? null)
  const projects = useStore((s) => s.workspace?.projects)
  const [entries, setEntries] = useState<MovedNotice[]>([])
  const load = useCallback(() => {
    call('connections:notice')
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [])
  useEffect(load, [load, changed, wsPath, projects])
  if (!entries.length) return null
  const setting = (n: MovedNotice): string => (n.field === 'effort' ? tr(M.effortIs, { value: String(n.value) }) : n.field === 'use200kContext' ? tr(M.contextIs, { value: tr(n.value ? M.on : M.off) }) : tr(M.modelIs, { value: String(n.value) }))
  return (
    <div className="banner warn connections-notice" data-moved-notice>
      <div>
        <Icon name="warning" /> {tr(M.noticeTitle)}
        <ul>
          {entries.map((n) => (
            <li key={n.key} data-moved={n.key}>
              {tr(M.noticeLine, { project: n.project, agent: n.agent, setting: setting(n) })}
            </li>
          ))}
        </ul>
        <div className="hint">{tr(M.noticeHint)}</div>
      </div>
      <button className="btn small" onClick={() => void call('connections:dismissNotice', entries.map((n) => n.key)).then(load).catch((e) => notify('error', tr(M.failed), errorMessage(e)))}>
        {tr(M.dismiss)}
      </button>
    </div>
  )
}
