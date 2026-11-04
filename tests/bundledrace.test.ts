// An automatic update of a bundled skill or mode never overwrites the user: a copy edited, deleted or replaced after
// Hive decided to update it (while the new version is being copied, after the old one is moved aside, or through a file
// left open until after the new one is in place) stays as the user has it, the update is abandoned, and the manifest
// isn't told it happened. Other items still update. What a crash in a swap left is removed only when it is a version
// Hive shipped; anything else is kept as a visible "-conflict-" copy. The races are made deterministic by hooks in
// fs/promises: `onCopy` runs before the first file of a swap's copy is written (opened for writing), `afterRename` after a rename.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const hooks: { onCopy: null | (() => void | Promise<void>); afterRename: null | ((from: string, to: string) => boolean | Promise<boolean>); failRename: null | ((from: string, to: string) => boolean) } = { onCopy: null, afterRename: null, failRename: null }
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  return {
    ...real,
    // A swap's copy writes each file into its staging place (a .hive-new- name): the hook runs before the first.
    open: async (path: string, flags?: string, mode?: number) => {
      const h = hooks.onCopy
      if (h && flags === 'w' && /\.hive-new-/.test(String(path))) {
        hooks.onCopy = null
        await h()
      }
      return real.open(path, flags, mode)
    },
    rename: async (from: string, to: string) => {
      // A rename Windows refuses (a file in it open): every try, while the hook says so.
      if (hooks.failRename?.(String(from), String(to))) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' })
      await real.rename(from, to)
      // A hook returning true has had its turn.
      if (hooks.afterRename && (await hooks.afterRename(String(from), String(to)))) hooks.afterRename = null
    }
  }
})

