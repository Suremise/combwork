// A SKILL.md's header is YAML: who gets a Hive skill (metadata.audience) is read as YAML says, whatever form it is
// written in (comments, flow mappings, quotes, block scalars, CRLF, a BOM). No audience means the project agents. A
// header that can't be read, or an audience Hive doesn't know, is a problem: nobody gets that skill, and the Skills view,
// the API, tool listings and each launch say why, instead of Hive guessing a recipient.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { skillListText } from '../src/shared/toolReplies'
import { tempDir } from './tempDir'

const base = tempDir('hive-frontmatter-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
afterAll(() => rmSync(base, { recursive: true, force: true }))

const { parseSkillFrontmatter } = await import('../src/main/skills')
const head = (yaml: string, nl = '\n') => `---${nl}${yaml.split('\n').join(nl)}${nl}---${nl}${nl}# Body${nl}`
const parse = (yaml: string) => parseSkillFrontmatter(head(yaml))

describe('reading the header as YAML', () => {
  it('finds the audience in every valid form', () => {
    expect(parse('name: a\nmetadata:\n  audience: assistant # Assistant only').audience).toBe('assistant')
    expect(parse('name: a\nmetadata: { audience: assistant }').audience).toBe('assistant')
    expect(parse('name: a\nmetadata:\n  # Recipients\n\n  audience: all').audience).toBe('all')
    expect(parse("name: a\nmetadata:\n  audience: 'Assistant'").audience).toBe('assistant')
    expect(parse('name: a\nmetadata:\n  audience: "agents"\n  other: 1').audience).toBe('agents')
    expect(parse('base: &who { audience: assistant }\nmetadata: *who').audience).toBe('assistant')
  })

  it('keeps names and descriptions in their YAML forms: quoted, block and folded, CRLF, a BOM', () => {
    expect(parse(`name: "release: notes"\ndescription: 'It''s for releases'`)).toEqual({ name: 'release: notes', description: "It's for releases" })
    expect(parse('name: a\ndescription: |\n  First line.\n  Second line.').description).toBe('First line.\nSecond line.')
    expect(parse('name: a\ndescription: >\n  One\n  sentence.').description).toBe('One sentence.')
    expect(parseSkillFrontmatter('﻿' + head('name: crlf\ndescription: Windows\nmetadata:\n  audience: all', '\r\n'))).toEqual({ name: 'crlf', description: 'Windows', audience: 'all' })
  })

  it('no audience is the default (no problem): no metadata, empty metadata, an unrelated nested one, prose', () => {
    for (const y of ['name: a', 'name: a\nmetadata:', 'name: a\nmetadata: {}', 'name: a\nmetadata:\n  other:\n    audience: assistant', 'name: a\ndescription: "audience: assistant"']) {
      const fm = parse(y)
      expect([fm.audience, fm.problem], y).toEqual([undefined, undefined])
    }
    // No header at all: nothing, and no problem.
    expect(parseSkillFrontmatter('# Just a heading\n')).toEqual({})
  })

  it("an audience Hive doesn't know, or the wrong type, is a problem rather than a default", () => {
    expect(parse('name: a\nmetadata:\n  audience: assitant')).toEqual({ name: 'a', problem: 'its audience is "assitant", not agents, assistant or all', problemText: expect.anything() })
    expect(parse('name: a\nmetadata:\n  audience: [assistant]').problem).toBe('its audience is a list, not agents, assistant or all')
    expect(parse('name: a\nmetadata:\n  audience: 3').problem).toBe('its audience is a number, not agents, assistant or all')
    expect(parse('name: a\nmetadata: assistant').problem).toMatch(/^its metadata isn't a set of fields/)
  })

  it('a key given twice (block or flow, at any level) is a problem, not last-one-wins', () => {
    const twice = [
      'name: a\nmetadata:\n  audience: assistant\n  audience: agents',
      'name: a\nmetadata: { audience: assistant, audience: agents }',
      'name: a\nname: b',
      'name: a\nmetadata: {}\nmetadata:\n  audience: all',
      'name: a\ndescription: x\ndescription: y'
    ]
    for (const y of twice) {
      const fm = parse(y)
      expect([fm.audience, fm.problem], y).toEqual([undefined, expect.stringMatching(/^its header isn't valid YAML \(line \d+: duplicated mapping key/)])
    }
  })

  it('an audience written but empty (null, ~, nothing) is a problem; only one left out is the default', () => {
    for (const y of ['metadata:\n  audience: null', 'metadata:\n  audience: ~', 'metadata:\n  audience:', 'metadata: { audience: }']) {
      expect(parse(`name: a\n${y}`), y).toEqual({ name: 'a', problem: 'its audience is empty, not agents, assistant or all', problemText: expect.anything() })
    }
    expect(parse('name: a\nmetadata:\n  other: 1')).toEqual({ name: 'a' })
  })

  it("a header that isn't valid YAML, isn't a mapping, or isn't closed is a problem", () => {
    expect(parse('name: [unclosed\nmetadata:\n  audience: assistant').problem).toMatch(/^its header isn't valid YAML \(line \d+: /)
    expect(parse('- just\n- a list').problem).toMatch(/^its header isn't a list of fields/)
    expect(parseSkillFrontmatter('---\nname: a\nmetadata:\n  audience: assistant\n\n# Body, no closing line\n').problem).toBe("its header isn't closed (no line with --- after it)")
    // Cut at headerOf's limit: said as that.
    expect(parseSkillFrontmatter('---\nname: a\ndescription: ' + 'x'.repeat(1000), true).problem).toBe("its header isn't closed within its first 64 KB")
  })
})

describe('who gets which skill', () => {
  it('the Skills view, the role filters and a launch agree; a broken one reaches nobody and says why', async () => {
    const ws = join(base, 'ws')
    const proj = join(ws, 'proj')
    mkdirSync(join(proj, '.combwork'), { recursive: true })
    writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
    const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
    const { hiveSkills } = await import('../src/main/skills')
    const { sessions } = await import('../src/main/sessions')
    const w = createWorkspaceService()
    await w.open(ws)
    const skill = (name: string, header: string) => {
      mkdirSync(join(ws, '.combwork', 'skills', name), { recursive: true })
      writeFileSync(join(ws, '.combwork', 'skills', name, 'SKILL.md'), head(`name: ${name}\ndescription: The ${name} skill.\n${header}`))
    }
    skill('inline-assistant', 'metadata:\n  audience: assistant # only the Assistant')
    skill('flow-all', 'metadata: { audience: all }')
    skill('commented-assistant', 'metadata:\n  # who\n  audience: assistant')
    skill('plain', '')
    skill('misspelt', 'metadata:\n  audience: assitant')
    skill('broken', 'metadata: [unclosed')
    skill('twice', 'metadata:\n  audience: assistant\n  audience: agents')
    skill('empty', 'metadata:\n  audience: ~')
    try {
      const names = async (role?: 'agent' | 'assistant') => (await inWorkspace(w, () => hiveSkills(false, role))).map((s) => s.name).sort()
      expect(await names('agent')).toEqual(['flow-all', 'plain'])
      expect(await names('assistant')).toEqual(['commented-assistant', 'flow-all', 'inline-assistant'])
      const all = await inWorkspace(w, () => hiveSkills())
      const of = (n: string) => all.find((s) => s.name === n)!
      expect([of('misspelt').audience, of('misspelt').problem]).toEqual([undefined, 'its audience is "assitant", not agents, assistant or all'])
      expect(of('broken').problem).toMatch(/^its header isn't valid YAML/)
      expect(of('twice').problem).toMatch(/duplicated mapping key/)
      expect([of('empty').audience, of('empty').problem]).toEqual([undefined, 'its audience is empty, not agents, assistant or all'])

      // A project agent's launch and the Assistant's: the same split, and the broken ones as problems.
      const agentLaunch = await sessions.effective(proj)
      const assistantLaunch0 = await sessions.effective(w.assistantHome)
      expect(agentLaunch.skills.map((s) => s.name).sort()).toEqual(['flow-all', 'plain'])
      expect(Object.keys(agentLaunch.skillProblems).sort()).toEqual(['broken', 'empty', 'misspelt', 'twice'])
      expect(Object.keys(assistantLaunch0.skillProblems).sort()).toEqual(['broken', 'empty', 'misspelt', 'twice'])
      const assistantLaunch = await sessions.effective(w.assistantHome)
      expect(assistantLaunch.skills.map((s) => s.name).sort()).toEqual(['commented-assistant', 'flow-all', 'inline-assistant'])
      expect(assistantLaunch.skillProblems.misspelt).toBe('its audience is "assitant", not agents, assistant or all')

      // A tool listing says it too.
      const text = skillListText(all.filter((s) => ['misspelt', 'inline-assistant', 'plain'].includes(s.name)).map((s) => ({ name: s.name, description: s.description, level: s.level, ...(s.audience ? { audience: s.audience } : {}), ...(s.problem ? { problem: s.problem } : {}) })))
      expect(text).toContain('misspelt (Combwork, given to nobody: its audience is "assitant", not agents, assistant or all)')
      expect(text).toContain('inline-assistant (Combwork, for the Assistant)')
      expect(text).toContain('plain (Combwork, for agents)')
    } finally {
      await disposeWorkspaceService(w)
    }
  })
})
