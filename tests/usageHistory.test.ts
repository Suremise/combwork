// The usage history in a workspace (#1106): its one-time import takes each record's transcript (or Combwork's backup), a
// record's kept usage when it has no file left, and each deleted session's kept usage, so nothing already counted is
// lost; the Overview's figures then come from it, and stay when the transcripts go; a transcript that grows while Combwork
// isn't reading it is found by the sweep; card costs come from its rows.
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { priceUsage } from '../src/shared/usageDays'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { SessionListItem, SessionUsage } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('cw-usage-history-')
// The CLIs' homes are the test's own (HI-1666): a list looks in each for sessions started outside Combwork, and the user's
// ~/.codex (a thousand rollouts) took 17 s of it under a full unit run's load.
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { usageHistory } = await import('../src/main/usageHistory')
const { newUsageParser } = await import('../src/main/usageParsers')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'proj')
const cli = join(base, 'cli')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const T0 = Date.parse('2026-10-12T10:00:00.000Z')
let n = 0
const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

const request = (sid: string, i: number, output: number): string => JSON.stringify({ type: 'assistant', sessionId: sid, requestId: `r${i}`, timestamp: new Date(T0 + i * 60_000).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output } } }) + '\n'
const transcript = (sid: string, outputs: number[]): string => JSON.stringify({ type: 'user', sessionId: sid, timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'Task' } }) + '\n' + outputs.map((o, i) => request(sid, i + 1, o)).join('')
const write = (file: string, text: string): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
const backup = (id: string): string => join(p, '.combwork', 'sessions', `${id}.jsonl`)
const cliFile = (id: string): string => join(cli, `${id}.jsonl`)
/** A kept usage, priced as Combwork kept them before the history. */
const keptUsage = (sid: string, output: number): SessionUsage => {
  const parser = newUsageParser('claude-code', sid)!
  parser.feed(transcript(sid, [output]))
  return { ...priceUsage(parser.result(), DEFAULT_SETTINGS), lastPrompt: null }
}
const outputOf = (items: SessionListItem[], id: string): number | undefined => items.find((i) => i.id === id)?.usage?.outputTokens

const cliLookup = vi.spyOn(sessions, 'providerTranscript')

