import { useRef, useState } from 'react'
import type { Account, ModelAlias, ProviderId, ServerModel } from '@shared/types'
import { providerDescriptor, type ServerPreset } from '@shared/providers'
import { MODEL_ALIASES, parseBaseUrl, type ServerModelsRead } from '@shared/serverConnection'
import { fmt, msg, tr, type Msg } from '@shared/i18n'
import { serverModelLabel } from '@shared/models'
import { call, errorMessage } from '../api'
import { confirm, notify } from '../store'
import { Icon, Modal } from './ui'
import { ProviderIcon } from './ProviderIcon'

/**
 * Server connections in Settings → Accounts & Connections (HI-1772): Add Connection's choice of where a connection gets its model
 * (its sign-in, or a server), a server's form with its presets, its key (typed into a password box, sent once to main,
 * never shown again: its row says only that one is set, by its last 4 characters), its models and the Claude names
 * each stands in for, and Set Up (the CLI's own first-run screens, in a terminal).
 */

const M = {
  addTitle: msg({ id: 'settings.connections.add.title', defaultMessage: 'Add a {cli} account', description: 'Title of the dialog adding an account (Settings → Accounts & Connections, HI-2107) when only one coding agent CLI can have them. {cli} is that CLI ("Claude Code").' }),
  addAny: msg({ id: 'settings.connections.add.titleAny', defaultMessage: 'Add an account', description: 'Title of the dialog adding an account (Settings → Accounts & Connections, HI-2107) when it first asks which coding agent CLI it is for.' }),
  cli: msg({ id: 'settings.connections.add.cli', defaultMessage: 'For', description: 'Label of the choice in Add a Connection (Settings → Accounts & Connections) of the coding agent CLI the connection is for (Claude Code, Codex), each shown with its icon.' }),
  name: msg({ id: 'settings.connections.add.name', defaultMessage: 'Name', description: "Label of a new connection's name (Settings → Accounts & Connections → Add Connection)." }),
  namePlaceholder: msg({ id: 'settings.connections.add.namePlaceholder', defaultMessage: 'Anthropic · Max 1, Work, DeepSeek…', description: "Placeholder of a new connection's name box: examples of names." }),
  from: msg({ id: 'settings.connections.add.from', defaultMessage: 'Gets its model from', description: 'Label of the choice in Add Connection (Settings → Accounts & Connections): where the connection gets its model, its sign-in or a server (Darren, 27 Oct).' }),
  fromSignIn: msg({ id: 'settings.connections.add.fromSignIn', defaultMessage: 'Its sign-in', description: "A choice of Gets its model from (Add Connection): the CLI's own sign-in (a Claude account, for example), done in a terminal after it is added." }),
  fromServer: msg({ id: 'settings.connections.add.fromServer', defaultMessage: 'A server', description: 'A choice of Gets its model from (Add Connection): a server reached by its base URL, with an API key or none (DeepSeek, Ollama, a company gateway).' }),
  preset: msg({ id: 'settings.connections.server.preset', defaultMessage: 'Preset', description: "Label of a server connection's preset (Add Connection): a filled form for a known service." }),
  custom: msg({ id: 'settings.connections.server.custom', defaultMessage: 'Custom', description: "A choice of a server connection's preset: no preset, the user fills in the form." }),
  local: msg({ id: 'settings.connections.server.local', defaultMessage: '{name} (on this PC)', description: 'A preset of a server connection that runs on the user\'s own computer ({name}: "Ollama").' }),
  docs: msg({ id: 'settings.connections.server.docs', defaultMessage: 'Its setup is documented at {url}.', description: "Under a server connection's preset: where the service documents using it with the CLI. {url} is a web address." }),
  contextAdvice: msg({ id: 'settings.connections.server.contextAdvice', defaultMessage: '{name} recommends a context length of {size, number} tokens or more for {cli}, especially in larger repositories. Set it in {name}\'s own settings: Hive doesn\'t change them.', description: 'Under a server connection\'s preset (Add Connection): the service ({name}: "Ollama") recommends a context window of at least {size} tokens (64,000) for the coding agent CLI ({cli}: "Claude Code"). Advice, not a requirement Hive enforces.' }),
  cloud: msg({ id: 'settings.connections.server.cloud', defaultMessage: 'cloud', description: "Beside a model in a server connection's model list: its server runs it in the cloud (an Ollama cloud model, on ollama.com), not on this PC." }),
  cloudTip: msg({ id: 'settings.connections.server.cloudTip', defaultMessage: "Runs in the cloud, not on this PC: its sessions aren't free (local).", description: "Tooltip of \"cloud\" beside a model in a server connection's model list (an Ollama cloud model). \"free (local)\" is how Hive shows the cost of sessions run only on this PC." }),
  baseUrl: msg({ id: 'settings.connections.server.baseUrl', defaultMessage: 'Base URL', description: "Label of a server connection's base URL (Settings → Accounts & Connections), such as https://api.deepseek.com/anthropic." }),
  key: msg({ id: 'settings.connections.server.key', defaultMessage: 'API key', description: "Label of a server connection's API key box (Settings → Accounts & Connections)." }),
  keyHint: msg({ id: 'settings.connections.server.keyHint', defaultMessage: "Stored encrypted for your Windows account, never shown again. The agent's commands can read it from their environment.", description: "Under a server connection's API key box: how Hive keeps the key, and that an agent running on it can read it (it is in the agent's environment)." }),
  keyLocal: msg({ id: 'settings.connections.server.keyLocal', defaultMessage: 'Not needed for a server on this PC.', description: "Under a server connection's API key box when its base URL is this computer (localhost): the key may be left empty." }),
  models: msg({ id: 'settings.connections.server.models', defaultMessage: 'Models', description: "Label of a server connection's model list (Settings → Accounts & Connections)." }),
  modelsHint: msg({ id: 'settings.connections.server.modelsHint', defaultMessage: "Each Claude name (Opus, Sonnet, Haiku) runs the model ticked for it. A model can stand in for several.", description: "Under a server connection's model list: the CLI asks for Claude models by name, and each name runs the server model ticked for it." }),
  modelId: msg({ id: 'settings.connections.server.modelId', defaultMessage: 'Model id', description: "Placeholder of a model's id box in a server connection's model list (\"deepseek-flash\")." }),
  addModel: msg({ id: 'settings.connections.server.addModel', defaultMessage: 'Add Model', description: "Button under a server connection's model list: adds a row." }),
  removeModel: msg({ id: 'settings.connections.server.removeModel', defaultMessage: 'Remove {model}', description: "Tooltip of the button removing a model ({model}, its id) from a server connection's list." }),
  readAfter: msg({ id: 'settings.connections.server.readAfter', defaultMessage: 'Read the models from the server once it is added', description: "A tick box in Add Connection for a server: its models are read from the server (its model list) right after it is added." }),
  addSignIn: msg({ id: 'settings.connections.add.addSignIn', defaultMessage: 'Add and Sign In', description: 'The confirm button of Add Connection for a sign-in connection: adds it, then opens its sign-in.' }),
  addServer: msg({ id: 'settings.connections.add.addServer', defaultMessage: 'Add', description: 'The confirm button of Add Connection for a server connection.' }),
  adding: msg({ id: 'settings.connections.add.adding', defaultMessage: 'Adding…', description: 'The confirm button of Add Connection while it adds the connection.' }),
  cancel: msg({ id: 'settings.connections.cancel', defaultMessage: 'Cancel', description: "A dialog's button in Settings → Accounts & Connections that closes it without changing anything." }),
  needName: msg({ id: 'settings.connections.add.needName', defaultMessage: 'Give it a name.', description: "Add Connection's error while the name box is empty." }),
  needUrl: msg({ id: 'settings.connections.server.needUrl', defaultMessage: 'Give the base URL in full, starting with https:// (or http:// for this PC).', description: "A server connection form's error: the base URL is empty or can't be used." }),
  hostKey: msg({ id: 'settings.connections.server.hostKey', defaultMessage: '{host} · Key …{last4}', description: "A server connection's line in Settings → Accounts & Connections: its server's host, and its key by its last 4 characters ({last4})." }),
  hostNoKey: msg({ id: 'settings.connections.server.hostNoKey', defaultMessage: '{host} · No key', description: "A server connection's line: its server's host, with no key saved." }),
  hostLocal: msg({ id: 'settings.connections.server.hostLocal', defaultMessage: '{host} · On this PC, no key', description: "A server connection's line: its server is on this computer and has no key (none needed)." }),
  needsKey: msg({ id: 'settings.connections.server.needsKey', defaultMessage: 'Its server needs a key: agents on it are refused until one is added.', description: "A warning on a server connection with no key whose server isn't on this computer." }),
  setKey: msg({ id: 'settings.connections.server.setKey', defaultMessage: 'Add Key…', description: "Button on a server connection with no key: asks for one." }),
  replaceKey: msg({ id: 'settings.connections.server.replaceKey', defaultMessage: 'Replace Key…', description: "Button on a server connection with a key: asks for a new one in its place." }),
  removeKey: msg({ id: 'settings.connections.server.removeKey', defaultMessage: 'Remove Key', description: "Button on a server connection with a key: deletes it (asks first)." }),
  removeKeyTitle: msg({ id: 'settings.connections.server.removeKeyTitle', defaultMessage: "Remove {name}'s key?", description: "Title of the dialog confirming a server connection's key is deleted ({name}, its name)." }),
  removeKeyMessage: msg({ id: 'settings.connections.server.removeKeyMessage', defaultMessage: "It's deleted from this PC. Agents running on it keep it until they restart; new ones are refused until a key is added.", description: "The message of the dialog confirming a server connection's key is deleted." }),
  keyTitle: msg({ id: 'settings.connections.server.keyTitle', defaultMessage: "{name}'s API key", description: "Title of the dialog asking a server connection's API key ({name}, its name)." }),
  keySave: msg({ id: 'settings.connections.server.keySave', defaultMessage: 'Save Key', description: "The confirm button of the dialog asking a server connection's API key." }),
  saving: msg({ id: 'settings.connections.server.saving', defaultMessage: 'Saving…', description: "A dialog's confirm button in Settings → Accounts & Connections while it saves." }),
  keyFailed: msg({ id: 'settings.connections.server.keyFailed', defaultMessage: "Couldn't save the key", description: "An error's title: a server connection's API key wasn't saved (Settings → Accounts & Connections)." }),
  keyFailedAdded: msg({ id: 'settings.connections.server.keyFailedAdded', defaultMessage: '{name} was added without its key. Use Add Key on it to try again.', description: "The error's text when a server connection ({name}) was added but its API key couldn't be stored. Add Key names a button on it." }),
  edit: msg({ id: 'settings.connections.server.edit', defaultMessage: 'Edit Server…', description: "Button on a server connection: changes its base URL and its models." }),
  editTitle: msg({ id: 'settings.connections.server.editTitle', defaultMessage: "{name}'s server", description: "Title of the dialog changing a server connection's base URL and models ({name}, its name)." }),
  save: msg({ id: 'settings.connections.server.save', defaultMessage: 'Save', description: "The confirm button of the dialog changing a server connection's server." }),
  moveWarn: msg({ id: 'settings.connections.server.moveWarn', defaultMessage: 'This is another server: its key will be removed, and you add the key for this one after.', description: "A warning in the dialog changing a server connection's base URL: the new URL is on another server, so the saved key (for the old server) is deleted when it is saved." }),
  keyCleared: msg({ id: 'settings.connections.server.keyCleared', defaultMessage: "{name}'s server changed, so its key was removed. Add the key for the new server.", description: 'A notice after a server connection was moved to another server ({name}, its name): its old key was deleted.' }),
  read: msg({ id: 'settings.connections.server.read', defaultMessage: 'Read Models', description: "Button on a server connection: reads its models from the server's model list." }),
  reading: msg({ id: 'settings.connections.server.reading', defaultMessage: 'Reading…', description: "A server connection's Read Models button while it reads them." }),
  readDone: msg({ id: 'settings.connections.server.readDone', defaultMessage: '{n, plural, one {# model read from {name}.} other {# models read from {name}.}}', description: "A notice after reading a server connection's models ({name}, its name)." }),
  readDropped: msg({ id: 'settings.connections.server.readDropped', defaultMessage: 'No longer listed, so taken out: {models}', description: "A second line of that notice: models the server doesn't list any more, removed from the connection ({models}, their ids)." }),
  readFailed: msg({ id: 'settings.connections.server.readFailed', defaultMessage: "Couldn't read {name}'s models", description: "An error's title: reading a server connection's models failed ({name}, its name)." }),
  setUp: msg({ id: 'settings.connections.server.setUp', defaultMessage: 'Set Up', description: "Button on a connection (a server one, or one signed in): opens the CLI on it in a terminal, for its first-run screens (its theme, its notes), answered by the user." }),
  setUpFailed: msg({ id: 'settings.connections.server.setUpFailed', defaultMessage: "Couldn't open the setup", description: "An error's title: a connection's Set Up terminal couldn't be opened." }),
  changeFailed: msg({ id: 'settings.connections.server.changeFailed', defaultMessage: "Couldn't change the connection", description: "An error's title: changing a server connection failed (Settings → Accounts & Connections)." })
}

