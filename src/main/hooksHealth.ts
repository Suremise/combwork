import { promptKey } from './providers/turns'

/**
 * Whether an agent's hooks are reaching Hive (#1336). Hive has no hooks-free mode (#1285): its hooks are how it knows what
 * an agent does. What can still go wrong is hooks that stop arriving while Hive thinks all is well (a CLI update changed
 * them, a managed policy turned them off, Hive refused their token), which left a wrong status: ready while it worked,
 * a turn never over, lines typed into it that were never confirmed. This reads only what Hive already has, no status of
 * its own: the hooks themselves (as the turn ledger takes them) and its screen reading (the ledger's last check). Two
 * signs, each needing time and evidence, never time alone:
 * - its start: a CLI that sends a hook as it starts (capabilities.startHook) sent none within the bound of starting,
 *   with no question at its start in the way (the time a question waits for the user doesn't count);
 * - a prompt: one sent while it was idle (the user's Enter, a line Hive typed, its launch's task) had no hook of a current
 *   turn after it for the bound, while its screen showed it working (it was idle when the prompt went, so that work is
 *   this prompt's), that standing a while too.
 * - a turn its transcript shows (#1371): one the CLI's own records identify (Claude Code's promptId, Codex's turn_id,
 *   Copilot's interactionId), begun by a prompt written since this launch started and taken up by the model, had no hook
 *   for the bound since Hive found it. Its hooks answer it by that same id (prompt_id, turn_id, as the turn ledger reads
 *   them), whenever they come, before or after the transcript is written. Copilot's carry none: its prompt hook answers
 *   it by the prompt's text (Copilot records the prompt only once that hook has returned), and any hook that came after
 *   the prompt was recorded (a late hook of the turn before arriving then is taken for it: it errs toward saying
 *   nothing). A quick turn over before Hive's first look at its screen is caught this way, and Copilot too.
 * A long silent think never counts: its prompt's hook came. An Enter that started nothing (a menu, a local command) is
 * dropped once its screen shows it idle, and a local command has no model work in its transcript. Not covered: a new
 * Codex session's turns while its hooks are missing (with no hook it has no session id, so no rollout to read) until
 * one is long enough to be seen on its screen, and Claude Code's task-notification wakes (whether their hooks come
 * isn't certain).
 */

/** How far apart Hive's clock and a transcript record's may be (both this machine's, written a moment apart). */
export const HOOKS_SKEW_MS = 2_000
/** How long before a Copilot prompt was recorded its prompt hook may have come (the hook runs first). */
export const PROMPT_HOOK_WINDOW_MS = 60_000
/** Hook turn ids kept per launch, and transcript turns waited on: the latest only. */
const MAX_HEARD = 256
const MAX_TURNS = 500
/** Turns order let go of, remembered as forgotten: the latest only. */
const MAX_FORGOTTEN = 2_000

/** How long the evidence of work must stand, with still no hook, before it counts (at most the bound). */
export const HOOKS_GRACE_MS = 15_000

export interface HooksWatch {
  /** Hooks this launch, any turn's, and when the last came. */
  hooks: number
  lastHookAt: number | null
  /** The CLI sends a hook as it starts. */
  startHook: boolean
  /** From when its start counts: its launch, or the last check that found a question at its start in the way. */
  startFrom: number
  /** The first prompt since a current turn's hook that was sent while it was idle: when (ms). */
  submit: { at: number } | null
  /** When its screen was first seen working on that prompt. */
  workAt: number | null
  /** How its transcript's turns meet its hooks (the adapter's turnsJoin), or null: no transcript turns read. */
  join: 'id' | 'time' | null
  /** Turn ids its hooks carried (the latest), and when the last hook came. */
  heard: Set<string>
  /** Transcript turns worked and not heard yet: when Hive found each worked, and its place in the transcript. */
  unheard: Map<string, { foundAt: number; seq: number; at: number; prompt?: string }>
  /** With no turn ids ('time'): prompts its prompt hooks carried (by promptKey), and when each came (the latest). */
  prompts: Map<string, number>
  /** Each transcript turn's place in the order read (the latest), to tell a newer turn's hook from an older one's. */
  order: Map<string, number>
  seq: number
  /**
   * How far its turns are answered (a place in order, this reading's): a turn placed at or before it is never waited on
   * again, though a later read returns it worked once more (a record of it appended late).
   */
  answered: number
  /** The transcript turn that showed its hooks missing, while that flag stands, and its place (kept: order is bounded). */
  flagged: string | null
  flaggedSeq: number
  /**
   * Turns order let go of that weren't waited on (answered, or never worked): read again (a late record), each is
   * unknown, never placed anew as a newer turn. The latest only.
   */
  forgotten: Set<string>
}

export const newHooksWatch = (startedAt: number, startHook: boolean, join: 'id' | 'time' | null = null): HooksWatch => ({
  hooks: 0,
  lastHookAt: null,
  startHook,
  startFrom: startedAt,
  submit: null,
  workAt: null,
  join,
  heard: new Set(),
  unheard: new Map(),
  prompts: new Map(),
  order: new Map(),
  seq: 0,
  answered: 0,
  flagged: null,
  flaggedSeq: 0,
  forgotten: new Set()
})

