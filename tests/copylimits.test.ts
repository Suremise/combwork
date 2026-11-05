// A skill's source can change while Combwork copies it for a session. The copy keeps the size limits (bytes read, entries,
// depth) as it goes, is checked before it is published, and what is recorded as delivered is the copy's own revision:
// a source grown past the limits, or with a file gone or unreadable mid-copy, never replaces a usable copy (Codex keeps
// its old one and says why) and is never left half-copied for a session (Claude Code: no copy, and why). A source that
// changed but is still valid is delivered as it was copied. Changes are made deterministically by a hook in
// fs/promises' open: `beforeWrite` runs before the copy writes a file whose path it matches; `deny` refuses reads.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const hooks: { beforeWrite: null | { match: RegExp; run: () => void }; deny: RegExp | null; writes: 'short' | 'none' | null; writeCalls: number } = { beforeWrite: null, deny: null, writes: null, writeCalls: 0 }
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  return {
    ...real,
    open: async (path: string, flags?: string, mode?: number) => {
      const p = String(path)
      const h = hooks.beforeWrite
      if (h && flags === 'w' && h.match.test(p)) {
        hooks.beforeWrite = null
        h.run()
      }
      if (hooks.deny?.test(p) && (flags === undefined || flags === 'r')) throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })
      const handle = await real.open(path, flags, mode)
      if (flags !== 'w' || !hooks.writes) return handle
      // A file being written takes less than it is given (as a FileHandle may, legitimately): half of each write, at
      // least one byte; or nothing at all.
      return new Proxy(handle, {
        get(t, k) {
          if (k === 'write')
            return async (buf: Buffer, offset: number, length: number) => {
              hooks.writeCalls++
              if (hooks.writes === 'none') return { bytesWritten: 0, buffer: buf }
              return t.write(buf, offset, Math.max(1, Math.floor(length / 2)))
            }
          const v = (t as unknown as Record<string | symbol, unknown>)[k]
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
        }
      })
    }
  }
})

const { contentHash, HASH_LIMITS, swapIn } = await import('../src/main/fsutil')
const { codex } = await import('../src/main/providers/codex/adapter')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
;(codex as unknown as { checkHookHashes: () => Promise<void> }).checkHookHashes = async () => undefined
type Delivery = { revision: string | null; problem?: string; lasting?: true }

// The entry and byte limits lowered for this file (HI-2453), as revisions.test.ts does (#215, #666): the copy and the
// check read HASH_LIMITS as they go, so the same limits are kept over a tenth of the files and a 1 MB file. At Combwork's own
// 2000 entries and 64 MB a test wrote and copied 2000 files or 65 MB, and under a loaded full run one passed even its
// 180 s bound. The real values are checked below, before they are lowered.
const CW_LIMITS = { ...HASH_LIMITS }
const LIMITS = { entries: 200, depth: HASH_LIMITS.depth, bytes: 1024 * 1024 }
beforeAll(() => {
  Object.assign(HASH_LIMITS, LIMITS)
})
afterAll(() => {
  Object.assign(HASH_LIMITS, CW_LIMITS)
})

it("Combwork's own limits, lowered for this file: 2000 entries, 12 folders deep, 64 MB", () => {
  expect(CW_LIMITS).toEqual({ entries: 2000, depth: 12, bytes: 64 * MB })
})

const base = tempDir('hive-copy-limits-')
beforeEach(() => {
  hooks.beforeWrite = null
  hooks.deny = null
  hooks.writes = null
  hooks.writeCalls = 0
})

