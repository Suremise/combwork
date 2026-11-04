// Hive's one way to the Recycle Bin (#414): every deletion goes through trash() in src/main/trash.ts, and a test copy of
// Hive moves what it deletes into its own trash folder instead of the user's Recycle Bin.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

// A rename across drives (EXDEV) where a test asks for one: the test trash folder can't be on another drive here. And the
// renames Windows refused, so a test can wait for one.
const hooks: { exdev: ((from: string, to: string) => boolean) | null; refused: string[] } = { exdev: null, refused: [] }
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (hooks.exdev?.(String(from), String(to))) throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${from}'`), { code: 'EXDEV' })
      await real.rename(from, to).catch((e: unknown) => {
        hooks.refused.push(String(from))
        throw e
      })
    }
  }
})

const { testTrashDir, trash } = await import('../src/main/trash')
const { trashAllOrNothing } = await import('../src/main/fsutil')

const base = tempDir('hive-trash-')
const shell = electron.shell as unknown as { trashItem?: (p: string) => Promise<void> }
const saved = { dir: process.env.HIVE_TEST_TRASH_DIR, profile: process.env.HIVE_USER_DATA }
afterEach(() => {
  for (const [k, v] of [['HIVE_TEST_TRASH_DIR', saved.dir], ['HIVE_USER_DATA', saved.profile]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  delete shell.trashItem
  hooks.exdev = null
  hooks.refused = []
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** Every source file under a folder. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|tsx|mts|cts)$/.test(e.name) ? [join(dir, e.name)] : []))
}

