import { randomBytes } from 'crypto'
import { basename } from 'path'
import type { Account, AgentDef, PlanLimit, UsageMoveRecord, UsageMoveRule } from '../shared/types'
import { USAGE_MOVES, englishText } from '../shared/advanced'
import { accountOnIn, resolveAgentConnection } from '../shared/accounts'
import { projectAgents } from '../shared/defaults'
import { fmt, msg, tr, type Msg } from '../shared/i18n'
import { agentProvider } from '../shared/providers'
import { limitDue, limitKind, liveRecords, matchConnection, movedOffWithinPeriod, periodRecord, ruleLimits, samePeriod, sameRule, targetProblem, USAGE_MOVE_TRIES, type UsageMoveProblem } from '../shared/usageMoves'
import { advanced } from './advanced'
import { accountById, allAccounts, allConnections, getConnection, onConnectionSignedIn } from './accounts'
import { choiceCount, onManualChoice } from './agentChoice'
import { coalesced } from './coalesce'
import { config } from './config'
import { onHiveEvent } from './events'
import { createLogger, userText } from './logger'
import { tell } from './notify'
import { connectionLoginNow } from './planUsage'
import { sessions } from './sessions'
import { inWorkspace, openWorkspaces, workspaceOf, type WorkspaceService } from './workspace'

/**
 * Usage moves (HI-2195, SPEC §11.2; the design is HI-2195's s7 as revised by s9, s11 and s13): an account's rule moves its
 * agents to another account's connections once one of its limits reaches a share.
 *
 * - It moves project agents, never the Hive Assistant (its connection is the user's own choice, Settings → Assistant).
 * - It fires once per limit and reset period (`config.usageMoves`, kept until the reset passes): agents it handled (moved,
 *   kept on the user's own choice, or given up after failed writes) aren't looked at again in that period, so a manual
 *   return holds and nothing moves back after a reset.
 * - A stopped agent's connection is written at once; a running agent's at its safe point (sessions.switchAtSafePoint with
 *   a usage intent), checked again then under its lock: the rule and the Advanced switch as they were, the agent's own
 *   choice unchanged (agentChoice.ts), the target still usable. A manual choice meanwhile keeps the agent where the user
 *   put it for the rest of the period; a stop, a target off or a failed write leave it to be tried again.
 * - A target that can't take them is noticed once per reason and period, and looked at again on the next change (a usage
 *   report, accounts or connections changed, one signed in, a workspace opened), never on a timer.
 */

const log = createLogger('usage-moves')

const enabled = (): boolean => advanced.get(USAGE_MOVES) !== false

/** A move waiting for an agent's safe point, by agent key: what it was queued with. */
interface Pending {
  ws: WorkspaceService
  projectPath: string
  agentId: string
  name: string
  account: string
  limit: string
  firing: string
  rule: UsageMoveRule
  to: string
  saved: string | undefined
  count: number
  /** Its switch ended or it was dropped (HR1's round 1): never written after, however long its write waited for the lock. */
  over?: boolean
}
const pending = new Map<string, Pending>()

/** An agent as the records name it: its project's stable id (the Assistant's home: the workspace's), then its own. */
function agentKey(ws: WorkspaceService, projectPath: string, projectId: string | undefined, agentId: string): string {
  const project = ws.isAssistantHome(projectPath) ? `assistant:${(ws.path ?? '').toLowerCase()}` : (projectId ?? projectPath.toLowerCase())
  return `${project}/${agentId}`
}

const records = (): Record<string, Record<string, UsageMoveRecord>> => config.get().usageMoves ?? {}

function saveRecord(account: string, limit: string, rec: UsageMoveRecord): void {
  config.update((c) => (c.usageMoves = { ...c.usageMoves, [account]: { ...c.usageMoves?.[account], [limit]: rec } }))
}