/** Why reading a server's models failed, by its kind only (never what the server said). */
const READ_WHY: Record<Exclude<ServerModelsRead, { ok: true }>['why'], Msg> = {
  refused: msg({ id: 'settings.connections.server.why.refused', defaultMessage: 'The server refused the key (401). Replace the key, then read again.', description: "Why reading a server connection's models failed: its API key was refused." }),
  forbidden: msg({ id: 'settings.connections.server.why.forbidden', defaultMessage: "The server refused access (403): the key may not be allowed to list models. Type the models in instead.", description: "Why reading a server connection's models failed: access was refused, though the key may be fine for using models." }),
  unreachable: msg({ id: 'settings.connections.server.why.unreachable', defaultMessage: "Couldn't reach the server: check its base URL and that it is running.", description: "Why reading a server connection's models failed: no answer (not running, wrong address, a timeout)." }),
  failed: msg({ id: 'settings.connections.server.why.failed', defaultMessage: 'The server answered with an error ({status}). Try again later.', description: "Why reading a server connection's models failed: the server answered with an HTTP error. {status} is its code (500)." }),
  shape: msg({ id: 'settings.connections.server.why.shape', defaultMessage: "The server's answer isn't a model list Hive can read. Type the models in instead.", description: "Why reading a server connection's models failed: its reply isn't the list Hive expects." }),
  redirect: msg({ id: 'settings.connections.server.why.redirect', defaultMessage: 'The server sent Hive elsewhere ({status}), which Hive doesn\'t follow with a key. Check the base URL.', description: "Why reading a server connection's models failed: the server answered with a redirect. {status} is its code (301)." }),
  tooBig: msg({ id: 'settings.connections.server.why.tooBig', defaultMessage: 'The model list is too large to read. Type the models in instead.', description: "Why reading a server connection's models failed: its reply was over Hive's size limit." }),
  stale: msg({ id: 'settings.connections.server.why.stale', defaultMessage: 'The account changed while its models were read. Read them again.', description: "Why reading a server connection's models was dropped: its server or key changed meanwhile, or a newer reading started." })
}

