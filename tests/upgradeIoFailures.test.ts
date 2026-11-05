// HI-2612 (HG1's sweep 2 on HI-2608): the one-way upgrade never takes an I/O failure for done. Only a thing's absence
// (ENOENT, fsPresence.ts) means "not there"; access denied (EACCES), held by another program (EPERM) or a failed read (EIO)
// leaves what it was looking at as it was and nothing recorded, the step refused (or, where it must never throw, its
// failure reported), and once the file can be read again the next try finishes. The places: the folder move's test of a
// `.hive` (combworkFolder.ts ours), its warning about a `.hive` made again (combworkMove.ts), the log's old files
// (logger.ts), the names upgrade's record (nameUpgrade.ts), the progress command's old shims (nameUpgradeProfile.ts) and
// the old skill copies' markers and hashes (nameUpgradeProjects.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

vi.mock('../src/main/events', async (orig) => ({ ...(await orig<object>()), toast: () => undefined }))

/** Paths whose calls fail, each with its error's code, as access denied, another program holding it or a bad disk would. */
const { held, later, sync, async_ } = vi.hoisted(() => {
  const paths = new Map<string, string>()
  /** Paths matching a pattern whose calls (`call`'s alone, when named) fail once `pass` of them have gone through (a later read failing). */
  const after: { match: RegExp; code: string; pass: number; call?: string }[] = []
  const failing = (p: unknown, call: string): string | undefined => {
    const now = paths.get(String(p).toLowerCase())
    if (now) return now
    const l = after.find((x) => x.match.test(String(p)) && (!x.call || x.call === call))
    if (!l) return undefined
    if (l.pass > 0) return void l.pass--
    return l.code
  }
  const failure = (p: unknown, code: string): Error => Object.assign(new Error(`${code}: refused, '${String(p)}' (test)`), { code })
  const syncCall = <F extends (...a: any[]) => any>(real: F, call: string): F =>
    ((p: unknown, ...rest: unknown[]) => {
      const code = failing(p, call)
      if (code) throw failure(p, code)
      return real(p, ...rest)
    }) as F
  const asyncCall = <F extends (...a: any[]) => Promise<any>>(real: F, call: string): F =>
    ((p: unknown, ...rest: unknown[]) => {
      const code = failing(p, call)
      return code ? Promise.reject(failure(p, code)) : real(p, ...rest)
    }) as F
  return { held: paths, later: after, sync: syncCall, async_: asyncCall }
})

vi.mock('original-fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  return { ...real, statSync: sync(real.statSync, 'statSync'), renameSync: sync(real.renameSync, 'renameSync') }
})
vi.mock('original-fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>()
  return { ...real, readFile: async_(real.readFile, 'readFile'), rm: async_(real.rm, 'rm'), open: async_(real.open, 'open'), lstat: async_(real.lstat, 'lstat'), rename: async_(real.rename, 'rename') }
})

