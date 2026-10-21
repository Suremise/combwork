import { useEffect, useMemo, useState } from 'react'
import { ADVANCED_DEFS, AGENTS_PER_PROJECT, advancedRow, advancedShown, advancedTakesText, advancedUnit, checkAdvanced, cliFacing, groupName, shownText, type AdvancedDef, type AdvancedRow } from '@shared/advanced'
import { AGENT_LIMIT_DEFAULT, manyAgentsNote } from '@shared/defaults'
import { msg, tr, tRich } from '@shared/i18n'
import type { ProviderId } from '@shared/types'
import { call, errorMessage } from '../api'
import { notify, set, useStore } from '../store'
import { NumberField } from './NumberField'
import { DottedId, Icon, IconButton, InfoTip, SearchInput, Switch, Tooltip } from './ui'
import { cx } from '../util'

/**
 * Settings → Advanced's list (#367), in the manner of about:config: every overridable default, grouped by Hive and each
 * CLI, searchable, a modified one marked with its default beside it and Reset. A value that isn't valid says why (Hive
 * uses the default); a CLI's value that no longer finds what the CLI was recorded sending, or that was made for another
 * CLI version, says so, with Keep for the installed version. Values a workspace can set have a This workspace box too.
 * advanced.json holds the same values, Show developer features too: Open advanced.json edits them by hand, and the list
 * follows the file. `query` and `modifiedOnly` are Settings' own search and Modified only, on top of the list's. A
 * value that applies when Hive restarts, changed since this Hive started, offers Restart Hive (#676).
 */
export function AdvancedSettings({ query, modifiedOnly: outerModified }: { query: string; modifiedOnly: boolean }) {
  const state = useStore((s) => s.advanced)
  const hasWorkspace = useStore((s) => !!s.workspace)
  const [filter, setFilter] = useState('')
  const [ownModified, setModifiedOnly] = useState(false)
  const modifiedOnly = outerModified || ownModified
  const words = `${query} ${filter}`.toLowerCase().split(/\s+/).filter(Boolean)
  const rows = useMemo(() => ADVANCED_DEFS.map((d) => advancedRow(d, state)), [state])
  const matches = (text: string): boolean => words.every((w) => text.toLowerCase().includes(w))
  // Its English matches as well as what it shows, as Settings' own rows do.
  const shown = rows.filter((r) => (!modifiedOnly || r.override !== undefined || r.workspaceValue !== undefined) && matches(`${r.def.id} ${r.def.setting ?? ''} ${groupName(r.def.group)} ${r.def.title} ${r.def.desc} ${shownText(r.def.text.title)} ${shownText(r.def.text.desc)}`))
  const groups = [...new Set(ADVANCED_DEFS.map((d) => d.group))]
  if (!state) return null
  return (
    <div className="advanced-list">
      <div className="advanced-bar">
        <SearchInput placeholder={tr(msg({ id: 'settings.advancedList.filter', defaultMessage: 'Filter advanced settings', description: "Placeholder and name of the filter box in Settings → Advanced's list." }))} aria-label={tr(msg({ id: 'settings.advancedList.filter', defaultMessage: 'Filter advanced settings', description: "Placeholder and name of the filter box in Settings → Advanced's list." }))} value={filter} onChange={setFilter} />
        <label className="flex muted">
          <input type="checkbox" className="checkbox" checked={modifiedOnly} disabled={outerModified} onChange={(e) => setModifiedOnly(e.target.checked)} /> {tr(msg({ id: 'settings.advancedList.modifiedOnly', defaultMessage: 'Modified only', description: "A box above Settings → Advanced's list: ticked, only values changed from their default show." }))}
        </label>
        <button className="btn subtle" onClick={() => void call('advanced:open').catch((e) => notify('error', tr(msg({ id: 'settings.advancedList.openFailed', defaultMessage: 'Could not open advanced.json', description: "An error's title: opening advanced.json (the advanced settings' file) failed." })), errorMessage(e)))}>
          <Icon name="go-to-file" /> {tr(msg({ id: 'settings.advancedList.open', defaultMessage: 'Open advanced.json', description: "Button above Settings → Advanced's list: opens the file the values are kept in. advanced.json is a file name: keep it." }))}
        </button>
      </div>
      {state.fileError && (
        <div className="advanced-note error" role="alert">
          <Icon name="warning" /> {tr(msg({ id: 'settings.advancedList.fileError', defaultMessage: '{problem} Hive keeps using the values it read before; fix the file to change them.', description: "Above Settings → Advanced's list when advanced.json can't be read. {problem} says why, a sentence of its own." }), { problem: state.fileErrorText ? shownText(state.fileErrorText) : state.fileError })}
        </div>
      )}
      {state.unknown.length > 0 && (
        <div className="advanced-note">
          <Icon name="info" /> {tr(msg({ id: 'settings.advancedList.unknown', defaultMessage: "advanced.json also names {ids}, which this Hive doesn't know (a typo, or a newer Hive's): kept in the file, not used.", description: "Above Settings → Advanced's list. {ids} lists values' ids, as advanced.json writes them; advanced.json is a file name: keep it." }), { ids: state.unknown.join(', ') })}
        </div>
      )}
      {groups.map((g) => {
        const list = shown.filter((r) => r.def.group === g)
        if (!list.length) return null
        return (
          <div key={g} className="advanced-group" role="group" aria-label={groupName(g)}>
            <h3>{groupName(g)}</h3>
            {list.map((r) => (
              <AdvancedItem key={r.def.id} row={r} cli={cliFacing(r.def) ? (state.cli[r.def.group as ProviderId] ?? null) : null} workspace={hasWorkspace} restartDue={r.def.applies === 'restart' && !!state.atStart && r.def.id in state.atStart && state.atStart[r.def.id] !== r.value} />
            ))}
          </div>
        )
      })}
      {!shown.length && <div className="empty-state">{tr(msg({ id: 'settings.advancedList.noMatch', defaultMessage: 'No advanced settings match.', description: "Settings → Advanced's list when its filter finds nothing." }))}</div>}
    </div>
  )
}

