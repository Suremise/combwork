// One agent of an all-agents action (HI-2665): which agents each one-agent menu lists, how choosing each acts, when the
// menu is offered, and what choosing one for Resume does once read again (never another agent).
import { describe, expect, it } from 'vitest'
import { offersOneAgent, oneAgentRows, resumeOneNow, type OneAgent } from '../src/shared/oneAgent'

const running = (status = 'ready', signIn?: object) => ({ sessionId: 's', status, ...(signIn ? { signIn } : {}) })
const agent = (id: string, live: OneAgent['live'] | (OneAgent['live'] & { signIn: object }), resume: OneAgent['resume']): OneAgent => ({ id, name: id.toUpperCase(), live, resume })

// A: stopped, resumable. B: stopped, held (its slot is free). C: running. D: running, its sign-in refused (stalled).
// E: stopped, nothing to resume.
const A = agent('a', null, { id: 'sa' })
const B = agent('b', null, { id: 'sb', hold: { is: 'byHand' } as never })
const C = agent('c', running('working') as never, { id: 'sc' })
const D = agent('d', running('finished', { at: 'now' }) as never, { id: 'sd' })
const E = agent('e', null, null)
const all = [A, B, C, D, E]
const rows = (kind: Parameters<typeof oneAgentRows>[0], agents = all) => oneAgentRows(kind, agents).map((r) => `${r.agent.id}:${r.how}`)

describe('the agents each one-agent menu lists (HI-2665)', () => {
  it("Resume: those Resume All resumes (a stalled one carried on), then the held ones it leaves, never chosen", () => {
    expect(rows('resume')).toEqual(['a:resume', 'd:carryOn', 'b:held'])
    expect(oneAgentRows('resume', all).find((r) => r.how === 'held')?.hold).toEqual({ is: 'byHand' })
  })

  it('Stop: the running ones; Start New: every agent; Archive and Start New: those with a session to archive', () => {
    expect(rows('stop')).toEqual(['c:stop', 'd:stop'])
    expect(rows('startNew')).toEqual(['a:start', 'b:start', 'c:start', 'd:start', 'e:start'])
    expect(rows('archive')).toEqual(['a:archive', 'b:archive', 'c:archive', 'd:archive'])
  })

  it('offered with two rows or more: with one, the all-agents action already acts on just that agent', () => {
    expect(offersOneAgent(oneAgentRows('stop', [C]))).toBe(false)
    expect(offersOneAgent(oneAgentRows('stop', [C, D]))).toBe(true)
    expect(offersOneAgent(oneAgentRows('resume', [A, E]))).toBe(false)
    // One to resume and one held: offered, so the held one's reason shows.
    expect(offersOneAgent(oneAgentRows('resume', [A, B]))).toBe(true)
  })
})

describe('choosing one for Resume, read again when chosen', () => {
  it('a stopped one resumes, a stalled one is carried on', () => {
    expect(resumeOneNow(A)).toBe('resume')
    expect(resumeOneNow(D)).toBe('carryOn')
  })

  it("gone, or no longer resumable since the menu opened (started, held, its sign-in carried on): nothing, never another agent", () => {
    expect(resumeOneNow(undefined)).toBe('gone')
    expect(resumeOneNow(null)).toBe('gone')
    expect(resumeOneNow({ ...A, live: running('working') as never })).toBe('notNow')
    expect(resumeOneNow(B)).toBe('notNow')
    expect(resumeOneNow({ ...D, live: running('working', { at: 'now' }) as never })).toBe('notNow')
    expect(resumeOneNow(E)).toBe('notNow')
  })
})