const ALIAS_NAME: Record<ModelAlias, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' } // i18n-ignore: Claude's model names, the same in every language

/** The server presets a CLI offers (its descriptor's), shown with "(on this PC)" for one without a key. */
const presetsOf = (cli: ProviderId): readonly ServerPreset[] => providerDescriptor(cli).capabilities.connections?.server?.presets ?? []
const presetLabel = (p: ServerPreset): string => (p.keyless ? tr(M.local, { name: p.name }) : p.name)

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Whether a CLI can have server connections. */
export const hasServers = (cli: ProviderId): boolean => !!providerDescriptor(cli).capabilities.connections?.server

/** Reads a server connection's models, saying how it went; `request` is this reading's own id. */
async function readModels(c: Pick<Account, 'id' | 'name'>): Promise<void> {
  const request = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    const r = await call('connections:readModels', c.id, request)
    if (r.ok) notify('info', tr(M.readDone, { n: r.models.length, name: c.name }), r.dropped.length ? tr(M.readDropped, { models: fmt.list(r.dropped) }) : undefined)
    else notify('error', tr(M.readFailed, { name: c.name }), tr(READ_WHY[r.why], { status: String(r.status ?? '') }))
  } catch (e) {
    notify('error', tr(M.readFailed, { name: c.name }), errorMessage(e))
  }
}

