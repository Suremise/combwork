import { useCallback, useEffect, useState } from 'react'
import type { Account, AppSettings, Connection, EffortLevel, PermissionMode, ProviderId } from '@shared/types'
import type { ConnectionPatch, ConnectionRow, ConnectionsView } from '@shared/accounts'
import type { MovedNotice } from '@shared/connectionDefaults'
import { modeCaveat, modeOption, offeredModes, permissionLabel, providerDescriptor } from '@shared/providers'
import { effortName, modelCaps } from '@shared/models'
import { serverDefaultModel } from '@shared/serverConnection'
import { modelLabel } from '@shared/defaults'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { notify, useLanguage, useStore } from '../store'
import { EffortPicker, ModelPicker } from './ModelPicker'
import { Icon, Modal } from './ui'

/**
 * A connection (HI-2106, HI-2107): the named setup on an account that agents and the Assistant choose. Its dialog (Add
 * Connection and Edit, in Settings → Accounts & Connections and from Add Agent), the summary of its values its rows show,
 * and the one-time notice of values moved onto agents that their connection can't use (HI-1770).
 */

const M = {
  addTitle: msg({ id: 'settings.connection.addTitle', defaultMessage: '{account} ({cli}): new connection', description: 'Title of the dialog adding a connection (HI-2107) on an account ({account}, its name; {cli}, its coding agent CLI: "Claude Code").' }),
  editTitle: msg({ id: 'settings.connection.editTitle', defaultMessage: '{account} ({cli}): connection', description: 'Title of the dialog editing a connection (HI-2107): its account ({account}) and its coding agent CLI ({cli}). Its name is in the Name field below, so the title leaves it out.' }),
  name: msg({ id: 'settings.connection.name', defaultMessage: 'Name', description: "Label of a connection's name in its dialog (HI-2107)." }),
  namePlaceholder: msg({ id: 'settings.connection.namePlaceholder', defaultMessage: 'Claude · High, Reviewer, Plan…', description: "Placeholder of a connection's name box: examples of names." }),
  model: msg({ id: 'settings.connection.model', defaultMessage: 'Model', description: "Label of a connection's model in its dialog (HI-2107)." }),
  effort: msg({ id: 'settings.connection.effort', defaultMessage: 'Effort', description: "Label of a connection's reasoning effort in its dialog (HI-2107)." }),
  context: msg({ id: 'settings.connection.context', defaultMessage: 'Context', description: "Label of a connection's context window choice in its dialog (HI-2107): 1M tokens or 200K." }),
  context1m: msg({ id: 'settings.connection.context1m', defaultMessage: "1M (the model's)", description: "A choice of a connection's context: the model's own 1M-token window. 1M is a number of tokens." }),
  context200k: msg({ id: 'settings.connection.context200k', defaultMessage: '200K', description: "A choice of a connection's context: a 200K-token window, which compacts sooner. 200K is a number of tokens." }),
  mode: msg({ id: 'settings.connection.mode', defaultMessage: 'Permission mode', description: "Label of a connection's permission mode in its dialog (HI-2107)." }),
  args: msg({ id: 'settings.connection.args', defaultMessage: 'Extra arguments', description: "Label of a connection's extra command-line arguments in its dialog (HI-2107)." }),
  argsHint: msg({ id: 'settings.connection.argsHint', defaultMessage: 'Added to {cli} when an agent on it starts.', description: "Under a connection's extra arguments: they are added to the coding agent CLI's command line ({cli}: its command, such as claude)." }),
  cliDefault: msg({ id: 'settings.provider.cliDefault', defaultMessage: '{provider} default', description: "The first choice of a model or effort list: the CLI's own default. {provider} is its name." }),
  cliDefaultIs: msg({ id: 'settings.provider.cliDefaultIs', defaultMessage: '{provider} default ({which})', description: "The first choice of a model or effort list: the CLI's own default, and which model or level that is. {provider} is its name." }),
  usedBy: msg({ id: 'settings.connection.usedBy', defaultMessage: 'In use: {users}. Running ones are offered Restart once you save (Switch Now for a new permission mode).', description: 'In the dialog editing a connection (HI-2107): who uses it ({users}: agents and the Assistant, listed), and that running ones are offered a restart, or a live switch for a mode change.' }),
  userIn: msg({ id: 'settings.connection.userIn', defaultMessage: '{agent} ({project})', description: 'One user of a connection in a list (HI-2107): an agent and its project.' }),
  save: msg({ id: 'settings.connection.save', defaultMessage: 'Save', description: "The confirm button of a connection's dialog." }),
  add: msg({ id: 'settings.connection.add', defaultMessage: 'Add', description: 'The confirm button of the dialog adding a connection.' }),
  saving: msg({ id: 'settings.connection.saving', defaultMessage: 'Saving…', description: "The confirm button of a connection's dialog while it saves." }),
  cancel: msg({ id: 'settings.connection.cancel', defaultMessage: 'Cancel', description: "A connection's dialog's button that closes it without saving." }),
  needName: msg({ id: 'settings.connection.needName', defaultMessage: 'Give it a name.', description: "A connection's dialog's error while its name box is empty." }),
  gone: msg({ id: 'settings.connection.gone', defaultMessage: 'It was removed meanwhile.', description: "A connection's dialog when its connection or account no longer exists." }),
  // Its values in a line (its row, a picker): each unset says the CLI decides.
  modelDefault: msg({ id: 'settings.connection.summary.model', defaultMessage: 'Model: CLI default', description: "In a connection's summary line (Settings → Accounts & Connections, HI-2107): no model chosen, the CLI's own default runs." }),
  effortDefault: msg({ id: 'settings.connection.summary.effort', defaultMessage: 'Effort: CLI default', description: "In a connection's summary line: no effort chosen, the CLI's own default." }),
  modeDefault: msg({ id: 'settings.connection.summary.mode', defaultMessage: 'Mode: CLI default', description: "In a connection's summary line: no permission mode chosen, the CLI's own default." }),
  args200k: msg({ id: 'settings.connection.summary.200k', defaultMessage: '200K context', description: "In a connection's summary line: it holds sessions to a 200K-token window." }),
  extra: msg({ id: 'settings.connection.summary.args', defaultMessage: 'Arguments: {args}', description: "In a connection's summary line: its extra command-line arguments ({args}, as typed)." }),
  effortUnusable: msg({ id: 'settings.connection.effortUnusable', defaultMessage: "{model} doesn't take {effort} effort any more: agents on it start without it. Edit the connection to choose a level it takes.", description: "A warning on a connection (HI-2107, decision E): a CLI update left its effort ({effort}) one its model ({model}, or \"its model\") no longer offers, so it isn't passed at launch." }),
  itsModel: msg({ id: 'settings.connection.itsModel', defaultMessage: 'Its model', description: 'In that warning, when the connection names no model: the CLI\'s default model ("Its model doesn\'t take…").' }),
  // The notice of HI-1770's moved settings (Settings → Accounts & Connections).
  failed: msg({ id: 'settings.accounts.defaults.failed', defaultMessage: "Couldn't change the connection's defaults", description: "An error's title (Settings → Accounts & Connections; HI-1770): saving a connection's default model, effort or context failed." }),
  on: msg({ id: 'agents.overrides.on', defaultMessage: 'On', description: "A choice of an agent's Use 200K context setting. Keep it short." }),
  off: msg({ id: 'agents.overrides.off', defaultMessage: 'Off', description: "A choice of an agent's Use 200K context setting. Keep it short." }),
  noticeTitle: msg({ id: 'settings.accounts.notice.title', defaultMessage: "Some settings moved onto agents can't be used by their connection", description: "A notice's title (Settings → Accounts & Connections; HI-1770): a project's own model, effort or context settings were moved onto its agents (connections hold the defaults now), and some of them the agent's connection can't use: they are kept on the agent but not used." }),
  noticeLine: msg({ id: 'settings.accounts.notice.line', defaultMessage: '{project} · {agent}: {setting}', description: "A line of the notice of moved settings a connection can't use (Settings → Accounts & Connections; HI-1770): the project, the agent and the setting with its value (\"Effort: high\")." }),
  effortIs: msg({ id: 'settings.accounts.notice.effort', defaultMessage: "Effort {value} (its model doesn't take it)", description: "A moved setting in the notice (Settings → Accounts & Connections; HI-1770): an effort level ({value}) the agent's model doesn't offer, kept on the agent but not used." }),
  contextIs: msg({ id: 'settings.accounts.notice.context', defaultMessage: "Use 200K context: {value} (its CLI has no such choice)", description: "A moved setting in the notice (Settings → Accounts & Connections; HI-1770): a context choice the agent's CLI doesn't have, kept on the agent but not used. {value} is On or Off." }),
  modelIs: msg({ id: 'settings.accounts.notice.model', defaultMessage: 'Model {value}', description: "A moved setting in the notice (Settings → Accounts & Connections; HI-1770): a model, kept on the agent." }),
  noticeHint: msg({ id: 'settings.accounts.notice.hint2', defaultMessage: "They weren't carried over. To use one, choose or make a connection with it for the agent.", description: "Under the notice of moved settings a connection can't use (Settings → Accounts & Connections; HI-1770, HI-2107): those values aren't part of the agent's connection." }),
  dismiss: msg({ id: 'settings.accounts.notice.dismiss', defaultMessage: 'Dismiss', description: "Button (Settings → Accounts & Connections; HI-1770): hides the notice of moved settings for good." })
}

