// The dialect files Combwork ships (HI-2442, dialects card 8; plans/2026-11-03-dialects-design.md, section 3, decision 8):
// the five model files (Opus 5.5, Haiku 5.5 and Sonnet 5.5 for Claude Code; GPT-6.1 Sol and GPT-6 Astra for Codex),
// each with its real model ID, and the CLI and API files; in Combwork's own format, passing the schema; and synced into a
// workspace by the bundled kind (card 6, HI-2439): a fresh workspace gets them all, an untouched copy follows an update,
// an edited one is kept. A dialect-only release runs this file first (scripts/dialectRelease.mjs) and may change no
// test (HR2, HI-2442 r1), so it checks what any shipped file must be, whatever its texts: a measured override (HI-2282)
// or another model's file passes it unchanged, as long as each override says why.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { agentTextSchema, autoModelFile, checkTexts, dialectFileText, loadDialects, parseDialectFile, type DialectFile } from '../src/main/dialects'
import { contentHash } from '../src/main/fsutil'
import { CLAUDE_MODEL_GROUPS } from '../src/shared/claude'
import { CODEX_MODEL_GROUPS } from '../src/shared/codex'
import HISTORY from '../src/main/bundledHistory.json'
import { tempDir } from './tempDir'

const RES = join(__dirname, '..', 'resources', 'dialects')

