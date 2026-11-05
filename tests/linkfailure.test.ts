// A link in a skill that Windows won't let Combwork make (a link to a file needs a privilege): the rest of the skill is
// still copied for Claude Code, whatever order the files come in, and the launch says which links are missing; Codex's
// swap is all or nothing, so an old copy stays whole. The refusal is injected: fs/promises' symlink fails for any link
// with "denied" in its name, as Windows would.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  return {
    ...real,
    symlink: async (target: string, path: string, type?: string) => {
      if (/denied[^\\/]*$/.test(String(path))) throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' })
      return real.symlink(target, path, type as never)
    }
  }
})

const { contentHash, copySkillTree } = await import('../src/main/fsutil')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { syncAgentsSkills } = await import('../src/main/providers/common')

const base = tempDir('hive-link-failure-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
const target = join(base, 'target')
mkdirSync(target, { recursive: true })
writeFileSync(join(target, 'shared.md'), 'shared')

/** A skill with a refused link before SKILL.md, between reference files and inside a nested folder, and a good link. */
function skill(name: string): string {
  const d = join(base, 'sources', name)
  mkdirSync(join(d, 'references', 'deep'), { recursive: true })
  symlinkSync(target, join(d, '00-denied-link'), 'junction')
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: A skill. Use when testing.\n---\n`)
  writeFileSync(join(d, 'references', 'a.md'), 'a')
  symlinkSync(target, join(d, 'references', 'denied-middle'), 'junction')
  writeFileSync(join(d, 'references', 'z.md'), 'z')
  symlinkSync(target, join(d, 'references', 'deep', 'denied-nested'), 'junction')
  writeFileSync(join(d, 'references', 'deep', 'after.md'), 'after')
  symlinkSync(target, join(d, 'references', 'shared'), 'junction')
  return d
}
const PLAIN = ['SKILL.md', 'references/a.md', 'references/z.md', 'references/deep/after.md']
const DENIED = ['00-denied-link', 'references/denied-middle', 'references/deep/denied-nested']

describe('a link Combwork is refused', () => {
  it('copySkillTree copies every other file and link, and says which links it left out', async () => {
    const dest = join(base, 'tree-copy')
    const skipped = await copySkillTree(skill('tree'), dest)
    expect(skipped.sort()).toEqual([...DENIED].sort())
    for (const f of PLAIN) expect(existsSync(join(dest, f)), f).toBe(true)
    for (const f of DENIED) expect(existsSync(join(dest, f)), f).toBe(false)
    expect(lstatSync(join(dest, 'references', 'shared')).isSymbolicLink()).toBe(true)
  })

  it('Claude Code: the skill is there without those links, and the launch says which are missing', async () => {
    const project = join(base, 'project')
    mkdirSync(project, { recursive: true })
    const src = skill('claude-skill')
    const delivered = await claudeCode.prepareLaunch({ projectPath: project, agentId: 'a1', cwd: project, skills: [{ name: 'claude-skill', sourcePath: src }], mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, extraArgs: [], hookAuthFile: 'C:/hive/hook-auth/x.txt', privateDir: `${project}-private` } as never)
    const copy = join(project, '.combwork', 'launch-a1', 'plugin', 'skills', 'claude-skill')
    for (const f of PLAIN) expect(readFileSync(join(copy, f), 'utf8').length, f).toBeGreaterThan(0)
    expect(delivered['claude-skill']).toEqual({ revision: await contentHash(copy), problem: expect.any(String), lasting: true })
    for (const f of DENIED) expect(delivered['claude-skill'].problem, f).toContain(f)
  })

  it("Codex: a copy missing a link never replaces the old one, which stays whole; a first copy isn't half made", async () => {
    const cwd = join(base, 'codex')
    const src = join(base, 'sources', 'codex-skill')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), 'v1')
    const sync = (ctx: unknown) => syncAgentsSkills(ctx as never, 'Codex')
    await sync({ cwd, skills: [{ name: 'codex-skill', sourcePath: src }] })
    const copy = join(cwd, '.agents', 'skills', 'cw-codex-skill')
    const v1 = await contentHash(copy)
    // The skill gains a link Combwork can't make, and a new SKILL.md.
    writeFileSync(join(src, 'SKILL.md'), 'v2')
    symlinkSync(target, join(src, 'denied-ref'), 'junction')
    const out = await sync({ cwd, skills: [{ name: 'codex-skill', sourcePath: src }] })
    expect(out['codex-skill']).toEqual({ revision: v1, problem: expect.stringContaining('denied-ref'), lasting: true })
    expect(readFileSync(join(copy, 'SKILL.md'), 'utf8')).toBe('v1')
    expect(readdirSync(join(cwd, '.agents', 'skills'))).toEqual(['cw-codex-skill'])
    // A skill it never had: nothing rather than a copy missing part of it.
    const other = skill('codex-new')
    const first = await sync({ cwd, skills: [{ name: 'codex-skill', sourcePath: src }, { name: 'codex-new', sourcePath: other }] })
    expect(first['codex-new']).toMatchObject({ revision: null, lasting: true })
    expect(existsSync(join(cwd, '.agents', 'skills', 'cw-codex-new'))).toBe(false)
  })
})
