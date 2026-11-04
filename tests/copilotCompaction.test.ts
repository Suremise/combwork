// Copilot's compactions (#454), from a real sample (tests/fixtures/copilot/compaction-1.0.98.jsonl: Copilot CLI 1.0.98
// offline against the scripted model, a prompt, three file views, /compact, a prompt, /exit): counted in usage, shown in
// the Sessions tab, and, as Copilot sends PreCompact but no hook at the end, its end read from events.jsonl ends Hive's
// compacting status. An automatic compaction couldn't be made offline (#454's comment says what was tried).
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { CopilotConversationParser, eventsDetails, parseEvents } from '../src/main/providers/copilot/events'
import { tempDir } from './tempDir'

const SAMPLE = readFileSync(join(__dirname, 'fixtures', 'copilot', 'compaction-1.0.98.jsonl'), 'utf8')
const ID = '53468de9-906c-4619-8d26-cc6b1e15ac4e'
const COMPLETED = '2026-10-19T20:40:24.324Z'

describe("Copilot's compactions in its events (#454)", () => {
  it('counts one in usage: the whole context before (its start) and after (system, conversation and tools)', () => {
    const u = parseEvents(SAMPLE, ID)
    expect(u.compactions).toEqual([{ timestamp: COMPLETED, trigger: 'manual', preTokens: 8070 + 550 + 7021, postTokens: 8070 + 108 + 7021 }])
    expect(Object.values(u.days ?? {}).reduce((n, d) => n + d.compactions, 0)).toBe(1)
    // The exit's count of the context is the latest.
    expect(u.contextTokens).toBe(15341)
  })

  it('takes the context down to what the compaction left, until the next report', () => {
    const upTo = SAMPLE.slice(0, SAMPLE.indexOf('\n', SAMPLE.indexOf('"session.compaction_complete"')) + 1)
    expect(parseEvents(upTo, ID).contextTokens).toBe(15199)
  })

  it('shows it in the Sessions tab with the summary Copilot carries on from', () => {
    const p = new CopilotConversationParser(null)
    p.feed(Buffer.from(SAMPLE))
    const items = p.items.filter((i) => i.kind === 'compaction')
    expect(items).toEqual([expect.objectContaining({ kind: 'compaction', timestamp: COMPLETED, trigger: 'manual', preTokens: 8070 + 550 + 7021, postTokens: 15199, nextRequestTokens: null, summary: 'Done.' })])
    // In its place: after the last prompt before it, before the one after.
    const users = p.items.filter((i) => i.kind === 'user').map((i) => i.id)
    expect(users.filter((id) => id < items[0].id)).toHaveLength(4)
    expect(users.filter((id) => id > items[0].id)).toHaveLength(1)
  })

  it('a compaction that started but never completed, or failed, counts nothing', () => {
    const start = SAMPLE.split('\n').find((l) => l.includes('"session.compaction_start"'))!
    const failed = SAMPLE.split('\n').find((l) => l.includes('"session.compaction_complete"'))!.replace('"success":true', '"success":false')
    for (const text of [`${start}\n`, `${start}\n${failed}\n`]) {
      expect(parseEvents(text, ID).compactions).toEqual([])
      const p = new CopilotConversationParser(null)
      p.feed(Buffer.from(text))
      expect(p.items.filter((i) => i.kind === 'compaction')).toEqual([])
    }
  })

  it('says when it completed, for the status (Copilot sends no hook at the end)', () => {
    expect(eventsDetails(SAMPLE).compactedAt).toBe(COMPLETED)
    expect(eventsDetails(SAMPLE.slice(0, SAMPLE.indexOf('"session.compaction_complete"'))).compactedAt).toBeUndefined()
  })
})

