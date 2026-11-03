import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseProfile, choiceLine } from '../src/main/profileFolders'
import { tempDir } from './tempDir'

// HI-2461: the app only chooses its profile folders (the installer moves them, HI-2460): Combwork's when it is there,
// Hive's as a fallback, never moving, locking or deleting; and after the installer's move, the sign-in check once.

const accounts = vi.hoisted(() => ({ list: [] as { id: string; name: string; kind?: string }[] }))
const toasts = vi.hoisted(() => [] as { level: string; title: string; message?: string }[])
vi.mock('../src/main/accounts', () => ({ hiveAccounts: () => accounts.list, isServer: (a: { kind?: string } | undefined) => a?.kind === 'server', checkAccount: async () => null }))
vi.mock('../src/main/events', () => ({ toast: (level: string, title: string, message?: string) => void toasts.push({ level, title, message }) }))
const { checkSignInsAfterMove, MOVE_RECORD } = await import('../src/main/profileNotices')

const tree = (parent: string): string[] => readdirSync(parent).sort()

describe('choosing the profile folder (HI-2461)', () => {
  it('a new install: neither is there, Combwork\'s is used (made as usual), and nothing is made here', () => {
    const p = tempDir('pf-fresh-')
    expect(chooseProfile(p, 'Hive', 'Combwork')).toEqual({ use: join(p, 'Combwork'), current: join(p, 'Combwork'), fallback: false })
    expect(tree(p)).toEqual([])
  })

  it("moved: Combwork's is used", () => {
    const p = tempDir('pf-current-')
    mkdirSync(join(p, 'Combwork'))
    expect(chooseProfile(p, 'Hive', 'Combwork')).toMatchObject({ use: join(p, 'Combwork'), fallback: false })
  })

  it("not moved yet: Hive's is used as the fallback, and left as it is", () => {
    const p = tempDir('pf-fallback-')
    mkdirSync(join(p, 'Hive'))
    writeFileSync(join(p, 'Hive', 'config.json'), '{}')
    const c = chooseProfile(p, 'Hive', 'Combwork')
    expect(c).toEqual({ use: join(p, 'Hive'), current: join(p, 'Combwork'), fallback: true })
    expect(choiceLine(c, (x) => x)).toContain("isn't there")
    expect(tree(p)).toEqual(['Hive'])
    expect(tree(join(p, 'Hive'))).toEqual(['config.json'])
  })

  it("both there: Combwork's is used, and Hive's is never touched", () => {
    const p = tempDir('pf-both-')
    mkdirSync(join(p, 'Combwork'))
    mkdirSync(join(p, 'Hive'))
    writeFileSync(join(p, 'Hive', 'kept.txt'), 'old')
    expect(chooseProfile(p, 'Hive', 'Combwork')).toMatchObject({ use: join(p, 'Combwork'), fallback: false })
    expect(readFileSync(join(p, 'Hive', 'kept.txt'), 'utf8')).toBe('old')
  })

  it("a file named like Combwork's folder: Hive's folder is used", () => {
    const p = tempDir('pf-file-')
    writeFileSync(join(p, 'Combwork'), 'not a folder')
    mkdirSync(join(p, 'Hive'))
    expect(chooseProfile(p, 'Hive', 'Combwork')).toMatchObject({ use: join(p, 'Hive'), fallback: true })
  })

  it("Combwork's folder that can't be looked at (no permission, an I/O error) is never taken for missing", () => {
    const p = tempDir('pf-unreadable-')
    mkdirSync(join(p, 'Hive'))
    for (const code of ['EPERM', 'EACCES', 'EIO', 'EBUSY']) {
      const stat = (path: string) => {
        if (path === join(p, 'Combwork')) throw Object.assign(new Error(code), { code })
        return statSync(path)
      }
      const c = chooseProfile(p, 'Hive', 'Combwork', stat)
      expect(c, code).toEqual({ use: join(p, 'Combwork'), current: join(p, 'Combwork'), fallback: false, unreadable: code })
      expect(choiceLine(c, (x) => x), code).toContain(code)
    }
  })

  it("Hive's folder that can't be looked at, Combwork's missing: Hive's is used (never a blank Combwork in its place), for roaming and local alike", () => {
    const p = tempDir('pf-legacy-unreadable-')
    for (const parent of [join(p, 'appdata'), join(p, 'localappdata')]) {
      mkdirSync(parent, { recursive: true })
      for (const code of ['EPERM', 'EACCES', 'EIO', 'EBUSY']) {
        const stat = (path: string) => {
          if (path === join(parent, 'Combwork')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          if (path === join(parent, 'Hive')) throw Object.assign(new Error(code), { code })
          return statSync(path)
        }
        const c = chooseProfile(parent, 'Hive', 'Combwork', stat)
        expect(c, `${parent} ${code}`).toEqual({ use: join(parent, 'Hive'), current: join(parent, 'Combwork'), fallback: true, unreadable: code })
        expect(choiceLine(c, (x) => x), code).toContain(code)
      }
      // Nothing was made in either place.
      expect(tree(parent)).toEqual([])
    }
  })

  it("only ENOENT and ENOTDIR count as missing: Hive's folder is used then", () => {
    const p = tempDir('pf-missing-')
    mkdirSync(join(p, 'Hive'))
    for (const code of ['ENOENT', 'ENOTDIR']) {
      const stat = (path: string) => {
        if (path === join(p, 'Combwork')) throw Object.assign(new Error(code), { code })
        return statSync(path)
      }
      expect(chooseProfile(p, 'Hive', 'Combwork', stat), code).toMatchObject({ use: join(p, 'Hive'), fallback: true })
    }
  })
})

describe('the fallback notice (HI-2461)', () => {
  it('names each old folder in use, and says nothing when Combwork\'s are used', async () => {
    const { setProfileChoices } = await import('../src/main/profileFolders')
    const { startProfileNotices } = await import('../src/main/profileNotices')
    toasts.length = 0
    const p = tempDir('pf-notice-')
    mkdirSync(join(p, 'appdata', 'Hive-Dev'), { recursive: true })
    mkdirSync(join(p, 'localappdata', 'Combwork-Dev'), { recursive: true })
    const roaming = chooseProfile(join(p, 'appdata'), 'Hive-Dev', 'Combwork-Dev')
    const local = chooseProfile(join(p, 'localappdata'), 'Hive-Dev', 'Combwork-Dev')
    setProfileChoices({ roaming, local })
    await startProfileNotices()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toContain(join(p, 'appdata', 'Hive-Dev'))
    expect(toasts[0].message).not.toContain(join(p, 'localappdata'))
    // The dev build's words: rename it by hand.
    expect(toasts[0].message).toContain('rename it to Combwork-Dev')
    toasts.length = 0
    mkdirSync(join(p, 'appdata', 'Combwork-Dev'))
    setProfileChoices({ roaming: chooseProfile(join(p, 'appdata'), 'Hive-Dev', 'Combwork-Dev'), local })
    await startProfileNotices()
    expect(toasts).toHaveLength(0)
    setProfileChoices({ roaming: null, local: null })
  })
})

describe("a start between the installer's record and its rename (HI-2460)", () => {
  it("runs on Hive's folders, says so, and never checks sign-ins: the record waits in Hive's folder, untouched", async () => {
    const { setProfileChoices } = await import('../src/main/profileFolders')
    const { startProfileNotices } = await import('../src/main/profileNotices')
    toasts.length = 0
    const p = tempDir('pf-interval-')
    mkdirSync(join(p, 'appdata', 'Hive-Dev'), { recursive: true })
    const oldLocal = join(p, 'localappdata', 'Hive-Dev')
    mkdirSync(oldLocal, { recursive: true })
    const rec = JSON.stringify({ v: 1, from: oldLocal, movedAt: '2026-11-03T21:00:00.000Z', by: 'installer' })
    writeFileSync(join(oldLocal, MOVE_RECORD), rec)
    accounts.list = [{ id: 'a-out', name: 'Work' }]
    setProfileChoices({ roaming: chooseProfile(join(p, 'appdata'), 'Hive-Dev', 'Combwork-Dev'), local: chooseProfile(join(p, 'localappdata'), 'Hive-Dev', 'Combwork-Dev') })
    await startProfileNotices()
    expect(toasts.map((t) => t.title)).toEqual(['Hive is using its data folders from before Combwork'])
    expect(readFileSync(join(oldLocal, MOVE_RECORD), 'utf8')).toBe(rec)
    setProfileChoices({ roaming: null, local: null })
  })
})

describe('the sign-in check after the installer moved the folder (HI-2461, HI-2460)', () => {
  const record = { v: 1, from: 'C:\\Users\\x\\AppData\\Local\\Hive', movedAt: '2026-11-03T21:00:00.000Z', by: 'installer', extra: { kept: true } }
  const answers: Record<string, { loggedIn: boolean | null } | null | 'throw'> = {}
  const check = async (id: string) => {
    const a = answers[id]
    if (a === 'throw') throw new Error('the CLI failed')
    return a ?? null
  }
  const folder = (r?: unknown, raw?: string): string => {
    const dir = tempDir('pf-signin-')
    if (raw !== undefined) writeFileSync(join(dir, MOVE_RECORD), raw)
    else if (r) writeFileSync(join(dir, MOVE_RECORD), JSON.stringify(r))
    return dir
  }
  const readRec = (dir: string) => JSON.parse(readFileSync(join(dir, MOVE_RECORD), 'utf8')) as Record<string, unknown>

  beforeEach(() => {
    toasts.length = 0
    for (const k of Object.keys(answers)) delete answers[k]
    accounts.list = [
      { id: 'a-in', name: 'Personal' },
      { id: 'a-out', name: 'Work' },
      { id: 'a-server', name: 'Local Ollama', kind: 'server' }
    ]
  })

  it('names only the connections that show signed out, once, never a server; the record kept whole and marked done', async () => {
    answers['a-in'] = { loggedIn: true }
    answers['a-out'] = { loggedIn: false }
    answers['a-server'] = { loggedIn: false }
    const dir = folder(record)
    expect(await checkSignInsAfterMove(dir, check)).toEqual(['Work'])
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toContain('Work')
    expect(toasts[0].message).not.toContain('Personal')
    expect(readRec(dir)).toEqual({ ...record, signInNamed: ['a-out'], signInChecked: true })
    // Once: the next start says nothing.
    expect(await checkSignInsAfterMove(dir, check)).toEqual([])
    expect(toasts).toHaveLength(1)
  })

  it('no record (no move by the installer): nothing checked, nothing said, nothing written', async () => {
    const dir = folder()
    let checked = 0
    expect(await checkSignInsAfterMove(dir, async () => (checked++, { loggedIn: false }))).toEqual([])
    expect(checked).toBe(0)
    expect(tree(dir)).toEqual([])
  })

  it("a record that can't be read, or isn't the installer's: left exactly as it is, nothing checked", async () => {
    for (const raw of ['{"v":1,"from":', '{"v":2,"from":"x","by":"installer"}', '{"v":1,"from":"x","by":"someone"}', '[]', '']) {
      toasts.length = 0
      const dir = folder(undefined, raw)
      let checked = 0
      expect(await checkSignInsAfterMove(dir, async () => (checked++, { loggedIn: false })), raw).toEqual([])
      expect(checked, raw).toBe(0)
      expect(readFileSync(join(dir, MOVE_RECORD), 'utf8'), raw).toBe(raw)
      expect(toasts, raw).toHaveLength(0)
    }
  })

  it("a check that couldn't finish: not marked done, tried again next start, and a name said once only", async () => {
    answers['a-in'] = 'throw'
    answers['a-out'] = { loggedIn: false }
    const dir = folder(record)
    expect(await checkSignInsAfterMove(dir, check)).toEqual(['Work'])
    expect(readRec(dir)).toEqual({ ...record, signInNamed: ['a-out'] })
    // Next start: Personal now answers signed out, Work isn't said again.
    answers['a-in'] = { loggedIn: false }
    expect(await checkSignInsAfterMove(dir, check)).toEqual(['Personal'])
    expect(readRec(dir)).toEqual({ ...record, signInNamed: ['a-out', 'a-in'], signInChecked: true })
    expect(toasts.map((t) => t.message?.includes('Work'))).toEqual([true, false])
  })

  it('a check with no answer (null) counts as unfinished, never as signed out', async () => {
    answers['a-in'] = { loggedIn: null }
    answers['a-out'] = null
    const dir = folder(record)
    expect(await checkSignInsAfterMove(dir, check)).toEqual([])
    expect(toasts).toHaveLength(0)
    expect(readRec(dir).signInChecked).toBeUndefined()
  })

  it("a record that can't be written back: the check stays to do next start", async () => {
    answers['a-in'] = { loggedIn: true }
    answers['a-out'] = { loggedIn: true }
    const dir = folder(record)
    // The temp file's name is taken by a folder: the write fails.
    mkdirSync(join(dir, `${MOVE_RECORD}.tmp`))
    expect(await checkSignInsAfterMove(dir, check)).toEqual([])
    expect(readRec(dir)).toEqual(record)
  })
})
