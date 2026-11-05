import { join } from 'path'
import { readdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parseSkillFrontmatter, skillFromZip, skillText } from '../src/main/skills'

const text = (u: Uint8Array | undefined): string => new TextDecoder().decode(u)

describe('skillText', () => {
  it('sets the frontmatter name to the chosen one', () => {
    const out = skillText('---\nname: old\ndescription: Does things\n---\n\n# Body\n', 'new-name')
    expect(parseSkillFrontmatter(out)).toEqual({ name: 'new-name', description: 'Does things' })
    expect(out).toContain('# Body')
  })

  it('adds a name when the frontmatter has none, and keeps CRLF files CRLF', () => {
    const out = skillText('---\r\ndescription: x\r\n---\r\nbody\r\n', 'n')
    expect(out.startsWith('---\r\nname: n\r\ndescription: x\r\n---\r\n')).toBe(true)
    expect(out.endsWith('body\r\n')).toBe(true)
  })

  it('adds frontmatter to a plain .md, describing it from its heading', () => {
    const out = skillText('# Release checklist\n\nSteps…\n', 'release')
    expect(parseSkillFrontmatter(out)).toEqual({ name: 'release', description: 'Release checklist' })
    expect(out).toContain('Steps…')
  })

  it('quotes a description YAML would misread', () => {
    const out = skillText('# Use for: deploys\n', 'deploy')
    expect(parseSkillFrontmatter(out).description).toBe('Use for: deploys')
  })
})

describe('skillFromZip', () => {
  it('takes SKILL.md and its files from the top of the zip', () => {
    const z = zipSync({ 'SKILL.md': strToU8('---\nname: a\ndescription: d\n---\n'), 'scripts/run.sh': strToU8('echo hi') })
    const r = skillFromZip(z)
    expect(r.folder).toBeNull()
    expect([...r.files.keys()].sort()).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(text(r.files.get('scripts/run.sh'))).toBe('echo hi')
  })

  it('drops a single top folder, and names the skill after it', () => {
    const z = zipSync({ 'my-skill/SKILL.md': strToU8('x'), 'my-skill/ref/notes.md': strToU8('y'), '__MACOSX/my-skill/._SKILL.md': strToU8('junk') })
    const r = skillFromZip(z)
    expect(r.folder).toBe('my-skill')
    expect([...r.files.keys()].sort()).toEqual(['SKILL.md', 'ref/notes.md'])
  })

  it('refuses a zip without a SKILL.md where a skill has it', () => {
    expect(() => skillFromZip(zipSync({ 'a/SKILL.md': strToU8('x'), 'b/SKILL.md': strToU8('y') }))).toThrow(/No SKILL.md/)
    expect(() => skillFromZip(zipSync({ 'readme.md': strToU8('x') }))).toThrow(/No SKILL.md/)
  })

  it('refuses paths that would land outside the skill folder', () => {
    expect(() => skillFromZip(zipSync({ 'SKILL.md': strToU8('x'), '../evil.txt': strToU8('y') }))).toThrow(/unsafe path/)
  })
})

describe('bundled skills', () => {
  const root = join(__dirname, '..', 'resources', 'skills')
  const names = readdirSync(root)

  it('are the seventeen Combwork ships with', () => {
    expect(names.sort()).toEqual(['board-hygiene', 'card-loop', 'coordinate-agents', 'generalist', 'handover', 'journal', 'licence-audit', 'merge-ready', 'pick-up', 'review-agent-work', 'run-lanes', 'split-work', 'triage-report', 'tune-settings', 'use-cw-api', 'work-on-card', 'workspace-note'])
  })

  it('each has a SKILL.md named after its folder, with a description', async () => {
    for (const n of names) {
      const fm = parseSkillFrontmatter(await readFile(join(root, n, 'SKILL.md'), 'utf8'))
      expect(fm.name).toBe(n)
      expect((fm.description ?? '').length).toBeGreaterThan(40)
    }
  })
})
