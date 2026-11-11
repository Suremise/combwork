import type { AgentInstallInfo, AppSettings, CatalogModel, Account, Connection, EffortLevel, EffortOption, FallbackModel, ModelAlias, ModelCatalog, ModelSwitch, ProviderId } from './types'
import { EFFORT_TEXT, OLDER_VERSIONS } from './claude'
import { fmt } from './i18n'
import { msg } from './i18n/msg'
import { serverDefaultModel } from './serverConnection'
import { providerDescriptor, type ModelGroup } from './providers'
import type { Tr } from './tasks'

/**
 * Which models and effort levels a provider offers, and what each model can do (#125). The CLI is the source of truth
 * wherever it can say (its catalog: Claude Code's initialize reply, codex debug models); where it can't, the fallbacks
 * in Settings → <provider>, which the user can edit and reset, and which start as the descriptor's. Shared by the
 * pickers, the footer and the Agent API, so they all say the same.
 */

type Settings = Pick<AppSettings, 'providers'> | null | undefined
/** What Combwork knows of a provider's models (its install info), when it knows anything. */
export type ModelInfo = Pick<AgentInstallInfo, 'catalog' | 'configuredEffort' | 'observedEfforts' | 'defaultModel'> | null | undefined
type Info = ModelInfo

const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * A saved catalogue as a cache for a refresh (the last good reply, shown while the CLI is asked again): only one of the
 * same version (`version` undefined: any), and for a CLI whose catalogue depends on a context (HI-2779: its GitHub host and
 * sign-in; `context` not undefined), only one read in that same context; none known now (null), none.
 */
export function cachedCatalogFor(c: ModelCatalog | null | undefined, version: string | null | undefined, context: string | null | undefined): ModelCatalog | null {
  if (!c || !Array.isArray(c.models) || !c.models.length) return null
  if (context !== undefined && (!context || c.context !== context)) return null
  return version === undefined || c.version === version ? { ...c, source: 'cache' } : null
}

/** Where models are offered (HI-2779): a project's folder, else its workspace's; neither: the CLI's catalogue as it is. */
export interface ModelPlace {
  projectPath?: string | null
  workspacePath?: string | null
}

/**
 * A provider's install info as a place sees it (HI-2779): for a CLI signing in on a GitHub host, the catalogue of the host
 * the project (else its workspace) resolves to, and its default; a host with no listing has none (the fallback list,
 * which says so), never another host's. A place no check knows (not open, or a CLI without hosts): the info as it is.
 */
export function infoAt<T extends Pick<AgentInstallInfo, 'catalog' | 'defaultModel' | 'hostCatalogs' | 'hostRouteOf'>>(info: T | null | undefined, at: ModelPlace): T | null | undefined {
  if (!info?.hostRouteOf || !info.hostCatalogs) return info
  const route = (at.projectPath && info.hostRouteOf[at.projectPath.toLowerCase()]) || (at.workspacePath && info.hostRouteOf[at.workspacePath.toLowerCase()]) || null
  if (!route) return info
  const catalog = info.hostCatalogs[route] ?? null
  // The info's own default where the info's catalogue is this host's (the same read); else this host's catalogue's.
  const same = !!catalog && !!info.catalog && info.catalog.context === catalog.context
  return { ...info, catalog, defaultModel: same ? info.defaultModel : (catalog?.defaultModel ?? null) }
}

/** The account fields that say whose models apply (HI-2852): its id, its kind, and whether it is on the CLI's own home. */
export type ModelAccount = Pick<Account, 'id' | 'kind' | 'home'>

/**
 * A provider's install info as one sign-in account sees it (HI-2852): the CLI offers each account its own models, so
 * the catalogue and default are that account's alone (`accountCatalogs`, read in its own folder), never the CLI's own
 * home's or another account's; an account with nothing read nor kept has none (the fallback list, which says so). An
 * account on the CLI's own home, a server account, or a CLI whose accounts aren't read: the info as it is.
 */
export function accountInfo<T extends Pick<AgentInstallInfo, 'catalog' | 'defaultModel' | 'accountCatalogs'>>(info: T | null | undefined, account: ModelAccount | null | undefined): T | null | undefined {
  if (!info?.accountCatalogs || !account || account.home || (account.kind ?? 'signIn') !== 'signIn') return info
  // One not read yet (added since the CLI's check): none, until its read lands.
  const own = Object.hasOwn(info.accountCatalogs, account.id) ? info.accountCatalogs[account.id] : undefined
  return { ...info, catalog: own?.catalog ?? null, defaultModel: own?.defaultModel ?? null }
}

