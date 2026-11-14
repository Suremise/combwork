/**
 * Restarts announced and resumed (HI-1707): what Combwork records of its agents as it closes, the record's states, the
 * installer's request to close for an install, and the lines agents are given. Pure: main/restartResume.ts keeps the
 * record and runs the queue.
 */
import { agentMsg, say } from './agentText'
import { NOTICE_PREFIX } from './doorbell'

/** Why Combwork closed: an installer asked (install), an update installing (update), Restart Combwork (restart), or a quit. */
export type RestartReason = 'install' | 'update' | 'restart' | 'quit'

/**
 * Where an agent's resume stands. pending: not yet decided at this start (or its workspace isn't open); offered: the
 * notice offers it, the user decides; queued, starting: in this run's queue; the rest are final.
 */
export type RestartState = 'pending' | 'offered' | 'queued' | 'starting' | 'resumed' | 'held' | 'failed' | 'dismissed' | 'skipped'

/** States an entry ends in: a record whose entries are all in one of them is done (removed). */
export const FINAL_STATES: readonly RestartState[] = ['resumed', 'failed', 'dismissed', 'skipped']
/** The states the user still has to see: held (its slot), and offered. */
const OPEN_STATES: readonly RestartState[] = ['pending', 'offered', 'queued', 'starting', 'held']

/** An agent Combwork closed under, and where its resume stands: who is resumed (how is the record's `reason`). */
export interface RestartEntry {
  workspace: string
  projectPath: string
  project: string
  agentId: string
  agentName: string
  provider: string
  sessionId: string
  sessionName?: string
  /** How it was as Combwork closed: working, watching (a card loop), waiting, background, or idle in a running lane. */
  status: string
  /** The card it was on (its key, else #n), and the card's round then. */
  card?: { label: string; round?: number }
  /** The running lane it was the builder or reviewer of. */
  lane?: { id: string; name: string | null; role: 'builder' | 'reviewer' }
  /** Combwork's version as it closed. */
  from: string
  /** When Combwork closed. */
  at: string
  state: RestartState
  /** Why it was skipped, held or failed, for the notice. */
  why?: string
  /** A skip from before the queue (idle as Combwork closed, or expired) that a start's notice has named (HI-2909). */
  reported?: boolean
  /** When it was last changed. */
  changedAt: string
}

/**
 * The record: who (its entries) and how (`reason`, the latest close's: every close overwrites it). An install, an update
 * or a restart resumes the entries by itself; a quit offers them. Entries carry no reason of their own, so none can
 * carry an older close's.
 */
export interface RestartRecord {
  version: 1
  reason: RestartReason
  entries: RestartEntry[]
}

const REASONS: readonly RestartReason[] = ['install', 'update', 'restart', 'quit']

/**
 * Why Combwork's own quit closes it (an installer's request aside): Restart and Update's install is an update's
 * (`install` 'restart'), Restart Combwork a restart, and anything else a quit, including a plain quit that installs the
 * update on its way out with Install now (`install` 'quit', HI-3167): the user quit, and Combwork doesn't restart itself,
 * so its agents are offered back at the next start, never told it restarted for an update.
 */
export const closeReason = (install: 'quit' | 'restart' | null, relaunch: boolean): RestartReason => (install === 'restart' ? 'update' : relaunch ? 'restart' : 'quit')

/** How long an entry no start has taken up is kept, then skipped. */
export const ENTRY_EXPIRY_MS = 24 * 60 * 60 * 1000
/** How long a lane's "isn't running" stall is held for an agent queued to resume, at most. */
export const STALL_HOLD_MS = 10 * 60 * 1000

/** One agent of one project: an entry for it replaces another for it. */
export const agentKey = (e: Pick<RestartEntry, 'projectPath' | 'agentId'>): string => `${e.projectPath.toLowerCase()}#${e.agentId}`

export const isFinal = (s: RestartState): boolean => FINAL_STATES.includes(s)
export const isOpen = (s: RestartState): boolean => OPEN_STATES.includes(s)

/**
 * A new snapshot (Combwork closing again) added to the record, with that close's reason: each agent in it replaces its
 * earlier entry (it ran in this run, so that entry is out of date), and entries of agents not in it are kept as they
 * are, so an offer the user hasn't answered isn't lost. Final entries are dropped, a skip no notice has named yet
 * (`unreported`) included: a later close replaces an earlier record's unreported skips (HI-2909, the Assistant's scope).
 */
