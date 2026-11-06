// Skill revisions (the Agent API's status, the Skills view, each session's settings) without reading every skill again
// on each poll (src/main/revisions.ts): kept per workspace while their files are unchanged, hashed again when one
// changes, shared between callers asking at once, gone when the workspace closes. Hashing and the API's skill reads
// are bounded by what they actually read. MEASURE=1 prints files and bytes read and time per poll for a small and a
// large catalog (docs/ARCHITECTURE.md has the numbers).
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-revisions-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { syncBundled } = await import('../src/main/bundled')
const { skillRevisions } = await import('../src/main/guidance')
const { coalesced, revisionOf } = await import('../src/main/revisions')
const { ContentTooLarge, contentHash, HASH_LIMITS, readDirBounded, readStats, readCapped } = await import('../src/main/fsutil')
const { skillFiles } = await import('../src/main/skills')
type WS = ReturnType<typeof createWorkspaceService>
// base is removed when the file ends by tests/tempCleanup.ts, which retries and reports a folder still held rather than
// failing the file (HI-2453: an rmSync here, without retries, failed it with EPERM after two tests had timed out).

/**
 * fn with HASH_LIMITS' byte limit lowered to 1 MB (HI-2453), as `toobig-bundled` does (#666): the same refusal over a file
 * just past it, rather than writing 65 MB into the scanned temp folder for each such test.
 */
const SMALL_BYTES = 1024 * 1024
async function smallBytes<T>(fn: () => Promise<T>): Promise<T> {
  const limits = { ...HASH_LIMITS }
  Object.assign(HASH_LIMITS, { bytes: SMALL_BYTES })
  try {
    return await fn()
  } finally {
    Object.assign(HASH_LIMITS, limits)
  }
}
const OVER = SMALL_BYTES + 1024

