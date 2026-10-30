// Whether a paused team is parked (HI-2081; HR1's round 1 and 2 findings, from its review probes): an agent's leftovers,
// an earlier launch's too, counted and ended by their recorded identity; a pause taken from the user's pause
// but not saved never parked, a failed save named; any Assistant at work counted unless it is the one asking; projects
// that can't be read can't be checked; and Install Now refusing when work starts while its last scan is made.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const h = vi.hoisted(() => ({
  open: [] as { path: string; assistantHome: string; info: () => unknown; lifetime: { aborted: boolean } }[],
  lives: new Map<string, { status: string }>(),
  job: null as null | ((p: string, a: string) => Promise<unknown>),
  installed: 0,
  left: { processes: [], more: 0, since: '' } as { processes: { pid: number; name: string; label: string; created: string }[]; more: number; since: string },
  ended: [] as number[],
  profile: ''
}))

vi.mock('../src/main/workspace', async (orig) => ({
  ...(await orig<object>()),
  openWorkspaces: () => h.open,
  workspaceFor: (p: string) => h.open.find((w) => p.toLowerCase().startsWith(w.path.toLowerCase())) ?? null,
  inWorkspace: (_w: unknown, f: () => unknown) => f()
}))
vi.mock('../src/main/sessions', async (orig) => ({ ...(await orig<object>()), sessions: { liveFor: (p: string, a: string) => h.lives.get(`${p}#${a}`) ?? null } }))
vi.mock('../src/main/events', async (orig) => ({ ...(await orig<object>()), emit: () => undefined }))
vi.mock('../src/main/deliveries', async (orig) => ({ ...(await orig<object>()), createDelivery: async () => null }))
// A read that takes a while (its slots): a test's step lands then.
vi.mock('../src/main/agentFolders', async (orig) => ({ ...(await orig<object>()), heldSlots: async () => (await h.job?.('', ''), new Map()) }))
vi.mock('../src/main/agentProcesses', async (orig) => ({
  ...(await orig<object>()),
  endTreesExactly: async (ps: { pid: number }[]) => (h.ended.push(...ps.map((x) => x.pid)), { failed: [], unverified: [] }),
  // B1's only (the Assistant's leftovers can't mask it).
  leftoversOf: (_p: string, a: string) => (a === 'b1' ? h.left : { processes: [], more: 0, since: '' })
}))
vi.mock('../src/main/progressService', async (orig) => ({ ...(await orig<object>()), progress: { list: () => [] } }))
vi.mock('../src/main/updater', async (orig) => ({ ...(await orig<object>()), restartAndInstall: () => void h.installed++, updateState: () => ({ status: 'ready' }) }))

;(electron.app as unknown as { getPath: () => string }).getPath = () => h.profile

const tp = await import('../src/main/teamPause')
const parked = await import('../src/main/teamParked')

const base = tempDir('hive-teamparked-')
let n = 0
/** A workspace (with alpha's B1, or no project), as the scan reads it. */
function space(withAgent = false): (typeof h.open)[number] {
  const p = join(base, `ws${++n}`)
  mkdirSync(join(p, '.hive'), { recursive: true })
  return { path: p, assistantHome: join(p, '.hive', 'assistant'), lifetime: { aborted: false }, info: () => ({ projects: withAgent ? [{ name: 'alpha', path: join(p, 'alpha'), config: { agents: [{ id: 'b1', name: 'B1' }] } }] : [] }) }
}
const ws = (w: (typeof h.open)[number]) => w as never

beforeEach(() => {
  tp.resetTeamPauseForTests()
  Object.assign(h, { open: [], lives: new Map(), job: null, installed: 0, left: { processes: [], more: 0, since: '' }, ended: [], profile: join(base, `profile${++n}`) })
  mkdirSync(h.profile, { recursive: true })
})