/** Changes a record still the same firing's (none: nothing; a later period's or rule's has replaced it). */
function changeRecord(account: string, limit: string, firing: string, fn: (r: UsageMoveRecord) => void): void {
  config.update((c) => {
    const r = c.usageMoves?.[account]?.[limit]
    if (!r || r.firing !== firing) return
    const next = structuredClone(r)
    fn(next)
    c.usageMoves = { ...c.usageMoves, [account]: { ...c.usageMoves![account], [limit]: next } }
  })
}

const MOVED_TITLE = msg({
  id: 'main.usageMove.movedTitle',
  defaultMessage: '{count, plural, one {# agent moves} other {# agents move}} from {from} to {to}',
  description: "A notice's title (HI-2195): an account ({from}, the user's name for it in Settings → Accounts & Connections) reached the share of its plan's usage limit its rule sets, so Hive moves its agents to another account ({to})."
})
const MOVED_BODY = msg({
  id: 'main.usageMove.movedBody',
  defaultMessage: "{from} has used {share, number, ::percent} of its {window, select, weekly {weekly limit} other {5-hour limit}}. {agents}: each moves to the matching connection on {to} and resumes its conversation there, a working agent once its turn ends. Hive doesn't move them back: to move one back, choose its connection in Agent Settings.",
  description: "A notice's text (HI-2195), under the title saying agents move from one account to another. {from} and {to} are accounts' names, {share} how much of the limit is used (\"98%\"), {agents} the agents' names joined into a list. The limit is the weekly one or the 5-hour one. Agent Settings names a dialog."
})
const BLOCKED_TITLE = msg({
  id: 'main.usageMove.blockedTitle',
  defaultMessage: "Hive can't move {from}'s agents to {to}",
  description: "A notice's title (HI-2195): an account ({from}) reached the share of its usage limit its rule sets, but its agents can't move to the account the rule names ({to}); the text says why."
})
const BLOCKED_BODY = msg({
  id: 'main.usageMove.blockedBody',
  defaultMessage:
    "{reason, select, missing {That account is gone, or isn't for the same CLI: choose another in Settings → Accounts & Connections.} signedOut {{to} is signed out: sign it in, and they move then.} noConnections {{to} has no connections: add one, and they move then.} full {{to} has also used {share, number, ::percent} of its {window, select, weekly {weekly limit} other {5-hour limit}}, so they stay where they are.} off {{to} isn't on in {workspace}: turn it on in Settings → Accounts & Connections, and they move then.} other {Their connection couldn't be saved: {agents}. Hive stops trying until the limit resets.}}",
  description: "Why an account's agents can't move to another (HI-2195), under the title saying so. {to} is the account they should move to, {workspace} a workspace's name, {share} a share of a usage limit (\"98%\"), {agents} agents' names joined into a list. The limit is the weekly one or the 5-hour one. Settings → Accounts & Connections names a section."
})

/** Tells a notice as plan usage's are (planUsage.ts, HI-2320): once, a pop-up or a Windows notification. */
function notify(level: 'warning' | 'error' | 'info', title: Msg, body: Msg, values: Record<string, string | number>): void {
  // agent-later: HI-2465 says the events stream's titles in each caller's dialect
  tell({ kind: 'usage', level, title: tr(title, values), message: tr(body, values), apiTitle: englishText({ m: title, values }) })
}

const windowOf = (l: Pick<PlanLimit, 'windowMinutes'>): 'weekly' | 'fiveHour' => limitKind(l) ?? 'fiveHour'

/** A reason a firing couldn't move agents, noticed once per period (HR1: never on every report, nor again as reasons alternate). */
function blocked(from: Account, l: PlanLimit, rec: UsageMoveRecord, reason: UsageMoveProblem, extra: { workspace?: string; agents?: string[] } = {}): void {
  if (rec.noticed?.includes(reason)) return
  rec.noticed = [...(rec.noticed ?? []), reason]
  changeRecord(from.id, l.id, rec.firing, (r) => (r.noticed = [...new Set([...(r.noticed ?? []), reason])]))
  const to = accountById(rec.rule.to)
  const share = (config.get().connectionPlanUsage?.[rec.rule.to]?.limits.find((x) => limitKind(x) === limitKind(l))?.usedPercent ?? l.usedPercent) / 100
  log.info(`${userText(from.name)}: its usage move can't go on: ${reason}`)
  notify('warning', BLOCKED_TITLE, BLOCKED_BODY, { reason, from: from.name, to: to?.name ?? rec.rule.to, workspace: extra.workspace ?? '', agents: fmt.list(extra.agents ?? []), share, window: windowOf(l) })
}

