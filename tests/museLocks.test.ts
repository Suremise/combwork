// Muse Code's file locks with its names renamed (HI-3202 round 2): a launch gives Muse its hook events and fields by the
// names its advanced mappings say, and its hooks come back by them. Every hook is routed in Combwork's vocabulary
// (sessions.canonicalHook, the adapter's canonicalHook) before anything reads it, so a renamed PreToolUse, under a renamed
// event field, still reaches the file locks through sessions.hookReply: the holder's edit claims the file and another
// agent's is blocked, by the reply's names as that launch gave them. A body under the names it didn't give claims nothing.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-muselocks-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { MuseAdapter } = await import('../src/main/providers/muse/adapter')
const { DEFAULT_NAMES } = await import('../src/main/providers/muse/names')
const { fallbackLine } = await import('../src/main/providers/muse/names')
const { logLine } = await import('../src/main/logger')
const { redactLog } = await import('../src/shared/redact')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'locks')
const s = sessions as unknown as { live: Map<string, unknown>; runs: Map<string, string> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

/** A launch's names: its PreToolUse and SessionStart renamed, its event field, its turn and the block reply's names too. */
const NAMES = {
  events: { ...DEFAULT_NAMES.events, preTool: 'BeforeTool', start: 'Begin' },
  fields: { ...DEFAULT_NAMES.fields, event: 'event_name', session: 'sid', turn: 'turn_ref', decision: 'verdict', block: 'deny' },
  config: DEFAULT_NAMES.config
}

let n = 0
/** A running Muse agent (no process) on the launch copy that gave Muse these names. */
function agent(names = NAMES) {
  const agentId = `m${++n}`
  const state = { provider: 'muse', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `01a1d9f2-e1a5-7300-bebb-9ee68a04${String(n).padStart(4, '0')}`, status: 'working', startedAt: '', launchSignature: '', unseen: false, turn: { state: 'running' }, runtime: { lifecycle: 'running', maintenance: null, attention: null, composer: 'free' } }
  s.live.set(`${p.toLowerCase()}#${agentId}`, { state, adapter: new MuseAdapter(names), transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
  s.runs.set(state.runId, `${p.toLowerCase()}#${agentId}`)
  return state
}
/** An edit of `file` as this Muse sends it: its event under its event field, write_file's path. */
const edit = (st: ReturnType<typeof agent>, file: string, event = 'BeforeTool', field = 'event_name') => ({ [field]: event, sid: st.sessionId, session_id: st.sessionId, cwd: p, tool_name: 'write_file', tool_input: { path: file, content: 'x' }, tool_use_id: `c${n}` })
const reply = (st: ReturnType<typeof agent>, body: Record<string, unknown>) => run(() => sessions.hookReply(st.runId, body))

describe("Muse's file locks, its names renamed", () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, fileLocks: 'block', agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it('reach the locks through hookReply: the holder claims, another is blocked by the launch\'s reply names', async () => {
    writeFileSync(join(p, 'held.txt'), 'hi\n')
    const holder = agent()
    const editor = agent()
    expect(await reply(holder, edit(holder, 'held.txt'))).toBeNull()
    const blocked = await reply(editor, edit(editor, 'held.txt'))
    expect(blocked).toMatchObject({ verdict: 'deny', reason: expect.stringContaining('held.txt') })
    expect(blocked).not.toHaveProperty('decision')
  })

  it("claims nothing for a body under names this launch didn't give (1.4.20's event name, or its event field)", async () => {
    writeFileSync(join(p, 'free.txt'), 'hi\n')
    const first = agent()
    const second = agent()
    // 1.4.20's PreToolUse, which this launch renamed: not an edit here, so no claim.
    expect(await reply(first, edit(first, 'free.txt', 'PreToolUse'))).toBeNull()
    // The renamed event under 1.4.20's field, which this launch renamed too: nothing.
    expect(await reply(first, edit(first, 'free.txt', 'BeforeTool', 'hook_event_name'))).toBeNull()
    // So the file is free: another agent's edit, as its launch sends it, claims it.
    expect(await reply(second, edit(second, 'free.txt'))).toBeNull()
  })

  it("1.4.20's own names still lock as before", async () => {
    writeFileSync(join(p, 'plain.txt'), 'hi\n')
    const holder = agent(DEFAULT_NAMES)
    const editor = agent(DEFAULT_NAMES)
    const plain = (st: ReturnType<typeof agent>) => ({ hook_event_name: 'PreToolUse', session_id: st.sessionId, cwd: p, tool_name: 'write_file', tool_input: { path: 'plain.txt', content: 'x' } })
    expect(await reply(holder, plain(holder))).toBeNull()
    expect(await reply(editor, plain(editor))).toMatchObject({ decision: 'block', reason: expect.stringContaining('plain.txt') })
  })

  it("is handled by the same names: a renamed start gives the session's id, under a renamed session field", async () => {
    const st = agent()
    st.sessionId = null as unknown as string
    const id = '01a1d9f2-e1a5-7300-bebb-9ee68a04ffff'
    await run(() => sessions.handleHook(st.runId, { event_name: 'Begin', sid: id, source: 'startup', cwd: p }))
    expect(st.sessionId).toBe(id)
  })

  it("leaves a rejected mapping's value out of Copy Diagnostics", () => {
    const line = logLine('warn', 'muse', fallbackLine('muse.names.hookEvents', ['start=C:\\Users\\jo\\secret-PASTED-TOKEN-7731']))
    expect(line).toContain('muse.names.hookEvents')
    const out = redactLog(line, { home: 'C:\\Users\\jo', folders: [], names: [] })
    expect(out).not.toContain('PASTED-TOKEN-7731')
    expect(out).toContain('muse.names.hookEvents')
  })
})