describe("an agent's leftovers (round 2, finding 2)", () => {
  it("an earlier launch's leftover blocks once the agent has a new session; install refuses; End It finds that old process", async () => {
    const w = space(true)
    h.open = [w]
    await tp.pauseTeam(ws(w), 'user')
    const alpha = join(w.path, 'alpha')
    h.lives.set(`${alpha}#b1`, { status: 'ready' })
    h.left = { processes: [{ pid: 4120, name: 'node.exe', label: 'node dev-server.js', created: '133749000000000000' }], more: 0, since: '' }
    const v = await parked.scanWorkspace(ws(w))
    expect(v.parked).toBe(false)
    expect(v.items).toEqual([expect.objectContaining({ agent: 'B1', kind: 'process', label: 'node dev-server.js', process: { pid: 4120, created: '133749000000000000', name: 'node.exe' } })])
    expect((await parked.installIfParked()).installed).toBe(false)
    expect(await parked.endParkedProcess(alpha, 'b1', 4120, '133749000000000000')).toBe('ended')
    expect(h.ended).toEqual([4120])
    // Another pid, or the same pid started at another time: not that process.
    expect(await parked.endParkedProcess(alpha, 'b1', 4120, '133749000000000001')).toBe('notFound')
    // Ended: parked, and installed.
    h.left = { processes: [], more: 0, since: '' }
    expect((await parked.installIfParked()).installed).toBe(true)
  })

  it('leftovers it can’t list (more than it lists): can’t be checked', async () => {
    const w = space(true)
    h.open = [w]
    await tp.pauseTeam(ws(w), 'user')
    h.left = { processes: [], more: 3, since: '' }
    const v = await parked.scanWorkspace(ws(w))
    expect(v.parked).toBe(false)
    expect(v.items).toEqual([expect.objectContaining({ state: 'unknown', kind: 'process' })])
  })
})

describe('what a paused team counts (round 1, findings 2, 4, 5)', () => {
  it('a working Assistant blocks the user’s install; its own turn is skipped only when it is the one asking', async () => {
    const w = space()
    h.open = [w]
    await tp.pauseTeam(ws(w), 'user')
    h.lives.set(`${w.assistantHome}#assistant`, { status: 'working' })
    expect((await parked.scanWorkspace(ws(w))).parked).toBe(false)
    expect((await parked.scanWorkspace(ws(w), { assistantOf: ws(w) })).parked).toBe(true)
  })

  it('a first pause of every workspace whose save fails: named, never parked', async () => {
    const w = space()
    h.open = [w]
    mkdirSync(join(w.path, '.hive', 'team-pause.json'))
    const r = await tp.pauseApp()
    expect(r.failed.map((f) => f.workspacePath)).toEqual([w.path])
    await tp.withLock(ws(w), () => undefined)
    const s = await parked.teamPauseState()
    expect(s.allParked).toBe(false)
    expect(s.workspaces[0].items.map((i) => i.what)).toEqual([expect.stringMatching(/^its pause couldn't be saved/)])
  })

  it('a workspace opened during the user’s pause whose save fails: held, named, never parked', async () => {
    const a = space()
    h.open = [a]
    await tp.pauseApp()
    const b = space()
    mkdirSync(join(b.path, '.hive', 'team-pause.json'))
    h.open = [a, b]
    expect(tp.teamPauseOf(ws(b))).not.toBeNull()
    await vi.waitFor(async () => expect(tp.pauseSaveState(ws(b))).toMatchObject({ failed: expect.any(String) }), { timeout: 10_000 })
    expect((await parked.scanWorkspace(ws(b))).parked).toBe(false)
  })

  it('projects that can’t be read: can’t be checked, never parked', async () => {
    const w = space()
    h.open = [w]
    await tp.pauseTeam(ws(w), 'user')
    w.info = () => null
    const v = await parked.scanWorkspace(ws(w))
    expect(v.parked).toBe(false)
    expect(v.items.map((i) => i.what)).toContain("its projects can't be read now")
  })
})

describe('Install Now (round 1, finding 3)', () => {
  it('work starting while its last scan is made: not installed', async () => {
    const w = space(true)
    h.open = [w]
    await tp.pauseTeam(ws(w), 'user')
    const alpha = join(w.path, 'alpha')
    h.lives.set(`${alpha}#b1`, { status: 'ready' })
    h.job = async () => {
      h.lives.set(`${alpha}#b1`, { status: 'working' })
      return null
    }
    expect((await parked.installIfParked()).installed).toBe(false)
    expect(h.installed).toBe(0)
  })

  it('nothing changing and all parked: installed, once', async () => {
    const w = space(true)
    h.open = [w]
    await tp.pauseTeam(ws(w), 'user')
    h.lives.set(`${join(w.path, 'alpha')}#b1`, { status: 'ready' })
    expect((await parked.installIfParked()).installed).toBe(true)
    expect(h.installed).toBe(1)
  })
})
