// Hooks health, part 2 (#1371), through SessionManager.readTurns: what a read of the transcript's turns finds is kept
// only for the file it read. A hook naming another file while the read waits (or before it starts, during the look's
// details read) leaves the old file's turns out. A reading that starts again lets go of what it showed, and the alarm
// that evidence raised goes with it; an alarm from the agent's start or a prompt isn't the transcript's and stays.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-hooks-health-sessions-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { hooksMissing, newHooksWatch } = await import('../src/main/hooksHealth')
type HooksWatch = ReturnType<typeof newHooksWatch>

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type State = { runId: string; agentId: string; sessionId: string; hooksMissing?: { since: string; after: string } }
type Live = { state: State; hooksWatch: HooksWatch; transcriptPath: string }
const s = sessions as unknown as {
  live: Map<string, Live>
  readTurns: (l: unknown, path: string, size: number) => Promise<void>
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

const BOUND = 60_000
const STARTED = '2026-10-21T18:00:00.000Z'
/** A turn as Claude Code writes it: a person's prompt by its promptId, and the model's entry chained to it. */
const claudeTurn = (promptId: string, at = '2026-10-21T18:01:00.000Z'): string =>
  JSON.stringify({ type: 'user', uuid: `u-${promptId}`, parentUuid: null, promptId, origin: { kind: 'human' }, timestamp: at, message: { role: 'user', content: 'do it' } }) +
  '\n' +
  JSON.stringify({ type: 'assistant', uuid: `a-${promptId}`, parentUuid: `u-${promptId}`, timestamp: at, message: { role: 'assistant', content: [] } }) +
  '\n'

/** A Claude Code agent of this launch, its transcript a file of its own with `text`, read from its start. */
function agent(agentId: string, text: string): { l: Live; file: string } {
  const file = join(base, `${agentId}.jsonl`)
  writeFileSync(file, text)
  const st = { provider: 'claude-code', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'ready', startedAt: STARTED, launchSignature: '', unseen: false }
  const l = { state: st, adapter: claudeCode, transcriptMtime: '', transcriptPath: file, defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, hooksWatch: newHooksWatch(Date.parse(STARTED), false, 'id') }
  s.live.set(`${p.toLowerCase()}#${agentId}`, l as never)
  return { l, file }
}
const size = (text: string): number => Buffer.byteLength(text)

describe('reading its transcript’s turns (#1371)', () => {
  beforeAll(async () => {
    mkdirSync(join(p, '.hive'), { recursive: true })
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it('a hook names another file while the read waits: the old file’s turns are left out', async () => {
    const text = claudeTurn('OLD-FILE')
    const { l, file } = agent('a', text)
    // The read is under way (waiting on the file) when the hook moves the agent to its new transcript.
    const reading = run(() => s.readTurns(l, file, size(text)))
    l.transcriptPath = join(base, 'a-new.jsonl')
    await reading
    expect([...l.hooksWatch.unheard.keys()]).toEqual([])
    expect([...l.hooksWatch.order.keys()]).toEqual([])
    expect((l as { turnsRead?: unknown }).turnsRead).toBeUndefined()
  })

  it('another file named before the read starts (while the look read its details): nothing of the old one is read', async () => {
    const text = claudeTurn('OLD-FILE')
    const { l, file } = agent('b', text)
    l.transcriptPath = join(base, 'b-new.jsonl')
    await run(() => s.readTurns(l, file, size(text)))
    expect([...l.hooksWatch.order.keys()]).toEqual([])
  })

  it('still its file: its turn is waited on (the control for the two above)', async () => {
    const text = claudeTurn('KEPT')
    const { l, file } = agent('c', text)
    await run(() => s.readTurns(l, file, size(text)))
    expect([...l.hooksWatch.unheard.keys()]).toEqual(['KEPT'])
  })

  it('a reading that starts again (the file replaced) takes the transcript’s alarm down with its evidence', async () => {
    const text = claudeTurn('E')
    const { l, file } = agent('d', text)
    await run(() => s.readTurns(l, file, size(text)))
    const found = l.hooksWatch.unheard.get('E')!.foundAt
    expect(hooksMissing(l.hooksWatch, { startWaits: false, screen: null }, found + BOUND, BOUND)).toBe('transcript')
    l.state.hooksMissing = { since: new Date().toISOString(), after: 'transcript' }
    // Replaced by a shorter file: the reading starts again from its end.
    const replaced = '{}\n'
    writeFileSync(file, replaced)
    await run(() => s.readTurns(l, file, size(replaced)))
    expect(l.hooksWatch.flagged).toBeNull()
    expect(l.hooksWatch.unheard.size).toBe(0)
    expect(l.state.hooksMissing).toBeUndefined()
  })

  it('a reading that starts again leaves an alarm from a prompt (not the transcript’s) standing', async () => {
    const text = claudeTurn('P')
    const { l, file } = agent('e', text)
    await run(() => s.readTurns(l, file, size(text)))
    l.state.hooksMissing = { since: new Date().toISOString(), after: 'prompt' }
    const replaced = '{}\n'
    writeFileSync(file, replaced)
    await run(() => s.readTurns(l, file, size(replaced)))
    expect(l.state.hooksMissing?.after).toBe('prompt')
  })

  it("a newer turn's hook came before its record: the transcript showing it takes the alarm down", async () => {
    const text = claudeTurn('E')
    const { l, file } = agent('f', text)
    await run(() => s.readTurns(l, file, size(text)))
    const found = l.hooksWatch.unheard.get('E')!.foundAt
    expect(hooksMissing(l.hooksWatch, { startWaits: false, screen: null }, found + BOUND, BOUND)).toBe('transcript')
    l.state.hooksMissing = { since: new Date().toISOString(), after: 'transcript' }
    l.hooksWatch.heard.add('N')
    const more = text + claudeTurn('N', '2026-10-21T18:05:00.000Z')
    writeFileSync(file, more)
    await run(() => s.readTurns(l, file, size(more)))
    expect(l.state.hooksMissing).toBeUndefined()
  })
})
