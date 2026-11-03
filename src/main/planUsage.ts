import { englishText } from '../shared/advanced'
import { msg, tr } from '../shared/i18n'
import { createHash } from 'crypto'
import type { ConnectionPlanUsage, PlanLimit, PlanUsage, ProviderId } from '../shared/types'
import { providerName } from '../shared/providers'
import { formatTime, formatWeekdayTime } from '../shared/dates'
import { config } from './config'
import { emit } from './events'
import { tell } from './notify'

/**
 * Plan usage (a subscription's rolling limits, e.g. 5-hour and weekly) as each provider reports it:
 * Claude Code to its status line, Codex in its transcripts. Nothing here talks to a provider's servers.
 * The values are account-wide, but each session relays the reading of its own latest API call (or, resuming Codex, the
 * last one in its rollout, maybe days old), so reports come out of order: mergePlanUsage keeps the truth (#383).
 */

const WARN_LEVELS = [95, 80]

/** Reset times can wobble by seconds between reports; a new period moves them by hours. */
function samePeriod(a: string | null, b: string | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return Math.abs(Date.parse(a) - Date.parse(b)) < 30 * 60 * 1000
}

const resetPassed = (l: Pick<PlanLimit, 'resetsAt'>, now: number): boolean => !!l.resetsAt && Date.parse(l.resetsAt) <= now

/**
 * One limit's reading, given the one kept and a new report (#383, from what the CLIs were seen to send: a session reports
 * its own latest API call's reading, so another's can be older). Usage never goes down within a reset period, so:
 * the new reading when none is kept or the kept one's period is over; nothing from a period already over (a resumed
 * rollout's); the later period's when they differ; within one period the higher, as reported, with the later reset time
 * (they wobble by seconds). With no reset time to tell periods apart, the latest report, as before.
 */
function mergeLimit(kept: PlanLimit | undefined, next: PlanLimit, now: number): PlanLimit | undefined {
  if (resetPassed(next, now)) return kept && !resetPassed(kept, now) ? kept : undefined
  if (!kept || resetPassed(kept, now) || !kept.resetsAt || !next.resetsAt) return next
  if (!samePeriod(kept.resetsAt, next.resetsAt)) return Date.parse(next.resetsAt) > Date.parse(kept.resetsAt) ? next : kept
  const resetsAt = Date.parse(next.resetsAt) > Date.parse(kept.resetsAt) ? next.resetsAt : kept.resetsAt
  return { ...(next.usedPercent >= kept.usedPercent ? next : kept), resetsAt }
}

/**
 * What to keep of a provider's plan usage after a report: each limit merged by its id (mergeLimit), limits the report
 * doesn't name kept until their reset passes. `reportedBy` names the session (its agent) on the limits it set.
 * Exported for tests.
 */
export function mergePlanUsage(kept: PlanUsage | undefined, report: PlanUsage, now = Date.now(), reportedBy?: string): PlanUsage {
  const stamped = report.limits.map((l) => ({ ...l, reportedAt: report.updatedAt, ...(reportedBy ? { reportedBy } : {}) }))
  const ids = new Set(stamped.map((l) => l.id))
  const limits = [
    ...stamped.map((l) => mergeLimit(kept?.limits.find((k) => k.id === l.id), l, now)),
    ...(kept?.limits ?? []).filter((k) => !ids.has(k.id) && !resetPassed(k, now))
  ].filter((l): l is PlanLimit => !!l)
  return { ...report, plan: report.plan ?? kept?.plan ?? null, limits }
}

/**
 * Which warning to show for a limit, if any: the highest level crossed that hasn't been shown in
 * this reset period. Returns the level and the record to store.
 */
export function nextWarning(l: Pick<PlanLimit, 'usedPercent' | 'resetsAt'>, warned: { resetsAt: string | null; level: number } | undefined): number | null {
  const level = warned && samePeriod(warned.resetsAt, l.resetsAt) ? warned.level : 0
  const crossed = WARN_LEVELS.find((w) => l.usedPercent >= w)
  return crossed !== undefined && crossed > level ? crossed : null
}

function resetText(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const sameDay = d.toDateString() === new Date().toDateString()
  return ` ${sameDay ? tr(msg({ id: 'main.plan.resetsAt', defaultMessage: 'It resets at {time}.', description: 'The end of a plan-usage notice: the limit resets today. {time} is the time.' }), { time: formatTime(d) }) : tr(msg({ id: 'main.plan.resetsOn', defaultMessage: 'It resets on {when}.', description: 'The end of a plan-usage notice: the limit resets another day. {when} is the day and time.' }), { when: formatWeekdayTime(d) })}`
}

