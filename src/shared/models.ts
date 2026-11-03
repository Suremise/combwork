import type { AgentInstallInfo, AppSettings, CatalogModel, Account, EffortLevel, EffortOption, FallbackModel, ModelAlias, ProviderId } from './types'
import { OLDER_VERSIONS } from './claude'
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
/** What Hive knows of a provider's models (its install info), when it knows anything. */
export type ModelInfo = Pick<AgentInstallInfo, 'catalog' | 'configuredEffort' | 'observedEfforts' | 'defaultModel'> | null | undefined
type Info = ModelInfo

const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * What Hive knows of a connection's models (HI-1770), by its kind, never its CLI: a sign-in connection's are its CLI's
 * (its catalogue, as without connections); a server connection's its own list (HI-1772), each with the aliases it
 * stands in for, none taking an effort, its default the one standing in for Opus (else Sonnet, else its first).
 */
export function connectionModels(conn: Pick<Account, 'kind' | 'server'>, info: Info, tr?: Tr): Info {
  switch (conn.kind ?? 'signIn') {
    case 'signIn':
      return info
    case 'server': {
      const models = conn.server?.models ?? []
      const def = serverDefaultModel(models)
      return { catalog: { source: 'cli', version: null, at: '', models: models.map((m) => ({ value: m.id, label: serverModelLabel(m.id, m.as ?? [], tr, m.remote), efforts: [] })), ...(def ? { defaultModel: def } : {}) }, ...(def ? { defaultModel: def } : {}) }
    }
  }
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
  return found?.label ?? value.charAt(0).toUpperCase() + value.slice(1)
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
    if (src.kind === 'cli') return tr(msg({ id: 'agents.models.fromCli', defaultMessage: 'From {provider}{version, select, none {} other { {version}}}', description: "Settings → a provider: where its models come from now: the CLI ({provider}: its name) told Hive, in that version ({version}; none: leave that branch empty)." }), values)
    if (src.kind === 'cache') return tr(msg({ id: 'agents.models.fromCache', defaultMessage: 'From {provider}{version, select, none {} other { {version}}} (as it last said; asking again)', description: "Settings → a provider: where its models come from now: what the CLI ({provider}) said when last asked ({version}: its version, none: leave that branch empty), while Hive asks again." }), values)
    return tr(msg({ id: 'agents.models.fallback', defaultMessage: "Fallback ({provider} couldn't be asked){edited, select, yes {, as you edited it} other {}}", description: "Settings → a provider: its models are Hive's fallback list, because the CLI ({provider}) couldn't be asked; and whether the user edited that list." }), values)
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

/** What a model can do, as far as Hive knows. */
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
 * `model` is what would run (null: the CLI's default model, when Hive knows it).
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

/** A bare alias ("opus", "opus[1m]", "default"): a word, not a model ID, which always has a version in it. */
const BARE_ALIAS = /^[a-z]+(\[[^\]]*\])?$/i

/**
 * The real model ID a launch runs, which picks its dialect's model file (dialects, HI-2439): the choice (else the CLI's
 * default, when Hive knows it) with an alias resolved through the CLI's catalogue ("opus" → "claude-opus-5-5"), a full
 * ID as it is. Null when Hive can't name it: no choice and no known default, or an alias the catalogue doesn't resolve
 * (the launch record says "model unknown"). Never the friendly name: names are for display.
 */
export function dialectModelId(info: Info, chosen: string | null | undefined): string | null {
  const model = (chosen?.trim() || info?.defaultModel?.trim()) ?? ''
  if (!model) return null
  const id = resolvedModel(info, model).trim()
  return id && !BARE_ALIAS.test(id) ? id : null
}
