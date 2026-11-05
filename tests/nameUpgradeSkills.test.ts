// HI-2611: a bundled skill Hive shipped under its old name (use-hive-api, now use-cw-api, HI-2463) is removed by the
// names upgrade's files step (nameUpgradeFiles.ts retireRenamedSkills), not by every sync of the bundled items: a copy
// Hive shipped, unchanged, goes with its entry in bundled.json; one the user changed stays; a second run does nothing.
// Only a confirmed absence is gone: a copy or manifest it couldn't look at is left, unsettled, for the next open (HR1's
// round 1). And a workspace an RC recorded done (version 3) runs it at its next open, once.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { contentHash } from '../src/main/fsutil'
import HISTORY from '../src/main/bundledHistory.json'
import { tempDir } from './tempDir'

const OLD = "---\nname: use-hive-api\ndescription: Hive's HTTP API.\n---\n\nAs shipped.\n"
const base = tempDir('nameupgrade-skills-')
let mod: typeof import('../src/main/nameUpgradeFiles')
let move: typeof import('../src/main/combworkMove')
let names: typeof import('../src/main/nameUpgrade')

beforeAll(async () => {
  // The history this Combwork "shipped": the old skill as above.
  const shipped = join(base, 'shipped', 'use-hive-api')
  mkdirSync(shipped, { recursive: true })
  writeFileSync(join(shipped, 'SKILL.md'), OLD)
  const history = structuredClone(HISTORY) as Record<string, Record<string, string[]>>
  history.skills['use-hive-api'] = [...(history.skills['use-hive-api'] ?? []), await contentHash(shipped)]
  vi.resetModules()
  vi.doMock('../src/main/bundledHistory.json', () => ({ default: history }))
  vi.doMock('../src/main/events', async (orig) => ({ ...(await orig<object>()), toast: () => undefined }))
  const electron = await import('electron')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  mod = await import('../src/main/nameUpgradeFiles')
  move = await import('../src/main/combworkMove')
  names = await import('../src/main/nameUpgrade')
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

  /** An error other than absence, as another program holding a file or access denied gives. */
  const denied = (): never => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
  }

  it("a copy it can't look at or hash is left with its entry, unsettled; the next run removes it", async () => {
    for (const ops of [{ lstat: async () => denied() }, { hash: async () => denied() }]) {
      const dir = workspace(OLD)
      expect(await mod.retireRenamedSkills(dir, ops)).toBe(false)
      expect(existsSync(join(dir, 'skills', 'use-hive-api'))).toBe(true)
      expect(manifest(dir).skills['use-hive-api']).toEqual({ from: 'x' })
      expect(await mod.retireRenamedSkills(dir)).toBe(true)
      expect(existsSync(join(dir, 'skills', 'use-hive-api'))).toBe(false)
      expect(manifest(dir).skills).toEqual({ handover: { from: 'y' } })
    }
  })

  it("a manifest it can't read is left as it is, unsettled; the next run drops the entry", async () => {
    const dir = workspace(OLD)
    expect(await mod.retireRenamedSkills(dir, { read: async () => denied() })).toBe(false)
    expect(existsSync(join(dir, 'skills', 'use-hive-api'))).toBe(false)
    expect(manifest(dir).skills['use-hive-api']).toEqual({ from: 'x' })
    expect(await mod.retireRenamedSkills(dir)).toBe(true)
    expect(manifest(dir).skills).toEqual({ handover: { from: 'y' } })
  })

  it('a workspace an RC recorded done (version 3) gets it at its next open, records the new version, and a second open changes nothing', async () => {
    expect(names.NAMES_VERSION).toBeGreaterThan(3)
    const dir = workspace(OLD)
    const ws = join(dir, '..')
    writeFileSync(join(dir, names.NAMES_DONE_FILE), JSON.stringify({ version: 3, at: '2026-11-01T00:00:00.000Z' }))
    expect(await names.workspaceNeeds(ws)).toBe(true)
    await move.moveFolders(ws)
    expect(existsSync(join(dir, 'skills', 'use-hive-api'))).toBe(false)
    expect(manifest(dir).skills).toEqual({ handover: { from: 'y' } })
    expect(JSON.parse(readFileSync(join(dir, names.NAMES_DONE_FILE), 'utf8')).version).toBe(names.NAMES_VERSION)
    expect(await names.workspaceNeeds(ws)).toBe(false)
    const before = readFileSync(join(dir, 'bundled.json'), 'utf8')
    await move.moveFolders(ws)
    expect(readFileSync(join(dir, 'bundled.json'), 'utf8')).toBe(before)
  })

  it('an open that cannot remove it now records nothing, and the next one finishes', async () => {
    const dir = workspace(OLD)
    const ws = join(dir, '..')
    writeFileSync(join(dir, names.NAMES_DONE_FILE), JSON.stringify({ version: 3 }))
    // A file in the copy held open: the swap's rename fails, as Windows fails it.
    const spy = vi.spyOn(mod, 'retireRenamedSkills').mockResolvedValueOnce(false)
    try {
      await move.moveFolders(ws)
    } finally {
      spy.mockRestore()
    }
    expect(JSON.parse(readFileSync(join(dir, names.NAMES_DONE_FILE), 'utf8')).version).toBe(3)
    await move.moveFolders(ws)
    expect(existsSync(join(dir, 'skills', 'use-hive-api'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, names.NAMES_DONE_FILE), 'utf8')).version).toBe(names.NAMES_VERSION)
  })
})
