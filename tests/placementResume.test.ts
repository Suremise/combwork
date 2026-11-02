// A placement owed at a restart (HI-1746, slotCards.ts's place): the conversation it resumes for its stopped builder
// (sessions.leaseConversation: the newest of the agent's records of its provider bound to the card's lease, chosen
// before its hold; none only when there is no such record or its transcript is gone), and the window's Resume All
// joining a start of that same conversation (sessions.joinResume). A real workspace, its board and session records;
// the provider's transcript lookup and the slots' hold are stand-ins, and a start under way is put in sessions' own maps.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo } from './workflow/harness'

const state = vi.hoisted(() => ({
  /** Conversations whose transcript is on disk. */
  transcripts: new Set<string>(),
  /** The slots' hold on a conversation (resumeHold), by its id. */
  holds: new Map<string, { is: string; slot: string }>(),
  /** The transcript lookup fails (a read that can't be made now). */
  lookupFails: false
}))
vi.mock('../src/main/providers', async (orig) => {
  const actual = await orig<typeof import('../src/main/providers')>()
  const transcriptPath = async (_cwd: string, sessionId: string): Promise<string | null> => {
    if (state.lookupFails) throw new Error('EBUSY: the transcript folder is busy (test)')
    return state.transcripts.has(sessionId) ? `${sessionId}.jsonl` : null
  }
  // The adapter with only its transcript lookup replaced (its methods are its class's: kept through its prototype).
  const withLookup = <T extends object>(a: T): T => Object.assign(Object.create(a) as T, { transcriptPath })
  return { ...actual, allProviders: () => actual.allProviders().map(withLookup), provider: (id: string) => withLookup(actual.provider(id as never)) }
})
vi.mock('../src/shared/agentFolders', async (orig) => ({ ...(await orig<object>()), resumeHold: (_f: unknown, _a: unknown, s: { id: string }) => state.holds.get(s.id) ?? null }))

const base = tempDir('placementresume-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { boardWrite, boardWriteOp } = await import('../src/main/boardStore')
const { sessions } = await import('../src/main/sessions')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const wsPath = join(base, 'ws')
const project = join(wsPath, 'alpha')
const ws = createWorkspaceService()
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)

/** One of B1's conversations: its provider, when it was last active, and the lease it is bound to. */
async function record(id: string, o: { lease: string | null; at: string; provider?: string; agentId?: string }): Promise<void> {
  await run(() => ws.upsertSession(project, { id, agent: (o.provider ?? 'claude-code') as never, agentId: o.agentId ?? 'b1', cwd: join(base, 'slot-a'), name: id, lastActiveAt: o.at }))
  const host = (await ws.sessionScope(project)).scope
  await boardWrite(ws, async () => boardWriteOp(ws, (db) => db.prepare('UPDATE sessions SET lease = ? WHERE host = ? AND id = ?').run(o.lease, host, id)))
}
const chosen = () => run(() => sessions.leaseConversation(project, 'b1', 'l-card'))

beforeAll(async () => {
  gitRepo(project)
  commit(project, { '.gitignore': '.hive/\n', 'a.txt': 'a\n' }, 'first')
  mkdirSync(join(project, '.hive'), { recursive: true })
  const write = (id: string): void => writeFileSync(join(project, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id, agents: [{ id: 'b1', name: 'B1', provider: 'claude-code', workflowRole: 'builder' }] }))
  write('p1')
  await ws.open(wsPath)
  write((await ws.projectConfig(project)).id ?? 'p1')
  await ws.refresh()
  // B1's conversations: an older and a newer one bound to the card's lease, a newest one under another lease, one of
  // another provider bound to it (never B1's to resume now), and another agent's.
  await record('c-old', { lease: 'l-card', at: '2026-10-27T01:00:00.000Z' })
  await record('c-new', { lease: 'l-card', at: '2026-10-27T02:00:00.000Z' })
  await record('c-other-lease', { lease: 'l-other', at: '2026-10-27T03:00:00.000Z' })
  await record('c-codex', { lease: 'l-card', at: '2026-10-27T04:00:00.000Z', provider: 'codex' })
  await record('c-b2', { lease: 'l-card', at: '2026-10-27T05:00:00.000Z', agentId: 'b2' })
})

afterAll(async () => {
  await disposeWorkspaceService(ws)
})

