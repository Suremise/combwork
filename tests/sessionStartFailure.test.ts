// A start's failure stands (HI-1976, HR6's round 1): a CLI that exits before its session started, while its start's
// bookkeeping after the spawn is still under way, leaves its failure for the card's stall, however the start settles
// after. A new start clears it before it runs. The start's own work is a stand-in here (startReserved held), its exit
// the real onExit.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-startfailure-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { resetAgentStartsForTests, startFailed, startNow } = await import('../src/main/agentStarts')
const { agentNowOf } = await import('../src/main/cardStall')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type Internals = {
  live: Map<string, unknown>
  startReserved: (...a: unknown[]) => Promise<unknown>
  onExit: (projectPath: string, agentId: string, runId: string, code: number, output?: string) => Promise<void>
}
const s = sessions as unknown as Internals
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

/** B1's live entry as a launch leaves it once its CLI has spawned, its session not started yet. */
const spawned = (runId: string) => ({ state: { provider: 'claude', runId, projectPath: p, agentId: 'b1', cwd: p, sessionId: '', status: 'starting', startedAt: new Date().toISOString(), launchSignature: '', unseen: false }, adapter: claudeCode, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })

describe("a start's failure (HI-1976)", () => {
  const original = s.startReserved
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    s.startReserved = original
    s.live.clear()
    resetAgentStartsForTests()
    await disposeWorkspaceService(w)
  })

  it("its CLI exiting while the start's bookkeeping is held: the failure, with why, stands once the start settles", async () => {
    // An earlier start's failure: the new start clears it before it runs.
    startFailed(p, 'b1', 'an earlier failure')
    let settle!: () => void
    let reserved!: () => void
    const isReserved = new Promise<void>((r) => (reserved = r))
    s.startReserved = (...a: unknown[]) => {
      const id = a[2] as string
      s.live.set(id, spawned('run-1'))
      reserved()
      // Held after the spawn (its session's record being written), until the test lets it go.
      return new Promise((res) => (settle = () => res((s.live.get(id) as { state: unknown } | undefined)?.state ?? spawned('run-1').state)))
    }
    const starting = run(() => sessions.start(p, { agentId: 'b1' }))
    await isReserved
    expect(startNow(p, 'b1').failed).toBeNull()
    // Starting, not stalled, while its start is under way.
    expect(agentNowOf(p, 'b1', 'B1')).toEqual({ name: 'B1', running: true })
    // Its CLI refuses an option and exits before its session started.
    await run(() => s.onExit(p, 'b1', 'run-1', 1, 'error: unknown option --bogus\r\n'))
    expect(startNow(p, 'b1').failed).toMatch(/unknown option --bogus/)
    settle()
    await starting.catch(() => undefined)
    // Settled after: the failure stands, and the card's stall says why.
    expect(startNow(p, 'b1').failed).toMatch(/unknown option --bogus/)
    expect(agentNowOf(p, 'b1', 'B1')).toEqual({ name: 'B1', running: false, failed: expect.stringMatching(/unknown option --bogus/) })
  })
})
