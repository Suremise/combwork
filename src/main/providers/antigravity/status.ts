import type { PlanLimit, PlanUsage } from '../../../shared/types'
import { ANTIGRAVITY } from '../../../shared/antigravity'
import { advanced } from '../../advanced'
import { isoTime } from '../../../shared/planLimits'
import type { LiveDetails } from '../types'

/**
 * What agy's status line says of the session (its status-line docs; 1.5.0's recorded in HI-2545): the model by its name
 * (its `id` is a display name too, HI-2544: never matched as an id), its effort and the context window. Its tokens come
 * from the transcript (transcript.ts), which has each request's; agy publishes no prices, so there is no cost to show.
 * Its plan's limits (HI-2734): agyPlanUsage.
 */
export function agyStatusDetails(body: Record<string, any>, now = new Date()): LiveDetails {
  const d: LiveDetails = {}
  const model = body?.model
  if (model && typeof model === 'object') {
    if (typeof model.display_name === 'string' && model.display_name) d.modelName = model.display_name
    if (typeof model.effort === 'string' && model.effort) d.effort = model.effort
  }
  const size = Number(body?.context_window?.context_window_size)
  if (Number.isFinite(size) && size > 0) d.contextWindow = size
  const plan = agyPlanUsage(body, now)
  if (plan) d.planUsage = plan
  return d
}

/** A week, in minutes: the window of agy's `…-weekly` quotas. */
const WEEK_MINUTES = 7 * 24 * 60

/**
 * The plan's limits agy's status line reports (HI-2734; 1.5.0's recorded): its quota, a bucket per group of models
 * (`gemini-weekly`, `3p-weekly`: the other providers' models), each the share left (0 to 1) and when it resets, and the
 * plan's name (`plan_tier`). Each valid bucket is a limit by its key, the share used; a `…-weekly` one's window is a week,
 * any other's none (agy says no more); `models` is the key without its window (`gemini`; `otherModels` for agy's
 * third-party `3p`; else as agy says it). A bucket without a share in range is left out. With no valid bucket, the plan's
 * name alone is a report of it (limits: none, so those kept stay); with neither, there is no report, and the figures
 * kept stay as they were. Field names and agy's words are advanced settings (#367).
 */
export function agyPlanUsage(body: Record<string, any>, now = new Date()): PlanUsage | null {
  const quota = body?.[advanced.get<string>('antigravity.statusLine.quota')]
  const left = advanced.get<string>('antigravity.statusLine.remainingFraction')
  const reset = advanced.get<string>('antigravity.statusLine.resetTime')
  const weekly = advanced.get<string>('antigravity.statusLine.weeklySuffix')
  const others = advanced.get<string>('antigravity.statusLine.otherModels')
  const limits: PlanLimit[] = []
  if (quota && typeof quota === 'object' && !Array.isArray(quota)) {
    for (const [key, raw] of Object.entries(quota as Record<string, unknown>)) {
      if (!key || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const r = raw as Record<string, unknown>
      const fraction = r[left]
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue
      const isWeekly = !!weekly && key.endsWith(weekly) && key.length > weekly.length
      const group = isWeekly ? key.slice(0, -weekly.length) : key
      limits.push({ id: key, label: key, windowMinutes: isWeekly ? WEEK_MINUTES : null, usedPercent: (1 - fraction) * 100, resetsAt: isoTime(r[reset]), models: group === others ? 'otherModels' : group })
    }
  }
  const tier = body?.[advanced.get<string>('antigravity.statusLine.planTier')]
  const plan = typeof tier === 'string' && tier.trim() ? tier.trim() : null
  if (!limits.length && !plan) return null
  return { provider: ANTIGRAVITY, plan, limits, updatedAt: now.toISOString() }
}