const RES = join(__dirname, '..', 'resources')
const base = tempDir('hive-bundled-race-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
afterAll(() => rmSync(base, { recursive: true, force: true }))

const OLD_HANDOVER = '---\nname: handover\ndescription: An older handover skill.\n---\n\nOld text.\n'
const OLD_PLANNER = '---\nname: Planner\ndescription: An older planner.\n---\n\nOld planner.\n'
let mod: typeof import('../src/main/bundled')
let wsMod: typeof import('../src/main/workspace')
let fsutil: typeof import('../src/main/fsutil')
let oldSkill = ''
let oldMode = ''
const OLD_OVERSEER = '---\nname: Overseer\ndescription: A lighthouse keeper.\n---\n\nYou keep the light.\n'
let retiredHash = ''

beforeAll(async () => {
  fsutil = await import('../src/main/fsutil')
  const old = join(base, 'old')
  mkdirSync(join(old, 'handover'), { recursive: true })
  writeFileSync(join(old, 'handover', 'SKILL.md'), OLD_HANDOVER)
  writeFileSync(join(old, 'planner.md'), OLD_PLANNER)
  oldSkill = await fsutil.contentHash(join(old, 'handover'))
  oldMode = await fsutil.contentHash(join(old, 'planner.md'))
  const HISTORY = (await import('../src/main/bundledHistory.json')).default as Record<'skills' | 'modes', Record<string, string[]>>
  const history = structuredClone(HISTORY)
  history.skills.handover = [oldSkill, ...history.skills.handover]
  history.modes.planner = [oldMode, ...history.modes.planner]
  // An Overseer Hive shipped before working modes retired it (#259).
  writeFileSync(join(old, 'overseer.md'), OLD_OVERSEER)
  retiredHash = await fsutil.contentHash(join(old, 'overseer.md'))
  history.modes.overseer = [...(history.modes.overseer ?? []), retiredHash]
  vi.doMock('../src/main/bundledHistory.json', () => ({ default: history }))
  mod = await import('../src/main/bundled')
  wsMod = await import('../src/main/workspace')
})
beforeEach(() => {
  hooks.onCopy = null
  hooks.afterRename = null
  hooks.failRename = null
})

/** The user's work kept beside an item as a conflict copy: its file's text (a skill's SKILL.md, a mode itself). */
const conflictText = (dir: string, prefix: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-conflict-`))
    .map((f) => (f.endsWith('.md') ? readFileSync(join(dir, f), 'utf8') : readFileSync(join(dir, f, 'SKILL.md'), 'utf8')))

let n = 0
/** A workspace with every bundled item, then the handover skill and planner mode set back to the older version. */
async function older(): Promise<{ ws: string; w: ReturnType<typeof wsMod.createWorkspaceService>; skill: string; mode: string; sync: () => Promise<void>; from: (kind: 'skills' | 'modes', id: string) => string | null }> {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(ws, { recursive: true })
  const w = wsMod.createWorkspaceService()
  await w.open(ws)
  await wsMod.inWorkspace(w, () => mod.syncBundled({ fresh: true }))
  const skill = join(ws, '.combwork', 'skills', 'handover')
  const mode = join(ws, '.combwork', 'modes', 'planner.md')
  rmSync(skill, { recursive: true, force: true })
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), OLD_HANDOVER)
  writeFileSync(mode, OLD_PLANNER)
  const manifest = join(ws, '.combwork', 'bundled.json')
  const m = JSON.parse(readFileSync(manifest, 'utf8'))
  m.skills.handover = { from: oldSkill }
  m.modes.planner = { from: oldMode }
  writeFileSync(manifest, JSON.stringify(m))
  return {
    ws,
    w,
    skill,
    mode,
    sync: () => wsMod.inWorkspace(w, () => mod.syncBundled()),
    from: (kind, id) => JSON.parse(readFileSync(manifest, 'utf8'))[kind][id]?.from ?? null
  }
}

/** Hive's swap leftovers (dot-names) in a folder: there should be none once a sync is over. */
const leftovers = (dir: string): string[] => readdirSync(dir).filter((f) => /\.hive-(new|old|back)-/.test(f))

describe('a skill changed while Hive updates it', () => {
  it('edited while the new version is copied: the edit stays, the update is abandoned', async () => {
    const t = await older()
    hooks.onCopy = () => writeFileSync(join(t.skill, 'SKILL.md'), OLD_HANDOVER + 'MY EDIT\n')
    await t.sync()
    expect(readFileSync(join(t.skill, 'SKILL.md'), 'utf8')).toBe(OLD_HANDOVER + 'MY EDIT\n')
    expect(t.from('skills', 'handover')).toBe(oldSkill)
    const status = await wsMod.inWorkspace(t.w, () => mod.bundledStatus('skills', 'handover', t.skill))
    expect(status.bundled).toBe('changed')
    expect(leftovers(join(t.ws, '.combwork', 'skills'))).toEqual([])
    // The mode, unchanged meanwhile, was updated.
    expect(readFileSync(t.mode, 'utf8')).toBe(readFileSync(join(RES, 'modes', 'planner.md'), 'utf8'))
    expect(t.from('modes', 'planner')).toBe(await fsutil.contentHash(join(RES, 'modes', 'planner.md')))
    await wsMod.disposeWorkspaceService(t.w)
  })

  it('deleted while the new version is copied: it stays deleted', async () => {
    const t = await older()
    hooks.onCopy = () => rmSync(t.skill, { recursive: true, force: true })
    await t.sync()
    expect(existsSync(t.skill)).toBe(false)
    expect(t.from('skills', 'handover')).toBe(oldSkill)
    await wsMod.disposeWorkspaceService(t.w)
  })

  it("replaced by a folder of the user's while the new version is copied: theirs stays", async () => {
    const t = await older()
    hooks.onCopy = () => {
      rmSync(t.skill, { recursive: true, force: true })
      mkdirSync(t.skill)
      writeFileSync(join(t.skill, 'SKILL.md'), 'MINE')
    }
    await t.sync()
    expect(readdirSync(t.skill)).toEqual(['SKILL.md'])
    expect(readFileSync(join(t.skill, 'SKILL.md'), 'utf8')).toBe('MINE')
    expect(t.from('skills', 'handover')).toBe(oldSkill)
    await wsMod.disposeWorkspaceService(t.w)
  })

  it('written to after it was moved aside (a file left open): put back as the user has it', async () => {
    const t = await older()
    hooks.afterRename = (from, to) => {
      if (from.toLowerCase() !== t.skill.toLowerCase() || !/\.hive-old-/.test(to)) return false
      writeFileSync(join(to, 'SKILL.md'), OLD_HANDOVER + 'LATE EDIT\n')
      return true
    }
    await t.sync()
    expect(readFileSync(join(t.skill, 'SKILL.md'), 'utf8')).toBe(OLD_HANDOVER + 'LATE EDIT\n')
    expect(t.from('skills', 'handover')).toBe(oldSkill)
    expect(leftovers(join(t.ws, '.combwork', 'skills'))).toEqual([])
    await wsMod.disposeWorkspaceService(t.w)
  })

  it('written to after the new version went in (a file left open): the user’s version wins', async () => {
    const t = await older()
    let old = ''
    hooks.afterRename = (from, to) => {
      if (from.toLowerCase() === t.skill.toLowerCase() && /\.hive-old-/.test(to)) old = to
      if (!old || !/\.hive-new-/.test(from) || to.toLowerCase() !== t.skill.toLowerCase()) return false
      writeFileSync(join(old, 'SKILL.md'), OLD_HANDOVER + 'LATEST EDIT\n')
      return true
    }
    await t.sync()
    expect(readFileSync(join(t.skill, 'SKILL.md'), 'utf8')).toBe(OLD_HANDOVER + 'LATEST EDIT\n')
    expect(t.from('skills', 'handover')).toBe(oldSkill)
    expect(leftovers(join(t.ws, '.combwork', 'skills'))).toEqual([])
    await wsMod.disposeWorkspaceService(t.w)
  })

  it('both copies edited (the old through an open file, the new one too) before the last check: neither edit is lost', async () => {
    const t = await older()
    let old = ''
    hooks.afterRename = (from, to) => {
      if (from.toLowerCase() === t.skill.toLowerCase() && /\.hive-old-/.test(to)) old = to
      if (!old || !/\.hive-new-/.test(from) || to.toLowerCase() !== t.skill.toLowerCase()) return false
      writeFileSync(join(old, 'SKILL.md'), 'OLD COPY EDIT')
      writeFileSync(join(t.skill, 'SKILL.md'), 'NEW COPY USER EDIT')
      return true
    }
    await t.sync()
    expect(readFileSync(join(t.skill, 'SKILL.md'), 'utf8')).toBe('OLD COPY EDIT')
    expect(conflictText(join(t.ws, '.combwork', 'skills'), 'handover')).toEqual(['NEW COPY USER EDIT'])
    expect(t.from('skills', 'handover')).toBe(oldSkill)
    expect(leftovers(join(t.ws, '.combwork', 'skills'))).toEqual([])
    await wsMod.disposeWorkspaceService(t.w)
  })

  it("the rollback's renames refused: nothing is deleted, the edited copy is kept beside the item", async () => {
    // Moving the new version out is refused: it stays, and the user's edited old copy is kept as a conflict copy.
    let t = await older()
    let old = ''
    const editOldAfterPublish = (from: string, to: string): boolean => {
      if (from.toLowerCase() === t.skill.toLowerCase() && /\.hive-old-/.test(to)) old = to
      if (!old || !/\.hive-new-/.test(from) || to.toLowerCase() !== t.skill.toLowerCase()) return false
      writeFileSync(join(old, 'SKILL.md'), 'EDITED OLD')
      return true
    }
    hooks.afterRename = editOldAfterPublish
    hooks.failRename = (from, to) => from.toLowerCase() === t.skill.toLowerCase() && /\.hive-back-/.test(to)
    await t.sync()
    expect(conflictText(join(t.ws, '.combwork', 'skills'), 'handover')).toEqual(['EDITED OLD'])
    expect(existsSync(join(t.skill, 'SKILL.md'))).toBe(true)
    expect(t.from('skills', 'handover')).toBe(oldSkill)
    expect(leftovers(join(t.ws, '.combwork', 'skills'))).toEqual([])
    await wsMod.disposeWorkspaceService(t.w)

    // Putting the user's old copy back is refused: the new version goes back in place, and the old copy is kept beside.
    t = await older()
    old = ''
    hooks.afterRename = editOldAfterPublish
    hooks.failRename = (from, to) => /\.hive-old-/.test(from) && to.toLowerCase() === t.skill.toLowerCase()
    await t.sync()
    expect(conflictText(join(t.ws, '.combwork', 'skills'), 'handover')).toEqual(['EDITED OLD'])
    expect(await fsutil.contentHash(t.skill)).toBe(await fsutil.contentHash(join(RES, 'skills', 'handover')))
    expect(t.from('skills', 'handover')).toBe(oldSkill)
    expect(leftovers(join(t.ws, '.combwork', 'skills'))).toEqual([])
    await wsMod.disposeWorkspaceService(t.w)
  }, 30_000)

  it('an untouched old copy still updates, as before', async () => {
    const t = await older()
    await t.sync()
    expect(await fsutil.contentHash(t.skill)).toBe(await fsutil.contentHash(join(RES, 'skills', 'handover')))
    expect(t.from('skills', 'handover')).toBe(await fsutil.contentHash(join(RES, 'skills', 'handover')))
    await wsMod.disposeWorkspaceService(t.w)
  })
})

describe('a retired persona changed while Hive removes it (#259)', () => {
  /** A workspace holding Hive's untouched old Overseer, which its Assistant chose. */
  async function retiring() {
    const t = await older()
    const mode = join(t.ws, '.combwork', 'modes', 'overseer.md')
    writeFileSync(mode, OLD_OVERSEER)
    mkdirSync(join(t.ws, '.combwork', 'assistant', '.combwork'), { recursive: true })
    writeFileSync(join(t.ws, '.combwork', 'assistant', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'assistant', name: 'Assistant', mode: 'overseer' }] }))
    const chosen = async () => (await wsMod.inWorkspace(t.w, () => t.w.projectConfig(t.w.assistantHome))).agents.find((a) => a.id === 'assistant')?.mode
    return { ...t, retired: mode, chosen }
  }
  const movedAside = (to: string) => /\.overseer\.md\.hive-old-/.test(to)

  it('untouched: it goes, and the Assistant moves to Coordinator', async () => {
    const t = await retiring()
    await t.sync()
    expect(existsSync(t.retired)).toBe(false)
    expect(await t.chosen()).toBe('coordinator')
    expect(leftovers(join(t.ws, '.combwork', 'modes'))).toEqual([])
  })

  it('written to through a file held open once it is moved aside: the edit is put back, and the choice stays', async () => {
    const t = await retiring()
    hooks.afterRename = (_from, to) => {
      if (!movedAside(to)) return false
      writeFileSync(to, `${OLD_OVERSEER}USER EDIT\n`)
      return true
    }
    await t.sync()
    expect(readFileSync(t.retired, 'utf8')).toContain('USER EDIT')
    expect(await t.chosen()).toBe('overseer')
    expect(leftovers(join(t.ws, '.combwork', 'modes'))).toEqual([])
  })

  it('replaced and the old one edited meanwhile: the new one stays, the edited one is kept as a conflict copy', async () => {
    const t = await retiring()
    hooks.afterRename = (from, to) => {
      if (!movedAside(to)) return false
      writeFileSync(from, 'USER NEW OVERSEER\n')
      writeFileSync(to, `${OLD_OVERSEER}USER EDIT\n`)
      return true
    }
    await t.sync()
    expect(readFileSync(t.retired, 'utf8')).toBe('USER NEW OVERSEER\n')
    expect(conflictText(join(t.ws, '.combwork', 'modes'), 'overseer').join('')).toContain('USER EDIT')
    expect(await t.chosen()).toBe('overseer')
  })

  it('replaced by the user while it was being removed: theirs stays, and so does the choice of it', async () => {
    const t = await retiring()
    hooks.afterRename = (from, to) => {
      if (!movedAside(to)) return false
      writeFileSync(from, 'USER NEW OVERSEER\n')
      return true
    }
    await t.sync()
    expect(readFileSync(t.retired, 'utf8')).toBe('USER NEW OVERSEER\n')
    expect(await t.chosen()).toBe('overseer')
    expect(leftovers(join(t.ws, '.combwork', 'modes'))).toEqual([])
  })

  it('changed after Hive decided to remove it: swapOut leaves it as it is', async () => {
    const t = await retiring()
    writeFileSync(t.retired, `${OLD_OVERSEER}USER EDIT\n`)
    // As retirement does, with the hash it decided on.
    await expect(fsutil.swapOut(t.retired, retiredHash)).rejects.toBeInstanceOf(fsutil.SwapAbandoned)
    expect(readFileSync(t.retired, 'utf8')).toContain('USER EDIT')
    expect(leftovers(join(t.ws, '.combwork', 'modes'))).toEqual([])
  })
})

describe('a skill made while Hive adds it', () => {
  it("a folder of the user's with the name, made while the new skill is copied: theirs stays", async () => {
    const t = await older()
    const coord = join(t.ws, '.combwork', 'skills', 'coordinate-agents')
    rmSync(coord, { recursive: true, force: true })
    // Never given: the manifest doesn't have it, so Hive adds it.
    const manifest = join(t.ws, '.combwork', 'bundled.json')
    const m = JSON.parse(readFileSync(manifest, 'utf8'))
    delete m.skills['coordinate-agents']
    m.skills.handover = { from: await fsutil.contentHash(join(RES, 'skills', 'handover')) }
    writeFileSync(manifest, JSON.stringify(m))
    cpSync(join(RES, 'skills', 'handover'), t.skill, { recursive: true, force: true })
    hooks.onCopy = () => {
      mkdirSync(coord, { recursive: true })
      writeFileSync(join(coord, 'SKILL.md'), 'MINE')
    }
    await t.sync()
    expect(readFileSync(join(coord, 'SKILL.md'), 'utf8')).toBe('MINE')
    expect(t.from('skills', 'coordinate-agents')).toBeNull()
    await wsMod.disposeWorkspaceService(t.w)
  })
})

describe('a mode changed while Hive updates it', () => {
  const onlyMode = async (t: Awaited<ReturnType<typeof older>>): Promise<void> => {
    // The skill current, so the mode's swap is the first copy.
    cpSync(join(RES, 'skills', 'handover'), t.skill, { recursive: true, force: true })
    const manifest = join(t.ws, '.combwork', 'bundled.json')
    const m = JSON.parse(readFileSync(manifest, 'utf8'))
    m.skills.handover = { from: await fsutil.contentHash(join(RES, 'skills', 'handover')) }
    writeFileSync(manifest, JSON.stringify(m))
  }

  it('edited while the new version is copied: the edit stays', async () => {
    const t = await older()
    await onlyMode(t)
    hooks.onCopy = () => writeFileSync(t.mode, OLD_PLANNER + 'MY EDIT\n')
    await t.sync()
    expect(readFileSync(t.mode, 'utf8')).toBe(OLD_PLANNER + 'MY EDIT\n')
    expect(t.from('modes', 'planner')).toBe(oldMode)
    expect(leftovers(join(t.ws, '.combwork', 'modes'))).toEqual([])
    await wsMod.disposeWorkspaceService(t.w)
  })

  it('deleted, or written to after it was moved aside: the user’s state stays', async () => {
    let t = await older()
    await onlyMode(t)
    hooks.onCopy = () => rmSync(t.mode)
    await t.sync()
    expect(existsSync(t.mode)).toBe(false)
    expect(t.from('modes', 'planner')).toBe(oldMode)
    await wsMod.disposeWorkspaceService(t.w)

    t = await older()
    await onlyMode(t)
    hooks.afterRename = (from, to) => {
      if (from.toLowerCase() !== t.mode.toLowerCase() || !/\.hive-old-/.test(to)) return false
      writeFileSync(to, OLD_PLANNER + 'LATE EDIT\n')
      return true
    }
    await t.sync()
    expect(readFileSync(t.mode, 'utf8')).toBe(OLD_PLANNER + 'LATE EDIT\n')
    expect(t.from('modes', 'planner')).toBe(oldMode)
    await wsMod.disposeWorkspaceService(t.w)
  })
})

describe('a mode edited twice while Hive updates it', () => {
  it('the old copy through an open file and the new one: neither edit is lost', async () => {
    const t = await older()
    cpSync(join(RES, 'skills', 'handover'), t.skill, { recursive: true, force: true })
    const manifest = join(t.ws, '.combwork', 'bundled.json')
    const m = JSON.parse(readFileSync(manifest, 'utf8'))
    m.skills.handover = { from: await fsutil.contentHash(join(RES, 'skills', 'handover')) }
    writeFileSync(manifest, JSON.stringify(m))
    let old = ''
    hooks.afterRename = (from, to) => {
      if (from.toLowerCase() === t.mode.toLowerCase() && /\.hive-old-/.test(to)) old = to
      if (!old || !/\.hive-new-/.test(from) || to.toLowerCase() !== t.mode.toLowerCase()) return false
      writeFileSync(old, 'OLD MODE EDIT')
      writeFileSync(t.mode, 'NEW MODE EDIT')
      return true
    }
    await t.sync()
    expect(readFileSync(t.mode, 'utf8')).toBe('OLD MODE EDIT')
    expect(conflictText(join(t.ws, '.combwork', 'modes'), 'planner')).toEqual(['NEW MODE EDIT'])
    expect(t.from('modes', 'planner')).toBe(oldMode)
    expect(leftovers(join(t.ws, '.combwork', 'modes'))).toEqual([])
    await wsMod.disposeWorkspaceService(t.w)
  })
})

describe('after a crash in a swap', () => {
  it("a crash between the rollback's two renames: the user's original goes back in place, the edited backup is kept", async () => {
    const t = await older()
    const skills = join(t.ws, '.combwork', 'skills')
    rmSync(t.skill, { recursive: true, force: true })
    mkdirSync(join(skills, '.handover.hive-old-1-5'))
    writeFileSync(join(skills, '.handover.hive-old-1-5', 'SKILL.md'), 'ORIGINAL USER EDIT')
    mkdirSync(join(skills, '.handover.hive-back-1-5'))
    writeFileSync(join(skills, '.handover.hive-back-1-5', 'SKILL.md'), 'BACKUP USER EDIT')
    // A backup that is just a version Hive shipped is Hive's: removed.
    cpSync(join(RES, 'skills', 'pick-up'), join(skills, '.pick-up.hive-back-1-6'), { recursive: true })
    await t.sync()
    expect(readFileSync(join(t.skill, 'SKILL.md'), 'utf8')).toBe('ORIGINAL USER EDIT')
    expect(conflictText(skills, 'handover')).toEqual(['BACKUP USER EDIT'])
    expect(existsSync(join(skills, '.pick-up.hive-back-1-6'))).toBe(false)
    expect(leftovers(skills)).toEqual([])
    await wsMod.disposeWorkspaceService(t.w)
  })

  it("removes an old copy that is a shipped version, and keeps one that isn't as a visible conflict copy", async () => {
    const t = await older()
    const skills = join(t.ws, '.combwork', 'skills')
    const modes = join(t.ws, '.combwork', 'modes')
    // handover in place, with an old copy beside it that the user had edited; pick-up's old copy is Hive's own.
    mkdirSync(join(skills, '.handover.hive-old-1-1'))
    writeFileSync(join(skills, '.handover.hive-old-1-1', 'SKILL.md'), 'USER WORK')
    cpSync(join(RES, 'skills', 'pick-up'), join(skills, '.pick-up.hive-old-1-2'), { recursive: true })
    writeFileSync(join(modes, '.planner.md.hive-old-1-3'), 'USER MODE WORK')
    await t.sync()
    const conflict = readdirSync(skills).find((f) => f.startsWith('handover-conflict-'))
    expect(conflict).toBeDefined()
    expect(readFileSync(join(skills, conflict!, 'SKILL.md'), 'utf8')).toBe('USER WORK')
    expect(existsSync(join(skills, '.pick-up.hive-old-1-2'))).toBe(false)
    const modeConflict = readdirSync(modes).find((f) => /^planner-conflict-.*\.md$/.test(f))
    expect(modeConflict && readFileSync(join(modes, modeConflict), 'utf8')).toBe('USER MODE WORK')
    expect(leftovers(skills)).toEqual([])
    expect(leftovers(modes)).toEqual([])
    await wsMod.disposeWorkspaceService(t.w)
  })
})
