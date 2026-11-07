// Tools by a project agent's side of the workflow (HI-2664, Darren's approval with role filtering): a builder is never
// offered a reviewer's moves, nor a reviewer a builder's; either side or neither gets both; the Assistant none of a
// worker's. Every tool a side's own skills tell it to use is offered to that side, so no skill sends an agent to a tool it
// lacks (card-loop is one skill for both sides: its builder.md and reviewer.md are each their side's).
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ASSISTANT_ONLY_TOOLS, BUILDER_ONLY_TOOLS, CW_TOOLS, REVIEWER_ONLY_TOOLS, WORKER_ONLY_TOOLS, hiddenForSide, toolSideOf } from '../src/shared/assistantTools'

const SKILLS = join(__dirname, '..', 'resources', 'skills')
const read = (...p: string[]): string => readFileSync(join(SKILLS, ...p), 'utf8')
const dir = (name: string): string => readdirSync(join(SKILLS, name)).filter((f) => f.endsWith('.md')).map((f) => read(name, f)).join('\n')
const named = (text: string): string[] => [...new Set(text.match(/\bcw_[a-z_]+\b/g) ?? [])].filter((t) => CW_TOOLS.includes(t))

/** Each side's own texts: what it is told to do. */
const SIDE_TEXTS = {
  builder: [read('card-loop', 'builder.md'), dir('work-on-card'), dir('merge-ready')].join('\n'),
  reviewer: [read('card-loop', 'reviewer.md'), dir('review-agent-work')].join('\n')
}

describe('tools by side (HI-2664)', () => {
  it("a side's lists are Combwork's tools, apart, and every project agent's (never only the Assistant's)", () => {
    for (const t of [...BUILDER_ONLY_TOOLS, ...REVIEWER_ONLY_TOOLS]) {
      expect(CW_TOOLS, t).toContain(t)
      expect(ASSISTANT_ONLY_TOOLS, t).not.toContain(t)
    }
    expect(BUILDER_ONLY_TOOLS.filter((t) => REVIEWER_ONLY_TOOLS.includes(t))).toEqual([])
  })

  it("a launch's side: builder, reviewer, else both (either, none, unknown)", () => {
    expect(['builder', 'reviewer', 'either', 'none', 'unknown', undefined].map(toolSideOf)).toEqual(['builder', 'reviewer', 'both', 'both', 'both', 'both'])
    expect(hiddenForSide('builder')).toEqual(REVIEWER_ONLY_TOOLS)
    expect(hiddenForSide('reviewer')).toEqual(BUILDER_ONLY_TOOLS)
    expect([hiddenForSide('both'), hiddenForSide(undefined), hiddenForSide('nonsense')]).toEqual([[], [], []])
  })

  for (const side of ['builder', 'reviewer'] as const) {
    it(`every tool a ${side}'s skills name is offered to a ${side}`, () => {
      const tools = named(SIDE_TEXTS[side])
      expect(tools.length).toBeGreaterThan(3)
      expect(tools.filter((t) => hiddenForSide(side).includes(t)), `${side}'s skills name tools it isn't offered`).toEqual([])
    })
  }

  it("the Assistant's skills name none of a worker's tools", () => {
    const assistant = readdirSync(SKILLS).filter((s) => /audience:\s*assistant/.test(read(s, 'SKILL.md')))
    expect(assistant.length).toBeGreaterThan(2)
    for (const s of assistant) {
      // Naming a tool another session uses ("ask the builder to post it as a design step, cw_loop_step") is fine; using
      // one is not: those lines say whose call it is.
      const own = dir(s).split('\n').filter((l) => !/builder|reviewer|agent's|ask (?:the|an) agent/i.test(l)).join('\n')
      expect(named(own).filter((t) => WORKER_ONLY_TOOLS.includes(t)), s).toEqual([])
    }
  })
})