/**
 * Whether a waiting move still holds as queued (HR1): not ended or dropped, the switch on, the same rule and firing, its
 * source's reading still at the share in that firing's period (HR1's round 1: a period that ended while the agent worked
 * moves nothing), the target usable. Checked as it is queued, before its write and again under the agent's lock.
 */
function stillHolds(m: Pending): boolean {
  if (m.over || !enabled()) return false
  const now = Date.now()
  const acc = accountById(m.account)
  const rec = records()[m.account]?.[m.limit]
  if (!acc || !sameRule(acc.usageMove, m.rule) || rec?.firing !== m.firing || rec.handled[keyOf(m)] || Date.parse(rec.resetsAt) <= now) return false
  const usage = config.get().connectionPlanUsage?.[m.account]
  const l = usage?.limits.find((x) => x.id === m.limit)
  if (!usage || (usage.login && usage.login !== connectionLoginNow(m.account)) || !l || !limitDue(l, m.rule.percent, now) || !samePeriod(l.resetsAt, rec.resetsAt)) return false
  if (targetProblem(acc, m.rule, allAccounts(), allConnections(), config.get().connectionPlanUsage?.[m.rule.to], now)) return false
  const target = accountById(m.rule.to)
  const to = getConnection(m.to)
  return !!target && !!to && to.account === target.id && accountOnIn(m.ws.config, target, allAccounts())
}

const keys = new WeakMap<Pending, string>()
const keyOf = (m: Pending): string => keys.get(m)!

/** An agent no longer on the source as the user chose (a manual choice, or its connection changed meanwhile): kept for the period. */
class KeptByUser extends Error {}
/** The move no longer holds (stillHolds), found under the lock: nothing written, nothing marked. */
class NoLongerHolds extends Error {}

/**
 * Writes a move (HR1: under the agent's lock, its choice checked then): true once its connection is the target's. A
 * manual choice since it was queued keeps the agent where it is for the period; a failed write is tried again, up to
 * USAGE_MOVE_TRIES times, then noticed and given up.
 */
async function commit(m: Pending): Promise<boolean> {
  const key = keyOf(m)
  if (!stillHolds(m)) return false
  const acc = accountById(m.account)!
  if (choiceCount(m.projectPath, m.agentId) !== m.count) {
    changeRecord(m.account, m.limit, m.firing, (r) => (r.handled[key] = 'kept'))
    return false
  }
  try {
    await m.ws.updateAgent(m.projectPath, m.agentId, { connection: m.to }, (current) => {
      // Everything again under the lock (HR1's round 1): a stop, a drop, the switch off or the rule or target changed
      // while this write waited for the lock writes nothing.
      if (!stillHolds(m)) throw new NoLongerHolds()
      if (choiceCount(m.projectPath, m.agentId) !== m.count || current.connection !== m.saved) throw new KeptByUser()
      const now = resolveAgentConnection(m.ws.config, acc.provider, current.connection, allAccounts(), allConnections())
      if (!now.ok || now.account.id !== acc.id) throw new KeptByUser()
    })
  } catch (e) {
    if (e instanceof NoLongerHolds) return false
    if (e instanceof KeptByUser) {
      changeRecord(m.account, m.limit, m.firing, (r) => (r.handled[key] = 'kept'))
      return false
    }
    log.warn(`${userText(m.name)}: its usage move couldn't be saved`, e)
    let gaveUp = false
    changeRecord(m.account, m.limit, m.firing, (r) => {
      const n = (r.tries?.[key] ?? 0) + 1
      r.tries = { ...r.tries, [key]: n }
      if (n >= USAGE_MOVE_TRIES) {
        r.handled[key] = 'failed'
        gaveUp = true
      }
    })
    const rec = records()[m.account]?.[m.limit]
    const l = config.get().connectionPlanUsage?.[m.account]?.limits.find((x) => x.id === m.limit)
    if (gaveUp && rec && l) blocked(acc, l, rec, 'failed', { agents: [m.name] })
    return false
  }
  changeRecord(m.account, m.limit, m.firing, (r) => {
    r.handled[key] = 'moved'
    if (r.tries) delete r.tries[key]
  })
  log.info(`${userText(m.name)}: moved by ${userText(acc.name)}'s usage move to ${userText(getConnection(m.to)?.name ?? m.to)}`)
  return true
}

