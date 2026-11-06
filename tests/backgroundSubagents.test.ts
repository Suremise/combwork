// #1584: HB6 showed "Finished" while nine background subagents it had launched ran #1126's reviews (24 Oct). Claude
// Code's Agent tool runs a subagent in the background with an `async_launched` result, which Combwork didn't count, so
// the turn's Stop left the agent finished. Here the transcript is read as Combwork reads it, the status settled after each
// read: subagents keep the agent in the background until the last ends, each end that Claude Code tells it of may
// open a turn (`woke`), a resumed one counts again, and one it stopped itself wakes nothing (#640). Codex's subagents
// are counted, and leave the agent finished, as its commands do (Codex starts no turn when one ends).
import { appendFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-bg-subagents-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')

type Task = { at: number; type?: string; description?: string }
type Live = { state: Record<string, unknown>; adapter: unknown; transcriptPath: string; tasks?: Map<string, Task>; woke?: boolean }
const s = sessions as unknown as { readBackground: (l: Live, path: string, size: number) => Promise<boolean>; settleBackground: (l: Live, woke: boolean) => void }

const line = (o: Record<string, unknown>): string => JSON.stringify(o) + '\n'
// Times from now: a task older than Settings' limit is dropped from the count.
const ago = (secs: number): string => new Date(Date.now() - secs * 1000).toISOString()
// As Claude Code 2.1 wrote HB6's (its transcript, 24 Oct), the prompt left out.
const launched = (id: string, description: string, at: string): string =>
  line({ type: 'user', timestamp: at, toolUseResult: { isAsync: true, status: 'async_launched', agentId: id, description, resolvedModel: 'claude-opus-5-5', prompt: '…', outputFile: `C:\\tasks\\${id}.output`, canReadOutputFile: true, canContinueAgent: true } })
const finished = (id: string, description: string, at: string): string =>
  line({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_018m</tool-use-id>\n<status>completed</status>\n<summary>Agent "${description}" finished</summary>\n</task-notification>` })
const queued = (id: string, at: string): string => line({ type: 'user', timestamp: at, toolUseResult: { success: true, message: `Message queued for delivery to ${id} at its next tool round. If it finishes first, it is resumed with the message and notifies again, so wait for that notification before resending.` } })
const resumed = (id: string, at: string): string => line({ type: 'user', timestamp: at, toolUseResult: { success: true, message: `Resuming agent ${id.slice(0, 7)}`, resumedAgentId: id, revivedAgentId: id } })
const stopped = (id: string, at: string): string => line({ type: 'user', timestamp: at, toolUseResult: { message: `Successfully stopped task: ${id} (Review pl translations part A)` } })

const A = 'ab1827f13c285365d'
const B = 'ac82ead91b961b4f2'
let n = 0
/** A running agent whose transcript holds `lines`, read up to there, its turn then over with Stop (`status`). */
async function agent(adapter: unknown, provider: string, lines: string, status: string): Promise<{ l: Live; file: string; read: () => Promise<void> }> {
  const file = join(base, `t${++n}.jsonl`)
  writeFileSync(file, lines)
  const state = { provider, runId: `run-${n}`, projectPath: join(base, 'p'), agentId: `a${n}`, sessionId: '55c580da-ba19-49b0-850b-41b41157471b', status: 'working', startedAt: ago(600) }
  const l: Live = { state, adapter, transcriptPath: file }
  const read = async (): Promise<void> => {
    s.settleBackground(l, await s.readBackground(l, file, statSync(file).size))
  }
  await read()
  l.state.status = status
  return { l, file, read }
}
const claude = (): ReturnType<typeof agent> => agent(claudeCode, 'claude-code', launched(A, 'Review pl translations part A', ago(300)) + launched(B, 'Review pl translations part B', ago(300)), 'background')

describe('background subagents (#1584)', () => {
  it('count as background tasks, with what they are and their descriptions', async () => {
    const { l } = await claude()
    expect([...(l.tasks?.values() ?? [])].map((t) => `${t.type}: ${t.description}`)).toEqual(['subagent: Review pl translations part A', 'subagent: Review pl translations part B'])
  })

  it('a turn that ended while they run leaves the agent in the background, until the last ends', async () => {
    const { l, file, read } = await claude()
    appendFileSync(file, finished(A, 'Review pl translations part A', ago(60)))
    await read()
    expect(l.tasks?.size).toBe(1)
    expect(l.state.status).toBe('background')
    // Claude Code tells it of each end and begins a turn for it: that wake may open a turn though another runs on.
    expect(l.woke).toBe(true)
    l.woke = false
    appendFileSync(file, finished(B, 'Review pl translations part B', ago(30)))
    await read()
    expect(l.tasks?.size).toBe(0)
    expect(l.state.status).toBe('working')
    expect(l.woke).toBe(true)
  })

  it('a message queued to one running changes nothing; one resumed after it finished counts again', async () => {
    const { l, file, read } = await claude()
    appendFileSync(file, queued(B, ago(200)) + finished(A, 'Review pl translations part A', ago(100)) + finished(B, 'Review pl translations part B', ago(90)))
    await read()
    expect(l.tasks?.size).toBe(0)
    // Its turn for the last end is over: finished, then a message resumes A.
    l.state.status = 'finished'
    appendFileSync(file, resumed(A, ago(30)))
    await read()
    expect([...(l.tasks?.entries() ?? [])].map(([id, t]) => `${id} ${t.description}`)).toEqual([`${A} Review pl translations part A`])
    expect(l.state.status).toBe('background')
    // It notifies again when it stops, which ends it.
    appendFileSync(file, finished(A, 'Review pl translations part A', ago(5)))
    await read()
    expect(l.tasks?.size).toBe(0)
  })

  it('one the agent stops itself ends without a wake (#640), the last leaving it finished', async () => {
    const { l, file, read } = await claude()
    appendFileSync(file, stopped(A, ago(60)) + stopped(B, ago(50)))
    await read()
    expect(l.tasks?.size).toBe(0)
    expect(l.state.status).toBe('finished')
    expect(l.woke).toBeFalsy()
  })
})

// As Codex 0.164 wrote a parent's rollout (the test home, 24 Oct): its subagent outlived the turn that spawned it.
const activity = (kind: string, at: string): string =>
  line({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', thread_id: '01a16de6-192e', turn_id: '01a16de6-1a94', item: { type: 'SubAgentActivity', model: null, reasoning_effort: null, id: `subagent-${kind}`, kind, agent_thread_id: '01a16de6-2c40-7ef2-b882-f6423230efbe', agent_path: '/root/sleep_task' } } })

describe("Codex's subagents (#1584)", () => {
  it('are counted while they run, the agent finished (Codex starts no turn when one ends)', async () => {
    const { l, file, read } = await agent(codex, 'codex', activity('started', ago(80)), 'finished')
    expect(l.tasks?.size).toBe(1)
    expect(l.state.backgroundTasks).toBe(1)
    appendFileSync(file, activity('completed', ago(1)))
    await read()
    expect(l.tasks?.size).toBe(0)
    expect(l.state.status).toBe('finished')
  })
})