export function mergeSnapshot(record: RestartRecord | null, snapshot: readonly RestartEntry[], reason: RestartReason): RestartRecord {
  const now = new Set(snapshot.map(agentKey))
  const kept = (record?.entries ?? []).filter((e) => !isFinal(e.state) && !now.has(agentKey(e)))
  return { version: 1, reason, entries: [...kept, ...snapshot] }
}

/**
 * The record as a start finds it: an entry the last run left queued or starting (it ended mid-recovery) is pending
 * again, to be checked once more before it is queued; one older than ENTRY_EXPIRY_MS is skipped.
 */
export function atStart(record: RestartRecord, now: number): RestartRecord {
  return {
    version: 1,
    reason: record.reason,
    entries: record.entries.map((e) => {
      if (isOpen(e.state) && now - Date.parse(e.at) > ENTRY_EXPIRY_MS) return { ...e, state: 'skipped', why: 'expired', changedAt: new Date(now).toISOString() }
      if (e.state === 'queued' || e.state === 'starting') return { ...e, state: 'pending', changedAt: new Date(now).toISOString() }
      return e
    })
  }
}

/**
 * A skip from before any start's queue (HI-2909): idle as Combwork closed, or a day old at this start. Final, but kept
 * until a start's notice has named it, so the notice accounts for every agent that ran, those all skipped included.
 */
export const unreported = (e: RestartEntry): boolean => e.state === 'skipped' && (e.why === 'idle' || e.why === 'expired') && !e.reported

/** Whether a record still has anything to do or tell: an entry not final, or a skip not named yet. */
export const recordOpen = (r: RestartRecord | null): boolean => !!r?.entries.some((e) => !isFinal(e.state) || unreported(e))

