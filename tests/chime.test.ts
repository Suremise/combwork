// A chime plays now or not at all (HI-3605): tones go only on a running AudioContext's clock, a context that won't run
// within the bound drops its chime with no tones scheduled, and tones a context stops before they play are cut off
// rather than left to play late, together, at its next resume. Each outcome is reported for combwork.log.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHIME_RESUME_MS, chimeLogLine, cleanChimeReport, type ChimeReport } from '../src/shared/chime'

// The renderer's module, by a path tsc doesn't follow (its DOM types aren't this program's), as other renderer tests do.
type ChimeContext = { readonly __chimeContext: unique symbol }
const rendererChime = '../src/renderer/src/chime'
const { chimeNow } = (await import(/* @vite-ignore */ rendererChime)) as {
  chimeNow: (sound: string, volume: number, deps: { context: () => ChimeContext; report: (r: ChimeReport) => void }) => Promise<ChimeReport>
}

const param = () => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() })

/** A context in `state`; `resume` says what resuming it does (by default: nothing, ever). */
function fakeContext(state: string, resume: (c: { state: string }) => Promise<void> = () => new Promise(() => undefined)) {
  const listeners: (() => void)[] = []
  const started: number[] = []
  const masters: { disconnect: ReturnType<typeof vi.fn> }[] = []
  const c = {
    state,
    currentTime: 100,
    destination: {},
    resume: vi.fn(() => resume(c)),
    createGain: vi.fn(() => {
      const g = { gain: param(), connect: (n: unknown) => n, disconnect: vi.fn() }
      masters.push(g)
      return g
    }),
    createOscillator: vi.fn(() => ({ type: 'sine', frequency: param(), connect: (n: unknown) => n, start: (t: number) => started.push(t), stop: vi.fn() })),
    addEventListener: (_: string, f: () => void) => listeners.push(f),
    /** The context's state changes, as Windows or Chromium changes it. */
    become(s: string) {
      c.state = s
      for (const f of listeners) f()
    }
  }
  return { c, ac: c as unknown as ChimeContext, started, masters }
}

function run(ac: ChimeContext) {
  const reports: ChimeReport[] = []
  return { reports, play: () => chimeNow('chime', 0.5, { context: () => ac, report: (r) => reports.push(r) }) }
}

afterEach(() => vi.useRealTimers())

describe('a chime plays now or not at all', () => {
  it('plays at once on a running context', async () => {
    const { ac, c, started } = fakeContext('running')
    const { reports, play } = run(ac)
    expect(await play()).toMatchObject({ outcome: 'played', state: 'running' })
    expect(started.length).toBeGreaterThan(0)
    expect(Math.min(...started)).toBeGreaterThanOrEqual(100)
    expect(c.resume).not.toHaveBeenCalled()
    expect(reports).toHaveLength(1)
  })

  it('schedules no tones on a suspended context that does not resume within the bound', async () => {
    vi.useFakeTimers()
    const { ac, c, started } = fakeContext('suspended')
    const { reports, play } = run(ac)
    const p = play()
    await vi.advanceTimersByTimeAsync(CHIME_RESUME_MS)
    expect(await p).toMatchObject({ outcome: 'dropped', state: 'suspended', after: 'suspended' })
    expect(c.createOscillator).not.toHaveBeenCalled()
    expect(c.createGain).not.toHaveBeenCalled()
    // Resuming later plays nothing: nothing was left on its clock.
    c.become('running')
    expect(started).toEqual([])
    expect(reports.map((r) => r.outcome)).toEqual(['dropped'])
  })

  it('plays after a resume that runs the context within the bound', async () => {
    const { ac, started } = fakeContext('suspended', async (c) => void (c.state = 'running'))
    expect(await run(ac).play()).toMatchObject({ outcome: 'resumed', state: 'suspended', after: 'running' })
    expect(started.length).toBeGreaterThan(0)
  })

  it('drops it when the resume resolves but the context is still not running', async () => {
    const { ac, c } = fakeContext('suspended', async () => undefined)
    expect(await run(ac).play()).toMatchObject({ outcome: 'dropped', after: 'suspended' })
    expect(c.createOscillator).not.toHaveBeenCalled()
  })

  it('drops it, saying why, when the resume fails', async () => {
    const { ac, c } = fakeContext('suspended', async () => Promise.reject(new Error('no device')))
    expect(await run(ac).play()).toMatchObject({ outcome: 'dropped', error: 'no device' })
    expect(c.createOscillator).not.toHaveBeenCalled()
  })

  it('drops it on a closed context without trying to resume it', async () => {
    const { ac, c } = fakeContext('closed')
    expect(await run(ac).play()).toMatchObject({ outcome: 'dropped', state: 'closed' })
    expect(c.resume).not.toHaveBeenCalled()
    expect(c.createOscillator).not.toHaveBeenCalled()
  })

  it('cuts off tones the context stops before they play, and only those', async () => {
    const { ac, c, masters } = fakeContext('running')
    const { reports, play } = run(ac)
    await play()
    // Stopped before it played: cut off, never left for the next resume.
    c.become('suspended')
    expect(masters[0].disconnect).toHaveBeenCalledOnce()
    expect(reports.map((r) => r.outcome)).toEqual(['played', 'cut'])
    // One that has played is left alone when the context stops later.
    c.become('running')
    await play()
    c.currentTime += 10
    c.become('suspended')
    // Each chime's first gain is its output (then one a tone): the second chime's is the fourth.
    expect(masters[3].disconnect).not.toHaveBeenCalled()
    expect(reports.map((r) => r.outcome)).toEqual(['played', 'cut', 'played'])
  })
})

describe("a chime's line in combwork.log", () => {
  it('checks what the page sends', () => {
    expect(cleanChimeReport(null)).toBeNull()
    expect(cleanChimeReport({ outcome: 'late' })).toBeNull()
    expect(cleanChimeReport({ outcome: 'dropped', state: 'suspended', after: 'suspended', waitedMs: 1000.4, error: 'x'.repeat(500) })).toEqual({ outcome: 'dropped', state: 'suspended', after: 'suspended', waitedMs: 1000, error: 'x'.repeat(200) })
    expect(cleanChimeReport({ outcome: 'played', waitedMs: -3 })).toEqual({ outcome: 'played', state: 'unknown', after: 'unknown', waitedMs: 0 })
  })

  it('says which case it was', () => {
    expect(chimeLogLine({ outcome: 'played', state: 'running', after: 'running', waitedMs: 0 })).toBe('Chime played (audio context running)')
    expect(chimeLogLine({ outcome: 'resumed', state: 'suspended', after: 'running', waitedMs: 12 })).toBe('Chime played after resuming its audio context (was suspended), waited 12 ms')
    expect(chimeLogLine({ outcome: 'dropped', state: 'suspended', after: 'suspended', waitedMs: 1000, error: 'no device' })).toBe('Chime dropped: its audio context was suspended and still suspended, waited 1000 ms; resume failed: no device')
    expect(chimeLogLine({ outcome: 'cut', state: 'running', after: 'suspended', waitedMs: 0 })).toBe('Chime cut off: its audio context went from running to suspended before it played')
  })
})