/** At most one save of plan usage per minute; the numbers are only shown, so a late save loses nothing that matters. */
const SAVE_INTERVAL_MS = 60_000
let lastSave = 0
let saveTimer: NodeJS.Timeout | null = null

function saveSoon(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    lastSave = Date.now()
    config.update(() => undefined)
  }, Math.max(0, lastSave + SAVE_INTERVAL_MS - Date.now()))
}

const USED = msg({ id: 'main.plan.used', defaultMessage: '{share, number, ::percent} of your {provider} {window, select, hours {{hours, plural, one {#-hour limit} other {#-hour limit}}} weekly {weekly limit} other {{label} limit}} used', description: "A notice: how much of a plan's usage limit is used ({share}: \"85%\"). {provider} is the coding agent. The limit is a rolling window of {hours} hours (the 5-hour one), the weekly one, or another the provider names itself ({label}, in English as the provider says it)." })

/** A limit's window as main.plan.used selects on: a whole number of hours (the 5-hour window), the weekly one, else its label. */
const usedWindow = (l: Pick<PlanLimit, 'windowMinutes'>): { window: 'hours' | 'weekly' | 'other'; hours: number } =>
  l.windowMinutes === 7 * 24 * 60 ? { window: 'weekly', hours: 0 } : l.windowMinutes && l.windowMinutes % 60 === 0 ? { window: 'hours', hours: l.windowMinutes / 60 } : { window: 'other', hours: 0 }

const USED_ON = msg({ id: 'main.plan.usedOn', defaultMessage: '{share, number, ::percent} of the {window, select, hours {{hours, plural, one {#-hour limit} other {#-hour limit}}} weekly {weekly limit} other {{label} limit}} used on {connection}', description: "A notice (HI-1756): how much of a plan's usage limit is used ({share}: \"85%\") on one connection, a sign-in the user named ({connection}: \"Max 1\"). The limit is a rolling window of {hours} hours (the 5-hour one), the weekly one, or another the provider names itself ({label}, in English as the provider says it)." })

/**
 * The notice that a limit is `level`% used: in the language shown, its title in English for the Agent API too. On a
 * connection (HI-1756), it names the connection, whose own limit it is. Exported for tests.
 */
export function planNotice(provider: ProviderId, l: Pick<PlanLimit, 'usedPercent' | 'resetsAt' | 'label' | 'windowMinutes'>, level: number, connection?: string): { title: string; body: string; apiTitle: string } {
  const values = { share: Math.round(l.usedPercent) / 100, provider: providerName(provider), ...usedWindow(l), label: l.label, connection: connection ?? '' }
  const m = connection ? USED_ON : USED
  const body = `${level >= 95 ? tr(msg({ id: 'main.plan.pause', defaultMessage: 'Sessions will pause when it runs out.', description: 'A plan-usage notice, at 95% used or more.' })) : tr(msg({ id: 'main.plan.close', defaultMessage: 'You are getting close to the limit.', description: 'A plan-usage notice, below 95% used.' }))}${resetText(l.resetsAt)}`
  // agent-later: HI-2465 says the events stream's titles in each caller's dialect
  return { title: tr(m, values), body, apiTitle: englishText({ m, values }) }
}

/**
 * What the windows are told: the kept values as they are (#383 round 4: a rounded figure hid 94.9% → 95.1%, which the
 * status bar's warning colour goes by), the reset times and who reported them. Only the report times aren't a change.
 */
const shownValues = (u: PlanUsage | null | undefined): string => JSON.stringify([u?.plan ?? null, (u?.limits ?? []).map((l) => [l.id, l.usedPercent, l.resetsAt, l.reportedBy ?? null])])

/**
 * Providers report plan usage often (Claude Code with every status-line update, many times a minute while
 * agents work). What mergePlanUsage keeps is in memory (saved with the config on quit and with any other
 * change); it is only written to disk when a shown value changes, and then at most once a minute. `reportedBy` is the
 * reporting session's agent, for the status bar's tooltip.
 *
 * A session launched on a connection (HI-1756) reports that connection's own limits: kept by its id
 * (`connectionPlanUsage`), never mixed into its CLI's, and warned of per connection (`connection:<id>:<limit>`), the
 * notice naming it. One whose session isn't on a connection (a CLI without them: Copilot) is its CLI's.
 * They are a login's (HR2's round 1): kept with the login they came from (`login`, usageLogin), and taken only from a
 * session launched as the login the connection is signed in as now. One still running as another (a login kept since,
 * or changed in a pane) or whose login its launch couldn't tell is left out: it never fills another login's figures.
 */
