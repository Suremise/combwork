// The CLIs' recorded cwd against Combwork's spelling of a folder (#493). Started in a folder named through a junction or an
// 8.3 short name, Codex and Copilot record the cwd as given, and Claude Code files its transcripts under Node's realpath
// of it (the junction followed, an 8.3 name kept; checked with Claude Code 2.1.296, Codex 0.162.1, Copilot 1.0.95).
// Combwork finds a folder's sessions by place, whichever name it has now. Each test uses a junction, which makes another name
// on any machine (tests/pathAliases.ts), and an 8.3 name where the volume makes them.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { junction, shortPath } from './pathAliases'
import { tempDir } from './tempDir'

const { ClaudeCodeAdapter, MAY_BE_SHORT, claudeSpelling } = await import('../src/main/providers/claude/adapter')
const { CodexAdapter } = await import('../src/main/providers/codex/adapter')
const { listCopilotSessions } = await import('../src/main/providers/copilot/events')
const { encodeProjectPath } = await import('../src/main/providers/claude/usage')
const { placeMatcher } = await import('../src/main/fsutil')

const ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const ID2 = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c'
const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME }
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
})

/** A folder with a long name, a junction to it, and its 8.3 name where the volume has one. */
function place(): { base: string; real: string; via: string; short: string | null } {
  const base = tempDir('hive-cliplaces-')
  const real = join(base, 'RealFolderWithLongName')
  mkdirSync(real)
  return { base, real, via: junction(real, join(base, 'via-junction')), short: shortPath(real) }
}

describe('placeMatcher (#493)', () => {
  it('matches a spelling, the folder through a junction or by its 8.3 name, and nothing else', () => {
    const p = place()
    const here = placeMatcher(p.via)
    expect(here(p.via.toUpperCase())).toBe(true)
    expect(here(p.real)).toBe(true)
    if (p.short) expect(here(p.short)).toBe(true)
    expect(here(p.base)).toBe(false)
    expect(here(join(p.base, 'missing'))).toBe(false)
  })
})