function addSkill(ws: string, name: string, body = 'Step.\n'.repeat(200)): string {
  const d = join(ws, '.combwork', 'skills', name)
  mkdirSync(join(d, 'refs'), { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: Skill ${name}\n---\n\n${body}`)
  writeFileSync(join(d, 'refs', 'notes.md'), 'x'.repeat(8000))
  return d
}

async function open(path: string, extra = 0, bigFile = 0): Promise<WS> {
  mkdirSync(path, { recursive: true })
  const w = createWorkspaceService()
  await w.open(path)
  await inWorkspace(w, () => syncBundled({ fresh: true }))
  for (let i = 0; i < extra; i++) addSkill(path, `extra-${i}`)
  if (bigFile) writeFileSync(join(path, '.combwork', 'skills', 'extra-0', 'refs', 'big.bin'), Buffer.alloc(bigFile, 1))
  return w
}

type Reads = { files: number; bytes: number; entries: number; metaBytes: number }

/** What fn read: files and bytes hashed, directory entries listed, bytes of SKILL.md headers. */
async function reads<T>(fn: () => Promise<T>): Promise<Reads & { value: T }> {
  const before = { ...readStats }
  const value = await fn()
  return { files: readStats.files - before.files, bytes: readStats.bytes - before.bytes, entries: readStats.entries - before.entries, metaBytes: readStats.metaBytes - before.metaBytes, value }
}

async function measure(label: string, w: WS, polls: number, concurrent: number): Promise<Reads & { ms: number }> {
  const t = performance.now()
  const r = await reads(async () => {
    for (let i = 0; i < polls; i++) await Promise.all(Array.from({ length: concurrent }, () => inWorkspace(w, () => skillRevisions())))
  })
  const m = { files: r.files / polls, bytes: r.bytes / polls, entries: r.entries / polls, metaBytes: r.metaBytes / polls, ms: (performance.now() - t) / polls }
  if (process.env.MEASURE) console.log(`${label}: hashed ${m.files} files, ${(m.bytes / 1024).toFixed(0)} KB; headers ${(m.metaBytes / 1024).toFixed(0)} KB; ${m.entries} directory entries; ${m.ms.toFixed(1)} ms per poll`)
  return m
}

describe('status polls', () => {
  it('read each skill once: unchanged polls, one at a time or ten at once, read no file contents (small and large catalogs)', async () => {
    // The large catalog at full size (100 more skills, a 20 MB file, a 14 MB SKILL.md) when measuring for
    // docs/ARCHITECTURE.md; smaller in ordinary runs, which check the same reads in well under a second (#215).
    const L = process.env.MEASURE ? { skills: 100, file: 20 * 1024 * 1024, lines: 2 * 1024 * 1024 } : { skills: 10, file: 1024 * 1024, lines: 16 * 1024 }
    const small = await open(join(base, 'small'))
    const large = await open(join(base, 'large'), L.skills, L.file)
    // One skill whose SKILL.md itself is far over the 64 KB a header read takes.
    const longBody = 'Words.\n'.repeat(L.lines)
    addSkill(join(base, 'large'), 'long-body', longBody)
    const skills = readdirSync(join(base, 'large', '.combwork', 'skills')).filter((d) => !d.startsWith('.')).length
    const none = (m: Reads) => ({ files: m.files, bytes: m.bytes, metaBytes: m.metaBytes })
    const first = await measure('small, first', small, 1, 1)
    expect(first.files).toBeGreaterThan(0)
    expect(none(await measure('small, sequential', small, 10, 1))).toEqual({ files: 0, bytes: 0, metaBytes: 0 })
    expect(none(await measure('small, 10 concurrent', small, 5, 10))).toEqual({ files: 0, bytes: 0, metaBytes: 0 })
    const big = await measure('large, first', large, 1, 1)
    // Hashed whole, the big file and the long SKILL.md included…
    expect(big.bytes).toBeGreaterThan(L.file + longBody.length)
    // …but headers: no more than 64 KB a skill, however long the SKILL.md.
    expect(big.metaBytes).toBeLessThanOrEqual(skills * 64 * 1024)
    const again = await measure('large, sequential', large, 5, 1)
    expect(none(again)).toEqual({ files: 0, bytes: 0, metaBytes: 0 })
    // What an unchanged poll still does: list the skills' folders (and stat their files).
    expect(again.entries).toBeGreaterThan(0)
    expect(none(await measure('large, 10 concurrent', large, 3, 10))).toEqual({ files: 0, bytes: 0, metaBytes: 0 })
    await disposeWorkspaceService(small)
    await disposeWorkspaceService(large)
  }, 120_000)

  it("listing a workspace's skills (as the skill API does before reading one) reads only their headers", async () => {
    const ws = join(base, 'headers')
    const w = await open(ws)
    addSkill(ws, 'long-body', 'Words.\n'.repeat(2 * 1024 * 1024))
    const { combworkSkills } = await import('../src/main/skills')
    const r = await reads(() => inWorkspace(w, () => combworkSkills()))
    expect(r.value.find((s) => s.name === 'long-body')?.description).toBe('Skill long-body')
    // The 12 MB skill isn't bundled, so nothing of it is hashed, and only 64 KB of its SKILL.md is read.
    expect(r.metaBytes).toBeLessThan(r.value.length * 64 * 1024 + 1)
    const again = await reads(() => inWorkspace(w, () => combworkSkills()))
    expect(again.metaBytes).toBe(0)
    // An edit is read again.
    appendFileSync(join(ws, '.combwork', 'skills', 'long-body', 'SKILL.md'), 'more')
    const edited = await reads(() => inWorkspace(w, () => combworkSkills()))
    expect(edited.metaBytes).toBe(64 * 1024)
    await disposeWorkspaceService(w)
  })

  // Real file work, not a wait (#596): three workspaces opened with Combwork's bundled skills, two with 20 more, and polled:
  // about 8,000 file system calls through Node's four I/O threads. Measured: 1 s alone, 2 to 5 s under a full unit run
  // beside other runs, over 20 s under heavier load. So it is bounded by FS_HUNG_MS rather than the suite's 20 s: only a
  // hung read takes a minute.
  const FS_HUNG_MS = 60_000
  it('ten polls at once on a cold workspace read what one poll does', { timeout: FS_HUNG_MS }, async () => {
    // Combwork's shipped skills have one inventory for the whole process (revisions.ts), hashed by its first poll, whichever
    // test makes it: polled here first, so the polls compared below read only their own workspaces' skills.
    const warm = await open(join(base, 'cold-warm'))
    await inWorkspace(warm, () => skillRevisions())
    await disposeWorkspaceService(warm)
    const one = await open(join(base, 'cold-1'), 20)
    const ten = await open(join(base, 'cold-10'), 20)
    const single = await reads(() => inWorkspace(one, () => skillRevisions()))
    const r = await reads(() => Promise.all(Array.from({ length: 10 }, () => inWorkspace(ten, () => skillRevisions()))))
    expect(single.files).toBeGreaterThan(20)
    expect(r.files).toBe(single.files)
    expect(r.bytes).toBe(single.bytes)
    for (const v of r.value) expect(v).toEqual(single.value)
    await disposeWorkspaceService(one)
    await disposeWorkspaceService(ten)
  })
})

describe('changes', () => {
  let w: WS
  const ws = join(base, 'changes')
  const rev = async (name: string): Promise<string | undefined> => (await inWorkspace(w, () => skillRevisions())).find((s) => s.name === name)?.revision

  it('an edit, even keeping the size and time, a new file, a removed one and a deleted skill all show on the next poll', async () => {
    w = await open(ws)
    const d = addSkill(ws, 'mine', 'aaaa\n')
    const r0 = await rev('mine')
    expect(await rev('mine')).toBe(r0)

    // Same size, and the old modified time put back: the change time and file id still differ.
    const f = join(d, 'SKILL.md')
    const t = new Date(Date.now() - 60_000)
    utimesSync(f, t, t)
    const r1 = await rev('mine')
    writeFileSync(f, `---\nname: mine\ndescription: Skill mine\n---\n\nbbbb\n`)
    utimesSync(f, t, t)
    const r2 = await rev('mine')
    expect(r2).not.toBe(r1)
    expect(r2).toBe(await inWorkspace(w, () => contentHash(d)))

    writeFileSync(join(d, 'refs', 'more.md'), 'more')
    const r3 = await rev('mine')
    expect(r3).not.toBe(r2)
    unlinkSync(join(d, 'refs', 'more.md'))
    expect(await rev('mine')).toBe(r2)

    rmSync(d, { recursive: true, force: true })
    expect(await rev('mine')).toBeUndefined()
  })

  it("a bundled skill's edit and its restore show as changed and then the same", async () => {
    const name = (await inWorkspace(w, () => skillRevisions())).find((s) => s.bundled)!.name
    const status = async () => (await inWorkspace(w, () => skillRevisions())).find((s) => s.name === name)!.bundled
    expect(await status()).toBe('same')
    const f = join(ws, '.combwork', 'skills', name, 'SKILL.md')
    appendFileSync(f, '\nMine.\n')
    expect(await status()).toBe('changed')
    const { restoreBundled } = await import('../src/main/bundled')
    await inWorkspace(w, () => restoreBundled('skills', name))
    expect(await status()).toBe('same')
    await disposeWorkspaceService(w)
  })
})

describe('workspaces', () => {
  it('each has its own revisions, and a closed one keeps none', async () => {
    const a = await open(join(base, 'iso-a'), 3)
    const b = await open(join(base, 'iso-b'), 3)
    expect((await reads(() => inWorkspace(a, () => skillRevisions()))).files).toBeGreaterThan(0)
    // b's skills are the same text in other files: b reads its own.
    const rb = await reads(() => inWorkspace(b, () => skillRevisions()))
    expect(rb.files).toBeGreaterThan(0)
    expect((await reads(() => inWorkspace(a, () => skillRevisions()))).files).toBe(0)

    // Reopened, a reads its skills again rather than trusting what was kept.
    await a.open(join(base, 'iso-a'))
    expect((await reads(() => inWorkspace(a, () => skillRevisions()))).files).toBeGreaterThan(0)
    await disposeWorkspaceService(a)
    await disposeWorkspaceService(b)
  })

  it('hashing for a workspace stops when it closes', async () => {
    const ws = join(base, 'closing')
    const w = await open(ws, 1, 60 * 1024 * 1024)
    const hashing = inWorkspace(w, () => revisionOf(join(ws, '.combwork', 'skills', 'extra-0')))
    await w.close()
    await expect(hashing).rejects.toThrow('The workspace was closed')
    await disposeWorkspaceService(w)
  })
})

describe('sharing a scan', () => {
  it('a caller during a run waits for the next run, shared with everyone who asked meanwhile', async () => {
    let runs = 0
    const gates: (() => void)[] = []
    const scan = coalesced(async () => {
      const n = ++runs
      await new Promise<void>((r) => gates.push(r))
      return n
    })
    const a = scan()
    const b = scan()
    const c = scan()
    expect(runs).toBe(1)
    gates.shift()!()
    expect(await a).toBe(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(runs).toBe(2)
    gates.shift()!()
    expect([await b, await c]).toEqual([2, 2])
    expect(runs).toBe(2)
  })
})

describe('limits', () => {
  const dir = join(base, 'limits')

  it('stops on bytes actually read, on entries and on depth, with ContentTooLarge', async () => {
    mkdirSync(join(dir, 'bytes'), { recursive: true })
    writeFileSync(join(dir, 'bytes', 'a'), Buffer.alloc(300 * 1024, 1))
    await expect(contentHash(join(dir, 'bytes'), { limits: { bytes: 256 * 1024 } })).rejects.toBeInstanceOf(ContentTooLarge)
    const before = readStats.bytes
    await contentHash(join(dir, 'bytes'), { limits: { bytes: 256 * 1024 } }).catch(() => undefined)
    // Read in chunks: it stopped within one chunk of the limit, not after the whole file.
    expect(readStats.bytes - before).toBeLessThanOrEqual(256 * 1024 + 64 * 1024)

    mkdirSync(join(dir, 'many'))
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, 'many', `f${i}`), '')
    await expect(contentHash(join(dir, 'many'), { limits: { entries: 20 } })).rejects.toBeInstanceOf(ContentTooLarge)
    expect(await contentHash(join(dir, 'many'), { limits: { entries: 30 } })).toMatch(/^[0-9a-f]{16}$/)

    mkdirSync(join(dir, 'deep', 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(dir, 'deep', 'a', 'b', 'c', 'f'), '')
    await expect(contentHash(join(dir, 'deep'), { limits: { depth: 3 } })).rejects.toBeInstanceOf(ContentTooLarge)
    expect(await contentHash(join(dir, 'deep'), { limits: { depth: 4 } })).toMatch(/^[0-9a-f]{16}$/)
  })

  it('reads in chunks without changing the hash: CRLF split between chunks is one line ending', async () => {
    mkdirSync(join(dir, 'crlf'))
    const lf = 'a'.repeat(64 * 1024 - 1) + '\n' + 'b\n'.repeat(1000)
    writeFileSync(join(dir, 'crlf', 'lf.md'), lf)
    writeFileSync(join(dir, 'crlf', 'crlf.md'), lf.replace(/\n/g, '\r\n'))
    // A lone CR at a chunk's end stays a CR.
    writeFileSync(join(dir, 'crlf', 'cr.md'), 'a'.repeat(64 * 1024 - 1) + '\rb')
    writeFileSync(join(dir, 'crlf', 'cr2.md'), 'a'.repeat(64 * 1024 - 1) + '\nb')
    expect(await contentHash(join(dir, 'crlf', 'crlf.md'))).toBe(await contentHash(join(dir, 'crlf', 'lf.md')))
    expect(await contentHash(join(dir, 'crlf', 'cr.md'))).not.toBe(await contentHash(join(dir, 'crlf', 'cr2.md')))
  })

  it('an unchanged too-big skill is never read: cold, warm, ten at once; a change is seen at once', () => smallBytes(async () => {
    const ws = join(base, 'toobig-warm')
    const w = await open(ws)
    const poll = () => inWorkspace(w, () => skillRevisions())
    await poll()
    const d = addSkill(ws, 'huge')
    const big = join(d, 'refs', 'big.bin')
    writeFileSync(big, Buffer.alloc(OVER, 1))
    const problem = 'too big to check: it is over 1 MB'
    const huge = (v: Awaited<ReturnType<typeof poll>>) => v.find((s) => s.name === 'huge')!
    // Its files' sizes say so: refused before reading, even the first time.
    const cold = await reads(poll)
    expect([huge(cold.value).revision, huge(cold.value).problem]).toEqual(['', problem])
    expect(cold.bytes).toBe(0)
    for (let i = 0; i < 3; i++) {
      const warm = await reads(poll)
      expect([warm.bytes, warm.files, huge(warm.value).problem]).toEqual([0, 0, problem])
    }
    const many = await reads(() => Promise.all(Array.from({ length: 10 }, poll)))
    expect(many.bytes).toBe(0)
    for (const v of many.value) expect(huge(v).problem).toBe(problem)
    if (process.env.MEASURE) console.log(`too big, warm: ${cold.bytes} bytes cold, ${many.bytes} for ten at once`)

    // Shrunk: a revision at once, and then kept.
    writeFileSync(big, Buffer.alloc(1024, 1))
    const shrunk = await reads(poll)
    expect(huge(shrunk.value).revision).toBe(await contentHash(d))
    expect(huge(shrunk.value).problem).toBeUndefined()
    expect((await reads(poll)).bytes).toBe(0)
    // Grown again, then removed.
    writeFileSync(big, Buffer.alloc(OVER, 1))
    expect(huge((await poll())).problem).toBe(problem)
    rmSync(d, { recursive: true, force: true })
    expect((await poll()).some((s) => s.name === 'huge')).toBe(false)
    await disposeWorkspaceService(w)
  }))

  it('too many files: each poll is a bounded walk with no file read; closing the workspace forgets what was kept', async () => {
    const ws = join(base, 'toomany')
    const w = await open(ws)
    // The limits lowered for this test (2000 entries, 64 MB): the same walk and the same kept outcome over a tenth of
    // the files and a small file, rather than writing 2500 files and 65 MB on every run (#215).
    const limits = { ...HASH_LIMITS }
    Object.assign(HASH_LIMITS, { entries: 200, bytes: 1024 * 1024 })
    try {
      const d = addSkill(ws, 'many')
      for (let i = 0; i < 250; i++) writeFileSync(join(d, 'refs', `f${i}.md`), 'x')
      const path = join(ws, '.combwork', 'skills', 'many')
      for (let i = 0; i < 2; i++) {
        const r = await reads(() => inWorkspace(w, () => revisionOf(path).catch((e) => e)))
        expect(r.value).toBeInstanceOf(ContentTooLarge)
        expect([r.files, r.bytes]).toEqual([0, 0])
        expect(r.entries).toBeLessThanOrEqual(HASH_LIMITS.entries + 2)
      }

      // A too-big skill kept in one opening of the workspace is checked again in the next (by its sizes: still no read).
      const d2 = addSkill(ws, 'huge')
      writeFileSync(join(d2, 'refs', 'big.bin'), Buffer.alloc(HASH_LIMITS.bytes + 1024, 1))
      const hugePath = join(ws, '.combwork', 'skills', 'huge')
      expect(await inWorkspace(w, () => revisionOf(hugePath).catch((e) => e))).toBeInstanceOf(ContentTooLarge)
      await w.open(ws)
      rmSync(join(d2, 'refs', 'big.bin'))
      expect(await inWorkspace(w, () => revisionOf(hugePath))).toBe(await contentHash(d2))
    } finally {
      Object.assign(HASH_LIMITS, limits)
      await disposeWorkspaceService(w)
    }
  })

  it("a bundled skill made too big is the user's edit: shown as changed, and kept when the workspace opens again", async () => {
    const ws = join(base, 'toobig-bundled')
    const w = await open(ws)
    // The byte limit lowered for this test (1 MB): the same outcome over a file just above it, rather than writing 65 MB
    // into the scanned temp folder and reading up to 64 MB of it at each check, which took over 20 s under load (#666).
    const limits = { ...HASH_LIMITS }
    Object.assign(HASH_LIMITS, { bytes: 1024 * 1024 })
    try {
      const big = join(ws, '.combwork', 'skills', 'pick-up', 'big.bin')
      writeFileSync(big, Buffer.alloc(HASH_LIMITS.bytes + 1024, 1))
      const pick = (await inWorkspace(w, () => skillRevisions())).find((s) => s.name === 'pick-up')!
      expect([pick.bundled, pick.problem]).toEqual(['changed', 'too big to check: it is over 1 MB'])
      await w.open(ws)
      await inWorkspace(w, () => syncBundled())
      expect(existsSync(big)).toBe(true)
    } finally {
      Object.assign(HASH_LIMITS, limits)
      await disposeWorkspaceService(w)
    }
  })

  it("an over-limit skill shows why it has no revision; a link isn't followed", () => smallBytes(async () => {
    const ws = join(base, 'toobig')
    const w = await open(ws)
    const d = addSkill(ws, 'huge')
    writeFileSync(join(d, 'refs', 'big.bin'), Buffer.alloc(OVER, 1))
    const huge = (await inWorkspace(w, () => skillRevisions())).find((s) => s.name === 'huge')!
    expect(huge.revision).toBe('')
    expect(huge.problem).toMatch(/too big to check: it is over 1 MB/)
    rmSync(join(d, 'refs', 'big.bin'))
    try {
      symlinkSync(join(base, 'small'), join(d, 'refs', 'elsewhere'), 'junction')
      const r = await reads(() => inWorkspace(w, () => skillRevisions()))
      expect(r.value.find((s) => s.name === 'huge')!.revision).toMatch(/^[0-9a-f]{16}$/)
      // Only the skill's own two files: nothing behind the link.
      expect(r.files).toBe(2)
    } finally {
      await disposeWorkspaceService(w)
    }
  }))

  it("a launch says a skill over the limits isn't delivered, and delivers the others", () => smallBytes(async () => {
    const src = join(dir, 'launch')
    const big = join(src, 'big')
    const ok = join(src, 'ok')
    mkdirSync(big, { recursive: true })
    mkdirSync(ok, { recursive: true })
    writeFileSync(join(big, 'SKILL.md'), '---\nname: big\n---\n')
    writeFileSync(join(big, 'data.bin'), Buffer.alloc(OVER, 1))
    writeFileSync(join(ok, 'SKILL.md'), '---\nname: ok\n---\n')
    const { syncAgentsSkills } = await import('../src/main/providers/common')
    const out: Record<string, unknown> = await syncAgentsSkills({ cwd: join(dir, 'launch-cwd'), skills: [{ name: 'big', sourcePath: big }, { name: 'ok', sourcePath: ok }] } as never, 'Codex')
    expect(out.big).toEqual({ revision: null, problem: 'it is too big for Combwork to check (it is over 1 MB)', lasting: true })
    expect(out.ok).toEqual({ revision: await contentHash(ok) })

    // A skill Codex had a copy of, grown too big: the old copy stays, and is what's reported as delivered.
    writeFileSync(join(ok, 'data.bin'), Buffer.alloc(OVER, 1))
    const kept = join(dir, 'launch-cwd', '.agents', 'skills', 'cw-ok')
    const again: Record<string, unknown> = await syncAgentsSkills({ cwd: join(dir, 'launch-cwd'), skills: [{ name: 'ok', sourcePath: ok }] } as never, 'Codex')
    expect(again.ok).toEqual({ revision: await contentHash(kept), problem: 'it is too big for Combwork to check (it is over 1 MB), so it kept its old copy', lasting: true })
    rmSync(join(ok, 'data.bin'))
  }))

  it("Claude Code: a skill over the limits isn't copied into the launch, checked before anything is copied", () => smallBytes(async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const src = join(dir, 'claude-src')
    const deep = join(src, 'deep')
    mkdirSync(join(deep, ...'abcdefghijklm'.split('')), { recursive: true })
    writeFileSync(join(deep, 'SKILL.md'), '---\nname: deep\n---\n')
    const big = join(src, 'big')
    mkdirSync(big, { recursive: true })
    writeFileSync(join(big, 'SKILL.md'), '---\nname: big\n---\n')
    writeFileSync(join(big, 'data.bin'), Buffer.alloc(OVER, 1))
    const ok = join(src, 'ok')
    mkdirSync(ok, { recursive: true })
    writeFileSync(join(ok, 'SKILL.md'), '---\nname: ok\n---\n')
    const project = join(dir, 'claude-project')
    mkdirSync(project, { recursive: true })
    const before = readStats.bytes
    const delivered = await claudeCode.prepareLaunch({ projectPath: project, agentId: 'a1', cwd: project, skills: [{ name: 'deep', sourcePath: deep }, { name: 'big', sourcePath: big }, { name: 'ok', sourcePath: ok }], mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, extraArgs: [], hookAuthFile: 'C:/profile/hook-auth/x.txt', privateDir: `${project}-private` } as never)
    const skills = join(project, '.combwork', 'launch-a1', 'plugin', 'skills')
    expect(delivered.deep).toEqual({ revision: null, problem: 'it is too big for Combwork to check (it has folders more than 12 deep)', lasting: true })
    expect(delivered.big).toEqual({ revision: null, problem: 'it is too big for Combwork to check (it is over 1 MB)', lasting: true })
    expect(delivered.ok).toEqual({ revision: await contentHash(join(skills, 'ok')) })
    expect(existsSync(join(skills, 'deep'))).toBe(false)
    expect(existsSync(join(skills, 'big'))).toBe(false)
    // The big one was read only up to the limit (plus a chunk), once: less than its whole file.
    expect(readStats.bytes - before).toBeLessThan(OVER)
  }))

  it('a huge folder is listed only as far as the limits: entries read, not just entries kept', async () => {
    const huge = join(dir, 'huge')
    mkdirSync(huge, { recursive: true })
    for (let i = 0; i < 5000; i++) writeFileSync(join(huge, `f${i}`), '')
    const listed = await reads(() => readDirBounded(huge, 20))
    expect(listed.value).toMatchObject({ more: true })
    expect(listed.value.entries).toHaveLength(20)
    expect(listed.entries).toBe(21)
    const hashed = await reads(() => contentHash(huge, { limits: { entries: 100 } }).catch((e) => e))
    expect(hashed.value).toBeInstanceOf(ContentTooLarge)
    expect(hashed.entries).toBe(102)
    expect(hashed.files).toBe(0)
    const files = await reads(() => skillFiles(huge, { files: 10, entries: 50, depth: 8 }))
    expect(files.value.truncated).toBe(true)
    expect(files.value.files).toHaveLength(10)
    expect(files.entries).toBe(51)
    // Unbounded, it is all of them.
    expect((await reads(() => readDirBounded(huge, 10_000))).entries).toBe(5000)
  })

  it('readCapped reads no more than asked, whatever the file has grown to', async () => {
    writeFileSync(join(dir, 'grow'), Buffer.alloc(1000, 2))
    expect(await readCapped(join(dir, 'grow'), 1000)).toMatchObject({ more: false })
    appendFileSync(join(dir, 'grow'), 'more')
    const r = await readCapped(join(dir, 'grow'), 1000)
    expect(r).toMatchObject({ more: true })
    expect(r.data.length).toBe(1000)
  })

  it("skillFiles lists a folder's files in order, and says when it stopped short", async () => {
    const s = join(dir, 'skill')
    mkdirSync(join(s, 'a', 'b', 'c'), { recursive: true })
    for (const f of ['SKILL.md', 'z.md', 'a/1.md', 'a/b/2.md', 'a/b/c/3.md', '.combwork-copy']) writeFileSync(join(s, f), '')
    expect(await skillFiles(s)).toEqual({ files: ['SKILL.md', 'a/1.md', 'a/b/2.md', 'a/b/c/3.md', 'z.md'], truncated: false })
    expect(await skillFiles(s, { files: 2, entries: 100, depth: 8 })).toEqual({ files: ['SKILL.md', 'a/1.md'], truncated: true })
    expect(await skillFiles(s, { files: 100, entries: 100, depth: 2 })).toEqual({ files: ['SKILL.md', 'a/1.md', 'z.md'], truncated: true })
    expect((await skillFiles(s, { files: 100, entries: 3, depth: 8 })).truncated).toBe(true)
  })
})