const keep = <T>(set: Set<T> | Map<T, unknown>, max: number): void => {
  while (set.size > max) set.delete(set.keys().next().value!)
}

/** A hook came, of whatever turn (as it reaches Hive, before its turn in the launch's queue): its start is heard. */
export function hookSeen(w: HooksWatch, now: number): void {
  w.hooks++
  w.lastHookAt = now
}

/**
 * A hook, as the launch's queue takes it (in the order hooks came, beside the checks), came at `now`: the one place a hook
 * answers transcript turns, whatever the ledger makes of it and whether or not a flag stands (`turn`: its turn id as the
 * ledger reads it; any turn's, a stale one too: it proves that turn's hooks arrive). With ids, a turn the transcript has
 * placed answers every turn up to its place, the flagged one among them (an older turn's late hook never reaches a newer
 * one); one it hasn't placed yet is unknown, never newer, and is kept heard for transcriptTurns to answer by once its
 * record is read. With no ids (Copilot): the turn its prompt hook's text is the prompt of (`prompt`), every turn whose
 * prompt was recorded before the hook came, and a standing flag. Whether the flag was answered.
 */
export function hookTurn(w: HooksWatch, now: number, turn: string | null, prompt: string | null = null): boolean {
  // Its place as known before it is heard (a pending turn's own, though order has let go of it).
  const pos = turn ? placeOf(w, turn) : undefined
  if (turn) {
    w.heard.delete(turn)
    w.heard.add(turn)
    keep(w.heard, MAX_HEARD)
    w.unheard.delete(turn)
  }
  if (w.join === 'id') return pos !== undefined && answeredUpTo(w, pos)
  if (w.join !== 'time') return false
  const key = prompt ? promptKey(prompt) : null
  if (key) {
    w.prompts.delete(key)
    w.prompts.set(key, now)
    keep(w.prompts, MAX_HEARD)
  }
  for (const [id, u] of w.unheard) if (u.at <= now || (key && u.prompt === key)) w.unheard.delete(id)
  return w.flagged !== null && answeredUpTo(w, Infinity)
}

/**
 * The turns up to `upTo` (a place in the transcript) are answered, and so is the flag if its turn is among them: never
 * waited on again. At most the places read so far, so a turn read later (Copilot's any hook answers all) still counts.
 */
function answeredUpTo(w: HooksWatch, upTo: number): boolean {
  w.answered = Math.max(w.answered, Math.min(upTo, w.seq))
  for (const [id, u] of w.unheard) if (u.seq <= upTo) w.unheard.delete(id)
  if (w.flagged === null || w.flaggedSeq > upTo) return false
  w.flagged = null
  w.flaggedSeq = 0
  return true
}

/**
 * A turn's place in this reading, while it is known: in order, else (order being bounded) a turn still waited on or
 * flagged keeps its own. Undefined: unknown (not read, or forgotten), never taken as newer or older.
 */
function placeOf(w: HooksWatch, id: string): number | undefined {
  return w.order.get(id) ?? w.unheard.get(id)?.seq ?? (id === w.flagged ? w.flaggedSeq : undefined)
}

/**
 * A turn read for the first time is placed after all before it (or a known one given its place back); order lets go of
 * the oldest, remembering it forgotten unless its place is kept elsewhere (waited on, or flagged).
 */
function place(w: HooksWatch, id: string, at = ++w.seq): void {
  w.order.set(id, at)
  while (w.order.size > MAX_TURNS) {
    const old = w.order.keys().next().value!
    w.order.delete(old)
    if (!w.unheard.has(old) && old !== w.flagged) w.forgotten.add(old)
  }
  keep(w.forgotten, MAX_FORGOTTEN)
}

/**
 * Turns its transcript showed (the adapter's transcriptTurns), read at `now`: a worked turn begun since `since` (this
 * launch's start; history never counts) that no hook has named is waited on from now. Each turn's place is kept. With
 * turn ids, a turn read that a hook had already named answers every turn waited on before it, the flagged one too (its
 * hook came before the transcript showed it: an id not read yet is unknown, never taken as newer). A turn is read only
 * from its prompt, in the file's order, so one first read now is newer than those read before. Whether the flag was
 * answered.
 */