/** A server's models, each with the Claude names it stands in for (each name on one model at most). */
export function ServerModelsEditor({ models, onChange, disabled }: { models: ServerModel[]; onChange: (models: ServerModel[]) => void; disabled?: boolean }) {
  const set = (i: number, m: ServerModel): void => onChange(models.map((x, j) => (j === i ? m : x)))
  const toggle = (i: number, a: ModelAlias): void => {
    const on = !models[i].as?.includes(a)
    // A name moves to the model ticked: it runs one model only.
    onChange(models.map((m, j) => ({ ...m, as: j === i ? (on ? MODEL_ALIASES.filter((x) => x === a || m.as?.includes(x)) : (m.as ?? []).filter((x) => x !== a)) : (m.as ?? []).filter((x) => !(on && x === a)) })))
  }
  return (
    <div className="server-models" data-server-models>
      {models.map((m, i) => (
        <div key={i} className="server-model-row flex" data-model={m.id}>
          <input className="input" value={m.id} disabled={disabled} placeholder={tr(M.modelId)} aria-label={tr(M.modelId)} spellCheck={false} onChange={(e) => set(i, { ...m, id: e.target.value })} />
          {m.remote && <span className="muted" data-cloud title={tr(M.cloudTip)}>{tr(M.cloud)}</span>}
          {MODEL_ALIASES.map((a) => (
            <label key={a} className="flex server-model-alias">
              <input type="checkbox" disabled={disabled} checked={!!m.as?.includes(a)} onChange={() => toggle(i, a)} /> {ALIAS_NAME[a]}
            </label>
          ))}
          <button className="btn subtle small" disabled={disabled} title={tr(M.removeModel, { model: m.id })} aria-label={tr(M.removeModel, { model: m.id })} onClick={() => onChange(models.filter((_, j) => j !== i))}>
            <Icon name="close" />
          </button>
        </div>
      ))}
      <button className="btn subtle small" disabled={disabled} onClick={() => onChange([...models, { id: '' }])}>
        <Icon name="add" /> {tr(M.addModel)}
      </button>
      <div className="hint">{tr(M.modelsHint)}</div>
    </div>
  )
}