/**
 * What Combwork knows of a connection's models (HI-1770), by its kind, never its CLI: a sign-in connection's are its CLI's
 * in its account's own folder (HI-2852: accountInfo); a server connection's its own list (HI-1772), each with the aliases
 * it stands in for, none taking an effort, its default the one standing in for Opus (else Sonnet, else its first).
 */
export function connectionModels(conn: Pick<Account, 'id' | 'kind' | 'server' | 'home'>, info: (NonNullable<Info> & Pick<AgentInstallInfo, 'accountCatalogs'>) | null | undefined, tr?: Tr): Info {
  switch (conn.kind ?? 'signIn') {
    case 'signIn':
      return accountInfo(info, conn)
    case 'server': {
      const models = conn.server?.models ?? []
      const def = serverDefaultModel(models)
      return { catalog: { source: 'cli', version: null, at: '', models: models.map((m) => ({ value: m.id, label: serverModelLabel(m.id, m.as ?? [], tr, m.remote), efforts: [] })), ...(def ? { defaultModel: def } : {}) }, ...(def ? { defaultModel: def } : {}) }
    }
  }
}

/** A listed model: its value and label (GET /v1/providers). */
export interface ListedModel {
  value: string
  label: string
}

/** The models the pickers offer for this info (the CLI's, else the fallback list in Settings), those unavailable left out. */
export function offeredModels(provider: ProviderId, info: Info, settings: Settings): ListedModel[] {
  return modelGroups(provider, info, settings)
    .filter((g) => !g.unavailable)
    .flatMap((g) => g.models.map((m) => ({ value: m.value, label: m.label })))
}

/** A connection as GET /v1/providers lists it (HI-2856): its account's default, and its models where they aren't the provider's. */
export interface ListedConnection {
  id: string
  name: string
  defaultModel: string | null
  models?: ListedModel[]
}

const sameModels = (a: readonly ListedModel[], b: readonly ListedModel[]): boolean => a.length === b.length && a.every((m, i) => m.value === b[i].value && m.label === b[i].label)

/**
 * A provider's connections as GET /v1/providers lists them (HI-2856): each its own account's models (connectionModels: a
 * sign-in account's read in its own folder, a server's its own list), its default always, its list only where it isn't
 * the provider's (`models`, the CLI's own home's), so the reply stays lean. A connection whose account is gone: the provider's.
 */
export function listedConnections(provider: ProviderId, conns: readonly Pick<Connection, 'id' | 'name' | 'account'>[], accountOf: (id: string) => Pick<Account, 'id' | 'kind' | 'server' | 'home'> | null | undefined, info: (NonNullable<Info> & Pick<AgentInstallInfo, 'accountCatalogs'>) | null | undefined, settings: Settings, models: readonly ListedModel[]): ListedConnection[] {
  return conns.map((c) => {
    const account = accountOf(c.account)
    if (!account) return { id: c.id, name: c.name, defaultModel: info?.defaultModel ?? null }
    const own = connectionModels(account, info)
    const list = offeredModels(provider, own, settings)
    return { id: c.id, name: c.name, defaultModel: own?.defaultModel ?? null, ...(sameModels(list, models) ? {} : { models: list }) }
  })
}

/**
 * A server's model as shown (HI-1772): its id, with the Claude names it stands in for ("deepseek-flash (as Opus,
 * Sonnet)"), and "cloud" for one its server runs elsewhere (HI-1773: "glm-4.6:cloud (cloud, as Opus)").
 */