describe("the conversation a placement resumes for its stopped builder (HI-1746)", () => {
  it("is the agent's newest of its provider bound to the card's lease", async () => {
    state.transcripts = new Set(['c-old', 'c-new', 'c-other-lease', 'c-codex', 'c-b2'])
    state.holds.clear()
    expect(await chosen()).toEqual({ is: 'resume', id: 'c-new', name: 'c-new' })
  })

  it('held: that hold, never the older one passed over to', async () => {
    state.transcripts = new Set(['c-old', 'c-new'])
    state.holds = new Map([['c-new', { is: 'draining', slot: 'slot-a' }]])
    expect(await chosen()).toEqual({ is: 'held', hold: { is: 'draining', slot: 'slot-a' } })
    state.holds.clear()
  })

  it('its transcript gone: none, so a new conversation starts (never the older one)', async () => {
    state.transcripts = new Set(['c-old'])
    expect(await chosen()).toEqual({ is: 'none' })
  })

  it("its transcript lookup failing (unknown, HR4's round 1): thrown, never none (so no new conversation is started)", async () => {
    state.transcripts = new Set(['c-old', 'c-new'])
    state.lookupFails = true
    try {
      await expect(chosen()).rejects.toThrow(/EBUSY/)
    } finally {
      state.lookupFails = false
    }
  })

  it("two as new as each other: the one saved first, as the project's records sorted by activity gave it (HR5's HI-1236 round 1)", async () => {
    // Saved a then z, at the same time (the agent's index, walked backwards, has z first).
    await record('c-tie-a', { lease: 'l-tie', at: '2026-10-27T06:00:00.000Z' })
    await record('c-tie-z', { lease: 'l-tie', at: '2026-10-27T06:00:00.000Z' })
    state.transcripts = new Set(['c-tie-z', 'c-tie-a'])
    expect(await run(() => sessions.leaseConversation(project, 'b1', 'l-tie'))).toEqual({ is: 'resume', id: 'c-tie-a', name: 'c-tie-a' })
  })

  it('no record bound to the lease: none', async () => {
    state.transcripts = new Set(['c-old', 'c-new'])
    expect(await run(() => sessions.leaseConversation(project, 'b1', 'l-none'))).toEqual({ is: 'none' })
  })
})

describe("Resume All joining a start of that same conversation (HI-1746)", () => {
  // Sessions' own maps, as a start or a running session leaves them.
  const internals = sessions as unknown as { live: Map<string, { state: { sessionId: string; runId: string } }>; starting: Map<string, { resumeId?: string; outcome: Promise<unknown> }> }
  const key = `${project.toLowerCase()}#b1`
  const join_ = () => run(() => sessions.joinResume(project, 'b1', 'c-new'))
  let runs = 0
  /**
   * A start of the conversation under way, as startReserved leaves it: in `starting`, and its live state already there
   * (put in before its launch runs, HR4's round 1), taken out again if the launch fails or is cancelled.
   */
  const pending = (resumeId: string): { settle: () => void; fail: (e: Error) => void } => {
    const runId = `run-${++runs}`
    let settle!: () => void
    let fail!: (e: Error) => void
    const outcome = new Promise<unknown>((res, rej) => {
      settle = () => {
        internals.starting.delete(key)
        res({ sessionId: resumeId, runId })
      }
      fail = (e) => {
        internals.starting.delete(key)
        internals.live.delete(key)
        rej(e)
      }
    })
    internals.starting.set(key, { resumeId, outcome })
    internals.live.set(key, { state: { sessionId: resumeId, runId } })
    return { settle, fail }
  }
  const clear = (): void => {
    internals.live.delete(key)
    internals.starting.delete(key)
  }

  it('running that conversation now: running', async () => {
    internals.live.set(key, { state: { sessionId: 'c-new', runId: 'run-live' } })
    try {
      expect(await join_()).toBe('running')
    } finally {
      clear()
    }
  })

  it("a start of it under way (its live state already there): running once it has started; its failure, or its cancellation, is Resume All's", async () => {
    try {
      const ok = pending('c-new')
      const joined = join_()
      ok.settle()
      expect(await joined).toBe('running')
      clear()
      const failing = pending('c-new')
      const refused = join_()
      failing.fail(new Error("its CLI couldn't start (test)"))
      await expect(refused).rejects.toThrow(/couldn't start/)
      const cancelling = pending('c-new')
      const cancelled = join_()
      cancelling.fail(new Error('The session was stopped before it started.'))
      await expect(cancelled).rejects.toThrow(/stopped before it started/)
    } finally {
      clear()
    }
  })

  it('another conversation running or starting, or nothing: other (the refusal stands)', async () => {
    try {
      expect(await join_()).toBe('other')
      internals.live.set(key, { state: { sessionId: 'c-old', runId: 'run-old' } })
      expect(await join_()).toBe('other')
      internals.live.delete(key)
      const other = pending('c-old')
      expect(await join_()).toBe('other')
      other.settle()
    } finally {
      clear()
    }
  })
})
