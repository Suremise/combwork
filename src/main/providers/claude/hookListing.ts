import { HOOK_SHORT_MAX, clip, type HookNote, type HookRow, type HookStatus } from '../../../shared/hooks'
import { obj, rowsOfHooksTable } from '../../hookListing'

/** A Claude Code settings scope as the dialog reads it (autoCompact.ts's settingsScopes). */
export interface ScopeRead {
  kind?: 'managed' | 'cli' | 'local' | 'project' | 'user'
  label: string
  file?: string
  json: unknown
  unsure?: string
  notJson?: true
}

/**
 * Claude Code's own hooks for a launch, from its settings scopes as read at launch (highest first): each is configured,
 * its loading unverified (Claude Code doesn't say which it loaded), but `disabled` where the first scope setting
 * disableAllHooks sets it on (managed hooks too, when managed settings set it), and `notLoaded` outside managed
 * settings where they allow only their own (allowManagedHooksOnly). A file Combwork couldn't read, or that isn't JSON, is a
 * note, never "no hooks".
 */
export function claudeScopeHooks(scopes: readonly ScopeRead[], secrets: readonly string[] = []): { rows: HookRow[]; notes: HookNote[] } {
  const rows: HookRow[] = []
  const notes: HookNote[] = []
  const managedOnly = scopes[0]?.kind === 'managed' && obj(scopes[0].json)?.allowManagedHooksOnly === true
  const deciding = scopes.find((s) => typeof obj(s.json)?.disableAllHooks === 'boolean')
  const offBy = deciding && obj(deciding.json)!.disableAllHooks === true ? deciding : null
  for (const s of scopes) {
    if (s.unsure !== undefined) notes.push(s.file ? { kind: 'unreadable', file: s.file, why: clip(s.unsure, HOOK_SHORT_MAX).text } : { kind: 'unsure', what: clip(s.label, HOOK_SHORT_MAX).text, why: clip(s.unsure, HOOK_SHORT_MAX).text })
    if (s.notJson) notes.push({ kind: 'notJson', file: s.file ?? s.label })
    if (!s.kind) continue
    // Managed settings that turn hooks off keep none; anyone else's turn off all but managed ones.
    const off = offBy && (offBy.kind === 'managed' || s.kind !== 'managed')
    const status: HookStatus = off ? 'disabled' : managedOnly && s.kind !== 'managed' ? 'notLoaded' : 'unverified'
    const why = off ? `disableAllHooks: ${offBy!.label}` : status === 'notLoaded' ? `allowManagedHooksOnly: ${scopes[0].label}` : undefined // i18n-ignore: a setting's name, then the file it is in
    const got = rowsOfHooksTable(obj(s.json)?.hooks, { source: s.kind, ...(s.file ? { file: s.file } : {}), status, ...(why ? { why } : {}) }, secrets)
    rows.push(...got.rows)
    if (got.more) notes.push({ kind: 'more', source: s.kind, count: got.more })
  }
  return { rows, notes }
}
