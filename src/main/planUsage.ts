import { englishText, shownText, type TextPart } from '../shared/advanced'
import { msg, tr } from '../shared/i18n'
import { createHash } from 'crypto'
import type { ConnectionPlanUsage, PlanLimit, PlanUsage, ProviderId } from '../shared/types'
import { providerName } from '../shared/providers'
import { hasShare, limitNameText } from '../shared/planLimits'
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
 * its own latest API call's reading, so another's can be older). Usage goes down within a reset period only when the plan's
 * usage is reset (HI-3181), so: the new reading when none is kept or the kept one's period is over; nothing from a period
 * already over (a resumed rollout's); the later period's when they differ; within one period the newer where the reports
 * tell, else the higher, as reported, with the later reset time (they wobble by seconds). With no reset time to tell periods apart, the latest report, as before.
 * What the plan allows changing (HI-2734: unlimited now or no longer, another entitlement) makes the two readings
 * incomparable: the one reported later is what it is now, whatever its figure, and never a mix of the two.
 */
function mergeLimit(kept: PlanLimit | undefined, next: PlanLimit, now: number): PlanLimit | undefined {
  if (resetPassed(next, now)) return kept && !resetPassed(kept, now) ? kept : undefined
  if (!kept || resetPassed(kept, now)) return next
  // Against the latest the allowance was seen as it is (allowanceAt), not the age of the share kept: a delayed report of
  // another allowance never replaces a newer one.
  if (allowanceChanged(kept, next)) return later(allowanceAt(kept), next.reportedAt) === next.reportedAt ? next : kept
  return seen(mergeSame(kept, next), kept, next)
}

/**
 * Which of two readings of one period was taken later, where their sessions' reports tell (HI-3181): one taken after the
 * other's session had already reported it, or after its own run launched (HI-3187: a run launched since the other was
 * taken, its first report included). Null when they can't be ordered. A reading kept from before HI-3181 was taken at or
 * before its report.
 */
function newer(kept: PlanLimit, next: PlanLimit): 'kept' | 'next' | null {
  const takenBy = (l: PlanLimit): string | undefined => l.firstSeenAt ?? l.reportedAt
  // A reading taken after a report that came at or after the other was taken (HR3's round 2: equal is a session changing
  // its figure on the report right after the one that gave the kept one).
  const after = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && Date.parse(a) >= Date.parse(b)
  if (after(takenAfter(next), takenBy(kept))) return 'next'
  if (after(takenAfter(kept), takenBy(next))) return 'kept'
  return null
}

/** The latest a reading is known to have been taken after (HI-3181, HI-3187): its session's report before, or its run's launch. */
const takenAfter = (l: PlanLimit): string | undefined => later(l.changedAfter, l.takenAfter)

/**
 * Two readings of the same allowance (#383): the later period's; within one, the newer where their reports tell
 * (HI-3181: a usage reset lowers the share mid-period), else the higher; said as the latest report said it. A reading
 * that can't be dated (a session's first report, or one forgotten) never replaces one that can (HR1's round 1): it may be
 * from before a drop the dated one shows. Its run's launch orders a reading only when the launch came after the kept one
 * was taken (HI-3187); otherwise it is still undated (HR1's round 1: two runs' launches and calls interleave, so a run
 * launched later can still relay a reading from before the drop).
 */
function mergeSame(kept: PlanLimit, next: PlanLimit): PlanLimit {
  if (!kept.resetsAt || !next.resetsAt) return described(next, kept)
  if (!samePeriod(kept.resetsAt, next.resetsAt)) return Date.parse(next.resetsAt) > Date.parse(kept.resetsAt) ? next : kept
  const resetsAt = Date.parse(next.resetsAt) > Date.parse(kept.resetsAt) ? next.resetsAt : kept.resetsAt
  const order = newer(kept, next)
  const undatedOverDated = !next.changedAfter && !!takenAfter(kept)
  if (order === 'next' || (order === null && !undatedOverDated && next.usedPercent >= kept.usedPercent)) return described({ ...next, resetsAt }, kept)
  // The reading kept, its figures, who reported them and how old it is.
  const out: PlanLimit = { ...next, usedPercent: kept.usedPercent, resetsAt }
  for (const k of ['used', 'reportedAt', 'reportedBy', 'firstSeenAt', 'changedAfter', 'takenAfter'] as const) {
    if (kept[k] === undefined) delete out[k]
    else (out as unknown as Record<string, unknown>)[k] = kept[k]
  }
  return described(out, kept, next.describedAt ?? next.reportedAt)
}

/** One session's latest reading of a limit (HI-3181): its figure and period, and when it was first and last reported. */
interface SessionReading {
  usedPercent: number
  resetsAt: string | null
  firstSeenAt: string
  changedAfter?: string
  lastAt: string
}

/** Sessions' latest readings, by session and limit (HI-3181); in memory, a session's first report after a restart is of unknown age. */
const sessionReadings = new Map<string, SessionReading>()
const SESSION_READINGS_KEPT = 500

/**
 * How old each limit's reading in a session's report is (HI-3181), from that session's earlier reports. Claude Code's
 * status line carries no reading time, and a session repeats its latest API call's reading until it calls again
 * (tests/fixtures/planusage-2026-10-19.json): a figure the session hadn't reported before was taken since its report
 * before; one it repeats is as old as its first report of it. `launchedAt` (HI-3187): its run's launch, where every
 * reading of a run was taken since (capabilities.planUsageSinceLaunch). Exported for tests (`memo` there).
 */
export function readingAges(session: string, report: PlanUsage, memo = sessionReadings, launchedAt?: string): Record<string, { firstSeenAt: string; changedAfter?: string; takenAfter?: string }> {
  const ages: Record<string, { firstSeenAt: string; changedAfter?: string; takenAfter?: string }> = {}
  for (const l of report.limits) {
    const key = `${session}\n${l.id}`
    const prev = memo.get(key)
    const same = prev && prev.usedPercent === l.usedPercent && samePeriod(prev.resetsAt, l.resetsAt)
    const age = same ? { firstSeenAt: prev.firstSeenAt, ...(prev.changedAfter ? { changedAfter: prev.changedAfter } : {}) } : { firstSeenAt: report.updatedAt, ...(prev ? { changedAfter: prev.lastAt } : {}) }
    ages[l.id] = launchedAt ? { ...age, takenAfter: launchedAt } : age
    memo.delete(key)
    memo.set(key, { usedPercent: l.usedPercent, resetsAt: l.resetsAt, ...age, lastAt: report.updatedAt })
  }
  while (memo.size > SESSION_READINGS_KEPT) memo.delete(memo.keys().next().value!)
  return ages
}

/** Whether a reading says what the plan allows (HI-2734: Copilot's entitlement, unlimited or not included). */
const saysAllowance = (l: PlanLimit): boolean => l.entitlement !== undefined || !!l.unlimited || !!l.notIncluded

/** When the allowance a reading has was last seen so (HI-2734): its own clock, else when it was reported. */
const allowanceAt = (l: PlanLimit): string | undefined => l.allowanceAt ?? l.reportedAt

/** The later of two times (ISO), either missing: the other. */
function later(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) > Date.parse(b) ? a : b
}

