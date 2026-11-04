// What a Codex launch says it delivered of each Hive skill when something fails (CodexAdapter.prepareLaunch): one
// skill's failure (its source gone, unreadable, removed mid-copy) is its own, the others are still delivered, and each
// record is what Codex reads: Hive's copy from an earlier launch with its revision and why it wasn't refreshed, or
// nothing. A folder of the user's with the name is never Hive's delivery and is never touched. When the skills folder
// itself can't be set up, the records still say what's there. Faults are injected in fs/promises: reading files under
// a folder named "unreadable" is denied, and so is creating .agents/skills while `folderFails` is set.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, sep } from 'path'
import { execFileSync } from 'child_process'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const faults = { folderFails: false }
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  const denied = (what: string): Error => Object.assign(new Error(`EACCES: permission denied, ${what}`), { code: 'EACCES' })
  return {
    ...real,
    open: async (path: string, ...rest: unknown[]) => {
      if (/[\\/]unreadable[\\/]/.test(String(path))) throw denied('open')
      return (real.open as (...a: unknown[]) => unknown)(path, ...rest)
    },
    mkdir: async (path: string, ...rest: unknown[]) => {
      if (faults.folderFails && String(path).endsWith(`${sep}.agents${sep}skills`)) throw denied('mkdir')
      return (real.mkdir as (...a: unknown[]) => unknown)(path, ...rest)
    }
  }
})

const { contentHash } = await import('../src/main/fsutil')
const { codex } = await import('../src/main/providers/codex/adapter')
type Delivery = { revision: string | null; problem?: string; lasting?: true }
// Hook trust is checked against the Codex executable; not what these tests are about.
;(codex as unknown as { checkHookHashes: () => Promise<void> }).checkHookHashes = async () => undefined

