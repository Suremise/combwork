// Combwork's tools where a CLI defers MCP tools (HI-2229): none is marked to be sent in full (HI-3361, the user's
// decision); a refused call that guessed its arguments is told the tool's, and one Combwork names two ways is taken as meant.
import { describe, expect, it } from 'vitest'
import { AGENT_ONLY_TOOLS, ASSISTANT_ONLY_TOOLS, CW_TOOLS, assistantTools } from '../src/shared/assistantTools'
import { AGENT_ALWAYS_LOAD, ARG_ALIASES, ASSISTANT_ALWAYS_LOAD, alwaysLoaded, argumentHint, withAliases } from '../src/shared/combworkToolLoad'

describe('the tools sent in full (HI-2229)', () => {
  it('are Combwork tools, a few per role', () => {
    for (const t of ASSISTANT_ALWAYS_LOAD) expect(CW_TOOLS).toContain(t)
    expect(alwaysLoaded(false)).toEqual(AGENT_ALWAYS_LOAD)
    expect(alwaysLoaded(true)).toEqual(ASSISTANT_ALWAYS_LOAD)
    expect(ASSISTANT_ALWAYS_LOAD.length).toBeLessThanOrEqual(6)
    expect(AGENT_ALWAYS_LOAD.length).toBeLessThanOrEqual(6)
  })

  it("HI-3361 (the user's decision): no tool is marked to load at a session's start, an agent's or the Assistant's", () => {
    expect(AGENT_ALWAYS_LOAD).toEqual([])
    expect(ASSISTANT_ALWAYS_LOAD).toEqual([])
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
    expect(argumentHint('cw_read_task', readTask, { key: 'AL-1', comments: 5 })).toBe('cw_read_task takes number (required), comments, latestComment, summary, history; missing: number; not: key.')
  })

  it('names the arguments, never the values given', () => {
    const hint = argumentHint('cw_read_task', readTask, { task_id: 'secret value AL-1' })!
    expect(hint).toContain('task_id')
    expect(hint).not.toContain('secret')
  })

  it('nothing when the arguments match the schema: the refusal is about something else', () => {
    expect(argumentHint('cw_read_task', readTask, { number: 'AL-1' })).toBeNull()
    expect(argumentHint('cw_list_projects', { properties: {} }, {})).toBeNull()
  })

  it('a tool with no arguments says so', () => {
    expect(argumentHint('cw_list_projects', { properties: {} }, { project: 'alpha' })).toBe('cw_list_projects takes no arguments; not: project.')
  })

  it('stays short: at most six names of each kind', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`x${i}`, i]))
    const hint = argumentHint('cw_read_task', readTask, many)!
    expect(hint).toContain('not: x0, x1, x2, x3, x4, x5, …')
    expect(hint).not.toContain('x6')
  })
})

describe("an argument Combwork's own tools name two ways, taken as meant (HI-3361)", () => {
  const schema = (...names: string[]) => (n: string) => names.includes(n)
  it("a card as `number` where the tool takes `card`, and the reverse; a message's `message` as `text`; a note's `name`; a setting's `key`", () => {
    expect(withAliases('cw_start_card', schema('card'), { number: 'HI-12' })).toEqual({ card: 'HI-12' })
    expect(withAliases('cw_submit', schema('card', 'summary'), { number: 12, summary: 'Ready' })).toEqual({ card: 12, summary: 'Ready' })
    expect(withAliases('cw_read_task', schema('number', 'comments'), { card: 'HI-12', comments: 2 })).toEqual({ number: 'HI-12', comments: 2 })
    expect(withAliases('cw_message_agent', schema('project', 'agent', 'text', 'card'), { project: 'p', agent: 'B1', message: 'hi' })).toEqual({ project: 'p', agent: 'B1', text: 'hi' })
    expect(withAliases('cw_read_shared_note', schema('path'), { name: 'notes.md' })).toEqual({ path: 'notes.md' })
    expect(withAliases('cw_read_setting', schema('id', 'project'), { key: 'workflow.target' })).toEqual({ id: 'workflow.target' })
  })

  it("both given: the tool's own name wins and the alias is left as it was (an unknown argument, as before)", () => {
    expect(withAliases('cw_start_card', schema('card'), { card: 'HI-1', number: 'HI-2' })).toEqual({ card: 'HI-1', number: 'HI-2' })
    expect(withAliases('cw_message_agent', schema('text', 'agent'), { agent: 'B1', text: 'a', message: 'b' })).toEqual({ agent: 'B1', text: 'a', message: 'b' })
  })

  it('a canonical given as null or empty is given: no alias is taken, so the call is refused as before', () => {
    expect(withAliases('cw_start_card', schema('card'), { card: null, number: 'HI-2' })).toEqual({ card: null, number: 'HI-2' })
    expect(withAliases('cw_message_agent', schema('text'), { text: '', message: 'b' })).toEqual({ text: '', message: 'b' })
  })

  it('a value of a type the canonical takes only: a wrong type is left as it was', () => {
    expect(withAliases('cw_start_card', schema('card'), { number: ['HI-1'] })).toEqual({ number: ['HI-1'] })
    expect(withAliases('cw_read_shared_note', schema('path'), { name: 3 })).toEqual({ name: 3 })
  })

  it("a tool that takes both names, or neither, or an alias of another tool's: nothing changes; unknown fields stay", () => {
    const both = { number: 'HI-1', extra: true }
    expect(withAliases('cw_x', schema('card', 'number'), both)).toBe(both)
    expect(withAliases('cw_list_projects', schema(), { number: 'HI-1' })).toEqual({ number: 'HI-1' })
    // `message` is cw_message_agent's alias only: cw_ask_assistant's `text` takes none.
    expect(withAliases('cw_ask_assistant', schema('card', 'text'), { card: 'HI-1', message: 'hi' })).toEqual({ card: 'HI-1', message: 'hi' })
  })

  it('the map names only Combwork tools and never a project, agent or actor', () => {
    for (const t of Object.keys(ARG_ALIASES).filter((k) => k !== '*')) expect(CW_TOOLS).toContain(t)
    for (const a of Object.values(ARG_ALIASES).flat()) for (const n of [a.from, a.to]) expect(['project', 'agent', 'actor', 'builder', 'reviewer', 'by']).not.toContain(n)
  })
})
