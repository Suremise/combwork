// HI-2462: a workspace's .hive folders move to .combwork as it opens (combworkMove.ts; SPEC §4.1.1; the design is the
// card's, HI-2462/s21). Real folders, git and SQLite in throwaway workspaces: a fresh one and one already moved need
// nothing; a 1.0 workspace moves whole (board, notes, attachments, the Assistant's home, its projects) with its paths
// rewritten; a folder with both, another tool's .hive and a linked one are left as they are; a held database refuses the
// move before any project changes; a move stopped after a rename or between phases finishes at the next open, once, and
// a .hive made again meanwhile is left alone; a live process's presence refuses it; a project that comes later moves on
// its own; git's exclude line and a worktree inside .hive/slots follow; and two processes racing for one workspace move
// it once, the loser writing nothing.
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const told = vi.hoisted(() => ({ toasts: [] as { title: string; body: string }[] }))
vi.mock('../src/main/events', async (orig) => ({
  ...(await orig<object>()),
  toast: (_kind: string, title: string, body: string) => void told.toasts.push({ title, body })
}))

const base = tempDir('combworkmove-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { MOVED_FILE, MOVE_LOCK_FILE, MARK_FILE, finishMove, moveFolders, moveTestHooks, movedFolders, movedPath, treeOf } = await import('../src/main/combworkMove')
const { NAMES_VERSION } = await import('../src/main/nameUpgrade')
const { dataFolder } = await import('../src/main/combworkFolder')

const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs')
const WAIT = { timeout: 30_000, interval: 25 }

let n = 0
const write = (p: string, text: string): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
const json = (p: string, v: unknown): void => write(p, JSON.stringify(v))
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

/** A board as 1.0 keeps it, the tables the move rewrites, with a card naming the workspace's and alpha's attachments. */
function board(file: string, ws: string): void {
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE cards (number INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL) STRICT')
  db.exec('CREATE TABLE card_comments (card INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT, PRIMARY KEY (card, ord)) STRICT')
  db.exec('CREATE TABLE card_context (card INTEGER NOT NULL, ord INTEGER NOT NULL, ref TEXT NOT NULL, PRIMARY KEY (card, ord)) STRICT')
  db.prepare('INSERT INTO cards VALUES (1, ?, ?)').run('One', `Evidence: ![shot](${ws}\\alpha\\.hive\\attachments\\cards\\1\\shot.png), note ${ws}\\.hive\\shared\\plan.md`)
  db.prepare('INSERT INTO cards VALUES (2, ?, ?)').run('Two', `Unrelated: ${ws}\\beta-lookalike\\.hive\\x and C:\\other\\.hive\\y`)
  db.prepare('INSERT INTO card_comments VALUES (1, 0, ?)').run(`See ${ws.replace(/\\/g, '/')}/.hive/assistant/.hive/attachments/a.png`)
  db.prepare('INSERT INTO card_context VALUES (1, 0, ?)').run('.hive/shared/plan.md#open')
  db.close()
}

/** A workspace as 1.0 left it: its .hive (settings, board, notes, a handover, the Assistant's home) and a project's. */
function workspace10(): string {
  const ws = join(base, `ws${++n}`)
  json(join(ws, '.hive', 'workspace.json'), { version: 1 })
  board(join(ws, '.hive', 'hive.db'), ws)
  write(join(ws, '.hive', 'shared', 'plan.md'), '# Plan\n')
  write(join(ws, '.hive', 'shared', 'handovers', 'h.md'), `Logs in ${ws}\\alpha\\.hive\\attachments\\cards\\1\\shot.png\n`)
  json(join(ws, '.hive', 'assistant', '.hive', 'project.json'), { agents: [{ id: 'assistant' }] })
  json(join(ws, 'alpha', '.hive', 'project.json'), { id: 'p-alpha', agents: [] })
  write(join(ws, 'alpha', '.hive', 'attachments', 'cards', '1', 'shot.png'), 'png')
  write(join(ws, 'alpha', 'src.txt'), 'code')
  return ws
}

/** Whether the rewrites finished for the map as the folders show it now (its hash recorded). */
const doneFor = (ws: string): boolean => {
  try {
    return typeof JSON.parse(readFileSync(join(ws, '.combwork', MOVED_FILE), 'utf8')).hash === 'string'
  } catch {
    return false
  }
}

const late = (ws: string) => ({ boardFile: join(ws, '.combwork', 'combwork.db'), relocateFolders: async () => true })

/** The whole open's move: early, then late. */
async function openMove(ws: string): Promise<void> {
  const r = await moveFolders(ws)
  if (r.late) await finishMove(ws, late(ws))
}

const cardText = (ws: string): { d: string; c: string; ref: string } => {
  const db = new DatabaseSync(join(ws, '.combwork', 'combwork.db'))
  try {
    return {
      d: (db.prepare('SELECT description FROM cards WHERE number = 1').get() as { description: string }).description,
      c: (db.prepare('SELECT text FROM card_comments WHERE card = 1').get() as { text: string }).text,
      ref: (db.prepare('SELECT ref FROM card_context WHERE card = 1').get() as { ref: string }).ref
    }
  } finally {
    db.close()
  }
}

afterEach(() => {
  delete moveTestHooks.after
  delete moveTestHooks.looked
  told.toasts.length = 0
})

describe('nothing to move', () => {
  it('a fresh folder and one already moved: nothing written, no lock taken', async () => {
    const fresh = join(base, `fresh${++n}`)
    mkdirSync(join(fresh, 'alpha'), { recursive: true })
    expect(await moveFolders(fresh)).toEqual({ late: false, moved: 0 })
    expect(readdirSync(fresh)).toEqual(['alpha'])
    const done = join(base, `done${++n}`)
    json(join(done, '.combwork', 'workspace.json'), {})
    json(join(done, 'alpha', '.combwork', 'project.json'), {})
    // Its names upgraded too (HI-2587): nothing left of Hive's.
    json(join(done, '.combwork', 'combwork-names.json'), { version: NAMES_VERSION })
    expect(await moveFolders(done)).toEqual({ late: false, moved: 0 })
    expect(existsSync(join(done, MOVE_LOCK_FILE))).toBe(false)
  })

  it("one moved by a 1.1 release candidate, its names not yet upgraded (HI-2587): the lock once, then nothing", async () => {
    const rc = join(base, `rc${++n}`)
    json(join(rc, '.combwork', 'workspace.json'), {})
    json(join(rc, 'alpha', '.combwork', 'project.json'), {})
    expect(await moveFolders(rc)).toEqual({ late: false, moved: 0 })
    expect(existsSync(join(rc, '.combwork', 'combwork-names.json'))).toBe(true)
    const lock = join(rc, MOVE_LOCK_FILE)
    const before = readFileSync(lock)
    expect(await moveFolders(rc)).toEqual({ late: false, moved: 0 })
    expect(readFileSync(lock).equals(before)).toBe(true)
  })
})

describe('a 1.0 workspace', () => {
  it('moves whole: board, notes, attachments, the Assistant and its projects, with their paths', async () => {
    const ws = workspace10()
    await openMove(ws)
    for (const gone of ['.hive', 'alpha\\.hive', '.combwork\\assistant\\.hive']) expect(existsSync(join(ws, gone)), gone).toBe(false)
    expect(existsSync(join(ws, '.combwork', 'combwork.db'))).toBe(true)
    expect(existsSync(join(ws, '.combwork', 'assistant', '.combwork', 'project.json'))).toBe(true)
    expect(readFileSync(join(ws, 'alpha', '.combwork', 'attachments', 'cards', '1', 'shot.png'), 'utf8')).toBe('png')
    expect(readFileSync(join(ws, 'alpha', 'src.txt'), 'utf8')).toBe('code')
    // Card text and context, a handover: rewritten; the unrelated card left as it was.
    const t = cardText(ws)
    expect(t.d).toBe(`Evidence: ![shot](${ws}\\alpha\\.combwork\\attachments\\cards\\1\\shot.png), note ${ws}\\.combwork\\shared\\plan.md`)
    expect(t.c).toBe(`See ${ws.replace(/\\/g, '/')}/.combwork/assistant/.combwork/attachments/a.png`)
    expect(t.ref).toBe('shared:plan.md#open')
    const db = new DatabaseSync(join(ws, '.combwork', 'combwork.db'))
    expect((db.prepare('SELECT description FROM cards WHERE number = 2').get() as { description: string }).description).toBe(`Unrelated: ${ws}\\beta-lookalike\\.hive\\x and C:\\other\\.hive\\y`)
    db.close()
    expect(readFileSync(join(ws, '.combwork', 'shared', 'handovers', 'h.md'), 'utf8')).toBe(`Logs in ${ws}\\alpha\\.combwork\\attachments\\cards\\1\\shot.png\n`)
    // The plan is gone; the map and the lock's file stay.
    expect(doneFor(ws)).toBe(true)
    expect(existsSync(join(ws, MOVE_LOCK_FILE))).toBe(true)
    const moves = await movedFolders(ws)
    expect(moves.map((m) => m.from).sort()).toEqual([join(ws, '.combwork', 'assistant', '.hive'), join(ws, '.hive'), join(ws, '.hive', 'assistant', '.hive'), join(ws, 'alpha', '.hive')].sort())
    expect(await movedPath(ws, join(ws, 'alpha', '.hive', 'slots', 'HI-1'))).toBe(join(ws, 'alpha', '.combwork', 'slots', 'HI-1'))
    // Opened again: nothing more to do.
    expect(await moveFolders(ws)).toEqual({ late: false, moved: 0 })
  })
})

describe('left as they are', () => {
  it('a folder with both, another tool\'s .hive and a linked one: unmoved, warned where it matters, not in the map', async () => {
    const ws = workspace10()
    // beta has both; gamma has another tool's .hive; delta's .hive is a junction to a folder outside.
    json(join(ws, 'beta', '.hive', 'project.json'), { id: 'old' })
    json(join(ws, 'beta', '.combwork', 'project.json'), { id: 'new' })
    write(join(ws, 'gamma', '.hive', 'config.yaml'), 'colonyops: true\n')
    const outside = join(base, `outside${++n}`)
    json(join(outside, 'project.json'), { id: 'elsewhere' })
    mkdirSync(join(ws, 'delta'))
    symlinkSync(outside, join(ws, 'delta', '.hive'), 'junction')
    await openMove(ws)
    expect(JSON.parse(readFileSync(join(ws, 'beta', '.hive', 'project.json'), 'utf8'))).toEqual({ id: 'old' })
    expect(JSON.parse(readFileSync(join(ws, 'beta', '.combwork', 'project.json'), 'utf8'))).toEqual({ id: 'new' })
    expect(readFileSync(join(ws, 'gamma', '.hive', 'config.yaml'), 'utf8')).toBe('colonyops: true\n')
    expect(existsSync(join(ws, 'gamma', '.combwork'))).toBe(false)
    expect(existsSync(join(ws, 'delta', '.hive', 'project.json'))).toBe(true)
    expect(existsSync(join(ws, 'delta', '.combwork'))).toBe(false)
    expect(told.toasts.map((t) => t.title)).toEqual(expect.arrayContaining([expect.stringContaining('beta'), expect.stringContaining('delta')]))
    const froms = (await movedFolders(ws)).map((m) => m.from.toLowerCase())
    for (const p of ['beta', 'gamma', 'delta']) expect(froms).not.toContain(join(ws, p, '.hive').toLowerCase())
  })
})

describe('refused, nothing lost', () => {
  it('a held database: the workspace is tried first, so no project changes; it moves once released', async () => {
    const ws = workspace10()
    const held = new DatabaseSync(join(ws, '.hive', 'hive.db'))
    held.prepare('SELECT count(*) FROM cards').get()
    try {
      await expect(moveFolders(ws)).rejects.toThrow(/a program has a file in it open/)
      expect(existsSync(join(ws, '.hive', 'hive.db'))).toBe(true)
      expect(existsSync(join(ws, 'alpha', '.hive', 'project.json'))).toBe(true)
      expect(existsSync(join(ws, 'alpha', '.combwork'))).toBe(false)
    } finally {
      held.close()
    }
    await openMove(ws)
    expect(existsSync(join(ws, '.combwork', 'combwork.db'))).toBe(true)
    expect(existsSync(join(ws, 'alpha', '.combwork', 'project.json'))).toBe(true)
  })

  it("another live process's presence marker: refused before any rename", async () => {
    const ws = workspace10()
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    try {
      json(join(ws, '.hive', 'open', 'Combwork-1234.json'), { pid: other.pid, profile: 'Combwork', appVersion: '1.0.0', startedAt: new Date().toISOString(), heartbeat: new Date().toISOString() })
      await expect(moveFolders(ws)).rejects.toThrow(/open in another Combwork or a 1\.0 copy \(Combwork\)/)
      expect(existsSync(join(ws, '.hive', 'hive.db'))).toBe(true)
      expect(existsSync(join(ws, 'alpha', '.hive'))).toBe(true)
    } finally {
      other.kill()
    }
  })
})

describe('an interrupted move', () => {
  for (const at of ['marked:workspace', 'renamed:workspace', 'marked:assistant', 'renamed:assistant', 'marked:project', 'renamed:project', 'phase:notes', 'phase:cards', 'phase:folders'])
    it(`stopped at ${at}: the next open finishes it, once`, async () => {
      const ws = workspace10()
      moveTestHooks.after = (step) => {
        if (step === at) throw new Error(`stopped at ${step}`)
      }
      await expect(openMove(ws)).rejects.toThrow(`stopped at ${at}`)
      delete moveTestHooks.after
      await openMove(ws)
      expect(existsSync(join(ws, '.hive'))).toBe(false)
      expect(existsSync(join(ws, 'alpha', '.hive'))).toBe(false)
      expect(cardText(ws).d).toContain(`${ws}\\alpha\\.combwork\\attachments`)
      expect(cardText(ws).d).not.toContain('.combwork\\.combwork')
      expect(readFileSync(join(ws, '.combwork', 'shared', 'handovers', 'h.md'), 'utf8')).toContain(`${ws}\\alpha\\.combwork\\`)
      expect(doneFor(ws)).toBe(true)
    })

  it('a .hive made again after our rename is left as it is; the moved folder keeps its mapping and finishes', async () => {
    const ws = workspace10()
    moveTestHooks.after = (step) => {
      if (step === 'renamed:project') throw new Error('stopped')
    }
    await expect(openMove(ws)).rejects.toThrow('stopped')
    delete moveTestHooks.after
    const id = readFileSync(join(ws, 'alpha', '.combwork', MARK_FILE), 'utf8')
    // An older Hive opened alpha meanwhile and made a .hive of its own.
    json(join(ws, 'alpha', '.hive', 'project.json'), { id: 'recreated' })
    await openMove(ws)
    expect(JSON.parse(readFileSync(join(ws, 'alpha', '.hive', 'project.json'), 'utf8'))).toEqual({ id: 'recreated' })
    expect(readdirSync(join(ws, 'alpha', '.hive'))).toEqual(['project.json'])
    expect(readFileSync(join(ws, 'alpha', '.combwork', MARK_FILE), 'utf8')).toBe(id)
    expect(existsSync(join(ws, 'alpha', '.combwork', 'attachments', 'cards', '1', 'shot.png'))).toBe(true)
    expect(cardText(ws).d).toContain(`${ws}\\alpha\\.combwork\\attachments`)
    expect((await movedFolders(ws)).some((m) => m.from.toLowerCase() === join(ws, 'alpha', '.hive').toLowerCase())).toBe(true)
  })
})

describe("HR1's round 1: the map is what the folders show (s65)", () => {
  it('a stop right after the native rename: the map already has it, and old links resolve, before any reopen', async () => {
    const ws = workspace10()
    moveTestHooks.after = (step) => {
      if (step === 'renamed:project') throw new Error('stopped')
    }
    await expect(openMove(ws)).rejects.toThrow('stopped')
    delete moveTestHooks.after
    const note = join(ws, 'alpha', '.hive', 'attachments', 'cards', '1', 'shot.png')
    expect(await movedPath(ws, note)).toBe(join(ws, 'alpha', '.combwork', 'attachments', 'cards', '1', 'shot.png'))
    expect(await movedPath(ws, join(ws, '.hive', 'shared', 'plan.md'))).toBe(join(ws, '.combwork', 'shared', 'plan.md'))
    await openMove(ws)
    expect(cardText(ws).d).toContain(`${ws}\\alpha\\.combwork\\attachments`)
  })

  for (const at of ['phase:notes', 'phase:cards'])
    it(`a host that appears after ${at}: everything runs again, and its references are rewritten`, async () => {
      const ws = workspace10()
      write(join(ws, '.hive', 'shared', 'beta.md'), `Beta keeps ${ws}\\beta\\.hive\\attachments\\b.png\n`)
      moveTestHooks.after = (step) => {
        if (step === at) throw new Error('stopped')
      }
      await expect(openMove(ws)).rejects.toThrow('stopped')
      delete moveTestHooks.after
      json(join(ws, 'beta', '.hive', 'project.json'), { id: 'p-beta' })
      await openMove(ws)
      expect(existsSync(join(ws, 'beta', '.combwork', 'project.json'))).toBe(true)
      expect(readFileSync(join(ws, '.combwork', 'shared', 'beta.md'), 'utf8')).toBe(`Beta keeps ${ws}\\beta\\.combwork\\attachments\\b.png\n`)
      expect(doneFor(ws)).toBe(true)
    })

  it("a host that appears after the move finished: the hash changes, so the rewrites run again for it", async () => {
    const ws = workspace10()
    write(join(ws, '.hive', 'shared', 'gamma.md'), `See ${ws}\\gamma\\.hive\\x.md\n`)
    await openMove(ws)
    json(join(ws, 'gamma', '.hive', 'project.json'), { id: 'p-gamma' })
    await openMove(ws)
    expect(readFileSync(join(ws, '.combwork', 'shared', 'gamma.md'), 'utf8')).toBe(`See ${ws}\\gamma\\.combwork\\x.md\n`)
  })

  it("both at the workspace, the Assistant's inner .hive under .combwork: the inner one moves; the old outer tree is never mapped", async () => {
    const ws = join(base, `bothws${++n}`)
    json(join(ws, '.hive', 'workspace.json'), { old: true })
    write(join(ws, '.hive', 'assistant', '.hive', 'project.json'), '{"old":true}')
    json(join(ws, '.combwork', 'workspace.json'), { version: 1 })
    json(join(ws, '.combwork', 'assistant', '.hive', 'project.json'), { agents: [] })
    await moveFolders(ws)
    expect(existsSync(join(ws, '.combwork', 'assistant', '.combwork', 'project.json'))).toBe(true)
    expect(readFileSync(join(ws, '.hive', 'assistant', '.hive', 'project.json'), 'utf8')).toBe('{"old":true}')
    expect(await movedPath(ws, join(ws, '.hive', 'assistant', '.hive', 'x.png'))).toBeNull()
    expect(await movedPath(ws, join(ws, '.combwork', 'assistant', '.hive', 'x.png'))).toBe(join(ws, '.combwork', 'assistant', '.combwork', 'x.png'))
  })

  it('a .hive made again after the rename, holding a workspace and a file named like an old plan: byte for byte untouched through recovery and finish', async () => {
    const ws = workspace10()
    moveTestHooks.after = (step) => {
      if (step === 'renamed:workspace') throw new Error('stopped')
    }
    await expect(openMove(ws)).rejects.toThrow('stopped')
    delete moveTestHooks.after
    const files: Record<string, string> = { 'workspace.json': '{"recreated":true}', 'combwork-move.json': '{"id":"theirs"}', 'combwork-move.json.bak': '{"id":"theirs-bak"}', 'combwork-moved.json': '{"theirs":1}' }
    for (const [f, t] of Object.entries(files)) write(join(ws, '.hive', f), t)
    await openMove(ws)
    expect(Object.fromEntries(readdirSync(join(ws, '.hive')).map((f) => [f, readFileSync(join(ws, '.hive', f), 'utf8')]))).toEqual(files)
    expect(existsSync(join(ws, 'alpha', '.combwork', 'project.json'))).toBe(true)
    expect(doneFor(ws)).toBe(true)
    expect(told.toasts.some((t) => t.title.includes(ws) && /both/.test(t.title))).toBe(true)
  })
})

describe('a project that comes later', () => {
  it('moves on its own into the moved workspace, joining the map', async () => {
    const ws = workspace10()
    await openMove(ws)
    json(join(ws, 'beta', '.hive', 'project.json'), { id: 'p-beta' })
    const r = await moveFolders(ws, { only: join(ws, 'beta') })
    expect(r.moved).toBe(1)
    if (r.late) await finishMove(ws, late(ws))
    expect(existsSync(join(ws, 'beta', '.combwork', 'project.json'))).toBe(true)
    expect(existsSync(join(ws, 'beta', '.hive'))).toBe(false)
    expect(await movedPath(ws, join(ws, 'beta', '.hive', 'x'))).toBe(join(ws, 'beta', '.combwork', 'x'))
  })
})

describe('before the open', () => {
  it("dataFolder is .combwork only (HI-2594); the move's own treeOf reads our .hive until it moves, never making a second tree", () => {
    const ws = workspace10()
    expect(dataFolder(ws)).toBe(join(ws, '.combwork'))
    expect(dataFolder(join(ws, 'alpha'))).toBe(join(ws, 'alpha', '.combwork'))
    expect(treeOf(ws)).toBe(join(ws, '.hive'))
    write(join(ws, 'gamma', '.hive', 'x'), '')
    expect(treeOf(join(ws, 'gamma'))).toBe(join(ws, 'gamma', '.combwork'))
    expect(existsSync(join(ws, '.combwork'))).toBe(false)
  })
})

describe('git', () => {
  it("Hive's exclude line follows, a user's stays; a worktree in .hive/slots stays registered, its changes intact", async () => {
    const ws = workspace10()
    const alpha = join(ws, 'alpha')
    git(alpha, 'init', '-q', '-b', 'main')
    write(join(alpha, '.git', 'info', 'exclude'), '# a user line\nbuild/\n# Hive project metadata (added by Hive)\n/.hive/\n')
    git(alpha, 'add', 'src.txt')
    git(alpha, 'commit', '-q', '-m', 'one')
    git(alpha, 'worktree', 'add', '-q', '-b', 'card', join(alpha, '.hive', 'slots', 'HI-1'))
    write(join(alpha, '.hive', 'slots', 'HI-1', 'src.txt'), 'changed')
    write(join(alpha, '.hive', 'slots', 'HI-1', 'new.txt'), 'untracked')
    await openMove(ws)
    expect(readFileSync(join(alpha, '.git', 'info', 'exclude'), 'utf8')).toBe('# a user line\nbuild/\n# Combwork project metadata (added by Combwork)\n/.combwork/\n')
    const slot = join(alpha, '.combwork', 'slots', 'HI-1')
    expect(git(alpha, 'worktree', 'list', '--porcelain').replace(/\//g, '\\').toLowerCase()).toContain(slot.toLowerCase())
    expect(git(slot, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([' M src.txt', '?? new.txt'])
    expect(git(slot, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('card')
  })
})

describe("the lock's file", () => {
  it('stays after the move, kept out of git when the workspace is in a repository', async () => {
    const ws = workspace10()
    git(ws, 'init', '-q', '-b', 'main')
    await openMove(ws)
    expect(existsSync(join(ws, MOVE_LOCK_FILE))).toBe(true)
    expect(readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\/\.combwork-move\.lock$/m)
    expect(git(ws, 'status', '--porcelain', '--untracked-files=all', '--', MOVE_LOCK_FILE)).toBe('')
  })
})

describe('two processes racing for one workspace', () => {
  const tmp = tempDir('combworkmove-race-')
  const bundle = join(tmp, 'child.cjs')
  const children: ChildProcess[] = []
  beforeAll(async () => {
    const entry = join(tmp, 'child-entry.cjs')
    writeFileSync(
      entry,
      `
const { appendFileSync, existsSync } = require('fs')
const m = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'combworkMove.ts'))})
const [ws, out, barrier, stopAt] = process.argv.slice(2)
const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 20)) }
m.moveTestHooks.looked = async () => { appendFileSync(out, 'looked\\n'); await until(() => existsSync(barrier)) }
// A stop at that step that never ends: the process is killed there, holding the lock (a crash mid-move).
if (stopAt) m.moveTestHooks.after = async (step) => { if (step === stopAt) { appendFileSync(out, 'stopped\\n'); setInterval(() => {}, 60000); await new Promise(() => {}) } }
m.moveFolders(ws).then((r) => appendFileSync(out, 'moved ' + r.moved + '\\n'), (e) => appendFileSync(out, 'refused ' + e.message + '\\n'))
`
    )
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs', electron: join(__dirname, 'electron-stub.ts') }, external: ['node:sqlite'], logLevel: 'silent' })
  }, 60_000)
  afterAll(() => {
    for (const c of children) if (c.exitCode === null) c.kill()
  })

  it('one killed mid-move, holding the lock: refused while it lives; then the next open takes over its dead row and finishes', async () => {
    const ws = workspace10()
    const barrier = join(tmp, `go${++n}`)
    writeFileSync(barrier, '')
    const out = join(tmp, `k${n}.txt`)
    writeFileSync(out, '')
    const child = spawn(process.execPath, [bundle, ws, out, barrier, 'renamed:workspace'], { env: { ...ctx.baseEnv(), CW_USER_DATA: join(tmp, `ud${n}`) }, stdio: 'ignore', windowsHide: true })
    children.push(child)
    await vi.waitFor(() => expect(readFileSync(out, 'utf8')).toContain('stopped'), WAIT)
    // While it lives, its row holds: this open is refused, nothing changed.
    await expect(moveFolders(ws)).rejects.toThrow(/Another Combwork is moving/)
    expect(existsSync(join(ws, 'alpha', '.hive'))).toBe(true)
    child.kill()
    await new Promise((r) => (child.exitCode !== null ? r(undefined) : child.once('exit', () => r(undefined))))
    await openMove(ws)
    expect(existsSync(join(ws, 'alpha', '.combwork', 'project.json'))).toBe(true)
    expect(existsSync(join(ws, '.hive'))).toBe(false)
    expect(cardText(ws).d).toContain(`${ws}\\alpha\\.combwork\\attachments`)
    // Every moved folder carries its marker: the dead one's and the taker's.
    for (const d of [join(ws, '.combwork'), join(ws, 'alpha', '.combwork'), join(ws, '.combwork', 'assistant', '.combwork')]) expect(existsSync(join(d, MARK_FILE)), d).toBe(true)
  })

  it('both paused after seeing it unclaimed, released together: exactly one moves it, the other writes nothing', async () => {
    const ws = workspace10()
    const barrier = join(tmp, `go${++n}`)
    const outs = [join(tmp, `a${n}.txt`), join(tmp, `b${n}.txt`)]
    for (const o of outs) {
      writeFileSync(o, '')
      children.push(spawn(process.execPath, [bundle, ws, o, barrier], { env: { ...ctx.baseEnv(), CW_USER_DATA: join(tmp, `ud${n}`) }, stdio: 'ignore', windowsHide: true }))
    }
    const lines = (o: string): string[] => readFileSync(o, 'utf8').split('\n').filter(Boolean)
    await vi.waitFor(() => expect(outs.every((o) => lines(o).includes('looked'))).toBe(true), WAIT)
    writeFileSync(barrier, '')
    await vi.waitFor(() => expect(outs.every((o) => lines(o).length === 2)).toBe(true), WAIT)
    const ends = outs.map((o) => lines(o)[1])
    // The winner moved every host (the workspace, its Assistant, alpha); the other was refused, or found nothing left.
    expect(ends.filter((e) => e === 'moved 3')).toHaveLength(1)
    expect(ends.filter((e) => e !== 'moved 3').every((e) => e === 'moved 0' || e.startsWith('refused Another Combwork is moving'))).toBe(true)
    // One plan's id in every moved host, and the map once each.
    const ids = new Set([join(ws, '.combwork'), join(ws, 'alpha', '.combwork'), join(ws, '.combwork', 'assistant', '.combwork')].map((d) => JSON.parse(readFileSync(join(d, MARK_FILE), 'utf8')).id))
    expect(ids.size).toBe(1)
    const moves = await movedFolders(ws)
    expect(moves.map((m) => m.from).sort()).toEqual([join(ws, '.combwork', 'assistant', '.hive'), join(ws, '.hive'), join(ws, '.hive', 'assistant', '.hive'), join(ws, 'alpha', '.hive')].sort())
  })
})