export function reportPlanUsage(provider: ProviderId, report: PlanUsage, reportedBy?: string, connection?: { id: string; name: string; login?: string }): void {
  if (connection && (!connection.login || connection.login !== connectionLoginNow(connection.id))) return
  const c = config.get()
  const kept = connection ? c.connectionPlanUsage?.[connection.id] : c.planUsage[provider]
  // Another login's figures (its connection signed in as someone else since): this login's start afresh, warnings too.
  const stale = !!connection && !!kept && (kept as ConnectionPlanUsage).login !== connection.login
  if (stale) forgetConnectionUsage(connection.id)
  const prev = stale ? undefined : kept
  const usage = mergePlanUsage(prev, report, Date.now(), reportedBy)
  const changed = shownValues(prev) !== shownValues(usage)
  if (connection) c.connectionPlanUsage = { ...c.connectionPlanUsage, [connection.id]: { ...usage, login: connection.login } }
  else c.planUsage = { ...c.planUsage, [provider]: usage }
  if (changed) {
    emit({ type: 'plan-usage', provider, usage, ...(connection ? { connection: connection.id } : {}) })
    saveSoon()
  }

  for (const l of usage.limits) {
    const key = warningKey(provider, l.id, connection?.id)
    const level = nextWarning(l, config.get().planWarnings[key])
    if (level === null) continue
    config.update((cfg) => (cfg.planWarnings[key] = { resetsAt: l.resetsAt, level }))
    const { title, body, apiTitle } = planNotice(provider, l, level, connection?.name)
    // Told once (HI-2320): a pop-up in the window you are using (kept in its bell), a Windows notification with Hive in
    // the background (its bell row kept quietly), or nothing (notifications off).
    tell({ kind: 'usage', level: level >= 95 ? 'error' : 'warning', title, message: body, apiTitle })
  }
}

/** Where a limit's last warning is kept: per CLI, or per connection (HI-1756). Exported for tests. */
export const warningKey = (provider: ProviderId, limit: string, connection?: string): string => (connection ? `connection:${connection}:${limit}` : `${provider}:${limit}`)

/**
 * A connection removed, or now signed in as another login than its figures are from (HI-1756): its usage and warnings
 * go, here and in the windows, so they never show under another login.
 */
export function forgetConnectionUsage(id: string): void {
  const c = config.get()
  if (!c.connectionPlanUsage?.[id] && !Object.keys(c.planWarnings).some((k) => k.startsWith(`connection:${id}:`))) return
  config.update((cfg) => {
    if (cfg.connectionPlanUsage) delete cfg.connectionPlanUsage[id]
    for (const k of Object.keys(cfg.planWarnings)) if (k.startsWith(`connection:${id}:`)) delete cfg.planWarnings[k]
  })
  emit({ type: 'plan-usage-cleared', connection: id })
}

/**
 * A login, as plan usage keeps it (HR2's round 1): its email (any case) and organisation, hashed, so a session's state
 * and the saved figures say whose they are without carrying the email. Null with no email. A CLI whose login has no
 * organisation (Codex: an email and a plan) is its email alone (HI-1882: requiring one dropped every Codex report).
 */
export function usageLogin(identity: { email?: string; orgId?: string } | null | undefined): string | null {
  if (!identity?.email) return null
  return createHash('sha256').update(`${identity.email.toLowerCase()}\n${identity.orgId ?? ''}`).digest('hex').slice(0, 16)
}

/**
 * The login a connection is signed in as now: its latest check's when that found it signed in (a login changed in a
 * pane included: its new sessions launch as it), else the one accepted. What a session launched on it now runs as.
 */
export function connectionLoginNow(id: string): string | null {
  const a = config.get().accounts?.find((x) => x.id === id)
  if (!a) return null
  return (a.observed?.loggedIn === true ? usageLogin(a.observed) : null) ?? usageLogin(a.accepted)
}

/** After a connection's record changed (accounts.ts): figures from another login than it is signed in as now go. */
export function connectionLoginChanged(id: string): void {
  const kept = config.get().connectionPlanUsage?.[id]
  const now = connectionLoginNow(id)
  if (kept && now && kept.login !== now) forgetConnectionUsage(id)
}
