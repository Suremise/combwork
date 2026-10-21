// A start or resume never waits for the usage history's one-time import (#1177): with an import that never finishes
// (its first session's job held in the worker for good, so the worker's queue never moves on), a resume and a new
// session both get past every check to their launch. Its own file: the held job keeps the queue stuck for the rest of it.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-start-import-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (f: string) => Promise<void> }).trashItem = async (f) => rmSync(f, { force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { usageHistory } = await import('../src/main/usageHistory')
const { providerService } = await import('../src/main/providerService')
const { config } = await import('../src/main/config')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'proj')
let w: ReturnType<typeof createWorkspaceService>
const at = new Date().toISOString()
const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-9000-${String(i + 1).padStart(12, '0')}`)
// The longest a wait here waits: a bound for a hung run, never how long it should take.
const HUNG_MS = 20_000
const STEP = '6f1d3b52-1c1e-4a39-9d5e-2f7a1b0c4d11'

type Call = (body: { type: string }) => Promise<unknown>
const history = usageHistory as unknown as { call: Call }
const realCall = history.call
/** The import's jobs reached the worker: the first is held there for good. */
let held = 0

describe('a start during the usage history import', () => {
  const info = providerService.info
  let enabled = false

  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive', 'sessions'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1', provider: 'claude-code' }] }))
    for (const id of ids) writeFileSync(join(p, '.hive', 'sessions', `${id}.jsonl`), JSON.stringify({ type: 'user', sessionId: id, timestamp: at, message: { role: 'user', content: 'Task' } }) + '\n')
    vi.spyOn(sessions, 'providerTranscript').mockImplementation(async () => null)
    // An ingest never answers: the import's first session never finishes, nor does anything queued after it.
    vi.spyOn(history, 'call').mockImplementation(function (this: unknown, body) {
      if (body.type === 'ingest') {
        held++
        return new Promise(() => undefined)
      }
      return realCall.call(this, body)
    })
    providerService.info = ((id: string) => ({ provider: id, found: true, path: join(base, 'no-cli.exe') })) as never
    enabled = config.settings.providers['claude-code'].enabled
    config.settings.providers['claude-code'].enabled = true
    w = createWorkspaceService()
    await w.open(wsPath)
    // The newest first: the import starts with ids[0].
    for (const [i, id] of ids.entries()) await w.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: `S ${i}`, createdAt: at, lastActiveAt: new Date(Date.now() - i * 60_000).toISOString(), archived: false })
    void inWorkspace(w, () => usageHistory.opened(w))
    await vi.waitFor(() => expect(held).toBe(1), { timeout: HUNG_MS })
  })
  afterAll(async () => {
    providerService.info = info
    config.settings.providers['claude-code'].enabled = enabled
    vi.restoreAllMocks()
    await disposeWorkspaceService(w)
  })

  /** Starts c1 and stops it just before its CLI would spawn, past every check and wait of the launch. */
  const reachesLaunch = async (opts: { resumeId?: string }): Promise<void> => {
    const past = new Error(STEP)
    await expect(inWorkspace(w, () => sessions.start(p, { agentId: 'c1', ...opts, allowed: () => { throw past } }))).rejects.toBe(past)
  }

  it('resumes a session the import has not reached', async () => {
    expect(usageHistory.backfilled(wsPath)).toBe(false)
    await reachesLaunch({ resumeId: ids[4] })
  })

  it('resumes the session whose import is held', async () => {
    await reachesLaunch({ resumeId: ids[0] })
  })

  it('starts a new session', async () => {
    await reachesLaunch({})
    // The import is still under way, held where it was.
    expect(held).toBe(1)
    expect(usageHistory.backfilled(wsPath)).toBe(false)
  })
})
