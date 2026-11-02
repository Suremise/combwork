// "Ask me" file locks for a CLI without its own approval (Codex): the user's Allow reaches the agent whenever it is
// clicked. Clicked while the blocked agent is still in its turn (the toast shows as the hook denies the edit), the
// go-ahead is typed when that turn ends and the edit is allowed in the next one (#201). Like every prompt Hive types on
// its own, it waits while the user may be writing in the agent's terminal, and never adds to or sends their input. An
// edit that went ahead meanwhile needs none, and an interrupt drops it.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

// What Hive types into agents' terminals, recorded instead (no process runs), with when each piece went in (Date.now(),
// the clock Hive's pause after typing is measured by); onWrite acts as each piece goes in.
const pty = vi.hoisted(() => ({ typed: [] as { key: string; data: string; at: number }[], onWrite: (_data: string): void => undefined }))
vi.mock('../src/main/ptyHost', async (original) => ({
  ...(await original<object>()),
  writePty: (key: string, data: string) => {
    pty.typed.push({ key, data, at: Date.now() })
    pty.onWrite(data)
  }
}))

const base = tempDir('hive-goahead-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
// The delivery service gives the go-ahead (#649): it sets itself into sessions as it loads.
const deliveries = await import('../src/main/deliveries')
const { config } = await import('../src/main/config')
const { codex } = await import('../src/main/providers/codex/adapter')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'locks')
const s = sessions as unknown as { live: Map<string, unknown>; runs: Map<string, string>; key: (p: string, a: string) => string }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Long enough for a prompt to be typed and sent (Enter goes in some 450 ms after the first piece). */
const typingTime = () => wait(1500)
/** Settings → Assistant → Pause after you type, for these tests (seconds). */
const PAUSE = 2

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

let n = 0
/**
 * Running Codex agents (no process), each set with files of its own: `holder` has claimed one, `other` a second, and
 * `editor` is in a turn.
 */
