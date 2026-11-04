// The usage history's import and what relies on it (#1106 round 2): an import that couldn't finish isn't recorded as done
// (nothing retired, its fallbacks kept) and the next try imports what is left; a record's kept usage wins over a stale
// backup that counted less; a session deleted before the import reached it, or whose use can't be recorded, keeps what
// it used; the Overview reads a running session from the history, not its transcript; the Sessions list reads a running
// session by the usage worker, as its pane does (#1157).
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { priceUsage } from '../src/shared/usageDays'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { SessionListItem, SessionUsage } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-usage-backfill-')
// The CLIs' homes are the test's own (HI-1666): a list looks in each for sessions started outside Hive, and the user's
// ~/.codex (a thousand rollouts) took 14 s of it under a full unit run's load.
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (f: string) => Promise<void> }).trashItem = async (f) => rmSync(f, { force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { usageHistory } = await import('../src/main/usageHistory')
const { newUsageParser } = await import('../src/main/usageParsers')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'proj')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const T0 = Date.parse('2026-10-12T10:00:00.000Z')
const at = new Date(T0).toISOString()
let n = 0
const newId = (): string => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`

const transcript = (sid: string, outputs: number[]): string =>
  JSON.stringify({ type: 'user', sessionId: sid, timestamp: at, message: { role: 'user', content: 'Task' } }) + '\n' + outputs.map((o, i) => JSON.stringify({ type: 'assistant', sessionId: sid, requestId: `r${i}`, timestamp: new Date(T0 + (i + 1) * 60_000).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: o } } }) + '\n').join('')
const write = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
const backup = (id: string): string => join(p, '.combwork', 'sessions', `${id}.jsonl`)
const keptUsage = (sid: string, outputs: number[]): SessionUsage => {
  const parser = newUsageParser('claude-code', sid)!
  parser.feed(transcript(sid, outputs))
  return { ...priceUsage(parser.result(), DEFAULT_SETTINGS), lastPrompt: null }
}
const outputOf = (items: SessionListItem[], id: string): number | undefined => items.find((i) => i.id === id)?.usage?.outputTokens
const cliLookup = vi.spyOn(sessions, 'providerTranscript')

/** Holds a file open the way an editor or a virus scanner can: no sharing, so it can't be read (as sessionInUse.test.ts does). */
async function hold(file: string): Promise<ChildProcess> {
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 60`
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the file was not held in time')), 20000)
    child.stdout!.on('data', (d) => {
      if (String(d).includes('held')) {
        clearTimeout(t)
        resolve()
      }
    })
    child.on('exit', () => reject(new Error('the holder exited')))
  })
  return child
}
const cache = join(base, 'profile', 'usage-cache.json')