export function transcriptTurns(w: HooksWatch, turns: { id: string; at: number; worked: boolean; prompt?: string }[], now: number, since: number): boolean {
  let heardUpTo = 0
  for (const t of turns) {
    // A turn order let go of: one still waited on or flagged keeps its place; one forgotten is unknown, and left alone.
    if (!w.order.has(t.id)) {
      const kept = placeOf(w, t.id)
      if (kept !== undefined) place(w, t.id, kept)
      else if (w.forgotten.has(t.id)) continue
      else place(w, t.id)
    }
    const pos = w.order.get(t.id)!
    if (w.join === 'id' && w.heard.has(t.id)) heardUpTo = Math.max(heardUpTo, pos)
    if (!t.worked || !(t.at >= since - HOOKS_SKEW_MS) || w.unheard.has(t.id) || pos <= w.answered) continue
    const hookAt = t.prompt ? w.prompts.get(t.prompt) : undefined
    const heard = w.join === 'time' ? (w.lastHookAt !== null && w.lastHookAt >= t.at) || (hookAt !== undefined && hookAt >= t.at - PROMPT_HOOK_WINDOW_MS) : w.heard.has(t.id)
    if (heard) continue
    w.unheard.set(t.id, { foundAt: now, seq: pos, at: t.at, ...(t.prompt ? { prompt: t.prompt } : {}) })
    keep(w.unheard, MAX_TURNS)
  }
  return heardUpTo > 0 && answeredUpTo(w, heardUpTo)
}

/**
 * Its transcript is read again from the start (another file, conversation or launch): what it showed is let go, and the
 * flag it raised with it. Whether a flag stood (its alarm goes too).
 */
export function transcriptReset(w: HooksWatch): boolean {
  const flagged = w.flagged !== null
  w.unheard.clear()
  w.order.clear()
  w.forgotten.clear()
  w.answered = 0
  w.flagged = null
  w.flaggedSeq = 0
  return flagged
}

/**
 * A hook of a current turn was taken (the turn ledger didn't find it stale): the prompt watched is answered. A late hook
 * of a turn that is over says nothing of the prompt sent since, so it doesn't count.
 */
export function turnHeard(w: HooksWatch): void {
  w.submit = null
  w.workAt = null
}

/** A prompt was sent (`idle`: while the agent was idle, so a hook should follow). Whether it is the one now watched. */
export function promptSent(w: HooksWatch, now: number, idle: boolean): boolean {
  if (!idle || w.submit) return false
  w.submit = { at: now }
  w.workAt = null
  return true
}

/** What a check sees now. */
export interface HooksEvidence {
  /** A question at its start waits for the user (folder trust): its start doesn't count meanwhile. */
  startWaits: boolean
  /** Its screen's reading of its turn (null: not read, or not sure). */
  screen: 'idle' | 'working' | null
}

/**
 * Whether its hooks are missing now: 'start', 'transcript' or 'prompt' (what showed it), else null. `boundMs`: Settings → Advanced
 * (cw.hooks.missingSeconds). It notes what it saw on the way (work begun, a question at the start, an Enter dropped).
 */
export function hooksMissing(w: HooksWatch, ev: HooksEvidence, now: number, boundMs: number): 'start' | 'prompt' | 'transcript' | null {
  if (ev.startWaits) w.startFrom = now
  if (w.startHook && w.hooks === 0 && !ev.startWaits && now - w.startFrom >= boundMs) return 'start'
  for (const [id, u] of w.unheard) {
    if (now - u.foundAt < boundMs) continue
    w.flagged = id
    w.flaggedSeq = u.seq
    return 'transcript'
  }
  const s = w.submit
  if (!s) return null
  const grace = Math.min(HOOKS_GRACE_MS, boundMs)
  if (ev.screen === 'working') w.workAt ??= now
  // At its prompt again with nothing seen of it: that Enter started no turn (a menu, a local command).
  else if (w.workAt === null && ev.screen === 'idle' && now - s.at >= grace) {
    w.submit = null
    return null
  }
  return w.workAt !== null && now - s.at >= boundMs && now - w.workAt >= grace ? 'prompt' : null
}

const keyOf = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/** The agents whose hooks are missing now (sessions sets them), for the lanes that pause on them. */
const missing = new Set<string>()
const listeners: (() => void)[] = []

export function noteHooksMissing(projectPath: string, agentId: string, on: boolean): void {
  const k = keyOf(projectPath, agentId)
  if (on === missing.has(k)) return
  if (on) missing.add(k)
  else missing.delete(k)
  for (const fn of listeners) fn()
}

export const hooksMissingFor = (projectPath: string, agentId: string): boolean => missing.has(keyOf(projectPath, agentId))

/** Called when an agent's hooks go missing or come back. */
export function onHooksHealthChanged(fn: () => void): void {
  listeners.push(fn)
}

/**
 * Agents and conversations whose user was told their hooks went missing (#1336, #1369): told once each while Hive runs,
 * at most `max` remembered. One seen again moves to the newest place, so only conversations no longer missing hooks
 * are forgotten (one forgotten and missing them again is told again).
 */
export class SeenOnce {
  private seen = new Set<string>()
  constructor(private readonly max: number) {}
  /** Whether `key` is new (tell it); either way it is now the newest. */
  first(key: string): boolean {
    const had = this.seen.delete(key)
    this.seen.add(key)
    if (this.seen.size > this.max) this.seen.delete(this.seen.values().next().value!)
    return !had
  }
  get size(): number {
    return this.seen.size
  }
}