const isServer = (a: Pick<Account, 'kind'> | undefined): boolean => a?.kind === 'server'

/**
 * A connection's values in one line (HI-2107): model, effort (not a server's), permission mode, each "CLI default"
 * when unset; then 200K context and its extra arguments when it has them.
 */
export function connectionSummary(c: Pick<Connection, 'model' | 'effort' | 'use200kContext' | 'permissionMode' | 'extraArgs'>, account: Pick<Account, 'provider' | 'kind'>, settings: AppSettings | null): string {
  const cli = account.provider
  const server = isServer(account)
  const parts = [c.model ? (server ? c.model : modelLabel(c.model, cli)) : tr(M.modelDefault)]
  if (!server) parts.push(c.effort ? effortName(cli, c.effort, settings ?? undefined, tr) : tr(M.effortDefault))
  parts.push(c.permissionMode ? permissionLabel(cli, c.permissionMode, tr) : tr(M.modeDefault))
  if (c.use200kContext && !server) parts.push(tr(M.args200k))
  if (c.extraArgs) parts.push(tr(M.extra, { args: c.extraArgs }))
  return parts.join(' · ')
}

/** Who uses a connection, listed (HI-2107): agents with their projects, the Assistant by name. */
export function connectionUsers(row: Pick<ConnectionRow, 'users'>): string {
  return fmt.list(row.users.map((u) => (u.assistant ? u.agent : tr(M.userIn, { agent: u.agent, project: u.project }))))
}

