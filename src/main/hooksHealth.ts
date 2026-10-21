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
 * A long silent think never counts: its prompt's hook came. An Enter that started nothing (a menu, a local command) is
 * dropped once its screen shows it idle. Not yet (the Assistant's scope, #1371): a quick turn over before Hive's first
 * look at its screen isn't flagged by itself (a later turn long enough to be seen is, and a line Hive types meanwhile
 * shows as not taken, #430), nor a CLI without a screen reading (Copilot).
 */

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
}

export const newHooksWatch = (startedAt: number, startHook: boolean): HooksWatch => ({ hooks: 0, lastHookAt: null, startHook, startFrom: startedAt, submit: null, workAt: null })

/** A hook came, of whatever turn (as it reaches Hive, before its turn in the launch's queue): its start is heard. */
export function hookSeen(w: HooksWatch, now: number): void {
  w.hooks++
  w.lastHookAt = now
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
 * Whether its hooks are missing now: 'start' or 'prompt' (what showed it), else null. `boundMs`: Settings → Advanced
 * (hive.hooks.missingSeconds). It notes what it saw on the way (work begun, a question at the start, an Enter dropped).
 */
export function hooksMissing(w: HooksWatch, ev: HooksEvidence, now: number, boundMs: number): 'start' | 'prompt' | null {
  if (ev.startWaits) w.startFrom = now
  if (w.startHook && w.hooks === 0 && !ev.startWaits && now - w.startFrom >= boundMs) return 'start'
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
