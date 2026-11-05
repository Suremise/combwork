// Agents' temp folder (HI-2496): the setting, each launch's own folder in it (stable, collision-safe, the Assistant's
// apart), the checks that keep it out of projects, slots and Combwork's own folders (junctions too), a folder that can't
// be made, and the launch environment's temp variables (the empty default unchanged, duplicates by case removed).
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { junction } from './pathAliases'

const base = tempDir('hive-agenttemp-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { agentTempFolder, agentTempSetting, expandRoot, prepareAgentTemp, protectedFolders, withAgentTemp } = await import('../src/main/agentTemp')
const { advanced } = await import('../src/main/advanced')
const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const { AGENT_TEMP_FOLDER_ID, advancedDef, checkAdvanced } = await import('../src/shared/advanced')

// The run's temp folder goes with the run (tests/README.md, Isolation): no recursive delete here, junctions in it.
afterAll(() => advanced.stop())

type FakeWs = Parameters<typeof protectedFolders>[0][number]
const fakeWs = (path: string, projects: string[], hidden: string[] = []): FakeWs =>
  ({
    path,
    worktreesRoot: `${path}.worktrees`,
    assistantHome: join(path, '.combwork', 'assistant'),
    listProjectPaths: async (o?: { hidden?: boolean }) => (o?.hidden ? hidden : projects),
    knownRoots: () => []
  }) as unknown as FakeWs

describe('the setting', () => {
  const def = advancedDef(AGENT_TEMP_FOLDER_ID)!
  it('is empty by default, one folder, a workspace may set its own, and sessions take it', () => {
    expect(def.default).toEqual([])
    expect(def.max).toBe(1)
    expect(def.workspace).toBe(true)
    expect(def.applies).toBe('sessions')
  })
  it('takes one full path or a leading %VARIABLE%, and refuses two, a relative path, or text', () => {
    expect(checkAdvanced(def, 'D:\\agent-tmp')).toEqual({ value: ['D:\\agent-tmp'] })
    expect(checkAdvanced(def, '%LOCALAPPDATA%\\hive-test\\agent-tmp')).toEqual({ value: ['%LOCALAPPDATA%\\hive-test\\agent-tmp'] })
    expect(checkAdvanced(def, [])).toEqual({ value: [] })
    for (const bad of ['D:\\a; E:\\b', 'agent-tmp', 'tmp\\x', 42]) expect('error' in checkAdvanced(def, bad), String(bad)).toBe(true)
    expect((checkAdvanced(def, 'agent-tmp') as { error: string }).error).toMatch(/one folder's full path/)
  })
  it("reads the workspace's own over Combwork's; empty, none", async () => {
    expect(agentTempSetting(null)).toBeNull()
    await advanced.set(AGENT_TEMP_FOLDER_ID, 'D:\\hive-wide')
    expect(agentTempSetting(null)).toBe('D:\\hive-wide')
    const ws = { config: { advanced: { [AGENT_TEMP_FOLDER_ID]: ['E:\\own'] } } } as unknown as Parameters<typeof agentTempSetting>[0]
    expect(agentTempSetting(ws)).toBe('E:\\own')
    const emptied = { config: { advanced: { [AGENT_TEMP_FOLDER_ID]: [] } } } as unknown as Parameters<typeof agentTempSetting>[0]
    expect(agentTempSetting(emptied)).toBe('D:\\hive-wide')
    await advanced.set(AGENT_TEMP_FOLDER_ID, [])
    expect(agentTempSetting(null)).toBeNull()
  })
})

describe('expandRoot', () => {
  it('fills a leading variable (any case), and refuses one not set or a path that is not full', () => {
    expect(expandRoot('%LocalAppData%\\x', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toBe('C:\\Users\\u\\AppData\\Local\\x')
    expect(expandRoot('%NOPE%\\x', {})).toBeNull()
    expect(expandRoot('%EMPTY%\\x', { EMPTY: '' })).toBeNull()
    expect(expandRoot('%REL%\\x', { REL: 'relative' })).toBeNull()
    expect(expandRoot('\\\\server\\share\\t', {})).toBe('\\\\server\\share\\t')
  })
})

describe("each launch's folder", () => {
  it('is per host and agent id: stable, any spelling the same, equal project names in two workspaces apart', () => {
    const a = agentTempFolder('D:\\t', 'D:\\ws1\\alpha', 'a-1', false)
    expect(a).toMatch(/^D:\\t\\alpha-[0-9a-f]{8}\\a-1$/)
    expect(agentTempFolder('D:\\t', 'd:\\WS1\\Alpha\\', 'a-1', false).toLowerCase()).toBe(a.toLowerCase())
    expect(agentTempFolder('D:\\t', 'D:\\ws2\\alpha', 'a-1', false)).not.toBe(a)
    expect(agentTempFolder('D:\\t', 'D:\\ws1\\alpha', 'a-2', false)).not.toBe(a)
  })
  it("keeps the Assistant apart from any project, a project named assistant too", () => {
    const home = 'D:\\ws1\\.combwork\\assistant'
    const asst = agentTempFolder('D:\\t', home, 'assistant', true)
    expect(asst).toMatch(/\\_assistant-[0-9a-f]{8}\\assistant$/)
    expect(agentTempFolder('D:\\t', 'D:\\ws1\\assistant', 'assistant', false)).not.toBe(asst)
  })
  it('makes names safe as folders: separators, device names and trailing dots', () => {
    expect(agentTempFolder('D:\\t', 'D:\\w\\a b:c', 'x/..\\y', false)).toMatch(/^D:\\t\\a_b_c-[0-9a-f]{8}\\x_\.\._y$/)
    expect(agentTempFolder('D:\\t', 'D:\\w\\p', 'con', false)).toMatch(/\\_con$/)
    expect(agentTempFolder('D:\\t', 'D:\\w\\p.', 'a', false)).toMatch(/\\p-[0-9a-f]{8}\\a$/)
  })
})

describe('prepareAgentTemp', () => {
  const ws = join(base, 'ws')
  const proj = join(ws, 'alpha')
  mkdirSync(proj, { recursive: true })
  const launch = (setting: string | null, more: Partial<Parameters<typeof prepareAgentTemp>[0]> = {}) => prepareAgentTemp({ setting, host: proj, agentId: 'a-1', assistant: false, protect: [proj, `${ws}.worktrees`, join(ws, '.combwork')], ...more })

  it('empty: nothing made, null', async () => {
    expect(await launch(null)).toBeNull()
    expect(await launch('  ')).toBeNull()
  })
  it("set: the agent's folder made and returned, again on the next launch", async () => {
    const root = join(base, 'root')
    const dir = await launch(root)
    expect(dir).toBe(agentTempFolder(root, proj, 'a-1', false))
    expect(statSync(dir!).isDirectory()).toBe(true)
    writeFileSync(join(dir!, 'kept.txt'), 'x')
    expect(await launch(root)).toBe(dir)
    expect(statSync(join(dir!, 'kept.txt')).isFile()).toBe(true)
  })
  it('fills a leading variable from the environment given, and refuses one not set', async () => {
    const dir = await launch('%AGENT_ROOT%\\v', { env: { AGENT_ROOT: base } })
    expect(dir?.startsWith(join(base, 'v'))).toBe(true)
    await expect(launch('%AGENT_ROOT_MISSING%\\v', { env: {} })).rejects.toThrow(/variable that isn't set/)
  })
  it('refuses a folder inside a project, a slot or .combwork, making nothing', async () => {
    for (const root of [join(proj, 'tmp'), join(`${ws}.worktrees`, 'slot-a', 'tmp'), join(ws, '.combwork', 'tmp')]) {
      await expect(launch(root), root).rejects.toThrow(/is inside/)
      expect(() => statSync(root)).toThrow()
    }
  })
  it('refuses a folder reached through a junction into a project', async () => {
    const link = join(base, 'into-project')
    junction(proj, link)
    await expect(launch(join(link, 'tmp'))).rejects.toThrow(/is inside/)
    expect(() => statSync(join(proj, 'tmp'))).toThrow()
  })
  it('refuses a root whose host folder is a junction into a project (checked again once made)', async () => {
    const root = join(base, 'root-j')
    mkdirSync(root, { recursive: true })
    junction(proj, dirname(agentTempFolder(root, proj, 'a-1', false)))
    await expect(launch(root)).rejects.toThrow(/is inside/)
  })
  it("stops the launch when the folder can't be made", async () => {
    const file = join(base, 'a-file')
    writeFileSync(file, 'x')
    await expect(launch(join(file, 'under'))).rejects.toThrow(/couldn't be made/)
  })
})

describe('protectedFolders', () => {
  // HR1, round 1: an agent's folder registered outside the workspace and its pool (a 0.9 worktree, a slot or retired home
  // elsewhere, a worktree noted unused) is protected from another agent's temp folder, through the real WorkspaceService.
  it("protects another agent's registered folders outside the workspace, in a real workspace", async () => {
    const root = join(base, 'registered')
    const ws = join(root, 'ws')
    const proj = join(ws, 'alpha')
    const external = join(root, 'external-checkout')
    const unused = join(root, 'unused-worktree')
    for (const d of [join(proj, '.combwork'), external, unused]) mkdirSync(d, { recursive: true })
    writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-legacy', name: 'Legacy', provider: 'claude-code', worktree: { path: external, branch: 'legacy', base: 'main' } }] }))
    const w = createWorkspaceService()
    try {
      await w.open(ws)
      expect(w.projectForRoot(external)).toBe(proj)
      w.noteUnusedWorktrees(proj, [unused])
      const protect = [...(await protectedFolders([w])), proj]
      for (const inside of [external, unused]) {
        const setting = join(inside, 'temp-for-other-agent')
        await expect(prepareAgentTemp({ setting, host: proj, agentId: 'a-other', assistant: false, protect }), inside).rejects.toThrow(/is inside/)
        expect(existsSync(setting), inside).toBe(false)
      }
      // Beside them, outside every known folder: taken.
      expect(await prepareAgentTemp({ setting: join(root, 'agent-tmp'), host: proj, agentId: 'a-other', assistant: false, protect })).toBe(agentTempFolder(join(root, 'agent-tmp'), proj, 'a-other', false))
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it("lists every open workspace's folder, projects, hidden ones, slots, Assistant home and .combwork", async () => {
    const list = await protectedFolders([fakeWs('D:\\w1', ['D:\\w1\\a'], ['D:\\w1\\h']), fakeWs('E:\\w2', ['E:\\w2\\a'])])
    expect(list).toEqual(expect.arrayContaining(['D:\\w1', 'E:\\w2', 'D:\\w1\\a', 'D:\\w1\\h', 'D:\\w1.worktrees', join('D:\\w1', '.combwork', 'assistant'), join('D:\\w1', '.combwork'), 'E:\\w2\\a', 'E:\\w2.worktrees']))
  })
  it('skips a workspace with no folder (closing) and one whose list fails', async () => {
    const failing = { ...fakeWs('F:\\w3', []), listProjectPaths: async () => Promise.reject(new Error('closed')) } as unknown as FakeWs
    const list = await protectedFolders([{ path: null } as unknown as FakeWs, failing])
    expect(list).toEqual(['F:\\w3', 'F:\\w3.worktrees', join('F:\\w3', '.combwork', 'assistant'), join('F:\\w3', '.combwork')])
  })
})

describe('withAgentTemp', () => {
  const env = { Path: 'C:\\x', temp: 'C:\\Users\\u\\AppData\\Local\\Temp', TMP: 'C:\\old', TmpDir: '/tmp', CLAUDE_CODE_TMPDIR: 'C:\\mine' }
  it('none set: the environment as it was, the same object', () => {
    expect(withAgentTemp(env, null)).toBe(env)
  })
  it('set: TEMP, TMP and TMPDIR the folder, once each whatever their case, the rest unchanged', () => {
    const out = withAgentTemp(env, 'D:\\t\\alpha-1\\a-1')
    expect(out).toEqual({ Path: 'C:\\x', CLAUDE_CODE_TMPDIR: 'C:\\mine', TEMP: 'D:\\t\\alpha-1\\a-1', TMP: 'D:\\t\\alpha-1\\a-1', TMPDIR: 'D:\\t\\alpha-1\\a-1' })
    expect(env.temp).toBe('C:\\Users\\u\\AppData\\Local\\Temp')
  })
  it("reaches Copilot's launch: its environment step keeps them, stripping only its token variables", async () => {
    const { copilotEnv } = await import('../src/main/providers/copilot/home')
    const out = copilotEnv(withAgentTemp({ GH_TOKEN: 'x', TEMP: 'C:\\old' }, 'D:\\t\\p-1\\c-1'), true, true)
    expect(out).toMatchObject({ TEMP: 'D:\\t\\p-1\\c-1', TMP: 'D:\\t\\p-1\\c-1', TMPDIR: 'D:\\t\\p-1\\c-1' })
    expect(out.GH_TOKEN).toBeUndefined()
  })
})
