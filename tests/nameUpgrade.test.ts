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
const { MOVE_LOCK_FILE, finishMove, moveFolders } = await import('../src/main/combworkMove')
const { NAMES_DONE_FILE, projectNamesDone } = await import('../src/main/nameUpgrade')
const { boardMoveTestHooks } = await import('../src/main/boardFileMove')
const { WORKSPACE_README, BOARD_GITIGNORE } = await import('../src/main/workspace')

let n = 0
const write = (p: string, text: string): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })

const OLD_GITIGNORE = "# The task board's database and what moving it from files left (added by Hive, #1017)\nhive.db\nhive.db-*\nbackups/\n"
const OLD_EXCLUDE = "# Hive project metadata (added by Hive)\n/.combwork/\n# Hive's copies of workspace skills for Codex and Copilot (added by Hive)\n/.agents/skills/cw-*/\n"

/** A workspace as 1.0 (`.hive`) or an RC2 (`.combwork`) left it, with its board, a project in git with a skill copy, and a slot. */
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
  expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toMatch(/^# The task board's database .*\(added by Combwork, #1017\)\ncombwork\.db\ncombwork\.db-\*\n/)
  expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe(WORKSPACE_README)
  expect(readFileSync(join(dir, 'mcp', 'srv.json'), 'utf8')).toBe('{"command":"${CW_MCP_DIR}/srv/run.cmd"}')
  for (const [f, hash] of [[w.alpha, 'h1'], [w.slot, 'h2']]) {
    const copy = join(f, '.agents', 'skills', 'cw-handover')
    expect(existsSync(join(copy, '.hive-copy'))).toBe(false)
    expect(JSON.parse(readFileSync(join(copy, '.combwork-copy'), 'utf8')).hash).toBe(hash)
  }
  const exclude = readFileSync(join(w.alpha, '.git', 'info', 'exclude'), 'utf8')
  expect(exclude).not.toMatch(/Hive/)
  expect(exclude).toContain('# Combwork project metadata (added by Combwork)')
  const head = git(w.alpha, 'rev-parse', 'HEAD').trim()
  expect(git(w.alpha, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/hive', 'refs/cw').trim().split('\n').sort()).toEqual([`refs/cw/cards/AL-1/1 ${head}`, `refs/cw/queue/AL-1-e1 ${head}`])
  expect(JSON.parse(readFileSync(join(dir, NAMES_DONE_FILE), 'utf8')).version).toBe(1)
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
    await expect(open(w.ws)).rejects.toThrow(/couldn't finish renaming the workspace's .gitignore, README and MCP definitions/)
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
    await expect(open(w.ws)).rejects.toThrow(/couldn't finish renaming the projects' skill copies, git exclude lines and refs/)
    expect(existsSync(join(w.ws, '.combwork', NAMES_DONE_FILE))).toBe(false)
    rmSync(skills)
    renameSync(`${skills}.kept`, skills)
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

  it('a new project with nothing old is recorded with no lock, even while another Combwork has the workspace open', async () => {
    const w = workspace('rc2')
    await open(w.ws)
    const gamma = join(w.ws, 'gamma')
    write(join(gamma, '.combwork', 'project.json'), '{}')
    git(w.ws, 'init', '-q', gamma)
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    try {
      write(join(w.ws, '.combwork', 'open', 'Combwork-other.json'), JSON.stringify({ pid: other.pid, profile: 'Combwork', appVersion: '1.1.0', startedAt: new Date().toISOString(), heartbeat: new Date().toISOString() }))
      const lock = join(w.ws, MOVE_LOCK_FILE)
      const before = readFileSync(lock)
      await moveFolders(w.ws, { only: gamma })
      expect(await projectNamesDone(gamma)).toBe(true)
      expect(readFileSync(lock).equals(before)).toBe(true)
    } finally {
      other.kill()
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