/** One firing: each agent of the open workspaces on the account and not handled yet, moved now or at its safe point. */
async function fire(acc: Account, rule: UsageMoveRule, l: PlanLimit, now: number): Promise<void> {
  const kept = records()[acc.id]?.[l.id]
  let rec = periodRecord(kept, l, rule, randomBytes(4).toString('hex'))
  // The rule changed within the period: a new firing (agents moved meanwhile are on the target already).
  if (!sameRule(rec.rule, rule)) rec = periodRecord(undefined, l, rule, randomBytes(4).toString('hex'))
  if (rec !== kept) saveRecord(acc.id, l.id, rec)
  const problem = targetProblem(acc, rule, allAccounts(), allConnections(), config.get().connectionPlanUsage?.[rule.to], now)
  if (problem) return blocked(acc, l, rec, problem)
  const target = accountById(rule.to)!
  const movedNames: string[] = []
  for (const ws of openWorkspaces()) {
    // Never the Hive Assistant (Darren, 30 Oct: "Set you manually"): its connection is the user's, in Settings → Assistant.
    const hosts = await ws.listProjectPaths().catch(() => [] as string[])
    for (const projectPath of hosts) {
      const pc = await ws.projectConfig(projectPath).catch(() => null)
      if (!pc || !ws.path) continue
      for (const a of projectAgents(pc)) {
        const key = agentKey(ws, projectPath, pc.id, a.id)
        if (records()[acc.id]?.[l.id]?.handled[key] || pending.has(key)) continue
        if (agentProvider(a, config.settings) !== acc.provider) continue
        const choice = resolveAgentConnection(ws.config, acc.provider, a.connection, allAccounts(), allConnections())
        if (!choice.ok || choice.account.id !== acc.id) continue
        if (!accountOnIn(ws.config, target, allAccounts())) {
          blocked(acc, l, records()[acc.id]![l.id], 'off', { workspace: basename(ws.path) })
          continue
        }
        // HR1: no rule moves an agent back onto an account a rule moved it off in a period not reset yet.
        if (movedOffWithinPeriod(key, target.id, records(), now)) continue
        const to = matchConnection(choice.connection.name, target.id, allConnections())
        if (!to) continue
        const m: Pending = { ws, projectPath, agentId: a.id, name: a.name, account: acc.id, limit: l.id, firing: rec.firing, rule: { ...rule }, to: to.id, saved: a.connection ?? undefined, count: choiceCount(projectPath, a.id) }
        keys.set(m, key)
        pending.set(key, m)
        const r = inWorkspace(ws, () =>
          sessions.switchAtSafePoint(projectPath, a.id, {
            commit: () => commit(m),
            ended: () => {
              m.over = true
              if (pending.get(key) === m) pending.delete(key)
            }
          })
        )
        if (r === 'notRunning') {
          pending.delete(key)
          if (await commit(m)) movedNames.push(a.name)
        } else movedNames.push(a.name)
      }
    }
  }
  if (!movedNames.length) return
  log.info(`${userText(acc.name)} reached ${Math.round(l.usedPercent)}% of ${l.id}: moving ${movedNames.length} agents to ${userText(target.name)}`)
  notify('info', MOVED_TITLE, MOVED_BODY, { count: movedNames.length, from: acc.name, to: target.name, share: l.usedPercent / 100, window: windowOf(l), agents: fmt.list(movedNames) })
}