describe("the usage history's import", () => {
  const stale = newId()
  const keptOnly = newId()
  const deleted = newId()
  const deletedEarly = newId()

  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1' }] }))
    mkdirSync(join(base, 'profile'), { recursive: true })
    writeFileSync(cache, '{"version":"0.9.3","entries":[]}')
    cliLookup.mockImplementation(async () => null)
    // A record whose backup is stale (10) while its kept usage counted 500; one with only its kept usage; a deleted one.
    write(backup(stale), transcript(stale, [10]))
    write(
      join(p, '.combwork', 'sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [
          { id: stale, agent: 'claude-code', agentId: 'c1', name: 'stale backup', createdAt: at, lastActiveAt: at, keptUsage: keptUsage(stale, [500]) },
          { id: keptOnly, agent: 'claude-code', agentId: 'c1', name: 'kept only', createdAt: at, lastActiveAt: at, keptUsage: keptUsage(keptOnly, [70]) },
          { id: deletedEarly, agent: 'claude-code', agentId: 'c1', name: 'deleted before the import', createdAt: at, lastActiveAt: at, keptUsage: keptUsage(deletedEarly, [40]) }
        ],
        deleted: [deleted],
        deletedUsage: [{ id: deleted, provider: 'claude-code', agentId: 'c1', name: 'deleted', cwd: p, usage: keptUsage(deleted, [300]) }]
      })
    )
    usageHistory.start()
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    cliLookup.mockRestore()
    await disposeWorkspaceService(w)
    await usageHistory.stop()
  })

  it('a session deleted before the import reaches it keeps what it used (its kept usage recorded first)', async () => {
    await run(() => sessions.delete(p, deletedEarly))
    expect((await run(() => workspace.sessionsFile(p))).sessions.some((s) => s.id === deletedEarly)).toBe(false)
    expect(outputOf(await run(() => sessions.keptUsage(p)), deletedEarly)).toBe(40)
  })

  it('a list reads no transcript in main: a stopped session it has none of yet (the import not there yet) is queued, a running one read by the worker as its pane is (#1157)', async () => {
    const [stopped, running] = [newId(), newId()]
    for (const id of [stopped, running]) {
      await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'not imported yet', lastActiveAt: at }))
      write(backup(id), transcript(id, Array.from({ length: 200 }, () => 5)))
    }
    const s = sessions as unknown as { live: Map<string, unknown> }
    s.live.set(`${p.toLowerCase()}#c1`, { state: { provider: 'claude-code', runId: 'run-c', projectPath: p, agentId: 'c1', sessionId: running, status: 'working' } })
    const usageFor = vi.spyOn(sessions as unknown as { usageFor: (pp: string, path: string, id: string) => Promise<unknown> }, 'usageFor')
    // The worker's read (#1147): main only asks it.
    const workerReads = vi.spyOn(usageHistory, 'read')
    const readFor = (spy: { mock: { calls: unknown[][] } }): unknown[] => spy.mock.calls.map((c) => c[2])
    try {
      const items = await run(() => sessions.list(p))
      expect([stopped, running].map((id) => outputOf(items, id) ?? null)).toEqual([null, 1000])
      expect([readFor(usageFor), readFor(workerReads)]).toEqual([[running], [running]])
      // The queued read lands in the worker: the next list has it, read from the history.
      await vi.waitFor(async () => {
        const later = await run(() => sessions.list(p))
        expect([stopped, running].map((id) => outputOf(later, id))).toEqual([1000, 1000])
      }, { timeout: 10_000 })
      expect(readFor(usageFor)).not.toContain(stopped)
      // The running one, unchanged since: the worker isn't asked again.
      expect(readFor(workerReads)).toEqual([running])
    } finally {
      usageFor.mockRestore()
      workerReads.mockRestore()
      s.live.clear()
    }
  })

  it("isn't recorded as done when a session fails to import: nothing is retired, and the next try imports what is left", async () => {
    const h = usageHistory as unknown as { importKept: (...a: unknown[]) => Promise<unknown> }
    const real = h.importKept.bind(usageHistory)
    // The deleted session's import fails (the worker ended, a write another Hive held).
    const fail = vi.spyOn(h, 'importKept').mockImplementation((host, k, ...rest) => ((k as { id: string }).id === deleted ? Promise.reject(new Error('the usage worker ended')) : real(host, k, ...rest)))
    await run(() => usageHistory.opened(w))
    fail.mockRestore()
    expect(usageHistory.progressOf(wsPath).importing).toBe(true)
    expect(usageHistory.backfilled(wsPath)).toBe(false)
    expect(existsSync(cache)).toBe(true)
    // Meanwhile the deleted session still counts, from what an older Hive kept.
    expect(outputOf(await run(() => sessions.keptUsage(p)), deleted)).toBe(300)
    // Tried again (the next open, or the ten-minute tick): what is left is imported, and it's done.
    await run(() => usageHistory.opened(w))
    expect(usageHistory.backfilled(wsPath)).toBe(true)
    expect(existsSync(cache)).toBe(false)
    const items = await run(() => sessions.usageItems(p))
    expect(outputOf(items, deleted)).toBe(300)
    expect(outputOf(items, keptOnly)).toBe(70)
  })

  it("a record's kept usage wins over a stale backup that counted less", async () => {
    expect(outputOf(await run(() => sessions.usageItems(p)), stale)).toBe(500)
  })

  it("a session whose use can't be recorded isn't deleted, nor its copies", async () => {
    const id = newId()
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'keep me', lastActiveAt: at }))
    write(backup(id), transcript(id, [20]))
    const busy = vi.spyOn(usageHistory, 'ingest').mockResolvedValue({ status: 'busy' })
    const err = await run(() => sessions.delete(p, id)).catch((e) => e)
    busy.mockRestore()
    expect(String(err)).toMatch(/couldn't read what the session used/)
    expect(existsSync(backup(id))).toBe(true)
    expect((await run(() => workspace.sessionsFile(p))).sessions.some((s) => s.id === id)).toBe(true)
  })

  it.runIf(process.platform === 'win32')("a session whose file can't be read to its end isn't deleted (what is recorded isn't all of it)", async () => {
    const id = newId()
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'unread tail', lastActiveAt: at }))
    write(backup(id), transcript(id, [20]))
    await usageHistory.ingest(p, id, { priority: 1, keepState: 'no' })
    // More written since it was recorded, and the file held open by another program when Delete asks.
    writeFileSync(backup(id), transcript(id, [20, 30]))
    const holder = await hold(backup(id))
    try {
      const err = await run(() => sessions.delete(p, id)).catch((e) => e)
      expect(String(err)).toMatch(/couldn't read what the session used/)
    } finally {
      holder.kill()
    }
    expect(existsSync(backup(id))).toBe(true)
    expect((await run(() => workspace.sessionsFile(p))).sessions.some((s) => s.id === id)).toBe(true)
  })

  it('lists a running session the history has by the worker, as its pane is (#1157): what was added since, a title too, and not asked again while unchanged', async () => {
    const id = newId()
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'running listed', lastActiveAt: at }))
    write(backup(id), transcript(id, [25]))
    await usageHistory.ingest(p, id, { priority: 1, keepState: 'running' })
    const s = sessions as unknown as { live: Map<string, unknown> }
    s.live.set(`${p.toLowerCase()}#c1`, { state: { provider: 'claude-code', runId: 'run-l', projectPath: p, agentId: 'c1', sessionId: id, status: 'working' } })
    const usageFor = vi.spyOn(sessions as unknown as { usageFor: (pp: string, path: string, id: string) => Promise<unknown> }, 'usageFor')
    // The worker's read (#1147): main only asks it. usageFor(projectPath, path, sessionId, provider), read(the same).
    const workerReads = vi.spyOn(usageHistory, 'read')
    const readFor = (spy: { mock: { calls: unknown[][] } }): unknown[] => spy.mock.calls.map((c) => c[2])
    const row = async (): Promise<SessionListItem | undefined> => (await run(() => sessions.list(p))).find((i) => i.id === id)
    try {
      expect((await row())?.usage?.outputTokens).toBe(25)
      expect([readFor(usageFor), readFor(workerReads)]).toEqual([[id], [id]])
      // A CLI /rename and a request since, with no turn ended: the history has neither, the row has both.
      const request = JSON.stringify({ type: 'assistant', sessionId: id, requestId: 'r-after', timestamp: new Date(T0 + 10 * 60_000).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 30 } } })
      appendFileSync(backup(id), JSON.stringify({ type: 'custom-title', customTitle: 'Renamed while running', sessionId: id }) + '\n' + request + '\n')
      workerReads.mockClear()
      const after = await row()
      expect([after?.usage?.customTitle, after?.title, after?.usage?.outputTokens]).toEqual(['Renamed while running', 'Renamed while running', 55])
      expect(readFor(workerReads)).toEqual([id])
      // Unchanged since: the worker isn't asked again.
      workerReads.mockClear()
      expect((await row())?.usage?.outputTokens).toBe(55)
      expect(workerReads).not.toHaveBeenCalled()
    } finally {
      usageFor.mockRestore()
      workerReads.mockRestore()
      s.live.clear()
    }
  })

  it("reads a running session from the history: its transcript isn't read for the Overview", async () => {
    const id = newId()
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'running', lastActiveAt: at }))
    write(backup(id), transcript(id, [15]))
    await usageHistory.ingest(p, id, { priority: 1, keepState: 'running' })
    const s = sessions as unknown as { live: Map<string, unknown> }
    s.live.set(`${p.toLowerCase()}#c1`, { state: { provider: 'claude-code', runId: 'run-r', projectPath: p, agentId: 'c1', sessionId: id, status: 'working' } })
    const reads = vi.spyOn(sessions, 'anyTranscript')
    const usageFor = vi.spyOn(sessions as unknown as { usageFor: () => Promise<unknown> }, 'usageFor')
    try {
      expect(outputOf(await run(() => sessions.usageItems(p)), id)).toBe(15)
      expect(reads).not.toHaveBeenCalled()
      expect(usageFor).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
      usageFor.mockRestore()
      s.live.clear()
    }
  })
})