export function serverModelLabel(id: string, as: readonly ModelAlias[], tr?: Tr, remote?: boolean): string {
  if (!as.length && !remote) return id
  const names = as.map((a) => ALIAS_NAMES[a])
  if (remote) {
    const c = as.length
      ? msg({ id: 'agents.models.serverCloudAs', defaultMessage: '{model} (cloud, as {names})', description: "A model of a server connection that its server runs in the cloud rather than on this PC (an Ollama cloud model), with the Claude model names it stands in for. {model} is the model id (\"glm-4.6:cloud\"); {names} the Claude names, joined (\"Opus, Sonnet\")." })
      : msg({ id: 'agents.models.serverCloud', defaultMessage: '{model} (cloud)', description: "A model of a server connection that its server runs in the cloud rather than on this PC (an Ollama cloud model). {model} is the model id (\"glm-4.6:cloud\")." })
    return tr ? tr(c, { model: id, names: fmt.list(names) }) : `${id} (cloud${as.length ? `, as ${names.join(', ')}` : ''})` // i18n-ignore: English without tr
  }
  const m = msg({ id: 'agents.models.serverAs', defaultMessage: '{model} (as {names})', description: "A model of a server connection (Settings → Accounts & Connections), with the Claude model names it stands in for. {model} is the server's model id (\"deepseek-flash\"); {names} the Claude names, joined (\"Opus, Sonnet\")." })
  return tr ? tr(m, { model: id, names: fmt.list(names) }) : `${id} (as ${names.join(', ')})` // i18n-ignore: English without tr
}

/** The Claude names a server's model stands in for: product names, the same in every language. */
const ALIAS_NAMES: Record<ModelAlias, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' } // i18n-ignore: Claude's model names, the same in every language

/** The descriptor's effort levels: the starting fallback. */
export const shippedEfforts = (provider: ProviderId): EffortOption[] => providerDescriptor(provider).effortLevels

/** The effort levels offered when the CLI doesn't report a model's own: the user's list, else the descriptor's. */
export function fallbackEfforts(provider: ProviderId, settings: Settings): EffortOption[] {
  const own = settings?.providers?.[provider]?.effortFallback
  const valid = Array.isArray(own) ? own.filter((e) => e && text(e.value)).map((e) => ({ value: e.value.trim(), label: text(e.label) ? e.label.trim() : e.value.trim() })) : []
  return valid.length ? valid : shippedEfforts(provider)
}

/**
 * What to call an effort level: its name in the fallback list (the user's, then the descriptor's), else capitalised. With
 * tr, a descriptor's name is in the window's language (#800); a name the user gave stays theirs.
 */
