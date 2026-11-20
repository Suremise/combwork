// HI-3376 (HR1's round 1): a run counts as still closing until its exit work is over, not only while it is a live
// session. onExit takes a run out of `live` part way through, before its transcript's check and its session list's
// write; a close (closingAgents.ts, counting sessions.closingPending) must still wait for those. The real SessionManager's
// onExit, with its transcript check held open after the run has left `live`.
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { timing } from './timing.cjs'

const base = tempDir('closing-exit-work-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { sessions } = await import('../src/main/sessions')
const { waitForAgentsClosed, closingLimits } = await import('../src/main/closingAgents')

/** A bound for a hung run, never how long a step should take. */
const HUNG_MS = timing('wait.hang')

type Internals = {
  live: Map<string, unknown>
  backup: (...a: unknown[]) => Promise<void>
  anyTranscript: (...a: unknown[]) => Promise<string | null>
  onExit: (projectPath: string, agentId: string, runId: string, code: number) => Promise<void>
}
const s = sessions as unknown as Internals
const PROJECT = join(base, 'proj')
const AGENT = 'a-1'
const RUN = 'run-closing-1'

const saved = { backup: s.backup, anyTranscript: s.anyTranscript }
afterEach(() => {
  s.backup = saved.backup
  s.anyTranscript = saved.anyTranscript
  s.live.clear()
})

/** A run of AGENT live in PROJECT, as the launch leaves one (only what its exit reads). */
function liveRun(): void {
  s.live.set(`${PROJECT}#${AGENT}`.toLowerCase(), {
    state: { projectPath: PROJECT, agentId: AGENT, runId: RUN, sessionId: 's-1', status: 'ready', settingUp: false, cwd: PROJECT, startedAt: new Date().toISOString(), provider: 'claude-code' },
    adapter: { descriptor: { name: 'Claude Code' }, launch: {}, transcript: {} }
  })
}

describe('a run still closing until its exit work is over (HI-3376)', () => {
  it('out of live but its transcript check and session list still to come: still counted, and a close keeps waiting until they are done', async () => {
    liveRun()
    // The live key as sessions makes it (liveId): found by what closingPending counts before the exit.
    expect(sessions.closingPending().running).toBe(1)
    s.backup = async () => undefined
    let release!: () => void
    let reached!: () => void
    const atCheck = new Promise<void>((r) => (reached = r))
    s.anyTranscript = () => {
      reached()
      return new Promise<string | null>((r) => (release = () => r(null)))
    }
    const exit = s.onExit(PROJECT, AGENT, RUN, 0).catch(() => undefined)
    try {
      await atCheck
      // Out of live by now, its exit work not over: still one running.
      expect([...s.live.keys()].length).toBe(0)
      expect(sessions.closingPending().running).toBe(1)
      expect(sessions.closingPending((p) => p === PROJECT).running).toBe(1)
      expect(sessions.closingPending((p) => p !== PROJECT).running).toBe(0)
      // A close counting it keeps waiting while it is held: each of its looks counted, waited for (never a sleep).
      const result = { how: null as string | null, looks: 0 }
      const waited = waitForAgentsClosed({ pending: () => (result.looks++, sessions.closingPending()), deadlineMs: HUNG_MS, windows: () => [], send: () => undefined }).then((h) => (result.how = h))
      await vi.waitFor(() => expect(result.looks).toBeGreaterThanOrEqual(3), { timeout: HUNG_MS, interval: closingLimits.lookMs / 4 })
      // Three looks made while it is held, each seeing it still closing.
      expect(result.how).toBeNull()
      release()
      await exit
      expect(sessions.closingPending().running).toBe(0)
      await waited
      expect(result.how).toBe('settled')
    } finally {
      // An assertion failing above still lets go of the held exit.
      release?.()
      await exit
    }
  })

  it('an exit whose work throws is let go of too (its finally)', async () => {
    liveRun()
    s.backup = async () => undefined
    s.anyTranscript = async () => {
      throw new Error('disk gone')
    }
    await s.onExit(PROJECT, AGENT, RUN, 0).catch(() => undefined)
    expect(sessions.closingPending().running).toBe(0)
  })
})
