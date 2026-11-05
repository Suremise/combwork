import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseProfile, choiceLine, ProfileMoveRefused, type ProfileFs } from '../src/main/profileFolders'
import { tempDir } from './tempDir'

// HI-2461, HI-2594: the app runs on Combwork's profile folders only. Hive's from before, where the installer didn't move
// it (HI-2460), is moved at start by the names upgrade, by the installer's rule (one rename, only while Combwork's is
// confirmed absent, never a copy or a delete); a move it can't make refuses the start, nothing made in its place. After
// a move (the installer's or the app's), the sign-in check once.

const accounts = vi.hoisted(() => ({ list: [] as { id: string; name: string; kind?: string }[] }))
const toasts = vi.hoisted(() => [] as { level: string; title: string; message?: string }[])
vi.mock('../src/main/accounts', () => ({ combworkAccounts: () => accounts.list, isServer: (a: { kind?: string } | undefined) => a?.kind === 'server', checkAccount: async () => null }))
vi.mock('../src/main/events', () => ({ toast: (level: string, title: string, message?: string) => void toasts.push({ level, title, message }) }))
const { checkSignInsAfterMove, MOVE_RECORD } = await import('../src/main/profileNotices')

const tree = (parent: string): string[] => readdirSync(parent).sort()
const real: ProfileFs = { stat: statSync, rename: renameSync, write: (p, t) => writeFileSync(p, t), remove: (p) => rmSync(p, { force: true }) }
const failing = (path: string, code: string) => (p: string) => {
  if (p === path) throw Object.assign(new Error(code), { code })
  return statSync(p)
}