describe('trash (src/main/trash.ts)', () => {
  it('is the only caller of shell.trashItem', () => {
    const root = join(__dirname, '..', 'src')
    const callers = sources(root).filter((f) => !f.endsWith(join('main', 'trash.ts')) && /\btrashItem\b/.test(readFileSync(f, 'utf8')))
    expect(callers.map((f) => relative(root, f))).toEqual([])
  })

  it('picks the test trash folder only in a test copy: unpackaged, or packaged and quiet (#1599)', () => {
    expect(testTrashDir({ HIVE_TEST_TRASH_DIR: 'C:\\t\\trash', HIVE_USER_DATA: 'C:\\p' }, false)).toBe('C:\\t\\trash')
    expect(testTrashDir({ HIVE_USER_DATA: 'C:\\p' }, false)).toBe(join('C:\\p', 'test-trash'))
    // npm run dev: no test profile, the Recycle Bin.
    expect(testTrashDir({}, false)).toBeNull()
    // The installed app (never quiet): always the Recycle Bin, whatever else its environment says.
    expect(testTrashDir({ HIVE_TEST_TRASH_DIR: 'C:\\t\\trash', HIVE_USER_DATA: 'C:\\p' }, true)).toBeNull()
    expect(testTrashDir({ HIVE_TEST_TRASH_DIR: 'C:\\t\\trash', HIVE_USER_DATA: 'C:\\p', HIVE_TEST_QUIET: '0' }, true)).toBeNull()
    // A packaged copy a test started (HIVE_TEST_QUIET=1, lib.hiveEnv): its suite's trash folder, or its profile's.
    expect(testTrashDir({ HIVE_TEST_TRASH_DIR: 'C:\\t\\trash', HIVE_USER_DATA: 'C:\\p', HIVE_TEST_QUIET: '1' }, true)).toBe('C:\\t\\trash')
    expect(testTrashDir({ HIVE_USER_DATA: 'C:\\p', HIVE_TEST_QUIET: '1' }, true)).toBe(join('C:\\p', 'test-trash'))
    expect(testTrashDir({ HIVE_TEST_QUIET: '1' }, true)).toBeNull()
  })

  it('in a test copy, moves files and folders into its trash folder and notes each one', async () => {
    const dir = join(base, 'run-trash')
    process.env.HIVE_TEST_TRASH_DIR = dir
    shell.trashItem = async () => {
      throw new Error('the real Recycle Bin was used')
    }
    const file = join(base, 'note.md')
    writeFileSync(file, 'hello')
    const folder = join(base, 'skill')
    mkdirSync(join(folder, 'refs'), { recursive: true })
    writeFileSync(join(folder, 'refs', 'a.txt'), 'a')
    await trash(file)
    await trash(folder)
    // The same name again: kept apart.
    writeFileSync(file, 'again')
    await trash(file)
    expect(existsSync(file) || existsSync(folder)).toBe(false)
    const log = readFileSync(join(dir, 'trash.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { from: string; to: string })
    expect(log.map((e) => e.from)).toEqual([file, folder, file])
    expect(new Set(log.map((e) => e.to)).size).toBe(3)
    expect(readFileSync(log[0].to, 'utf8')).toBe('hello')
    expect(readFileSync(log[2].to, 'utf8')).toBe('again')
    expect(readFileSync(join(log[1].to, 'refs', 'a.txt'), 'utf8')).toBe('a')
  })

  it('falls back to <profile>/test-trash with only a test profile', async () => {
    const profile = join(base, 'profile')
    process.env.HIVE_USER_DATA = profile
    delete process.env.HIVE_TEST_TRASH_DIR
    const file = join(base, 'card.json')
    writeFileSync(file, '{}')
    await trash(file)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(join(profile, 'test-trash')).some((n) => n.endsWith('-card.json'))).toBe(true)
  })

  it("a note that can't be written doesn't turn a deletion that happened into a failure (#414 round 1)", async () => {
    const dir = join(base, 'note-fails')
    // Its log can't be appended to: a folder of that name.
    mkdirSync(join(dir, 'trash.jsonl'), { recursive: true })
    process.env.HIVE_TEST_TRASH_DIR = dir
    const file = join(base, 'gone.md')
    writeFileSync(file, 'gone')
    await expect(trash(file)).resolves.toBeUndefined()
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir).filter((n) => n.endsWith('-gone.md'))).toHaveLength(1)
    // A group's delete (trashAllOrNothing, the Attachments tab's) goes through whole: nothing put back, nothing lost.
    const group = ['a.png', 'b.png'].map((n) => join(base, n))
    for (const f of group) writeFileSync(f, f)
    await trashAllOrNothing(group, trash)
    expect(group.filter((f) => existsSync(f) || existsSync(`${f}.spare`))).toEqual([])
    expect(readdirSync(dir).filter((n) => /-(a|b)\.png$/.test(n))).toHaveLength(2)
  })

  it('an item on another drive is refused before anything moves: whole, in place, nothing in the trash (#414 round 1)', async () => {
    const dir = join(base, 'other-drive')
    process.env.HIVE_TEST_TRASH_DIR = dir
    const folder = join(base, 'project')
    mkdirSync(join(folder, 'src'), { recursive: true })
    writeFileSync(join(folder, 'a.txt'), 'a')
    writeFileSync(join(folder, 'src', 'b.txt'), 'b')
    hooks.exdev = (from, to) => from === folder && to.startsWith(dir)
    await expect(trash(folder)).rejects.toThrow(/another drive.*Nothing was changed/)
    expect(readFileSync(join(folder, 'a.txt'), 'utf8') + readFileSync(join(folder, 'src', 'b.txt'), 'utf8')).toBe('ab')
    expect(readdirSync(dir)).toEqual([])
    // The caller's all-or-nothing: the first went, the second was refused, so the first is put back.
    const first = join(base, 'one.png')
    const second = join(base, 'two.png')
    writeFileSync(first, '1')
    writeFileSync(second, '2')
    hooks.exdev = (from, to) => from === second && to.startsWith(dir)
    await expect(trashAllOrNothing([first, second], trash)).rejects.toThrow(/another drive/)
    expect([readFileSync(first, 'utf8'), readFileSync(second, 'utf8')]).toEqual(['1', '2'])
  })

  it('rejects for something that is not there, noting nothing', async () => {
    const dir = join(base, 'missing-trash')
    process.env.HIVE_TEST_TRASH_DIR = dir
    await expect(trash(join(base, 'not-there.txt'))).rejects.toThrow()
    expect(existsSync(join(dir, 'trash.jsonl'))).toBe(false)
  })

  it('a folder something has open for a moment is moved once it is let go, not refused (#668)', async () => {
    const dir = join(base, 'held-trash')
    process.env.HIVE_TEST_TRASH_DIR = dir
    const folder = join(base, 'held-project')
    mkdirSync(join(folder, '.combwork'), { recursive: true })
    const file = join(folder, '.combwork', 'project.json')
    writeFileSync(file, '{}')
    // A handle on a file in it (an antivirus scan, a reader closing it): Windows can't move the folder while it is open.
    const fd = openSync(file, 'r')
    // Settled whatever happens below: its failure is kept as a value, never left unhandled.
    const moving = trash(folder).then(
      () => null,
      (e: unknown) => e
    )
    let failure: unknown
    try {
      // Let go once a try has been refused, as a scan finishes.
      await vi.waitFor(() => expect(hooks.refused).toContain(folder), { timeout: HUNG_MS })
    } finally {
      // On every path: the handle closed and the move over before the test ends (and afterAll removes the folder).
      closeSync(fd)
      failure = await moving
    }
    expect(failure).toBeNull()
    expect(existsSync(folder)).toBe(false)
    const [moved] = readFileSync(join(dir, 'trash.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { from: string; to: string })
    expect(moved.from).toBe(folder)
    expect(readFileSync(join(moved.to, '.combwork', 'project.json'), 'utf8')).toBe('{}')
  })

  it('a folder kept open is refused after a few tries, whole and in place, nothing in the trash (#668)', async () => {
    const dir = join(base, 'kept-open-trash')
    process.env.HIVE_TEST_TRASH_DIR = dir
    const folder = join(base, 'kept-open')
    mkdirSync(folder, { recursive: true })
    const file = join(folder, 'a.txt')
    writeFileSync(file, 'a')
    const fd = openSync(file, 'r')
    try {
      await expect(trash(folder)).rejects.toMatchObject({ code: 'EPERM' })
      // The first try and five more, then no more.
      expect(hooks.refused.filter((f) => f === folder)).toHaveLength(6)
      expect(readFileSync(file, 'utf8')).toBe('a')
      expect(readdirSync(dir)).toEqual([])
    } finally {
      closeSync(fd)
    }
  })

  it('outside a test copy, tries the Recycle Bin again while the item is still there (#668)', async () => {
    delete process.env.HIVE_TEST_TRASH_DIR
    delete process.env.HIVE_USER_DATA
    const file = join(base, 'busy.txt')
    writeFileSync(file, 'busy')
    let tries = 0
    shell.trashItem = async (p) => {
      if (++tries < 3) throw new Error('in use')
      rmSync(p)
    }
    await trash(file)
    expect(tries).toBe(3)
    expect(existsSync(file)).toBe(false)
  })

  it('outside a test copy, uses the Recycle Bin (shell.trashItem), and passes on its failure', async () => {
    delete process.env.HIVE_TEST_TRASH_DIR
    delete process.env.HIVE_USER_DATA
    const asked: string[] = []
    shell.trashItem = async (p) => {
      asked.push(p)
    }
    await trash(join(base, 'real.txt'))
    expect(asked).toEqual([join(base, 'real.txt')])
    let tries = 0
    shell.trashItem = async () => {
      tries++
      throw new Error('in use')
    }
    // Nothing there to move: not tried again.
    await expect(trash(join(base, 'real.txt'))).rejects.toThrow('in use')
    expect(tries).toBe(1)
  })
})
