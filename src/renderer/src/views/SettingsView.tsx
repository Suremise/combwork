import { WorkflowLevelForm } from '../components/WorkflowOptions'
import { JournalSettingsPanel } from '../components/JournalSettings'
import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, ChimeSound, EffortLevel, EffortOption, FallbackModel, ModelPrice, PermissionMode, ProviderId, TaskColumn, WorkspaceConfig } from '@shared/types'
import { DEFAULT_COLUMN_COLORS, TASK_COLUMNS, columnColor, columnName } from '@shared/tasks'
import { DEFAULT_MODE } from '@shared/assistant'
import { PRICES_CHECKED, SHIPPED_PRICES, listedPriceModels, priceRows } from '@shared/prices'
import { APP_SETTINGS_CATALOG, SETTINGS_SECTIONS, providerSection, settingDefault, settingPatch, settingValue, SETTINGS_TEXT, shownSetting, type SettingEntry, type SettingsSection, type SettingsSectionInfo } from '@shared/settingsCatalog'
import { cliDefaultEffort, effortName, fallbackEfforts, fallbackModels, modelCaps, modelSource, modelSourceText, runsAsName } from '@shared/models'
import type { SettingsPatch } from '@shared/api'
import { AUTO_PROVIDER, PROVIDERS, defaultProviderLabel, enabledProviders, isProviderEnabled, installSourceText, offeredModes, permissionLabel, providerDescriptor, providerSettings, shownText as providerText } from '@shared/providers'
import { modeName, useModes } from '../components/Assistant'
import { ModeCaveat } from '../components/AgentDialogs'
import { EffortPicker, ModelPicker } from '../components/ModelPicker'
import { NumberField } from '../components/NumberField'
import { ProviderIcon } from '../components/ProviderIcon'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { playChime } from '../chime'
import { Icon, IconButton, InfoTip, SearchInput, Switch, Tooltip, usePlaceholderClipped } from '../components/ui'
import { UpdateStatusRow } from '../components/Updates'
import { KeybindingsEditor } from '../components/Keybindings'
import { HiddenProjectsList } from '../components/ProjectRemoval'
import { WorkspaceStorageList } from '../components/Storage'
import { AntivirusPanel } from '../components/Antivirus'
import { AccountsSettings } from '../components/AccountsSettings'
import { AdvancedSettings } from '../components/AdvancedSettings'
import { ACCOUNTS_PREVIEW, ADVANCED_DEFS, groupName, shownText, type AdvancedState } from '@shared/advanced'
import { choose, confirm, get, notify, set, useLanguage, useStore } from '../store'
import { fmt, msg, tr, tRich } from '@shared/i18n'
import { LANGUAGES, SOURCE_LANGUAGE, languageOf } from '@shared/i18n/languages'
import { LANGUAGE_TEXT } from '@shared/i18n/languageText'
import { cx, timeAgo } from '../util'

/** A settings section: a group of AppSettings, "providers" (turning them on), one provider's page ("provider:<id>"), or "advanced". */
type Section = SettingsSection

/** A row of Settings: its catalog entry (the text, the control, the flags), and the control the view draws for a custom one. */
interface SettingDef extends SettingEntry {
  render?: () => React.ReactNode
}

const SECTION_ICONS: Record<string, string> = { general: 'settings-gear', updates: 'cloud-download', appearance: 'symbol-color', providers: 'hubot', accounts: 'plug', notifications: 'bell', sessions: 'history', assistant: 'person', workspace: 'root-folder', board: 'project', workflow: 'git-pull-request', agents: 'organization', keybindings: 'keyboard', agentApi: 'broadcast', advanced: 'tools' }

const SECTIONS: (SettingsSectionInfo<Section> & { icon: string })[] = SETTINGS_SECTIONS.map((s) => ({ ...s, icon: SECTION_ICONS[s.id] ?? 'blank' }))

/** The controls Settings draws itself (custom rows), by catalog id; the catalog has their text (settingsCatalog.ts). */
const CONTROLS: Record<string, () => React.ReactNode> = {
  'updates.status': () => <UpdateStatusRow />,
  'keybindings.editor': () => <KeybindingsEditor />,
  'providers.list': () => <ProvidersList />,
  'providers.defaultProvider': () => <DefaultProviderPicker />,
  'general.language': () => <LanguagePicker />,
  'notifications.chimeSound': () => <ChimePicker />,
  'sessions.usageCacheClear': () => <ClearUsageCacheButton />,
  'sessions.resetPerformance': () => <ResetMetricsButton />,
  'accounts.list': () => <AccountsSettings />,
  'workspace.hiddenProjects': () => <HiddenProjectsList />,
  'workspace.storage': () => <WorkspaceStorageList />,
  'workspace.antivirus': () => <AntivirusPanel />,
  'workspace.workflowDefaults': () => <WorkflowLevelForm level="workspace" />,
  'workflow.defaults': () => <WorkflowLevelForm level="global" />,
  'board.colors': () => <ColumnColors />,
  'assistant.provider': () => <AssistantProviderPicker />,
  'assistant.mode': () => <AssistantModePicker />,
  'assistant.journal': () => <JournalSettingsPanel />,
  ...Object.fromEntries(PROVIDERS.map((p) => [`assistant.provider:${p.id}`, () => <AssistantProviderDefaults provider={p.id} />])),
  'agentApi.status': () => <ApiStatus />,
  'agentApi.token': () => <ApiToken />,
  'agentApi.viewers': () => <ViewerTokens />,
  'advanced.logs': () => (
    <button className="btn subtle" onClick={() => void call('app:openLogs')}>
      <Icon name="output" /> {tr(msg({ id: 'settings.advanced.openLogs', defaultMessage: 'Open logs', description: "Button in Settings → Advanced → Logs: opens the folder of Hive's log files." }))}
    </button>
  ),
  'advanced.values': () => <AdvancedValues />,
  'advanced.data': () => <DataFolder />,
  'advanced.reset': () => <ResetAll />
}

/** A provider page's custom controls, by key. */
function providerControl(provider: ProviderId, key: string): (() => React.ReactNode) | undefined {
  switch (key) {
    case 'enabled':
      return () => <ProviderToggle provider={provider} />
    case 'status':
      return () => <ProviderStatus provider={provider} />
    case 'defaultModel':
      return () => <GlobalModelPicker provider={provider} />
    case 'defaultEffort':
      return () => <GlobalEffortPicker provider={provider} />
    case 'modelFallback':
      return () => <ModelFallbackTable provider={provider} />
    case 'effortFallback':
      return () => <EffortFallbackTable provider={provider} />
    case 'prices':
      return () => <PriceTable provider={provider} />
  }
  return undefined
}

// Fields drawn as part of another row (the Assistant's "With <provider>") aren't rows of their own.
const SETTINGS: SettingDef[] = APP_SETTINGS_CATALOG.filter((e) => !e.hidden).map((e) => ({ ...e, render: e.provider ? providerControl(e.provider, e.key) : CONTROLS[e.id] }))

/** A message's <link> part, opening a page in the browser. */
const linkTo =
  (url: string) =>
  (chunks: React.ReactNode[]): React.ReactNode => (
    <a key="link" onClick={() => void call('app:openExternal', url)}>
      {chunks}
    </a>
  )

/**
 * The price table for a provider's models: Hive's prices (editable defaults), with the user's changes, added and removed
 * models (#125), and the models the CLI lists (#436): one with no price marked to enter one, a priced one it no longer
 * lists greyed. A provider that doesn't report costs says where to check its prices.
 */
