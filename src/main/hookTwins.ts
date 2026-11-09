/**
 * Hook deliveries that arrive twice (HI-2777). Claude Code runs a handler defined in two settings files once, and
 * Combwork's launch hooks are built identical to the admin snippet's, so normally a hook comes once. Where they differ (a
 * timeout changed after the snippet was pasted, an older snippet, the Agent API's port not listening), Claude Code runs
 * both, and Combwork gets each hook twice. Only a hook that carries a real occurrence identity (its CLI's own id for one
 * tool call or one prompt) is matched: its first delivery is handled, its reply computed once, and a later delivery of
 * the same identity is answered from that reply, never handled again, never with another occurrence's reply.
 *
 * A duplicate always gets the first reply's decision (everything in it but its context: a lock's deny stands even if the
 * first response never reached Claude Code). Its context (a notice, SessionStart's guidance) goes in one response at a
 * time: a later delivery takes it only once the response carrying it has failed. A response that finished was written in
 * full, which isn't proof Claude Code read it: recovering context across a dropped connection is best effort. Hooks
 * without an identity are never matched here: each delivery is handled.
 */

/** How many identities a run keeps (the oldest go first: a duplicate of one older than that is handled again). */
export const TWINS_PER_RUN = 4096

/** What a delivery is to do: handle it (the first), or answer from the first one's reply. */
export type TwinClaim = { first: true; entry: TwinEntry } | { first: false; entry: TwinEntry }

type ContextState = 'unsent' | 'sending' | 'sent' | 'free'

export class TwinEntry {
  /** The first delivery's reply once computed (null: none, or it failed, or the run ended first). */
  private answer: Promise<unknown>
  private settle!: (v: unknown) => void
  private context: ContextState = 'unsent'
  private changed: (() => void)[] = []
  constructor() {
    this.answer = new Promise((r) => (this.settle = r))
  }

  /** The first delivery's reply, computed. */
  computed(reply: unknown): void {
    this.settle(reply)
  }

  /**
   * The response carrying the context is being written: `delivered` once it finished, false if it failed or closed
   * first (a later delivery may then carry it).
   */
  sending(): void {
    this.context = 'sending'
  }

  sent(delivered: boolean): void {
    this.context = delivered ? 'sent' : 'free'
    this.wake()
  }

  /** The run ended: whatever waits on this entry goes on (with no reply, or the context counted as sent). */
  end(): void {
    this.settle(null)
    if (this.context !== 'sent') this.context = 'sent'
    this.wake()
  }

  private wake(): void {
    const w = this.changed
    this.changed = []
    for (const f of w) f()
  }

  private nextChange(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.changed = this.changed.filter((f) => f !== done)
        resolve(false)
      }, ms)
      const done = (): void => {
        clearTimeout(t)
        resolve(true)
      }
      this.changed.push(done)
    })
  }

  /**
   * A later delivery's reply: the first reply's decision, and its context only when no response has carried it (this
   * delivery then carries it: call sent() with how its response ended, which the reply's `carries` says). Waits at most
   * `boundMs` for the first reply and for a response carrying the context to end; past that, a reply never computed is
   * none, and context still being sent counts as sent (never given twice).
   */
  async twinReply(boundMs: number): Promise<{ reply: unknown; carries: boolean }> {
    const until = Date.now() + boundMs
    const reply = await Promise.race([this.answer, new Promise((r) => setTimeout(() => r(null), boundMs))])
    if (reply === null || reply === undefined) return { reply: null, carries: false }
    if (!hasContext(reply)) return { reply, carries: false }
    while (this.context === 'unsent' || this.context === 'sending') {
      const left = until - Date.now()
      if (left <= 0 || !(await this.nextChange(left))) return { reply: decisionOnly(reply), carries: false }
    }
    if (this.context === 'free') {
      this.context = 'sending'
      return { reply, carries: true }
    }
    return { reply: decisionOnly(reply), carries: false }
  }
}

/** Whether a reply carries context (a notice, SessionStart's guidance). */
export function hasContext(reply: unknown): boolean {
  const r = reply as Record<string, any> | null
  return !!r && typeof r === 'object' && (r.additionalContext !== undefined || r.systemMessage !== undefined || (r.hookSpecificOutput && typeof r.hookSpecificOutput === 'object' && r.hookSpecificOutput.additionalContext !== undefined))
}

/**
 * A reply without its context: every other field kept as it is (a permission decision and its reason, a block and its
 * reason, anything a handler adds), so a duplicate carries the same decision. Null when nothing is left.
 */
export function decisionOnly(reply: unknown): Record<string, unknown> | null {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null
  const out: Record<string, unknown> = { ...(reply as Record<string, unknown>) }
  delete out.additionalContext
  delete out.systemMessage
  const hso = out.hookSpecificOutput
  if (hso && typeof hso === 'object' && !Array.isArray(hso)) {
    const rest: Record<string, unknown> = { ...(hso as Record<string, unknown>) }
    delete rest.additionalContext
    if (Object.keys(rest).some((k) => k !== 'hookEventName')) out.hookSpecificOutput = rest
    else delete out.hookSpecificOutput
  }
  return Object.keys(out).length ? out : null
}

/** Each run's identities, in arrival order (a Map keeps insertion order: the oldest go first). */
const runs = new Map<string, Map<string, TwinEntry>>()
/** Runs whose hooks were seen arriving twice (told once each). */
const doubled = new Set<string>()

/**
 * A delivery of the occurrence `key` (null: it has no identity) of the run `run`: decided at arrival, before anything
 * is awaited, so of two deliveries arriving together one is always the first. `onDoubled` the first time a run has one.
 */
export function claimTwin(run: string, key: string | null, onDoubled?: () => void): TwinClaim | null {
  if (!key) return null
  let seen = runs.get(run)
  if (!seen) runs.set(run, (seen = new Map()))
  const had = seen.get(key)
  if (had) {
    if (!doubled.has(run)) {
      doubled.add(run)
      onDoubled?.()
    }
    return { first: false, entry: had }
  }
  const entry = new TwinEntry()
  seen.set(key, entry)
  if (seen.size > TWINS_PER_RUN) seen.delete(seen.keys().next().value!)
  return { first: true, entry }
}

/** Whether the run's hooks have arrived twice. */
export const hooksDoubled = (run: string): boolean => doubled.has(run)

/** The run ended: its identities go, and every delivery waiting on one goes on. */
export function endTwins(run: string): void {
  const seen = runs.get(run)
  runs.delete(run)
  doubled.delete(run)
  if (seen) for (const e of seen.values()) e.end()
}
