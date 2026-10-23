// Resume All: only stopped agents with a conversation resume, running ones are skipped, failures don't stop the rest.
import { describe, expect, it } from 'vitest'
import { agentsToResume, resumeAll, type ResumeAllAgent } from '../src/shared/resumeAll'

const agent = (name: string, state: 'running' | 'stopped' | 'none'): ResumeAllAgent => ({
  id: `a-${name}`,
  name,
  live: state === 'running' ? { status: 'working' } : null,
  resume: state === 'none' ? null : { id: `s-${name}` }
})

describe('resume all', () => {
  const agents = [agent('One', 'running'), agent('Two', 'stopped'), agent('Three', 'stopped'), agent('Four', 'running'), agent('Five', 'none')]

  it('picks only stopped agents with a session to resume', () => {
    expect(agentsToResume(agents).map((a) => a.name)).toEqual(['Two', 'Three'])
  })

  it('resumes the stopped agents and leaves running ones alone', async () => {
    const started: string[] = []
    const r = await resumeAll(agents, async (a) => {
      started.push(a.id)
    })
    expect(started).toEqual(['a-Two', 'a-Three'])
    expect(r).toEqual({ resumed: ['Two', 'Three'], running: ['One', 'Four'], nothing: ['Five'], held: [], failed: [] })
  })

  it('reports a failure with its reason and still resumes the others', async () => {
    const started: string[] = []
    const r = await resumeAll([agent('Two', 'stopped'), agent('Three', 'stopped'), agent('Six', 'stopped'), agent('One', 'running')], async (a) => {
      if (a.name === 'Two') throw new Error('Claude Code is turned off in Settings → Providers.')
      if (a.name === 'Three') throw 'session file missing'
      started.push(a.name)
    })
    expect(started).toEqual(['Six'])
    expect(r.resumed).toEqual(['Six'])
    expect(r.running).toEqual(['One'])
    expect(r.failed).toEqual([
      { name: 'Two', error: 'Claude Code is turned off in Settings → Providers.' },
      { name: 'Three', error: 'session file missing' }
    ])
  })

  it('resumes one at a time', async () => {
    let active = 0
    let most = 0
    await resumeAll([agent('A', 'stopped'), agent('B', 'stopped'), agent('C', 'stopped')], async () => {
      most = Math.max(most, ++active)
      await new Promise((r) => setTimeout(r, 5))
      active--
    })
    expect(most).toBe(1)
  })
})