/** Reads a record from its file's text: null when it isn't one (damaged, another version). */
export function parseRecord(text: string): RestartRecord | null {
  try {
    const v = JSON.parse(text) as Partial<RestartRecord>
    if (v?.version !== 1 || !Array.isArray(v.entries)) return null
    const ok = (e: Partial<RestartEntry>): e is RestartEntry => typeof e?.projectPath === 'string' && typeof e.agentId === 'string' && typeof e.sessionId === 'string' && typeof e.state === 'string' && typeof e.at === 'string'
    // A record with no reason we know offers (a quit's): Combwork never resumes by itself on a guess.
    const reason = REASONS.includes(v.reason as RestartReason) ? (v.reason as RestartReason) : 'quit'
    return { version: 1, reason, entries: v.entries.filter(ok) }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The installer's request (installer.nsh): close for an install, bound to this process and this copy.
// ---------------------------------------------------------------------------

/** The request's file in Combwork's profile, the acknowledgement's, and what a request taken is renamed to. */
export const REQUEST_FILE = 'restart-request.json'
export const ackFile = (nonce: string): string => `restart-ack-${nonce}.json`
export const takenFile = (nonce: string): string => `restart-request.${nonce}.taken`
/** A request is at most this big, and this old. */
export const REQUEST_MAX_BYTES = 4096
export const REQUEST_MAX_AGE_MS = 60_000
/** How far apart this process's start and the request's may be (the installer reads it from Windows, Combwork from its uptime). */
export const START_TOLERANCE_MS = 5_000

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RestartRequest {
  v: 1
  nonce: string
  pid: number
  /** When that process started (UTC, ISO). */
  pidCreated: string
  /** The Combwork.exe it was started from. */
  exe: string
  reason: 'install'
  /** When the installer wrote it (UTC, ISO). */
  at: string
}

/** This process, as a request must name it. */
export interface RequestTarget {
  pid: number
  /** When this process started (ms). */
  startedAt: number
  /** This copy's executable, its real path. */
  exe: string
  now: number
  /** Nonces already handled in this run. */
  seen: ReadonlySet<string>
}

export type RequestCheck = { ok: true; request: RestartRequest } | { ok: false; why: string; nonce?: string }

/**
 * Whether a request's text asks this process to close for an install: its size, its form (a GUID nonce before any file
 * is named after it), this process and its start, this copy's executable (`samePath` compares real paths), and its age.
 * A nonce already handled is a replay.
 */
export function checkRequest(text: string, t: RequestTarget, samePath: (a: string, b: string) => boolean): RequestCheck {
  if (new TextEncoder().encode(text).length > REQUEST_MAX_BYTES) return { ok: false, why: 'too big' } // agent-protocol: the installer request's check, written only to the log
  let v: Partial<RestartRequest>
  try {
    v = JSON.parse(text.replace(/^﻿/, '')) as Partial<RestartRequest>
  } catch {
    return { ok: false, why: 'malformed (partial or not JSON)' } // agent-protocol: the installer request's check, written only to the log
  }
  if (!v || typeof v !== 'object' || v.v !== 1 || v.reason !== 'install') return { ok: false, why: 'malformed' }
  if (typeof v.nonce !== 'string' || !GUID.test(v.nonce)) return { ok: false, why: 'malformed (its nonce)' } // agent-protocol: the installer request's check, written only to the log
  const nonce = v.nonce
  if (t.seen.has(nonce.toLowerCase())) return { ok: false, why: 'a replay (already handled)', nonce } // agent-protocol: the installer request's check, written only to the log
  if (typeof v.pid !== 'number' || typeof v.pidCreated !== 'string' || typeof v.exe !== 'string' || typeof v.at !== 'string') return { ok: false, why: 'malformed', nonce }
  if (v.pid !== t.pid) return { ok: false, why: `for another process (${v.pid})`, nonce } // agent-protocol: the installer request's check, written only to the log
  const created = Date.parse(v.pidCreated)
  if (Number.isNaN(created) || Math.abs(created - t.startedAt) > START_TOLERANCE_MS) return { ok: false, why: 'for an earlier process with the same id', nonce } // agent-protocol: the installer request's check, written only to the log
  if (!samePath(v.exe, t.exe)) return { ok: false, why: 'for another copy of Combwork', nonce } // agent-protocol: the installer request's check, written only to the log
  const at = Date.parse(v.at)
  if (Number.isNaN(at) || t.now - at > REQUEST_MAX_AGE_MS || at - t.now > START_TOLERANCE_MS) return { ok: false, why: 'stale', nonce }
  return { ok: true, request: v as RestartRequest }
}

// ---------------------------------------------------------------------------
// What agents are told (agent-facing: agent messages, said in the dialect of the agent each is for).
// ---------------------------------------------------------------------------

const T = {
  restarting: agentMsg({ id: 'notice.restart.restarting', text: "Combwork is restarting for an update. Your work is saved; you'll be resumed.", note: 'HI-1707: the notice an agent finds in its inbox as Combwork closes for an update, an install or a restart.' }),
  resumed: agentMsg({
    id: 'notice.restart.resumed',
    text: '{reason, select, quit {Combwork was quit and started again} restart {Combwork restarted} other {Combwork restarted for an update}}{versions} at {time} UTC; your session was stopped and is resumed now.{where}{watch, select, yes { Carry on: re-arm your card watch if you were waiting.} other { Carry on where you were.}}',
    note: 'HI-1707: the first prompt a resumed agent is given. reason: quit, restart or update (an install too); versions: " (1.0.0 → 1.0.1)" when the version changed, or nothing; time: when Combwork closed ("10:00"); where: what it was on (notice.restart.where), after a space, or nothing; watch: yes when it was watching or in a lane.'
  }),
  where: agentMsg({
    id: 'notice.restart.where',
    text: "{onCard, select, yes {You were on {card}{hasRound, select, yes {, round {round}} other {}}{inLane, select, yes {, in lane ''{lane}'' (its {role, select, builder {builder} other {reviewer}})} other {}}} other {You were in lane ''{lane}'' (its {role, select, builder {builder} other {reviewer}})}}.",
    note: 'HI-1707: what a resumed agent was on as Combwork closed. onCard: yes with its card (card: "HI-12"; round: its round when hasRound is yes); inLane: yes with its lane (lane: its name or id; role: builder or reviewer). One of the two at least.'
  })
}

/** The line an agent finds in its inbox as Combwork closes for an update (said per agent, in its dialect). */
export const restartingLine = (): string => say(T.restarting)

/**
 * The first line a resumed agent is given: why Combwork restarted, from which version to which and when, what it was on,
 * and to re-arm its watch if it was waiting.
 */
export function resumeNote(e: Pick<RestartEntry, 'from' | 'at' | 'status' | 'card' | 'lane'>, to: string, reason: RestartReason): string {
  const versions = e.from && e.from !== to ? ` (${e.from} → ${to})` : ''
  const where = e.card || e.lane ? ` ${say(T.where, { onCard: e.card ? 'yes' : 'no', card: e.card?.label ?? '', hasRound: e.card?.round ? 'yes' : 'no', round: String(e.card?.round ?? ''), inLane: e.lane ? 'yes' : 'no', lane: e.lane ? (e.lane.name ?? e.lane.id) : '', role: e.lane?.role ?? '' })}` : ''
  return NOTICE_PREFIX + say(T.resumed, { reason: reason === 'quit' || reason === 'restart' ? reason : 'update', versions, time: e.at.slice(11, 16), where, watch: e.status === 'watching' || e.lane ? 'yes' : 'no' })
}