/** A merged reading of the same allowance, with when that allowance was last seen: the later of the two reports'. */
function seen(merged: PlanLimit, kept: PlanLimit, next: PlanLimit): PlanLimit {
  if (!saysAllowance(merged)) return merged
  const at = later(allowanceAt(kept), allowanceAt(next))
  return at ? { ...merged, allowanceAt: at } : merged
}

/** The fields that say what a limit is, rather than how much of it is used (HI-2734). */
const DESCRIPTION = ['label', 'windowMinutes', 'models'] as const

/**
 * A merged reading, saying what the limit is as the latest report to say it did (HI-2734): the new report's, unless the
 * kept one's description was taken from a later report than it (a delayed report never rolls a name or models back).
 * `newAt` is when the new description was reported (by default the merged reading's own report time).
 */
function described(merged: PlanLimit, kept: PlanLimit, newAt = merged.describedAt ?? merged.reportedAt): PlanLimit {
  const keptAt = kept.describedAt ?? kept.reportedAt
  const out: PlanLimit = { ...merged }
  if (keptAt && newAt && Date.parse(keptAt) > Date.parse(newAt)) {
    for (const k of DESCRIPTION) (out as unknown as Record<string, unknown>)[k] = kept[k]
    if (kept.models === undefined) delete out.models
    out.describedAt = keptAt
  } else if (newAt) out.describedAt = newAt
  return out
}

/** Whether what the plan allows differs between two readings of a limit (HI-2734): unlimited in one, or two entitlements. */
const allowanceChanged = (a: PlanLimit, b: PlanLimit): boolean => !!a.unlimited !== !!b.unlimited || !!a.notIncluded !== !!b.notIncluded || (a.entitlement !== undefined && b.entitlement !== undefined && a.entitlement !== b.entitlement)