function Modified() {
  return (
    <Tooltip content={tr(msg({ id: 'settings.advancedList.modified', defaultMessage: 'Modified from the default', description: 'Tooltip of the dot beside an advanced value changed from its default.' }))}>
      <span className="modified" />
    </Tooltip>
  )
}

/** Sets a value (null: back to the default, or a workspace's to Settings → Advanced's); a refusal shows its reason. */
async function save(def: AdvancedDef, value: unknown, scope: 'app' | 'workspace' = 'app'): Promise<string | null> {
  try {
    set({ advanced: await call('advanced:set', def.id, value, scope) })
    return null
  } catch (e) {
    return errorMessage(e)
  }
}

/**
 * What a box shows for a value as written (in advanced.json or workspace.json): as Hive reads it when it checks out (a
 * number written as text, "600", is 600), as written when it doesn't and the box can show text, else `fallback`.
 */
function shownValue(def: AdvancedDef, raw: unknown, fallback: unknown): unknown {
  if (raw === undefined || raw === null) return fallback
  const checked = checkAdvanced(def, raw)
  if ('value' in checked) return checked.value
  return def.kind === 'number' || def.kind === 'boolean' ? fallback : raw
}

function AdvancedItem({ row, cli, workspace, restartDue }: { row: AdvancedRow; cli: string | null; workspace: boolean; restartDue: boolean }) {
  const { def } = row
  const modified = row.override !== undefined
  const [error, setError] = useState<string | null>(null)
  const commit = async (v: unknown, scope: 'app' | 'workspace' = 'app'): Promise<void> => {
    // Checked here first, as main checks it, so a refusal shows in the user's language (main's is English, for the tools).
    const checked = v === null ? null : checkAdvanced(def, v)
    if (checked && 'error' in checked) {
      const why = shownText(checked.errorText)
      setError(why)
      throw new Error(why)
    }
    const err = await save(def, v, scope)
    setError(err)
    if (err) throw new Error(err)
  }
  const title = shownText(def.text.title)
  const label = tr(msg({ id: 'settings.advancedList.label', defaultMessage: '{group}: {title}', description: "The name, for screen readers, of an advanced value's box: Hive or the CLI it belongs to, then its title." }), { group: groupName(def.group), title })
  const about = [
    shownText(advancedTakesText(def)),
    def.applies === 'sessions' ? tr(msg({ id: 'settings.advancedList.appliesToSessions', defaultMessage: 'Applies to sessions started afterwards.', description: "A line of an advanced value's info tip." })) : '',
    def.applies === 'restart' ? tr(msg({ id: 'settings.advancedList.appliesAtRestart', defaultMessage: 'Applies when Hive restarts.', description: "A line of an advanced value's info tip." })) : '',
    cliFacing(def) ? tr(msg({ id: 'settings.advancedList.cliVersion', defaultMessage: "It is {cli}'s: a change records the version it was made for.", description: "A line of an advanced value's info tip, for a CLI's value. {cli} is the CLI's name." }), { cli: groupName(def.group) }) : '',
    def.setting ? tr(msg({ id: 'settings.advancedList.alsoSetting', defaultMessage: "Hive's setting {key}, kept in advanced.json too.", description: "A line of an advanced value's info tip, for one of Hive's settings shown here. {key} is its key in Hive's settings: keep it." }), { key: def.setting }) : ''
  ].filter(Boolean)
  return (
    <div
      // i18n-ignore: class names
      className={cx('setting advanced-row', row.problem && 'invalid')}
      data-advanced={def.id}
    >
      <div className="s-text">
        <div className="s-title">
          {modified && <Modified />}
          {title}
          <InfoTip text={<span style={{ whiteSpace: 'pre-line' }}>{about.join('\n')}</span>} />
          {modified && <IconButton icon="discard" title={tr(msg({ id: 'settings.advancedList.reset', defaultMessage: 'Reset to default ({value})', description: 'Button beside an advanced value changed from its default: puts it back. {value} is the default.' }), { value: advancedShown(def, def.default) })} onClick={() => void commit(null).catch(() => undefined)} />}
        </div>
        {/* Breaks after a dot, not mid-word, when the column is narrow (#887). */}
        <div className="advanced-id">
          <DottedId id={def.id} />
        </div>
        <div className="s-desc">{shownText(def.text.desc)}</div>
        {modified && (
          <div className="s-desc">
            {tRich(msg({ id: 'settings.advancedList.default', defaultMessage: 'Default: {value}', description: 'Under an advanced value changed from its default: what the default is. {value} is the default, shown as code.' }), { value: <code key="value">{advancedShown(def, def.default)}</code> })}
          </div>
        )}
        {row.problemText && (
          <div className="advanced-note error">
            <Icon name="error" /> {tr(msg({ id: 'settings.advancedList.notValid', defaultMessage: 'Not valid, so Hive uses the default: {problem}', description: "Under an advanced value that isn't valid. {problem} says why." }), { problem: shownText(row.problemText) })}
          </div>
        )}
        {row.missText && (
          <div className="advanced-note warn">
            <Icon name="warning" /> {shownText(row.missText)}
          </div>
        )}
        {row.madeForOther && (
          <div className="advanced-note warn">
            <Icon name="warning" /> {tr(msg({ id: 'settings.advancedList.madeFor', defaultMessage: 'Made for {cli} {version}; {installed} is installed now. Check it still works, then keep it for {installed}.', description: "Under a CLI's advanced value made for another version of the CLI. {cli} is its name; {version} and {installed} are version numbers." }), { cli: groupName(def.group), version: row.madeForOther, installed: cli ?? '' })}
            <button className="btn small subtle" onClick={() => void call('advanced:keep', def.id).then((s) => set({ advanced: s })).catch((e) => notify('error', tr(msg({ id: 'settings.advancedList.keepFailed', defaultMessage: 'Could not keep it', description: "An error's title: keeping an advanced value for the installed CLI version failed." })), errorMessage(e)))}>
              {tr(msg({ id: 'settings.advancedList.keep', defaultMessage: 'Keep for {version}', description: "Button under a CLI's advanced value made for another version: keeps it for the installed one. {version} is that version's number." }), { version: cli ?? '' })}
            </button>
          </div>
        )}
        {restartDue && (
          <div className="advanced-note" data-note="restart">
            <Icon name="info" /> {tr(msg({ id: 'settings.advancedList.restartDue', defaultMessage: 'Restart Hive to apply this.', description: 'Under an advanced value that applies when Hive restarts, changed since Hive started.' }))}
            <button className="btn small subtle" onClick={() => void call('app:restart').catch((e) => notify('error', tr(msg({ id: 'settings.advancedList.restartFailed', defaultMessage: 'Could not restart Hive', description: "An error's title: restarting Hive from Settings → Advanced failed." })), errorMessage(e)))}>
              {tr(msg({ id: 'settings.advancedList.restart', defaultMessage: 'Restart Hive', description: 'Button under an advanced value that applies when Hive restarts: quits Hive (asking about running agents, as quitting does) and starts it again.' }))}
            </button>
          </div>
        )}
        {def.id === AGENTS_PER_PROJECT && [row.value, shownValue(def, row.override, null), shownValue(def, row.workspaceValue, null)].some((v) => typeof v === 'number' && v > AGENT_LIMIT_DEFAULT) && <ManyAgentsNote />}
        {error && <div className="field-error">{error}</div>}
      </div>
      <div className="s-control advanced-control">
        {/* Settings' own value (not this workspace's). */}
        <ValueBox def={def} value={shownValue(def, row.override, def.default)} label={label} onCommit={(v) => commit(v)} />
        {def.workspace && workspace && (
          <div className="advanced-workspace">
            <span className="muted">{tr(msg({ id: 'settings.advancedList.workspace', defaultMessage: 'This workspace', description: "Beside the box for the open workspace's own advanced value." }))}</span>
            <ValueBox def={def} value={shownValue(def, row.workspaceValue, null)} label={tr(msg({ id: 'settings.advancedList.workspaceLabel', defaultMessage: '{label}, this workspace', description: "The name, for screen readers, of the box for the open workspace's own advanced value. {label} is the value's name." }), { label })} placeholder={tr(msg({ id: 'settings.advancedList.workspacePlaceholder', defaultMessage: "{value} (Settings')", description: "Placeholder of the box for the workspace's own advanced value: the value Settings has, which applies while it is empty." }), { value: advancedShown(def, shownValue(def, row.override, def.default)) })} onCommit={(v) => commit(v, 'workspace')} />
          </div>
        )}
      </div>
    </div>
  )
}

