// HI-3406: on 18 Nov HB5 and HB6 showed "Stopped counting its background tasks after 120 minutes", and their lanes
// stalled, while their cw-progress runs were still reporting (HB5's fake-codex scenarios at step 28 of 64). The time limit
// counted from the task's start, whatever its runs said. Here the transcript is read as Combwork reads it and the count
// swept as its looks do: a task whose agent's run still reports stays counted past the limit, one with no progress is
// still dropped (MB1's hyper-v run, silent from 03:34, really was stuck), and a dropped task that ends after all wakes
// the agent, as a counted one does (Claude Code begins that turn itself).
import { appendFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-bg-limit-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { config } = await import('../src/main/config')

type Run = { state: 'running' | 'stale' | 'passed'; finishedAt: number | null; startedAt: number; updatedAt: number }
type Live = { state: Record<string, unknown>; adapter: unknown; transcriptPath: string; tasks?: Map<string, unknown>; woke?: boolean }
const s = sessions as unknown as {
  readBackground: (l: Live, path: string, size: number) => Promise<boolean>
  settleBackground: (l: Live, woke: boolean) => void
  followProgress: (fn: (projectPath: string, agentId: string) => Run[]) => void
}

const min = 60_000
const line = (o: Record<string, unknown>): string => JSON.stringify(o) + '\n'
const iso = (ms: number): string => new Date(ms).toISOString()
// As Claude Code writes a Bash call, its result once the command is in the background, and its end.
const callLine = (id: string, at: number): string => line({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Bash', input: { command: 'cw-progress -- npm test' } }] } })
const startedLine = (id: string, at: number): string =>
  line({ type: 'user', timestamp: iso(at), message: { role: 'user', content: [{ tool_use_id: `toolu_${id}`, type: 'tool_result', content: `Command running in background with ID: ${id}.` }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id } })
const endedLine = (id: string, at: number): string =>
  line({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(at), content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Background command "Run tests" completed (exit code 0)</summary>\n</task-notification>` })

let runs: Run[] = []
s.followProgress(() => runs)
const limit = config.settings.agents.backgroundTaskMinutes
afterEach(() => {
  runs = []
  config.settings.agents.backgroundTaskMinutes = limit
})

let n = 0
/**
 * A Claude Code agent whose turn ended while task `id`, started `startedMinAgo` minutes ago, runs; `progress`: its
 * cw-progress runs; `calledMinAgo`: when its Bash call was made, if before (a command moved to the background later).
 * Its first read is a look, so the limit applies at once.
 */
async function agent(id: string, startedMinAgo: number, progress: Run[] = [], calledMinAgo = startedMinAgo): Promise<{ l: Live; file: string; read: () => Promise<void> }> {
  config.settings.agents.backgroundTaskMinutes = 120
  runs = progress
  const file = join(base, `t${++n}.jsonl`)
  const at = Date.now() - startedMinAgo * min
  const called = Date.now() - calledMinAgo * min
  writeFileSync(file, callLine(id, called) + startedLine(id, at))
  const state = { provider: 'claude-code', runId: `run-${n}`, projectPath: join(base, 'p'), agentId: `a${n}`, sessionId: '55c580da-ba19-49b0-850b-41b41157471b', status: 'working', startedAt: iso(called - min) }
  const l: Live = { state, adapter: claudeCode, transcriptPath: file }
  const read = async (): Promise<void> => s.settleBackground(l, await s.readBackground(l, file, statSync(file).size))
  await read()
  l.state.status = 'background'
  return { l, file, read }
}

describe('background tasks past the time limit (HI-3406)', () => {
  it("a long run with progress: counted past the limit while its agent's cw-progress run reports", async () => {
    const { l } = await agent('b1', 150, [{ state: 'running', finishedAt: null, startedAt: Date.now() - 149 * min, updatedAt: Date.now() - 10_000 }])
    s.settleBackground(l, false)
    expect(l.tasks?.size).toBe(1)
    expect([l.state.status, l.state.backgroundTasks]).toEqual(['background', 1])
  })

  // HR1's round 1: a command moved to the background after running a while (Claude Code writes its backgroundTaskId
  // only then) had a cw-progress run that started before that record; it is still the command's own.
  it('a command that reported first and went to the background later: kept while its run reports, past the limit', async () => {
    const reporting = { state: 'running' as const, finishedAt: null, startedAt: Date.now() - 155 * min + 10_000, updatedAt: Date.now() - 5_000 }
    const { l } = await agent('b5', 150, [reporting], 155)
    expect([l.tasks?.size, l.state.status]).toEqual([1, 'background'])
    // A run from before its call isn't its: an older run still reporting keeps nothing counted.
    const { l: other } = await agent('b6', 150, [{ ...reporting, startedAt: Date.now() - 170 * min }], 155)
    s.settleBackground(other, false)
    expect([other.tasks?.size, other.state.status]).toEqual([0, 'finished'])
  })

  it('a truly stuck run (its progress quiet since soon after it began) still stops counting at the limit', async () => {
    const { l } = await agent('b2', 150, [{ state: 'running', finishedAt: null, startedAt: Date.now() - 149 * min, updatedAt: Date.now() - 10_000 }])
    expect(l.tasks?.size).toBe(1)
    // Then its run goes quiet: stale, last heard from 145 minutes ago.
    runs = [{ state: 'stale', finishedAt: null, startedAt: Date.now() - 149 * min, updatedAt: Date.now() - 145 * min }]
    s.settleBackground(l, false)
    expect(l.tasks?.size).toBe(0)
    expect(l.state.status).toBe('finished')
    expect(l.state.statusMessage).toBe('Stopped counting its background tasks after 120 minutes')
  })

  it('a run that finishes after the limit dropped it still wakes the agent', async () => {
    const { l, file, read } = await agent('b3', 150)
    s.settleBackground(l, false)
    expect(l.state.status).toBe('finished')
    appendFileSync(file, endedLine('b3', Date.now()))
    await read()
    // Claude Code begins a turn for it: the agent works again, and that wake may open the turn (turnLedger rule 1).
    expect([l.state.status, l.state.statusMessage, l.woke]).toEqual(['working', undefined, true])
  })

  it('one the agent stopped itself after the drop wakes nothing (#640)', async () => {
    const { l, file, read } = await agent('b4', 150)
    s.settleBackground(l, false)
    appendFileSync(file, line({ type: 'user', timestamp: iso(Date.now()), toolUseResult: { message: 'Successfully stopped task: b4 (npm test)' } }))
    await read()
    expect([l.state.status, l.woke]).toEqual(['finished', undefined])
  })
})
