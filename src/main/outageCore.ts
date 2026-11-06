import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { OUTAGE_NOT_CONNECTION, outagePatternId } from '../shared/advanced'
import { agentMsg, inDialectOf, say } from '../shared/agentText'
import type { ProviderId } from '../shared/types'
import { createLogger, userText } from './logger'

/**
 * The wait for a dropped connection (HI-1612), without Combwork's services (outageResume.ts gives it them): which failed
 * turns it is for, the checks backing off, the resume, and when it gives up.
 */
const log = createLogger('outage')

const T = {
  back: agentMsg({ id: 'notice.outage.back', text: 'The connection dropped at {dropped} and came back at {back}: check what was cut off, rerun it, and carry on.', note: "HI-1612: the note an agent's conversation is given once its dropped connection is back. dropped, back: times of day (notice.outage.clock)." }),
  clock: agentMsg({ id: 'notice.outage.clock', text: '{time} (UTC{offset})', note: 'HI-1612: a time of day as the connection notices give it: 24-hour, local (time: "11:47"), with its offset from UTC (offset: "+01:00").' })
}

/**
 * Whether a failed turn's words are a dropped connection of its CLI's: its CLI's pattern finds them, and Combwork's for
 * what is never one (a usage limit, a sign-in, "overloaded") doesn't. `pattern` gives an advanced pattern by its id.
 */
export function connectionDropped(provider: ProviderId, words: string, pattern: (id: string) => RegExp): boolean {
  const said = words.trim()
  if (!said || pattern(OUTAGE_NOT_CONNECTION).test(said)) return false
  return pattern(outagePatternId(provider)).test(said)
}

/** One agent's launch, as the wait needs it. */
export interface OutageAgent {
  key: string
  projectPath: string
  agentId: string
  runId: string
  provider: ProviderId
  /** The failed turn's mark (LiveSessionState.failedTurn.since): the wait is for that turn only. */
  turn: string
  /** Its server connection's base URL, when it launched on one (HI-1772): the host its CLI really calls. */
  baseUrl?: string
  assistant: boolean
}

/** How a wait ended. */
export type OutageEnd = { kind: 'resumed'; droppedAt: number; backAt: number } | { kind: 'gaveUp'; resumes: number } | { kind: 'timedOut'; minutes: number } | { kind: 'cancelled' }

/** What the wait needs of Combwork: the settings, the network, the agent's status, its note and the notices. */
export interface OutageHost {
  on(): boolean
  /** Whether this failed turn's words are a connection error of its CLI's. */
  dropped(provider: ProviderId, words: string): boolean
  /** Whether the agent's API host answers. Never throws. */
  reachable(a: OutageAgent): Promise<boolean>
  /** The agent is still stopped on the same failed turn of the same launch. */
  stillStopped(a: OutageAgent): boolean
  /** Its status and Progress say it waits; `ended`, how the wait ended. */
  waiting(a: OutageAgent): void
  ended(a: OutageAgent, end: OutageEnd): void
  /** Gives the agent its note now; whether it was given. */
  resume(a: OutageAgent, note: string): Promise<boolean>
  now(): number
  later(fn: () => void, ms: number): () => void
  checkFirstMs(): number
  checkMostMs(): number
  waitMs(): number
  resumesPerHour(): number
}

/** The note an agent's conversation is given once its connection is back (agent-facing: said in its dialect). */
export function resumeNote(droppedAt: number, backAt: number): string {
  return say(T.back, { dropped: clock(droppedAt), back: clock(backAt) })
}

/** A time of day as agents read it: 24-hour, local, with its offset ("11:47 (UTC+01:00)"). */
export function clock(at: number): string {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off < 0 ? '-' : '+'
  return say(T.clock, { time: `${two(d.getHours())}:${two(d.getMinutes())}`, offset: `${sign}${two(Math.floor(Math.abs(off) / 60))}:${two(Math.abs(off) % 60)}` })
}

/** The wait before check `n` (0 first): the first's, doubling, at most the most's. */
export function checkDelay(n: number, firstMs: number, mostMs: number): number {
  return Math.min(mostMs, firstMs * 2 ** Math.min(n, 20))
}

const HOUR_MS = 3_600_000

interface Waiting {
  agent: OutageAgent
  droppedAt: number
  checks: number
  cancel: (() => void) | null
  checking: boolean
}

export class OutageResume {
  private readonly waits = new Map<string, Waiting>()
  /** Each agent's resumes in the past hour (when), for the stop after too many. */
  private readonly resumes = new Map<string, number[]>()

  constructor(private readonly host: OutageHost) {}