describe('choosing the profile folder, and moving Hive\'s (HI-2461, HI-2594)', () => {
  it('a new install: neither is there, Combwork\'s is used (made as usual), and nothing is made here', () => {
    const p = tempDir('pf-fresh-')
    expect(chooseProfile(p, 'Hive', 'Combwork')).toEqual({ use: join(p, 'Combwork') })
    expect(tree(p)).toEqual([])
  })

  it("moved by the installer: Combwork's is used, nothing moved", () => {
    const p = tempDir('pf-current-')
    mkdirSync(join(p, 'Combwork'))
    expect(chooseProfile(p, 'Hive', 'Combwork')).toEqual({ use: join(p, 'Combwork') })
  })

  it("not moved yet: Hive's is renamed to Combwork's, its files as they were; the local one carries the app's record of the move", () => {
    for (const record of [false, true]) {
      const p = tempDir('pf-move-')
      mkdirSync(join(p, 'Hive'))
      writeFileSync(join(p, 'Hive', 'config.json'), '{"kept":true}')
      const c = chooseProfile(p, 'Hive', 'Combwork', { record })
      expect(c).toEqual({ use: join(p, 'Combwork'), movedFrom: join(p, 'Hive') })
      expect(choiceLine(c, (x) => x)).toContain(`moved ${join(p, 'Hive')} to ${join(p, 'Combwork')}`)
      expect(tree(p)).toEqual(['Combwork'])
      expect(readFileSync(join(p, 'Combwork', 'config.json'), 'utf8')).toBe('{"kept":true}')
      if (record) expect(JSON.parse(readFileSync(join(p, 'Combwork', MOVE_RECORD), 'utf8'))).toMatchObject({ v: 1, from: join(p, 'Hive'), by: 'app' })
      else expect(tree(join(p, 'Combwork'))).toEqual(['config.json'])
      // The next start: Combwork's is there, nothing moves.
      expect(chooseProfile(p, 'Hive', 'Combwork', { record })).toEqual({ use: join(p, 'Combwork') })
    }
  })

  it("a record already in Hive's local folder (the installer's, its rename having failed) is kept as it is, and moves with it", () => {
    const p = tempDir('pf-installer-record-')
    mkdirSync(join(p, 'Hive'))
    const rec = JSON.stringify({ v: 1, from: join(p, 'Hive'), movedAt: '2026-11-03T21:00:00.000Z', by: 'installer' })
    writeFileSync(join(p, 'Hive', MOVE_RECORD), rec)
    expect(chooseProfile(p, 'Hive', 'Combwork', { record: true })).toEqual({ use: join(p, 'Combwork'), movedFrom: join(p, 'Hive') })
    expect(readFileSync(join(p, 'Combwork', MOVE_RECORD), 'utf8')).toBe(rec)
  })

  it("both there: Combwork's is used, and Hive's is never touched", () => {
    const p = tempDir('pf-both-')
    mkdirSync(join(p, 'Combwork'))
    mkdirSync(join(p, 'Hive'))
    writeFileSync(join(p, 'Hive', 'kept.txt'), 'old')
    expect(chooseProfile(p, 'Hive', 'Combwork', { record: true })).toEqual({ use: join(p, 'Combwork') })
    expect(tree(join(p, 'Hive'))).toEqual(['kept.txt'])
  })

  it("a rename that fails (a Hive still running holds the folder): the start is refused, both as they were, the record taken back out", () => {
    const p = tempDir('pf-held-')
    mkdirSync(join(p, 'Hive'))
    writeFileSync(join(p, 'Hive', 'config.json'), '{}')
    const fs: ProfileFs = { ...real, rename: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) } }
    expect(() => chooseProfile(p, 'Hive', 'Combwork', { record: true, fs })).toThrow(ProfileMoveRefused)
    try {
      chooseProfile(p, 'Hive', 'Combwork', { record: true, fs })
    } catch (e) {
      expect(e).toMatchObject({ from: join(p, 'Hive'), to: join(p, 'Combwork'), reason: "it couldn't be renamed (EBUSY)" })
    }
    expect(tree(p)).toEqual(['Hive'])
    expect(tree(join(p, 'Hive'))).toEqual(['config.json'])
  })

  it("a record that can't be put in Hive's local folder: refused before anything moves", () => {
    const p = tempDir('pf-norecord-')
    mkdirSync(join(p, 'Hive'))
    const fs: ProfileFs = { ...real, write: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }
    expect(() => chooseProfile(p, 'Hive', 'Combwork', { record: true, fs })).toThrow(/record of the move couldn't be put in it \(EACCES\)/)
    expect(tree(p)).toEqual(['Hive'])
  })

  it("a file named like Combwork's folder beside Hive's: refused, never renamed over it", () => {
    const p = tempDir('pf-file-')
    writeFileSync(join(p, 'Combwork'), 'not a folder')
    mkdirSync(join(p, 'Hive'))
    expect(() => chooseProfile(p, 'Hive', 'Combwork')).toThrow(/a file is there under Combwork's name/)
    expect(readFileSync(join(p, 'Combwork'), 'utf8')).toBe('not a folder')
    expect(tree(p)).toEqual(['Combwork', 'Hive'])
  })

  it("Combwork's folder that can't be looked at (no permission, an I/O error) is never taken for missing: used, nothing moved", () => {
    const p = tempDir('pf-unreadable-')
    mkdirSync(join(p, 'Hive'))
    for (const code of ['EPERM', 'EACCES', 'EIO', 'EBUSY']) {
      const c = chooseProfile(p, 'Hive', 'Combwork', { fs: { ...real, stat: failing(join(p, 'Combwork'), code) } })
      expect(c, code).toEqual({ use: join(p, 'Combwork'), unreadable: code })
      expect(choiceLine(c, (x) => x), code).toContain(code)
    }
    expect(tree(p)).toEqual(['Hive'])
  })

  it("Hive's folder that can't be looked at, Combwork's missing: refused (never a blank Combwork in its place), for roaming and local alike", () => {
    const p = tempDir('pf-legacy-unreadable-')
    for (const parent of [join(p, 'appdata'), join(p, 'localappdata')]) {
      mkdirSync(parent, { recursive: true })
      for (const code of ['EPERM', 'EACCES', 'EIO', 'EBUSY']) {
        const stat = (path: string) => {
          if (path === join(parent, 'Combwork')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          if (path === join(parent, 'Hive')) throw Object.assign(new Error(code), { code })
          return statSync(path)
        }
        expect(() => chooseProfile(parent, 'Hive', 'Combwork', { record: true, fs: { ...real, stat } }), `${parent} ${code}`).toThrow(`it couldn't be looked at (${code})`)
      }
      // Nothing was made in either place.
      expect(tree(parent)).toEqual([])
    }
  })

  it("only ENOENT and ENOTDIR count as missing: Hive's folder is moved then", () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      const p = tempDir('pf-missing-')
      mkdirSync(join(p, 'Hive'))
      const c = chooseProfile(p, 'Hive', 'Combwork', { fs: { ...real, stat: failing(join(p, 'Combwork'), code) } })
      expect(c, code).toEqual({ use: join(p, 'Combwork'), movedFrom: join(p, 'Hive') })
    }
  })
})

describe('the start notices (HI-2594): no fallback is ever said', () => {
  it("after the app's own move, the local folder's record runs the sign-in check once, as after the installer's", async () => {
    const { setProfileChoices } = await import('../src/main/profileFolders')
    const { startProfileNotices } = await import('../src/main/profileNotices')
    toasts.length = 0
    const p = tempDir('pf-notice-')
    mkdirSync(join(p, 'appdata', 'Hive-Dev'), { recursive: true })
    mkdirSync(join(p, 'localappdata', 'Hive-Dev'), { recursive: true })
    const roaming = chooseProfile(join(p, 'appdata'), 'Hive-Dev', 'Combwork-Dev')
    const local = chooseProfile(join(p, 'localappdata'), 'Hive-Dev', 'Combwork-Dev', { record: true })
    accounts.list = []
    setProfileChoices({ roaming, local })
    await startProfileNotices()
    expect(toasts).toHaveLength(0)
    expect(JSON.parse(readFileSync(join(p, 'localappdata', 'Combwork-Dev', MOVE_RECORD), 'utf8'))).toMatchObject({ by: 'app', signInChecked: true })
    setProfileChoices({ roaming: null, local: null })
  })
})

describe('the sign-in check after the installer (or the app) moved the folder (HI-2461, HI-2460, HI-2594)', () => {
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