describe("Claude Code's transcript folder (#493)", () => {
  it('finds a session started through a junction, filed under the real path, and restores where Claude Code looks', async () => {
    const p = place()
    process.env.CLAUDE_CONFIG_DIR = join(p.base, 'claude-home')
    // Claude Code, started in the junction, names its folder by the real path.
    expect(claudeSpelling(p.via)).toBe(p.real)
    const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', encodeProjectPath(p.real))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ID}.jsonl`), '{"type":"user"}\n')
    const claude = new ClaudeCodeAdapter()
    expect((await claude.listSessions(p.via)).map((s) => s.id)).toEqual([ID])
    expect(await claude.transcriptPath(p.via, ID)).toBe(join(dir, `${ID}.jsonl`))
    expect(claude.restorePath(p.via, ID)).toBe(join(dir, `${ID}.jsonl`))
  })

  it("keeps an 8.3 name as Claude Code does, and finds that folder's sessions by the long name and a junction too", async () => {
    const p = place()
    if (!p.short) return // The volume makes no 8.3 names.
    process.env.CLAUDE_CONFIG_DIR = join(p.base, 'claude-home')
    expect(claudeSpelling(p.short)).toBe(p.short)
    const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', encodeProjectPath(p.short))
    mkdirSync(dir, { recursive: true })
    // As Claude Code writes it: its first lines carry no cwd.
    writeFileSync(join(dir, `${ID}.jsonl`), `{"type":"custom-title","customTitle":"t"}\n${JSON.stringify({ type: 'user', cwd: p.short, sessionId: ID })}\n`)
    // Another folder's, also under a name that may hold an 8.3 one: not this folder's.
    const elsewhere = join(process.env.CLAUDE_CONFIG_DIR, 'projects', encodeProjectPath(join(p.base, 'OTHER~1')))
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, `${ID2}.jsonl`), JSON.stringify({ type: 'user', cwd: join(p.base, 'OTHER~1') }) + '\n')
    const claude = new ClaudeCodeAdapter()
    for (const name of [p.short, p.real, p.via]) {
      expect((await claude.listSessions(name)).map((s) => s.id)).toEqual([ID])
      expect(await claude.transcriptPath(name, ID)).toBe(join(dir, `${ID}.jsonl`))
    }
  })

  it('finds an 8.3-named session once its transcript records a cwd, on the same adapter', async () => {
    const p = place()
    if (!p.short) return // The volume makes no 8.3 names.
    process.env.CLAUDE_CONFIG_DIR = join(p.base, 'claude-home')
    const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', encodeProjectPath(p.short))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${ID}.jsonl`)
    // Just started: only lines with no cwd yet.
    writeFileSync(file, '{"type":"custom-title","customTitle":"t"}\n')
    const claude = new ClaudeCodeAdapter()
    expect(await claude.listSessions(p.real)).toEqual([])
    // Its first prompt adds a line with the cwd: that changes the file, not the folder.
    appendFileSync(file, JSON.stringify({ type: 'user', cwd: p.short, sessionId: ID }) + '\n')
    expect((await claude.listSessions(p.real)).map((s) => s.id)).toEqual([ID])
  })

  it('looks for 8.3 names only in folders whose names may hold one (HI-1681)', () => {
    // `~n` after at most six characters of a name, its own `-`s included; the encoded drive and separators are `-` too.
    for (const n of ['C--Users-RUNNER-1-AppData', 'C--x-REALFO-1', 'C--combwork-test-BUILD--1', 'C--a-PROGRA-1-b', 'D--x-HIVE-T-12']) expect(MAY_BE_SHORT.test(n), n).toBe(true)
    for (const n of ['C--other-project-123', 'C--Users-Darren-AppData', 'D--Development-worktrees-review7']) expect(MAY_BE_SHORT.test(n), n).toBe(false)
  })

  it("finds a folder's first session once Claude Code makes its folder, on the same adapter (#1649)", async () => {
    const p = place()
    process.env.CLAUDE_CONFIG_DIR = join(p.base, 'claude-home')
    const projects = join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    mkdirSync(join(projects, encodeProjectPath(join(p.base, 'Other'))), { recursive: true })
    const claude = new ClaudeCodeAdapter()
    // Looked up before it has any: the projects folder's names are kept while it is unchanged.
    expect(await claude.transcriptPath(p.real, ID)).toBeNull()
    expect(await claude.transcriptPath(p.real, ID)).toBeNull()
    const dir = join(projects, encodeProjectPath(p.real))
    mkdirSync(dir)
    writeFileSync(join(dir, `${ID}.jsonl`), '{"type":"user"}\n')
    expect(await claude.transcriptPath(p.real, ID)).toBe(join(dir, `${ID}.jsonl`))
    expect((await claude.listSessions(p.via)).map((s) => s.id)).toEqual([ID])
  })

  // A folder's time is a clock tick's: a change in the tick it was read in leaves the time as it was. Setting the time
  // back after a change is that, every time.
  it('finds a folder Claude Code makes in the tick the projects folder was read in, and a transcript added so (HI-2446)', async () => {
    const p = place()
    process.env.CLAUDE_CONFIG_DIR = join(p.base, 'claude-home')
    const projects = join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    mkdirSync(join(projects, encodeProjectPath(join(p.base, 'Other'))), { recursive: true })
    const claude = new ClaudeCodeAdapter()
    // Whole milliseconds, so that setting it again gives the very time read (a stat's has a fraction). The clock stays
    // at that time too, so each read is in its tick however long the test takes.
    const tick = new Date()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(tick)
    try {
      utimesSync(projects, tick, tick)
      expect(await claude.transcriptPath(p.real, ID)).toBeNull()
      const dir = join(projects, encodeProjectPath(p.real))
      mkdirSync(dir)
      writeFileSync(join(dir, `${ID}.jsonl`), '{"type":"user"}\n')
      utimesSync(projects, tick, tick)
      expect(statSync(projects).mtimeMs).toBe(tick.getTime())
      expect(await claude.transcriptPath(p.real, ID)).toBe(join(dir, `${ID}.jsonl`))
      // The same in a transcript folder: its second session, added in the tick its names were read in.
      utimesSync(dir, tick, tick)
      expect((await claude.listSessions(p.real)).map((s) => s.id)).toEqual([ID])
      writeFileSync(join(dir, `${ID2}.jsonl`), '{"type":"user"}\n')
      utimesSync(dir, tick, tick)
      expect(statSync(dir).mtimeMs).toBe(tick.getTime())
      expect((await claude.listSessions(p.real)).map((s) => s.id).sort()).toEqual([ID, ID2].sort())
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the names of a projects folder that has settled while its time is unchanged (#1649)', async () => {
    const p = place()
    process.env.CLAUDE_CONFIG_DIR = join(p.base, 'claude-home')
    const projects = join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    mkdirSync(join(projects, encodeProjectPath(join(p.base, 'Other'))), { recursive: true })
    // Read a minute after its time: settled, whatever the real clock says.
    const old = new Date(Date.now() - 60_000)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(old.getTime() + 60_000)
    try {
      utimesSync(projects, old, old)
      const claude = new ClaudeCodeAdapter()
      expect(await claude.transcriptPath(p.real, ID)).toBeNull()
      const dir = join(projects, encodeProjectPath(p.real))
      mkdirSync(dir)
      writeFileSync(join(dir, `${ID}.jsonl`), '{"type":"user"}\n')
      // Its time as it was: its names are the kept ones, so the new folder isn't seen until the time changes.
      utimesSync(projects, old, old)
      expect(await claude.transcriptPath(p.real, ID)).toBeNull()
      const later = new Date(old.getTime() + 1000)
      utimesSync(projects, later, later)
      expect(await claude.transcriptPath(p.real, ID)).toBe(join(dir, `${ID}.jsonl`))
    } finally {
      vi.useRealTimers()
    }
  })

  it("copies a moved folder's data from every folder it is kept under, the first one winning", async () => {
    const p = place()
    process.env.CLAUDE_CONFIG_DIR = join(p.base, 'claude-home')
    const projects = join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    // A, filed by Claude Code under the real path; B under the junction's name (an older CLI's, or one copied there).
    const real = join(projects, encodeProjectPath(p.real))
    const via = join(projects, encodeProjectPath(p.via))
    for (const [dir, id, memory] of [[real, ID, 'real'], [via, ID2, 'via']]) {
      mkdirSync(join(dir, 'memory'), { recursive: true })
      writeFileSync(join(dir, `${id}.jsonl`), '{"type":"user"}\n')
      writeFileSync(join(dir, 'memory', 'MEMORY.md'), memory)
      writeFileSync(join(dir, 'memory', `${memory}.md`), memory)
    }
    const claude = new ClaudeCodeAdapter()
    expect((await claude.listSessions(p.via)).map((s) => s.id).sort()).toEqual([ID, ID2].sort())
    const moved = join(p.base, 'Moved')
    mkdirSync(moved)
    const dest = join(projects, encodeProjectPath(moved))
    // The preview counts what the first folder would copy as there: the second's MEMORY.md differs, so it is kept.
    const preview = await claude.copyPathData(p.via, moved, false)
    expect(preview.map((c) => [c.from, c.to, c.copy, c.kept])).toEqual([
      [real, dest, 3, []],
      [via, dest, 2, [join('memory', 'MEMORY.md')]]
    ])
    const done = await claude.copyPathData(p.via, moved, true)
    expect(done.map((c) => [c.copy, c.kept])).toEqual(preview.map((c) => [c.copy, c.kept]))
    expect((await claude.listSessions(moved)).map((s) => s.id).sort()).toEqual([ID, ID2].sort())
    expect(readFileSync(join(dest, 'memory', 'MEMORY.md'), 'utf8')).toBe('real')
    expect(existsSync(join(dest, 'memory', 'via.md'))).toBe(true)
  })
})