function agents() {
  n++
  const file = `notes${n}.txt`
  const second = `other${n}.txt`
  for (const f of [file, second]) writeFileSync(join(p, f), 'hi\n')
  const agent = (agentId: string) => {
    const state = withFacts({ provider: 'codex', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `session-${agentId}`, status: 'working', startedAt: '', launchSignature: '', unseen: false })
    s.live.set(`${p.toLowerCase()}#${agentId}`, { state, adapter: codex, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
    s.runs.set(state.runId, `${p.toLowerCase()}#${agentId}`)
    return state
  }
  const holder = agent(`h${n}`)
  const other = agent(`o${n}`)
  const editor = agent(`e${n}`)
  const patch = (...files: string[]) => ({ hook_event_name: 'PreToolUse', cwd: p, tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n+x\n`).join('')}*** End Patch` } })
  const editBy = (st: typeof holder, ...files: string[]) => run(() => sessions.preToolUse(st.runId, { ...patch(...files), session_id: st.sessionId }))
  const hookOf = (st: typeof holder, event: string) => run(() => sessions.handleHook(st.runId, { hook_event_name: event, session_id: st.sessionId, cwd: p }))
  const typed = () => pty.typed.filter((t) => t.key === s.key(p, editor.agentId)).map((t) => t.data)
  /**
   * The go-ahead for the file given: its doorbell typed (in pieces, as Hive types) and sent (#650: it names the notice by
   * id; the agent reads what it says with hive_inbox).
   */
  const goAhead = async () => typed().join('').includes('New in your inbox: 1 notice') && typed().at(-1) === '\r' && (await deliveries.deliveriesOf(p, editor.agentId)).some((r) => r.state === 'offered' && r.body.includes(`allowed you to edit ${file}`))
  /** Its go-ahead once the claim it waited on ended unanswered (HI-2386): try again, nothing allowed. */
  const freed = async () => typed().at(-1) === '\r' && (await deliveries.deliveriesOf(p, editor.agentId)).some((r) => r.state === 'offered' && r.body.includes(`has finished with ${file}`) && !r.body.includes('allowed you'))
  const asked = () => (sessions as unknown as { lockAsked: Map<string, number> }).lockAsked
  const editorKey = `${p.toLowerCase()}#${editor.agentId}|`
  return {
    file,
    second,
    editor,
    /** holder claims the file (and other the second one). */
    claim: async () => {
      expect(await editBy(holder, file)).toBeNull()
      expect(await editBy(other, second)).toBeNull()
    },
    /** editor tries an edit (of its file by default): null when it may, the hook's refusal when not. */
    edit: (...files: string[]) => editBy(editor, ...(files.length ? files : [file])),
    hook: (event: string) => hookOf(editor, event),
    holderHook: (event: string) => hookOf(holder, event),
    allow: (offer?: string) => run(() => sessions.allowLockedEdit(p, editor.agentId, join(p, file), offer)),
    /** The offer of editor's open ask (its notice's Allow), or null. */
    offer: () => {
      const k = [...asked().keys()].find((x) => x.startsWith(editorKey))
      return k ? `lock:${k}#${asked().get(k)}` : null
    },
    /** other edits the file (claiming it once the holder has let it go). */
    otherEdits: () => editBy(other, file),
    /** The user typing in editor's terminal. */
    userTypes: (text: string) => sessions.noteUserInput(s.key(p, editor.agentId), text),
    /**
     * Once the user's pause has passed (Hive's own check of it), what the delivery service's retry then does, awaited: a
     * check reads its outcome, not how soon the retry's timer ran (#1029: late on a loaded machine).
     */
    afterPause: async () => {
      await vi.waitFor(() => expect(sessions.userMayBeTyping(p, editor.agentId)).toBe(false), { timeout: (PAUSE + 3) * 1000 })
      // A retry already running (started within the pause, and put off) is joined, not repeated: then one of its own.
      for (let i = 0; i < 3 && !(await goAhead()); i++) await deliveries.offerNow(p, editor.agentId)
    },
    typed,
    goAhead,
    freed
  }
}

describe('Allow on an "Ask me" lock', () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, fileLocks: 'ask', agents: [] }))
    config.settings.assistant.typingPause = PAUSE
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })
  beforeEach(() => {
    pty.typed.length = 0
    pty.onWrite = () => undefined
  })

  it('clicked once the blocked turn has ended: the go-ahead is typed at once', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    a.editor.status = 'finished'
    await a.allow()
    await vi.waitFor(async () => expect(await a.goAhead()).toBe(true), { timeout: HUNG_MS })
  })

  it('clicked after the blocked turn ended by its Stop (HI-2386): the ask outlived it, the go-ahead is typed, and the next turn may edit', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    // The agent stops to wait for the answer, as Codex does within seconds: its turn's end keeps the ask open.
    await a.hook('Stop')
    expect(a.editor.status).toBe('finished')
    await a.allow()
    await vi.waitFor(async () => expect(await a.goAhead()).toBe(true), { timeout: HUNG_MS })
    a.editor.status = 'working'
    expect(await a.edit()).toBeNull()
  })

  it('an ask answered after its turn ended is closed: a later block asks again (a new notice) rather than waiting on it', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.hook('Stop')
    await a.allow()
    await vi.waitFor(async () => expect(await a.goAhead()).toBe(true), { timeout: HUNG_MS })
    const asked = (sessions as unknown as { lockAsked: Map<string, number> }).lockAsked
    const mine = () => [...asked.keys()].filter((k) => k.startsWith(`${p.toLowerCase()}#${a.editor.agentId}|`))
    expect(mine()).toEqual([])
    // The allowed edit goes ahead; the turn the go-ahead started ends, and the holder claims the file again: the next try
    // asks again.
    a.editor.status = 'working'
    expect(await a.edit()).toBeNull()
    await a.hook('Stop')
    await a.claim()
    a.editor.status = 'working'
    expect(await a.edit()).not.toBeNull()
    expect(mine().length).toBe(1)
  })

  it('an ask its turn left open, then the edit went ahead on its own (the holder finished): the ask is closed', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.hook('Stop')
    await a.holderHook('Stop')
    a.editor.status = 'working'
    expect(await a.edit()).toBeNull()
    const asked = (sessions as unknown as { lockAsked: Map<string, number> }).lockAsked
    expect([...asked.keys()].some((k) => k.startsWith(`${p.toLowerCase()}#${a.editor.agentId}|`))).toBe(false)
  })

  it("the holder lets the file go before the user answers (HR1's round 1): the ask goes, the agent is told to try again, and the old notice's Allow lets nothing through a new holder's claim", async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.hook('Stop')
    const old = a.offer()
    expect(old).not.toBeNull()
    // The holder finishes: its claim ends, and with it the question about it. The waiting agent is told it may try again.
    await a.holderHook('Stop')
    expect(a.offer()).toBeNull()
    await vi.waitFor(async () => expect(await a.freed()).toBe(true), { timeout: HUNG_MS })
    // A third agent claims the file before the retry. The old notice's Allow, pressed now, answers nothing.
    expect(await a.otherEdits()).toBeNull()
    await a.allow(old!)
    await a.allow()
    a.editor.status = 'working'
    // The retry is refused for the new holder's claim, and asks the user about that one: a new question, its own notice.
    const refused = JSON.stringify(await a.edit())
    expect(refused).toContain('Hive has asked the user')
    expect(a.offer()).not.toBeNull()
    expect(a.offer()).not.toBe(old)
  })

  it('allowed while the blocked agent is in its turn, then the holder lets the file go and another claims it: the go-ahead only says try again, and the retry asks about the new holder', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    await a.holderHook('Stop')
    expect(await a.otherEdits()).toBeNull()
    await a.hook('Stop')
    await vi.waitFor(async () => expect(await a.freed()).toBe(true), { timeout: HUNG_MS })
    a.editor.status = 'working'
    expect(JSON.stringify(await a.edit())).toContain('Hive has asked the user')
  })

  it('clicked while the blocked agent is still in its turn: nothing is typed then; at its end, the go-ahead, and the edit is allowed', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    expect(a.typed()).toEqual([])
    await a.hook('Stop')
    expect(a.editor.status).toBe('finished')
    await vi.waitFor(async () => expect(await a.goAhead()).toBe(true), { timeout: HUNG_MS })
    // The next turn's retry goes through: the turn's end released the allowance the click gave, and it was given again.
    a.editor.status = 'working'
    expect(await a.edit()).toBeNull()
    // Typed once only: the next turn's end has nothing more to say.
    pty.typed.length = 0
    await a.hook('Stop')
    await typingTime()
    expect(a.typed()).toEqual([])
  })

  it('allowed and tried again in the same turn: no go-ahead when the turn ends', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    expect(await a.edit()).toBeNull()
    await a.hook('Stop')
    await typingTime()
    expect(a.typed()).toEqual([])
  })

  it('the holder finished before the retry, which then went ahead: no go-ahead when the turn ends', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    await a.holderHook('Stop')
    expect(await a.edit()).toBeNull()
    await a.hook('Stop')
    await typingTime()
    expect(a.typed()).toEqual([])
  })

  it('an edit refused for another of its files: the allowed file still gets its go-ahead, and only it', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    // The retry also edits the second file, which other holds and nobody allowed: the whole edit is refused.
    expect(await a.edit(a.file, a.second)).not.toBeNull()
    await a.hook('Stop')
    await vi.waitFor(async () => expect(await a.goAhead()).toBe(true), { timeout: HUNG_MS })
    expect(a.typed().join('')).not.toContain(a.second)
  })

  it('the agent starts another turn before the go-ahead is typed: it is not sent, and the edit is still allowed in that turn', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    // A wake (or the user's prompt, sent with Enter) went first: the agent is working as Hive clears the input.
    pty.onWrite = (d) => {
      if (d === '\x15') a.editor.status = 'working'
    }
    await a.hook('Stop')
    await typingTime()
    expect(a.typed().includes('\r')).toBe(false)
    expect(await a.edit()).toBeNull()
  })

  it('the user types in the terminal while the go-ahead is typed: it is not sent, their input is left alone, and it goes once they pause', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    let typedBy: { n: number; at: number } | null = null
    pty.onWrite = () => {
      if (typedBy === null && pty.typed.map((t) => t.data).join('').includes('New in your inbox')) {
        typedBy = { n: pty.typed.length, at: Date.now() }
        a.userTypes('My next task')
      }
    }
    await a.hook('Stop')
    // The turn's end types it, and the user types as it goes in (the first typing is waited for as this file's other
    // tests wait for it).
    await vi.waitFor(() => expect(typedBy).not.toBeNull(), { timeout: HUNG_MS })
    pty.onWrite = () => undefined
    await a.afterPause()
    expect(await a.goAhead()).toBe(true)
    // Within their pause, nothing sent and nothing cleared after their keystroke: what they typed stayed where they typed
    // it. It went once they paused.
    const within = pty.typed.slice(typedBy!.n).filter((t) => t.key === s.key(p, a.editor.agentId) && t.at - typedBy!.at < PAUSE * 1000)
    expect(within.filter((t) => t.data === '\r' || t.data === '\x15')).toEqual([])
  })

  it('a draft in the terminal when the turn ends: nothing is typed until the user pauses', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    const draftAt = Date.now()
    a.userTypes('half a thought')
    await a.hook('Stop')
    await a.afterPause()
    expect(await a.goAhead()).toBe(true)
    // Its first key went in once their pause had passed, not before.
    const first = pty.typed.find((t) => t.key === s.key(p, a.editor.agentId))!
    expect(first.at - draftAt).toBeGreaterThanOrEqual(PAUSE * 1000)
  })

  it('interrupted while the go-ahead is being typed: it stops before Enter, and is not tried again', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    await a.hook('Stop')
    // Delivery has begun (the input cleared): the user interrupts, and the agent is ready again.
    await vi.waitFor(() => expect(a.typed()).toContain('\x15'), { timeout: HUNG_MS })
    await a.hook('Interrupt')
    expect(a.editor.status).toBe('ready')
    await typingTime()
    expect(a.typed().includes('\r')).toBe(false)
    // Not later either: once the typing pause would have ended, nothing more has been typed.
    const so = a.typed().length
    await wait(PAUSE * 1000 + 500)
    expect(a.typed().length).toBe(so)
  })

  it('interrupted after the click (the user stopped it): no go-ahead, then or after a later turn', async () => {
    const a = agents()
    await a.claim()
    expect(await a.edit()).not.toBeNull()
    await a.allow()
    await a.hook('Interrupt')
    a.editor.status = 'working'
    await a.hook('Stop')
    await typingTime()
    expect(a.typed()).toEqual([])
  })
})
