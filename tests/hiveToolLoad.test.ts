// Hive's tools where a CLI defers MCP tools (HI-2229): each role's most used tools are marked to be sent in full, only
// tools that role is offered at every control level; and a refused call that guessed its arguments is told the tool's.
import { describe, expect, it } from 'vitest'
import { AGENT_ONLY_TOOLS, ASSISTANT_ONLY_TOOLS, HIVE_TOOLS, assistantTools } from '../src/shared/assistantTools'
import { AGENT_ALWAYS_LOAD, ASSISTANT_ALWAYS_LOAD, alwaysLoaded, argumentHint } from '../src/shared/hiveToolLoad'

describe('the tools sent in full (HI-2229)', () => {
  it('are hive tools, a few per role', () => {
    for (const t of ASSISTANT_ALWAYS_LOAD) expect(HIVE_TOOLS).toContain(t)
    expect(alwaysLoaded(false)).toEqual(AGENT_ALWAYS_LOAD)
    expect(alwaysLoaded(true)).toEqual(ASSISTANT_ALWAYS_LOAD)
    expect(ASSISTANT_ALWAYS_LOAD.length).toBeLessThanOrEqual(6)
  })

  it("a project agent's are tools every agent is offered", () => {
    for (const t of AGENT_ALWAYS_LOAD) expect(ASSISTANT_ONLY_TOOLS).not.toContain(t)
  })

  it("the Assistant's are tools it is offered at the lowest control level, without the journal or settings", () => {
    const look = assistantTools('look')
    for (const t of ASSISTANT_ALWAYS_LOAD) {
      expect(AGENT_ONLY_TOOLS).not.toContain(t)
      if (ASSISTANT_ONLY_TOOLS.includes(t)) expect(look).toContain(t)
    }
  })
})

describe("a refused call is told its tool's arguments (HI-2229)", () => {
  const readTask = {
    properties: { number: { description: 'Its key ("HI-12").' }, comments: {}, latestComment: {}, summary: {}, history: {} },
    required: ['number']
  }

  it('a guessed name: what it takes, the required first, and what it gave that it does not take', () => {
    expect(argumentHint('hive_read_task', readTask, { key: 'AL-1', comments: 5 })).toBe('hive_read_task takes number (required), comments, latestComment, summary, history; missing: number; not: key.')
  })

  it('names the arguments, never the values given', () => {
    const hint = argumentHint('hive_read_task', readTask, { task_id: 'secret value AL-1' })!
    expect(hint).toContain('task_id')
    expect(hint).not.toContain('secret')
  })

  it('nothing when the arguments match the schema: the refusal is about something else', () => {
    expect(argumentHint('hive_read_task', readTask, { number: 'AL-1' })).toBeNull()
    expect(argumentHint('hive_list_projects', { properties: {} }, {})).toBeNull()
  })

  it('a tool with no arguments says so', () => {
    expect(argumentHint('hive_list_projects', { properties: {} }, { project: 'alpha' })).toBe('hive_list_projects takes no arguments; not: project.')
  })

  it('stays short: at most six names of each kind', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`x${i}`, i]))
    const hint = argumentHint('hive_read_task', readTask, many)!
    expect(hint).toContain('not: x0, x1, x2, x3, x4, x5, …')
    expect(hint).not.toContain('x6')
  })
})
