import { msg, tr } from './i18n'
import type { PlanLimit } from './types'

/**
 * A reset time as a CLI reports it, as ISO (HI-2734): an ISO date (agy's `reset_time`, Copilot's `resetDate`) or epoch
 * milliseconds (seconds below 1e12, as Claude Code's are). Null for anything else: no reset is shown rather than one made up.
 */
export function isoTime(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const d = new Date(v < 1e12 ? v * 1000 : v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString()
  return null
}

const MODELS_NAME = msg({
  id: 'project.limit.models',
  defaultMessage: '{models, select, gemini {Gemini models} otherModels {Other models} premium {Premium requests} chat {Chat messages} completions {Code completions} other {{models}}}{window, select, weekly {, weekly} other {}}',
  description: "The name of a plan limit that covers part of a plan (HI-2734), shown where Combwork says \"{name} limit\": which models or requests it is for (Antigravity's Gemini models, or its other providers' models; Copilot's premium requests, chat messages or code completions; else the provider's own word, {models}), and, for a weekly one, that it is weekly. \"Other models\" are the models of providers other than Google."
})

/**
 * What a plan limit is called, for the messages that say "{label} limit" (HI-2734): a limit of part of a plan (`models`)
 * by its models and window, in the language shown; any other by its label, as the provider says it.
 */
export function limitName(l: Pick<PlanLimit, 'label' | 'models' | 'windowMinutes'>): string {
  if (!l.models) return l.label
  return tr(MODELS_NAME, { models: l.models, window: l.windowMinutes === 7 * 24 * 60 ? 'weekly' : 'other' })
}

/** A limit's window as the plan-limit messages select on: the 5-hour and weekly ones, else "other" (named by limitName). */
export function limitWindow(l: Pick<PlanLimit, 'windowMinutes' | 'models'>): 'fiveHour' | 'weekly' | 'other' {
  if (l.models) return 'other'
  return l.windowMinutes === 300 ? 'fiveHour' : l.windowMinutes === 7 * 24 * 60 ? 'weekly' : 'other'
}
