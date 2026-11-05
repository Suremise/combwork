// Auto memory on a connection (HI-1899): a connection's home links `projects` to the CLI's own by a junction, so Claude
// Code saw each memory file's resolved path outside its memory folder and asked before every memory write. Combwork gives
// the launch that folder by its resolved path (autoMemoryDirectory), only on such a home and only where nothing else
// names the folder.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { connectionMemoryDir, memoryBase, memoryKey } from '../src/main/providers/claude/memoryDir'
import { advanced } from '../src/main/advanced'
import { junction } from './pathAliases'
import { tempDir } from './tempDir'

const base = tempDir('cw-connection-memory-')
afterAll(() => rmSync(base, { recursive: true, force: true }))

const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: baseEnv(), stdio: 'pipe' }).toString()

/** A connection's home whose `projects` is a junction to the CLI home's, as accounts.ts makes it. */
function connectionHome(name: string): { home: string; cliProjects: string } {
  const cliProjects = join(base, name, 'cli', '.claude', 'projects')
  mkdirSync(cliProjects, { recursive: true })
  const home = join(base, name, 'accounts', 'a-1')
  mkdirSync(home, { recursive: true })
  junction(cliProjects, join(home, 'projects'))
  return { home, cliProjects }
}

describe("a project's memory folder name, as Claude Code makes it (2.1.312)", () => {
  it('turns every character but letters and digits into -', () => {
    expect(memoryKey('D:\\Development\\HIVE\\hive')).toBe('D--Development-HIVE-hive')
    expect(memoryKey('C:/work/my project.v2')).toBe('C--work-my-project-v2')
  })

  it('cuts a name past 200 characters and adds a hash of the whole path, never a pattern', () => {
    const long = 'C:/' + 'deep/'.repeat(45) + 'project'
    // Claude Code's own hash (a 32-bit h*31+c, absolute, base 36), worked out for this path.
    expect(memoryKey(long)).toBe(`${memoryKey(long).slice(0, 200)}-km5ypa`)
    expect(memoryKey(long)).toHaveLength(207)
    expect(memoryKey(long)).not.toMatch(/[*?]/)
  })
})

describe('the folder Claude Code keys memory by', () => {
  it("is a repository's main working tree, from it or any worktree of it, and the folder itself outside Git", async () => {
    const repo = join(base, 'repo')
    mkdirSync(repo, { recursive: true })
    gitIn(repo, 'init', '-q')
    gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x')
    const wt = join(base, 'repo-wt')
    gitIn(repo, 'worktree', 'add', '-q', wt)
    mkdirSync(join(repo, 'sub'))
    expect((await memoryBase(repo))?.toLowerCase()).toBe(repo.toLowerCase())
    expect((await memoryBase(join(repo, 'sub')))?.toLowerCase()).toBe(repo.toLowerCase())
    expect((await memoryBase(wt))?.toLowerCase()).toBe(repo.toLowerCase())
    const plain = join(base, 'plain')
    mkdirSync(plain)
    expect(await memoryBase(plain)).toBe(plain)
  })
})

describe("a connection's memory folder for the launch", () => {
  it('is the session\'s memory folder by its resolved path, on a home whose projects is a junction', async () => {
    const { home, cliProjects } = connectionHome('linked')
    expect(await connectionMemoryDir(home, async () => 'D:\\work\\alpha')).toBe(join(cliProjects, 'D--work-alpha', 'memory'))
  })

  it('follows a link within it too, its project folder or memory itself, to the folder in use', async () => {
    const { home, cliProjects } = connectionHome('inner')
    const elsewhere = join(base, 'inner', 'elsewhere-memory')
    mkdirSync(elsewhere, { recursive: true })
    mkdirSync(join(cliProjects, 'D--work-alpha'))
    junction(elsewhere, join(cliProjects, 'D--work-alpha', 'memory'))
    expect(await connectionMemoryDir(home, async () => 'D:\\work\\alpha')).toBe(elsewhere)
    // A project folder not made yet: named under the resolved projects folder.
    expect(await connectionMemoryDir(home, async () => 'D:\\work\\beta')).toBe(join(cliProjects, 'D--work-beta', 'memory'))
  })

  it("is none where a link on the way leads nowhere or a file stands where a folder goes: never a guess", async () => {
    const { home, cliProjects } = connectionHome('dangling')
    // The project's folder a junction whose target is gone.
    const gone = join(base, 'dangling', 'gone-project')
    mkdirSync(gone)
    junction(gone, join(cliProjects, 'D--work-alpha'))
    rmSync(gone, { recursive: true })
    expect(await connectionMemoryDir(home, async () => 'D:\\work\\alpha')).toBeNull()
    // memory itself a junction whose target is gone.
    const goneMemory = join(base, 'dangling', 'gone-memory')
    mkdirSync(goneMemory)
    mkdirSync(join(cliProjects, 'D--work-beta'))
    junction(goneMemory, join(cliProjects, 'D--work-beta', 'memory'))
    rmSync(goneMemory, { recursive: true })
    expect(await connectionMemoryDir(home, async () => 'D:\\work\\beta')).toBeNull()
    // A file named memory.
    mkdirSync(join(cliProjects, 'D--work-gamma'))
    writeFileSync(join(cliProjects, 'D--work-gamma', 'memory'), 'x')
    expect(await connectionMemoryDir(home, async () => 'D:\\work\\gamma')).toBeNull()
    // A project folder made, its memory not yet: named.
    mkdirSync(join(cliProjects, 'D--work-delta'))
    expect(await connectionMemoryDir(home, async () => 'D:\\work\\delta')).toBe(join(cliProjects, 'D--work-delta', 'memory'))
  })

  it("is none on a home with its own projects folder, a junction that can't be resolved, or a base that can't be told", async () => {
    const own = join(base, 'own')
    mkdirSync(join(own, 'projects'), { recursive: true })
    const asked = vi.fn(async () => 'D:\\work\\alpha')
    expect(await connectionMemoryDir(own, asked)).toBeNull()
    // Git isn't asked where nothing is needed.
    expect(asked).not.toHaveBeenCalled()
    expect(await connectionMemoryDir(join(base, 'missing'), asked)).toBeNull()
    const { home, cliProjects } = connectionHome('broken')
    rmSync(cliProjects, { recursive: true, force: true })
    expect(await connectionMemoryDir(home, asked)).toBeNull()
    const linked = connectionHome('nobase')
    expect(await connectionMemoryDir(linked.home, async () => null)).toBeNull()
  })
})