function PriceTable({ provider }: { provider: ProviderId }) {
  const settings = useStore((s) => s.settings)
  const catalog = useStore((s) => s.providers[provider]?.catalog)
  const ps = providerSettings(settings, provider)
  const own = ps.prices
  const removed = ps.pricesRemoved ?? []
  const shipped = SHIPPED_PRICES[provider] ?? {}
  const p = providerDescriptor(provider)
  const listed = useMemo(() => listedPriceModels(provider, catalog), [provider, catalog])
  const rows = priceRows(provider, settings, listed)
  const [adding, setAdding] = useState('')
  const newHint = tr(msg({ id: 'settings.prices.newPlaceholder', defaultMessage: 'Model ID, e.g. a new model', description: "Placeholder of the box under a price table where a model's ID is typed to add it." }))
  const [newBox, hintClipped] = usePlaceholderClipped(newHint)
  const cols: { key: keyof ModelPrice; label: string }[] = [
    { key: 'input', label: tr(msg({ id: 'settings.prices.input', defaultMessage: 'Input', description: "A column of a provider's price table (Settings → <provider> → API prices): the price of input tokens." })) },
    { key: 'cachedInput', label: tr(msg({ id: 'settings.prices.cachedInput', defaultMessage: 'Cached input', description: "A column of a provider's price table: the price of input tokens read from the cache." })) },
    ...(Object.values(shipped).some((m) => m.cacheWrite !== undefined) ? [{ key: 'cacheWrite' as const, label: tr(msg({ id: 'settings.prices.cacheWrite', defaultMessage: 'Cache write', description: "A column of a provider's price table: the price of writing tokens to the cache." })) }] : []),
    { key: 'output', label: tr(msg({ id: 'settings.prices.output', defaultMessage: 'Output', description: "A column of a provider's price table: the price of output tokens." })) }
  ]
  const save = (next: Record<string, ModelPrice>, nextRemoved: string[] = removed): Promise<void> =>
    // Replaces the whole table (a deep merge can't remove a model's override).
    actions.attempt(tr(msg({ id: 'settings.prices.saveFailed', defaultMessage: 'Could not save prices', description: "An error's title: saving a provider's price table failed." })), () => call('settings:setProviderPrices', provider, next, nextRemoved)).then((s) => void (s && set({ settings: s })))
  const setPrice = (model: string, key: keyof ModelPrice, value: string): void => {
    const n = Number(value)
    if (value.trim() === '' || !Number.isFinite(n) || n < 0) return
    const current = own[model] ?? shipped[model] ?? { input: 0, cachedInput: 0, output: 0 }
    void save({ ...own, [model]: { ...current, [key]: n } })
  }
  const back = (model: string): void => {
    const next = { ...own }
    delete next[model]
    void save(next)
  }
  const remove = (model: string): void => {
    const next = { ...own }
    delete next[model]
    void save(next, shipped[model] ? [...new Set([...removed, model])] : removed)
  }
  const add = (): void => {
    const m = adding.trim()
    if (!m || rows.some((r) => r.model.toLowerCase() === m.toLowerCase())) return
    setAdding('')
    void save({ ...own, [m]: { input: 0, cachedInput: 0, output: 0 } }, removed.filter((x) => x !== m))
  }
  const edited = Object.keys(own).length > 0 || removed.length > 0
  return (
    <div className="fallback-table">
      {!p.capabilities.reportsCost && (
        <div className="fallback-source price-note">
          <Icon name="info" />
          <span>
            {tRich(msg({ id: 'settings.prices.noReports', defaultMessage: "{provider} doesn't report costs, so Hive estimates them from these prices. Check them against <link>{company}'s pricing</link>.", description: "Above a provider's price table when the provider reports no costs. {provider} is its name, {company} the company's; <link> opens the company's price page." }), { provider: p.name, company: p.company, link: linkTo(p.pricingUrl) })}
          </span>
        </div>
      )}
      <div className="fallback-source faint">{tr(msg({ id: 'settings.prices.checked', defaultMessage: "Hive's starting prices, checked {checked}: edit them if they are out of date.", description: "Above a provider's price table. {checked} is a date." }), { checked: PRICES_CHECKED })}</div>
      {/* Narrower than the table even with its boxes narrowed, it scrolls sideways in its own box (#887). */}
      <div className="price-table-wrap">
      <table className="table price-table">
        <thead>
          <tr>
            <th>{tr(msg({ id: 'settings.prices.model', defaultMessage: 'Model', description: "The first column of a provider's price table: the model's ID." }))}</th>
            {cols.map((c) => (
              <th key={c.key} className="num">
                {c.label}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ model: m, price, shipped: isShipped, edited: isEdited, listed: isListed }) => (
            <tr key={m} className={cx(isListed === false && 'unlisted')}>
              <td className="mono">
                {m} {isEdited && <span className="badge">{isShipped ? tr(msg({ id: 'settings.prices.edited', defaultMessage: 'edited', description: "A badge on a model in a price table: one of Hive's prices that the user changed." })) : tr(msg({ id: 'settings.prices.yours', defaultMessage: 'yours', description: 'A badge on a model in a price table: a model the user added.' }))}</span>}
                {!price && <span className="badge warn">{tr(msg({ id: 'settings.prices.noPrice', defaultMessage: 'No price: enter one', description: 'A badge on a model in a price table that has no price yet.' }))}</span>}
                {isListed === false && (
                  <Tooltip content={tr(msg({ id: 'settings.prices.unlistedTip', defaultMessage: "{provider} doesn't list this model now; its price stays for older sessions.", description: 'Tooltip of a model in a price table that the provider no longer lists. {provider} is its name.' }), { provider: p.name })}>
                    <span className="badge">{tr(msg({ id: 'settings.prices.unlisted', defaultMessage: "not in {provider}'s list", description: 'A badge on a model in a price table that the provider no longer lists. {provider} is its name.' }), { provider: p.name })}</span>
                  </Tooltip>
                )}
              </td>
              {cols.map((c) => (
                <td key={c.key} className="num">
                  <input className="input price-input" type="number" min={0} step={0.01} aria-label={tr(msg({ id: 'settings.prices.cell', defaultMessage: '{model} {column}', description: "A price box's name for screen readers: the model's ID and the column." }), { model: m, column: c.label })} defaultValue={price?.[c.key] ?? ''} key={`${m}:${c.key}:${price?.[c.key]}`} onBlur={(e) => e.target.value !== String(price?.[c.key] ?? '') && setPrice(m, c.key, e.target.value)} />
                </td>
              ))}
              <td className="row-actions">
                {isEdited && isShipped && <IconButton icon="discard" title={tr(msg({ id: 'settings.prices.back', defaultMessage: "Back to Hive's price", description: "Button on an edited model in a price table: puts Hive's price back." }))} onClick={() => back(m)} />}
                {price && <IconButton icon="trash" title={tr(msg({ id: 'settings.prices.remove', defaultMessage: 'Remove from the table', description: 'Button on a model in a price table: removes it.' }))} onClick={() => remove(m)} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {/* The new model's box keeps room for its hint; too narrow even so, the whole hint shows on hover (#892). */}
      <div className="fallback-actions price-actions">
        <Tooltip content={hintClipped ? newHint : null}>
          <input ref={newBox} className="input mono" placeholder={newHint} aria-label={tr(msg({ id: 'settings.prices.newLabel', defaultMessage: "New model's ID", description: "The name, for screen readers, of the box under a price table where a model's ID is typed." }))} value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        </Tooltip>
        <button className="btn subtle" disabled={!adding.trim()} onClick={add}>
          <Icon name="add" /> {tr(msg({ id: 'settings.prices.add', defaultMessage: 'Add model', description: 'Button under a price table: adds the model typed beside it.' }))}
        </button>
        <button className="btn subtle" disabled={!edited} onClick={() => void save({}, [])}>
          <Icon name="discard" /> {tr(msg({ id: 'settings.fallback.reset', defaultMessage: 'Reset to defaults', description: "Button under a provider's table (prices, models or effort levels): goes back to Hive's own." }))}
        </button>
      </div>
    </div>
  )
}

/**
 * An editable list for a provider's fallback (models or effort levels): value, name and, for models, Older. Any edit
 * stores the whole list as the user's; Reset to defaults removes it, so Hive's own list (and its updates) applies again.
 */
function FallbackRows<T extends FallbackModel | EffortOption>({ provider, kind, rows, edited, valueLabel, newLabel, placeholder, open: startOpen }: { provider: ProviderId; kind: 'models' | 'efforts'; rows: T[]; edited: boolean; valueLabel: string; newLabel: string; placeholder: string; open: boolean }) {
  const [adding, setAdding] = useState('')
  // Folded while the CLI's answer is in use and the list is Hive's own: it is only used without one.
  const [open, setOpen] = useState(startOpen)
  useEffect(() => {
    if (startOpen) setOpen(true)
  }, [startOpen])
  const save = (next: T[] | null): Promise<void> => actions.attempt(tr(msg({ id: 'settings.fallback.saveFailed', defaultMessage: 'Could not save the list', description: "An error's title: saving a provider's fallback list of models or effort levels failed." })), () => call('settings:setProviderFallback', provider, kind, next)).then((s) => void (s && set({ settings: s })))
  const change = (i: number, patch: Partial<FallbackModel>): void => void save(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  // A level's name as Hive ships it is shown in the window's language (#889), as the pickers show it; one the user gave stays theirs.
  const shownName = (r: T): string => {
    const shipped = kind === 'efforts' ? providerDescriptor(provider).effortLevels.find((e) => e.value === r.value && e.label === r.label) : undefined
    return shipped?.text ? tr(shipped.text) : r.label
  }
  const add = (): void => {
    const v = adding.trim()
    if (!v || rows.some((r) => r.value.toLowerCase() === v.toLowerCase())) return
    setAdding('')
    void save([...rows, { value: v, label: v } as T])
  }
  if (!open)
    return (
      <a className="fallback-toggle" onClick={() => setOpen(true)}>
        {kind === 'models' ? tr(msg({ id: 'settings.fallback.showModels', defaultMessage: 'Show the list ({n, plural, one {# model} other {# models}})', description: "A link that unfolds a provider's fallback list of models. {n} is how many it holds." }), { n: rows.length }) : tr(msg({ id: 'settings.fallback.showLevels', defaultMessage: 'Show the list ({n, plural, one {# level} other {# levels}})', description: "A link that unfolds a provider's fallback list of effort levels. {n} is how many it holds." }), { n: rows.length })}
      </a>
    )
  return (
    <>
      <table className="table fallback-list">
        <thead>
          <tr>
            <th>{valueLabel}</th>
            <th>{tr(msg({ id: 'settings.fallback.name', defaultMessage: 'Name', description: "A column of a provider's fallback list: the name pickers show." }))}</th>
            {kind === 'models' && <th>{tr(msg({ id: 'settings.fallback.older', defaultMessage: 'Older', description: "A column of a provider's fallback list of models: ticked, the model is listed under Older models." }))}</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.value}>
              <td>
                <input className="input mono" aria-label={tr(msg({ id: 'settings.fallback.valueCell', defaultMessage: '{column} {n}', description: "The name, for screen readers, of a box in a fallback list: the column and the row's number." }), { column: valueLabel, n: i + 1 })} defaultValue={r.value} key={`v:${r.value}`} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== r.value && change(i, { value: e.target.value.trim() })} />
              </td>
              <td>
                <input className="input" aria-label={tr(msg({ id: 'settings.fallback.nameCell', defaultMessage: 'Name {n}', description: "The name, for screen readers, of a row's Name box in a fallback list. {n} is the row's number." }), { n: i + 1 })} defaultValue={shownName(r)} key={`l:${r.value}:${shownName(r)}`} onBlur={(e) => e.target.value.trim() !== shownName(r) && change(i, { label: e.target.value.trim() || r.value })} />
              </td>
              {kind === 'models' && (
                <td>
                  <input type="checkbox" aria-label={tr(msg({ id: 'settings.fallback.olderCell', defaultMessage: 'Older {n}', description: "The name, for screen readers, of a row's Older box in a fallback list. {n} is the row's number." }), { n: i + 1 })} checked={!!(r as FallbackModel).older} onChange={(e) => change(i, { older: e.target.checked })} />
                </td>
              )}
              <td className="row-actions">
                <IconButton icon="trash" title={tr(msg({ id: 'settings.fallback.remove', defaultMessage: 'Remove', description: 'Button on a row of a fallback list: removes it.' }))} disabled={rows.length < 2} onClick={() => void save(rows.filter((_, j) => j !== i))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fallback-actions">
        <input className="input mono" placeholder={placeholder} aria-label={newLabel} value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn subtle" disabled={!adding.trim()} onClick={add}>
          <Icon name="add" /> {tr(msg({ id: 'settings.fallback.add', defaultMessage: 'Add', description: 'Button under a fallback list: adds the value typed beside it.' }))}
        </button>
        <button className="btn subtle" disabled={!edited} onClick={() => void save(null)}>
          <Icon name="discard" /> {tr(msg({ id: 'settings.fallback.reset', defaultMessage: 'Reset to defaults', description: "Button under a provider's table (prices, models or effort levels): goes back to Hive's own." }))}
        </button>
      </div>
    </>
  )
}

/** Settings → <provider> → Models (fallback): where the pickers' models come from now, and the list used without the CLI. */
function ModelFallbackTable({ provider }: { provider: ProviderId }) {
  const settings = useStore((s) => s.settings)
  const info = useStore((s) => s.providers[provider])
  const src = modelSource(provider, info, settings)
  const edited = !!providerSettings(settings, provider).modelFallback?.length
  const p = providerDescriptor(provider)
  return (
    <div className="fallback-table">
      <div className={cx('fallback-source', src.kind === 'fallback' ? 'warn' : 'faint')}>
        <Icon name={src.kind === 'fallback' ? 'warning' : 'check'} /> {tr(msg({ id: 'settings.fallback.modelsNow', defaultMessage: 'Models now: {source}', description: "Above a provider's fallback list of models: where the model pickers' models come from now. {source} says it." }), { source: modelSourceText(provider, { ...src, edited }, tr) })}
      </div>
      <FallbackRows provider={provider} kind="models" rows={fallbackModels(provider, settings)} edited={edited} valueLabel={tr(msg({ id: 'settings.fallback.modelId', defaultMessage: 'Model ID', description: "A column of a provider's fallback list of models: the ID Hive passes to the CLI." }))} newLabel={tr(msg({ id: 'settings.fallback.newModel', defaultMessage: 'New model ID', description: 'The name, for screen readers, of the box under a fallback list of models where a new one is typed.' }))} placeholder={providerText(p.modelPlaceholder, p.text?.modelPlaceholder, tr)} open={src.kind === 'fallback' || edited} />
    </div>
  )
}

/** Settings → <provider> → Effort levels (fallback). */
function EffortFallbackTable({ provider }: { provider: ProviderId }) {
  const settings = useStore((s) => s.settings)
  const info = useStore((s) => s.providers[provider])
  const edited = !!providerSettings(settings, provider).effortFallback?.length
  const perModel = !!info?.catalog?.models.some((m) => m.efforts)
  return (
    <div className="fallback-table">
      <div className="fallback-source faint">
        <Icon name={perModel ? 'check' : 'info'} />{' '}
        {perModel
          ? tr(msg({ id: 'settings.fallback.levelsPerModel', defaultMessage: "{source}: each model offers its own levels; this list names them and is used for models it doesn't describe.", description: "Above a provider's fallback list of effort levels, when the CLI reports each model's levels. {source} says where the models come from." }), { source: modelSourceText(provider, modelSource(provider, info, settings), tr) })
          : tr(msg({ id: 'settings.fallback.levelsUsed', defaultMessage: "Used now: {provider} hasn't reported per-model levels.", description: "Above a provider's fallback list of effort levels, when the CLI reports none per model. {provider} is its name." }), { provider: providerDescriptor(provider).name })}
      </div>
      <FallbackRows provider={provider} kind="efforts" rows={fallbackEfforts(provider, settings)} edited={edited} valueLabel={tr(msg({ id: 'settings.fallback.level', defaultMessage: 'Level', description: "A column of a provider's fallback list of effort levels: the value Hive passes to the CLI." }))} newLabel={tr(msg({ id: 'settings.fallback.newLevel', defaultMessage: 'New level', description: 'The name, for screen readers, of the box under a fallback list of effort levels where a new one is typed.' }))} placeholder={tr(msg({ id: 'settings.fallback.levelPlaceholder', defaultMessage: 'e.g. xhigh', description: "Placeholder of the box where a new effort level is typed. xhigh is a level's value: keep it." }))} open={!perModel || edited} />
    </div>
  )
}

/** Settings → <provider> → Default effort: the levels of the model new sessions run (the default model, else the CLI's). */
function GlobalEffortPicker({ provider }: { provider: ProviderId }) {
  const settings = useStore((s) => s.settings)
  const info = useStore((s) => s.providers[provider])
  const g = providerSettings(settings, provider)
  const setting = SETTINGS.find((d) => d.provider === provider && d.key === 'defaultEffort')!
  const model = g.defaultModel || info?.defaultModel || null
  const def = modelCaps(provider, model, info, settings).defaultEffort
  return <EffortPicker provider={provider} model={model} value={g.defaultEffort} base={{ value: '', label: !def ? tr(msg({ id: 'settings.provider.cliDefault', defaultMessage: '{provider} default', description: "The first choice of a model or effort list: the CLI's own default. {provider} is its name." }), { provider: providerDescriptor(provider).name }) : tr(msg({ id: 'settings.provider.cliDefaultIs', defaultMessage: '{provider} default ({which})', description: "The first choice of a model or effort list: the CLI's own default, and which model or level that is. {provider} is its name." }), { provider: providerDescriptor(provider).name, which: effortName(provider, def, settings, tr) }) }} onChange={(v) => void update(setting, v)} />
}

function GlobalModelPicker({ provider }: { provider: ProviderId }) {
  const value = useStore((s) => providerSettings(s.settings, provider).defaultModel)
  const def = SETTINGS.find((d) => d.provider === provider && d.key === 'defaultModel')!
  return <ModelPicker provider={provider} value={value} base={{ value: '', label: tr(msg({ id: 'settings.provider.cliDefault', defaultMessage: '{provider} default', description: "The first choice of a model or effort list: the CLI's own default. {provider} is its name." }), { provider: providerDescriptor(provider).name }) }} onChange={(v) => void update(def, v)} />
}

/** A row's value: Hive's settings, or the open workspace's own (Settings → Workspace's card loops, #412). */
const getValue = (s: AppSettings, def: SettingDef, loops: WorkspaceConfig['loops']): unknown => settingValue(def, s, null, { loops })

const defaultValue = (def: SettingDef): unknown => settingDefault(def)

async function saveSettings(patch: SettingsPatch): Promise<void> {
  const s = await actions.attempt(tr(msg({ id: 'settings.saveFailed', defaultMessage: 'Could not save setting', description: "An error's title: saving a setting failed." })), () => call('settings:update', patch))
  if (s) set({ settings: s })
}

/** A row's text as Settings shows it, in the user's language (#767). */
const rowText = (d: SettingEntry): { title: string; desc: string; tip: string } => shownSetting(d)

/** Why a row can't be changed now, as shown; null when it can. */
function disabledText(d: SettingEntry, settings: AppSettings): string | null {
  const why = d.disabledBy?.(settings)
  return why ? shownText(why) : null
}

/** A row's default as its Reset button names it: the value as it is, or empty. */
function defaultShown(d: SettingEntry): string {
  const v = defaultValue(d)
  return v ? String(v) : tr(msg({ id: 'settings.emptyDefault', defaultMessage: 'empty', description: 'In "Reset to default (empty)": the setting\'s default is empty.' }))
}

/** Saves a row's new value through the change the catalog gives for it (the Assistant's settings tool makes the same). */
async function update(def: SettingDef, value: unknown): Promise<void> {
  if (def.action) return
  const change = settingPatch(def, value)
  if ('settings' in change) return saveSettings(change.settings as SettingsPatch)
  if ('workspace' in change) {
    const info = await actions.attempt(tr(msg({ id: 'settings.saveFailed', defaultMessage: 'Could not save setting', description: "An error's title: saving a setting failed." })), () => call('workspace:setLoops', change.workspace))
    if (info) set({ workspace: info })
  }
}

/** Turns a provider on or off. Turning it off with agents running asks whether to stop them. */
export async function setProviderEnabled(provider: ProviderId, on: boolean): Promise<void> {
  const name = providerDescriptor(provider).name
  if (!on) {
    // Providers are app-wide: list the agents running it in every window, naming the other windows' workspaces.
    const here = get().workspace?.path.toLowerCase()
    const leaf = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
    const live = (await actions.attempt(tr(msg({ id: 'settings.providerOff.listFailed', defaultMessage: 'Could not list the running agents', description: "An error's title: listing the agents that run a provider, before turning it off, failed." })), () => call('session:live'))) ?? []
    const running = live
      .filter((s) => s.provider === provider)
      .map((s) => {
        const parent = s.projectPath.replace(/[\\/][^\\/]+[\\/]?$/, '')
        const where = parent.toLowerCase() === here ? leaf(s.projectPath) : tr(msg({ id: 'settings.providerOff.otherWindow', defaultMessage: '{workspace}/{project} (another window)', description: 'In the list of agents running a provider that is being turned off: a project open in another window. {workspace} and {project} are folder names.' }), { workspace: leaf(parent), project: leaf(s.projectPath) })
        return s.agentName ? `${where} · ${s.agentName}` : where
      })
    if (running.length) {
      const choice = await choose({
        title: tr(msg({ id: 'settings.providerOff.title', defaultMessage: 'Turn off {provider}?', description: 'Title of the question before a provider is turned off while its agents run. {provider} is its name.' }), { provider: name }),
        message: tr(msg({ id: 'settings.providerOff.message', defaultMessage: '{n, plural, one {An agent is running {provider}: {agents}.} other {# agents are running {provider}: {agents}.}}', description: 'The question before a provider is turned off while its agents run. {provider} is its name; {agents} lists them (project · agent).' }), { n: running.length, provider: name, agents: fmt.list(running) }),
        detail: tr(msg({ id: 'settings.providerOff.detail', defaultMessage: 'Stop them now, or let them run until they are stopped. Either way no new ones start while it is off.', description: 'More in the question before a provider is turned off while its agents run.' })),
        choices: [
          { label: tr(msg({ id: 'settings.providerOff.run', defaultMessage: 'Let them run', description: 'Choice in the question before a provider is turned off: its agents keep running.' })), value: 'run' },
          { label: tr(msg({ id: 'settings.providerOff.stop', defaultMessage: 'Stop them now', description: 'Choice in the question before a provider is turned off: its agents stop now.' })), value: 'stop' }
        ]
      })
      if (!choice) return
      if (choice === 'stop') await actions.attempt(tr(msg({ id: 'settings.providerOff.stopFailed', defaultMessage: 'Could not stop the {provider} agents', description: "An error's title: stopping a provider's agents failed. {provider} is its name." }), { provider: name }), () => call('provider:stopAgents', provider))
    }
  }
  await saveSettings({ providers: { [provider]: { enabled: on } } } as SettingsPatch)
}

function Control({ def, settings }: { def: SettingDef; settings: AppSettings }) {
  // The workspace's own values come from its config: shown again when it changes.
  const loops = useStore((s) => s.workspace?.config.loops)
  const value = getValue(settings, def, loops)
  const [draft, setDraft] = useState(String(value ?? ''))
  useEffect(() => setDraft(String(value ?? '')), [value])
  switch (def.type) {
    case 'custom':
      return <>{def.render?.()}</>
    case 'boolean':
      return (
        <Switch
          checked={!!value}
          label={rowText(def).title}
          disabled={!!def.disabledBy?.(settings)}
          onChange={async (v) => {
            const ask = def.text.confirmOn
            if (v && ask && !(await confirm({ title: shownText(ask.title), message: shownText(ask.message), ...(ask.detail ? { detail: shownText(ask.detail) } : {}), confirmLabel: tr(msg({ id: 'settings.enable', defaultMessage: 'Enable', description: 'Button of the confirmation before a risky setting is turned on.' })), danger: true }))) return
            void update(def, v)
          }}
        />
      )
    case 'select':
      return (
        <select className="select" value={String(value ?? '')} onChange={(e) => void update(def, e.target.value)}>
          {def.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {shownText(o.text)}
            </option>
          ))}
        </select>
      )
    case 'range':
      return (
        <div className="flex" style={{ width: '100%' }}>
          <input className="range" type="range" min={def.min} max={def.max} step={def.step} value={Number(value)} onChange={(e) => void update(def, Number(e.target.value))} />
          <span className="muted" style={{ minWidth: 40, textAlign: 'right', whiteSpace: 'nowrap' }}>{fmt.percent(Number(value))}</span>
        </div>
      )
    case 'number':
      return (
        <NumberField
          value={Number(value)}
          min={def.min}
          max={def.max}
          step={def.step}
          label={rowText(def).title}
          off={def.off && def.text.off ? { label: shownText(def.text.off), restore: Number(defaultValue(def)) || null } : undefined}
          onCommit={(v) => update(def, v)}
        />
      )
    case 'text': {
      const commit = (): void => {
        if (draft !== value) void update(def, draft.trim())
      }
      return <input className="input" value={draft} placeholder={def.placeholder === undefined ? undefined : shownText(def.placeholder)} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    }
  }
}

function ProviderToggle({ provider }: { provider: ProviderId }) {
  const on = useStore((s) => isProviderEnabled(s.settings, provider))
  return <Switch checked={on} label={tr(msg({ id: 'settings.provider.use', defaultMessage: 'Use {provider}', description: 'The switch that turns a provider on (Settings → Providers, and its own page). {provider} is its name.' }), { provider: providerDescriptor(provider).name })} onChange={(v) => void setProviderEnabled(provider, v)} />
}

function ProviderStatus({ provider }: { provider: ProviderId }) {
  const info = useStore((s) => s.providers[provider])
  if (!info || info.checking)
    return (
      <span className="muted">
        <Icon name="loading" spin /> {tr(msg({ id: 'settings.provider.checking', defaultMessage: 'Checking…', description: "While Hive looks for a provider's CLI (Settings → <provider> → Installation)." }))}
      </span>
    )
  const problems = (info.readiness ?? []).filter((r) => r.level !== 'info')
  return (
    <div className="flex" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {info.found ? (
        <Tooltip content={info.path}>
          <span className="badge success">
            <Icon name="check" /> {info.version} · {installSourceText(info.source, tr)}
          </span>
        </Tooltip>
      ) : (
        <span className="badge error">{tr(msg({ id: 'settings.provider.notInstalled', defaultMessage: 'CLI not installed', description: "A badge on a provider's page: Hive didn't find its CLI." }))}</span>
      )}
      {info.found &&
        problems.map((r) => (
          <span key={r.id} className={cx('badge', r.level === 'error' ? 'error' : 'accent')}>
            {r.message}
          </span>
        ))}
      {info.updateAvailable && <span className="badge accent">{tr(msg({ id: 'settings.provider.updateAvailable', defaultMessage: '{version} available', description: "A badge on a provider's page: a newer version of its CLI. {version} is its number." }), { version: info.latestVersion ?? '' })}</span>}
      <button className="btn small subtle" onClick={() => void actions.refreshProviders()}>
        {tr(msg({ id: 'settings.provider.checkNow', defaultMessage: 'Check now', description: "Button on a provider's page: looks for its CLI and updates again." }))}
      </button>
      <button className="btn small primary" onClick={() => set({ setupOpen: provider })}>
        {info.found ? tr(msg({ id: 'settings.provider.manage', defaultMessage: 'Manage', description: "Button on a provider's page: opens Agent Setup for the installed CLI." })) : tr(msg({ id: 'settings.provider.install', defaultMessage: 'Install', description: "Button on a provider's page: opens Agent Setup to install its CLI." }))}
      </button>
    </div>
  )
}

/** Every provider with its on/off switch and install state. */
function ProvidersList() {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  return (
    <div className="provider-list">
      {PROVIDERS.map((p) => {
        const info = providers[p.id]
        const on = isProviderEnabled(settings, p.id)
        const state = !info || info.checking ? tr(msg({ id: 'settings.provider.checking', defaultMessage: 'Checking…', description: "While Hive looks for a provider's CLI (Settings → <provider> → Installation)." })) : !info.found ? tr(msg({ id: 'settings.provider.notInstalledShort', defaultMessage: 'Not installed', description: "Under a provider in Settings → Providers: Hive didn't find its CLI." })) : (info.readiness?.find((r) => r.level === 'error')?.message ?? tr(msg({ id: 'settings.provider.installed', defaultMessage: 'Installed · {version}', description: 'Under a provider in Settings → Providers: its CLI is installed. {version} is its number.' }), { version: info.version ?? '' }))
        return (
          <div key={p.id} className={cx('provider-row', !on && 'off')}>
            <ProviderIcon provider={p.id} />
            <div className="grow">
              <div>
                <strong>{p.name}</strong> <span className="faint">{tr(msg({ id: 'settings.provider.by', defaultMessage: 'by {company}', description: "Beside a provider's name in Settings → Providers: the company that makes it." }), { company: p.company })}</span>
              </div>
              <div className="faint small">{state}</div>
            </div>
            <button className="btn small subtle" onClick={() => set({ settingsSection: providerSection(p.id), settingsQuery: '' })}>
              {tr(msg({ id: 'settings.provider.settings', defaultMessage: 'Settings', description: 'Button beside a provider in Settings → Providers: opens its page.' }))}
            </button>
            <Switch checked={on} label={tr(msg({ id: 'settings.provider.use', defaultMessage: 'Use {provider}', description: 'The switch that turns a provider on (Settings → Providers, and its own page). {provider} is its name.' }), { provider: p.name })} onChange={(v) => void setProviderEnabled(p.id, v)} />
          </div>
        )
      })}
    </div>
  )
}

function AssistantProviderPicker() {
  const settings = useStore((s) => s.settings)
  const on = enabledProviders(settings)
  const current = settings?.assistant.provider ?? ''
  // The window re-renders when what's installed changes: Automatic follows it.
  useStore((s) => s.providers)
  return (
    <select className="select" value={current} onChange={(e) => void saveSettings({ assistant: { provider: e.target.value } })}>
      <option value="">{tr(msg({ id: 'settings.assistant.defaultProvider', defaultMessage: 'Default provider ({provider})', description: 'The first choice of Settings → Assistant → Provider: the default provider, and which one that is now.' }), { provider: defaultProviderLabel(settings, tr) })}</option>
      {PROVIDERS.filter((p) => on.includes(p) || p.id === current).map((p) => (
        <option key={p.id} value={p.id}>
          {on.includes(p) ? p.name : tr(SETTINGS_TEXT.providerOff, { provider: p.name })}
        </option>
      ))}
    </select>
  )
}

/** Hive's modes, for choosing a default before a workspace is open. */
const SHIPPED_MODES = [
  { id: 'coordinator', name: 'Coordinator', icon: '🧭', bundled: 'same' as const }, // i18n-ignore: the shipped modes' names, as their files name them (modeName shows them translated)
  { id: 'planner', name: 'Planner', icon: '🗺️', bundled: 'same' as const }, // i18n-ignore: the shipped modes' names, as their files name them (modeName shows them translated)
  { id: 'qa-triager', name: 'QA triager', icon: '🔍', bundled: 'same' as const }, // i18n-ignore: the shipped modes' names, as their files name them (modeName shows them translated)
  { id: 'release-manager', name: 'Release manager', icon: '📦', bundled: 'same' as const } // i18n-ignore: the shipped modes' names, as their files name them (modeName shows them translated)
]

function AssistantModePicker() {
  const current = useStore((s) => s.settings?.assistant.mode) || DEFAULT_MODE
  const own = useModes().filter((p) => p.bundled !== 'missing')
  const list = own.length ? own : SHIPPED_MODES
  return (
    <select className="select" value={current} onChange={(e) => void saveSettings({ assistant: { mode: e.target.value } })}>
      {!list.some((p) => p.id === current) && <option value={current}>{current}</option>}
      {list.map((p) => (
        <option key={p.id} value={p.id}>
          {p.icon ? `${p.icon} ` : ''}
          {modeName(p)}
        </option>
      ))}
    </select>
  )
}

/** The Assistant's model, effort, mode and arguments with one provider. */
function AssistantProviderDefaults({ provider }: { provider: ProviderId }) {
  const settings = useStore((s) => s.settings)
  const p = providerDescriptor(provider)
  const a = settings?.assistant.providers[provider] ?? { model: '', effort: '', permissionMode: '', extraArgs: '', use200kContext: '' as const }
  const g = providerSettings(settings, provider)
  const [args, setArgs] = useState(a.extraArgs)
  useEffect(() => setArgs(a.extraArgs), [a.extraArgs])
  const save = (patch: Partial<typeof a>): void => void saveSettings({ assistant: { providers: { [provider]: patch } } } as SettingsPatch)
  const info = useStore((s) => s.providers[provider])
  const cliDefault = info?.defaultModel ?? null
  const runModel = a.model || g.defaultModel || cliDefault
  // The level itself, "Default (Medium)": effortText's "Medium, default" would say default twice (#911). Not known: "Claude Code's default", no outer "Default (…)" (#916).
  const effortLevel = g.defaultEffort && g.defaultEffort !== 'inherit' ? g.defaultEffort : modelCaps(provider, runModel, info, settings).defaultEffort
  const effortLabel = !effortLevel ? cliDefaultEffort(provider, tr) : tr(msg({ id: 'settings.assistant.defaultIs', defaultMessage: 'Default ({value})', description: 'The first choice of a list in Settings → Assistant → With <provider>: what applies when nothing is chosen. {value} says what that is.' }), { value: effortName(provider, effortLevel, settings, tr) })
  return (
    <div className="agent-form assistant-defaults">
      <label>{tr(msg({ id: 'settings.assistantProvider.model.title', defaultMessage: 'Model', description: "A field's title in Settings → Assistant → With <provider>: the Assistant's model." }))}</label>
      <ModelPicker provider={provider} value={a.model} base={{ value: '', label: g.defaultModel ? tr(msg({ id: 'settings.provider.cliDefaultIs', defaultMessage: '{provider} default ({which})', description: "The first choice of a model or effort list: the CLI's own default, and which model or level that is. {provider} is its name." }), { provider: p.name, which: runsAsName(provider, g.defaultModel, info) }) : tr(msg({ id: 'settings.provider.cliDefault', defaultMessage: '{provider} default', description: "The first choice of a model or effort list: the CLI's own default. {provider} is its name." }), { provider: p.name }) }} onChange={(v) => save({ model: v })} />
      <label>{tr(msg({ id: 'settings.assistantProvider.effort.title', defaultMessage: 'Effort', description: "A field's title in Settings → Assistant → With <provider>: the Assistant's reasoning effort." }))}</label>
      <EffortPicker provider={provider} model={runModel} value={a.effort} base={{ value: '', label: effortLabel }} onChange={(v) => save({ effort: v as EffortLevel | '' })} />
      <label>{tr(msg({ id: 'settings.assistantProvider.permissionMode.title', defaultMessage: 'Permission mode', description: "A field's title in Settings → Assistant → With <provider>: the Assistant's permission mode." }))}</label>
      <select className="select" value={a.permissionMode} onChange={(e) => save({ permissionMode: e.target.value as PermissionMode | '' })}>
        <option value="">{tr(msg({ id: 'settings.assistant.defaultIs', defaultMessage: 'Default ({value})', description: 'The first choice of a list in Settings → Assistant → With <provider>: what applies when nothing is chosen. {value} says what that is.' }), { value: permissionLabel(provider, p.assistantMode, tr) })}</option>
        {offeredModes(provider, settings, true)
          .filter((m) => m.value !== p.assistantMode)
          .map((m) => (
            <option key={m.value} value={m.value}>
              {permissionLabel(provider, m.value, tr)}
            </option>
          ))}
      </select>
      <ModeCaveat provider={provider} mode={a.permissionMode || p.assistantMode} model={a.model || g.defaultModel || cliDefault} />
      {p.capabilities.contextLimit && (
        <>
          <label>{tr(msg({ id: 'settings.assistantProvider.use200kContext.title', defaultMessage: 'Use 200K context (instead of 1M)', description: "A field's title in Settings → Assistant → With <provider>. 200K and 1M are numbers of tokens." }))}</label>
          <select className="select" value={a.use200kContext ?? ''} onChange={(e) => save({ use200kContext: e.target.value as '' | 'on' | 'off' })}>
            <option value="">{tr(msg({ id: 'settings.assistant.defaultIs', defaultMessage: 'Default ({value})', description: 'The first choice of a list in Settings → Assistant → With <provider>: what applies when nothing is chosen. {value} says what that is.' }), { value: g.use200kContext ? tr(msg({ id: 'settings.option.on', defaultMessage: 'On', description: 'A choice of a setting that is on or off, beside Inherit or Default.' })) : tr(msg({ id: 'settings.option.off', defaultMessage: 'Off', description: 'A choice of a setting that is on or off, beside Inherit or Default.' })) })}</option>
            <option value="on">{tr(msg({ id: 'settings.option.on', defaultMessage: 'On', description: 'A choice of a setting that is on or off, beside Inherit or Default.' }))}</option>
            <option value="off">{tr(msg({ id: 'settings.option.off', defaultMessage: 'Off', description: 'A choice of a setting that is on or off, beside Inherit or Default.' }))}</option>
          </select>
        </>
      )}
      <label>{tr(msg({ id: 'settings.assistantProvider.extraArgs.title', defaultMessage: 'Extra arguments', description: "A field's title in Settings → Assistant → With <provider>: command-line arguments." }))}</label>
      <input className="input" value={args} placeholder={tr(msg({ id: 'settings.assistantDefaults.extraArgsPlaceholder', defaultMessage: 'e.g. --verbose', description: 'The empty box\'s placeholder of the setting "Extra arguments". --verbose is an argument: keep it.' }))} onChange={(e) => setArgs(e.target.value)} onBlur={() => args !== a.extraArgs && save({ extraArgs: args.trim() })} />
    </div>
  )
}

function DefaultProviderPicker() {
  const settings = useStore((s) => s.settings)
  const on = enabledProviders(settings)
  const def = SETTINGS.find((d) => d.key === 'defaultProvider')!
  const current = settings?.defaultProvider ?? ''
  // Automatic names what it picks now, which follows what's installed.
  useStore((s) => s.providers)
  return (
    <select className="select" value={current} onChange={(e) => void update(def, e.target.value)}>
      <option value={AUTO_PROVIDER}>{defaultProviderLabel(settings && { ...settings, defaultProvider: AUTO_PROVIDER }, tr)}</option>
      {PROVIDERS.filter((p) => on.includes(p) || p.id === current).map((p) => (
        <option key={p.id} value={p.id}>
          {on.includes(p) ? p.name : tr(SETTINGS_TEXT.providerOff, { provider: p.name })}
        </option>
      ))}
    </select>
  )
}

function ClearUsageCacheButton() {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className="btn subtle"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void call('session:clearUsageCache')
          .then(() => notify('info', tr(msg({ id: 'settings.usageCache.cleared', defaultMessage: 'Usage cache cleared', description: 'A notice after Settings → Sessions → Clear the usage cache.' })), tr(msg({ id: 'settings.usageCache.clearedDetail', defaultMessage: 'Each transcript is read again the next time it is shown.', description: 'More in the notice after the usage cache was cleared.' }))))
          .catch((e) => notify('error', tr(msg({ id: 'settings.usageCache.clearFailed', defaultMessage: 'Could not clear the usage cache', description: "An error's title: clearing the usage cache failed." })), errorMessage(e)))
          .finally(() => setBusy(false))
      }}
    >
      <Icon name="clear-all" /> {tr(msg({ id: 'settings.usageCache.clear', defaultMessage: 'Clear', description: 'Button of Settings → Sessions → Clear the usage cache.' }))}
    </button>
  )
}

