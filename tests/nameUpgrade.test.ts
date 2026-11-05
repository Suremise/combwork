// HI-2587: the names upgrade at a workspace's open (nameUpgrade.ts; the design is the card's, HI-2587/s15 with s20, s23,
// s26 and s40). Real folders, git and SQLite: a 1.0 workspace (.hive, hive.db) and an RC2 one (.combwork, hive.db) both
// end the same: combwork.db holding every card, the .gitignore, README and MCP definitions in Combwork's names, the skill
// copies' markers renamed in the project and in a slot the board's records name, git's exclude comments Combwork's, and
// the record written; the next open takes no lock. A run stopped at each step finishes at the next open; a new workspace
// writes its record at once; a project with nothing old is left byte for byte.
import { execFileSync, spawn } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

vi.mock('../src/main/events', async (orig) => ({ ...(await orig<object>()), toast: () => undefined }))

const base = tempDir('nameupgrade-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { MOVE_LOCK_FILE, finishMove, moveFolders, recordNewWorkspace } = await import('../src/main/combworkMove')
const { NAMES_DONE_FILE, NAMES_VERSION, projectNamesDone } = await import('../src/main/nameUpgrade')
const { boardMoveTestHooks } = await import('../src/main/boardFileMove')
const { contentHash } = await import('../src/main/fsutil')
const { stubTestHooks } = await import('../src/main/nameUpgradeFiles')
const { WORKSPACE_README, BOARD_GITIGNORE } = await import('../src/main/workspace')

let n = 0
const write = (p: string, text: string): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

/** A card an older Hive saved in the board's stub. */
const STUB_CARD = '{"number":7,"title":"Made in an older Hive"}'

const OLD_GITIGNORE = "# The task board's database and what moving it from files left (added by Hive, #1017)\nhive.db\nhive.db-*\nbackups/\n"
const OLD_EXCLUDE = "# Hive project metadata (added by Hive)\n/.combwork/\n# Hive's copies of workspace skills for Codex and Copilot (added by Hive)\n/.agents/skills/cw-*/\n/.agents/skills/.cw-*/\n/.agents/skills/hive-*/\n/.agents/skills/.hive-*/\n"

/**
 * A copy Combwork made before HI-2463 (`hive-<skill>`, with the old marker), its marker's hash its content's: provably
 * Combwork's and unchanged (HI-2594). `edited`: changed since, so its content is no longer the hash.
 */
async function oldCopy(folder: string, skill: string, edited = false): Promise<string> {
  const dir = join(folder, '.agents', 'skills', `hive-${skill}`)
  write(join(dir, 'SKILL.md'), `# ${skill}`)
  const hash = await contentHash(dir)
  write(join(dir, '.hive-copy'), JSON.stringify({ source: 's', hash }))
  if (edited) writeFileSync(join(dir, 'SKILL.md'), `# ${skill}, edited`)
  return dir
}

/**
 * A workspace as 1.0 (`.hive`) or an RC2 (`.combwork`) left it, with its board, a project in git with a skill copy, and a
 * slot; with `copies`, each also holds copies under the old prefix (HI-2594): Combwork's unchanged, one edited since, and
 * a folder of the user's.
 */
async function withOldCopies(w: { ws: string; alpha: string; slot: string }): Promise<{ gone: string[]; kept: string[] }> {
  const gone = [await oldCopy(w.alpha, 'merge-ready'), await oldCopy(w.slot, 'merge-ready')]
  const kept = [await oldCopy(w.alpha, 'handover', true), join(w.alpha, '.agents', 'skills', 'hive-mine')]
  write(join(kept[1], 'SKILL.md'), '# mine')
  return { gone, kept }
}

function workspace(kind: '1.0' | 'rc2'): { ws: string; alpha: string; slot: string } {
  const ws = join(base, `ws${++n}`)
  const tree = kind === '1.0' ? '.hive' : '.combwork'
  write(join(ws, tree, 'workspace.json'), '{}')
  write(join(ws, tree, '.gitignore'), OLD_GITIGNORE)
  write(join(ws, tree, 'README.md'), WORKSPACE_README.replace('`combwork.db`', '`hive.db`'))
  write(join(ws, tree, 'mcp', 'srv.json'), '{"command":"${HIVE_MCP_DIR}/srv/run.cmd"}')
  const alpha = join(ws, 'alpha')
  write(join(alpha, tree, 'project.json'), '{}')
  git(ws, 'init', '-q', alpha)
  // A submission's pin and a test merge's ref under Hive's prefix (HI-2593's handoff), at a commit of the project's.
  write(join(alpha, 'src.txt'), 'code')
  git(alpha, 'add', 'src.txt')
  git(alpha, 'commit', '-q', '-m', 'one')
  git(alpha, 'update-ref', 'refs/hive/cards/AL-1/1', 'HEAD')
  git(alpha, 'update-ref', 'refs/hive/queue/AL-1-e1', 'HEAD')
  write(join(alpha, '.git', 'info', 'exclude'), OLD_EXCLUDE)
  write(join(alpha, '.agents', 'skills', 'cw-handover', 'SKILL.md'), '# h')
  write(join(alpha, '.agents', 'skills', 'cw-handover', '.hive-copy'), '{"source":"s","hash":"h1"}')
  const slot = join(ws, 'worktrees', 'alpha', 'slot-a')
  write(join(slot, '.agents', 'skills', 'cw-handover', '.hive-copy'), '{"source":"s","hash":"h2"}')
  const db = new DatabaseSync(join(ws, tree, 'hive.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE cards (number INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT \'\') STRICT')
  // The tables the folder move's card rewrite reads (a 1.0 board's), so its late phases finish.
  db.exec('CREATE TABLE card_comments (card INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT, PRIMARY KEY (card, ord)) STRICT')
  db.exec('CREATE TABLE card_context (card INTEGER NOT NULL, ord INTEGER NOT NULL, ref TEXT NOT NULL, PRIMARY KEY (card, ord)) STRICT')
  db.exec('CREATE TABLE skill_copies (folder TEXT NOT NULL, skill TEXT NOT NULL, project TEXT NOT NULL, revision TEXT NOT NULL, made_at TEXT NOT NULL, PRIMARY KEY (folder, skill)) STRICT')
  db.prepare('INSERT INTO cards (number, title) VALUES (1, ?)').run('One')
  // The stub 0.9 to 1.0 left for older versions (#1017), with a card an older Hive saved in it (HI-2594).
  write(join(ws, tree, 'tasks', 'board.json'), '{"version":1,"next":2}')
  write(join(ws, tree, 'tasks', 'README.txt'), 'The task board moved to .hive/hive.db in Hive 0.9 (#1017).\r\n')
  write(join(ws, tree, 'tasks', '7.json'), STUB_CARD)
  db.prepare('INSERT INTO skill_copies VALUES (?, ?, ?, ?, ?)').run(slot, 'handover', 'alpha', 'h2', 'now')
  db.close()
  return { ws, alpha, slot }
}

function expectUpgraded(w: { ws: string; alpha: string; slot: string }): void {
  const dir = join(w.ws, '.combwork')
  const db = new DatabaseSync(join(dir, 'combwork.db'), { readOnly: true })
  expect((db.prepare('SELECT title FROM cards').all() as { title: string }[]).map((r) => r.title)).toEqual(['One'])
  db.close()
  expect(readdirSync(dir).filter((f) => f.startsWith('hive'))).toEqual([])
  // The stub's card set aside, intact, and the stub gone (HI-2594).
  expect(readdirSync(dir).filter((f) => f.startsWith('tasks'))).toEqual(['tasks.set-aside'])
  expect(readFileSync(join(dir, 'tasks.set-aside', '7.json'), 'utf8')).toBe(STUB_CARD)
  expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toMatch(/^# The task board's database .*\(added by Combwork, #1017\)\ncombwork\.db\ncombwork\.db-\*\n/)
  expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe(WORKSPACE_README)
  expect(readFileSync(join(dir, 'mcp', 'srv.json'), 'utf8')).toBe('{"command":"${CW_MCP_DIR}/srv/run.cmd"}')
  for (const [f, hash] of [[w.alpha, 'h1'], [w.slot, 'h2']]) {
    const copy = join(f, '.agents', 'skills', 'cw-handover')
    expect(existsSync(join(copy, '.hive-copy'))).toBe(false)
    expect(JSON.parse(readFileSync(join(copy, '.combwork-copy'), 'utf8')).hash).toBe(hash)
  }
  const exclude = readFileSync(join(w.alpha, '.git', 'info', 'exclude'), 'utf8')
  expect(exclude).not.toMatch(/Hive|hive/)
  expect(exclude).toContain('# Combwork project metadata (added by Combwork)')
  // The old copies' lines gone (HI-2594), Combwork's own kept.
  expect(exclude.split('\n').filter((l) => l.startsWith('/.agents/'))).toEqual(['/.agents/skills/cw-*/', '/.agents/skills/.cw-*/'])
  const head = git(w.alpha, 'rev-parse', 'HEAD').trim()
  expect(git(w.alpha, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/hive', 'refs/cw').trim().split('\n').sort()).toEqual([`refs/cw/cards/AL-1/1 ${head}`, `refs/cw/queue/AL-1-e1 ${head}`])
  expect(JSON.parse(readFileSync(join(dir, NAMES_DONE_FILE), 'utf8')).version).toBe(NAMES_VERSION)
}

/** An open's move: the folders, then (a 1.0 workspace) its late phases, as the workspace's open runs them. */
async function open(ws: string): Promise<void> {
  const r = await moveFolders(ws)
  if (r.late) await finishMove(ws, { boardFile: join(ws, '.combwork', 'combwork.db'), relocateFolders: async () => true })
}

beforeEach(() => {
  boardMoveTestHooks.after = undefined
})

describe('the names upgrade at the open', () => {
  for (const kind of ['1.0', 'rc2'] as const) {
    it(`a ${kind} workspace ends upgraded; the next open takes no lock and writes nothing`, async () => {
      const w = workspace(kind)
      await open(w.ws)
      expectUpgraded(w)
      const lock = join(w.ws, MOVE_LOCK_FILE)
      const before = readFileSync(lock)
      const record = readFileSync(join(w.ws, '.combwork', NAMES_DONE_FILE), 'utf8')
      await open(w.ws)
      expect(readFileSync(lock).equals(before)).toBe(true)
      expect(readFileSync(join(w.ws, '.combwork', NAMES_DONE_FILE), 'utf8')).toBe(record)
    })
  }

  for (const kind of ['1.0', 'rc2'] as const) {
    it(`a ${kind} workspace's copies under the old prefix: Combwork's unchanged ones retired, in the project and in a slot; an edited one and the user's kept (HI-2594)`, async () => {
      const w = workspace(kind)
      const { gone, kept } = await withOldCopies(w)
      await open(w.ws)
      expectUpgraded(w)
      for (const d of gone) expect(existsSync(d), d).toBe(false)
      for (const d of kept) expect(existsSync(join(d, 'SKILL.md')), d).toBe(true)
      expect(readFileSync(join(kept[0], 'SKILL.md'), 'utf8')).toBe('# handover, edited')
      // Its marker renamed (it is still the copy Combwork made), its content the user's.
      expect(existsSync(join(kept[0], '.combwork-copy'))).toBe(true)
      // The cw- copies are untouched.
      expect(existsSync(join(w.alpha, '.agents', 'skills', 'cw-handover', '.combwork-copy'))).toBe(true)
    })
  }

  it("a workspace the first version of the upgrade recorded (version 1): every step runs again, and the old copies left go (HI-2594)", async () => {
    const w = workspace('rc2')
    await open(w.ws)
    writeFileSync(join(w.ws, '.combwork', NAMES_DONE_FILE), JSON.stringify({ version: 1, at: '2026-11-05T00:00:00.000Z' }) + '\n')
    writeFileSync(join(w.alpha, '.combwork', NAMES_DONE_FILE), JSON.stringify({ version: 1, at: '2026-11-05T00:00:00.000Z' }) + '\n')
    const { gone } = await withOldCopies(w)
    await open(w.ws)
    expectUpgraded(w)
    for (const d of gone) expect(existsSync(d), d).toBe(false)
  })

  it('a run stopped after the board moved: no record yet, so the next open does every step and finishes', async () => {
    const w = workspace('rc2')
    boardMoveTestHooks.after = (p) => {
      if (p === 'renamed') throw new Error('crashed')
    }
    await expect(open(w.ws)).rejects.toThrow()
    boardMoveTestHooks.after = undefined
    expect(existsSync(join(w.ws, '.combwork', NAMES_DONE_FILE))).toBe(false)
    expect(existsSync(join(w.ws, '.combwork', 'combwork.db'))).toBe(true)
    await open(w.ws)
    expectUpgraded(w)
  })

  it('a ref already made under refs/cw (a run stopped between its two writes): the old one goes, the new one kept', async () => {
    const w = workspace('rc2')
    git(w.alpha, 'update-ref', 'refs/cw/cards/AL-1/1', 'HEAD')
    await open(w.ws)
    expectUpgraded(w)
  })

  it('a ref under both names at different commits: neither is touched, no commit loses its ref; the others move', async () => {
    const w = workspace('rc2')
    const first = git(w.alpha, 'rev-parse', 'HEAD').trim()
    write(join(w.alpha, 'two.txt'), 'two')
    git(w.alpha, 'add', 'two.txt')
    git(w.alpha, 'commit', '-q', '-m', 'two')
    const second = git(w.alpha, 'rev-parse', 'HEAD').trim()
    git(w.alpha, 'update-ref', 'refs/cw/cards/AL-1/1', second)
    await open(w.ws)
    const refs = git(w.alpha, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/hive', 'refs/cw').trim().split('\n').sort()
    expect(refs).toEqual([`refs/cw/cards/AL-1/1 ${second}`, `refs/cw/queue/AL-1-e1 ${first}`, `refs/hive/cards/AL-1/1 ${first}`])
  })

  it('a step that fails refuses the open naming it; the next open finishes', async () => {
    const w = workspace('rc2')
    // A read-only definition can't be replaced: the files step fails.
    const def = join(w.ws, '.combwork', 'mcp', 'srv.json')
    chmodSync(def, 0o444)
    await expect(open(w.ws)).rejects.toThrow(/couldn't finish renaming the workspace's settings, templates, .gitignore, README and MCP definitions/)
    expect(existsSync(join(w.ws, '.combwork', NAMES_DONE_FILE))).toBe(false)
    chmodSync(def, 0o644)
    await open(w.ws)
    expectUpgraded(w)
  })

  it("a folder a step can't list fails the step, nothing recorded; once it can be, the next open finishes (HR2's round 1)", async () => {
    const w = workspace('rc2')
    // Not a folder where the step lists one: an error other than its absence.
    const skills = join(w.alpha, '.agents', 'skills')
    const { renameSync, rmSync } = await import('fs')
    renameSync(skills, `${skills}.kept`)
    writeFileSync(skills, 'not a folder')
    await expect(open(w.ws)).rejects.toThrow(/couldn't finish renaming the projects' settings, templates, skill copies, git exclude lines and refs/)
    expect(existsSync(join(w.ws, '.combwork', NAMES_DONE_FILE))).toBe(false)
    rmSync(skills)
    renameSync(`${skills}.kept`, skills)
    await open(w.ws)
    expectUpgraded(w)
  })

  it("a board file that can't be looked at fails the files step: the stub and its card left, nothing recorded; once it can be, the next open finishes (HR1's round 2)", async () => {
    const w = workspace('rc2')
    const { lstat } = await import('fs/promises')
    const board = join(w.ws, '.combwork', 'combwork.db')
    stubTestHooks.stat = async (p) => {
      if (p === board) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
      return lstat(p)
    }
    try {
      await expect(open(w.ws)).rejects.toThrow(/couldn't finish renaming the workspace's \.gitignore, README and MCP definitions/)
    } finally {
      stubTestHooks.stat = undefined
    }
    expect(existsSync(join(w.ws, '.combwork', NAMES_DONE_FILE))).toBe(false)
    expect(readFileSync(join(w.ws, '.combwork', 'tasks', '7.json'), 'utf8')).toBe(STUB_CARD)
    expect(existsSync(join(w.ws, '.combwork', 'tasks.set-aside'))).toBe(false)
    await open(w.ws)
    expectUpgraded(w)
  })

  it("a project that comes into an upgraded workspace with an RC's .combwork: its own steps by its own record, under the move's lock, refused while another Combwork has the workspace open (HR2's rounds 1 and 2)", async () => {
    const w = workspace('rc2')
    await open(w.ws)
    expectUpgraded(w)
    expect(existsSync(join(w.alpha, '.combwork', NAMES_DONE_FILE))).toBe(true)
    // Copied in from an RC's workspace: its .combwork, an old marker, Hive's exclude comment, an old ref.
    const beta = join(w.ws, 'beta')
    write(join(beta, '.combwork', 'project.json'), '{}')
    git(w.ws, 'init', '-q', beta)
    write(join(beta, '.git', 'info', 'exclude'), OLD_EXCLUDE)
    write(join(beta, '.agents', 'skills', 'cw-handover', '.hive-copy'), '{"source":"s","hash":"b1"}')
    write(join(beta, 'b.txt'), 'b')
    git(beta, 'add', 'b.txt')
    git(beta, 'commit', '-q', '-m', 'b')
    git(beta, 'update-ref', 'refs/hive/cards/BE-1/1', 'HEAD')
    expect(await projectNamesDone(beta)).toBe(false)
    // An RC still has the workspace open (its presence marker, a live process): refused, nothing of beta's changed.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    const marker = join(w.ws, '.combwork', 'open', 'Combwork-rc2.json')
    try {
      write(marker, JSON.stringify({ pid: other.pid, profile: 'Combwork', hiveVersion: '1.1.0-rc.2', startedAt: new Date().toISOString(), heartbeat: new Date().toISOString() }))
      await expect(moveFolders(w.ws, { only: beta })).rejects.toThrow(/open in another Combwork or Hive \(Combwork\)/)
      expect(existsSync(join(beta, '.agents', 'skills', 'cw-handover', '.hive-copy'))).toBe(true)
      expect(readFileSync(join(beta, '.git', 'info', 'exclude'), 'utf8')).toBe(OLD_EXCLUDE)
      expect(git(beta, 'for-each-ref', '--format=%(refname)', 'refs/hive', 'refs/cw').trim()).toBe('refs/hive/cards/BE-1/1')
      expect(await projectNamesDone(beta)).toBe(false)
    } finally {
      other.kill()
      await new Promise((r) => (other.exitCode !== null ? r(undefined) : other.once('exit', () => r(undefined))))
    }
    // Once it has gone: the retry converts it under the lock and records it.
    await moveFolders(w.ws, { only: beta })
    expect(existsSync(join(beta, '.agents', 'skills', 'cw-handover', '.combwork-copy'))).toBe(true)
    expect(readFileSync(join(beta, '.git', 'info', 'exclude'), 'utf8')).not.toMatch(/Hive/)
    expect(git(beta, 'for-each-ref', '--format=%(refname)', 'refs/hive', 'refs/cw').trim()).toBe('refs/cw/cards/BE-1/1')
    expect(await projectNamesDone(beta)).toBe(true)
  })

  it('every entry point, with another Combwork present: nothing written, refused (or put off); once it exits, the retry completes (HR2 rounds 2 and 3)', async () => {
    // A live process with an RC's presence marker in the workspace's .combwork.
    const present = (ws: string) => {
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
      write(join(ws, '.combwork', 'open', 'Combwork-other.json'), JSON.stringify({ pid: other.pid, profile: 'Combwork', hiveVersion: '1.1.0-rc.2', startedAt: new Date().toISOString(), heartbeat: new Date().toISOString() }))
      return async () => {
        other.kill()
        await new Promise((r) => (other.exitCode !== null ? r(undefined) : other.once('exit', () => r(undefined))))
      }
    }
    // Every file under the workspace (git's objects aside, and the lock's own file, which a lock writes), with its bytes,
    // and every ref: what "nothing written" is checked against.
    const snapshot = (ws: string): string => {
      const out: string[] = []
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const f = join(d, e.name)
          if (e.isDirectory()) {
            if (e.name !== 'objects' && e.name !== 'logs') walk(f)
          } else if (e.name !== MOVE_LOCK_FILE && e.name !== 'Combwork-other.json') out.push(`${f} ${readFileSync(f).toString('base64')}`)
        }
      }
      walk(ws)
      return out.sort().join('\n')
    }
    const refs = (repo: string): string => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)')

    // 1. A workspace's open (an RC2's, its names not upgraded).
    {
      const w = workspace('rc2')
      const gone = present(w.ws)
      const before = snapshot(w.ws)
      const beforeRefs = refs(w.alpha)
      await expect(open(w.ws)).rejects.toThrow(/open in another Combwork or Hive \(Combwork\)/)
      expect(snapshot(w.ws)).toBe(before)
      expect(refs(w.alpha)).toBe(beforeRefs)
      await gone()
      await open(w.ws)
      expectUpgraded(w)
    }
    // 2. A project that comes later, with something old, and 3. one with nothing old.
    {
      const w = workspace('rc2')
      await open(w.ws)
      const beta = join(w.ws, 'beta')
      write(join(beta, '.combwork', 'project.json'), '{}')
      write(join(beta, '.agents', 'skills', 'cw-handover', '.hive-copy'), '{"source":"s","hash":"b1"}')
      const gamma = join(w.ws, 'gamma')
      write(join(gamma, '.combwork', 'project.json'), '{}')
      const gone = present(w.ws)
      const before = snapshot(w.ws)
      for (const p of [beta, gamma]) await expect(moveFolders(w.ws, { only: p })).rejects.toThrow(/open in another Combwork or Hive/)
      expect(snapshot(w.ws)).toBe(before)
      expect([await projectNamesDone(beta), await projectNamesDone(gamma)]).toEqual([false, false])
      await gone()
      for (const p of [beta, gamma]) await moveFolders(w.ws, { only: p })
      expect([await projectNamesDone(beta), await projectNamesDone(gamma)]).toEqual([true, true])
      expect(existsSync(join(beta, '.agents', 'skills', 'cw-handover', '.combwork-copy'))).toBe(true)
    }
    // 4. A workspace just made: its record written only with no other process there.
    {
      const ws = join(base, `made${++n}`)
      write(join(ws, '.combwork', 'workspace.json'), '{}')
      const gone = present(ws)
      await recordNewWorkspace(ws)
      expect(existsSync(join(ws, '.combwork', NAMES_DONE_FILE))).toBe(false)
      await gone()
      await recordNewWorkspace(ws)
      expect(existsSync(join(ws, '.combwork', NAMES_DONE_FILE))).toBe(true)
    }
  })

  it("a new workspace's first open writes nothing; once made, its record is there and its .gitignore keeps it out", async () => {
    const ws = join(base, `new${++n}`)
    mkdirSync(join(ws, 'alpha'), { recursive: true })
    await moveFolders(ws)
    expect(readdirSync(ws)).toEqual(['alpha'])
    expect(BOARD_GITIGNORE).toContain('combwork-names.json')
  })
})
