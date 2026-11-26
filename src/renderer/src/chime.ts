import type { ChimeSound } from '@shared/types'
import { CHIME_RESUME_MS, type ChimeReport } from '@shared/chime'

// A chime plays now or not at all (HI-3605, shared/chime.ts): tones go only on a running context's clock, and tones it
// stops before they play are cut off rather than left to play late, together with others.

/** What of an AudioContext a chime uses: a fake in a unit test. */
export type ChimeContext = Pick<AudioContext, 'state' | 'currentTime' | 'destination' | 'resume' | 'createGain' | 'createOscillator' | 'addEventListener'>

/** A chime scheduled: its output, and when (on its context's clock) its last tone ends. */
interface Pending {
  out: GainNode
  endsAt: number
}

/** Where a chime's context comes from and its outcome goes. */
export interface ChimeDeps {
  context: () => ChimeContext
  report: (r: ChimeReport) => void
  now?: () => number
  resumeMs?: number
}

let ctx: ChimeContext | null = null
const pending = new WeakMap<ChimeContext, Pending[]>()

/** The context's chimes still to play, watched: when it stops, those are cut off, never left for its next resume. */
function pendingOf(ac: ChimeContext, report: (r: ChimeReport) => void): Pending[] {
  let list = pending.get(ac)
  if (!list) {
    const mine: Pending[] = []
    list = mine
    pending.set(ac, mine)
    ac.addEventListener('statechange', () => {
      if (ac.state === 'running') return
      for (const p of mine.splice(0)) {
        if (p.endsAt <= ac.currentTime) continue
        p.out.disconnect()
        report({ outcome: 'cut', state: 'running', after: ac.state, waitedMs: 0 })
      }
    })
  }
  return list
}

/** Waits up to `ms` for the context to run, resuming it: true when it is running. */
async function running(ac: ChimeContext, ms: number): Promise<{ ok: boolean; error?: string }> {
  if (ac.state === 'running') return { ok: true }
  if (ac.state === 'closed') return { ok: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  let error: string | undefined
  const resumed = ac.resume().then(
    () => true,
    (e: unknown) => ((error = e instanceof Error ? e.message : String(e)), false)
  )
  const late = new Promise<false>((done) => (timer = setTimeout(() => done(false), ms)))
  await Promise.race([resumed, late])
  clearTimeout(timer)
  // The state, not the promise: a resume can resolve while the device stays suspended.
  return { ok: (ac.state as string) === 'running', ...(error ? { error } : {}) }
}

/** Plays a chime on `deps`' context if it runs within the bound (by `now`, not only by which promise settles first),
 * else drops it (HI-3605). What happened is reported. */
export async function chimeNow(sound: ChimeSound, volume: number, deps: ChimeDeps): Promise<ChimeReport> {
  const now = deps.now ?? Date.now
  const ac = deps.context()
  const state = ac.state as string
  const started = now()
  const bound = deps.resumeMs ?? CHIME_RESUME_MS
  const { ok, error } = await running(ac, bound)
  const waitedMs = now() - started
  const after = ac.state as string
  let report: ChimeReport
  // Late is late, whichever settled first: a renderer paused (sleep, a long stall) can see the resume before the timer.
  if (!ok || waitedMs > bound) report = { outcome: 'dropped', state, after, waitedMs, ...(error ? { error } : {}) }
  else {
    const list = pendingOf(ac, deps.report)
    const t = ac.currentTime
    const out = schedule(ac, sound, volume, t + 0.02)
    // Those already played needn't be watched.
    list.splice(0, list.length, ...list.filter((p) => p.endsAt > t), { out, endsAt: t + 0.02 + LONGEST })
    report = { outcome: state === 'running' ? 'played' : 'resumed', state, after, waitedMs }
  }
  deps.report(report)
  return report
}

/** The longest any sound lasts after it starts, in seconds (bell's tones, and each tone's tail). */
const LONGEST = 1.7

function tone(ac: ChimeContext, out: AudioNode, freq: number, start: number, duration: number, gain: number, type: OscillatorType = 'sine'): void {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(gain, start + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(g).connect(out)
  osc.start(start)
  osc.stop(start + duration + 0.05)
}

function schedule(ac: ChimeContext, sound: ChimeSound, volume: number, t: number): GainNode {
  const master = ac.createGain()
  master.gain.value = Math.max(0, Math.min(1, volume))
  master.connect(ac.destination)
  switch (sound) {
    case 'chime':
      tone(ac, master, 1318.5, t, 0.9, 0.35) // E6
      tone(ac, master, 1975.5, t + 0.12, 1.1, 0.28) // B6
      break
    case 'bell':
      for (const [f, g] of [[880, 0.3], [1760, 0.12], [2640, 0.06], [3520, 0.03]] as const) tone(ac, master, f, t, 1.6, g)
      break
    case 'soft':
      tone(ac, master, 659.3, t, 0.7, 0.3) // E5
      tone(ac, master, 987.8, t + 0.16, 0.8, 0.22) // B5
      break
    case 'pop':
      tone(ac, master, 1046.5, t, 0.18, 0.4, 'triangle')
      tone(ac, master, 1568, t + 0.07, 0.22, 0.3, 'triangle')
      break
  }
  return master
}

/** Plays a short synthesised notification sound — no audio files needed — now, or not at all (HI-3605). */
export function playChime(sound: ChimeSound, volume: number): void {
  void chimeNow(sound, volume, {
    context: () => (ctx ??= new AudioContext()),
    // combwork.log says each chime's outcome: no bridge outside Combwork's window.
    report: (r) => void (typeof globalThis.window === 'undefined' ? undefined : window.combwork)?.invoke('window:chime', r).catch(() => undefined)
  }).catch(() => undefined)
}