const base = tempDir('hive-copilot-compaction-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

describe("a Copilot compaction's end ends Hive's compacting status (#454)", () => {
  const wsPath = join(base, 'ws')
  const p = join(wsPath, 'alpha')
  let sessions: typeof import('../src/main/sessions').sessions
  let run: <T>(fn: () => Promise<T>) => Promise<T>
  let dispose: () => Promise<void>

  beforeAll(async () => {
    const workspace = await import('../src/main/workspace')
    ;({ sessions } = await import('../src/main/sessions'))
    const { providerService } = await import('../src/main/providerService')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const ws = workspace.createWorkspaceService()
    await ws.open(wsPath)
    run = (fn) => workspace.inWorkspace(ws, fn)
    dispose = () => workspace.disposeWorkspaceService(ws)
    vi.spyOn(providerService, 'refresh').mockResolvedValue([])
    const s = sessions as unknown as { notify: () => void; setInbox: () => void }
    s.notify = () => {}
    s.setInbox = () => {}
    sessions.inboxNotice = null
  })
  afterAll(async () => {
    ;(sessions as unknown as { live: Map<string, unknown> }).live.clear()
    await dispose()
  })

  type State = { runId: string; status: string; statusSince?: string; startedAt: string }
  type Live = { state: State; hooksSeen?: number; compactedAt?: string }
  const s = () => sessions as unknown as { live: Map<string, Live>; runs: Map<string, string>; applyDetails: (l: Live, d: object, hooks?: number) => void; inHookOrder: (run: string, fn: () => void) => Promise<void> }
  const preCompact = (): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'copilot', 'sessionstart-1.0.98.json'), 'utf8')).hooks.find((h: { hook_event_name: string }) => h.hook_event_name === 'PreCompact')
  let n = 0

  /** A running Copilot agent that has just begun a /compact typed in it (its PreCompact handled): "Compacting…". */
  async function compacting(): Promise<Live> {
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    const { newLedger } = await import('../src/main/turnLedger')
    const agentId = `c${++n}`
    const st = { provider: 'copilot', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: ID, status: 'ready', startedAt: new Date(Date.now() - 60_000).toISOString(), launchSignature: '', unseen: false }
    const key = `${p.toLowerCase()}#${agentId}`
    s().live.set(key, { state: st, adapter: copilot, transcriptMtime: '', transcriptPath: null, defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, ledger: newLedger() } as never)
    s().runs.set(st.runId, key)
    await run(async () => sessions.handleHook(st.runId, { ...preCompact(), session_id: ID, cwd: p }, null))
    await vi.waitFor(() => expect(st.status).toBe('working'), { timeout: 10_000 })
    return s().live.get(key)!
  }
  /** Everything queued for the launch so far has run (its hooks and what details queued behind them). */
  const settled = (l: Live) => s().inHookOrder(l.state.runId, () => undefined)
  const later = (ms = 1000) => new Date(Date.now() + ms).toISOString()

  it('a /compact typed in it: ready again once events.jsonl says it completed, once', async () => {
    const l = await compacting()
    // A completion from before this launch is history.
    s().applyDetails(l, { compactedAt: new Date(Date.parse(l.state.startedAt) - 1000).toISOString() })
    await settled(l)
    expect(l.state.status).toBe('working')
    const end = later()
    s().applyDetails(l, { compactedAt: end }, l.hooksSeen)
    await vi.waitFor(() => expect(l.state.status).toBe('ready'), { timeout: 10_000 })
    expect(l.compactedAt).toBe(end)
  })

  it("an older compaction's end, read late, never ends a newer one (review round 1)", async () => {
    // Read before the newer PreCompact came (the read's hooks are fewer than the launch's now).
    const l = await compacting()
    s().applyDetails(l, { compactedAt: later(500) }, (l.hooksSeen ?? 1) - 1)
    await settled(l)
    expect(l.state.status).toBe('working')
    // Read after it came, but the end it found is from before it began: an earlier compaction's.
    s().applyDetails(l, { compactedAt: new Date(Date.parse(l.state.statusSince!) - 1000).toISOString() }, l.hooksSeen)
    await settled(l)
    expect(l.state.status).toBe('working')
    // The same end read again, or an earlier one, counts once; this compaction's own end ends it.
    const end = later(2000)
    s().applyDetails(l, { compactedAt: end }, l.hooksSeen)
    await vi.waitFor(() => expect(l.state.status).toBe('ready'), { timeout: 10_000 })
    await run(async () => sessions.handleHook(l.state.runId, { ...preCompact(), session_id: ID, cwd: p }, null))
    await vi.waitFor(() => expect(l.state.status).toBe('working'), { timeout: 10_000 })
    s().applyDetails(l, { compactedAt: end }, l.hooksSeen)
    await settled(l)
    expect(l.state.status).toBe('working')
  })
})
