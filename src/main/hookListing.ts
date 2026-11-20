/**
 * An agent's hooks for its Hooks dialog (HI-982), from what each provider can establish: Combwork's own as passed for the
 * launch, then the CLI's own listing where it has one (Codex's hooks/list) or its settings files as read at launch
 * (Claude Code), each row saying how sure Combwork is. Read-only and bounded: a source lists at most HOOK_ROWS_MAX hooks,
 * each text cut short and Combwork's authentication left out.
 */
import { HOOK_ROWS_MAX, HOOK_SHORT_MAX, HOOK_TEXT_MAX, clip, withoutCombworkAuth, type HookRow, type HookSource, type HookStatus } from '../shared/hooks'

/** A value as a plain object, or null (a provider's own listing reads its settings with it too). */
export const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

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
