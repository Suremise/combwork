// A start's step times (#1177): the log line names the steps over a second, slowest first, once the whole took over one.
import { describe, expect, it } from 'vitest'
import { StepTimes } from '../src/main/stepTimes'

/** Times on a clock that moves only when told. */
function clock(): { now: () => number; pass: (ms: number) => void } {
  let t = 0
  return { now: () => t, pass: (ms) => void (t += ms) }
}

describe('StepTimes', () => {
  it('says nothing for a start of a second or less', () => {
    const c = clock()
    const times = new StepTimes(c.now)
    c.pass(400)
    times.mark('agentDef')
    c.pass(600)
    times.mark('usage')
    expect(times.slowLine()).toBeNull()
  })

  it('names the slow steps, the slowest first', () => {
    const c = clock()
    const times = new StepTimes(c.now)
    c.pass(200)
    times.mark('agentDef')
    c.pass(1100)
    times.mark('usage')
    c.pass(42_000)
    times.mark('resumeProvider')
    expect(times.steps).toEqual([['agentDef', 200], ['usage', 1100], ['resumeProvider', 42_000]])
    expect(times.slowLine()).toBe('took 43.3 s: resumeProvider 42.0 s, usage 1.1 s')
  })

  it('says when no one step was slow, and counts time after the last mark', () => {
    const c = clock()
    const times = new StepTimes(c.now)
    for (const step of ['a', 'b', 'c']) {
      c.pass(500)
      times.mark(step)
    }
    c.pass(300)
    expect(times.slowLine()).toBe('took 1.8 s (no step over 1.0 s)')
    expect(times.slowLine(2000)).toBeNull()
  })
})
