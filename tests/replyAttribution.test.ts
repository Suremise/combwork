// Combwork's own line is never told as the user's reply (HI-2218, #418): the user pressed Enter in an agent's pane, then
// within 15 s Combwork typed a line there whose prompt its CLI reported taken while sendPrompt still waited for it (its
// confirm loop, before `typed` was recorded); or a launch's task on its command line was taken just after the user
// answered its start screen. With the real SessionManager on a stand-in Claude Code input: no reply is told for Combwork's
// line or task; the user's own prompt after it still is.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeInput } from './claudeInputStandIn'

const { writes, echo, onEnter } = vi.hoisted(() => ({ writes: [] as string[], echo: { to: null as null | { write(d: string): void } }, onEnter: { fn: null as null | (() => void) } }))
vi.mock('../src/main/ptyHost', async (original) => ({
  ...((await original()) as object),
  writePty: (_key: string, data: string) => {
    writes.push(data)
    echo.to?.write(data)
    if (data === '\r') onEnter.fn?.()
  }
}))
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { hookStep } = await import('../src/main/hookStatus')

const project = 'C:/hive-test/reply-attribution'
const id = 'r1'
const key = `${project.toLowerCase()}#${id}`
/** Its terminal's key (agentPtyKey), as the user's typing is noted by. */
const pty = `session:${key}`
type Entry = Record<string, unknown> & { state: Record<string, unknown> & { status: string; runId: string }; prompts?: number }
const s = sessions as unknown as {
  live: Map<string, Entry>
  delivering: Set<string>
  userInput: Map<string, unknown>
  userEnter: Map<string, number>
  carryOut(id: string, l: Entry, step: unknown, cause: string, ev?: unknown): void
  statusInput(l: Entry): unknown
}

function running(): Entry {
  const claude = claudeInput({ paste: true })
  echo.to = { write: claude.feed }
  const e: Entry = { state: { projectPath: project, agentId: id, agentName: 'LB1', runId: 'run1', status: 'ready', open: [] }, adapter: claudeCode, screen: claude.screen, prompts: 0, open: [] }
  s.live.set(key, e)
  return e
}
/** Its CLI reports a prompt taken (UserPromptSubmit), as its hook would. */
const prompted = (e: Entry, text: string): void => {
  const ev = { kind: 'prompt', text }
  s.carryOut(key, e, hookStep(ev as never, s.statusInput(e) as never), 'Hook', ev)
}

describe("Combwork's own line isn't the user's reply (HI-2218)", () => {
  afterEach(() => {
    s.live.delete(key)
    s.delivering.clear()
    s.userInput.delete(pty)
    s.userEnter.delete(pty)
    writes.length = 0
    echo.to = null
    onEnter.fn = null
    vi.restoreAllMocks()
  })

  it("the user's Enter, then Combwork's line reported taken before its delivery returns: no reply; the user's own prompt after it is one", async () => {
    const replies: string[] = []
    vi.spyOn(sessions, 'userReplied').mockImplementation((_p, _a, _n, text) => void replies.push(text))
    const e = running()
    // The user answers something in the pane (the agent's startup, say): their Enter.
    sessions.noteUserInput(pty, '\r')
    const line = '[CW] New in your inbox: 1 task (m672)'
    let reportedWhileDelivering = false
    // Its CLI takes Combwork's line at its Enter, while sendPrompt's confirm still waits (`typed` not recorded yet).
    onEnter.fn = () => {
      onEnter.fn = null
      reportedWhileDelivering = s.delivering.has(pty) && !e.typed
      prompted(e, line)
    }
    await sessions.sendPrompt(project, id, line, undefined, { confirm: true })
    expect(reportedWhileDelivering, 'reported while Combwork still delivered it').toBe(true)
    expect(writes.join('')).toContain('New in your inbox')
    expect(replies, "Combwork's line is told as nobody's reply").toEqual([])
    // The user then types a prompt of their own and sends it, their Enter later than Combwork's: told.
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(e.hiveEnterAt as number))
    sessions.noteUserInput(pty, 'Red\r')
    prompted(e, 'Red')
    expect(replies).toEqual(['Red'])
  })

  it("a launch's task on its command line, taken just after the user answered its start screen: no reply; the user's next prompt is one", () => {
    const replies: string[] = []
    vi.spyOn(sessions, 'userReplied').mockImplementation((_p, _a, _n, text) => void replies.push(text))
    // Launched with its first task on its command line (#712): nothing typed, so no `typed` and no Enter of Combwork's.
    const e = running()
    e.launchTask = true
    // The user answers its trust screen with Enter (the reported case: a new sign-in's home), then its CLI takes the task.
    sessions.noteUserInput(pty, '\r')
    prompted(e, '[CW] New in your inbox: 1 task (m672)')
    expect(replies, "the launch task is told as nobody's reply").toEqual([])
    // The user then sends a prompt of their own: told.
    sessions.noteUserInput(pty, 'Blue\r')
    prompted(e, 'Blue')
    expect(replies).toEqual(['Blue'])
  })
})

describe("a turn Claude Code starts by itself isn't the user's reply (HI-2410)", () => {
  // Claude Code 2.1.317's prompt hooks: the user's prompt, then the turn it started when that prompt's background
  // command ended. The same fields; only the text differs.
  const recorded = (JSON.parse(readFileSync(join(__dirname, 'fixtures/advanced/prompt-task-notification-claude-2.1.317.json'), 'utf8')) as { hooks: Record<string, unknown>[] }).hooks
  /** Its CLI sends a recorded hook, read by the adapter as it would be. */
  const sent = (e: Entry, body: Record<string, unknown>): void => {
    const ev = claudeCode.normalizeHook(body).event
    s.carryOut(key, e, hookStep(ev, s.statusInput(e) as never), 'Hook', ev)
  }

  afterEach(() => {
    s.live.delete(key)
    s.userInput.delete(pty)
    s.userEnter.delete(pty)
    echo.to = null
    vi.restoreAllMocks()
  })

  it('reads the recorded hooks: the task\'s wake is the CLI\'s own prompt, the user\'s is not', () => {
    expect(recorded.map((b) => b.hook_event_name)).toEqual(['UserPromptSubmit', 'UserPromptSubmit'])
    expect(Object.keys(recorded[0]).sort()).toEqual(Object.keys(recorded[1]).sort())
    expect(claudeCode.normalizeHook(recorded[0]).event).toEqual({ kind: 'prompt', text: 'run a background task' })
    expect(claudeCode.normalizeHook(recorded[1]).event).toMatchObject({ kind: 'prompt', cli: true })
  })

  it("the user's Enter (a permission dialog answered), then a background task's end: no reply; the user's own prompt after it is one", () => {
    const replies: string[] = []
    vi.spyOn(sessions, 'userReplied').mockImplementation((_p, _a, _n, text) => void replies.push(text))
    const e = running()
    sent(e, recorded[0])
    // The user answers a permission dialog in the pane with Enter: no prompt of theirs. Within 15 s the task ends.
    sessions.noteUserInput(pty, '\r')
    sent(e, recorded[1])
    expect(replies, "the task's wake is told as nobody's reply").toEqual([])
    expect(e.prompts, 'it is still a turn').toBe(2)
    // The user then sends a prompt of their own: told.
    sessions.noteUserInput(pty, 'Green\r')
    sent(e, { ...recorded[0], prompt: 'Green' })
    expect(replies).toEqual(['Green'])
  })
})
