// HI-2462: HR1's round-1 probes, kept as regressions against the derived map (s65). Each keeps its invariant; only the
// plumbing the new shape removed is adapted (a plan file is now just a file named like one).
// 1. A native rename that completes, then a crash before anything else is written: the move is in the map, old paths resolve.
// 2. A both-present workspace whose current Assistant's inner .hive moves: the old outer tree is never mapped.
// 3. A recreated .hive holding a file named like the old plan: untouched through recovery and finish.
// 4. A host found after the notes phase finished: its references are repaired.
// 5. A card edited by another connection between the rewrite's read and its write: never overwritten (here the edit is
//    tried at that moment, refused as the batch holds the write, and lands as written once it commits).
// Plus HR1's approval of s65: a project that arrives once the move has finished (the old hash unchanged before its rename)
// is still moved; a marker that isn't Combwork's, or sits in a linked folder, isn't a move.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const crash = vi.hoisted(() => ({ from: '' }))
/** A read of one file held until released (HR1's round-3 race: a cold reader paused at its last marker read). */
const gate = vi.hoisted(() => ({ path: '', armed: false, entered: null as null | (() => void), release: null as null | (() => void) }))
vi.mock('fs/promises', async (orig) => {
  const fs = await orig<typeof import('fs/promises')>()
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args)
      if (crash.from && String(args[0]).toLowerCase() === crash.from.toLowerCase()) {
        crash.from = ''
        throw new Error('crash immediately after native rename')
      }
    },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const bytes = await fs.readFile(...args)
      if (gate.armed && String(args[0]).toLowerCase() === gate.path.toLowerCase()) {
        gate.armed = false
        gate.entered?.()
        await new Promise<void>((r) => (gate.release = r))
      }
      return bytes
    }
  }
})

const base = tempDir('hi2462-probes-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { MARK_FILE, MOVED_FILE, deriveMoves, finishMove, moveFolders, movedFolders, movedPath, moveStats, moveTestHooks } = await import('../src/main/combworkMove')
const { cardsTestHooks, rewriteCards } = await import('../src/main/hiveMoveWorker')

const json = (p: string, v: unknown): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(v))
}
const board = (file: string): void => {
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE cards(number INTEGER PRIMARY KEY, description TEXT); CREATE TABLE card_comments(card INTEGER, ord INTEGER, text TEXT); CREATE TABLE card_context(card INTEGER, ord INTEGER, ref TEXT)')
  db.close()
}
afterEach(() => {
  crash.from = ''
  delete moveTestHooks.after
  delete cardsTestHooks.inBatch
})

