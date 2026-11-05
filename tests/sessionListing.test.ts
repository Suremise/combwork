// A session list's other sessions (HI-1681): those the CLIs keep for a project's folders that Combwork didn't start. The
// Sessions tab took up to 19 s to open on a busy machine with hundreds of sessions, reading every CLI folder in full on
// every listing, and a listing asked for while one ran waited for it and then for one more. Now each CLI leaves Combwork's
// own sessions out by id before looking at their files and reads a folder's names again only when it changed; the
// other sessions' listing under way is joined; and Combwork's sessions can be listed alone, for the tab to show them first.
import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-sessionlisting-')
// The CLIs' homes are the test's (never ~/.claude or ~/.codex).
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { ClaudeCodeAdapter } = await import('../src/main/providers/claude/adapter')
const { CodexAdapter } = await import('../src/main/providers/codex/adapter')
const { encodeProjectPath } = await import('../src/main/providers/claude/usage')
const { provider } = await import('../src/main/providers')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')

let n = 0
const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const old = new Date(Date.now() - 3600_000)
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 15000
const transcript = (sid: string): string =>
  [
    { type: 'user', sessionId: sid, timestamp: old.toISOString(), message: { role: 'user', content: 'Task' } },
    { type: 'assistant', sessionId: sid, requestId: 'r1', timestamp: old.toISOString(), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, output_tokens: 50 } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const write = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
  utimesSync(file, old, old)
}

describe("Claude Code's sessions in a folder (HI-1681)", () => {
  const folder = join(base, 'claude-folder')
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', encodeProjectPath(folder))
  beforeAll(() => mkdirSync(folder, { recursive: true }))

  it("leaves out the ids the caller has, and gives each transcript's size and time", async () => {
    const [mine, other] = [newId(), newId()]
    write(join(dir, `${mine}.jsonl`), transcript(mine))
    write(join(dir, `${other}.jsonl`), transcript(other))
    const claude = new ClaudeCodeAdapter()
    const asked: string[] = []
    const found = await claude.listSessions(folder, (id) => (asked.push(id), id === mine))
    expect(asked.sort()).toEqual([mine, other].sort())
    expect(found.map((s) => s.id)).toEqual([other])
    const st = statSync(join(dir, `${other}.jsonl`))
    expect(found[0]).toMatchObject({ bytes: st.size, mtimeMs: st.mtimeMs, modified: st.mtime.toISOString() })
  })

  it('finds a transcript added or removed since the last listing, and one grown, on the same adapter', async () => {
    const claude = new ClaudeCodeAdapter()
    const before = (await claude.listSessions(folder)).map((s) => s.id)
    const added = newId()
    write(join(dir, `${added}.jsonl`), transcript(added))
    const after = await claude.listSessions(folder)
    expect(after.map((s) => s.id).sort()).toEqual([...before, added].sort())
    // Growing doesn't change the folder: the transcript's own size and time still come from it.
    appendFileSync(join(dir, `${added}.jsonl`), transcript(added))
    const grown = (await claude.listSessions(folder)).find((s) => s.id === added)
    expect(grown?.bytes).toBe(statSync(join(dir, `${added}.jsonl`)).size)
    rmSync(join(dir, `${added}.jsonl`))
    expect((await claude.listSessions(folder)).map((s) => s.id).sort()).toEqual([...before].sort())
  })
})

describe("Codex's sessions in a folder (HI-1681)", () => {
  it('leaves out the ids the caller has, and gives a grown rollout its new size', async () => {
    const folder = join(base, 'codex-folder')
    mkdirSync(folder, { recursive: true })
    const day = join(process.env.CODEX_HOME!, 'sessions', '2026', '10', '26')
    const [mine, other] = [newId(), newId()]
    const file = (id: string): string => join(day, `rollout-2026-10-26T10-00-00-${id}.jsonl`)
    for (const id of [mine, other]) write(file(id), JSON.stringify({ type: 'session_meta', payload: { id, cwd: folder } }) + '\n')
    const codex = new CodexAdapter()
    const found = await codex.listSessions(folder, (id) => id === mine)
    expect(found.map((s) => s.id)).toEqual([other])
    expect(found[0].bytes).toBe(statSync(file(other)).size)
    appendFileSync(file(other), JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'more' } }) + '\n')
    expect((await codex.listSessions(folder, (id) => id === mine))[0].bytes).toBe(statSync(file(other)).size)
  })
})