function ResetMetricsButton() {
  const [busy, setBusy] = useState(false)
  const workspace = useStore((st) => st.workspace)
  return (
    <button
      className="btn subtle"
      disabled={busy || !workspace}
      onClick={() => {
        void confirm({
          title: tr(msg({ id: 'settings.metrics.resetTitle', defaultMessage: 'Reset performance metrics?', description: 'Title of the question before the recorded performance metrics are cleared.' })),
          message: tr(msg({ id: 'settings.metrics.resetMessage', defaultMessage: "Clear this workspace's recorded performance metrics?", description: 'The question before the recorded performance metrics are cleared.' })),
          detail: tr(msg({ id: 'settings.metrics.resetDetail', defaultMessage: 'The history starts again from now.', description: 'More in the question before the performance metrics are cleared.' })),
          confirmLabel: tr(msg({ id: 'settings.reset', defaultMessage: 'Reset', description: 'Button of a confirmation that resets something to its defaults or clears it.' })),
          danger: true
        }).then((ok) => {
          if (!ok) return
          setBusy(true)
          void call('metrics:reset')
            .then(() => notify('info', tr(msg({ id: 'settings.metrics.wasReset', defaultMessage: 'Performance metrics reset', description: 'A notice after the performance metrics were cleared.' }))))
            .catch((e) => notify('error', tr(msg({ id: 'settings.metrics.resetFailed', defaultMessage: 'Could not reset the performance metrics', description: "An error's title: clearing the performance metrics failed." })), errorMessage(e)))
            .finally(() => setBusy(false))
        })
      }}
    >
      <Icon name="discard" /> {tr(msg({ id: 'settings.reset', defaultMessage: 'Reset', description: 'Button of a confirmation that resets something to its defaults or clears it.' }))}
    </button>
  )
}