describe("HR1's round-1 probes against the derived map", () => {
  it('1. a native rename completed before anything else was written still gives the map', async () => {
    const ws = join(base, 'crash')
    json(join(ws, '.hive', 'workspace.json'), { version: 1 })
    json(join(ws, '.hive', 'shared', 'note.md'), { kept: true })
    crash.from = join(ws, '.hive')
    await expect(moveFolders(ws)).rejects.toThrow(/immediately after native rename/)
    expect(existsSync(join(ws, '.combwork', 'workspace.json'))).toBe(true)
    expect(existsSync(join(ws, '.hive'))).toBe(false)
    expect(await movedPath(ws, join(ws, '.hive', 'shared', 'note.md'))).toBe(join(ws, '.combwork', 'shared', 'note.md'))
    await moveFolders(ws)
    expect(await movedPath(ws, join(ws, '.hive', 'shared', 'note.md'))).toBe(join(ws, '.combwork', 'shared', 'note.md'))
  })

  it("2. moving the current Assistant's inner folder doesn't map an unmoved old workspace tree", async () => {
    const ws = join(base, 'both')
    json(join(ws, '.hive', 'workspace.json'), { which: 'old' })
    json(join(ws, '.combwork', 'workspace.json'), { which: 'new' })
    json(join(ws, '.combwork', 'assistant', '.hive', 'project.json'), { agents: [] })
    await moveFolders(ws)
    expect(await movedPath(ws, join(ws, '.hive', 'assistant', '.hive', 'attachments', 'old.png'))).toBeNull()
    expect(readFileSync(join(ws, '.hive', 'workspace.json'), 'utf8')).toBe(JSON.stringify({ which: 'old' }))
    expect((await movedFolders(ws)).map((m) => m.from)).toEqual([join(ws, '.combwork', 'assistant', '.hive')])
  })

  it("3. a recreated .hive's file named like the old plan stays as it is", async () => {
    const ws = join(base, 'recreated')
    json(join(ws, '.hive', 'workspace.json'), { version: 1 })
    moveTestHooks.after = (step) => {
      if (step === 'renamed:workspace') throw new Error('crash after the rename')
    }
    await expect(moveFolders(ws)).rejects.toThrow(/after the rename/)
    delete moveTestHooks.after
    json(join(ws, '.hive', 'workspace.json'), { which: 'recreated' })
    const plan = join(ws, '.hive', 'combwork-move.json')
    json(plan, { owner: 'recreated-data-must-stay' })
    json(`${plan}.bak`, { owner: 'its backup' })
    const kept = [readFileSync(plan, 'utf8'), readFileSync(`${plan}.bak`, 'utf8')]
    const dbfile = join(ws, '.combwork', 'hive.db')
    board(dbfile)
    const r = await moveFolders(ws)
    if (r.late) await finishMove(ws, { boardFile: dbfile, relocateFolders: async () => true })
    expect([readFileSync(plan, 'utf8'), readFileSync(`${plan}.bak`, 'utf8')]).toEqual(kept)
    expect(JSON.parse(readFileSync(join(ws, '.hive', 'workspace.json'), 'utf8'))).toEqual({ which: 'recreated' })
  })

  it('4. a host found after the notes phase finished gets its references repaired', async () => {
    const ws = join(base, 'late-during-recovery')
    const old = join(ws, 'beta', '.hive', 'attachments', 'x.png')
    json(join(ws, '.hive', 'workspace.json'), { version: 1 })
    mkdirSync(join(ws, '.hive', 'shared'), { recursive: true })
    writeFileSync(join(ws, '.hive', 'shared', 'note.md'), `Evidence ${old}`)
    moveTestHooks.after = (step) => {
      if (step === 'phase:notes') throw new Error('stop after notes')
    }
    await expect(moveFolders(ws)).rejects.toThrow(/stop after notes/)
    delete moveTestHooks.after
    json(join(ws, 'beta', '.hive', 'project.json'), { id: 'p-beta' })
    await moveFolders(ws)
    expect(await movedPath(ws, old)).toBe(join(ws, 'beta', '.combwork', 'attachments', 'x.png'))
    expect(readFileSync(join(ws, '.combwork', 'shared', 'note.md'), 'utf8')).toBe(`Evidence ${join(ws, 'beta', '.combwork', 'attachments', 'x.png')}`)
  })

  it("5. a card edit at the moment between the rewrite's read and its write isn't overwritten", () => {
    const file = join(tempDir('hi2462-worker-'), 'hive.db')
    board(file)
    const db = new DatabaseSync(file)
    db.prepare('INSERT INTO cards VALUES(1, ?)').run('Evidence D:/ws/.hive/shared/a.md')
    const other = new DatabaseSync(file, { timeout: 0 })
    let tried: string | null = null
    cardsTestHooks.inBatch = () => {
      if (tried !== null) return
      try {
        other.prepare('UPDATE cards SET description = ? WHERE number = 1').run('a concurrent user edit')
        tried = 'written'
      } catch (e) {
        tried = (e as Error).message
      }
    }
    try {
      expect(rewriteCards({ file, moves: [{ from: 'D:/ws/.hive', to: 'D:/ws/.combwork' }], workspaceMoved: true })).toMatchObject({ ok: true })
      // The edit couldn't slip in between the batch's read and its write…
      expect(tried).toMatch(/locked|busy/i)
      // …and the user's write, made again once the batch committed, is what stays.
      other.prepare('UPDATE cards SET description = ? WHERE number = 1').run('a concurrent user edit')
      expect(db.prepare('SELECT description FROM cards WHERE number = 1').get()).toMatchObject({ description: 'a concurrent user edit' })
    } finally {
      other.close()
      db.close()
    }
  })
})

describe("HR1's round 2: readers use the published map", () => {
  it('once a move has published the map, repeated lookups derive nothing; a move under way, or one that failed, makes readers look again', async () => {
    const ws = join(base, 'snapshot')
    json(join(ws, '.hive', 'workspace.json'), { version: 1 })
    for (const p of ['a', 'b', 'c']) json(join(ws, p, '.hive', 'project.json'), { id: p })
    const r = await moveFolders(ws)
    if (r.late) await finishMove(ws, { boardFile: join(ws, '.combwork', 'hive.db'), relocateFolders: async () => true })
    moveStats.derives = 0
    for (let i = 0; i < 20; i++) {
      expect(await movedPath(ws, join(ws, 'b', '.hive', `x${i}.png`))).toBe(join(ws, 'b', '.combwork', `x${i}.png`))
      expect(await movedPath(ws, join(ws, 'unmoved', 'cwd'))).toBeNull()
    }
    expect(moveStats.derives).toBe(0)
    // A late project, moved through its boundary: the map is published again, with it.
    json(join(ws, 'd', '.hive', 'project.json'), { id: 'd' })
    await moveFolders(ws, { only: join(ws, 'd') })
    moveStats.derives = 0
    expect(await movedPath(ws, join(ws, 'd', '.hive', 'y'))).toBe(join(ws, 'd', '.combwork', 'y'))
    expect(moveStats.derives).toBe(0)
    // One that fails after its rename: readers find the move on disk, then keep it.
    json(join(ws, 'e', '.hive', 'project.json'), { id: 'e' })
    crash.from = join(ws, 'e', '.hive')
    await expect(moveFolders(ws, { only: join(ws, 'e') })).rejects.toThrow(/immediately after native rename/)
    expect(await movedPath(ws, join(ws, 'e', '.hive', 'z'))).toBe(join(ws, 'e', '.combwork', 'z'))
    moveStats.derives = 0
    expect(await movedPath(ws, join(ws, 'e', '.hive', 'z'))).toBe(join(ws, 'e', '.combwork', 'z'))
    expect(moveStats.derives).toBe(0)
  })
})

