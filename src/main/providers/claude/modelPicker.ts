// HI-2684 (SPEC §11): a server connection's models in Claude Code's /model picker, as `modelPicker` rows in Combwork's own
// --settings file for the launch (never the user's CLI config). Each row's `model` is the server's exact ID, verbatim, so
// what the session reports and what dialects match is that ID; its label is the user's name for it, else none (Claude
// Code then titles it with the ID); its description, the connection's name. Never `behavesAs` and never
// `modelOverrides`: a local model isn't made to pass for a Claude model, and its effort, thinking and output come from
// the connection's model (HI-2682's launch environment), not from a guess.
//
// Claude Code reads modelPicker only from managed settings, --settings and the user's settings, the highest of them that
// sets it supplying the whole lineup, never combined with another (settings-reference, checked 7 Nov 2026). So a lineup
// of the user's own, in any of those, wins: Combwork passes none, and one of those it can't read stops it too.
import type { LaunchedPicker, ServerModel } from '../../../shared/types'
import type { SettingsScope } from './autoCompact'

/** The scopes Claude Code reads modelPicker from (settingsScopes' kinds). */
const PICKER_SCOPES: ReadonlySet<SettingsScope['kind']> = new Set(['managed', 'cli', 'user'])

const has = (json: unknown, key: string): boolean => !!json && typeof json === 'object' && (json as Record<string, unknown>)[key] !== undefined

/** One /model row Combwork passes: the exact ID, the user's label, the connection as its second line. */
export interface PickerRow {
  model: string
  label?: string
  description: string
}

/**
 * The /model lineup for a launch on a server connection (HI-2684), and its record. `test` is HI-2682's judgement of an ID
 * alone (an `alias` would run Claude Code's own alias, not that row: left out); `owns`, whether an ID is a Claude model
 * Claude Code knows, which decides `replaceBuiltInOptions`: only where the connection serves none (its built-in Opus,
 * Sonnet and Haiku rows would otherwise ask the server for Claude models it hasn't got, or run a local model under a Claude
 * name). `scopes` are the session's own (settingsScopes), the user's --settings among them.
 */
export function pickerFor(o: { models: readonly ServerModel[]; connection: string; scopes: readonly SettingsScope[]; test: (id: string) => 'alias' | 'spelling' | null; owns: (id: string) => boolean }): { picker: { options: PickerRow[]; replaceBuiltInOptions?: true } | null; record: LaunchedPicker } {
  const base = { connection: o.connection }
  // A lineup of the user's own wins, whichever scope it is in: none passed.
  const theirs = o.scopes.find((s) => s.kind && PICKER_SCOPES.has(s.kind) && has(s.json, 'modelPicker'))
  if (theirs) return { picker: null, record: { ...base, why: theirs.kind as 'managed' | 'cli' | 'user', whyFile: theirs.label } }
  // One of those scopes (or which are read) Combwork can't tell: it could hold one, so none.
  const unread = o.scopes.find((s) => (s.unsure || s.notJson) && (!s.kind || PICKER_SCOPES.has(s.kind)))
  if (unread) return { picker: null, record: { ...base, why: 'unreadable', whyFile: unread.label } } // i18n-ignore: a reason's code
  const omitted: { id: string; why: 'alias' }[] = []
  const options: PickerRow[] = []
  for (const m of o.models) {
    if (o.test(m.id) === 'alias') {
      omitted.push({ id: m.id, why: 'alias' }) // i18n-ignore: a reason's code
      continue
    }
    options.push({ model: m.id, ...(m.label ? { label: m.label } : {}), description: o.connection })
  }
  const left = omitted.length ? { omitted } : {}
  if (!options.length) return { picker: null, record: { ...base, why: 'noRows', ...left } } // i18n-ignore: a reason's code
  const replace = !o.models.some((m) => o.owns(m.id))
  // An allowlist still filters the rows (with none left, Claude Code shows its built-in lineup): said, never evaluated.
  const allowlist = o.scopes.find((s) => has(s.json, 'availableModels'))
  return {
    picker: { options, ...(replace ? { replaceBuiltInOptions: true as const } : {}) },
    record: { ...base, rows: options.map((r) => r.model), replace, ...left, ...(allowlist ? { allowlist: allowlist.label } : {}) }
  }
}