describe("a Claude Code launch's settings on a connection (HI-1899)", () => {
  const launch = async (name: string, over: { env?: Record<string, string>; extraArgs?: string[] } = {}) => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const cwd = join(base, `${name}-project`)
    mkdirSync(cwd, { recursive: true })
    const ctx = {
      projectPath: cwd, agentId: 'a1', executable: 'C:\\bin\\claude.exe', cwd, workspacePath: cwd, runId: 'r', sessionId: '00000000-0000-4000-8000-000000000000',
      resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: over.extraArgs ?? [], hookUrl: 'http://127.0.0.1:9/hook?run=r', hookAuthFile: 'C:/hive/hook-auth/r.txt', privateDir: join(base, `${name}-private`), guidance: '', env: over.env ?? {}, allowBackgroundSessions: true, use200kContext: false
    }
    await claudeCode.prepareLaunch(ctx as never)
    return { cwd, settings: JSON.parse(readFileSync(join(ctx.privateDir, 'settings.json'), 'utf8')) }
  }

  it("names exactly that session's memory folder by its resolved path, and allows nothing", async () => {
    const { home, cliProjects } = connectionHome('launch')
    const { cwd, settings } = await launch('launch', { env: { CLAUDE_CONFIG_DIR: home } })
    expect(settings.autoMemoryDirectory).toBe(join(cliProjects, memoryKey(cwd), 'memory'))
    expect(settings.permissions).toBeUndefined()
  })

  it('names none without a connection, with the switch off, or where something else names the folder', async () => {
    const { home } = connectionHome('none')
    expect((await launch('plain')).settings.autoMemoryDirectory).toBeUndefined()
    const real = advanced.get.bind(advanced)
    const off = vi.spyOn(advanced, 'get').mockImplementation(((id: string) => (id === 'claude-code.memory.realPath' ? false : real(id))) as typeof advanced.get)
    try {
      expect((await launch('off', { env: { CLAUDE_CONFIG_DIR: home } })).settings.autoMemoryDirectory).toBeUndefined()
    } finally {
      off.mockRestore()
    }
    for (const v of ['CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', 'CLAUDE_CODE_REMOTE_MEMORY_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME']) {
      expect((await launch(`env-${v}`, { env: { CLAUDE_CONFIG_DIR: home, [v]: 'x' } })).settings.autoMemoryDirectory).toBeUndefined()
    }
    // The same variables set by a settings file's env, as Claude Code applies them: the user's --settings, the project's,
    // Claude Code's settings.json on that home; and another home named there.
    for (const v of ['CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', 'CLAUDE_CODE_REMOTE_MEMORY_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME']) {
      expect((await launch(`flag-${v}`, { env: { CLAUDE_CONFIG_DIR: home }, extraArgs: ['--settings', JSON.stringify({ env: { [v]: 'user-chosen-memory' } })] })).settings.autoMemoryDirectory).toBeUndefined()
      const p = join(base, `proj-${v}-project`)
      mkdirSync(join(p, '.claude'), { recursive: true })
      writeFileSync(join(p, '.claude', 'settings.json'), JSON.stringify({ env: { [v]: 'user-chosen-memory' } }))
      expect((await launch(`proj-${v}`, { env: { CLAUDE_CONFIG_DIR: home } })).settings.autoMemoryDirectory).toBeUndefined()
    }
    const own = connectionHome('userenv')
    writeFileSync(join(own.home, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_PROJECT_DIR_NAME: 'user-chosen-memory' } }))
    expect((await launch('userenv', { env: { CLAUDE_CONFIG_DIR: own.home } })).settings.autoMemoryDirectory).toBeUndefined()
    expect((await launch('otherhome', { env: { CLAUDE_CONFIG_DIR: home }, extraArgs: ['--settings', JSON.stringify({ env: { CLAUDE_CONFIG_DIR: 'C:\\elsewhere' } })] })).settings.autoMemoryDirectory).toBeUndefined()
    // Settings Combwork can't be sure of (--bare may stop Claude Code reading some): none.
    expect((await launch('bare', { env: { CLAUDE_CONFIG_DIR: home }, extraArgs: ['--bare'] })).settings.autoMemoryDirectory).toBeUndefined()
    // The project's own settings.
    const project = join(base, 'project-project')
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/p' }))
    expect((await launch('project', { env: { CLAUDE_CONFIG_DIR: home } })).settings.autoMemoryDirectory).toBeUndefined()
    // The user's own, in their --settings or Claude Code's settings.json on that home: theirs stands.
    expect((await launch('theirs', { env: { CLAUDE_CONFIG_DIR: home }, extraArgs: ['--settings', '{"autoMemoryDirectory":"~/mine"}'] })).settings.autoMemoryDirectory).toBe('~/mine')
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/notes' }))
    expect((await launch('user', { env: { CLAUDE_CONFIG_DIR: home } })).settings.autoMemoryDirectory).toBeUndefined()
  })
})
