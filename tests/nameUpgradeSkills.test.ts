// HI-2611: a bundled skill Hive shipped under its old name (use-hive-api, now use-cw-api, HI-2463) is removed by the
// names upgrade's files step (nameUpgradeFiles.ts retireRenamedSkills), not by every sync of the bundled items: a copy
// Hive shipped, unchanged, goes with its entry in bundled.json; one the user changed stays; a second run does nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { contentHash } from '../src/main/fsutil'
import HISTORY from '../src/main/bundledHistory.json'
import { tempDir } from './tempDir'

const OLD = "---\nname: use-hive-api\ndescription: Hive's HTTP API.\n---\n\nAs shipped.\n"
const base = tempDir('nameupgrade-skills-')
let mod: typeof import('../src/main/nameUpgradeFiles')

beforeAll(async () => {
  // The history this Combwork "shipped": the old skill as above.
  const shipped = join(base, 'shipped', 'use-hive-api')
  mkdirSync(shipped, { recursive: true })
  writeFileSync(join(shipped, 'SKILL.md'), OLD)
  const history = structuredClone(HISTORY) as Record<string, Record<string, string[]>>
  history.skills['use-hive-api'] = [...(history.skills['use-hive-api'] ?? []), await contentHash(shipped)]
  vi.resetModules()
  vi.doMock('../src/main/bundledHistory.json', () => ({ default: history }))
  mod = await import('../src/main/nameUpgradeFiles')
})

let n = 0
/** A workspace's `.combwork` with the old skill's copy (`text`) and a bundled.json that lists it. */
function workspace(text: string): string {
  const dir = join(base, `ws-${++n}`, '.combwork')
  mkdirSync(join(dir, 'skills', 'use-hive-api'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'use-hive-api', 'SKILL.md'), text)
  writeFileSync(join(dir, 'bundled.json'), JSON.stringify({ skills: { 'use-hive-api': { from: 'x' }, handover: { from: 'y' } }, modes: {}, dialects: {} }))
  return dir
}
const manifest = (dir: string): { skills: Record<string, unknown> } => JSON.parse(readFileSync(join(dir, 'bundled.json'), 'utf8'))

describe('a skill Hive shipped under its old name, retired by the names upgrade (HI-2611)', () => {
  it('names the old skill and the one it ships as', () => {
    expect(mod.RENAMED_SKILLS).toEqual({ 'use-hive-api': 'use-cw-api' })
  })

  it("removes a copy Hive shipped, unchanged, and its manifest entry; a second run does nothing", async () => {
    const dir = workspace(OLD)
    expect(await mod.retireRenamedSkills(dir)).toBe(true)
    expect(existsSync(join(dir, 'skills', 'use-hive-api'))).toBe(false)
    expect(manifest(dir).skills).toEqual({ handover: { from: 'y' } })
    const before = readFileSync(join(dir, 'bundled.json'), 'utf8')
    expect(await mod.retireRenamedSkills(dir)).toBe(true)
    expect(readFileSync(join(dir, 'bundled.json'), 'utf8')).toBe(before)
  })

  it('keeps a copy the user changed, and its entry', async () => {
    const dir = workspace(`${OLD}\nMy own notes.\n`)
    expect(await mod.retireRenamedSkills(dir)).toBe(true)
    expect(readFileSync(join(dir, 'skills', 'use-hive-api', 'SKILL.md'), 'utf8')).toContain('My own notes.')
    expect(manifest(dir).skills['use-hive-api']).toEqual({ from: 'x' })
  })

  it('does nothing in a workspace without it', async () => {
    const dir = join(base, `ws-${++n}`, '.combwork')
    mkdirSync(dir, { recursive: true })
    expect(await mod.retireRenamedSkills(dir)).toBe(true)
    expect(existsSync(join(dir, 'bundled.json'))).toBe(false)
  })
})