  /** An agent's turn ended on an error, with the CLI's words: a connection error, with the switch on, starts a wait. */
  failed(a: OutageAgent, words: string): void {
    if (!this.host.on() || this.waits.has(a.key) || !this.host.dropped(a.provider, words)) return
    const now = this.host.now()
    const recent = (this.resumes.get(a.key) ?? []).filter((t) => now - t < HOUR_MS)
    this.resumes.set(a.key, recent)
    if (recent.length >= this.host.resumesPerHour()) {
      // The resumes are kept: until the hour since them has passed, another drop gives up again, never a fourth resume.
      log.warn(`${userText(a.projectPath)} · ${a.agentId}: its connection dropped again after ${recent.length} resumes in an hour; Combwork stops resuming it`)
      this.host.ended(a, { kind: 'gaveUp', resumes: recent.length })
      return
    }
    const w: Waiting = { agent: a, droppedAt: now, checks: 0, cancel: null, checking: false }
    this.waits.set(a.key, w)
    log.info(`${userText(a.projectPath)} · ${a.agentId}: its turn ended on a connection error; waiting for the connection`)
    this.host.waiting(a)
    this.schedule(w)
  }

  /** The agent's failed turn is over another way (a new turn started, its launch ended): no wait for it. */
  cleared(key: string): void {
    const w = this.waits.get(key)
    if (!w) return
    this.stop(w)
    this.host.ended(w.agent, { kind: 'cancelled' })
  }

  /** The switch was turned off: every wait ends, as cancelled. */
  turnedOff(): void {
    for (const key of [...this.waits.keys()]) this.cleared(key)
  }

  /** Waiting agents' keys (tests, diagnostics). */
  waitingKeys(): string[] {
    return [...this.waits.keys()]
  }

  private stop(w: Waiting): void {
    w.cancel?.()
    w.cancel = null
    this.waits.delete(w.agent.key)
  }

  private schedule(w: Waiting): void {
    const delay = checkDelay(w.checks, this.host.checkFirstMs(), this.host.checkMostMs())
    w.cancel = this.host.later(() => void this.check(w), delay)
  }

  /** Past the wait's limit (the setting as it is now): a timer the PC's sleep held, or a check that took long, ends it. */
  private expired(w: Waiting): boolean {
    if (this.host.now() - w.droppedAt < this.host.waitMs()) return false
    this.timedOut(w)
    return true
  }

  private timedOut(w: Waiting): void {
    this.stop(w)
    log.warn(`${userText(w.agent.projectPath)} · ${w.agent.agentId}: the connection didn't come back within the wait; Combwork stops waiting`)
    this.host.ended(w.agent, { kind: 'timedOut', minutes: Math.round(this.host.waitMs() / 60_000) })
  }

  private async check(w: Waiting): Promise<void> {
    if (this.waits.get(w.agent.key) !== w || w.checking) return
    if (!this.host.stillStopped(w.agent)) return this.cleared(w.agent.key)
    if (this.expired(w)) return
    w.checking = true
    const up = await this.host.reachable(w.agent)
    w.checking = false
    if (this.waits.get(w.agent.key) !== w) return
    if (!this.host.stillStopped(w.agent)) return this.cleared(w.agent.key)
    if (this.expired(w)) return
    const now = this.host.now()
    w.checks++
    if (up) {
      this.stop(w)
      const note = inDialectOf({ projectPath: w.agent.projectPath, agentId: w.agent.agentId }, () => resumeNote(w.droppedAt, now))
      const given = await this.host.resume(w.agent, note).catch((e) => {
        log.warn('resuming an agent after the connection came back', e)
        return false
      })
      if (given) {
        this.resumes.set(w.agent.key, [...(this.resumes.get(w.agent.key) ?? []), now])
        log.info(`${userText(w.agent.projectPath)} · ${w.agent.agentId}: the connection is back; resumed`)
        this.host.ended(w.agent, { kind: 'resumed', droppedAt: w.droppedAt, backAt: now })
      } else this.host.ended(w.agent, { kind: 'cancelled' })
      return
    }
    const next = checkDelay(w.checks, this.host.checkFirstMs(), this.host.checkMostMs())
    // No check is scheduled past the limit: the last one is the last before it.
    if (now - w.droppedAt + next > this.host.waitMs()) return this.timedOut(w)
    this.schedule(w)
  }
}

/** The longest a reachability request may take. */
const REACH_TIMEOUT_MS = 10_000

/**
 * Whether `url`'s host answers an HTTP request at all (any status: a 401 or 404 is an answer), by IPv4 or IPv6, each
 * tried at once: the CLI's own requests fall back from one to the other. Asynchronous throughout (the lookup and the
 * request), so main's thread is never held.
 */
export function reachable(url: string, timeoutMs = REACH_TIMEOUT_MS): Promise<boolean> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return Promise.resolve(false)
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return Promise.resolve(false)
  const one = (family: 4 | 6): Promise<boolean> =>
    new Promise((resolve) => {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest
      const req = send(target, { method: 'HEAD', family, timeout: timeoutMs, headers: { 'User-Agent': 'Combwork' } }, (res) => { // i18n-ignore: an HTTP header the API host reads
        res.resume()
        resolve(true)
        req.destroy()
      })
      req.on('timeout', () => req.destroy(new Error('timed out'))) // i18n-ignore: never shown (the check is false)
      req.on('error', () => resolve(false))
      req.end()
    })
  return new Promise((resolve) => {
    let left = 2
    for (const family of [4, 6] as const)
      void one(family).then((ok) => {
        if (ok) resolve(true)
        else if (--left === 0) resolve(false)
      })
  })
}
