// What a workspace's revision inventory keeps (src/main/revisions.ts RETENTION): at the largest supported catalog (the
// skills folder's 1000 entries, plus modes), unchanged scans, one at a time or ten at once, read no file contents and
// no headers; past the retention limits the least recently used entries go one at a time, never the whole inventory.
// MEASURE=1 prints files, bytes, header bytes and time per scan (docs/ARCHITECTURE.md records them).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-retention-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
afterAll(() => rmSync(base, { recursive: true, force: true }))

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { syncBundled } = await import('../src/main/bundled')
const { skillRevisions } = await import('../src/main/guidance')
const { RETENTION, revisionOf } = await import('../src/main/revisions')
const { readStats } = await import('../src/main/fsutil')
type WS = ReturnType<typeof createWorkspaceService>

/**
 * A workspace with Combwork's skills and modes, then skills up to `entries` in the skills folder (s0, s1…: `added` of
 * them, however many Combwork ships), and `modes` more.
 */
async function workspace(name: string, entries: number, modes: number, body = 'Step.\n'): Promise<{ w: WS; ws: string; modePaths: string[]; added: number }> {
  const ws = join(base, name)
  mkdirSync(ws, { recursive: true })
  const w = createWorkspaceService()
  await w.open(ws)
  await inWorkspace(w, () => syncBundled({ fresh: true }))
  const skills = join(ws, '.combwork', 'skills')
  const have = (await import('fs')).readdirSync(skills).length
  for (let i = 0; i < entries - have; i++) {
    mkdirSync(join(skills, `s${i}`))
    writeFileSync(join(skills, `s${i}`, 'SKILL.md'), `---\nname: s${i}\ndescription: Skill ${i}.\n---\n\n${body}`)
  }
  const dir = join(ws, '.combwork', 'modes')
  for (let i = 0; i < modes; i++) writeFileSync(join(dir, `p${i}.md`), `---\nname: P${i}\n---\n\nA mode.\n`)
  const modePaths = (await import('fs')).readdirSync(dir).map((f) => join(dir, f))
  return { w, ws, modePaths, added: entries - have }
}

/** One scan as Combwork does it: every skill's header and revision (the status), and every mode's revision. */
const scan = (w: WS, modes: string[]) => inWorkspace(w, async () => {
  await skillRevisions()
  for (const p of modes) await revisionOf(p)
})

async function measure(label: string, fn: () => Promise<unknown>): Promise<{ files: number; bytes: number; metaBytes: number; ms: number }> {
  const before = { ...readStats }
  const t = performance.now()
  await fn()
  const r = { files: readStats.files - before.files, bytes: readStats.bytes - before.bytes, metaBytes: readStats.metaBytes - before.metaBytes, ms: performance.now() - t }
  if (process.env.MEASURE) console.log(`${label}: hashed ${r.files} files, ${(r.bytes / 1024).toFixed(0)} KB; headers ${(r.metaBytes / 1024).toFixed(0)} KB; ${r.ms.toFixed(0)} ms`)
  return r
}
const nothing = (m: { files: number; bytes: number; metaBytes: number }) => ({ files: m.files, bytes: m.bytes, metaBytes: m.metaBytes })

describe('the largest supported catalog', () => {
  for (const entries of [999, 1000]) {
    it(`${entries} skill folders and 14 modes: warm scans read nothing, one at a time or ten at once`, async () => {
      const { w, modePaths } = await workspace(`full-${entries}`, entries, 10)
      const cold = await measure(`${entries} skills, cold`, () => scan(w, modePaths))
      expect(cold.files).toBeGreaterThanOrEqual(entries)
      expect(nothing(await measure(`${entries} skills, warm`, () => scan(w, modePaths)))).toEqual({ files: 0, bytes: 0, metaBytes: 0 })
      // Ten at once are two scans in turn (coalesced: the first, then one shared by the rest), each after a warm one (#1394).
      expect(nothing(await measure(`${entries} skills, 10 at once`, () => Promise.all(Array.from({ length: 10 }, () => scan(w, modePaths)))))).toEqual({ files: 0, bytes: 0, metaBytes: 0 })
      await disposeWorkspaceService(w)
    }, 180_000)
  }

  it('with larger bodies (64 KB each, 300 skills): warm scans still read nothing', async () => {
    const { w, modePaths, added } = await workspace('bodies', 300, 0, 'Words. '.repeat(64 * 1024 / 7))
    const cold = await measure('300 skills of 64 KB, cold', () => scan(w, modePaths))
    // Every big one read (64 KB less a few bytes each), besides Combwork's own.
    expect(cold.bytes).toBeGreaterThan(added * 65_000)
    expect(nothing(await measure('300 skills of 64 KB, warm', () => scan(w, modePaths)))).toEqual({ files: 0, bytes: 0, metaBytes: 0 })
    await disposeWorkspaceService(w)
  }, 180_000)
})

describe('past the retention limits', () => {
  it('the least recently used go one at a time: the most recent stay, so the whole inventory is never cleared', async () => {
    // 60 skills of its own (s0–s59), whatever Combwork ships.
    const { w, ws } = await workspace('overflow', 60 + readdirSync(join(__dirname, '..', 'resources', 'skills')).length, 0)
    const saved = { ...RETENTION }
    RETENTION.revisions = 50
    try {
      const paths = Array.from({ length: 60 }, (_, i) => join(ws, '.combwork', 'skills', `s${i}`))
      const hash = (ps: string[]) => measure('', () => inWorkspace(w, async () => { for (const p of ps) await revisionOf(p) }))
      await hash(paths)
      // The 50 most recent are still kept: nothing read.
      expect((await hash(paths.slice(10))).files).toBe(0)
      // The 10 oldest went (one each): read again, one file each.
      expect((await hash(paths.slice(0, 10))).files).toBe(10)
      // Which pushed out the 10 least recently used of the rest, not everything: the newest 40 are still kept.
      expect((await hash(paths.slice(20))).files).toBe(0)
    } finally {
      Object.assign(RETENTION, saved)
      await disposeWorkspaceService(w)
    }
  }, 60_000)

  it('headers past their byte budget: the oldest go first, the most recent stay', async () => {
    const { w, ws } = await workspace('header-bytes', 40, 0)
    const { headerOf } = await import('../src/main/revisions')
    const { parseSkillFrontmatter } = await import('../src/main/skills')
    const saved = { ...RETENTION }
    try {
      // Room for about 10 of these headers.
      RETENTION.headerBytes = 10 * 120
      const files = Array.from({ length: 30 }, (_, i) => join(ws, '.combwork', 'skills', `s${i}`, 'SKILL.md'))
      const read = (fs: string[]) => measure('', () => inWorkspace(w, async () => { for (const f of fs) await headerOf(f, parseSkillFrontmatter) }))
      await read(files)
      // The most recent few are still kept; the oldest were dropped one by one to make room, and are read again.
      expect((await read(files.slice(-5))).metaBytes).toBe(0)
      expect((await read(files.slice(0, 5))).metaBytes).toBeGreaterThan(0)
    } finally {
      Object.assign(RETENTION, saved)
      await disposeWorkspaceService(w)
    }
  }, 60_000)
})
