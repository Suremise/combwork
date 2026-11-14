// jj's evidence never takes an unreadable file for an absent one (HI-2796's J3, HR2's round 1 finding 2): a stat or a
// listing that fails with anything but "not there" (access denied, an I/O error) makes the capture unknown, so it never
// compares equal and never earns credit or passes a fingerprint; a file that is legitimately absent (a deleted tracked
// file, a fresh repository's missing packed refs or reflogs) is still an answer. The failures are injected into the file
// system calls jjView.ts and jjChecks.ts make.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const inject = vi.hoisted(() => ({ fail: null as RegExp | null }))
const eacces = (path: unknown): Error => Object.assign(new Error(`EACCES: permission denied, '${String(path)}'`), { code: 'EACCES' })
const hit = (path: unknown): boolean => !!inject.fail && inject.fail.test(String(path).replace(/\\/g, '/'))

vi.mock('original-fs', async (original) => {
  const actual = await original<typeof import('fs')>()
  return {
    ...actual,
    statSync: ((path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
      if (hit(path)) throw eacces(path)
      return (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.statSync,
    opendirSync: ((path: Parameters<typeof actual.opendirSync>[0], ...rest: unknown[]) => {
      if (hit(path)) throw eacces(path)
      return (actual.opendirSync as (...a: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.opendirSync
  }
})
vi.mock('original-fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return {
    ...actual,
    stat: (async (path: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
      if (hit(path)) throw eacces(path)
      return (actual.stat as (...a: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.stat
  }
})

const { jjStats } = await import('../src/main/platform/jjChecks')
const { gitState, jjFingerprint } = await import('../src/main/platform/jjView')

/** A colocated workspace's Git folder: HEAD, an index, a ref and its log; packed refs and the HEAD reflog absent. */
function colocated(): { root: string; git: string } {
  const root = tempDir('jjfail-')
  const git = join(root, '.git')
  mkdirSync(join(git, 'refs', 'heads'), { recursive: true })
  mkdirSync(join(git, 'logs', 'refs', 'heads'), { recursive: true })
  writeFileSync(join(git, 'HEAD'), `${'a'.repeat(40)}\n`)
  writeFileSync(join(git, 'index'), 'index')
  writeFileSync(join(git, 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`)
  writeFileSync(join(git, 'logs', 'refs', 'heads', 'main'), 'log\n')
  return { root, git }
}

beforeEach(() => {
  inject.fail = null
})

describe("jj's stat snapshot", () => {
  it('a deleted tracked file is a gone line; an unreadable file or folder makes the snapshot unknown', async () => {
    const root = tempDir('jjstats-')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.txt'), 'a')
    const ok = await jjStats(root, ['src/a.txt', 'deleted.txt'])
    expect(ok).toContain('deleted.txt:gone')
    inject.fail = /\/src\/a\.txt$/
    expect(await jjStats(root, ['src/a.txt', 'deleted.txt'])).toBeNull()
    inject.fail = /\/src$/
    expect(await jjStats(root, ['src/a.txt'])).toBeNull()
    inject.fail = /jjstats-[^/]+\/\.$|jjstats-[^/]+$/
    expect(await jjStats(root, ['src/a.txt'])).toBeNull()
  })
})

describe("a colocated workspace's Git state", () => {
  it('reads with packed refs and the HEAD reflog legitimately absent', () => {
    const { git } = colocated()
    const s = gitState(git, git)
    expect(s).not.toBeNull()
    expect(s).toContain(`${join(git, 'packed-refs')}:gone`)
  })

  it("an unreadable Git state makes the colocated workspace's fingerprint unknown", () => {
    const { root, git } = colocated()
    const jjRepo = join(root, '.jj', 'repo')
    mkdirSync(join(jjRepo, 'op_heads', 'heads'), { recursive: true })
    mkdirSync(join(root, '.jj', 'working_copy'), { recursive: true })
    const op = 'b'.repeat(128)
    writeFileSync(join(jjRepo, 'op_heads', 'heads', op), '')
    writeFileSync(join(root, '.jj', 'working_copy', 'checkout'), Buffer.concat([Buffer.from([0x12, 64]), Buffer.from(op, 'hex'), Buffer.from([0x1a, 7]), Buffer.from('default')]))
    const view = { jjRepo, workspace: join(root, '.jj'), root, store: git, colocated: true }
    expect(jjFingerprint(view)).not.toBeNull()
    inject.fail = /\/\.git\/index$/
    expect(jjFingerprint(view)).toBeNull()
  })

  it.each([
    ['the index', /\/\.git\/index$/],
    ['the HEAD reflog', /\/\.git\/logs\/HEAD$/],
    ['packed refs', /\/\.git\/packed-refs$/],
    ['a ref', /\/\.git\/refs\/heads\/main$/],
    ["the refs folder's presence or listing", /\/\.git\/refs\/heads$/],
    ["the ref logs' folder", /\/\.git\/logs\/refs\/heads$/],
    ['an operation under way', /\/\.git\/MERGE_HEAD$/]
  ])('%s unreadable makes it unknown, never gone', (_what, fail) => {
    const { git } = colocated()
    inject.fail = fail
    expect(gitState(git, git)).toBeNull()
  })
})
