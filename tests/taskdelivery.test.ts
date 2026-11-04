// Start on a card given to a running, idle agent: the prompt is typed in by sessions.sendPrompt, and the agent may
// start other work, or the user type in its terminal, while it is. Nothing more goes in then, and the card goes back.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeInput } from './claudeInputStandIn'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// What Hive types into agents' terminals, recorded instead (no process runs); onWrite acts as each piece goes in.
const pty = vi.hoisted(() => ({ typed: [] as string[], onWrite: (_data: string): void => undefined }))
vi.mock('../src/main/ptyHost', async (original) => ({
  ...(await original<object>()),
  writePty: (_key: string, data: string) => {
    pty.typed.push(data)
    pty.onWrite(data)
  }
}))

const base = tempDir('hive-delivery-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { startTask } = await import('../src/main/taskStart')
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const wsPath = join(base, 'ws')
const p = join(wsPath, 'deliver')
const s = sessions as unknown as { live: Map<string, unknown>; key: (p: string, a: string) => string }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

/**
 * A hand-made live state whose runtime facts follow its status, as the turn ledger's would (#648): the CLI running, a turn
 * running while it works, asked while it waits. Readiness reads the facts (#649).
 */
function withFacts<T extends { status: string }>(state: T): T {
  let status = state.status
  const rt = { lifecycle: 'running', maintenance: null as null, attention: null as 'waiting' | null, composer: 'free' }
  const follow = (): void => {
    Object.assign(state, { turn: { state: status === 'working' ? 'running' : 'over' } })
    rt.attention = status === 'waiting' ? 'waiting' : null
  }
  Object.defineProperty(state, 'status', {
    get: () => status,
    set: (v: string) => {
      status = v
      follow()
    },
    enumerable: true,
    configurable: true
  })
  Object.assign(state, { runtime: rt })
  follow()
  return state
}


/** A running agent, idle, as SessionManager keeps one (no process). */
function idle(agentId: string): { status: string } {
  const state = withFacts({ provider: 'claude', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: '', status: 'ready', startedAt: '', launchSignature: '', unseen: false })
  // Its input box (claudeInputStandIn, fed what is typed: HI-1979, Hive types into it only once a key of its own shows
  // it empty), bracketed paste off.
  const input = claudeInput({ paste: false })
  input.from(() => pty.typed)
  s.live.set(`${p.toLowerCase()}#${agentId}`, { state, adapter: claudeCode, screen: input.screen, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
  return state
}
// Its doorbell (#650: the task's id, never its text, which the agent reads with cw_inbox).
const prompted = (): boolean => pty.typed.join('').includes('New in your inbox: 1 task')
const submitted = (): boolean => pty.typed.includes('\r')
// A write of Backspaces only: how Hive takes back a line it stopped in Claude Code (HI-1974).
const backspaces = (d: string): boolean => /^\x7f+$/.test(d)

describe('a Start typed into a running agent', () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: ['d1', 'd2', 'd3', 'd4'].map((id, i) => ({ id, name: `Agent ${i + 1}` })) }))
    w = createWorkspaceService()
    await w.open(wsPath)
    // The Assistant that starts cards here is running: a task it gives is refused once its session has ended (#645, #649).
    const home = w.assistantHome
    s.live.set(`${home.toLowerCase()}#assistant`, { state: { provider: 'claude', runId: 'run-assistant', projectPath: home, agentId: 'assistant', cwd: home, sessionId: '', status: 'working', startedAt: '', launchSignature: '', unseen: false }, adapter: claudeCode, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })
  beforeEach(() => {
    pty.typed.length = 0
    pty.onWrite = () => undefined
  })

  /** A Review card of the agent's, and what Start did with it. */
  async function startWith(agentId: string, actor: typeof user | typeof assistant) {
    const c = await run(() => tasks.createTask({ title: `Follow-up for ${agentId}`, project: 'deliver', agent: agentId, column: 'review' }, user))
    const result = await run(() => startTask(c.number, { kind: 'agent', agentId }, actor, 'Address the latest review comment.')).then(
      () => null,
      (e: Error) => e.message
    )
    return { error: result, card: await run(() => tasks.getTask(c.number)) }
  }

  it('the agent starts work while the input is being cleared: nothing is typed, the card goes back to Review', async () => {
    const st = idle('d1')
    pty.onWrite = (d) => {
      // As the clear begins (HI-1979: an empty box's is the letter Hive shows and takes back).
      if (d === '\x15' || d === 'x') st.status = 'working'
    }
    const { error, card } = await startWith('d1', user)
    expect(error).toMatch(/is working/)
    expect([prompted(), submitted()]).toEqual([false, false])
    expect([card.column, card.agent]).toEqual(['review', 'd1'])
    expect(card.history.map((h) => h.what).slice(-2)).toEqual(['Moved to Doing', 'Moved to Review'])
  })

  it('the agent starts work while the prompt is typed: it is not sent, and what Hive typed is cleared again', async () => {
    const st = idle('d2')
    pty.onWrite = () => {
      if (pty.typed.join('').includes('New in your inbox')) st.status = 'working'
    }
    const { error, card } = await startWith('d2', user)
    expect(error).toMatch(/is working/)
    expect(submitted()).toBe(false)
    // Claude Code's Ctrl+U deletes only one wrapped row, so what Hive typed is taken back with a Backspace for each
    // character, eight to a write (HI-1974): never fewer than it typed, and nothing else after them.
    // The empty input shown so first (HI-1979): the letter Hive types and takes back.
    expect(pty.typed.slice(0, 2)).toEqual(['x', '\x7f'])
    const back = pty.typed.findIndex((d, i) => i >= 2 && backspaces(d))
    const typedText = pty.typed.slice(2, back).join('')
    expect(typedText).toContain('New in your inbox')
    expect(pty.typed.slice(back).every((d) => backspaces(d) && d.length <= 8)).toBe(true)
    expect(pty.typed.slice(back).join('').length).toBeGreaterThanOrEqual([...typedText].length)
    expect(pty.typed.includes('\x15')).toBe(false)
    expect([card.column, card.agent]).toEqual(['review', 'd2'])
  })

  it("the user types in the agent's terminal before the Assistant's prompt is sent: it isn't, and their input stays", async () => {
    idle('d3')
    // 50 ms after the last piece of the prompt went in (pieces go every 10 ms): in the wait before Enter.
    let timer: ReturnType<typeof setTimeout> | undefined
    pty.onWrite = () => {
      if (!pty.typed.slice(2).length) return
      clearTimeout(timer)
      timer = setTimeout(() => sessions.noteUserInput(s.key(p, 'd3'), 'x'), 50)
    }
    const { error, card } = await startWith('d3', assistant)
    expect(error).toMatch(/just typed/)
    expect(prompted()).toBe(true)
    expect(submitted()).toBe(false)
    // Nothing cleared after the prompt began: the user's text stays where they typed it.
    expect(pty.typed.slice(0, 2)).toEqual(['x', '\x7f'])
    expect(pty.typed.slice(2).some((d) => d.includes('\x15') || d.includes('\x7f'))).toBe(false)
    expect([card.column, card.agent]).toEqual(['review', 'd3'])
  })

  it('nothing changes meanwhile: the prompt is sent and the card stays in Doing', async () => {
    idle('d4')
    const { error, card } = await startWith('d4', assistant)
    expect(error).toBeNull()
    expect([prompted(), submitted()]).toEqual([true, true])
    expect([card.column, card.agent]).toEqual(['doing', 'd4'])
  })
})