/** Every rule against its account's usage as kept now: those due fire (once per period, fire). */
async function run(): Promise<void> {
  const now = Date.now()
  const live = liveRecords(config.get().usageMoves, now)
  if (JSON.stringify(live) !== JSON.stringify(config.get().usageMoves ?? {})) config.update((c) => (c.usageMoves = live))
  if (!enabled()) return
  for (const acc of allAccounts()) {
    const rule = acc.usageMove
    if (!rule) continue
    const usage = config.get().connectionPlanUsage?.[acc.id]
    // Only figures of the login it is signed in as now (planUsage.ts keeps them so; checked again here).
    if (!usage || (usage.login && usage.login !== connectionLoginNow(acc.id))) continue
    for (const l of ruleLimits(rule, usage.limits)) if (limitDue(l, rule.percent, now)) await fire(acc, rule, l, now).catch((e) => log.warn(`${userText(acc.name)}: its usage move failed`, e))
  }
}

/** Looks at the rules now (one run at a time; a change meanwhile runs it again). */
export const lookAtUsageMoves = (): Promise<void> => coalesced('usage-moves', run)

/** Waiting moves that no longer hold (the rule changed, the switch off, the target unusable) are dropped, nothing typed. */
function revalidate(): void {
  for (const [key, m] of pending) {
    if (stillHolds(m)) continue
    m.over = true
    pending.delete(key)
    sessions.dropUsageMove(m.projectPath, m.agentId, 'its usage move no longer holds') // i18n-ignore: for the log
  }
}

/**
 * A manual choice of an agent's connection (agentChoice.ts, under its lock): a move waiting for it is dropped, and every
 * firing in its period on the account it was on keeps it where the user put it (HR1's s11 and s13 checks).
 */
function manualChoice(projectPath: string, before: AgentDef): void {
  const ws = workspaceOf(projectPath)
  for (const [key, m] of pending) {
    if (m.projectPath.toLowerCase() !== projectPath.toLowerCase() || m.agentId !== before.id) continue
    m.over = true
    pending.delete(key)
    changeRecord(m.account, m.limit, m.firing, (r) => (r.handled[key] = 'kept'))
    sessions.dropUsageMove(m.projectPath, m.agentId, 'the user chose its connection') // i18n-ignore: for the log
  }
  const cli = agentProvider(before, config.settings)
  const choice = resolveAgentConnection(ws.config, cli, before.connection, allAccounts(), allConnections())
  if (!choice.ok) return
  const now = Date.now()
  const projectId = ws.projectIdsNow().byPath.get(projectPath.toLowerCase())
  const key = agentKey(ws, projectPath, projectId, before.id)
  for (const [limit, r] of Object.entries(records()[choice.account.id] ?? {})) if (!r.handled[key] && Date.parse(r.resetsAt) > now) changeRecord(choice.account.id, limit, r.firing, (x) => (x.handled[key] = 'kept'))
}

/** Usage moves' part of Hive's start (index.ts): they follow usage reports, accounts, workspaces and the Advanced switch. */
export function initUsageMoves(): void {
  onHiveEvent((e) => {
    if (e.type === 'connections-changed' || e.type === 'advanced-changed' || e.type === 'settings-changed' || e.type === 'workspace-changed') revalidate()
    if ((e.type === 'plan-usage' && e.connection) || e.type === 'connections-changed' || e.type === 'advanced-changed' || e.type === 'workspace-changed') void lookAtUsageMoves()
  })
  onConnectionSignedIn(() => void lookAtUsageMoves())
  onManualChoice(manualChoice)
  void lookAtUsageMoves()
}

/** For tests: forgets what waits (a test's fake sessions start afresh). */
export const resetUsageMovesForTests = (): void => pending.clear()

/** For tests: what waits now, by agent key. */
export const usageMovesPending = (): string[] => [...pending.keys()]