/** The warning of an effort a CLI update left unusable (decision E), for a connection's row. */
export function effortUnusableText(c: Pick<Connection, 'model' | 'effort'>, cli: ProviderId, settings: AppSettings | null): string {
  return tr(M.effortUnusable, { model: c.model ? modelLabel(c.model, cli) : tr(M.itsModel), effort: c.effort ? effortName(cli, c.effort, settings ?? undefined, tr) : '' })
}

/**
 * Add Connection and Edit (HI-2107, HI-2105's design): Name, Model, Effort (only the levels the model takes; saving one it
 * doesn't is refused: decision E), Context, Permission mode and Extra arguments. A server account's shows Model (its
 * server's), Permission mode and Extra arguments. `connection` given: it is edited; else one is added on `account`.
 * Saving changes it for everything that uses it: running agents on it are offered Restart, or Switch Now for a mode.
 */
export function ConnectionDialog({ account: accountId, connection: id, onClose }: { account: string; connection?: string; onClose: (saved?: Connection) => void }) {
  const settings = useStore((s) => s.settings)
  const [view, setView] = useState<ConnectionsView | null>(null)
  useEffect(() => {
    let live = true
    call('connections:list', false)
      .then((v) => live && setView(v))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  const account = view ? [...view.connections, ...view.homes].find((a) => a.id === accountId) : undefined
  const row = view && id ? view.connectionRows.find((r) => r.id === id) : undefined
  if (!view) return null
  if (!account || (id && !row)) {
    return (
      <Modal title={tr(M.addTitle, { account: account?.name ?? '', cli: account ? providerDescriptor(account.provider).name : '' })} onClose={() => onClose()} footer={<button className="btn" onClick={() => onClose()}>{tr(M.cancel)}</button>}>
        <p className="hint">{tr(M.gone)}</p>
      </Modal>
    )
  }
  return <ConnectionForm account={account} row={row} settings={settings} onClose={onClose} />
}

/** Under a mode choice: the provider's warning when it may not run that mode with that model (as the CLI says, #125). */
function ModeCaveat({ provider, mode, model }: { provider: ProviderId; mode: string | null | undefined; model: string | null | undefined }) {
  const info = useStore((s) => s.providers[provider])
  const settings = useStore((s) => s.settings)
  useLanguage()
  const caps = modelCaps(provider, model, info, settings)
  const text = modeCaveat(provider, mode as PermissionMode, model, { supportsAuto: caps.supportsAuto, label: caps.label }, tr)
  if (!text) return null
  return (
    <div className="mode-caveat">
      <Icon name="warning" /> <span>{text}</span>
    </div>
  )
}

function ConnectionForm({ account: a, row, settings, onClose }: { account: Account; row: ConnectionRow | undefined; settings: AppSettings | null; onClose: (saved?: Connection) => void }) {
  const cli = a.provider
  const p = providerDescriptor(cli)
  const server = isServer(a)
  const info = useStore((s) => s.providers[cli])
  const [name, setName] = useState(row?.name ?? '')
  const [model, setModel] = useState(row?.model ?? '')
  const [effort, setEffort] = useState<string>(row?.effort ?? '')
  const [ctx, setCtx] = useState(!!row?.use200kContext)
  const [mode, setMode] = useState<string>(row?.permissionMode ?? '')
  const [args, setArgs] = useState(row?.extraArgs ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cliModel = server ? (serverDefaultModel(a.server?.models ?? []) ?? null) : (info?.defaultModel ?? null)
  const runModel = model || cliModel
  const defEffort = modelCaps(cli, runModel, info, settings).defaultEffort
  // The modes it can choose: the CLI's, its dangerous ones only while enabled (Settings → <CLI>); one it has already stays.
  const modes = offeredModes(cli, settings)
  const shownModes = mode && !modes.some((m) => m.value === mode) && modeOption(cli, mode as PermissionMode) ? [...modes, modeOption(cli, mode as PermissionMode)!] : modes
  const save = async (): Promise<void> => {
    if (!name.trim()) return setError(tr(M.needName))
    setBusy(true)
    setError(null)
    const patch: ConnectionPatch & { name: string } = { name, model: model || null, permissionMode: (mode || null) as PermissionMode | null, extraArgs: args.trim() || null }
    if (!server) {
      patch.effort = (effort || null) as EffortLevel | null
      if (p.capabilities.contextLimit) patch.use200kContext = ctx || null
    }
    try {
      const saved = row ? await call('connection:update', row.id, patch) : await call('connection:add', a.id, patch)
      onClose(saved)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  const title = tr(row ? M.editTitle : M.addTitle, { account: a.name, cli: p.name })
  return (
    <Modal
      title={title}
      icon="plug"
      onClose={() => onClose()}
      busy={busy}
      error={error}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={() => onClose()}>
            {tr(M.cancel)}
          </button>
          <button className="btn primary" disabled={busy} data-save-connection onClick={() => void save()}>
            {busy ? tr(M.saving) : tr(row ? M.save : M.add)}
          </button>
        </>
      }
    >
      <div className="agent-form connection-form" data-connection-form={row?.id ?? 'new'}>
        <label htmlFor="connection-name">{tr(M.name)}</label>
        <input id="connection-name" className="input" autoFocus value={name} placeholder={tr(M.namePlaceholder)} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        <label>{tr(M.model)}</label>
        <ModelPicker provider={cli} connection={a} value={model} base={{ value: '', label: cliModel ? tr(M.cliDefaultIs, { provider: server ? a.name : p.name, which: server ? cliModel : modelLabel(cliModel, cli) }) : tr(M.cliDefault, { provider: server ? a.name : p.name }) }} onChange={setModel} />
        {!server && (
          <>
            <label>{tr(M.effort)}</label>
            <EffortPicker provider={cli} connection={a} model={runModel} value={effort} base={{ value: '', label: defEffort ? tr(M.cliDefaultIs, { provider: p.name, which: effortName(cli, defEffort, settings ?? undefined, tr) }) : tr(M.cliDefault, { provider: p.name }) }} onChange={setEffort} />
          </>
        )}
        {!server && p.capabilities.contextLimit && (
          <>
            <label>{tr(M.context)}</label>
            <select className="select" aria-label={tr(M.context)} data-context value={ctx ? 'on' : ''} onChange={(e) => setCtx(e.target.value === 'on')}>
              <option value="">{tr(M.context1m)}</option>
              <option value="on">{tr(M.context200k)}</option>
            </select>
          </>
        )}
        <label>{tr(M.mode)}</label>
        <div>
          <select className="select" aria-label={tr(M.mode)} data-mode value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">{tr(M.cliDefaultIs, { provider: p.name, which: permissionLabel(cli, p.defaultPermissionMode, tr) })}</option>
            {shownModes.map((m) => (
              <option key={m.value} value={m.value}>
                {permissionLabel(cli, m.value, tr)}
              </option>
            ))}
          </select>
          {/* A mode the model that would run may not take (Claude Code's Auto with Haiku, #129): said under it (HI-2145). */}
          <ModeCaveat provider={cli} mode={mode || p.defaultPermissionMode} model={runModel} />
        </div>
        <label htmlFor="connection-args">{tr(M.args)}</label>
        <div>
          <input id="connection-args" className="input mono" value={args} onChange={(e) => setArgs(e.target.value)} />
          <div className="hint">{tr(M.argsHint, { cli: p.cliName })}</div>
        </div>
        {row && row.users.length > 0 && <div className="hint span2" data-used-by>{tr(M.usedBy, { users: connectionUsers(row) })}</div>}
      </div>
    </Modal>
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