/**
 * What to keep of a provider's plan usage after a report: each limit merged by its id (mergeLimit), limits the report
 * doesn't name kept until their reset passes. `reportedBy` names the session (its agent) on the limits it set; `ages`,
 * how old its readings are (readingAges, HI-3181). Exported for tests.
 */
export function mergePlanUsage(kept: PlanUsage | undefined, report: PlanUsage, now = Date.now(), reportedBy?: string, ages?: ReturnType<typeof readingAges>): PlanUsage {
  const stamped = report.limits.map((l) => {
    const out: PlanLimit = { ...l, reportedAt: report.updatedAt, ...(reportedBy ? { reportedBy } : {}) }
    delete out.firstSeenAt
    delete out.changedAfter
    delete out.takenAfter
    return { ...out, ...ages?.[l.id] }
  })
  const ids = new Set(stamped.map((l) => l.id))
  const limits = [
    ...stamped.map((l) => mergeLimit(kept?.limits.find((k) => k.id === l.id), l, now)),
    ...(kept?.limits ?? []).filter((k) => !ids.has(k.id) && !resetPassed(k, now))
  ].filter((l): l is PlanLimit => !!l)
  // A report of the plan's name alone (HI-2734: agy's plan_tier without its quota) says nothing new of the figures: they
  // stay as of when they were reported.
  const updatedAt = report.limits.length || !kept ? report.updatedAt : kept.updatedAt
  return { ...report, plan: report.plan ?? kept?.plan ?? null, limits, updatedAt }
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

/**
 * The level a period's warnings stand at once its figure went down (HI-3181: a usage reset mid-period): the highest still
 * crossed, so a climb back past the others warns again. Null when nothing changes. Exported for tests.
 */
export function warnedAfterDrop(l: Pick<PlanLimit, 'usedPercent' | 'resetsAt'>, warned: { resetsAt: string | null; level: number } | undefined): number | null {
  if (!warned || !samePeriod(warned.resetsAt, l.resetsAt)) return null
  const crossed = WARN_LEVELS.find((w) => l.usedPercent >= w) ?? 0
  return crossed < warned.level ? crossed : null
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
const usedWindow = (l: Pick<PlanLimit, 'windowMinutes' | 'models'>): { window: 'hours' | 'weekly' | 'other'; hours: number } =>
  l.models ? { window: 'other', hours: 0 } : l.windowMinutes === 7 * 24 * 60 ? { window: 'weekly', hours: 0 } : l.windowMinutes && l.windowMinutes % 60 === 0 ? { window: 'hours', hours: l.windowMinutes / 60 } : { window: 'other', hours: 0 }

const USED_ON = msg({ id: 'main.plan.usedOn', defaultMessage: '{share, number, ::percent} of the {window, select, hours {{hours, plural, one {#-hour limit} other {#-hour limit}}} weekly {weekly limit} other {{label} limit}} used on {connection}', description: "A notice (HI-1756): how much of a plan's usage limit is used ({share}: \"85%\") on one connection, a sign-in the user named ({connection}: \"Max 1\"). The limit is a rolling window of {hours} hours (the 5-hour one), the weekly one, or another the provider names itself ({label}, in English as the provider says it)." })

/**
 * The notice that a limit is `level`% used: in the language shown, its title in English for the Agent API too. On a
 * connection (HI-1756), it names the connection, whose own limit it is. Exported for tests.
 */
export function planNotice(provider: ProviderId, l: Pick<PlanLimit, 'usedPercent' | 'resetsAt' | 'label' | 'windowMinutes' | 'models'>, level: number, connection?: string): { title: string; body: string; apiTitle: string; apiTitleText: TextPart } {
  // The limit's name as text (HI-2734), so the title is in the window's language and the Agent API's in English, each whole.
  const values = { share: Math.round(l.usedPercent) / 100, provider: providerName(provider), ...usedWindow(l), label: limitNameText(l), connection: connection ?? '' }
  const m = connection ? USED_ON : USED
  const body = `${level >= 95 ? tr(msg({ id: 'main.plan.pause', defaultMessage: 'Sessions will pause when it runs out.', description: 'A plan-usage notice, at 95% used or more.' })) : tr(msg({ id: 'main.plan.close', defaultMessage: 'You are getting close to the limit.', description: 'A plan-usage notice, below 95% used.' }))}${resetText(l.resetsAt)}`
  // agent-stored: agentField says the events stream's title again in each caller's dialect, from apiTitleText (apiEvents.ts, HI-2465)
  return { title: shownText({ m, values }), body, apiTitle: englishText({ m, values }), apiTitleText: { m, values } }
}

/**
 * What the windows are told: the kept values as they are (#383 round 4: a rounded figure hid 94.9% → 95.1%, which the
 * status bar's warning colour goes by), the reset times and who reported them. Only the report times aren't a change.
 */
const shownValues = (u: PlanUsage | null | undefined): string =>
  JSON.stringify([u?.plan ?? null, (u?.limits ?? []).map((l) => [l.id, l.usedPercent, l.resetsAt, l.reportedBy ?? null, l.label, l.windowMinutes, l.models ?? null, !!l.unlimited, !!l.notIncluded, l.used ?? null, l.entitlement ?? null])])

/**
 * Providers report plan usage often (Claude Code with every status-line update, many times a minute while
 * agents work). What mergePlanUsage keeps is in memory (saved with the config on quit and with any other
 * change); it is only written to disk when a shown value changes, and then at most once a minute. `reportedBy` is the
 * reporting session's agent, for the status bar's tooltip; `session`, its run, and `launchedAt`, when that run launched
 * if the provider's readings are all its own run's (readingAges).
 *
 * A session launched on a connection (HI-1756) reports that connection's own limits: kept by its id
 * (`connectionPlanUsage`), never mixed into its CLI's, and warned of per connection (`connection:<id>:<limit>`), the
 * notice naming it. One whose session isn't on a connection (a CLI without them: Copilot) is its CLI's.
 * They are a login's (HR2's round 1): kept with the login they came from (`login`, usageLogin), and taken only from a
 * session launched as the login the connection is signed in as now. One still running as another (a login kept since,
 * or changed in a pane) or whose login its launch couldn't tell is left out: it never fills another login's figures.
 */
export function reportPlanUsage(provider: ProviderId, report: PlanUsage, reportedBy?: string, connection?: { id: string; name: string; login?: string }, session?: string, launchedAt?: string): void {
  if (connection && (!connection.login || connection.login !== connectionLoginNow(connection.id))) return
  const c = config.get()
  const kept = connection ? c.connectionPlanUsage?.[connection.id] : c.planUsage[provider]
  // Another login's figures (its connection signed in as someone else since): this login's start afresh, warnings too.
  const stale = !!connection && !!kept && (kept as ConnectionPlanUsage).login !== connection.login
  if (stale) forgetConnectionUsage(connection.id)
  const prev = stale ? undefined : kept
  // How old its readings are (HI-3181), from this session's reports of this login's or this CLI's figures, and its launch.
  const ages = session ? readingAges(`${session}\n${connection ? `${connection.id}\n${connection.login}` : provider}`, report, sessionReadings, launchedAt) : undefined
  const usage = mergePlanUsage(prev, report, Date.now(), reportedBy, ages)
  const changed = shownValues(prev) !== shownValues(usage)
  if (connection) c.connectionPlanUsage = { ...c.connectionPlanUsage, [connection.id]: { ...usage, login: connection.login } }
  else c.planUsage = { ...c.planUsage, [provider]: usage }
  if (changed) {
    emit({ type: 'plan-usage', provider, usage, ...(connection ? { connection: connection.id } : {}) })
    saveSoon()
  }

  for (const l of usage.limits) {
    // Unlimited, or not in the plan (HI-2734): nothing to warn of.
    if (!hasShare(l)) continue
    const key = warningKey(provider, l.id, connection?.id)
    // Gone down within its period (HI-3181): warned of again as it climbs back.
    const lowered = warnedAfterDrop(l, config.get().planWarnings[key])
    if (lowered !== null) config.update((cfg) => (cfg.planWarnings[key] = { resetsAt: l.resetsAt, level: lowered }))
    const level = nextWarning(l, config.get().planWarnings[key])
    if (level === null) continue
    config.update((cfg) => (cfg.planWarnings[key] = { resetsAt: l.resetsAt, level }))
    const { title, body, apiTitle, apiTitleText } = planNotice(provider, l, level, connection?.name)
    // Told once (HI-2320): a pop-up in the window you are using (kept in its bell), a Windows notification with Combwork in
    // the background (its bell row kept quietly), or nothing (notifications off).
    tell({ kind: 'usage', level: level >= 95 ? 'error' : 'warning', title, message: body, apiTitle, apiTitleText })
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