describe('the usage history of a workspace', () => {
  const inCli = newId()
  const onlyBackup = newId()
  const keptOnRecord = newId()
  const deleted = newId()
  const noUsage = newId()

  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1' }] }))
    // An older build's usage-cache.json, which the history replaces.
    mkdirSync(join(base, 'profile'), { recursive: true })
    writeFileSync(join(base, 'profile', 'usage-cache.json'), '{"version":"0.9.3","entries":[]}')
    cliLookup.mockImplementation(async (_pp, id) => (existsSync(cliFile(id)) ? { path: cliFile(id), provider: 'claude-code' as const } : null))
    write(cliFile(inCli), transcript(inCli, [100, 200]))
    write(backup(inCli), transcript(inCli, [100, 200]))
    write(backup(onlyBackup), transcript(onlyBackup, [300]))
    // Sessions as an older Combwork left them: records (one whose transcripts went, with its kept usage) and a deleted one's usage.
    const at = new Date(T0).toISOString()
    write(
      join(p, '.combwork', 'sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [
          { id: inCli, agent: 'claude-code', agentId: 'c1', name: 'in the CLI', createdAt: at, lastActiveAt: at },
          { id: onlyBackup, agent: 'claude-code', agentId: 'c1', name: 'only a backup', createdAt: at, lastActiveAt: at },
          { id: keptOnRecord, agent: 'claude-code', agentId: 'c1', name: 'kept', archived: true, createdAt: at, lastActiveAt: at, keptUsage: keptUsage(keptOnRecord, 400) },
          { id: noUsage, agent: 'claude-code', name: 'never said anything', createdAt: at, lastActiveAt: at }
        ],
        deleted: [deleted],
        deletedUsage: [{ id: deleted, provider: 'claude-code', agentId: 'c1', name: 'deleted', cwd: p, usage: keptUsage(deleted, 500) }]
      })
    )
    // As Combwork starts it: its tick, and the board read for holds dropped after a change.
    usageHistory.start()
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    cliLookup.mockRestore()
    await disposeWorkspaceService(w)
    await usageHistory.stop()
  })

  it('before its import, the Overview counts what an older Combwork kept, and says the figures are partial', async () => {
    expect(usageHistory.progressOf(wsPath).importing).toBe(true)
    const items = await run(() => sessions.usageItems(p))
    expect(outputOf(items, keptOnRecord)).toBe(400)
    expect(outputOf(items, deleted)).toBe(500)
    expect(items.find((i) => i.id === noUsage)?.usage).toBeNull()
  })

  it('imports every session once, losing nothing already counted, and retires usage-cache.json', async () => {
    await run(() => usageHistory.opened(w))
    expect(usageHistory.progressOf(wsPath)).toEqual({ importing: false, done: 5, total: 5 })
    expect(existsSync(join(base, 'profile', 'usage-cache.json'))).toBe(false)
    const items = await run(() => sessions.usageItems(p))
    expect([inCli, onlyBackup, keptOnRecord, deleted].map((id) => outputOf(items, id))).toEqual([300, 300, 400, 500])
    expect(items.find((i) => i.id === deleted)?.deleted).toBe(true)
    expect(items.find((i) => i.id === noUsage)?.usage).toBeNull()
    // The kept usage keeps its cost as it was priced.
    expect(items.find((i) => i.id === keptOnRecord)?.usage?.costUsd).toBeCloseTo(keptUsage(keptOnRecord, 400).costUsd!, 6)
    // Opened again: nothing is imported again.
    await run(() => usageHistory.opened(w))
    expect(usageHistory.progressOf(wsPath)).toEqual({ importing: false, done: 0, total: 0 })
  })

  it('the totals stay when the transcripts and backups go', async () => {
    const before = await run(() => sessions.usageItems(p))
    rmSync(cliFile(inCli))
    // Plain or compressed (#1110: the import's housekeeping compresses ended sessions' backups).
    for (const b of [backup(inCli), backup(onlyBackup)]) for (const f of [b, `${b}.gz`]) rmSync(f, { force: true })
    const after = await run(() => sessions.usageItems(p))
    expect([inCli, onlyBackup].map((id) => outputOf(after, id))).toEqual([inCli, onlyBackup].map((id) => outputOf(before, id)))
    // A session's own usage too, as the Sessions list and the Agent API read it.
    expect((await run(() => sessions.usage(p, onlyBackup)))?.outputTokens).toBe(300)
  })

  it("a transcript that grew while Combwork wasn't reading it is found and read", async () => {
    const id = newId()
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'grows', lastActiveAt: new Date(T0).toISOString() }))
    write(cliFile(id), transcript(id, [10]))
    expect((await usageHistory.ingest(p, id, { priority: 1, keepState: 'no' }))?.status).toBe('written')
    appendFileSync(cliFile(id), request(id, 9, 90))
    // The sweep (every ten minutes, and after a workspace's import) finds it changed and reads it.
    await usageHistory['sweep'](w)
    await vi.waitFor(async () => expect(outputOf(await run(() => sessions.usageItems(p)), id)).toBe(100), { timeout: 10_000 })
  })

  it("a deleted session's usage is recorded before its copies go, and stays in the totals", async () => {
    const id = newId()
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'to delete', lastActiveAt: new Date(T0).toISOString() }))
    write(backup(id), transcript(id, [70]))
    ;(electron.shell as unknown as { trashItem: (f: string) => Promise<void> }).trashItem = async (f) => rmSync(f, { force: true })
    await run(() => sessions.delete(p, id))
    expect(existsSync(backup(id))).toBe(false)
    const kept = await run(() => sessions.keptUsage(p))
    expect(kept.find((k) => k.id === id)).toMatchObject({ deleted: true, name: 'to delete', agentId: 'c1' })
    expect(outputOf(kept, id)).toBe(70)
  })

  it("a session started outside Combwork is kept for the Sessions list, never counted, until a record makes it Combwork's", async () => {
    const id = newId()
    write(cliFile(id), transcript(id, [40]))
    expect((await usageHistory.ingestExternal(p, { id, provider: 'claude-code', transcriptPath: cliFile(id) }))?.status).toBe('written')
    const stored = await usageHistory.storedUsage(p)
    expect(stored.get(id)).toMatchObject({ source: 'external', read: { path: cliFile(id) } })
    expect(outputOf(await run(() => sessions.usageItems(p)), id)).toBeUndefined()
    expect((await run(() => sessions.keptUsage(p))).some((k) => k.id === id)).toBe(false)
    // Adopted: its record's job makes it Combwork's, so once deleted it stays in the totals.
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'adopted', lastActiveAt: new Date(T0).toISOString() }))
    await usageHistory.ingest(p, id, { priority: 1, keepState: 'no' })
    expect((await usageHistory.storedUsage(p)).get(id)?.source).toBe('transcript')
    expect(outputOf(await run(() => sessions.usageItems(p)), id)).toBe(40)
  })

  it("a card's cost is its builder's session's use while it held the card, from the history", async () => {
    const tasks = await import('../src/main/tasks')
    const { cardCosts } = await import('../src/main/cardCosts')
    const card = await run(() => tasks.createTask({ title: 'Costed', project: 'proj', agent: 'c1', column: 'doing' }, { kind: 'user' }))
    const id = newId()
    const now = Date.now()
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'builds', lastActiveAt: new Date(now).toISOString() }))
    // Two requests while the card is held, in the same second as the card's hold or after it.
    const req = (i: number, at: number, output: number): string => JSON.stringify({ type: 'assistant', sessionId: id, requestId: `q${i}`, timestamp: new Date(at).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output } } }) + '\n'
    write(cliFile(id), req(1, now + 1500, 30) + req(2, now + 2500, 20))
    // Recorded ten seconds on (the card still held): only the clock is moved, nothing waits.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now + 10_000)
    try {
      await usageHistory.ingest(p, id, { priority: 1, keepState: 'no' })
    } finally {
      vi.useRealTimers()
    }
    const [cost] = await run(() => cardCosts(w, { numbers: [card.number] }))
    expect(cost.build).toMatchObject({ outputTokens: 50, requests: 2, priced: 1, unpriced: 0 })
    expect(cost.unmatched).toBe(0)
  })

  it("a stopped session's share on a card follows the card's hold after it stopped (the board change, then the cost asked)", async () => {
    const tasks = await import('../src/main/tasks')
    const { cardCosts } = await import('../src/main/cardCosts')
    const card = await run(() => tasks.createTask({ title: 'Closed later', project: 'proj', agent: 'c1', column: 'doing' }, { kind: 'user' }))
    const from = Date.parse(card.held![0].from)
    const id = newId()
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'stopped', lastActiveAt: new Date(from).toISOString() }))
    // Its last request 2.3 s into the hold; recorded as it stopped, 0.1 s later, the hold still open (cut at that moment).
    const req = { type: 'assistant', sessionId: id, requestId: 'z1', timestamp: new Date(from + 2300).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1000 } } }
    write(cliFile(id), JSON.stringify(req) + '\n')
    // This session's part of the card (the agent's other sessions here may have some too), after its cost is asked for.
    const onCard = async (): Promise<number> => {
      await run(() => cardCosts(w, { numbers: [card.number] }))
      return (await usageHistory.cardRows(wsPath, [card.number])).filter((r) => r.session === id).reduce((sum, r) => sum + r.row.outputTokens, 0)
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(from + 2400)
      await usageHistory.ingest(p, id, { priority: 1, keepState: 'now' })
      expect(await onCard()).toBeLessThan(1000)
      // Ten seconds on, the card goes to Done: its hold ends after the whole request's second.
      vi.setSystemTime(from + 10_000)
      await run(() => tasks.updateTask(card.number, { column: 'done' }, { kind: 'user' }))
    } finally {
      vi.useRealTimers()
    }
    // The session isn't running: nothing reads its file again; asking for the card's cost shares it out again.
    await run(() => cardCosts(w, { numbers: [card.number] }))
    expect(await onCard()).toBe(1000)
  })

  it("a running session's row follows its transcript at once, a CLI /rename too, read by the worker (#1157)", async () => {
    const id = newId()
    write(cliFile(id), transcript(id, [100]))
    await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: 'Docs pass', titleAtRename: null, lastActiveAt: new Date(T0).toISOString() }))
    const live = (sessions as unknown as { live: Map<string, unknown> }).live
    live.set(`${p.toLowerCase()}#c1`, { state: { sessionId: id, projectPath: p, provider: 'claude-code' } })
    const reads = vi.spyOn(usageHistory, 'read')
    try {
      const row = async (): Promise<SessionListItem | undefined> => (await run(() => sessions.list(p))).find((i) => i.id === id)
      expect((await row())?.usage?.outputTokens).toBe(100)
      // No turn ends and no tick comes: the history has none of it.
      appendFileSync(cliFile(id), JSON.stringify({ type: 'custom-title', customTitle: 'Guide only', sessionId: id }) + '\n' + request(id, 2, 50))
      reads.mockClear()
      const after = await row()
      expect([after?.usage?.customTitle, after?.title, after?.usage?.outputTokens]).toEqual(['Guide only', 'Guide only', 150])
      expect(reads).toHaveBeenCalledTimes(1)
      // Unchanged since: the worker isn't asked again.
      reads.mockClear()
      expect((await row())?.usage?.customTitle).toBe('Guide only')
      expect(reads).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
      live.delete(`${p.toLowerCase()}#c1`)
    }
  })

  describe("a resume's read of a stopped session's /rename, through start's launch (HI-2839)", () => {
    // oxlint-disable-next-line typescript/no-explicit-any -- the manager's private launch and wait, replaced for the test
    const internals = sessions as any
    const past = new Error('past the name')
    /** What each launch was given as its name (the adapter's --name, none when empty). */
    let launched: string[] = []
    let restore: () => void = () => undefined
    beforeAll(async () => {
      const { providerService } = await import('../src/main/providerService')
      const { config } = await import('../src/main/config')
      const info = providerService.info
      const enabled = config.settings.providers['claude-code'].enabled
      const launch = internals.launch
      providerService.info = ((id: string) => ({ provider: id, found: true, path: join(base, 'no-cli.exe') })) as never
      config.settings.providers['claude-code'].enabled = true
      // The launch as start hands it its name (launchOn's context.name, the adapter's --name), stopped there.
      internals.launch = async (_p: string, _a: unknown, o: { name: string }) => {
        launched.push(o.name)
        throw past
      }
      restore = () => {
        providerService.info = info
        config.settings.providers['claude-code'].enabled = enabled
        internals.launch = launch
      }
    })
    afterAll(() => restore())

    /** A stopped session the history has, then a /rename in its CLI just before Stop: the import queued as it ended not run yet. */
    const renamedAfterImport = async (): Promise<string> => {
      const id = newId()
      write(cliFile(id), transcript(id, [100]))
      await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', cwd: p, names: 2, name: 'Docs pass', titleAtRename: null, lastActiveAt: new Date(T0).toISOString() }))
      await run(() => usageHistory.ingest(p, id, { priority: 1, keepState: 'no' }))
      appendFileSync(cliFile(id), JSON.stringify({ type: 'custom-title', customTitle: 'Guide only', sessionId: id }) + '\n')
      return id
    }
    /** Resumes it (as Resume does, or with a name given), returning the name its launch got and its record's name after. */
    const resumed = async (id: string, name?: string): Promise<{ launch: string | undefined; record: string | undefined }> => {
      launched = []
      await expect(run(() => sessions.start(p, { agentId: 'c1', resumeId: id, ...(name ? { name } : {}) }))).rejects.toBe(past)
      return { launch: launched.at(-1), record: (await run(() => workspace.sessionsFile(p))).sessions.find((s) => s.id === id)?.name }
    }
    /** The file's turn taken (the import ingesting it): a read that doesn't wait gets nothing; one that does, `waiting`'s. */
    const busy = (waiting: (real: typeof usageHistory.read, a: Parameters<typeof usageHistory.read>) => ReturnType<typeof usageHistory.read>) => {
      const real = usageHistory.read.bind(usageHistory)
      return vi.spyOn(usageHistory, 'read').mockImplementation(async (...a) => (a[4]?.noWait ? null : waiting(real, a)))
    }

    it('history behind the transcript: the transcript is read, and the /rename adopted and passed back', async () => {
      const id = await renamedAfterImport()
      // What a resume read before: the history, without the /rename (so --name gave the older name back for good).
      expect((await run(() => sessions.usage(p, id, undefined, { noWait: true })))?.customTitle).toBeFalsy()
      expect(await resumed(id)).toEqual({ launch: 'Guide only', record: 'Guide only' })
    })

    it('the worker busy with its transcript: the resume waits for its turn, bounded, and adopts the /rename', async () => {
      const id = await renamedAfterImport()
      const reads = busy((real, a) => real(...a))
      try {
        expect(await resumed(id)).toEqual({ launch: 'Guide only', record: 'Guide only' })
        expect(reads.mock.calls.map((c) => !!c[4]?.noWait)).toEqual([true, false])
      } finally {
        reads.mockRestore()
      }
    })

    it("a turn that doesn't come within the bound: the start goes on with no --name, so the CLI keeps the /rename", async () => {
      const id = await renamedAfterImport()
      const reads = busy(() => new Promise<never>(() => undefined))
      const was = internals.resumeReadWaitMs
      internals.resumeReadWaitMs = 50
      try {
        expect(await resumed(id)).toEqual({ launch: '', record: 'Docs pass' })
      } finally {
        internals.resumeReadWaitMs = was
        reads.mockRestore()
      }
    })

    it('a read that fails, or a transcript that cannot be looked at: no --name either', async () => {
      const id = await renamedAfterImport()
      const reads = busy(async () => {
        throw new Error('the worker failed')
      })
      try {
        expect(await resumed(id)).toEqual({ launch: '', record: 'Docs pass' })
      } finally {
        reads.mockRestore()
      }
      // Found, then gone (or held) as it is looked at: stat fails.
      const looked = vi.spyOn(sessions, 'anyTranscript').mockResolvedValue(join(cli, 'gone.jsonl'))
      try {
        expect(await resumed(id)).toEqual({ launch: '', record: 'Docs pass' })
      } finally {
        looked.mockRestore()
      }
    })

    it('a name the user gives with the resume is passed, whatever the read', async () => {
      const id = await renamedAfterImport()
      const reads = busy(() => new Promise<never>(() => undefined))
      try {
        expect((await resumed(id, 'Final docs')).launch).toBe('Final docs')
      } finally {
        reads.mockRestore()
      }
    })

    it('history up to date with the transcript: taken as it is, the worker not asked', async () => {
      const id = await renamedAfterImport()
      await run(() => usageHistory.ingest(p, id, { priority: 1, keepState: 'no' }))
      const reads = vi.spyOn(usageHistory, 'read')
      try {
        expect(await resumed(id)).toEqual({ launch: 'Guide only', record: 'Guide only' })
        expect(reads).not.toHaveBeenCalled()
      } finally {
        reads.mockRestore()
      }
    })
  })

  it("a cost read's freshen reads a host's records once for all its running sessions, and records each (HI-1790)", async () => {
    const ids = [newId(), newId(), newId()]
    const live = (sessions as unknown as { live: Map<string, unknown> }).live
    for (const [i, id] of ids.entries()) {
      write(cliFile(id), transcript(id, [10 * (i + 1)]))
      await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: `running ${i}`, lastActiveAt: new Date(T0).toISOString() }))
      live.set(`${p.toLowerCase()}#run${i}`, { state: { sessionId: id, projectPath: p, provider: 'claude-code' } })
    }
    const records = vi.spyOn(w, 'sessionsFile')
    cliLookup.mockClear()
    try {
      await run(() => usageHistory.freshen(w))
      expect(records.mock.calls.filter(([host]) => host === p)).toHaveLength(1)
      // The transcript looked up with the records read (not read again for each).
      for (const id of ids) expect(cliLookup.mock.calls.find(([, sid]) => sid === id)?.[2]?.records.some((r) => r.id === id)).toBe(true)
      const items = await run(() => sessions.usageItems(p))
      expect(ids.map((id) => outputOf(items, id))).toEqual([10, 20, 30])
    } finally {
      records.mockRestore()
      for (const i of ids.keys()) live.delete(`${p.toLowerCase()}#run${i}`)
    }
  })

  it('a roll-up waiting behind other jobs leaves a session resumed meanwhile alone: the running ones are read as it goes to the worker (HI-1648 review round 1)', async () => {
    // Two sessions last active on 12 Oct (over 14 days ago), recorded in full detail.
    const [resumed, ended] = [newId(), newId()]
    for (const id of [resumed, ended]) {
      write(cliFile(id), transcript(id, [5, 6]))
      await run(() => workspace.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: id, lastActiveAt: new Date(T0).toISOString() }))
      await run(() => usageHistory.ingest(p, id, { priority: 0, keepState: 'no' }))
    }
    const step = async (id: string) => (await run(() => usageHistory.timelines(p))).find((s) => s.session === id)?.timeline?.step
    expect([await step(resumed), await step(ended)]).toEqual([1, 1])
    const live = (sessions as unknown as { live: Map<string, unknown> }).live
    // The queue held by a job before it; the roll-up queued behind it, then the session resumed while it waits.
    let open!: () => void
    const gate = usageHistory['enqueue']('gate', 0, () => new Promise<null>((r) => (open = () => r(null))))
    await vi.waitFor(() => expect(open).toBeTypeOf('function'))
    usageHistory['rolledUp'].clear()
    const rolled = run(() => usageHistory['rollUp'](w, { path: w.path!, signal: w.lifetime }))
    live.set(`${p.toLowerCase()}#resumed`, { state: { sessionId: resumed, projectPath: p, provider: 'claude-code' } })
    try {
      open()
      await gate
      await rolled
      expect(await step(ended)).toBe(3600)
      expect(await step(resumed)).toBe(1)
    } finally {
      live.delete(`${p.toLowerCase()}#resumed`)
    }
  })

  it('the Overview reads no transcript', async () => {
    const reads = vi.spyOn(sessions, 'anyTranscript')
    const usageFor = vi.spyOn(sessions as unknown as { usageFor: () => Promise<unknown> }, 'usageFor')
    await run(() => sessions.usageItems(p))
    expect(reads).not.toHaveBeenCalled()
    expect(usageFor).not.toHaveBeenCalled()
    reads.mockRestore()
    usageFor.mockRestore()
  })
})
