/**
 * Whether an agent's hooks are reaching Hive (#1336). Hive has no hooks-free mode (#1285): its hooks are how it knows what
 * an agent does. What can still go wrong is hooks that stop arriving while Hive thinks all is well (a CLI update changed
 * them, a managed policy turned them off, Hive refused their token), which left a wrong status: ready while it worked,
 * a turn never over, lines typed into it that were never confirmed. This reads only what Hive already has, no status of
 * its own: the hooks themselves, its screen reading (the turn ledger's last check) and its records (the transcript's
 * requests). Two signs, each needing time and evidence, never time alone:
 * - its start: a CLI that sends a hook as it starts (capabilities.startHook) sent none within the bound of starting,
 *   with no question at its start in the way (the time a question waits for the user doesn't count);
 * - a prompt: one sent while it was idle (the user's Enter, a line Hive typed, its launch's task) had no hook after it for
 *   the bound, while its CLI went to work on it (its screen shows it working, or its records have more requests than
 *   just before the prompt: a count from before it, so a quick turn over before the first look still counts, and an
 *   unknown one shows nothing) for a while too.
 * A long silent think never counts: its prompt's hook came. An Enter that started nothing (a menu, a local command) is
 * dropped once its screen shows it idle. Any hook clears it.
 */

/** How long the evidence of work must stand, with still no hook, before it counts (at most the bound). */
export const HOOKS_GRACE_MS = 15_000

export interface HooksWatch {
  /** Hooks this launch, and when the last came. */
  hooks: number
  lastHookAt: number | null
  /** The CLI sends a hook as it starts. */
  startHook: boolean
  /** From when its start counts: its launch, or the last check that found a question at its start in the way. */
  startFrom: number
  /**
   * The first prompt since its last hook that was sent while it was idle: when (ms), and its records' requests just
   * before it (null: unknown, so its records show nothing for it).
   */
  submit: { at: number; requests: number | null } | null
  /** When the evidence of work on that prompt was first seen. */
  workAt: number | null
}

export const newHooksWatch = (startedAt: number, startHook: boolean): HooksWatch => ({ hooks: 0, lastHookAt: null, startHook, startFrom: startedAt, submit: null, workAt: null })

/** A hook came: its hooks are arriving, and whatever prompt it was waiting on is answered. */
export function hookArrived(w: HooksWatch, now: number): void {
  w.hooks++
  w.lastHookAt = now
  w.submit = null
  w.workAt = null
}

/**
 * A prompt was sent (`idle`: while the agent was idle, so a hook should follow), with its records' requests just before
 * it when known (`requests`: a count from before it, never one read after, which a quick turn could be in). Whether it is
 * the one now watched.
 */
export function promptSent(w: HooksWatch, now: number, idle: boolean, requests: number | null = null): boolean {
  if (!idle || w.submit) return false
  w.submit = { at: now, requests }
  w.workAt = null
  return true
}

/** What a check sees now. */
export interface HooksEvidence {
  /** A question at its start waits for the user (folder trust): its start doesn't count meanwhile. */
  startWaits: boolean
  /** Its screen's reading of its turn (null: not read, or not sure). */
  screen: 'idle' | 'working' | null
  /** Its records' (its transcript's) requests now; null: unknown. */
  requests: number | null
}

/**
 * Whether its hooks are missing now: 'start' or 'prompt' (what showed it), else null. `boundMs`: Settings → Advanced
 * (hive.hooks.missingSeconds). It notes what it saw on the way (work begun, a question at the start, an Enter dropped).
 */
export function hooksMissing(w: HooksWatch, ev: HooksEvidence, now: number, boundMs: number): 'start' | 'prompt' | null {
  if (ev.startWaits) w.startFrom = now
  if (w.startHook && w.hooks === 0 && !ev.startWaits && now - w.startFrom >= boundMs) return 'start'
  const s = w.submit
  if (!s) return null
  const grace = Math.min(HOOKS_GRACE_MS, boundMs)
  const worked = ev.screen === 'working' || (s.requests !== null && ev.requests !== null && ev.requests > s.requests)
  if (worked) w.workAt ??= now
  // At its prompt again with nothing to show for it: that Enter started no turn (a menu, a local command).
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