/** Agents per project over the default (#562): what more agents cost, in this machine's figures, measured as it shows. */
function ManyAgentsNote() {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void call('agents:memory')
      .then((m) => live && setText(manyAgentsNote(m)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  if (!text) return null
  return (
    <div className="advanced-note" data-note="many-agents">
      <Icon name="info" /> {text}
    </div>
  )
}

/** The value's box: a switch, a number field, or text saved on Enter or leaving it (empty: back to the default, or Settings'). */
function ValueBox({ def, value, label, placeholder, onCommit }: { def: AdvancedDef; value: unknown; label: string; placeholder?: string; onCommit: (v: unknown) => Promise<void> }) {
  const shown = (v: unknown): string => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v))
  const [draft, setDraft] = useState(shown(value))
  useEffect(() => setDraft(shown(value)), [value])
  if (def.kind === 'boolean') return <Switch checked={value === true} label={label} onChange={(v) => void onCommit(v).catch(() => undefined)} />
  if (def.kind === 'number')
    return <NumberField value={typeof value === 'number' ? value : null} min={def.min} max={def.max} step={1} inherit={placeholder} label={label} unit={advancedUnit(def) ?? undefined} onCommit={(v) => onCommit(v)} />
  const commit = (): void => {
    const v = draft.trim()
    if (v === shown(value)) return
    void onCommit(v === '' ? null : def.kind === 'list' ? v : draft).catch(() => setDraft(shown(value)))
  }
  return (
    <input
      className="input mono"
      aria-label={label}
      spellCheck={false}
      value={draft}
      placeholder={placeholder ?? advancedShown(def, def.default)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') setDraft(shown(value))
      }}
    />
  )
}
