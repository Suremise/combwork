// HI-2611: a bundled skill 1.0 shipped under its old name (now use-cw-api, HI-2463) is removed by the
// names upgrade's files step (nameUpgradeFiles.ts retireRenamedSkills), not by every sync of the bundled items: a copy
// 1.0 shipped, unchanged, goes with its entry in bundled.json; one the user changed stays; a second run does nothing.
// Only a confirmed absence is gone: a copy or manifest it couldn't look at is left, unsettled, for the next open (HR1's
// round 1). And a workspace an RC recorded done (version 3) runs it at its next open, once. swapOut's later checks
// failing to read (SwapUnreadable, HI-2612), or a copy an earlier run left set aside, never record it done (HR2).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { contentHash } from '../src/main/fsutil'
import HISTORY from '../src/main/bundledHistory.json'
import { tempDir } from './tempDir'

/** Paths matching a pattern whose calls (`call`'s alone, when named) fail once `pass` of them have gone through. */
const faults: { match: { test: (p: string) => boolean }; code: string; pass: number; call?: string; arms?: () => void }[] = []
const failing = (p: unknown, call: string): string | undefined => {
  const f = faults.find((x) => x.match.test(String(p)) && (!x.call || x.call === call))
  if (!f) return undefined
  if (f.pass > 0) return void f.pass--
  // Its first failure arms what follows from it (a later look failing too).
  const arms = f.arms
  f.arms = undefined
  arms?.()
  return f.code
}

// old-name: begin nameUpgradeSkills-inputs
/** The skill 1.0 shipped under its old name, and its text as shipped: the upgrade's input. */
const SKILL = 'use-hive-api'
const OLD = "---\nname: use-hive-api\ndescription: Hive's HTTP API.\n---\n\nAs shipped.\n"
// old-name: end nameUpgradeSkills-inputs
const base = tempDir('nameupgrade-skills-')
let mod: typeof import('../src/main/nameUpgradeFiles')
let move: typeof import('../src/main/combworkMove')
let names: typeof import('../src/main/nameUpgrade')

