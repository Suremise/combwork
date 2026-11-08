import type { PlanLimit, PlanUsage } from '../../../shared/types'
import { COPILOT } from '../../../shared/copilot'
import { isoTime } from '../../../shared/planLimits'
import { advancedValues as advanced } from '../../advancedValues'

/**
 * The plan's limits a Copilot model call recorded (HI-2734): `model.model_call_success`'s `quotaSnapshots` in events.jsonl,
 * one per quota (`chat`, `completions`, `premium_interactions`), each as the CLI's SDK documents them (1.0.106's
 * AccountQuotaSnapshot; 1.0.93's recorded in tests/fixtures/copilot/quota-snapshots-1.0.93.jsonl): its entitlement
 * (-1, or isUnlimitedEntitlement: unlimited), what was used, the percent left and when it resets. Its quota service's
 * other readings (session.quota_observation, assistant.usage) are ephemeral, never written to events.jsonl.
 *
 * Each quota with a finite entitlement above 0 and a percent left from 0 to 100 is a limit by its key, the percent used,
 * with its counts and its reset (no window: Copilot gives none, only the date); an unlimited one is a limit that says so,
 * never warned of; one whose entitlement is 0 (a plan without it: Copilot Free's premium requests) is a limit that says
 * it isn't in the plan, never a share (it would read all used). One with no valid figures is left out. `{}` (a custom provider's model: no quota) and nothing valid are no report.
 * `models` names the quota: `premium` for premium requests, else Copilot's own key. Field names are advanced settings (#367).
 */
export function copilotPlanUsage(snapshots: unknown, at: string): PlanUsage | null {
  if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)) return null
  const f = {
    unlimited: advanced.get<string>('copilot.quota.unlimitedField'),
    entitlement: advanced.get<string>('copilot.quota.entitlementField'),
    used: advanced.get<string>('copilot.quota.usedField'),
    left: advanced.get<string>('copilot.quota.remainingPercentField'),
    reset: advanced.get<string>('copilot.quota.resetField')
  }
  const premium = advanced.get<string>('copilot.quota.premiumKey')
  const limits: PlanLimit[] = []
  for (const [key, raw] of Object.entries(snapshots as Record<string, unknown>)) {
    if (!key || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const s = raw as Record<string, unknown>
    const entitlement = s[f.entitlement]
    const models = key === premium ? 'premium' : key
    const resetsAt = isoTime(s[f.reset])
    if (s[f.unlimited] === true || entitlement === -1) {
      limits.push({ id: key, label: key, windowMinutes: null, usedPercent: 0, resetsAt, models, unlimited: true })
      continue
    }
    if (entitlement === 0) {
      limits.push({ id: key, label: key, windowMinutes: null, usedPercent: 0, resetsAt, models, notIncluded: true, entitlement: 0 })
      continue
    }
    const left = s[f.left]
    if (typeof entitlement !== 'number' || !Number.isFinite(entitlement) || entitlement <= 0) continue
    if (typeof left !== 'number' || !Number.isFinite(left) || left < 0 || left > 100) continue
    const used = s[f.used]
    const counts = typeof used === 'number' && Number.isFinite(used) && used >= 0 ? { used, entitlement } : { entitlement }
    limits.push({ id: key, label: key, windowMinutes: null, usedPercent: 100 - left, resetsAt, models, ...counts })
  }
  return limits.length ? { provider: COPILOT, plan: null, limits, updatedAt: isoTime(at) ?? new Date().toISOString() } : null
}