/**
 * Add a Connection (Darren, 27 Oct): its CLI first (HI-1870: one list, one Add, the choice shown with more than one),
 * a name, then where it gets its model. Its sign-in: added, then signed in (`onSignIn`). A server: its preset, base
 * URL, key (sent once, then cleared from this dialog) and models.
 */
export function AddConnectionDialog({ clis, onClose, onSignIn }: { clis: readonly ProviderId[]; onClose: () => void; onSignIn: (id: string, cli: ProviderId) => void }) {
  const [cli, setCli] = useState<ProviderId>(clis[0])
  const servers = hasServers(cli)
  const presets = presetsOf(cli)
  const [name, setName] = useState('')
  const [from, setFrom] = useState<'signIn' | 'server'>('signIn')
  const [preset, setPreset] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [models, setModels] = useState<ServerModel[]>([])
  const [readAfter, setReadAfter] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const named = useRef('')
  const url = parseBaseUrl(baseUrl)
  const pick = (id: string): void => {
    setPreset(id)
    const p = presets.find((x) => x.id === id)
    if (!p) return
    // The preset's name, unless the user typed their own.
    if (!name.trim() || name === named.current) {
      named.current = presetLabel(p)
      setName(named.current)
    }
    setBaseUrl(p.baseUrl)
    setModels(p.models ? p.models.map((m) => ({ id: m.id, ...(m.as ? { as: [...m.as] } : {}) })) : [])
    setReadAfter(!!p.listing && !p.models)
  }
  const submit = async (): Promise<void> => {
    if (!name.trim()) return setError(tr(M.needName))
    if (from === 'server' && !url.ok) return setError(tr(M.needUrl))
    setBusy(true)
    setError(null)
    try {
      if (from === 'signIn') {
        const a = await call('connections:add', cli, name)
        onClose()
        onSignIn(a.id, cli)
        return
      }
      const typed = models.filter((m) => m.id.trim())
      const a = await call('connections:addServer', { cli, name, baseUrl, ...(preset ? { preset } : {}), models: typed, modelsFrom: readAfter ? 'listed' : 'typed', ...(key ? { key } : {}) })
      setKey('')
      onClose()
      // Added, but its key wasn't saved: said, and its row offers Add Key.
      if (a.keyFailed) notify('error', tr(M.keyFailed), tr(M.keyFailedAdded, { name: a.name }))
      else if (readAfter) await readModels(a)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const cliName = providerDescriptor(cli).name
  const chosen = presets.find((x) => x.id === preset)
  const docs = chosen?.docs
  // Another CLI: what was picked for the last one's server doesn't carry over.
  const pickCli = (p: ProviderId): void => {
    setCli(p)
    if (!hasServers(p)) setFrom('signIn')
    setPreset('')
    setBaseUrl('')
    setModels([])
    setReadAfter(false)
  }
  return (
    <Modal
      title={tr(clis.length > 1 ? M.addAny : M.addTitle, { cli: cliName })}
      icon="plug"
      wide={from === 'server'}
      busy={busy}
      error={error}
      onClose={onClose}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>{tr(M.cancel)}</button>
          <button className="btn primary" data-add-connection onClick={() => void submit()}>{tr(busy ? M.adding : from === 'signIn' ? M.addSignIn : M.addServer)}</button>
        </>
      }
    >
      <div className="agent-form server-form">
        {clis.length > 1 && (
          <>
            <label>{tr(M.cli)}</label>
            <div className="flex" role="radiogroup" aria-label={tr(M.cli)}>
              {clis.map((p) => (
                <label key={p} className="flex conn-cli-choice">
                  <input type="radio" name="conn-cli" checked={cli === p} disabled={busy} onChange={() => pickCli(p)} data-cli-choice={p} /> <ProviderIcon provider={p} /> {providerDescriptor(p).name}
                </label>
              ))}
            </div>
          </>
        )}
        <label htmlFor="conn-name">{tr(M.name)}</label>
        <input id="conn-name" className="input" autoFocus value={name} disabled={busy} placeholder={tr(M.namePlaceholder)} onChange={(e) => setName(e.target.value)} />
        {servers && (
          <>
            <label>{tr(M.from)}</label>
            <div className="flex" role="radiogroup" aria-label={tr(M.from)}>
              <label className="flex"><input type="radio" name="conn-from" checked={from === 'signIn'} disabled={busy} onChange={() => setFrom('signIn')} data-from="signIn" /> {tr(M.fromSignIn)}</label>
              <label className="flex"><input type="radio" name="conn-from" checked={from === 'server'} disabled={busy} onChange={() => setFrom('server')} data-from="server" /> {tr(M.fromServer)}</label>
            </div>
          </>
        )}
        {from === 'server' && (
          <>
            <label htmlFor="conn-preset">{tr(M.preset)}</label>
            <select id="conn-preset" className="select" value={preset} disabled={busy} onChange={(e) => pick(e.target.value)}>
              <option value="">{tr(M.custom)}</option>
              {presets.map((p) => <option key={p.id} value={p.id}>{presetLabel(p)}</option>)}
            </select>
            {docs && <div className="hint span2">{tr(M.docs, { url: docs })}</div>}
            {chosen?.contextAdvice && <div className="hint span2" data-context-advice>{tr(M.contextAdvice, { name: chosen.name, size: chosen.contextAdvice, cli: cliName })}</div>}
            <label htmlFor="conn-url">{tr(M.baseUrl)}</label>
            <input id="conn-url" className="input" value={baseUrl} disabled={busy} spellCheck={false} placeholder="https://" /* i18n-ignore: a URL's scheme */ onChange={(e) => setBaseUrl(e.target.value)} />
            <label htmlFor="conn-key">{tr(M.key)}</label>
            <input id="conn-key" className="input" type="password" autoComplete="off" spellCheck={false} value={key} disabled={busy} onChange={(e) => setKey(e.target.value)} data-key-input />
            <div className="hint span2">{url.ok && url.local ? tr(M.keyLocal) : tr(M.keyHint)}</div>
            <label>{tr(M.models)}</label>
            <div>
              <ServerModelsEditor models={models} onChange={setModels} disabled={busy} />
              {!!presets.find((x) => x.id === preset)?.listing || !preset ? (
                <label className="flex dialog-check">
                  <input type="checkbox" checked={readAfter} disabled={busy} onChange={(e) => setReadAfter(e.target.checked)} /> {tr(M.readAfter)}
                </label>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** Asks a server connection's key, in a password box: sent once to main, cleared here as soon as it is saved. */
function KeyDialog({ c, onClose }: { c: Account; onClose: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await call('connections:setKey', c.id, key)
      setKey('')
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={tr(M.keyTitle, { name: c.name })}
      icon="key"
      busy={busy}
      error={error}
      onClose={onClose}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>{tr(M.cancel)}</button>
          <button className="btn primary" disabled={!key} data-save-key onClick={() => void save()}>{tr(busy ? M.saving : M.keySave)}</button>
        </>
      }
    >
      <label className="dialog-field-label" htmlFor="server-key">{tr(M.key)}</label>
      <input id="server-key" className="input" type="password" autoComplete="off" spellCheck={false} autoFocus value={key} disabled={busy} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key && void save()} data-key-input />
      <div className="hint">{tr(M.keyHint)}</div>
    </Modal>
  )
}

/** Changes a server connection's base URL and models; another server's URL removes its key (said before saving). */
function EditServerDialog({ c, onClose }: { c: Account; onClose: () => void }) {
  const [baseUrl, setBaseUrl] = useState(c.server?.baseUrl ?? '')
  const [models, setModels] = useState<ServerModel[]>(c.server?.models ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const url = parseBaseUrl(baseUrl)
  const was = parseBaseUrl(c.server?.baseUrl ?? '')
  const moves = url.ok && was.ok && url.origin !== was.origin
  const save = async (): Promise<void> => {
    if (!url.ok) return setError(tr(M.needUrl))
    setBusy(true)
    setError(null)
    try {
      const r = await call('connections:editServer', c.id, { baseUrl, models: models.filter((m) => m.id.trim()) })
      onClose()
      if (r.keyCleared) notify('warning', tr(M.keyCleared, { name: c.name }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={tr(M.editTitle, { name: c.name })}
      icon="plug"
      wide
      busy={busy}
      error={error}
      onClose={onClose}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>{tr(M.cancel)}</button>
          <button className="btn primary" data-save-server onClick={() => void save()}>{tr(busy ? M.saving : M.save)}</button>
        </>
      }
    >
      <div className="agent-form server-form">
        <label htmlFor="edit-url">{tr(M.baseUrl)}</label>
        <input id="edit-url" className="input" value={baseUrl} disabled={busy} spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
        {moves && <div className="account-warning span2"><Icon name="warning" /> {tr(M.moveWarn)}</div>}
        <label>{tr(M.models)}</label>
        <ServerModelsEditor models={models} onChange={setModels} disabled={busy} />
      </div>
    </Modal>
  )
}

/** A server connection's part of its row: its server and key, and what can be done with them. */
export function ServerConnectionDetail({ c, keyLast4, needsSetUp, onSetUp }: { c: Account; keyLast4?: string; needsSetUp?: boolean; onSetUp: (id: string) => void }) {
  const [dialog, setDialog] = useState<'key' | 'edit' | null>(null)
  const [reading, setReading] = useState(false)
  const url = parseBaseUrl(c.server?.baseUrl ?? '')
  const host = hostOf(c.server?.baseUrl ?? '')
  const local = url.ok && url.local
  const caps = providerDescriptor(c.provider).capabilities.connections?.server
  const listing = !!caps && (caps.presets.find((p) => p.id === c.server?.preset)?.listing ?? caps.listing)
  const line = keyLast4 ? tr(M.hostKey, { host, last4: keyLast4 }) : local ? tr(M.hostLocal, { host }) : tr(M.hostNoKey, { host })
  const removeKey = (): void => {
    void confirm({ title: tr(M.removeKeyTitle, { name: c.name }), message: tr(M.removeKeyMessage), confirmLabel: tr(M.removeKey), danger: true, run: () => call('connections:removeKey', c.id) }).catch((e) => notify('error', tr(M.changeFailed), errorMessage(e)))
  }
  const models = c.server?.models ?? []
  return (
    <div className="server-detail" data-server={c.id}>
      <div className="account-ident muted" data-server-line>{line}</div>
      {models.length > 0 && <div className="muted server-models-line" data-server-models-line>{models.map((m) => serverModelLabel(m.id, m.as ?? [], tr, m.remote)).join(' · ')}</div>}
      {!keyLast4 && !local && <div className="account-warning" data-warning="noKey"><Icon name="warning" /> {tr(M.needsKey)}</div>}
      <div className="server-actions flex">
        <button className="btn subtle small" data-key-action onClick={() => setDialog('key')}>{tr(keyLast4 ? M.replaceKey : M.setKey)}</button>
        {keyLast4 && <button className="btn subtle small" data-remove-key onClick={removeKey}>{tr(M.removeKey)}</button>}
        <button className="btn subtle small" data-edit-server onClick={() => setDialog('edit')}>{tr(M.edit)}</button>
        {listing && (
          <button
            className="btn subtle small"
            data-read-models
            disabled={reading}
            onClick={() => {
              setReading(true)
              void readModels(c).finally(() => setReading(false))
            }}
          >
            {tr(reading ? M.reading : M.read)}
          </button>
        )}
        <button className={needsSetUp ? 'btn primary small' : 'btn subtle small'} data-set-up onClick={() => onSetUp(c.id)}>{tr(M.setUp)}</button>
      </div>
      {dialog === 'key' && <KeyDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'edit' && <EditServerDialog c={c} onClose={() => setDialog(null)} />}
    </div>
  )
}

const MASKING = {
  unavailable: msg({ id: 'settings.connections.masking.unavailable', defaultMessage: "Hive can't read the data it uses to hide your API keys in logs and exports. Until it is reset, every long word is hidden in its logs, and exports, Copy Diagnostics and recordings are refused.", description: "A warning in Settings → Accounts & Connections: the data Hive keeps to recognise server connections' API keys (to hide them) can't be read. A long word is 8 characters or more without a space." }),
  gap: msg({ id: 'settings.connections.masking.gap', defaultMessage: "Since {date}, Hive hides every long word in its logs, recordings and exports, for good: keys saved before its masking data was reset can't be recognised any more.", description: "A note in Settings → Accounts & Connections after Reset Masking Data: Hive masks strictly from then on. {date} is when it was reset. A long word is 8 characters or more without a space." }),
  full: msg({ id: 'settings.connections.masking.full', defaultMessage: 'Hive is near the most API keys it can keep masking for. Past it, a new key is refused.', description: 'A warning in Settings → Accounts & Connections: Hive keeps a fingerprint of every API key ever saved (to hide it in logs and exports), and is nearly at its limit.' }),
  reset: msg({ id: 'settings.connections.masking.reset', defaultMessage: 'Reset Masking Data…', description: "Button in Settings → Accounts & Connections when Hive's key masking data can't be read: makes it again from the keys saved now (asks first)." }),
  resetTitle: msg({ id: 'settings.connections.masking.resetTitle', defaultMessage: 'Reset masking data?', description: "Title of the dialog confirming Reset Masking Data (Settings → Accounts & Connections)." }),
  resetMessage: msg({ id: 'settings.connections.masking.resetMessage', defaultMessage: "Hive can no longer recognise keys saved before. From now on it hides every long word (8 characters or more with no spaces) in its logs, recordings and exports, for good, so none of them can show an old key. This can't be undone.", description: "The message of the dialog confirming Reset Masking Data (Settings → Accounts & Connections): what the user gives up." }),
  resetConfirm: msg({ id: 'settings.connections.masking.resetConfirm', defaultMessage: 'Reset', description: 'The confirm button of the dialog confirming Reset Masking Data.' }),
  resetFailed: msg({ id: 'settings.connections.masking.resetFailed', defaultMessage: "Couldn't reset the masking data", description: "An error's title: Reset Masking Data failed (Settings → Accounts & Connections)." })
}

/** Key masking's state (HI-1772): unreadable (with Reset Masking Data…), strict for good since a reset, or near full. */
export function MaskingBanner({ masking }: { masking?: { state: string; gap: boolean; gapSince?: string; full: boolean } }) {
  if (!masking) return null
  const reset = (): void => {
    void confirm({ title: tr(MASKING.resetTitle), message: tr(MASKING.resetMessage), confirmLabel: tr(MASKING.resetConfirm), danger: true, run: () => call('connections:resetMasking') }).catch((e) => notify('error', tr(MASKING.resetFailed), errorMessage(e)))
  }
  return (
    <>
      {masking.state === 'unavailable' && (
        <div className="banner warn" data-masking="unavailable">
          <Icon name="warning" /> {tr(MASKING.unavailable)}
          <button className="btn small" onClick={reset}>{tr(MASKING.reset)}</button>
        </div>
      )}
      {masking.gap && masking.state !== 'unavailable' && (
        <div className="banner" data-masking="gap">
          <Icon name="shield" /> {tr(MASKING.gap, { date: masking.gapSince ? fmt.dateTime(new Date(masking.gapSince)) : '' })}
        </div>
      )}
      {masking.full && (
        <div className="banner warn" data-masking="full">
          <Icon name="warning" /> {tr(MASKING.full)}
        </div>
      )}
    </>
  )
}

/**
 * Opens a connection's Set Up terminal (a server one's, or a sign-in one's: HI-1826): its key and where it opened
 * (HI-1871), or null when it couldn't be opened (said).
 */
export async function setUpConnection(id: string): Promise<{ key: string; in?: { folder: string; project?: string; workspace?: true } } | null> {
  try {
    return await call('connections:setUp', id)
  } catch (e) {
    notify('error', tr(M.setUpFailed), errorMessage(e))
    return null
  }
}

/** What Set Up is for, from the CLI's descriptor (HI-1870): above its terminal, and on a connection that needs it. */
export const setUpHint = (cli: ProviderId): string => {
  const m = providerDescriptor(cli).capabilities.connections?.setUp
  return m ? tr(m) : ''
}

/** The Set Up button's label. */
export const setUpLabel = (): string => tr(M.setUp)
