// An agent's Hooks dialog and live lock blocks (HI-982): what its launch has, each row saying how sure Combwork is; what
// Combwork observed of the hooks it received (its reply apart from the turn ledger's verdict), bounded; and a lock block in
// Activity only while its decision stands, by its launch, tool call, file and holder.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { HOOK_FIRED_MAX, HOOK_ROWS_MAX, HOOK_TEXT_MAX, clip, groupFired, withoutCombworkAuth, type HookFired } from '../src/shared/hooks'
import { claudeScopeHooks, codexListedHooks, rowsOfHooksTable } from '../src/main/hookListing'

const base = tempDir('hive-hooksview-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { codex, hookQueryArgs } = await import('../src/main/providers/codex/adapter')

const fired = (over: Partial<HookFired>): HookFired => ({ at: 0, event: 'Stop', receiver: 'command', response: 'none', ledger: 'applied', ms: 1, ...over })

describe('the shared helpers', () => {
  it('groups consecutive hooks alike, so a run of ignored ones reads as one row', () => {
    const ignored = fired({ ledger: 'ignored', ledgerWhy: 'an earlier turn' })
    const g = groupFired([ignored, ignored, ignored, fired({}), ignored])
    expect(g.map((x) => x.count)).toEqual([3, 1, 1])
  })

  it('cuts text short, saying so, and leaves Combwork\'s authentication out', () => {
    expect(clip('abcdef', 4)).toEqual({ text: 'abc…', truncated: true })
    expect(clip('abc', 4)).toEqual({ text: 'abc', truncated: false })
    const shown = withoutCombworkAuth('curl -H @C:\\data\\auth-1.txt "http://127.0.0.1:5/hook?run=abc123&statusline" -H "Authorization: Bearer s3cret"', ['C:\\data\\auth-1.txt'])
    expect(shown).not.toMatch(/auth-1|abc123|s3cret/)
    expect(withoutCombworkAuth('Bearer $CW_HOOK_TOKEN')).toBe('Bearer $CW_HOOK_TOKEN')
  })
})

describe('what a launch has', () => {
  it("reads a hooks table's every form, marking one Combwork doesn't know as unsupported rather than leaving it out", () => {
    const { rows } = rowsOfHooksTable({ Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }, { type: 'http', url: 'http://x' }, { type: 'mcp_tool', server: 's' }] }], PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'prompt', prompt: 'check' }] }] }, { source: 'user', file: 'u.json', status: 'unverified' })
    expect(rows.map((r) => [r.event, r.type, r.command, r.status, r.observed])).toEqual([
      ['Stop', 'command', 'echo hi', 'unverified', false],
      ['Stop', 'http', 'http://x', 'unverified', false],
      ['Stop', 'mcp_tool', '', 'unsupported', false],
      ['PreToolUse', 'prompt', 'check', 'unverified', false]
    ])
    expect(rows[3].matcher).toBe('Edit')
  })

  it('is bounded: so many hooks, and a command so long, are cut and counted', () => {
    const many = { Stop: Array.from({ length: HOOK_ROWS_MAX + 7 }, () => ({ hooks: [{ type: 'command', command: 'x'.repeat(HOOK_TEXT_MAX * 3) }] })) }
    const got = rowsOfHooksTable(many, { source: 'project', status: 'unverified' })
    expect(got.rows).toHaveLength(HOOK_ROWS_MAX)
    expect(got.more).toBe(7)
    expect(got.rows[0].command.length).toBe(HOOK_TEXT_MAX)
    expect(got.rows[0].truncated).toBe(true)
  })

  it("Claude Code's scopes: configured with their loading unverified, turned off where disableAllHooks decides, and a file Combwork couldn't read or that isn't JSON said so", () => {
    const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'echo s' }] }] }
    const on = claudeScopeHooks([
      { kind: 'managed', label: 'managed', file: 'm.json', json: null },
      { kind: 'project', label: 'project', file: 'p.json', json: null, notJson: true },
      { kind: 'local', label: 'local', file: 'l.json', json: null, unsure: "couldn't be read (EACCES)" },
      { kind: 'user', label: 'user', file: 'u.json', json: { hooks } }
    ])
    expect(on.rows.map((r) => [r.source, r.status])).toEqual([['user', 'unverified']])
    expect(on.notes).toEqual([{ kind: 'notJson', file: 'p.json' }, { kind: 'unreadable', file: 'l.json', why: "couldn't be read (EACCES)" }])
    // The project's disableAllHooks decides (it comes before the user's): every non-managed hook is off.
    const off = claudeScopeHooks([
      { kind: 'managed', label: 'managed', file: 'm.json', json: { hooks } },
      { kind: 'project', label: 'project', file: 'p.json', json: { disableAllHooks: true } },
      { kind: 'user', label: 'user', file: 'u.json', json: { disableAllHooks: false, hooks } }
    ])
    expect(off.rows.map((r) => [r.source, r.status])).toEqual([['managed', 'unverified'], ['user', 'disabled']])
    expect(off.rows[1].why).toContain('project')
    // Managed settings allowing only their own hooks: anyone else's aren't loaded.
    const managedOnly = claudeScopeHooks([
      { kind: 'managed', label: 'managed', file: 'm.json', json: { allowManagedHooksOnly: true } },
      { kind: 'user', label: 'user', file: 'u.json', json: { hooks } }
    ])
    expect(managedOnly.rows.map((r) => r.status)).toEqual(['notLoaded'])
  })

  it("Codex's own listing: Combwork's by the exact command Combwork passed (with Codex's trust), anyone else's with theirs and their file", () => {
    const hive = { command: 'curl.exe hive', flagsFile: 'C:\\<session-flags>\\config.toml' }
    const got = codexListedHooks(
      [
        { key: 'C:\\<session-flags>\\config.toml:pre_tool_use:0:0', source: 'sessionFlags', command: 'curl.exe hive', trustStatus: 'trusted' },
        { key: 'C:\\<session-flags>\\config.toml:stop:0:0', source: 'sessionFlags', command: 'curl.exe hive', trustStatus: 'modified' },
        // The user's own -c hook that names Combwork's endpoint isn't Combwork's: only Combwork's exact command is.
        { key: 'C:\\<session-flags>\\config.toml:stop:1:0', source: 'sessionFlags', command: 'curl.exe hive --extra', trustStatus: 'untrusted' },
        { key: 'C:\\home\\config.toml:post_tool_use:0:0', source: 'user', command: 'echo user', trustStatus: 'trusted', matcher: '*' }
      ],
      hive
    )
    expect([...got.combworkTrust]).toEqual([['PreToolUse', 'trusted'], ['Stop', 'modified']])
    expect(got.rows.map((r) => [r.event, r.source, r.status, r.file ?? null, r.observed])).toEqual([
      ['Stop', 'cli', 'untrusted', null, false],
      ['PostToolUse', 'user', 'trusted', 'C:\\home\\config.toml', false]
    ])
  })

  it("asks Codex with the launch's config overrides only, never its other arguments", () => {
    expect(hookQueryArgs(['resume', 'x', '-s', 'read-only', '-c', 'hooks.Stop=[]', '--config', 'projects={}', '-a', 'never', '--config=features.x=true', '-c', 'developer_instructions="d"', '-c', 'mcp_servers.hive={}'])).toEqual(['-c', 'hooks.Stop=[]', '-c', 'projects={}', '-c', 'features.x=true'])
  })
})