describe('a session list (HI-1681)', () => {
  const wsPath = join(base, 'ws')
  const p = join(wsPath, 'proj')
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', encodeProjectPath(p))
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const claude = provider('claude-code')
  let own: string[] = []
  let outside: string

  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    own = [newId(), newId(), newId()]
    for (const id of own) {
      await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', name: id, lastActiveAt: old.toISOString() }))
      write(join(dir, `${id}.jsonl`), transcript(id))
    }
    outside = newId()
    write(join(dir, `${outside}.jsonl`), transcript(outside))
  })
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await disposeWorkspaceService(w)
  })

  it("lists Combwork's sessions and the others; Combwork's alone when asked, without the CLIs' folders", async () => {
    const all = await run(() => sessions.list(p))
    expect(all.filter((i) => i.source === 'combwork').map((i) => i.id).sort()).toEqual([...own].sort())
    const ext = all.find((i) => i.id === outside)
    expect(ext?.source).toBe('external')
    expect(ext?.transcriptBytes).toBe(statSync(join(dir, `${outside}.jsonl`)).size)
    const listed = vi.spyOn(claude, 'listSessions')
    const mine = await run(() => sessions.list(p, { own: true }))
    expect(mine.map((i) => i.id).sort()).toEqual([...own].sort())
    expect(listed).not.toHaveBeenCalled()
  })

  it("never looks at Combwork's own sessions' files in the CLIs' folders", async () => {
    // What each folder's listing is told to leave out, as it is asked.
    const skipped: { own: boolean; outside: boolean }[] = []
    const real = claude.listSessions.bind(claude)
    vi.spyOn(claude, 'listSessions').mockImplementation((folder, skip) => {
      skipped.push({ own: own.every((id) => !!skip?.(id)), outside: !!skip?.(outside) })
      return real(folder, skip)
    })
    await run(() => sessions.list(p))
    expect(skipped.length).toBeGreaterThan(0)
    expect(skipped.every((s) => s.own && !s.outside)).toBe(true)
  })

  it("lists asked for while one runs share its reading of the other sessions; Combwork's alone joins its records' listing", async () => {
    const real = claude.listSessions.bind(claude)
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const folders = vi.spyOn(claude, 'listSessions').mockImplementation(async (folder, skip) => {
      await gate
      return real(folder, skip)
    })
    const records = vi.spyOn(sessions as unknown as { listOwn: (p: string) => Promise<unknown> }, 'listOwn')
    const first = run(() => sessions.list(p))
    // The first listing has asked for its folders before the others are asked for.
    await vi.waitFor(() => expect(folders).toHaveBeenCalled(), { timeout: HUNG_MS })
    const asked = folders.mock.calls.length
    const second = run(() => sessions.list(p))
    const mine = run(() => sessions.list(p, { own: true }))
    release()
    const [a, b, m] = await Promise.all([first, second, mine])
    expect(a.map((i) => i.id).sort()).toEqual(b.map((i) => i.id).sort())
    expect(a.some((i) => i.id === outside)).toBe(true)
    expect(m.map((i) => i.id).sort()).toEqual([...own].sort())
    // One reading of the CLIs' folders between them.
    expect(folders.mock.calls.length).toBe(asked)
    // Combwork's records: the first listing's, and one more for the second (its records as they were after it asked);
    // Combwork's alone joined one of them.
    expect(records).toHaveBeenCalledTimes(2)
  })

  it('a session started outside Combwork since the last listing is in the next', async () => {
    await run(() => sessions.list(p))
    const later = newId()
    write(join(dir, `${later}.jsonl`), transcript(later))
    expect((await run(() => sessions.list(p))).some((i) => i.id === later && i.source === 'external')).toBe(true)
  })
})