/** A colour picker per board column, saved a moment after the pick settles (the picker reports every drag). */
function ColumnColors() {
  const board = useStore((st) => st.settings!.board)
  const [draft, setDraft] = useState<Partial<Record<TaskColumn, string>>>({})
  useEffect(() => {
    if (!Object.keys(draft).length) return
    const t = setTimeout(() => {
      void saveSettings({ board: { colors: draft } } as SettingsPatch)
      setDraft({})
    }, 300)
    return () => clearTimeout(t)
  }, [draft])
  return (
    <div className={cx('column-colors', !board.columnColors && 'off')}>
      {TASK_COLUMNS.map((c) => {
        const value = draft[c.id] ?? columnColor(board.colors, c.id)
        const name = columnName(c.id, tr)
        return (
          <label key={c.id} className="column-color">
            <input type="color" value={value} aria-label={tr(msg({ id: 'settings.columnColors.pick', defaultMessage: '{column} colour', description: "The name, for screen readers, of a board column's colour picker (Settings → Board → Column colours). {column} is the column's name." }), { column: name })} onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))} />
            <span>{name}</span>
            {value.toLowerCase() !== DEFAULT_COLUMN_COLORS[c.id] && (
              <IconButton icon="discard" title={tr(msg({ id: 'settings.columnColors.reset', defaultMessage: 'Reset {column} to its default', description: "Button beside a board column's colour: puts back its default colour. {column} is the column's name." }), { column: name })} onClick={() => void saveSettings({ board: { colors: { [c.id]: DEFAULT_COLUMN_COLORS[c.id] } } } as SettingsPatch)} />
            )}
          </label>
        )
      })}
    </div>
  )
}