const MB = 1024 * 1024
let n = 0
/** A skill folder: a.md (copied first), b.md, data.bin (1 KB), and an empty refs folder. */
function source(root: string, name: string, text = 'v1'): string {
  const d = join(root, name)
  mkdirSync(join(d, 'refs'), { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\n---\n\n${text}\n`)
  writeFileSync(join(d, 'a.md'), 'a')
  writeFileSync(join(d, 'b.md'), 'b')
  writeFileSync(join(d, 'data.bin'), Buffer.alloc(1024, 1))
  return d
}
/** Growth and changes, made while the copy writes its first file (a.md: the first in the folder's order). */
const changes = {
  bytes: (src: string) => appendFileSync(join(src, 'data.bin'), Buffer.alloc(LIMITS.bytes + MB, 1)),
  entries: (src: string) => {
    for (let i = 0; i < LIMITS.entries + 100; i++) writeFileSync(join(src, 'refs', `r${i}.md`), '')
  },
  depth: (src: string) => mkdirSync(join(src, 'refs', ...'abcdefghijklm'.split('')), { recursive: true }),
  vanish: (src: string) => rmSync(join(src, 'b.md')),
  // Only this source's b.md (not a copy's, nor another skill's).
  unreadable: (src: string) => {
    hooks.deny = new RegExp(`^${join(src, 'b.md').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`, 'i')
  },
  valid: (src: string) => writeFileSync(join(src, 'b.md'), 'b, edited while it was being copied')
}
const reason = {
  bytes: 'it is too big for Combwork to check (it is over 1 MB)',
  entries: 'it is too big for Combwork to check (it has more than 200 files and folders)',
  depth: 'it is too big for Combwork to check (it has folders more than 12 deep)',
  vanish: 'a file in it went while it was being copied',
  unreadable: 'its folder in the workspace could not be read (access denied)'
} as const

describe('Codex: a source changing while it is copied', () => {
  const launch = (cwd: string, skills: { name: string; sourcePath: string }[]) =>
    codex.prepareLaunch({ projectPath: cwd, agentId: 'a1', runId: `r${++n}`, cwd, skills, mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, executable: 'codex' } as never) as Promise<Record<string, Delivery>>

  for (const kind of ['bytes', 'entries', 'depth', 'vanish', 'unreadable'] as const) {
    it(`${kind}: the old copy stays, reported as it is and why; a later skill is still delivered`, async () => {
      const root = join(base, `codex-${kind}`)
      const cwd = join(root, 'project')
      mkdirSync(cwd, { recursive: true })
      const bad = source(root, 'bad')
      const ok = source(root, 'ok')
      await launch(cwd, [{ name: 'bad', sourcePath: bad }])
      const copy = join(cwd, '.agents', 'skills', 'cw-bad')
      const old = await contentHash(copy)
      // A new version, then the change while it is copied.
      writeFileSync(join(bad, 'SKILL.md'), '---\nname: bad\n---\n\nv2\n')
      hooks.beforeWrite = { match: /cw-bad\.hive-new-[^\\/]*[\\/]a\.md$/, run: () => changes[kind](bad) }
      const out = await launch(cwd, [{ name: 'bad', sourcePath: bad }, { name: 'ok', sourcePath: ok }])
      const lasting = kind === 'bytes' || kind === 'entries' || kind === 'depth'
      expect(out.bad).toEqual({ revision: old, problem: `${reason[kind]}, so it kept its old copy`, ...(lasting ? { lasting: true } : {}) })
      expect(await contentHash(copy)).toBe(old)
      expect(readFileSync(join(copy, 'SKILL.md'), 'utf8')).toContain('v1')
      expect(out.ok).toEqual({ revision: await contentHash(ok) })
      expect(readdirSync(join(cwd, '.agents', 'skills')).filter((f) => f.startsWith('.'))).toEqual([])
    }, 60_000)
  }

  it('grown past the limits with no copy before: none, and why; nothing half-copied', async () => {
    const root = join(base, 'codex-first')
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })
    const bad = source(root, 'bad')
    hooks.beforeWrite = { match: /cw-bad\.hive-new-[^\\/]*[\\/]a\.md$/, run: () => changes.bytes(bad) }
    const out = await launch(cwd, [{ name: 'bad', sourcePath: bad }])
    expect(out.bad).toEqual({ revision: null, problem: reason.bytes, lasting: true })
    expect(readdirSync(join(cwd, '.agents', 'skills'))).toEqual([])
  })

  it('changed but still valid: delivered as copied, and its marker is that copy (no copy again next time)', async () => {
    const root = join(base, 'codex-valid')
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })
    const s = source(root, 'mine')
    hooks.beforeWrite = { match: /cw-mine\.hive-new-[^\\/]*[\\/]a\.md$/, run: () => changes.valid(s) }
    const out = await launch(cwd, [{ name: 'mine', sourcePath: s }])
    const copy = join(cwd, '.agents', 'skills', 'cw-mine')
    expect(readFileSync(join(copy, 'b.md'), 'utf8')).toBe('b, edited while it was being copied')
    expect(out.mine).toEqual({ revision: await contentHash(copy) })
    expect(await contentHash(copy)).toBe(await contentHash(s))
    expect(JSON.parse(readFileSync(join(copy, '.hive-copy'), 'utf8')).hash).toBe(await contentHash(s))
    const again = await launch(cwd, [{ name: 'mine', sourcePath: s }])
    expect(again.mine).toEqual({ revision: await contentHash(s) })
  })
})

describe('Claude Code: a source changing while it is copied', () => {
  const launch = (project: string, skills: { name: string; sourcePath: string }[]) =>
    claudeCode.prepareLaunch({ projectPath: project, agentId: 'a1', cwd: project, skills, mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, extraArgs: [], hookAuthFile: 'C:/hive/hook-auth/x.txt', privateDir: `${project}-private` } as never) as Promise<Record<string, Delivery>>

  for (const kind of ['bytes', 'entries', 'depth', 'vanish', 'unreadable'] as const) {
    it(`${kind}: not copied for the session (no partial copy), and why; a later skill is still delivered`, async () => {
      const root = join(base, `claude-${kind}`)
      const project = join(root, 'project')
      mkdirSync(project, { recursive: true })
      const bad = source(root, 'bad')
      const ok = source(root, 'ok')
      hooks.beforeWrite = { match: /plugin[\\/]skills[\\/]bad[\\/]a\.md$/, run: () => changes[kind](bad) }
      const out = await launch(project, [{ name: 'bad', sourcePath: bad }, { name: 'ok', sourcePath: ok }])
      const lasting = kind === 'bytes' || kind === 'entries' || kind === 'depth'
      expect(out.bad).toEqual({ revision: null, problem: reason[kind], ...(lasting ? { lasting: true } : {}) })
      const skills = join(project, '.combwork', 'launch-a1', 'plugin', 'skills')
      expect(existsSync(join(skills, 'bad'))).toBe(false)
      expect(out.ok).toEqual({ revision: await contentHash(join(skills, 'ok')) })
    }, 60_000)
  }

  it('changed but still valid: delivered as copied', async () => {
    const root = join(base, 'claude-valid')
    const project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    const s = source(root, 'mine')
    hooks.beforeWrite = { match: /plugin[\\/]skills[\\/]mine[\\/]a\.md$/, run: () => changes.valid(s) }
    const out = await launch(project, [{ name: 'mine', sourcePath: s }])
    const copy = join(project, '.combwork', 'launch-a1', 'plugin', 'skills', 'mine')
    expect(readFileSync(join(copy, 'b.md'), 'utf8')).toBe('b, edited while it was being copied')
    expect(out.mine).toEqual({ revision: await contentHash(copy) })
  })
})

describe('writes that take less than they are given', () => {
  /** A skill whose files span several 64 KB chunks: binary (every byte value) and Unicode text. */
  function rich(root: string, name: string): string {
    const d = join(root, name)
    mkdirSync(join(d, 'refs'), { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\n---\n\n${'Ünïcödé — 日本語 — 🐝 '.repeat(4000)}\nThis instruction must be copied in full.\n`)
    writeFileSync(join(d, 'refs', 'data.bin'), Buffer.from(Array.from({ length: 300 * 1024 }, (_, i) => (i * 7 + 3) % 256)))
    return d
  }
  const same = (a: string, b: string, rel: string) => expect(readFileSync(join(a, rel)).equals(readFileSync(join(b, rel)))).toBe(true)

  it('Codex: the copy is completed byte for byte, and delivered with its revision', async () => {
    const root = join(base, 'short-codex')
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })
    const s = rich(root, 'rich')
    hooks.writes = 'short'
    const out = (await codex.prepareLaunch({ projectPath: cwd, agentId: 'a1', runId: 'short', cwd, skills: [{ name: 'rich', sourcePath: s }], mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, executable: 'codex' } as never)) as Record<string, Delivery>
    const copy = join(cwd, '.agents', 'skills', 'cw-rich')
    for (const f of ['SKILL.md', 'refs/data.bin']) same(s, copy, f)
    expect(out.rich).toEqual({ revision: await contentHash(s) })
    // Many partial writes were made: it wasn't one write per chunk.
    expect(hooks.writeCalls).toBeGreaterThan(20)
  })

  it('Claude Code: the same', async () => {
    const root = join(base, 'short-claude')
    const project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    const s = rich(root, 'rich')
    hooks.writes = 'short'
    const out = (await claudeCode.prepareLaunch({ projectPath: project, agentId: 'a1', cwd: project, skills: [{ name: 'rich', sourcePath: s }], mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, extraArgs: [], hookAuthFile: 'C:/hive/hook-auth/x.txt', privateDir: `${project}-private` } as never)) as Record<string, Delivery>
    const copy = join(project, '.combwork', 'launch-a1', 'plugin', 'skills', 'rich')
    for (const f of ['SKILL.md', 'refs/data.bin']) same(s, copy, f)
    expect(out.rich).toEqual({ revision: await contentHash(s) })
  })

  it("a file swap (a mode's) is completed byte for byte too", async () => {
    const root = join(base, 'short-file')
    mkdirSync(root, { recursive: true })
    const src = join(root, 'src.md')
    writeFileSync(src, '日本語 🐝 '.repeat(30000))
    hooks.writes = 'short'
    const revision = await swapIn(src, join(root, 'mode.md'))
    expect(readFileSync(join(root, 'mode.md')).equals(readFileSync(src))).toBe(true)
    expect(revision).toBe(await contentHash(src))
  })

  it('a write that takes nothing fails the copy: the old copy stays (Codex), nothing is copied (Claude Code), nothing left behind', async () => {
    const root = join(base, 'none')
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })
    const s = source(root, 'stuck')
    const launchCodex = () => codex.prepareLaunch({ projectPath: cwd, agentId: 'a1', runId: `none${++n}`, cwd, skills: [{ name: 'stuck', sourcePath: s }], mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, executable: 'codex' } as never) as Promise<Record<string, Delivery>>
    await launchCodex()
    const copy = join(cwd, '.agents', 'skills', 'cw-stuck')
    const old = await contentHash(copy)
    writeFileSync(join(s, 'SKILL.md'), '---\nname: stuck\n---\n\nv2\n')
    hooks.writes = 'none'
    const out = await launchCodex()
    expect(out.stuck).toEqual({ revision: old, problem: 'it could not be copied (EIO), so it kept its old copy' })
    expect(await contentHash(copy)).toBe(old)
    expect(readdirSync(join(cwd, '.agents', 'skills')).filter((f) => f.startsWith('.'))).toEqual([])

    const project = join(root, 'claude')
    mkdirSync(project, { recursive: true })
    const claude = (await claudeCode.prepareLaunch({ projectPath: project, agentId: 'a1', cwd: project, skills: [{ name: 'stuck', sourcePath: s }], mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, extraArgs: [], hookAuthFile: 'C:/hive/hook-auth/x.txt', privateDir: `${project}-private` } as never)) as Record<string, Delivery>
    expect(claude.stuck).toEqual({ revision: null, problem: 'it could not be copied (EIO)' })
    expect(existsSync(join(project, '.combwork', 'launch-a1', 'plugin', 'skills', 'stuck'))).toBe(false)
  })
})

