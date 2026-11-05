// Claude Code's launch folder keeps the last launch's skill copies while each is still its source's content (HI-1694): a
// launch copied every skill again, which took 6 s on a drive a virus scanner watches. What changed is copied again, a
// copy changed in the launch folder is put back, a skill no longer given goes, and the rest of the folder is written anew.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const { contentHash } = await import('../src/main/fsutil')
const { claudeCode } = await import('../src/main/providers/claude/adapter')

type Delivery = { revision: string | null; problem?: string }
const base = tempDir('cw-claude-launch-skills-')

function source(name: string, text: string): string {
  const d = join(base, 'sources', name)
  mkdirSync(join(d, 'references'), { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${text}. Use when testing.\n---\n`)
  writeFileSync(join(d, 'references', 'notes.md'), text)
  return d
}

describe("Claude Code's launch: the skills' copies", () => {
  const project = join(base, 'project')
  mkdirSync(project, { recursive: true })
  const launch = (skills: { name: string; sourcePath: string }[]) =>
    claudeCode.prepareLaunch({ projectPath: project, agentId: 'a1', cwd: project, skills, mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, extraArgs: [], hookAuthFile: 'C:/hive/hook-auth/x.txt', privateDir: `${project}-private` } as never) as Promise<Record<string, Delivery>>
  const copy = (name: string): string => join(claudeCode.launchDir(project, 'a1'), 'plugin', 'skills', name)
  /** When a copy's file was made: a copy kept keeps it, a copy made again has a new one. */
  const born = (name: string): number => statSync(join(copy(name), 'SKILL.md')).birthtimeMs

  it('keeps an unchanged copy, copies a changed source again, puts back a copy changed in place, and removes one no longer given', async () => {
    const one = source('one', 'First')
    const two = source('two', 'Second')
    const three = source('three', 'Third')
    const first = await launch([{ name: 'one', sourcePath: one }, { name: 'two', sourcePath: two }, { name: 'three', sourcePath: three }])
    for (const [n, s] of [['one', one], ['two', two], ['three', three]]) expect(first[n]).toEqual({ revision: await contentHash(s) })
    const was = { one: born('one'), two: born('two'), three: born('three') }
    // Something left in the folder from before (a file only that launch had) goes; the skills' copies stay.
    writeFileSync(join(claudeCode.launchDir(project, 'a1'), 'instructions.md'), 'from the last launch')

    writeFileSync(join(two, 'references', 'notes.md'), 'Second, edited')
    writeFileSync(join(copy('three'), 'references', 'notes.md'), 'changed in the launch folder')
    const again = await launch([{ name: 'one', sourcePath: one }, { name: 'two', sourcePath: two }, { name: 'three', sourcePath: three }])
    expect(born('one')).toBe(was.one)
    expect(again.one).toEqual({ revision: await contentHash(one) })
    expect(readFileSync(join(copy('two'), 'references', 'notes.md'), 'utf8')).toBe('Second, edited')
    expect(again.two).toEqual({ revision: await contentHash(two) })
    expect(readFileSync(join(copy('three'), 'references', 'notes.md'), 'utf8')).toBe('Third')
    expect(again.three).toEqual({ revision: await contentHash(three) })
    expect(existsSync(join(claudeCode.launchDir(project, 'a1'), 'instructions.md'))).toBe(false)

    const last = await launch([{ name: 'one', sourcePath: one }])
    expect(Object.keys(last)).toEqual(['one'])
    expect(born('one')).toBe(was.one)
    expect(existsSync(copy('two'))).toBe(false)
    expect(existsSync(copy('three'))).toBe(false)
    expect(existsSync(join(claudeCode.launchDir(project, 'a1'), 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true)
  })
})