export function effortName(provider: ProviderId, value: EffortLevel, settings?: Settings, tr?: Tr): string {
  const found = fallbackEfforts(provider, settings).find((e) => e.value === value) ?? shippedEfforts(provider).find((e) => e.value === value)
  const shipped = tr ? providerDescriptor(provider).effortLevels.find((e) => e.value === value && e.label === found?.label) : undefined
  if (tr && shipped?.text) return tr(shipped.text)
  if (found) return found.label
  // A level only a model reports (OpenCode's variants, HI-2767): a common one by the shared name, else capitalised.
  const common = Object.hasOwn(EFFORT_TEXT, value) ? EFFORT_TEXT[value as keyof typeof EFFORT_TEXT] : undefined
  if (common) return tr ? tr(common) : common.defaultMessage
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** The descriptor's models as a fallback list (its groups flattened; "older" groups marked). */
export function shippedModels(provider: ProviderId): FallbackModel[] {
  return providerDescriptor(provider).modelGroups.flatMap((g) => g.models.map((m) => ({ value: m.value, label: m.label, ...(g.older ? { older: true } : {}) })))
}

/** The user's edited model list, or null when they haven't edited it (or it holds nothing usable). */
function ownModels(provider: ProviderId, settings: Settings): FallbackModel[] | null {
  const own = settings?.providers?.[provider]?.modelFallback
  if (!Array.isArray(own)) return null
  const valid = own.filter((m) => m && text(m.value)).map((m) => ({ value: m.value.trim(), label: text(m.label) ? m.label.trim() : m.value.trim(), ...(m.older ? { older: true } : {}) }))
  return valid.length ? valid : null
}

/** The models offered when the CLI can't be asked: the user's list, else the descriptor's. */
export function fallbackModels(provider: ProviderId, settings: Settings): FallbackModel[] {
  return ownModels(provider, settings) ?? shippedModels(provider)
}

/** Where a provider's models come from now. */
export interface ModelSource {
  kind: 'cli' | 'cache' | 'fallback'
  /** The CLI version that gave them (cli, cache). */
  version: string | null
  /** For fallback: whether it is the user's edited list. */
  edited: boolean
}

export function modelSource(provider: ProviderId, info: Info, settings: Settings): ModelSource {
  const c = info?.catalog
  if (c?.models.length) return { kind: c.source, version: c.version, edited: false }
  return { kind: 'fallback', version: null, edited: !!ownModels(provider, settings) }
}

/**
 * "From Claude Code 2.1.289", "From Claude Code 2.1.289 (last start; checking again)", "Fallback (CLI not available)". In
 * the window's language with tr (#800), else English.
 */
export function modelSourceText(provider: ProviderId, src: ModelSource, tr?: Tr): string {
  const name = providerDescriptor(provider).name
  if (tr) {
    const values = { provider: name, version: src.version || 'none', edited: src.edited ? 'yes' : 'no' }
    if (src.kind === 'cli') return tr(msg({ id: 'agents.models.fromCli', defaultMessage: 'From {provider}{version, select, none {} other { {version}}}', description: "Settings → a provider: where its models come from now: the CLI ({provider}: its name) told Combwork, in that version ({version}; none: leave that branch empty)." }), values)
    if (src.kind === 'cache') return tr(msg({ id: 'agents.models.fromCache', defaultMessage: 'From {provider}{version, select, none {} other { {version}}} (as it last said; asking again)', description: "Settings → a provider: where its models come from now: what the CLI ({provider}) said when last asked ({version}: its version, none: leave that branch empty), while Combwork asks again." }), values)
    return tr(msg({ id: 'agents.models.fallback', defaultMessage: "Fallback ({provider} couldn't be asked){edited, select, yes {, as you edited it} other {}}", description: "Settings → a provider: its models are Combwork's fallback list, because the CLI ({provider}) couldn't be asked; and whether the user edited that list." }), values)
  }
  if (src.kind === 'cli') return `From ${name}${src.version ? ` ${src.version}` : ''}` // i18n-ignore: English without tr (Settings passes tr once its area converts it)
  if (src.kind === 'cache') return `From ${name}${src.version ? ` ${src.version}` : ''} (as it last said; asking again)` // i18n-ignore: English without tr
  return `Fallback (${name} couldn't be asked)${src.edited ? ', as you edited it' : ''}` // i18n-ignore: English without tr
}

/**
 * The pickers' groups: the CLI's models (those it lists as unavailable to the account in a group of their own), else
 * the fallback (the descriptor's groups as shipped, or the user's list with older versions apart). With tr, the groups
 * made here are named in the window's language (#800; the descriptor's carry their words in `text`); the Agent API
 * reads only the models, never a group's name.
 */
export function modelGroups(provider: ProviderId, info: Info, settings: Settings, tr?: Tr): ModelGroup[] {
  const p = providerDescriptor(provider)
  const c = info?.catalog
  const named = tr ? tr(msg({ id: 'agents.models.providerGroup', defaultMessage: '{provider} models', description: "A group of the model picker: the models the CLI ({provider}: its name) offers, or the user's list of them." }), { provider: p.name }) : `${p.name} models` // i18n-ignore: English without tr
  if (c?.models.length) {
    const groups: ModelGroup[] = [{ label: named, models: c.models.filter((m) => !m.unavailable).map((m) => ({ value: m.value, label: catalogLabel(provider, m, info) })) }]
    const off = c.models.filter((m) => m.unavailable)
    const offLabel = tr ? tr(msg({ id: 'agents.models.unavailableGroup', defaultMessage: 'Not available to this account', description: "A group of the model picker: models the CLI lists that the user's account can't use (shown, not offered)." })) : 'Not available to this account' // i18n-ignore: English without tr
    if (off.length) groups.push({ label: offLabel, unavailable: true, models: off.map((m) => ({ value: m.value, label: catalogLabel(provider, m, info) })) })
    return groups
  }
  const own = ownModels(provider, settings)
  if (!own) return p.modelGroups
  const older = own.filter((m) => m.older)
  const olderLabel = tr ? tr(OLDER_VERSIONS) : 'Older versions' // i18n-ignore: English without tr
  return [
    { label: named, models: own.filter((m) => !m.older).map(({ value, label }) => ({ value, label })) },
    ...(older.length ? [{ label: olderLabel, older: true, models: older.map(({ value, label }) => ({ value, label })) }] : [])
  ]
}

/** The CLI's entry for exactly this value (an alias or an id, any case), if it lists one. */
const listed = (info: Info, model: string): CatalogModel | undefined => info?.catalog?.models.find((m) => m.value.toLowerCase() === model.trim().toLowerCase())

/** A model id's name (#248): as the CLI names that very id when it lists it as a version, else as the provider does ("claude-opus-5-5" → "Opus 5.5"). */
export function modelIdName(provider: ProviderId, id: string, info: Info): string {
  const m = listed(info, id)
  return m && !m.resolved ? m.label : providerDescriptor(provider).modelLabel(id)
}

/** The model a choice runs: the id an alias stands for when the CLI says ("opus" → "claude-opus-5-5"), else the choice itself. */
export function resolvedModel(info: Info, model: string): string {
  return listed(info, model)?.resolved ?? model
}

/** The name of the model a choice runs (#248): an alias by the model it stands for ("opus" → "Opus 5.5"), anything else as named. */
export function runsAsName(provider: ProviderId, model: string, info: Info): string {
  return modelIdName(provider, resolvedModel(info, model), info)
}

/** An alias's own name, without the model it stands for ("Opus"): the CLI's, unless that is the model's name, then the provider's. */
function aliasName(provider: ProviderId, m: CatalogModel, info: Info): string {
  const target = modelIdName(provider, m.resolved ?? m.value, info)
  return m.label !== target ? m.label : providerDescriptor(provider).modelLabel(m.value)
}

/** A picker's name for one of the CLI's models (#248): an alias with the model it stands for, "Opus (Opus 5.5)"; a version as the CLI names it. */
export function catalogLabel(provider: ProviderId, m: CatalogModel, info: Info): string {
  if (!m.resolved) return m.label
  const target = modelIdName(provider, m.resolved, info)
  const alias = aliasName(provider, m, info)
  return alias === target ? target : `${alias} (${target})`
}

/** What a choice is called where it was made: an alias by its own name ("Opus"), a version as the CLI or the provider names it. */
export function chosenName(provider: ProviderId, model: string, info: Info): string {
  const m = listed(info, model)
  return m ? (m.resolved ? aliasName(provider, m, info) : m.label) : providerDescriptor(provider).modelLabel(model)
}

/** A model id without what doesn't change the model: a "[1m]"-style suffix, a date ("-20251001"), case. */
const modelKey = (m: string): string => m.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')

/** The CLI's entry for a model, by what is passed (an alias or id) or the id an alias stands for. */
export function catalogModel(info: Info, model: string | null | undefined): CatalogModel | undefined {
  if (!model || !info?.catalog) return undefined
  const k = modelKey(model)
  const models = info.catalog.models
  return models.find((m) => modelKey(m.value) === k) ?? models.find((m) => m.resolved && modelKey(m.resolved) === k)
}

/** What a model can do, as far as Combwork knows. */
export interface ModelCaps {
  /** The effort levels to offer with it. */
  efforts: EffortOption[]
  /** Whether those are the model's own (the CLI said), rather than the provider's fallback list. */
  perModel: boolean
  /** The effort the CLI uses with it when none is chosen, when known. */
  defaultEffort: EffortLevel | null
  /** Whether the CLI runs it in its automatic mode; undefined when the CLI didn't say. */
  supportsAuto?: boolean
  /** The model's name as the CLI gives it. */
  label?: string
}

/**
 * A model's capabilities: its own effort levels and default effort where the CLI reports them, else the fallbacks.
 * `model` is what would run (null: the CLI's default model, when Combwork knows it).
 */
export function modelCaps(provider: ProviderId, model: string | null | undefined, info: Info, settings: Settings): ModelCaps {
  const m = catalogModel(info, model || info?.defaultModel)
  const efforts = m?.efforts ? m.efforts.map((v) => ({ value: v, label: effortName(provider, v, settings) })) : fallbackEfforts(provider, settings)
  const id = m?.resolved ?? m?.value ?? model ?? info?.defaultModel ?? null
  const observed = id ? (info?.observedEfforts?.[modelKey(id)] ?? info?.observedEfforts?.[id]) : undefined
  const def = info?.configuredEffort || m?.defaultEffort || observed || null
  // A model without effort has no default one either.
  const defaultEffort = def && (!m?.efforts || m.efforts.length) ? def : null
  return { efforts, perModel: !!m?.efforts, defaultEffort, supportsAuto: m?.supportsAuto, label: m?.label }
}

/**
 * The effort a choice comes to, for a base option ("Inherit (High)"): the chosen level's name, else the model's own
 * default when the CLI said what it is ("Medium, default"), else "default".
 */
export function effortText(provider: ProviderId, chosen: string | null | undefined, model: string | null | undefined, info: Info, settings: Settings, tr?: Tr): string {
  if (chosen && chosen !== 'inherit') return effortName(provider, chosen, settings, tr)
  const def = modelCaps(provider, model, info, settings).defaultEffort
  if (tr) return def ? tr(msg({ id: 'agents.efforts.defaultIs', defaultMessage: '{effort}, default', description: "The effort a choice comes to, in a picker's base option (\"Inherit (Medium, default)\"): the model's own default effort level ({effort}). Lower case after the comma." }), { effort: effortName(provider, def, settings, tr) }) : tr(msg({ id: 'agents.efforts.default', defaultMessage: 'default', description: "The effort a choice comes to, in a picker's base option (\"Inherit (default)\"), when the model's default isn't known. Lower case." }))
  return def ? `${effortName(provider, def, settings)}, default` : 'default' // i18n-ignore: English without tr (pickers in other areas pass tr once converted)
}

/** Whether a choice comes to the CLI's own default effort without the CLI having said what that is (effortText's "default"). */
export function effortUnknown(provider: ProviderId, chosen: string | null | undefined, model: string | null | undefined, info: Info, settings: Settings): boolean {
  return !(chosen && chosen !== 'inherit') && !modelCaps(provider, model, info, settings).defaultEffort
}

/** What an effort list calls that unknown default: "Claude Code's default", never "Default (Claude Code default)" (#916). */
export function cliDefaultEffort(provider: ProviderId, tr: Tr): string {
  return tr(msg({ id: 'agents.efforts.cliDefault', defaultMessage: "{provider}'s default", description: "The effort an effort list's first choice comes to when it is the CLI's own default and the CLI hasn't said which level that is. {provider} is the CLI's name (\"Claude Code\")." }), { provider: providerDescriptor(provider).name })
}

/** The key observedDefaultEffort keeps a model's effort under. */
export const observedEffortKey = modelKey

/**
 * A model's base ID, which a dialect's model file matches when no file has the exact ID (dialects, HI-2439): without a
 * context suffix ("[1m]") or a snapshot date ("-20261015"), in lower case ("claude-opus-5-5[1m]" → "claude-opus-5-5").
 */
export const baseModelId = modelKey

/** A model choice without a "[…]" suffix, in lower case: how an alias is compared ("opus[1m]" → "opus"). */
const aliasKey = (m: string): string => m.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')

/**
 * Whether a model choice is one of the CLI's aliases that Combwork can't resolve now (HI-2523): a word the CLI resolves
 * itself (its descriptor's `modelAliases`, or an alias its catalogue lists) with no model ID the catalogue gives for it.
 * Such a launch's model is unknown for dialects. Any other word ("gemma") is a model ID of its own.
 */
export function isUnresolvedAlias(provider: ProviderId, info: Info, model: string): boolean {
  const k = aliasKey(model)
  if (!k) return false
  const known = (providerDescriptor(provider).capabilities.modelAliases ?? []).some((a) => aliasKey(a) === k) || !!info?.catalog?.models.some((m) => m.resolved && aliasKey(m.value) === k)
  if (!known) return false
  const m = catalogModel(info, model)
  return !(m?.resolved && aliasKey(m.value) === k)
}

/**
 * The real model ID a launch runs, which picks its dialect's model file (dialects, HI-2439): the choice (else the CLI's
 * default, when Combwork knows it) with an alias resolved through the CLI's catalogue ("opus" → "claude-opus-5-5"), a full
 * ID as it is. Null when Combwork can't name it: no choice and no known default, or an alias of the CLI the catalogue
 * doesn't resolve (`isUnresolvedAlias`; the launch record says "model unknown"). A word that isn't one of the CLI's
 * aliases ("gemma") is a model ID like any other (HI-2523). Never the friendly name: names are for display.
 */
export function dialectModelId(provider: ProviderId, info: Info, chosen: string | null | undefined): string | null {
  const model = (chosen?.trim() || info?.defaultModel?.trim()) ?? ''
  if (!model) return null
  if (isUnresolvedAlias(provider, info, model)) return null
  const m = catalogModel(info, model)
  const id = (m?.resolved && aliasKey(m.value) === aliasKey(model) ? m.resolved : resolvedModel(info, model)).trim()
  return id || null
}

/**
 * Suffixes a CLI adds to a model ID that leave it the same model (HI-2609): Claude Code's 1M context, "[1m]". Only these:
 * any other suffix ("[preview]") stays part of the ID until it is known to be the same model.
 */
export const MODEL_ID_EQUIVALENT_SUFFIXES: readonly string[] = ['[1m]']

/**
 * A model ID's identity, to tell whether two IDs are the same model (HI-2609): trimmed, in lower case, without a suffix
 * MODEL_ID_EQUIVALENT_SUFFIXES lists ("claude-opus-5-5[1m]" is "claude-opus-5-5"). Nothing else is dropped: another
 * suffix, a snapshot date or another name is another model. Never a display name: two models can share one.
 */
export function modelIdentity(id: string): string {
  const k = id.trim().toLowerCase()
  const same = MODEL_ID_EQUIVALENT_SUFFIXES.find((s) => k.endsWith(s))
  return same ? k.slice(0, -same.length) : k
}

/**
 * Whether a running session reports another model than its launch gave it (HI-2609: Codex took a cheaper model at its
 * rate-limit prompt, answered by a wake's Enter), by their IDs' identities (`modelIdentity`), an alias resolved through the
 * CLI's catalogue first ("opus" → "claude-opus-5-5"). Null when they're the same model, or when Combwork can't tell: no
 * model of its own given (its CLI's default), an alias the catalogue doesn't resolve, or nothing reported.
 */
export function modelSwitched(provider: ProviderId, launched: { model: string | null; own?: true } | null | undefined, running: string | null | undefined, info: Info): ModelSwitch | null {
  if (!launched?.own || !launched.model?.trim() || !running?.trim()) return null
  const given = dialectModelId(provider, info, launched.model)
  if (!given) return null
  return modelIdentity(given) === modelIdentity(running) ? null : { launched: given, running: running.trim() }
}

/** A model ID for a dialect file, as the dialog saves it (HI-2523), and what Combwork made of what was typed. */
export interface DialectModel {
  /** What the file claims: the typed ID, trimmed, unless the CLI recognises it (below). */
  model: string
  /** The typed text was a recognised alias or form, and `model` differs from it ("Saved as claude-opus-5-5"). */
  normalised: boolean
  /** One of the CLI's aliases Combwork can't resolve now: agents running it show as model unknown, so it wouldn't match. */
  unresolvedAlias: boolean
}

/**
 * The model a dialect file claims for what was typed in its dialog (HI-2523; Darren's decision: free text first). Only
 * what the CLI recognises is normalised, by the matcher's rules: an alias its catalogue resolves becomes that ID, and an
 * ID its catalogue or its descriptor's models list (matched without case, a "[…]" suffix or a snapshot date) becomes
 * that entry's ID without the suffix or date. Anything else is kept exactly as typed, apart from surrounding
 * whitespace: "qwen3:32b", "hf.co/org/custom-20261104", "gemma".
 */
export function dialectModelOf(provider: ProviderId, info: Info, typed: string): DialectModel {
  const t = typed.trim()
  const unresolvedAlias = isUnresolvedAlias(provider, info, t)
  const strip = (id: string): string => id.trim().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
  let model = t
  if (t && !unresolvedAlias) {
    const m = catalogModel(info, t)
    if (m?.resolved && aliasKey(m.value) === aliasKey(t)) model = strip(m.resolved)
    else if (m) model = strip(m.resolved && modelKey(m.resolved) === modelKey(t) ? m.resolved : m.value)
    else {
      const k = modelKey(t)
      const fallback = providerDescriptor(provider)
        .modelGroups.flatMap((g) => g.models)
        .find((o) => modelKey(o.value) === k && !(providerDescriptor(provider).capabilities.modelAliases ?? []).some((a) => aliasKey(a) === aliasKey(o.value)))
      if (fallback) model = strip(fallback.value)
    }
  }
  return { model, normalised: model !== t, unresolvedAlias }
}

/** Why a typed model ID can't be a dialect file's (HI-2523): empty, or with a control character or a line break. */
export function dialectModelProblem(model: string): 'empty' | 'control' | null {
  if (!model.trim()) return 'empty'
  return /[\x00-\x1f\x7f]/.test(model.trim()) ? 'control' : null // i18n-ignore: a pattern
}