beforeAll(async () => {
  // The history this Combwork "shipped": the old skill as above.
  const shipped = join(base, 'shipped', SKILL)
  mkdirSync(shipped, { recursive: true })
  writeFileSync(join(shipped, 'SKILL.md'), OLD)
  const history = structuredClone(HISTORY) as Record<string, Record<string, string[]>>
  history.skills[SKILL] = [...(history.skills[SKILL] ?? []), await contentHash(shipped)]
  vi.resetModules()
  vi.doMock('../src/main/bundledHistory.json', () => ({ default: history }))
  vi.doMock('original-fs/promises', async () => {
    const real = await import('fs/promises')
    const wrap = <F extends (...a: any[]) => Promise<any>>(fn: F, call: string): F =>
      ((p: unknown, ...rest: unknown[]) => {
        const code = failing(p, call)
        return code ? Promise.reject(Object.assign(new Error(`${code}: refused, '${String(p)}' (test)`), { code })) : fn(p, ...rest)
      }) as F
    return { ...real, default: real, open: wrap(real.open, 'open'), readFile: wrap(real.readFile, 'readFile'), lstat: wrap(real.lstat, 'lstat'), rename: wrap(real.rename, 'rename') }
  })
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
  mkdirSync(join(dir, 'skills', SKILL), { recursive: true })
  writeFileSync(join(dir, 'skills', SKILL, 'SKILL.md'), text)
  writeFileSync(join(dir, 'bundled.json'), JSON.stringify({ skills: { [SKILL]: { from: 'x' }, handover: { from: 'y' } }, modes: {}, dialects: {} }))
  return dir
}
const manifest = (dir: string): { skills: Record<string, unknown> } => JSON.parse(readFileSync(join(dir, 'bundled.json'), 'utf8'))

describe('a skill 1.0 shipped under its old name, retired by the names upgrade (HI-2611)', () => {
  it('names the old skill and the one it ships as', () => {
    expect(mod.RENAMED_SKILLS).toEqual({ [SKILL]: 'use-cw-api' })
  })

  it("removes a copy 1.0 shipped, unchanged, and its manifest entry; a second run does nothing", async () => {
    const dir = workspace(OLD)
    expect(await mod.retireRenamedSkills(dir)).toBe(true)
    expect(existsSync(join(dir, 'skills', SKILL))).toBe(false)
    expect(manifest(dir).skills).toEqual({ handover: { from: 'y' } })
    const before = readFileSync(join(dir, 'bundled.json'), 'utf8')
    expect(await mod.retireRenamedSkills(dir)).toBe(true)
    expect(readFileSync(join(dir, 'bundled.json'), 'utf8')).toBe(before)
  })

  it('keeps a copy the user changed, and its entry', async () => {
    const dir = workspace(`${OLD}\nMy own notes.\n`)
    expect(await mod.retireRenamedSkills(dir)).toBe(true)
    expect(readFileSync(join(dir, 'skills', SKILL, 'SKILL.md'), 'utf8')).toContain('My own notes.')
    expect(manifest(dir).skills[SKILL]).toEqual({ from: 'x' })
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
      expect(existsSync(join(dir, 'skills', SKILL))).toBe(true)
      expect(manifest(dir).skills[SKILL]).toEqual({ from: 'x' })
      expect(await mod.retireRenamedSkills(dir)).toBe(true)
      expect(existsSync(join(dir, 'skills', SKILL))).toBe(false)
      expect(manifest(dir).skills).toEqual({ handover: { from: 'y' } })
    }
  })

  it("a manifest it can't read is left as it is, unsettled; the next run drops the entry", async () => {
    const dir = workspace(OLD)
    expect(await mod.retireRenamedSkills(dir, { read: async () => denied() })).toBe(false)
    expect(existsSync(join(dir, 'skills', SKILL))).toBe(false)
    expect(manifest(dir).skills[SKILL]).toEqual({ from: 'x' })
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
    expect(existsSync(join(dir, 'skills', SKILL))).toBe(false)
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
    expect(existsSync(join(dir, 'skills', SKILL))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, names.NAMES_DONE_FILE), 'utf8')).version).toBe(names.NAMES_VERSION)
  })

  // swapOut checks the copy again as it removes it (before the rename, then twice once it is moved aside). A read failing
  // at any of those is put back, but isn't the user's change: the record stays at 3, and the next open retires it.
  // `pass`: the reads of SKILL.md let through before the failing one, at its place (the first is the hash) or aside.
  const LATER = [
    { check: 'the check before it moves', at: new RegExp(String.raw`[\\/]${SKILL}[\\/]SKILL\.md$`), pass: 1 },
    { check: 'the first check once moved aside', at: new RegExp(String.raw`\.${SKILL}\.cw-old-[^\\/]+[\\/]SKILL\.md$`), pass: 0 },
    { check: 'the last check once moved aside', at: new RegExp(String.raw`\.${SKILL}\.cw-old-[^\\/]+[\\/]SKILL\.md$`), pass: 1 }
  ]
  const record = (dir: string): number => JSON.parse(readFileSync(join(dir, names.NAMES_DONE_FILE), 'utf8')).version
  const atV3 = (): { dir: string; ws: string } => {
    const dir = workspace(OLD)
    writeFileSync(join(dir, names.NAMES_DONE_FILE), JSON.stringify({ version: 3 }))
    return { dir, ws: join(dir, '..') }
  }
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    for (const l of LATER) {
      it(`${code} at ${l.check}: put back, not recorded done; released, the next open retires it`, async () => {
        const { dir, ws } = atV3()
        faults.push({ match: l.at, code, pass: l.pass })
        try {
          await move.moveFolders(ws)
          expect(faults[0].pass).toBe(0)
        } finally {
          faults.length = 0
        }
        expect(readFileSync(join(dir, 'skills', SKILL, 'SKILL.md'), 'utf8')).toBe(OLD)
        expect(readdirSync(join(dir, 'skills'))).toEqual([SKILL])
        expect(manifest(dir).skills[SKILL]).toEqual({ from: 'x' })
        expect(record(dir)).toBe(3)
        expect(await names.workspaceNeeds(ws)).toBe(true)
        await move.moveFolders(ws)
        expect(readdirSync(join(dir, 'skills'))).toEqual([])
        expect(manifest(dir).skills).toEqual({ handover: { from: 'y' } })
        expect(record(dir)).toBe(names.NAMES_VERSION)
      })
    }
  }

  it('a copy an earlier run left set aside (its put-back failed): put back and retired before the record is written', async () => {
    const { dir, ws } = atV3()
    renameSync(join(dir, 'skills', SKILL), join(dir, 'skills', `.${SKILL}.cw-old-1-1`))
    await move.moveFolders(ws)
    expect(readdirSync(join(dir, 'skills'))).toEqual([])
    expect(manifest(dir).skills).toEqual({ handover: { from: 'y' } })
    expect(record(dir)).toBe(names.NAMES_VERSION)
  })

  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    it(`${code} putting back a copy an earlier run left set aside: nothing removed or recorded; released, the next open finishes`, async () => {
      const { dir, ws } = atV3()
      const aside = join(dir, 'skills', `.${SKILL}.cw-old-1-1`)
      renameSync(join(dir, 'skills', SKILL), aside)
      faults.push({ match: new RegExp(String.raw`\.${SKILL}\.cw-old-1-1$`), code, pass: 0, call: 'rename' })
      try {
        await move.moveFolders(ws)
      } finally {
        faults.length = 0
      }
      expect(readdirSync(join(dir, 'skills'))).toEqual([`.${SKILL}.cw-old-1-1`])
      expect(manifest(dir).skills[SKILL]).toEqual({ from: 'x' })
      expect(record(dir)).toBe(3)
      await move.moveFolders(ws)
      expect(readdirSync(join(dir, 'skills'))).toEqual([])
      expect(record(dir)).toBe(names.NAMES_VERSION)
    })
  }

  // HR2's round 4: the place filled with the user's own edit, and the shipped copy set aside by an earlier run. A failure
  // hashing that copy is no answer: it stays aside (never made a conflict copy no retry sees), nothing is recorded, and
  // once released the next open removes it, the user's copy untouched.
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    it(`${code} hashing a set-aside copy whose place the user's edit filled: left aside, not recorded; released, removed, the edit kept`, async () => {
      const { dir, ws } = atV3()
      const aside = join(dir, 'skills', `.${SKILL}.cw-old-1-1`)
      renameSync(join(dir, 'skills', SKILL), aside)
      const mine = `${OLD}\nMy own notes.\n`
      mkdirSync(join(dir, 'skills', SKILL))
      writeFileSync(join(dir, 'skills', SKILL, 'SKILL.md'), mine)
      faults.push({ match: new RegExp(String.raw`\.${SKILL}\.cw-old-1-1[\\/]SKILL\.md$`), code, pass: 0 })
      try {
        await move.moveFolders(ws)
        expect(faults[0].pass).toBe(0)
      } finally {
        faults.length = 0
      }
      expect(readdirSync(join(dir, 'skills')).sort()).toEqual([`.${SKILL}.cw-old-1-1`, SKILL])
      expect(readFileSync(join(aside, 'SKILL.md'), 'utf8')).toBe(OLD)
      expect(readFileSync(join(dir, 'skills', SKILL, 'SKILL.md'), 'utf8')).toBe(mine)
      expect(record(dir)).toBe(3)
      expect(await names.workspaceNeeds(ws)).toBe(true)
      await move.moveFolders(ws)
      expect(readdirSync(join(dir, 'skills'))).toEqual([SKILL])
      expect(readFileSync(join(dir, 'skills', SKILL, 'SKILL.md'), 'utf8')).toBe(mine)
      expect(manifest(dir).skills[SKILL]).toEqual({ from: 'x' })
      expect(record(dir)).toBe(names.NAMES_VERSION)
    })
  }

  // swapOut's put-back after a failed check: a look at the place that fails too leaves the copy aside (never a conflict
  // copy on a guess), not recorded; released, the next open puts it back and retires it.
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    it(`${code} looking at its place as a failed check puts it back: left aside, not recorded; released, retired`, async () => {
      const { dir, ws } = atV3()
      const place = join(dir, 'skills', SKILL)
      const atPlace = { test: (p: string): boolean => p.toLowerCase() === place.toLowerCase() }
      faults.push({ match: new RegExp(String.raw`\.${SKILL}\.cw-old-[^\\/]+[\\/]SKILL\.md$`), code, pass: 0, arms: () => void faults.push({ match: atPlace, code, pass: 0, call: 'lstat' }) })
      try {
        await move.moveFolders(ws)
        expect(faults).toHaveLength(2)
      } finally {
        faults.length = 0
      }
      const left = readdirSync(join(dir, 'skills'))
      expect(left).toHaveLength(1)
      expect(left[0]).toMatch(new RegExp(String.raw`^\.${SKILL}\.cw-old-`))
      expect(readFileSync(join(dir, 'skills', left[0], 'SKILL.md'), 'utf8')).toBe(OLD)
      expect(record(dir)).toBe(3)
      await move.moveFolders(ws)
      expect(readdirSync(join(dir, 'skills'))).toEqual([])
      expect(manifest(dir).skills).toEqual({ handover: { from: 'y' } })
      expect(record(dir)).toBe(names.NAMES_VERSION)
    })
  }
})
