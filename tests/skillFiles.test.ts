// A skill's reference files (HI-2011): SKILL.md as a contents page linking files beside it. The skill page lists a
// skill's files only for a skill Combwork lists (skills:files), and a link in its preview opens a file of that skill only
// when it names one exactly: no traversal, no escape, no path outside the folder.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { skillLinkTarget } from '../src/shared/skillLinks'

const base = tempDir('cw-skill-files-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { listedSkillFiles } = await import('../src/main/skills')
const store = await import('../src/main/boardStore')

afterAll(() => {
  store.closeAllBoards()
  rmSync(base, { recursive: true, force: true })
})

describe('a link in a skill to one of its files (skillLinkTarget)', () => {
  const files = ['SKILL.md', 'builder.md', 'reviewer.md', 'notes/extra.md']
  it('names a listed file exactly, with its anchor or query dropped and a ./ allowed', () => {
    expect(skillLinkTarget('builder.md', files)).toBe('builder.md')
    expect(skillLinkTarget('./reviewer.md#a-failed-round', files)).toBe('reviewer.md')
    expect(skillLinkTarget('notes/extra.md?x=1', files)).toBe('notes/extra.md')
    expect(skillLinkTarget('builder%2Emd', files)).toBe('builder.md')
  })
  it('never anything else: not listed, traversal, absolute, drive, backslash, a scheme, an escape that hides one, a malformed escape', () => {
    for (const href of ['missing.md', '../card-loop/builder.md', 'notes/../builder.md', '/builder.md', 'C:/x/builder.md', 'c:builder.md', '..\\builder.md', 'notes\\extra.md', 'https://example.com/builder.md', 'file:///C:/builder.md', '%2e%2e/builder.md', '..%2fbuilder.md', '%5cbuilder.md', 'builder%', '%E0%A4%A.md', '#builder', '', './', 'notes//extra.md', 'builder.md%00'])
      expect([href, skillLinkTarget(href, files)]).toEqual([href, null])
  })
})

describe("a skill's files for its page (listedSkillFiles)", () => {
  it("lists a listed skill's files (a link inside never followed), and refuses any folder that isn't a listed skill", async () => {
    const ws = join(base, 'ws')
    const project = join(ws, 'alpha')
    mkdirSync(join(project, '.combwork'), { recursive: true })
    writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      const skill = join(w.skillsDir, 'release-steps')
      mkdirSync(skill, { recursive: true })
      writeFileSync(join(skill, 'SKILL.md'), '---\nname: release-steps\ndescription: Release steps. Use when releasing.\n---\n# Release\n\nSee [the checks](checks.md).\n')
      writeFileSync(join(skill, 'checks.md'), '# Checks\n')
      // A link to a folder outside the skill: never listed (skillFiles doesn't follow links).
      const outside = join(base, 'outside')
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'secret.md'), 'x')
      let linked = true
      try {
        symlinkSync(outside, join(skill, 'escape'), 'junction')
      } catch {
        linked = false
      }
      const r = await inWorkspace(w, () => listedSkillFiles(skill))
      expect(r).toEqual({ files: ['SKILL.md', 'checks.md'], truncated: false })
      if (linked) expect(r.files.some((f) => f.startsWith('escape'))).toBe(false)
      // Not a listed skill: the workspace, the skills folder itself, a folder inside a skill, a project folder.
      for (const dir of [ws, w.skillsDir, join(skill, 'escape'), project, join(skill, '..', 'release-steps', '..')])
        await expect(inWorkspace(w, () => listedSkillFiles(dir))).rejects.toThrow(/isn't a skill Combwork lists/)
    } finally {
      await disposeWorkspaceService(w)
    }
  })
})