const base = tempDir('hive-codex-delivery-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
beforeEach(() => {
  faults.folderFails = false
})

let n = 0
function setup(): { cwd: string; src: string; skills: string } {
  const root = join(base, `case-${++n}`)
  const cwd = join(root, 'project')
  mkdirSync(cwd, { recursive: true })
  return { cwd, src: join(root, 'workspace-skills'), skills: join(cwd, '.agents', 'skills') }
}

function source(src: string, name: string, text: string, folder = name): string {
  const d = join(src, folder)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\n---\n\n${text}\n`)
  return d
}

const launch = (cwd: string, skills: { name: string; sourcePath: string }[]): Promise<Record<string, Delivery>> =>
  codex.prepareLaunch({ projectPath: cwd, agentId: 'a1', runId: `r${n}`, cwd, skills, mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, executable: 'codex' } as never) as Promise<Record<string, Delivery>>

describe("one skill's source failing", () => {
  for (const order of ['before', 'after'] as const) {
    it(`a missing source ${order} a healthy one: the healthy one is delivered, the missing one keeps its old copy`, async () => {
      const { cwd, src, skills } = setup()
      const ok = source(src, 'ok', 'v1')
      const bad = source(src, 'bad', 'v1')
      const first = await launch(cwd, [{ name: 'ok', sourcePath: ok }, { name: 'bad', sourcePath: bad }])
      const oldBad = await contentHash(join(skills, 'cw-bad'))
      expect(first.bad).toEqual({ revision: oldBad })

      writeFileSync(join(ok, 'SKILL.md'), '---\nname: ok\n---\n\nv2\n')
      rmSync(bad, { recursive: true, force: true })
      const list = [{ name: 'ok', sourcePath: ok }, { name: 'bad', sourcePath: bad }]
      const out = await launch(cwd, order === 'before' ? list.reverse() : list)
      expect(out.ok).toEqual({ revision: await contentHash(ok) })
      expect(await contentHash(join(skills, 'cw-ok'))).toBe(await contentHash(ok))
      // Retryable: not lasting. The copy Codex still reads is reported as it is.
      expect(out.bad).toEqual({ revision: oldBad, problem: 'its folder in the workspace is gone, so it kept its old copy' })
      expect(await contentHash(join(skills, 'cw-bad'))).toBe(oldBad)
    })
  }

  it('an unreadable source keeps its old copy; with no old copy, it has none', async () => {
    const { cwd, src, skills } = setup()
    const ok = source(src, 'ok', 'v1')
    const was = source(src, 'was', 'v1')
    await launch(cwd, [{ name: 'was', sourcePath: was }])
    const kept = await contentHash(join(skills, 'cw-was'))
    // Both now under a folder Hive may not read.
    const locked = source(join(src, 'unreadable'), 'was', 'v2')
    const fresh = source(join(src, 'unreadable'), 'fresh', 'v1')
    const out = await launch(cwd, [{ name: 'was', sourcePath: locked }, { name: 'fresh', sourcePath: fresh }, { name: 'ok', sourcePath: ok }])
    expect(out.was).toEqual({ revision: kept, problem: 'its folder in the workspace could not be read (access denied), so it kept its old copy' })
    expect(out.fresh).toEqual({ revision: null, problem: 'its folder in the workspace could not be read (access denied)' })
    expect(existsSync(join(skills, 'cw-fresh'))).toBe(false)
    expect(out.ok).toEqual({ revision: await contentHash(ok) })
  })

  it("a folder of the user's with the name is never reported as delivered, nor touched", async () => {
    const { cwd, src, skills } = setup()
    mkdirSync(join(skills, 'cw-mine'), { recursive: true })
    writeFileSync(join(skills, 'cw-mine', 'SKILL.md'), 'MY OWN')
    const gone = join(src, 'mine')
    const out = await launch(cwd, [{ name: 'mine', sourcePath: gone }])
    expect(out.mine).toEqual({ revision: null, problem: 'its folder in the workspace is gone' })
    expect(readFileSync(join(skills, 'cw-mine', 'SKILL.md'), 'utf8')).toBe('MY OWN')
  })

  it('a too-big source is still a lasting problem (over the limits, not an I/O failure)', async () => {
    const { cwd, src } = setup()
    const big = source(src, 'big', 'v1')
    writeFileSync(join(big, 'data.bin'), Buffer.alloc(65 * 1024 * 1024, 1))
    const out = await launch(cwd, [{ name: 'big', sourcePath: big }])
    expect(out.big).toEqual({ revision: null, problem: 'it is too big for Combwork to check (it is over 64 MB)', lasting: true })
  })
})

describe('the skills folder failing', () => {
  it("can't be set up: each skill is what is there, Hive's copies with their revisions, the user's folders as nothing", async () => {
    const { cwd, src, skills } = setup()
    const a = source(src, 'a', 'v1')
    await launch(cwd, [{ name: 'a', sourcePath: a }])
    const kept = await contentHash(join(skills, 'cw-a'))
    mkdirSync(join(skills, 'cw-user'), { recursive: true })
    writeFileSync(join(skills, 'cw-user', 'SKILL.md'), 'MY OWN')
    writeFileSync(join(a, 'SKILL.md'), 'v2')
    faults.folderFails = true
    const out = await launch(cwd, [{ name: 'a', sourcePath: a }, { name: 'user', sourcePath: source(src, 'user', 'v1') }, { name: 'new', sourcePath: source(src, 'new', 'v1') }])
    expect(out.a).toEqual({ revision: kept, problem: 'the skills could not be copied, so it kept its old copy' })
    expect(out.user).toEqual({ revision: null, problem: 'the skills could not be copied' })
    expect(out.new).toEqual({ revision: null, problem: 'the skills could not be copied' })
    expect(readFileSync(join(skills, 'cw-user', 'SKILL.md'), 'utf8')).toBe('MY OWN')
  })

  it("keeping the copies out of git failing doesn't change what was delivered", async () => {
    const { cwd, src, skills } = setup()
    execFileSync('git', ['init', '-q'], { cwd })
    // info/exclude can't be written: it's a folder.
    rmSync(join(cwd, '.git', 'info'), { recursive: true, force: true })
    mkdirSync(join(cwd, '.git', 'info', 'exclude'), { recursive: true })
    const a = source(src, 'a', 'v1')
    const out = await launch(cwd, [{ name: 'a', sourcePath: a }])
    expect(out.a).toEqual({ revision: await contentHash(join(skills, 'cw-a')) })
  })
})