// The sessions side: hand-made running Codex agents (no process), as tests/lockgoahead.test.ts makes them.
const wsPath = join(base, 'ws')
const p = join(wsPath, 'locks')
const q = join(wsPath, 'other')
const s = sessions as unknown as { live: Map<string, any>; runs: Map<string, string> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

let n = 0
function agent(project: string, agentId: string) {
  const state = { provider: 'codex', runId: `run-${agentId}-${++n}`, projectPath: project, agentId, agentName: agentId.toUpperCase(), cwd: project, sessionId: `session-${agentId}`, status: 'working', startedAt: '', launchSignature: '', unseen: false }
  const l = { state, adapter: codex, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, hookHistory: [] as HookFired[], hooks: { listing: { basis: 'cli', rows: [], notes: [] }, receivers: { PreToolUse: 'command' } } }
  s.live.set(`${project.toLowerCase()}#${agentId}`, l)
  s.runs.set(state.runId, `${project.toLowerCase()}#${agentId}`)
  return l
}
/** A hook as the hook server handles it: observed, replied to, handled in the launch's order, recorded. */
async function hook(l: any, body: Record<string, unknown>) {
  return run(async () => {
    const full = { session_id: l.state.sessionId, cwd: l.state.cwd, ...body }
    const obs = sessions.observeHook(l.state.runId, full)
    const reply = sessions.hookReply(l.state.runId, full)
    await sessions.handleHook(l.state.runId, full, reply)
    if (obs) sessions.hookHandled(obs, await reply)
    return reply
  })
}
const edit = (l: any, file: string, call: string) => hook(l, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: call, turn_id: 't1', tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n+x\n*** End Patch` } })

describe("what Combwork observed, and the lock blocks standing now", () => {
  beforeAll(async () => {
    for (const d of [join(wsPath, '.combwork'), join(p, '.combwork'), join(q, '.combwork')]) mkdirSync(d, { recursive: true })
    for (const f of ['a.txt', 'b.txt']) writeFileSync(join(p, f), 'hi\n')
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, fileLocks: 'block', agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it("records Combwork's reply apart from the ledger's verdict: an allowed edit, a lock block, a stale hook ignored with why", async () => {
    const holder = agent(p, 'hb3')
    const editor = agent(p, 'hb6')
    await hook(holder, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await hook(editor, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await edit(holder, 'a.txt', 'c1')
    await edit(editor, 'a.txt', 'c2')
    const lastOf = (l: any): HookFired => l.hookHistory.at(-1)
    expect(holder.hookHistory.find((f: HookFired) => f.event === 'PreToolUse')).toMatchObject({ response: 'allowed', receiver: 'command' })
    expect(['blocked', 'asked']).toContain(lastOf(editor).response)
    expect(lastOf(editor).why).toContain('HB3 is editing a.txt')
    // Its turn ends, then a late tool end of that turn comes: ignored, with the ledger's why.
    await hook(editor, { hook_event_name: 'Stop', turn_id: 't1' })
    await hook(editor, { hook_event_name: 'PostToolUse', turn_id: 't1', tool_use_id: 'c9', tool_name: 'shell' })
    expect(lastOf(editor)).toMatchObject({ event: 'PostToolUse', ledger: 'ignored' })
    expect(lastOf(editor).ledgerWhy).toBeTruthy()
    expect(lastOf(editor).ms).toBeGreaterThanOrEqual(0)
  })

  it('keeps the newest HOOK_FIRED_MAX only', async () => {
    const l = agent(p, 'busy')
    for (let i = 0; i <= HOOK_FIRED_MAX + 4; i++) await hook(l, { hook_event_name: 'PostToolUse', turn_id: 't1', tool_use_id: `x${i}`, tool_name: 'shell' })
    expect(l.hookHistory).toHaveLength(HOOK_FIRED_MAX)
  })

  it('records an error at its step, and a hook of no launch of Combwork\'s nowhere', async () => {
    const l = agent(p, 'err')
    const obs = await run(() => sessions.observeHook(l.state.runId, {}))
    sessions.hookHandled(obs!, null, { step: 'read', error: new SyntaxError('Unexpected token') })
    expect(l.hookHistory.at(-1)).toMatchObject({ event: '?', response: 'error', ledger: 'none' })
    expect(l.hookHistory.at(-1)?.why).toBe('read: Unexpected token')
    expect(await run(() => sessions.observeHook('no-such-run', { session_id: 'none' }))).toBeNull()
  })

  it("shows a block while its decision stands, and drops it at the blocked call's end, another tool call, the turn's end or the lock's release", async () => {
    const holder = agent(p, 'h2')
    const editor = agent(p, 'e2')
    for (const l of [holder, editor]) await hook(l, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await edit(holder, 'b.txt', 'k1')
    const blocks = () => sessions.hookBlocks(p).filter((b) => b.agentId === 'e2')
    await edit(editor, 'b.txt', 'k2')
    expect(blocks()).toEqual([expect.objectContaining({ file: 'b.txt', holder: 'H2' })])
    // Another tool call of its own: it went on with something else.
    await hook(editor, { hook_event_name: 'PreToolUse', tool_name: 'shell', tool_use_id: 'k3', turn_id: 't1', tool_input: { command: 'ls' } })
    expect(blocks()).toEqual([])
    // Blocked again; the call's end drops it.
    await edit(editor, 'b.txt', 'k4')
    expect(blocks()).toHaveLength(1)
    await hook(editor, { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'k4', turn_id: 't1' })
    expect(blocks()).toEqual([])
    // Blocked again; the holder's turn ends, releasing its lock: gone, though nothing of the editor's came.
    await edit(editor, 'b.txt', 'k5')
    expect(blocks()).toHaveLength(1)
    await hook(holder, { hook_event_name: 'Stop', turn_id: 't1' })
    expect(blocks()).toEqual([])
  })

  it("is scoped: another project's Activity has none of it, and a restarted launch doesn't inherit it", async () => {
    const holder = agent(p, 'h3')
    const editor = agent(p, 'e3')
    for (const l of [holder, editor]) await hook(l, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    writeFileSync(join(p, 'c.txt'), 'hi\n')
    await edit(holder, 'c.txt', 'm1')
    await edit(editor, 'c.txt', 'm2')
    expect(sessions.hookBlocks(p).filter((b) => b.agentId === 'e3')).toHaveLength(1)
    // An agent of the same id in another project shows nothing of it.
    agent(q, 'e3')
    expect(sessions.hookBlocks(q)).toEqual([])
    // The editor restarted (a new run id): its old block isn't the new launch's.
    editor.state.runId = `${editor.state.runId}-again`
    expect(sessions.hookBlocks(p).filter((b) => b.agentId === 'e3')).toEqual([])
  })
})
