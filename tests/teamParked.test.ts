// Whether a paused team is parked (HI-2081; HR1's round 1, findings 1–5, from its review probes): the CLI's own
// processes positively identified by the launch's recorded MCP servers, never by age; a pause taken from the user's pause
// but not saved never parked, a failed save named; any Assistant at work counted unless it is the one asking; projects
// that can't be read can't be checked; and Install Now refusing when work starts while its last scan is made.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { ActivityProcess } from '../src/shared/activity'
import { tempDir } from './tempDir'

const h = vi.hoisted(() => ({
  open: [] as { path: string; assistantHome: string; info: () => unknown; lifetime: { aborted: boolean } }[],
  lives: new Map<string, { status: string }>(),
  job: null as null | ((p: string, a: string) => Promise<unknown>),
  installed: 0,
  profile: ''
}))

vi.mock('../src/main/workspace', async (orig) => ({
  ...(await orig<object>()),
  openWorkspaces: () => h.open,
  workspaceFor: (p: string) => h.open.find((w) => p.toLowerCase().startsWith(w.path.toLowerCase())) ?? null,
  inWorkspace: (_w: unknown, f: () => unknown) => f()
}))
vi.mock('../src/main/sessions', async (orig) => ({ ...(await orig<object>()), sessions: { liveFor: (p: string, a: string) => h.lives.get(`${p}#${a}`) ?? null, launchedMcp: () => null } }))
vi.mock('../src/main/events', async (orig) => ({ ...(await orig<object>()), emit: () => undefined }))
vi.mock('../src/main/deliveries', async (orig) => ({ ...(await orig<object>()), createDelivery: async () => null }))
vi.mock('../src/main/agentFolders', async (orig) => ({ ...(await orig<object>()), heldSlots: async () => new Map() }))
vi.mock('../src/main/agentProcesses', async (orig) => ({ ...(await orig<object>()), endTreesExactly: async () => null, launchJob: async (p: string, a: string) => (h.job ? await h.job(p, a) : 'none'), leftoversOf: () => ({ processes: [], more: 0, since: '' }) }))
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
  Object.assign(h, { open: [], lives: new Map(), job: null, installed: 0, profile: join(base, `profile${++n}`) })
  mkdirSync(h.profile, { recursive: true })
})

describe("a CLI's own processes, positively identified (round 1, finding 1)", () => {
  const ft = (ms: number): string => String(BigInt(ms) * 10000n + 116444736000000000n)
  const p = (pid: number, parent: number, ms: number, command: string, name = 'node.exe'): ActivityProcess => ({ pid, parent, created: ft(ms), command, label: command, name })
  const hive = { command: 'C:\\Hive\\Hive.exe', args: ['C:\\Hive\\out\\main\\hive-mcp.js'] }
  const ollama = { command: 'npx', args: ['-y', 'ollama-mcp'] }

  it('a child the CLI started early is a blocker unless it runs one of the launch’s servers; what a server started blocks', () => {
    const cli = p(2, 1, 0, 'codex.exe', 'codex.exe')
    const build = p(3, 2, 5_000, 'node dev-server.js')
    const server = p(4, 2, 5_000, '"C:\\Hive\\Hive.exe" "C:\\Hive\\out\\main\\hive-mcp.js"', 'Hive.exe')
    const underServer = p(5, 4, 60_000, 'node probe.js')
    expect(parked.beyondCli(1, [cli, build, server, underServer], [hive])!.map((x) => x.pid)).toEqual([3, 5])
    // With no servers recorded, nothing but the gate and the CLI is its own.
    expect(parked.beyondCli(1, [cli, build, server], [])!.map((x) => x.pid)).toEqual([3, 4])
  })

  it('a shell wrapping a server (cmd /c npx …), and the one server it started, are its own; a second child of it is not', () => {
    const cli = p(2, 1, 0, 'claude.exe', 'claude.exe')
    const shell = p(3, 2, 1_000, 'cmd.exe /d /s /c "npx -y ollama-mcp"', 'cmd.exe')
    const npx = p(4, 3, 2_000, 'node npx-cli.js -y ollama-mcp')
    expect(parked.beyondCli(1, [cli, shell, npx], [ollama])).toEqual([])
    const extra = p(5, 3, 3_000, 'node other.js')
    expect(parked.beyondCli(1, [cli, shell, npx, extra], [ollama])!.map((x) => x.pid).sort()).toEqual([4, 5])
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
    h.job = async (_p, a) => {
      if (a === 'b1') h.lives.set(`${alpha}#b1`, { status: 'working' })
      return 'none'
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