/**
 * Settings → General → Language (#767): Automatic, then each of Hive's languages by its own name, those drafted by AI
 * marked, with the chosen one's note in its own words under the list. What a language hasn't translated yet shows in
 * English.
 */
function LanguagePicker() {
  useLanguage()
  const value = useStore((s) => s.settings?.general.language ?? 'auto')
  const info = useStore((s) => s.appInfo?.language)
  const def = SETTINGS.find((d) => d.id === 'general.language')!
  const automatic = languageOf(info?.automatic ?? SOURCE_LANGUAGE)
  const noted = languageOf(value === 'auto' ? (info?.automatic ?? SOURCE_LANGUAGE) : value)
  return (
    <div className="language-picker" style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
      <select className="select" value={value} onChange={(e) => void update(def, e.target.value)}>
        <option value="auto">{tr(LANGUAGE_TEXT.automatic, { language: automatic?.name ?? SOURCE_LANGUAGE })}</option>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.ai && l.aiMark ? `${l.name} ${l.aiMark}` : l.name}
          </option>
        ))}
      </select>
      {noted?.ai && noted.aiNote && (
        <div className="s-desc" lang={noted.code}>
          {noted.aiNote}
        </div>
      )}
      {info?.forced ? <div className="s-desc muted">{tr(LANGUAGE_TEXT.forced, { language: info.forced })}</div> : info && info.code !== info.startCode && <div className="s-desc muted">{tr(LANGUAGE_TEXT.restart)}</div>}
    </div>
  )
}

