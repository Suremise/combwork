/**
 * An agent's hooks for its Hooks dialog (HI-982), from what each provider can establish: Combwork's own as passed for the
 * launch, then the CLI's own listing where it has one (Codex's hooks/list) or its settings files as read at launch
 * (Claude Code), each row saying how sure Combwork is. Read-only and bounded: a source lists at most HOOK_ROWS_MAX hooks,
 * each text cut short and Combwork's authentication left out.
 */
import { HOOK_ROWS_MAX, HOOK_SHORT_MAX, HOOK_TEXT_MAX, clip, withoutCombworkAuth, type HookNote, type HookRow, type HookSource, type HookStatus } from '../shared/hooks'

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/** A hook's command or URL (what it runs), whichever its form has, Combwork's authentication left out and cut short. */
function runs(handler: Record<string, unknown>, secrets: readonly string[]): { command: string; truncated?: true } {
  const v = [handler.command, handler.url, handler.prompt].find((x): x is string => typeof x === 'string') ?? ''
  const { text, truncated } = clip(withoutCombworkAuth(v.slice(0, HOOK_TEXT_MAX * 2), secrets), HOOK_TEXT_MAX)
  return truncated ? { command: text, truncated: true } : { command: text }
}

/** The hook forms a CLI takes (Claude Code's: command, http, prompt, agent); any other is listed as unsupported. */
const KNOWN_TYPES = new Set(['command', 'http', 'prompt', 'agent'])

/**
 * The rows of a settings file's `hooks` table, in Claude Code's (and Copilot's) form: `{ <event>: [{ matcher?, hooks: [{
 * type, command | url | prompt }] }] }`, each with the status given (or `unsupported`, for a form Combwork doesn't know). At
 * most `max` rows; `more` counts the rest.
 */
export function rowsOfHooksTable(hooks: unknown, base: { source: HookSource; file?: string; status: HookStatus; why?: string; observed?: boolean }, secrets: readonly string[] = [], max = HOOK_ROWS_MAX): { rows: HookRow[]; more: number } {
  const rows: HookRow[] = []
  let more = 0
  const table = obj(hooks)
  if (!table) return { rows, more }
  for (const [event, groups] of Object.entries(table)) {
    for (const group of Array.isArray(groups) ? groups : [groups]) {
      const g = obj(group)
      const handlers = Array.isArray(g?.hooks) ? g.hooks : g ? [g] : []
      for (const h of handlers) {
        const handler = obj(h) ?? {}
        if (rows.length >= max) {
          more++
          continue
        }
        const type = clip(typeof handler.type === 'string' ? handler.type : '?', HOOK_SHORT_MAX).text
        const known = KNOWN_TYPES.has(type)
        rows.push({
          event: clip(event, HOOK_SHORT_MAX).text,
          source: base.source,
          ...(base.file ? { file: base.file } : {}),
          type,
          ...runs(handler, secrets),
          ...(typeof g?.matcher === 'string' && g.matcher ? { matcher: clip(g.matcher, HOOK_SHORT_MAX).text } : {}),
          status: known ? base.status : 'unsupported',
          ...(known && base.why ? { why: base.why } : {}),
          observed: !!base.observed
        })
      }
    }
  }
  return { rows, more }
}

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

/** What Codex's hooks/list says of a hook (its app server; codexownhooks pins these fields). */
export interface CodexListedHook {
  key?: unknown
  source?: unknown
  command?: unknown
  trustStatus?: unknown
  eventName?: unknown
  matcher?: unknown
}

/** Codex's snake_case event label as its hook events are named (pre_tool_use → PreToolUse). */
const eventOfLabel = (label: string): string => label.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')

/**
 * Codex's own listing of a launch's hooks as rows: each with Codex's trust (trusted, untrusted, modified), its source
 * and file from its key (`<file>:<event>:<group>:<handler>`). `hive` is the command Hive passed for its own: an entry of
 * the session flags running exactly that is Combwork's (its row is Combwork's, with Codex's trust), never another.
 */
export function codexListedHooks(listed: readonly CodexListedHook[], combwork: { command: string; flagsFile: string }, secrets: readonly string[] = [], max = HOOK_ROWS_MAX): { rows: HookRow[]; combworkTrust: Map<string, HookStatus>; more: number } {
  const rows: HookRow[] = []
  const combworkTrust = new Map<string, HookStatus>()
  let more = 0
  for (const h of listed) {
    const key = typeof h.key === 'string' ? h.key : ''
    const m = /^(.*):([a-z_]+):\d+:\d+$/.exec(key)
    const event = typeof h.eventName === 'string' ? h.eventName : m ? eventOfLabel(m[2]) : '?'
    const trust: HookStatus = h.trustStatus === 'trusted' ? 'trusted' : h.trustStatus === 'untrusted' ? 'untrusted' : h.trustStatus === 'modified' ? 'modified' : 'unknown'
    const command = typeof h.command === 'string' ? h.command : ''
    const flags = h.source === 'sessionFlags' || (m?.[1] ?? '') === combwork.flagsFile
    if (flags && command === combwork.command) {
      combworkTrust.set(event, trust)
      continue
    }
    if (rows.length >= max) {
      more++
      continue
    }
    const source: HookSource = flags ? 'cli' : h.source === 'user' ? 'user' : h.source === 'project' ? 'project' : h.source === 'managed' || h.source === 'system' ? 'managed' : 'other'
    const { text, truncated } = clip(withoutCombworkAuth(command.slice(0, HOOK_TEXT_MAX * 2), secrets), HOOK_TEXT_MAX)
    rows.push({
      event: clip(event, HOOK_SHORT_MAX).text,
      source,
      ...(m && !flags ? { file: clip(m[1], HOOK_TEXT_MAX).text } : {}),
      type: 'command',
      command: text,
      ...(truncated ? { truncated: true } : {}),
      ...(typeof h.matcher === 'string' && h.matcher ? { matcher: clip(h.matcher, HOOK_SHORT_MAX).text } : {}),
      status: trust,
      observed: false
    })
  }
  return { rows, combworkTrust, more }
}