const base = tempDir('upgrade-io-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { ours } = await import('../src/main/combworkFolder')
const { classify, moveFolders } = await import('../src/main/combworkMove')
const { moveOldLogs } = await import('../src/main/logger')
const { NAMES_DONE_FILE, NAMES_VERSION, projectNamesDone, upgradeWorkspace, workspaceNeeds } = await import('../src/main/nameUpgrade')
const { removeOldShims } = await import('../src/main/nameUpgradeProfile')
const { upgradeProject } = await import('../src/main/nameUpgradeProjects')
const { contentHash, COPY_MARKER, SwapAbandoned, swapOut, SwapUnreadable } = await import('../src/main/fsutil')

/** The three ways a look fails that aren't an absence. */
const CODES = ['EACCES', 'EPERM', 'EIO'] as const

let n = 0
const fresh = (): string => {
  const d = join(base, `d${++n}`)
  mkdirSync(d, { recursive: true })
  return d
}
const write = (p: string, text: string): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
const hold = (p: string, code: string): void => void held.set(p.toLowerCase(), code)

const release = (): void => {
  held.clear()
  later.length = 0
}

afterEach(release)

describe("the folder move's test of a .hive (combworkFolder.ts ours)", () => {
  for (const code of CODES) {
    it(`${code} on its files: the look throws, never "not ours"; the open is refused, the .hive left; released, the move finishes`, async () => {
      const ws = fresh()
      write(join(ws, '.hive', 'workspace.json'), '{}')
      const p = join(ws, 'alpha')
      write(join(p, '.hive', 'project.json'), '{"x":1}')
      hold(join(p, '.hive', 'project.json'), code)
      expect(() => ours(join(p, '.hive'), 'project')).toThrow(code)
      await expect(classify(ws, p, 'project')).rejects.toThrow(code)
      hold(join(ws, '.hive', 'workspace.json'), code)
      expect(() => ours(join(ws, '.hive'), 'workspace')).toThrow(code)
      await expect(moveFolders(ws)).rejects.toThrow(code)
      expect(existsSync(join(ws, '.combwork'))).toBe(false)
      expect(readFileSync(join(p, '.hive', 'project.json'), 'utf8')).toBe('{"x":1}')
      held.clear()
      expect(ours(join(p, '.hive'), 'project')).toBe(true)
      await moveFolders(ws)
      expect(existsSync(join(ws, '.hive'))).toBe(false)
      expect(readFileSync(join(p, '.combwork', 'project.json'), 'utf8')).toBe('{"x":1}')
    })
  }

  it('a folder with none of its files is not ours', () => {
    const d = fresh()
    expect(ours(d, 'workspace')).toBe(false)
  })

  it("a .hive made again beside a moved .combwork that can't be looked at: only its warning is left out, the open goes on", async () => {
    const ws = fresh()
    write(join(ws, '.hive', 'workspace.json'), '{}')
    await moveFolders(ws)
    write(join(ws, '.hive', 'workspace.json'), '{"again":1}')
    hold(join(ws, '.hive', 'workspace.json'), 'EACCES')
    await moveFolders(ws)
    expect(readFileSync(join(ws, '.hive', 'workspace.json'), 'utf8')).toBe('{"again":1}')
  })
})

describe("the log's old files (logger.ts moveOldLogs)", () => {
  for (const code of CODES) {
    it(`${code} looking at the new name: the old file stays and the current log is never renamed over; the next start moves it`, () => {
      const dir = fresh()
      writeFileSync(join(dir, 'hive.log'), 'old')
      hold(join(dir, 'combwork.log'), code)
      expect(moveOldLogs(dir)).toEqual([`hive.log (${code})`])
      expect(readFileSync(join(dir, 'hive.log'), 'utf8')).toBe('old')
      held.clear()
      expect(moveOldLogs(dir)).toEqual([])
      expect(readdirSync(dir)).toEqual(['combwork.log'])
      expect(readFileSync(join(dir, 'combwork.log'), 'utf8')).toBe('old')
    })

    it(`${code} on the old file or its rename: left, reported for the log, moved by the next start`, () => {
      const dir = fresh()
      writeFileSync(join(dir, 'hive.log'), 'now')
      writeFileSync(join(dir, 'hive.1.log'), 'before')
      hold(join(dir, 'hive.1.log'), code)
      expect(moveOldLogs(dir)).toEqual([`hive.1.log (${code})`])
      expect(readdirSync(dir).sort()).toEqual(['combwork.log', 'hive.1.log'])
      held.clear()
      expect(moveOldLogs(dir)).toEqual([])
      expect(readFileSync(join(dir, 'combwork.1.log'), 'utf8')).toBe('before')
    })
  }

  it('a new name already taken is no failure: the old file is kept, nothing reported', () => {
    const dir = fresh()
    writeFileSync(join(dir, 'hive.log'), 'old')
    writeFileSync(join(dir, 'combwork.log'), 'new')
    expect(moveOldLogs(dir)).toEqual([])
    expect(readFileSync(join(dir, 'combwork.log'), 'utf8')).toBe('new')
  })
})

describe("the names upgrade's record (nameUpgrade.ts)", () => {
  const recorded = (host: string, text: string): string => {
    const f = join(host, '.combwork', NAMES_DONE_FILE)
    write(f, text)
    return f
  }

  it('none, damaged or an older version: not recorded, so every step runs again', async () => {
    const ws = fresh()
    mkdirSync(join(ws, '.combwork'))
    expect(await projectNamesDone(ws)).toBe(false)
    recorded(ws, '{not json')
    expect(await projectNamesDone(ws)).toBe(false)
    recorded(ws, 'null')
    expect(await projectNamesDone(ws)).toBe(false)
    recorded(ws, JSON.stringify({ version: NAMES_VERSION - 1 }))
    expect(await projectNamesDone(ws)).toBe(false)
    recorded(ws, JSON.stringify({ version: NAMES_VERSION }))
    expect(await projectNamesDone(ws)).toBe(true)
  })

  for (const code of CODES) {
    it(`${code} reading it: neither done nor not done, the look throws and the record is unchanged; released, it reads`, async () => {
      const ws = fresh()
      const text = JSON.stringify({ version: NAMES_VERSION })
      const f = recorded(ws, text)
      hold(f, code)
      await expect(projectNamesDone(ws)).rejects.toThrow(code)
      await expect(workspaceNeeds(ws)).rejects.toThrow(code)
      await expect(moveFolders(ws)).rejects.toThrow(code)
      expect(readFileSync(f, 'utf8')).toBe(text)
      held.clear()
      expect(await projectNamesDone(ws)).toBe(true)
    })
  }
})

describe("the progress command's old shims (nameUpgradeProfile.ts removeOldShims)", () => {
  for (const code of CODES) {
    it(`${code} removing one: it stays and is reported, the other goes; the next start removes it`, async () => {
      const bin = fresh()
      writeFileSync(join(bin, 'hive-progress'), 'sh')
      writeFileSync(join(bin, 'hive-progress.cmd'), 'cmd')
      hold(join(bin, 'hive-progress.cmd'), code)
      expect(await removeOldShims(bin)).toEqual([`hive-progress.cmd (${code})`])
      expect(readdirSync(bin)).toEqual(['hive-progress.cmd'])
      expect(readFileSync(join(bin, 'hive-progress.cmd'), 'utf8')).toBe('cmd')
      held.clear()
      expect(await removeOldShims(bin)).toEqual([])
      expect(readdirSync(bin)).toEqual([])
    })
  }

  it('none there: nothing to do, nothing reported', async () => {
    expect(await removeOldShims(fresh())).toEqual([])
  })
})

describe("the old skill copies' markers and hashes (nameUpgradeProjects.ts)", () => {
  /** A copy under the old prefix, its marker (already renamed) its content's hash: provably Combwork's and unchanged. */
  async function oldCopy(): Promise<{ folder: string; dir: string; marker: string }> {
    const folder = fresh()
    const dir = join(folder, '.agents', 'skills', 'hive-merge-ready')
    write(join(dir, 'SKILL.md'), '# merge-ready')
    const marker = join(dir, COPY_MARKER)
    writeFileSync(marker, JSON.stringify({ source: 's', hash: await contentHash(dir) }))
    return { folder, dir, marker }
  }

  for (const code of CODES) {
    it(`${code} reading its marker: the step fails, the copy kept as it was; released, the next run retires it`, async () => {
      const c = await oldCopy()
      const before = readFileSync(c.marker, 'utf8')
      hold(c.marker, code)
      await expect(upgradeProject(c.folder, [])).rejects.toThrow(code)
      expect(readFileSync(c.marker, 'utf8')).toBe(before)
      expect(readFileSync(join(c.dir, 'SKILL.md'), 'utf8')).toBe('# merge-ready')
      held.clear()
      await upgradeProject(c.folder, [])
      expect(existsSync(c.dir)).toBe(false)
    })

    it(`${code} hashing its content: the step fails, the copy kept as it was; released, the next run retires it`, async () => {
      const c = await oldCopy()
      hold(join(c.dir, 'SKILL.md'), code)
      await expect(upgradeProject(c.folder, [])).rejects.toThrow(code)
      held.clear()
      expect(readFileSync(join(c.dir, 'SKILL.md'), 'utf8')).toBe('# merge-ready')
      await upgradeProject(c.folder, [])
      expect(existsSync(c.dir)).toBe(false)
    })
  }

  // HR2's round 1: swapOut checks the copy again as it removes it (before the rename, then twice once it is moved aside).
  // A read failing at any of those is put back like a change, but fails the step: the project's record isn't written, and
  // the next run retires it. `pass`: the reads of SKILL.md let through before the failing one, at its place or aside.
  const LATER = [
    { check: 'the check before it moves', at: /hive-merge-ready[\\/]SKILL\.md$/, pass: 1 },
    { check: 'the first check once moved aside', at: /\.cw-old-[^\\/]+[\\/]SKILL\.md$/, pass: 0 },
    { check: 'the last check once moved aside', at: /\.cw-old-[^\\/]+[\\/]SKILL\.md$/, pass: 1 }
  ]
  for (const code of CODES) {
    for (const l of LATER) {
      it(`${code} at ${l.check}: put back, the step fails and the project's record isn't written; released, the next run retires it`, async () => {
        const c = await oldCopy()
        write(join(c.folder, '.combwork', 'project.json'), '{}')
        const run = (): Promise<void> => upgradeWorkspace(c.folder, { only: c.folder, projects: [], stop: () => undefined, checkpoint: async () => ({ ok: true }), copyFolders: async () => [] })
        later.push({ match: l.at, code, pass: l.pass })
        await expect(run()).rejects.toThrow(/couldn't finish renaming the projects'/)
        expect(later[0].pass).toBe(0)
        release()
        expect(readFileSync(join(c.dir, 'SKILL.md'), 'utf8')).toBe('# merge-ready')
        expect(readdirSync(join(c.folder, '.agents', 'skills'))).toEqual(['hive-merge-ready'])
        expect(await projectNamesDone(c.folder)).toBe(false)
        await run()
        expect(existsSync(c.dir)).toBe(false)
        expect(await projectNamesDone(c.folder)).toBe(true)
      })
    }
  }

  // HR2's round 2: a look at the folder moved aside failing on its own entry (lstat), not its content, at either check
  // after the rename: put back all the same, never left aside where the next run wouldn't see it.
  const ASIDE = /\.cw-old-[^\\/]+$/
  const run = (folder: string): Promise<void> => upgradeWorkspace(folder, { only: folder, projects: [], stop: () => undefined, checkpoint: async () => ({ ok: true }), copyFolders: async () => [] })
  const project = async (): Promise<Awaited<ReturnType<typeof oldCopy>>> => {
    const c = await oldCopy()
    write(join(c.folder, '.combwork', 'project.json'), '{}')
    return c
  }
  /** How many looks at the folder moved aside one check makes (a retirement makes two checks there). */
  const looksPerCheck = async (): Promise<number> => {
    const c = await project()
    later.push({ match: ASIDE, code: 'EIO', pass: 1000, call: 'lstat' })
    await run(c.folder)
    const looks = 1000 - later[0].pass
    release()
    expect(looks % 2).toBe(0)
    return looks / 2
  }
  for (const code of CODES) {
    for (const check of ['first', 'last'] as const) {
      it(`${code} on the moved-aside folder's own entry at the ${check} check after the rename: put back at once, no record; released, the next run retires it`, async () => {
        const pass = check === 'first' ? 0 : await looksPerCheck()
        const c = await project()
        later.push({ match: ASIDE, code, pass, call: 'lstat' })
        await expect(run(c.folder)).rejects.toThrow(/couldn't finish renaming the projects'/)
        expect(later[0].pass).toBe(0)
        release()
        expect(readdirSync(join(c.folder, '.agents', 'skills'))).toEqual(['hive-merge-ready'])
        expect(readFileSync(join(c.dir, 'SKILL.md'), 'utf8')).toBe('# merge-ready')
        expect(await projectNamesDone(c.folder)).toBe(false)
        await run(c.folder)
        expect(readdirSync(join(c.folder, '.agents', 'skills'))).toEqual([])
        expect(await projectNamesDone(c.folder)).toBe(true)
      })
    }
  }

  it('an old copy an earlier run left set aside: put back and retired before the record is written', async () => {
    const c = await project()
    const { renameSync } = await import('fs')
    const aside = join(c.folder, '.agents', 'skills', '.hive-merge-ready.cw-old-1-1')
    renameSync(c.dir, aside)
    await run(c.folder)
    expect(readdirSync(join(c.folder, '.agents', 'skills'))).toEqual([])
    expect(await projectNamesDone(c.folder)).toBe(true)
  })

  for (const code of CODES) {
    it(`${code} putting back an old copy an earlier run left set aside: the step fails, nothing recorded; released, the next run finishes`, async () => {
      const c = await project()
      const { renameSync } = await import('fs')
      const aside = join(c.folder, '.agents', 'skills', '.hive-merge-ready.cw-old-1-1')
      renameSync(c.dir, aside)
      hold(aside, code)
      await expect(run(c.folder)).rejects.toThrow(/couldn't finish renaming the projects'/)
      release()
      expect(readdirSync(join(c.folder, '.agents', 'skills'))).toEqual(['.hive-merge-ready.cw-old-1-1'])
      expect(readFileSync(join(aside, 'SKILL.md'), 'utf8')).toBe('# merge-ready')
      expect(await projectNamesDone(c.folder)).toBe(false)
      await run(c.folder)
      expect(readdirSync(join(c.folder, '.agents', 'skills'))).toEqual([])
      expect(await projectNamesDone(c.folder)).toBe(true)
    })
  }

  it("a copy that differs is a change, not a failure: swapOut abandons it as the user's, and the step keeps it and goes on", async () => {
    const c = await oldCopy()
    writeFileSync(join(c.dir, 'SKILL.md'), '# merge-ready, edited')
    const e = await swapOut(c.dir, JSON.parse(readFileSync(c.marker, 'utf8')).hash).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(SwapAbandoned)
    expect(e).not.toBeInstanceOf(SwapUnreadable)
    await upgradeProject(c.folder, [])
    expect(readFileSync(join(c.dir, 'SKILL.md'), 'utf8')).toBe('# merge-ready, edited')
  })

  it("no marker, a damaged one, or a file of the user's under the prefix: kept, and no failure", async () => {
    const c = await oldCopy()
    writeFileSync(c.marker, '{damaged')
    const noMarker = join(c.folder, '.agents', 'skills', 'hive-mine')
    write(join(noMarker, 'SKILL.md'), '# mine')
    const file = join(c.folder, '.agents', 'skills', 'hive-notes.md')
    writeFileSync(file, 'notes')
    await upgradeProject(c.folder, [])
    expect(readFileSync(join(c.dir, 'SKILL.md'), 'utf8')).toBe('# merge-ready')
    expect(readFileSync(join(noMarker, 'SKILL.md'), 'utf8')).toBe('# mine')
    expect(readFileSync(file, 'utf8')).toBe('notes')
  })
})