describe("Codex's rollouts (#493)", () => {
  it('lists a session whose session_meta.cwd is another name for the folder', async () => {
    const p = place()
    process.env.CODEX_HOME = join(p.base, 'codex-home')
    const day = join(process.env.CODEX_HOME, 'sessions', '2026', '10', '11')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, `rollout-2026-10-11T07-00-00-${ID}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: ID, cwd: p.via } }) + '\n')
    const codex = new CodexAdapter()
    expect((await codex.listSessions(p.real)).map((s) => s.id)).toEqual([ID])
    expect((await codex.listSessions(p.via)).map((s) => s.id)).toEqual([ID])
    if (p.short) expect((await codex.listSessions(p.short)).map((s) => s.id)).toEqual([ID])
    expect(await codex.listSessions(p.base)).toEqual([])
  })
})

describe("Copilot's sessions (#493)", () => {
  it("lists a session whose workspace.yaml's cwd is another name for the folder", async () => {
    const p = place()
    const home = join(p.base, 'copilot-home')
    mkdirSync(join(home, 'session-state', ID), { recursive: true })
    writeFileSync(join(home, 'session-state', ID, 'workspace.yaml'), `id: ${ID}\ncwd: ${p.via}\n`)
    writeFileSync(join(home, 'session-state', ID, 'events.jsonl'), '{"type":"session.start"}\n')
    expect((await listCopilotSessions(home, p.real)).map((s) => s.id)).toEqual([ID])
    if (p.short) expect((await listCopilotSessions(home, p.short)).map((s) => s.id)).toEqual([ID])
    expect(await listCopilotSessions(home, p.base)).toEqual([])
  })
})
