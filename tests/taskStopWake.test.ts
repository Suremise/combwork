// #640: HB3 showed "working" after its turn ended (13 Oct, Hive 0.6.0). It had stopped its only background task (a
// `sleep 2400` slot timer) with TaskStop 9 s before its Stop; its Stop left it waiting on background tasks, and when Combwork
// then read the TaskStop it took the task's end for a wake, as a <task-notification> is, and showed it working: Claude
// Code tells the agent of a task that ends, starting a turn, but not of one it stopped itself. Here the transcript is read
// as Combwork reads it, the status settled after each read: a task stopped by the agent leaves it finished; one that ends
// by itself wakes it, as before.
import { appendFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-taskstop-wake-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')

type Live = { state: Record<string, unknown>; adapter: unknown; transcriptPath: string; tasks?: Map<string, unknown>; woke?: boolean }
const s = sessions as unknown as { readBackground: (l: Live, path: string, size: number) => Promise<boolean>; settleBackground: (l: Live, woke: boolean) => void }

const line = (o: Record<string, unknown>): string => JSON.stringify(o) + '\n'
// As Claude Code 2.1.296 wrote HB3's (its transcript, 13 Oct).
const started = (id: string, at: string): string => line({ type: 'user', timestamp: at, toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: id } })
const stopped = (id: string, at: string): string => line({ type: 'user', timestamp: at, toolUseResult: { message: `Successfully stopped task: ${id} (sleep 2400; echo "extend the merge slot")`, task_id: id, task_type: 'local_bash', command: 'sleep 2400; echo "extend the merge slot"' } })
const notified = (id: string, at: string): string => line({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>` })

// Times from now: a task older than Settings' limit is dropped from the count.
const ago = (secs: number): string => new Date(Date.now() - secs * 1000).toISOString()
let n = 0
/** A running Claude Code agent whose transcript has started one background task, read up to there. */
async function agent(): Promise<{ l: Live; file: string; read: () => Promise<void> }> {
  const file = join(base, `t${++n}.jsonl`)
  writeFileSync(file, started('b6yi5x9z5', ago(120)))
  const state = { provider: 'claude-code', runId: `run-${n}`, projectPath: join(base, 'p'), agentId: `a${n}`, sessionId: '55c580da-ba19-49b0-850b-41b41157471b', status: 'working', startedAt: ago(600) }
  const l: Live = { state, adapter: claudeCode, transcriptPath: file }
  // What the transcript gained, read as Combwork does when it grows: the count, then the status from it.
  const read = async (): Promise<void> => {
    s.settleBackground(l, await s.readBackground(l, file, statSync(file).size))
  }
  await read()
  expect(l.tasks?.size).toBe(1)
  // Its Stop came before Combwork read the end: waiting on its background task.
  l.state.status = 'background'
  return { l, file, read }
}

describe('a background task the agent stopped itself (#640)', () => {
  it('leaves the agent finished when read after its Stop: nothing wakes it', async () => {
    const { l, file, read } = await agent()
    appendFileSync(file, stopped('b6yi5x9z5', ago(9)))
    await read()
    expect(l.tasks?.size).toBe(0)
    expect(l.state.status).toBe('finished')
    expect(l.woke).toBeFalsy()
  })

  it('a task that ends by itself still wakes it: Claude Code tells the agent and starts a turn', async () => {
    const { l, file, read } = await agent()
    appendFileSync(file, notified('b6yi5x9z5', ago(1)))
    await read()
    expect(l.tasks?.size).toBe(0)
    expect(l.state.status).toBe('working')
    expect(l.woke).toBe(true)
  })
})
