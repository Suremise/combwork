// The Agent API's route templates as patterns (HI-2258): `:agent` may be empty, the call that names no agent (Combwork's
// tools' optional `agent`), which its routes answer as the project's sole agent or refuse saying "agent" is missing;
// before, `/agents//activity` found no route and the tool's caller got "No route for GET …". Other parameters still
// need a segment. What the routes answer (the sole agent's activity, the refusal with several): e2e agentapislots.
import { describe, expect, it } from 'vitest'
import { routePattern } from '../src/main/routePattern'

const params = (template: string, path: string): string[] | null => path.match(routePattern(template))?.slice(1) ?? null

describe('routePattern', () => {
  it('matches each parameter, with or without a trailing slash, and nothing longer', () => {
    expect(params('/v1/tasks/:n/start', '/v1/tasks/12/start')).toEqual(['12'])
    expect(params('/v1/tasks/:n/start', '/v1/tasks/12/start/')).toEqual(['12'])
    expect(params('/v1/tasks/:n', '/v1/tasks/12/start')).toBeNull()
  })

  it('takes an empty agent: the call that names none (cw_agent_activity with no agent)', () => {
    expect(params('/v1/projects/:name/agents/:agent/activity', '/v1/projects/alpha/agents//activity')).toEqual(['alpha', ''])
    expect(params('/v1/projects/:name/agents/:agent/activity', '/v1/projects/alpha/agents/B1/activity')).toEqual(['alpha', 'B1'])
    expect(params('/v1/projects/:name/agents/:agent', '/v1/projects/alpha/agents/')).toEqual(['alpha', ''])
    expect(params('/v1/projects/:name/agents/:agent/launches/:run', '/v1/projects/alpha/agents//launches/r1')).toEqual(['alpha', '', 'r1'])
  })

  it('never takes another parameter empty', () => {
    expect(params('/v1/projects/:name/agents/:agent/activity', '/v1/projects//agents/B1/activity')).toBeNull()
    expect(params('/v1/tasks/:n/start', '/v1/tasks//start')).toBeNull()
    expect(params('/v1/projects/:name/agents/:agent/launches/:run', '/v1/projects/alpha/agents/B1/launches/')).toBeNull()
  })
})
