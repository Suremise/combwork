import type { Account, AppSettings, Connection, PlanLimit } from '../../../shared/types'
import { limitWindow } from '../../../shared/planLimits'
import { permissionLabel, providerDescriptor } from '../../../shared/providers'
import { effortName } from '../../../shared/models'
import { modelLabel } from '../../../shared/defaults'
import { formatDateTime, formatTime, formatWeekdayTime } from '../../../shared/dates'
import { msg, tr } from '../../../shared/i18n'

/**
 * What Settings → Accounts & Connections' tidied cards show (HI-2528, Darren's approved mockup v2), worked out apart from
 * the components so it can be tested: an account's current limits, when each resets, its bar's level, its plan's name,
 * and a connection's values as its table's cells.
 */

export const M = {
  resetsAt: msg({ id: 'settings.accounts.resetsAt', defaultMessage: 'resets at {time}', description: "Beside a plan-usage bar (HI-2528): the limit resets today, at {time}. Lower case, after the bar's percentage." }),
  resetsOn: msg({ id: 'settings.accounts.resetsOn', defaultMessage: 'resets {when}', description: "Beside a plan-usage bar (HI-2528): the limit resets another day; {when} is a weekday and time (\"Thu 09:00\") or a date and time further out. Lower case, after the bar's percentage." }),
  context200k: msg({ id: 'settings.connection.context200k', defaultMessage: '200K', description: "A choice of a connection's context: a 200K-token window, which compacts sooner. 200K is a number of tokens." }),
  cellOwn: msg({ id: 'settings.connection.cell.cliOwn', defaultMessage: "CLI's own", description: "A cell of a connection's row in Settings → Accounts & Connections (HI-2528): no value chosen for that column (model, effort, context or mode), so the coding agent CLI uses its own. Keep it short." }),
  cellNoArgs: msg({ id: 'settings.connection.cell.noArgs', defaultMessage: 'none', description: "The Extra args cell of a connection's row in Settings → Accounts & Connections (HI-2528) when it passes no extra command-line arguments. Keep it short, lower case as a cell value." })
}

/** An account's plan limits that haven't reset yet (an expired reading says nothing of now), in the order reported. */
export function currentLimits(limits: readonly PlanLimit[] | undefined, now = Date.now()): PlanLimit[] {
  // An unlimited one (HI-2734) has no share to draw: accounts' bars and usage moves are of shares only.
  return (limits ?? []).filter((l) => !l.unlimited && (!l.resetsAt || Date.parse(l.resetsAt) > now))
}

/** A limit's window for its label: the 5-hour or the weekly one, else the provider's own name for it. */
/** A limit's window as the usage messages select on (shared/planLimits.ts: a limit of part of a plan is named by limitName). */
export const windowOf = (l: Pick<PlanLimit, 'windowMinutes' | 'models'>): 'fiveHour' | 'weekly' | 'other' => limitWindow(l)

/**
 * When a limit resets, as plan-usage notices say it (main.plan.resetsAt/resetsOn): its time when that's today, its weekday
 * and time within the coming week, else its date and time. Empty with no reset time, or one that can't be read.
 */
export function resetText(iso: string | null, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (d.toDateString() === now.toDateString()) return tr(M.resetsAt, { time: formatTime(d) })
  return tr(M.resetsOn, { when: d.getTime() - now.getTime() < 6.5 * 24 * 3600e3 ? formatWeekdayTime(d) : formatDateTime(d) })
}

/** A bar's level: amber from 80%, red from 95%, as plan-usage warnings rise. */
export const usageLevel = (used: number): 'ok' | 'high' | 'full' => (used >= 95 ? 'full' : used >= 80 ? 'high' : 'ok')

/** A plan as the CLI reports it, title-cased ("max" → "Max"): never mapped or renamed, so it follows the CLI. */
export const planName = (plan: string): string => plan.charAt(0).toUpperCase() + plan.slice(1)

/** One cell of a connection's row: its text, `own` when the CLI decides it, `none` when it doesn't apply. */
export type ConnectionCell = { text: string; own?: true; none?: true }

/**
 * A connection's values as its table's cells: model, effort, context, mode and extra arguments, each "CLI's own" when not
 * chosen ("none" for arguments); "—" where its CLI or a server has no such setting.
 */
export function connectionCells(c: Pick<Connection, 'model' | 'effort' | 'use200kContext' | 'permissionMode' | 'extraArgs'>, account: Pick<Account, 'provider' | 'kind'>, settings: AppSettings | null): Record<'model' | 'effort' | 'context' | 'mode' | 'args', ConnectionCell> {
  const cli = account.provider
  const server = account.kind === 'server'
  const own: ConnectionCell = { text: tr(M.cellOwn), own: true }
  const none: ConnectionCell = { text: '—', none: true } // i18n-ignore: a dash for a setting that doesn't apply, no words
  return {
    model: c.model ? { text: server ? c.model : modelLabel(c.model, cli) } : own,
    effort: server ? none : c.effort ? { text: effortName(cli, c.effort, settings ?? undefined, tr) } : own,
    context: server || !providerDescriptor(cli).capabilities.contextLimit ? none : c.use200kContext ? { text: tr(M.context200k) } : own,
    mode: c.permissionMode ? { text: permissionLabel(cli, c.permissionMode, tr) } : own,
    args: c.extraArgs ? { text: c.extraArgs } : { text: tr(M.cellNoArgs), own: true }
  }
}
