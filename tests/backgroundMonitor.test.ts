// HI-3423: on 19 Nov HB1 (HI-3357) waited on rc.15's unit and fake e2e runs with a Claude Code Monitor and ended its
// turn. The Monitor reported the unit run's end ("unit exit=1") and waited on for the e2e run, but Combwork read that first
// event as the Monitor's end: HB1 showed finished with no background task, and its card stalled as not watched. Here the
// transcript is read as Combwork reads it, in HB1's shapes (Claude Code 2.1.326): the agent stays waiting on its Monitor
// through its events, so its lane's stall check leaves it be, and the Monitor's end (its expiry, its stream ending) wakes it.
import { appendFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-bg-monitor-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { unwatched } = await import('../src/main/loopCheck')

type Live = { state: Record<string, unknown>; adapter: unknown; transcriptPath: string; tasks?: Map<string, unknown>; woke?: boolean }
const s = sessions as unknown as {
  readBackground: (l: Live, path: string, size: number) => Promise<boolean>
  settleBackground: (l: Live, woke: boolean) => void
}

const min = 60_000
const line = (o: Record<string, unknown>): string => JSON.stringify(o) + '\n'
const iso = (ms: number): string => new Date(ms).toISOString()
// As Claude Code 2.1.326 wrote HB1's (tests/fixtures/advanced/monitor-claude-2.1.326.jsonl).
const armed = (id: string, at: number): string => line({ type: 'user', timestamp: iso(at), version: '2.1.326', toolUseResult: { taskId: id, timeoutMs: 30 * min, persistent: false } })
const notified = (id: string, at: number, body: string): string => line({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(at), content: `<task-notification>\n<task-id>${id}</task-id>\n${body}\n</task-notification>` })
const event = (id: string, at: number, text: string): string => notified(id, at, `<summary>Monitor event: "rc.15 unit and fake e2e runs finishing"</summary>\n<event>${text}</event>`)
const expired = (id: string, at: number): string => event(id, at, '[Monitor expired after 30m with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]')
const ended = (id: string, at: number): string =>
  notified(id, at, `<tool-use-id>toolu_01</tool-use-id>\n<output-file>C:\\work\\tasks\\${id}.output</output-file>\n<status>completed</status>\n<summary>Monitor "rc.15 unit and fake e2e runs finishing" stream ended</summary>\n<event>e2e exit=0</event>`)

let n = 0
/** A Claude Code agent whose turn ended with a Monitor armed `armedMinAgo` minutes ago. */
async function agent(id: string, armedMinAgo: number): Promise<{ l: Live; read: (more: string) => Promise<void> }> {
  const file = join(base, `t${++n}.jsonl`)
  const at = Date.now() - armedMinAgo * min
  writeFileSync(file, armed(id, at))
  const state = { provider: 'claude-code', runId: `run-${n}`, projectPath: join(base, 'p'), agentId: `a${n}`, sessionId: '55c580da-ba19-49b0-850b-41b41157471b', status: 'working', startedAt: iso(at - min) }
  const l: Live = { state, adapter: claudeCode, transcriptPath: file }
  const read = async (more: string): Promise<void> => {
    if (more) appendFileSync(file, more)
    s.settleBackground(l, await s.readBackground(l, file, statSync(file).size))
  }
  await read('')
  // Its turn ends with the Monitor running: waiting on it, not finished.
  l.state.status = 'finished'
  s.settleBackground(l, false)
  return { l, read }
}

const seen = (l: Live): unknown[] => [l.state.status, l.state.backgroundTasks, unwatched(l.state as never)]

describe('a Claude Code Monitor counts until it ends (HI-3423)', () => {
  it("HB1's case: an event while it waits on leaves the agent waiting on it, so its lane isn't stalled", async () => {
    const { l, read } = await agent('bmrnz1tfk', 22)
    expect(seen(l)).toEqual(['background', 1, false])
    // The event begins a turn (working), which ends with the Monitor still running.
    await read(event('bmrnz1tfk', Date.now(), 'unit exit=1'))
    expect([l.tasks?.size, l.woke]).toEqual([1, undefined])
    l.state.status = 'finished'
    s.settleBackground(l, false)
    expect(seen(l)).toEqual(['background', 1, false])
    // Its stream ends with the e2e run: Claude Code begins a turn for it, and the agent works again.
    await read(ended('bmrnz1tfk', Date.now()))
    expect([l.state.status, l.state.backgroundTasks, l.woke]).toEqual(['working', undefined, true])
  })

  it('its expiry ends it and wakes the agent, which Claude Code tells to re-arm it', async () => {
    const { l, read } = await agent('bncri2uo6', 29)
    expect(seen(l)).toEqual(['background', 1, false])
    await read(expired('bncri2uo6', Date.now()))
    expect([l.state.status, l.state.backgroundTasks, l.woke]).toEqual(['working', undefined, true])
  })
})