function ChimePicker() {
  const s = useStore((st) => st.settings!)
  const sounds: { value: ChimeSound; label: string }[] = [
    { value: 'chime', label: tr(msg({ id: 'settings.chime.chime', defaultMessage: 'Chime', description: 'A sound of Settings → Notifications → Chime sound.' })) },
    { value: 'bell', label: tr(msg({ id: 'settings.chime.bell', defaultMessage: 'Bell', description: 'A sound of Settings → Notifications → Chime sound.' })) },
    { value: 'soft', label: tr(msg({ id: 'settings.chime.soft', defaultMessage: 'Soft', description: 'A sound of Settings → Notifications → Chime sound.' })) },
    { value: 'pop', label: tr(msg({ id: 'settings.chime.pop', defaultMessage: 'Pop', description: 'A sound of Settings → Notifications → Chime sound.' })) }
  ]
  return (
    <div className="flex" style={{ width: '100%' }}>
      <select className="select" value={s.notifications.chimeSound} onChange={(e) => void call('settings:update', { notifications: { chimeSound: e.target.value as ChimeSound } }).then((ns) => set({ settings: ns }))}>
        {sounds.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <IconButton icon="play" title={tr(msg({ id: 'settings.chime.play', defaultMessage: 'Play', description: 'Button beside Settings → Notifications → Chime sound: plays it.' }))} onClick={() => playChime(s.notifications.chimeSound, s.notifications.chimeVolume)} />
    </div>
  )
}

function ApiStatus() {
  const api = useStore((s) => s.api)
  if (!api) return null
  return api.running ? (
    <span className="badge success">
      <Icon name="broadcast" /> {tr(msg({ id: 'settings.api.listening', defaultMessage: 'Listening on {url}', description: 'Settings → Agent API → Status while the API runs. {url} is its address.' }), { url: api.url ?? '' })}
    </span>
  ) : api.error ? (
    <span className="badge error">{api.error}</span>
  ) : (
    <span className="badge">{tr(msg({ id: 'settings.api.off', defaultMessage: 'Off', description: 'Settings → Agent API → Status while the API is turned off.' }))}</span>
  )
}

function ApiToken() {
  const api = useStore((s) => s.api)
  const [show, setShow] = useState(false)
  if (!api) return null
  return (
    <div className="token-box">
      <input className="input" readOnly value={show ? api.token : '•'.repeat(24)} />
      <IconButton icon={show ? 'eye-closed' : 'eye'} title={show ? tr(msg({ id: 'settings.token.hide', defaultMessage: 'Hide', description: 'Button beside a token: hides it again.' })) : tr(msg({ id: 'settings.token.show', defaultMessage: 'Show', description: 'Button beside a hidden token: shows it.' }))} onClick={() => setShow(!show)} />
      <IconButton
        icon="copy"
        title={tr(msg({ id: 'settings.token.copy', defaultMessage: 'Copy', description: 'Button beside a token: copies it.' }))}
        onClick={() => {
          void navigator.clipboard.writeText(api.token)
          notify('success', tr(msg({ id: 'settings.token.copied', defaultMessage: 'Token copied', description: 'A notice after a token was copied.' })))
        }}
      />
      <IconButton
        icon="refresh"
        action="regenerate-token"
        title={tr(msg({ id: 'settings.token.regenerate', defaultMessage: 'Regenerate', description: "Button beside the Agent API's token: makes a new one." }))}
        onClick={async () => {
          if (
            !(await confirm({
              title: tr(msg({ id: 'settings.token.regenerateTitle', defaultMessage: 'Regenerate token?', description: "Title of the question before the Agent API's token is replaced." })),
              message: tr(msg({ id: 'settings.token.regenerateMessage', defaultMessage: 'Programs using the current token will stop working. Running sessions pick up the new token when restarted.', description: "The question before the Agent API's token is replaced." })),
              confirmLabel: tr(msg({ id: 'settings.token.regenerate', defaultMessage: 'Regenerate', description: "Button beside the Agent API's token: makes a new one." })),
              danger: true
            }))
          )
            return
          set({ api: await call('api:regenerateToken') })
        }}
      />
    </div>
  )
}

/** Settings → Agent API → Viewer tokens (#620): read-only tokens for apps that show Hive, made and revoked here. */
function ViewerTokens() {
  const api = useStore((s) => s.api)
  const [name, setName] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  if (!api) return null
  const create = async (): Promise<void> => {
    const n = name.trim()
    if (!n) return
    try {
      const info = await call('api:createViewer', n)
      set({ api: info })
      setName('')
      // The new one shows, ready to copy into its app.
      setShown(info.viewers.find((v) => v.name === n)?.id ?? null)
      notify('success', tr(msg({ id: 'settings.viewers.made', defaultMessage: 'Viewer token "{name}" made', description: 'A notice after a viewer token was made (Settings → Agent API → Viewer tokens). {name} is the name the user gave it.' }), { name: n }), tr(msg({ id: 'settings.viewers.madeDetail', defaultMessage: 'Copy it into the app it is for.', description: 'More in the notice after a viewer token was made.' })))
    } catch (e) {
      notify('error', tr(msg({ id: 'settings.viewers.makeFailed', defaultMessage: 'Could not make the viewer token', description: "An error's title: making a viewer token failed." })), errorMessage(e))
    }
  }
  const revoke = async (id: string, label: string): Promise<void> => {
    if (
      !(await confirm({
        title: tr(msg({ id: 'settings.viewers.revokeTitle', defaultMessage: 'Revoke "{name}"?', description: 'Title of the question before a viewer token is revoked. {name} is its name.' }), { name: label }),
        message: tr(msg({ id: 'settings.viewers.revokeMessage', defaultMessage: 'The app using it can no longer read Hive, and its event stream ends now.', description: 'The question before a viewer token is revoked.' })),
        confirmLabel: tr(msg({ id: 'settings.viewers.revoke', defaultMessage: 'Revoke', description: 'Button: revokes a viewer token.' })),
        danger: true
      }))
    )
      return
    try {
      set({ api: await call('api:revokeViewer', id) })
    } catch (e) {
      notify('error', tr(msg({ id: 'settings.viewers.revokeFailed', defaultMessage: 'Could not revoke the viewer token', description: "An error's title: revoking a viewer token failed." })), errorMessage(e))
    }
  }
  return (
    <div className="viewer-tokens">
      {api.viewers.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>{tr(msg({ id: 'settings.viewers.name', defaultMessage: 'Name', description: 'A column of the viewer tokens table: the name the user gave a token.' }))}</th>
              <th>{tr(msg({ id: 'settings.viewers.token', defaultMessage: 'Token', description: 'A column of the viewer tokens table: the token.' }))}</th>
              <th>{tr(msg({ id: 'settings.viewers.madeColumn', defaultMessage: 'Made', description: 'A column of the viewer tokens table: when the token was made.' }))}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {api.viewers.map((v) => (
              <tr key={v.id}>
                <td>{v.name}</td>
                <td>
                  <div className="token-box">
                    <input className="input" readOnly aria-label={tr(msg({ id: 'settings.viewers.tokenOf', defaultMessage: "{name}'s token", description: "The name, for screen readers, of a viewer token's box. {name} is the token's name." }), { name: v.name })} value={shown === v.id ? v.token : '•'.repeat(24)} />
                    <IconButton icon={shown === v.id ? 'eye-closed' : 'eye'} title={shown === v.id ? tr(msg({ id: 'settings.token.hide', defaultMessage: 'Hide', description: 'Button beside a token: hides it again.' })) : tr(msg({ id: 'settings.token.show', defaultMessage: 'Show', description: 'Button beside a hidden token: shows it.' }))} onClick={() => setShown(shown === v.id ? null : v.id)} />
                    <IconButton
                      icon="copy"
                      title={tr(msg({ id: 'settings.token.copy', defaultMessage: 'Copy', description: 'Button beside a token: copies it.' }))}
                      onClick={() => {
                        void navigator.clipboard.writeText(v.token)
                        notify('success', tr(msg({ id: 'settings.token.copied', defaultMessage: 'Token copied', description: 'A notice after a token was copied.' })))
                      }}
                    />
                  </div>
                </td>
                <td className="faint">{timeAgo(v.createdAt)}</td>
                <td className="row-actions">
                  <button className="btn small subtle" onClick={() => void revoke(v.id, v.name)}>
                    {tr(msg({ id: 'settings.viewers.revoke', defaultMessage: 'Revoke', description: 'Button: revokes a viewer token.' }))}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="fallback-actions">
        <input className="input" placeholder={tr(msg({ id: 'settings.viewers.namePlaceholder', defaultMessage: 'Name, e.g. Apiary', description: "Placeholder of the box where a new viewer token's name is typed. Apiary is an app's name: keep it." }))} aria-label={tr(msg({ id: 'settings.viewers.nameLabel', defaultMessage: "New viewer token's name", description: "The name, for screen readers, of the box where a new viewer token's name is typed." }))} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
        <button className="btn subtle" disabled={!name.trim()} onClick={() => void create()}>
          <Icon name="add" /> {tr(msg({ id: 'settings.viewers.make', defaultMessage: 'Make viewer token', description: 'Button: makes a viewer token with the name typed beside it.' }))}
        </button>
      </div>
    </div>
  )
}

/** Settings → Advanced's list (#367), filtered by Settings' own search and Modified only too. */
function AdvancedValues() {
  const query = useStore((s) => s.settingsQuery)
  const modifiedOnly = useStore((s) => s.settingsModifiedOnly)
  return <AdvancedSettings query={query} modifiedOnly={modifiedOnly} />
}

/** Whether Settings' search, or Modified only, finds something in Advanced's list (its values aren't rows of their own). */
function advancedMatches(q: string, modifiedOnly: boolean, advanced: AdvancedState | null): boolean {
  const words = q.split(/\s+/).filter(Boolean)
  const hits = (text: string): boolean => words.every((w) => text.toLowerCase().includes(w))
  // Its English matches as well as what it shows, as Settings' own rows do.
  return ADVANCED_DEFS.some((d) => (!modifiedOnly || advanced?.values[d.id] !== undefined || advanced?.workspace?.[d.id] !== undefined) && hits(`${d.id} ${d.setting ?? ''} ${groupName(d.group)} ${d.title} ${d.desc} ${shownText(d.text.title)} ${shownText(d.text.desc)}`))
}

function DataFolder() {
  const info = useStore((s) => s.appInfo)
  const path = info ? `${info.userData}\\config.json` : ''
  return (
    <div className="token-box">
      <input className="input" readOnly value={path} />
      <IconButton
        icon="copy"
        title={tr(msg({ id: 'settings.data.copyPath', defaultMessage: 'Copy path', description: "Button beside the settings file's path (Settings → Advanced → Settings file): copies it." }))}
        onClick={() => {
          void navigator.clipboard.writeText(path)
          notify('success', tr(msg({ id: 'settings.data.copied', defaultMessage: 'Path copied', description: 'A notice after a path was copied.' })))
        }}
      />
    </div>
  )
}

function ResetAll() {
  return (
    <button
      className="btn danger"
      data-action="reset-all"
      onClick={async () => {
        if (
          !(await confirm({
            title: tr(msg({ id: 'settings.resetAll.title', defaultMessage: 'Reset all settings?', description: 'Title of the question before every setting goes back to its default (Settings → Advanced → Reset all settings).' })),
            message: tr(msg({ id: 'settings.resetAll.message', defaultMessage: "Every setting in Settings returns to its default, the advanced settings in advanced.json too. A workspace's own advanced values are kept.", description: 'The question before every setting goes back to its default.' })),
            confirmLabel: tr(msg({ id: 'settings.reset', defaultMessage: 'Reset', description: 'Button of a confirmation that resets something to its defaults or clears it.' })),
            danger: true
          }))
        )
          return
        try {
          set({ settings: await call('settings:reset') })
          notify('success', tr(msg({ id: 'settings.resetAll.done', defaultMessage: 'Settings reset', description: 'A notice after every setting went back to its default.' })))
        } catch (e) {
          notify('error', tr(msg({ id: 'settings.resetAll.failed', defaultMessage: 'Could not reset the settings', description: "An error's title: resetting the settings failed." })), errorMessage(e))
        }
      }}
    >
      {tr(msg({ id: 'settings.reset', defaultMessage: 'Reset', description: 'Button of a confirmation that resets something to its defaults or clears it.' }))}
    </button>
  )
}

export function SettingsView() {
  const settings = useStore((s) => s.settings)
  const section = useStore((s) => s.settingsSection) as Section
  const query = useStore((s) => s.settingsQuery)
  const modifiedOnly = useStore((s) => s.settingsModifiedOnly)
  const setModifiedOnly = (v: boolean): void => set({ settingsModifiedOnly: v })
  // Modified only lasts while Settings is shown, as it did.
  useEffect(() => () => set({ settingsModifiedOnly: false }), [])
  const loops = useStore((s) => s.workspace?.config.loops)
  const advanced = useStore((s) => s.advanced)
  // Searching matches the text as shown, in the language shown.
  const shownLanguage = useLanguage()
  const accountsShown = advanced?.values[ACCOUNTS_PREVIEW] === true

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return SETTINGS.filter((d) => {
      // Settings → Accounts only with its preview on (HI-980, staged until HI-1755).
      if (d.section === 'accounts' && !accountsShown) return false
      if (d.id === 'advanced.values' && (q || modifiedOnly)) return advancedMatches(q, modifiedOnly, advanced)
      // Its English matches as well as what it shows: Settings can be searched in either.
      if (q && !`${d.title} ${d.desc} ${d.tip} ${d.key}${shownLanguage !== SOURCE_LANGUAGE ? ` ${Object.values(rowText(d)).join(' ')}` : ''}`.toLowerCase().includes(q)) return false
      if (modifiedOnly && (d.type === 'custom' || getValue(settings!, d, loops) === defaultValue(d))) return false
      if (!q && !modifiedOnly && d.section !== section) return false
      return true
    })
  }, [query, section, settings, modifiedOnly, loops, advanced, shownLanguage, accountsShown])

  if (!settings) return null
  const grouped = SECTIONS.map((s) => ({ ...s, items: visible.filter((d) => d.section === s.id) })).filter((g) => g.items.length)
  // Shown in the user's language: a provider's page is its name.
  const sectionText = (s: (typeof SECTIONS)[number]): { label: string; desc: string } => ({ label: shownText(s.text.label), desc: shownText(s.text.desc) })
  const navIcon = (s: (typeof SECTIONS)[number]): React.ReactNode => (s.provider ? <ProviderIcon provider={s.provider} /> : <Icon name={s.icon} />)

  return (
    <div className="settings">
      <div className="settings-top">
        <Icon name="search" />
        <SearchInput autoFocus placeholder={tr(msg({ id: 'settings.search', defaultMessage: 'Search settings', description: "Placeholder of Settings' search box." }))} value={query} onChange={(v) => set({ settingsQuery: v })} />
        <label className="flex muted">
          <input type="checkbox" className="checkbox" checked={modifiedOnly} onChange={(e) => setModifiedOnly(e.target.checked)} /> {tr(msg({ id: 'settings.modifiedOnly', defaultMessage: 'Modified only', description: 'A box at the top of Settings: ticked, only settings changed from their default show.' }))}
        </label>
      </div>
      <div className="settings-body">
        <div className="settings-nav">
          {SECTIONS.filter((s) => s.id !== 'accounts' || accountsShown).map((s) => (
            <div key={s.id} className={cx('row', !query && !modifiedOnly && section === s.id && 'selected')} data-section={s.id} onClick={() => {
                set({ settingsSection: s.id, settingsQuery: '' })
                setModifiedOnly(false)
              }}
            >
              {navIcon(s)} <span className={cx('label', s.provider && 'settings-sub')}>{sectionText(s).label}</span>
            </div>
          ))}
        </div>
        <div className="settings-content">
          {grouped.length === 0 && <div className="empty-state">{tr(msg({ id: 'settings.noMatch', defaultMessage: 'No settings match.', description: 'Settings when its search finds nothing.' }))}</div>}
          {grouped.map((g) => (
            <div key={g.id} className="settings-group" data-section={g.id}>
              <h2>{sectionText(g).label}</h2>
              <p>{sectionText(g).desc}</p>
              {g.items.map((d) => {
                const modified = (d.type !== 'custom' || ['defaultModel', 'defaultEffort', 'defaultProvider', 'modelFallback', 'effortFallback'].includes(d.key)) && getValue(settings, d, loops) !== defaultValue(d)
                return (
                  d.wide ? (
                    <div key={`${d.section}.${d.key}`} className="setting wide" data-setting={d.id}>
                      <div className="s-text">
                        <div className="s-title">
                          {rowText(d).title} <InfoTip text={<span style={{ whiteSpace: 'pre-line' }}>{rowText(d).tip}</span>} />
                        </div>
                        {d.desc && <div className="s-desc">{rowText(d).desc}</div>}
                        {d.render?.()}
                      </div>
                    </div>
                  ) : (
                  <div key={`${d.section}.${d.key}`} className={cx('setting', d.danger && 'danger')} data-setting={d.id}>
                    <div className="s-text">
                      <div className="s-title">
                        {modified && (
                          <Tooltip content={tr(msg({ id: 'settings.modified', defaultMessage: 'Modified from the default', description: 'Tooltip of the dot beside a setting changed from its default.' }))}>
                            <span className="modified" />
                          </Tooltip>
                        )}
                        {rowText(d).title} <InfoTip text={<span style={{ whiteSpace: 'pre-line' }}>{rowText(d).tip}</span>} />
                        {modified && (
                          <IconButton icon="discard" title={tr(msg({ id: 'settings.resetToDefault', defaultMessage: 'Reset to default ({value})', description: 'Button beside a setting changed from its default: puts it back. {value} is the default.' }), { value: defaultShown(d) })} onClick={() => void update(d, defaultValue(d))} />
                        )}
                      </div>
                      {d.desc && <div className="s-desc">{rowText(d).desc}</div>}
                      {disabledText(d, settings) && <div className="s-desc muted">{disabledText(d, settings)}</div>}
                    </div>
                    <div className="s-control">
                      <Control def={d} settings={settings} />
                    </div>
                  </div>
                  )
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
