import { useEffect, useState } from 'react'
import { fmt, msg, tr } from '@shared/i18n'
import { providerDescriptor, shownText, type ModelOption } from '@shared/providers'
import { modelLabel } from '@shared/defaults'
import { connectionModels, effortName, infoAt, modelCaps, modelGroups } from '@shared/models'
import type { Account, ProviderId } from '@shared/types'
import { useLanguage, useStore } from '../store'
import { Icon } from './ui'

/**
 * Model choice for a provider's settings: the models the installed CLI reports (#125), else the fallback list in
 * Settings (for Claude Code as shipped: latest aliases, pinned versions, older versions hidden until asked for), and a
 * custom model ID. `base` is the option meaning "no choice here" (Inherit, or the CLI's default).
 */
export function ModelPicker({ provider, value, base, onChange, connection }: { provider: ProviderId; value: string; base: ModelOption; onChange: (value: string) => void; connection?: Pick<Account, 'kind' | 'server'> }) {
  useLanguage()
  const p = providerDescriptor(provider)
  // A connection's own models (HI-1770: by its kind), else the CLI's.
  // The models of the host the open workspace resolves to (HI-2779), for a CLI signing in on one; else its catalogue.
  const workspacePath = useStore((s) => s.workspace?.path ?? null)
  const cliInfo = infoAt(useStore((s) => s.providers[provider]), { workspacePath })
  const info = connection ? connectionModels(connection, cliInfo, tr) : cliInfo
  const settings = useStore((s) => s.settings)
  const groups = modelGroups(provider, info, settings, tr)
  const presets = groups.filter((g) => !g.unavailable).flatMap((g) => g.models)
  const isOlder = (v: string): boolean => groups.some((g) => g.older && g.models.some((m) => m.value === v))
  const known = presets.some((m) => m.value === value)
  const [custom, setCustom] = useState(value !== base.value && !known)
  const [draft, setDraft] = useState(custom ? value : '')
  const [showOlder, setShowOlder] = useState(isOlder(value))
  const older = isOlder(value)
  useEffect(() => {
    if (older) setShowOlder(true)
  }, [older])

  const selected = custom ? 'custom' : value === base.value ? base.value : value
  const hasOlder = groups.some((g) => g.older)

  return (
    <div className="model-picker">
      <div className="flex" style={{ gap: 8 }}>
        <select
          className="select"
          value={selected}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'custom') {
              setCustom(true)
              setDraft(value === base.value ? '' : value)
              return
            }
            setCustom(false)
            onChange(v)
          }}
        >
          <option value={base.value}>{base.label}</option>
          {groups
            .filter((g) => !g.older || showOlder)
            .map((g) => (
              <optgroup key={g.label} label={shownText(g.label, g.text, tr)}>
                {g.models.map((m) => (
                  <option key={m.value} value={m.value} disabled={g.unavailable}>
                    {shownText(m.label, m.text, tr)}
                  </option>
                ))}
              </optgroup>
            ))}
          <option value="custom">{tr(msg({ id: 'agents.picker.customModel', defaultMessage: 'Custom model ID…', description: "The model picker's last choice: type a model ID that isn't listed." }))}</option>
        </select>
      </div>
      {custom && (
        <input
          className="input"
          style={{ marginTop: 6 }}
          placeholder={shownText(p.modelPlaceholder, p.text?.modelPlaceholder, tr)}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const v = draft.trim()
            if (v && v !== value) onChange(v)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
      {hasOlder && (
        <a className="model-picker-older" onClick={() => setShowOlder(!showOlder)}>
          {showOlder ? tr(msg({ id: 'agents.picker.hideOlder', defaultMessage: 'Hide older versions', description: 'Link under the model picker: hides the older models again.' })) : tr(msg({ id: 'agents.picker.showOlder', defaultMessage: 'Show older versions', description: 'Link under the model picker: shows the older models in it.' }))}
        </a>
      )}
    </div>
  )
}

/**
 * Effort choice for the model that would run (`model`; null: the CLI's default model): the levels the CLI says that
 * model takes, else the provider's fallback list. A choice the model doesn't take stays chosen and says so, rather
 * than being changed behind the user's back: the CLI decides what to do with it (#125).
 */
export function EffortPicker({ provider, model, value, base, onChange, connection }: { provider: ProviderId; model: string | null | undefined; value: string; base: ModelOption; onChange: (value: string) => void; connection?: Pick<Account, 'kind' | 'server'> }) {
  useLanguage()
  const workspacePath = useStore((s) => s.workspace?.path ?? null)
  const cliInfo = infoAt(useStore((s) => s.providers[provider]), { workspacePath })
  const info = connection ? connectionModels(connection, cliInfo, tr) : cliInfo
  const settings = useStore((s) => s.settings)
  const caps = modelCaps(provider, model, info, settings)
  const providerName = providerDescriptor(provider).name
  const name = caps.label ?? (model ? modelLabel(model, provider) : tr(msg({ id: 'agents.picker.defaultModel', defaultMessage: "{provider}'s default model", description: "The model that runs when none is chosen, named in the effort picker's warnings: the CLI's ({provider}: its name) default." }), { provider: providerName }))
  const chosen = value && value !== base.value ? value : null
  const unsupported = !!chosen && !caps.efforts.some((e) => e.value === chosen)
  const effort = (v: string): string => effortName(provider, v, settings, tr)
  return (
    <div className="effort-picker-wrap">
      <select className="select effort-picker" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={base.value}>{base.label}</option>
        {caps.efforts.map((l) => (
          <option key={l.value} value={l.value}>
            {effort(l.value)}
          </option>
        ))}
        {unsupported && <option value={chosen}>{tr(msg({ id: 'agents.picker.notOffered', defaultMessage: '{effort} (not offered with {model})', description: "The effort picker's choice for a level the model doesn't take ({effort}), kept chosen: {model} is the model's name." }), { effort: effort(chosen), model: name })}</option>}
      </select>
      {unsupported ? (
        <div className="mode-caveat effort-caveat">
          <Icon name="warning" />{' '}
          <span>
            {caps.efforts.length
              ? tr(msg({ id: 'agents.picker.effortOffers', defaultMessage: "{provider} doesn't offer {effort} with {model} (it offers {efforts}): it may refuse it or use another.", description: "A warning under the effort picker: the CLI ({provider}) doesn't list the chosen effort level ({effort}) for this model ({model}); {efforts} lists the levels it does." }), { provider: providerName, effort: effort(chosen), model: name, efforts: fmt.list(caps.efforts.map((e) => effort(e.value)), 'unit') })
              : tr(msg({ id: 'agents.picker.effortNone', defaultMessage: "{provider} doesn't offer {effort} with {model}, which has no effort setting: it may refuse it or use another.", description: "A warning under the effort picker: the CLI ({provider}) has no effort setting for this model ({model}), and an effort level ({effort}) is chosen." }), { provider: providerName, effort: effort(chosen), model: name })}
          </span>
        </div>
      ) : (
        caps.perModel && !caps.efforts.length && <div className="mode-caveat effort-caveat faint">{tr(msg({ id: 'agents.picker.noEffort', defaultMessage: '{model} has no effort setting.', description: "Under the effort picker: the chosen model ({model}: its name) doesn't take an effort level." }), { model: name })}</div>
      )}
    </div>
  )
}