/** What Combwork ships at least (decision 8, "those 5 for now"), by id (`<folder>/<label>`): each file's name and, for a model file, its model ID. */
const SHIPPED: Record<string, { name: string; model?: string }> = {
  'api/cli': { name: 'API' },
  'claude-code/cli': { name: 'Claude Code' },
  'claude-code/Haiku 5.5': { name: 'Haiku 5.5', model: 'claude-haiku-5-5' },
  'claude-code/Opus 5.5': { name: 'Opus 5.5', model: 'claude-opus-5-5' },
  'claude-code/Sonnet 5.5': { name: 'Sonnet 5.5', model: 'claude-sonnet-5-5' },
  'codex/cli': { name: 'Codex' },
  'codex/GPT-6 Astra': { name: 'GPT-6 Astra', model: 'gpt-6-astra' },
  'codex/GPT-6.1 Sol': { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol' },
  'copilot/cli': { name: 'GitHub Copilot' }
}

const shippedIds = (): string[] =>
  readdirSync(RES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((d) => readdirSync(join(RES, d.name)).map((f) => `${d.name}/${f.replace(/\.json$/, '')}`))
    .sort()
const read = (id: string): string => readFileSync(join(RES, `${id}.json`), 'utf8').replace(/\r\n/g, '\n')

const parsed = (id: string): DialectFile => {
  const p = parseDialectFile(read(id))
  expect('file' in p, `${id}: a dialect file`).toBe(true)
  return (p as { file: DialectFile }).file
}

describe('the dialect files Combwork ships', () => {
  it('include the five model files, a CLI file for each CLI and the API file, in no other folders', () => {
    const ids = shippedIds()
    for (const id of Object.keys(SHIPPED)) expect(ids, id).toContain(id)
    expect([...new Set(ids.map((id) => id.split('/')[0]))].sort()).toEqual(['api', 'claude-code', 'codex', 'copilot'])
  })

  it('the five carry their name and real model ID', () => {
    for (const [id, want] of Object.entries(SHIPPED)) {
      const f = parsed(id)
      expect({ name: f.name, model: f.model }, id).toEqual({ name: want.name, model: want.model })
    }
  })

  it('each are in the form Combwork writes and pass the schema; a model file names its model, a CLI file none', () => {
    const schema = agentTextSchema()
    for (const id of shippedIds()) {
      const f = parsed(id)
      expect(read(id), `${id}: as dialectFileText writes it`).toBe(dialectFileText(f))
      expect(checkTexts(f, schema).outdated, id).toEqual([])
      // Combwork ships no test copy: a file in a CLI folder other than cli.json is a model file.
      if (id.endsWith('/cli')) expect(f.model, id).toBeUndefined()
      else expect(f.model, id).toMatch(/\S/)
    }
  })

  it('ship an override only with why: a change goes in once measured, on its own card', () => {
    for (const id of shippedIds())
      for (const [text, entry] of Object.entries(parsed(id).texts)) expect(typeof entry.why === 'string' && entry.why.trim() !== '', `${id}: ${text} says why`).toBe(true)
  })

  it("name models the CLI's own pickers offer", () => {
    const ids = (groups: typeof CLAUDE_MODEL_GROUPS) => groups.flatMap((g) => g.models.map((m) => m.value))
    for (const [id, want] of Object.entries(SHIPPED)) {
      if (!want.model) continue
      const offered = id.startsWith('claude-code/') ? ids(CLAUDE_MODEL_GROUPS) : ids(CODEX_MODEL_GROUPS)
      expect(offered, id).toContain(want.model)
    }
  })

  it('load as a dialects folder: each CLI file in place, every model file picked by Auto for its model', async () => {
    const set = await loadDialects(RES, agentTextSchema())
    expect(Object.keys(set.folders).sort()).toEqual(['api', 'claude-code', 'codex', 'copilot'])
    for (const [name, folder] of Object.entries(set.folders)) {
      expect(folder.cli?.path, name).toBe(`${name}/cli.json`)
      for (const f of [folder.cli!, ...folder.files]) expect({ broken: f.broken, claimTaken: f.claimTaken, outdated: f.outdated, on: f.on }, f.path).toEqual({ broken: undefined, claimTaken: undefined, outdated: [], on: true })
    }
    for (const [name, folder] of Object.entries(set.folders)) for (const f of folder.files) expect(autoModelFile(folder.files, f.model!)?.path, `${name}: ${f.path}`).toBe(f.path)
    // The API's slot has no model file under it (decision 12).
    expect(set.folders.api.files).toEqual([])
  })
})

describe('the shipped dialect files in a workspace', () => {
  const base = tempDir('hive-dialects-shipped-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  let mod: typeof import('../src/main/bundled')
  let wsMod: typeof import('../src/main/workspace')
  /** An Opus 5.5 file as an earlier Combwork might have shipped it, recorded in the history before the current one. */
  const OLDER = dialectFileText({ name: 'Opus 5.5', model: 'claude-opus-5-5', texts: { 'older.text': { text: 'Older.', why: 'a test' } } })

  beforeAll(async () => {
    writeFileSync(join(base, 'older.json'), OLDER)
    const h = structuredClone(HISTORY) as Record<string, Record<string, string[]>>
    h.dialects['claude-code/Opus 5.5'] = [await contentHash(join(base, 'older.json')), ...(h.dialects['claude-code/Opus 5.5'] ?? [])]
    vi.resetModules()
    vi.doMock('../src/main/bundledHistory.json', () => ({ default: h }))
    mod = await import('../src/main/bundled')
    wsMod = await import('../src/main/workspace')
  })
  afterAll(() => {
    vi.doUnmock('../src/main/bundledHistory.json')
    rmSync(base, { recursive: true, force: true })
  })

  it('reach a fresh workspace; an untouched older copy follows the update, an edited one is kept', async () => {
    const ws = join(base, 'ws')
    mkdirSync(ws, { recursive: true })
    const w = wsMod.createWorkspaceService()
    await w.open(ws)
    try {
      await wsMod.inWorkspace(w, () => mod.syncBundled({ fresh: true }))
      const dir = join(ws, '.combwork', 'dialects')
      for (const id of Object.keys(SHIPPED)) expect(readFileSync(join(dir, `${id}.json`), 'utf8').replace(/\r\n/g, '\n'), id).toBe(read(id))
      expect(existsSync(join(dir, 'workspace.json')), "workspace.json is the user's: Combwork never ships into it").toBe(false)

      const opus = join(dir, 'claude-code', 'Opus 5.5.json')
      writeFileSync(opus, OLDER)
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(readFileSync(opus, 'utf8').replace(/\r\n/g, '\n')).toBe(read('claude-code/Opus 5.5'))

      const sol = join(dir, 'codex', 'GPT-6.1 Sol.json')
      const edited = dialectFileText({ name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', texts: { 'mine.text': { text: 'Mine.', why: 'my own' } } })
      writeFileSync(sol, edited)
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(readFileSync(sol, 'utf8')).toBe(edited)
      expect(await wsMod.inWorkspace(w, () => mod.bundledStatus('dialects', 'codex/GPT-6.1 Sol', sol))).toEqual({ bundled: 'changed' })
    } finally {
      await wsMod.disposeWorkspaceService(w)
    }
  })
})