describe("HR1's round 3: a reader overtaken by a move", () => {
  it("an older cold reader can't replace the map a move published while it read", async () => {
    const ws = join(base, 'reader-race')
    const a = join(ws, 'a')
    const b = join(ws, 'b')
    const marker = { kind: 'combwork-move', version: 1, id: 'race', from: '.hive' }
    json(join(ws, '.combwork', 'workspace.json'), {})
    json(join(ws, '.combwork', MARK_FILE), marker)
    json(join(a, '.combwork', 'project.json'), {})
    json(join(a, '.combwork', MARK_FILE), marker)
    gate.path = join(a, '.combwork', MARK_FILE)
    gate.armed = true
    const entered = new Promise<void>((r) => (gate.entered = r))
    const older = movedFolders(ws)
    await entered
    try {
      json(join(b, '.hive', 'project.json'), { id: 'p-b' })
      await moveFolders(ws, { only: b })
      expect(await movedPath(ws, join(b, '.hive', 'x'))).toBe(join(b, '.combwork', 'x'))
    } finally {
      gate.release?.()
      // The older reader gets the map the move published, not its own.
      expect((await older).some((m) => m.from.toLowerCase() === join(b, '.hive').toLowerCase())).toBe(true)
    }
    expect(await movedPath(ws, join(b, '.hive', 'x'))).toBe(join(b, '.combwork', 'x'))
    // And the snapshot stays the move's: no derive for later lookups.
    moveStats.derives = 0
    expect(await movedPath(ws, join(b, '.hive', 'y'))).toBe(join(b, '.combwork', 'y'))
    expect(moveStats.derives).toBe(0)
  })
})

describe("HR1's approval of s65", () => {
  it('a project arriving after the move finished (the old hash unchanged before its rename) still moves', async () => {
    const ws = join(base, 'finished-then-late')
    json(join(ws, '.hive', 'workspace.json'), { version: 1 })
    const dbfile = join(ws, '.hive', 'hive.db')
    board(dbfile)
    const first = await moveFolders(ws)
    if (first.late) await finishMove(ws, { boardFile: join(ws, '.combwork', 'hive.db'), relocateFolders: async () => true })
    const hashBefore = JSON.parse(readFileSync(join(ws, '.combwork', MOVED_FILE), 'utf8')).hash
    json(join(ws, 'late', '.hive', 'project.json'), { id: 'p-late' })
    // The late project contributes nothing to the map until it has moved: the recorded hash still matches the map.
    expect((await deriveMoves(ws)).length).toBe(1)
    const r = await moveFolders(ws, { only: join(ws, 'late') })
    expect(r.moved).toBe(1)
    expect(existsSync(join(ws, 'late', '.combwork', 'project.json'))).toBe(true)
    if (r.late) await finishMove(ws, { boardFile: join(ws, '.combwork', 'hive.db'), relocateFolders: async () => true })
    expect(JSON.parse(readFileSync(join(ws, '.combwork', MOVED_FILE), 'utf8')).hash).not.toBe(hashBefore)
  })

  it("a stop right after the marker is written into the old .hive: the next open renames it", async () => {
    const ws = join(base, 'marked-only')
    json(join(ws, '.hive', 'workspace.json'), { version: 1 })
    moveTestHooks.after = (step) => {
      if (step === 'marked:workspace') throw new Error('stopped')
    }
    await expect(moveFolders(ws)).rejects.toThrow('stopped')
    delete moveTestHooks.after
    expect(existsSync(join(ws, '.hive', MARK_FILE))).toBe(true)
    expect(await deriveMoves(ws)).toEqual([])
    await moveFolders(ws)
    expect(existsSync(join(ws, '.combwork', 'workspace.json'))).toBe(true)
    expect((await deriveMoves(ws)).map((m) => m.from)).toEqual([join(ws, '.hive')])
  })

  it("a marker that isn't Combwork's, or a .combwork that is a link, isn't a move", async () => {
    const ws = join(base, 'fake-marks')
    json(join(ws, '.combwork', 'workspace.json'), { version: 1 })
    writeFileSync(join(ws, '.combwork', MARK_FILE), 'not a marker')
    json(join(ws, 'alpha', '.combwork', 'project.json'), {})
    json(join(ws, 'alpha', '.combwork', MARK_FILE), { kind: 'project', id: 'p-alpha' })
    const elsewhere = join(base, 'elsewhere-combwork')
    json(join(elsewhere, MARK_FILE), { kind: 'combwork-move', version: 1, id: 'x', from: '.hive' })
    mkdirSync(join(ws, 'beta'), { recursive: true })
    symlinkSync(elsewhere, join(ws, 'beta', '.combwork'), 'junction')
    expect(await deriveMoves(ws)).toEqual([])
  })
})