describe('a skill at the entry limit', () => {
  /** source() has 5 entries (SKILL.md, a.md, b.md, data.bin, refs): this fills refs up to `total` in all. */
  function sized(root: string, name: string, total: number): string {
    const d = source(root, name)
    for (let i = 0; i < total - 5; i++) writeFileSync(join(d, 'refs', `r${i}.md`), '')
    return d
  }
  const launchCodex = (cwd: string, skills: { name: string; sourcePath: string }[]) =>
    codex.prepareLaunch({ projectPath: cwd, agentId: 'a1', runId: `limit${++n}`, cwd, skills, mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, executable: 'codex' } as never) as Promise<Record<string, Delivery>>
  const launchClaude = (project: string, skills: { name: string; sourcePath: string }[]) =>
    claudeCode.prepareLaunch({ projectPath: project, agentId: 'a1', cwd: project, skills, mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, extraArgs: [], hookAuthFile: 'C:/hive/hook-auth/x.txt', privateDir: `${project}-private` } as never) as Promise<Record<string, Delivery>>

  // At the file's lowered limit (LIMITS, above), not Combwork's 2000: the same boundary over a tenth of the file work, which
  // at 2000 passed even a 180 s bound under a loaded full run (#356, HI-2423, HI-2453). The test hashes the source only
  // once itself: the next launch's revision is its copy's own hash, so its equal to the first, the source's, says the
  // copy is the source.
  const full = LIMITS.entries
  it('Codex: exactly the limit is delivered, marker and all, and stays delivered on the next launch', async () => {
    const root = join(base, 'limit-codex')
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })
    const s = sized(root, 'full', full)
    const first = await launchCodex(cwd, [{ name: 'full', sourcePath: s }])
    const copy = join(cwd, '.agents', 'skills', 'cw-full')
    expect(existsSync(join(copy, '.hive-copy'))).toBe(true)
    expect(first.full).toEqual({ revision: await contentHash(s) })
    expect(await launchCodex(cwd, [{ name: 'full', sourcePath: s }])).toEqual(first)
  })

  it('Codex: one more than the limit is too big, first delivery (none) and update (the old copy kept), with a later skill delivered', async () => {
    const root = join(base, 'over-codex')
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })
    const ok = source(root, 'ok')
    const big = sized(root, 'big', full + 1)
    const first = await launchCodex(cwd, [{ name: 'big', sourcePath: big }, { name: 'ok', sourcePath: ok }])
    expect(first.big).toEqual({ revision: null, problem: reason.entries, lasting: true })
    expect(existsSync(join(cwd, '.agents', 'skills', 'cw-big'))).toBe(false)
    expect(first.ok).toEqual({ revision: await contentHash(ok) })

    const grows = source(root, 'grows')
    await launchCodex(cwd, [{ name: 'grows', sourcePath: grows }])
    const copy = join(cwd, '.agents', 'skills', 'cw-grows')
    const old = await contentHash(copy)
    for (let i = 0; i < full - 4; i++) writeFileSync(join(grows, 'refs', `r${i}.md`), '')
    const update = await launchCodex(cwd, [{ name: 'grows', sourcePath: grows }])
    expect(update.grows).toEqual({ revision: old, problem: `${reason.entries}, so it kept its old copy`, lasting: true })
    expect(await contentHash(copy)).toBe(old)
  })

  it('Claude Code: exactly the limit is delivered; one more is not, and says why', async () => {
    const root = join(base, 'limit-claude')
    const project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    const atLimit = sized(root, 'full', full)
    const big = sized(root, 'big', full + 1)
    const out = await launchClaude(project, [{ name: 'full', sourcePath: atLimit }, { name: 'big', sourcePath: big }])
    const skills = join(project, '.combwork', 'launch-a1', 'plugin', 'skills')
    expect(out.full).toEqual({ revision: await contentHash(atLimit) })
    expect(out.big).toEqual({ revision: null, problem: reason.entries, lasting: true })
    expect(existsSync(join(skills, 'big'))).toBe(false)
  })
})
