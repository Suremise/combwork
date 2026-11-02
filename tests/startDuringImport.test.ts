// A start or resume never waits for the usage history's one-time import (#1177). The import's first session is held in
// the usage worker inside its file's turn (its transcript read, as the worker reads it, held until the test lets it go),
// so the import doesn't finish meanwhile, and a read of that transcript (a list's, the footer's) waits behind it. A
// resume of that same session, another session's resume and a new session all get past every check to their launch.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

/** The first session's transcript reads are held until `release()`. */
const gate = vi.hoisted(() => {
  let open!: () => void
  const opened = new Promise<void>((r) => (open = r))
  return { match: '', held: 0, opened, release: () => open() }
})
vi.mock('../src/main/transcriptFiles', async (orig) => {
  const real = await orig<typeof import('../src/main/transcriptFiles')>()
  return {
    ...real,
    readTranscript: async (path: string, ...rest: Parameters<typeof real.readTranscript> extends [string, ...infer R] ? R : never) => {
      if (gate.match && path.includes(gate.match)) {
        gate.held++
        await gate.opened
      }
      return real.readTranscript(path, ...rest)
    }
  }
})

const base = tempDir('hive-start-import-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// A test copy on its CLI test home (tests/cliHomes.ts), as an e2e run is: its agents start with no connection (the
// seam, HI-1755; connections are on for everyone since HI-1774).
process.env.HIVE_USER_DATA = join(base, 'profile')
process.env.HIVE_TEST_CLI_HOME_CONNECTION = '1'
;(electron.shell as unknown as { trashItem: (f: string) => Promise<void> }).trashItem = async (f) => rmSync(f, { force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { usageHistory } = await import('../src/main/usageHistory')
const { providerService } = await import('../src/main/providerService')
const { config } = await import('../src/main/config')

// The longest a wait here waits: a bound for a hung run, never how long it should take.
const HUNG_MS = 20_000
const wsPath = join(base, 'ws')
const p = join(wsPath, 'proj')
let w: ReturnType<typeof createWorkspaceService>
const at = new Date().toISOString()
const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-9000-${String(i + 1).padStart(12, '0')}`)
const backup = (id: string): string => join(p, '.hive', 'sessions', `${id}.jsonl`)
const PAST = 'past the checks'

describe('a start during the usage history import', () => {
  const info = providerService.info
  let enabled = false
  /** A read of the held transcript as a list or the footer makes it: answered only once the import's turn is over. */
  let waiting: Promise<unknown> | null = null
  let answered = false

  beforeAll(async () => {
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    mkdirSync(join(p, '.hive', 'sessions'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1', provider: 'claude-code' }] }))
    for (const id of ids) writeFileSync(backup(id), JSON.stringify({ type: 'user', sessionId: id, timestamp: at, message: { role: 'user', content: 'Task' } }) + '\n')
    vi.spyOn(sessions, 'providerTranscript').mockImplementation(async () => null)
    providerService.info = ((id: string) => ({ provider: id, found: true, path: join(base, 'no-cli.exe') })) as never
    enabled = config.settings.providers['claude-code'].enabled
    config.settings.providers['claude-code'].enabled = true
    w = createWorkspaceService()
    await w.open(wsPath)
    // The newest first: the import starts with ids[0].
    for (const [i, id] of ids.entries()) await w.upsertSession(p, { id, agent: 'claude-code', agentId: 'c1', name: `S ${i}`, createdAt: at, lastActiveAt: new Date(Date.now() - i * 60_000).toISOString(), archived: false })
    gate.match = ids[0]
    void inWorkspace(w, () => usageHistory.opened(w))
    await vi.waitFor(() => expect(gate.held).toBe(1), { timeout: HUNG_MS })
    waiting = inWorkspace(w, () => usageHistory.read(p, backup(ids[0]), ids[0], 'claude-code')).then(() => (answered = true))
  })
  afterAll(async () => {
    gate.release()
    await waiting
    providerService.info = info
    config.settings.providers['claude-code'].enabled = enabled
    vi.restoreAllMocks()
    await disposeWorkspaceService(w)
  })

  /** Starts c1 and stops it just before its CLI would spawn, past every check and wait of the launch. */
  const reachesLaunch = async (opts: { resumeId?: string }): Promise<void> => {
    const past = new Error(PAST)
    await expect(inWorkspace(w, () => sessions.start(p, { agentId: 'c1', ...opts, allowed: () => { throw past } }))).rejects.toBe(past)
  }

  it('resumes the session the import holds in its turn', async () => {
    expect(usageHistory.backfilled(wsPath)).toBe(false)
    await reachesLaunch({ resumeId: ids[0] })
    // Its transcript is still held: a read that waits for the turn is still waiting.
    expect(gate.held).toBe(1)
    expect(answered).toBe(false)
  })

  it('resumes a session the import has not reached', async () => {
    await reachesLaunch({ resumeId: ids[4] })
  })

  it('starts a new session', async () => {
    await reachesLaunch({})
    expect(usageHistory.backfilled(wsPath)).toBe(false)
    expect(answered).toBe(false)
  })

  it('and the read that waited is answered once the import goes on', async () => {
    gate.release()
    await vi.waitFor(() => expect(answered).toBe(true), { timeout: HUNG_MS })
  })
})
