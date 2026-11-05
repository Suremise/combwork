// The dialects service (HI-2439, dialects card 6; plans/2026-11-03-dialects-design.md, sections 3 and 5): the file
// format and its one check (the schema's), the chain (Model file → CLI → Workspace → Default, and API → Workspace →
// Default with no session), model ID matching (exact, then the base ID; aliases through models.ts; "model unknown"),
// one file per model in a CLI folder (save refused, import as a test copy, Promote), outdated overrides falling
// through, a session's resolved texts in a CW_DIALECT_FILE, and the bundled sync of dialect files.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { agentMsg, inDialectOf, say, setChainResolver } from '../src/shared/agentText'
import { chainFromFile } from '../src/shared/agentText/processDialect'
import { baseModelId, dialectModelId } from '../src/shared/models'
import { contentHash } from '../src/main/fsutil'
import {
  agentTextSchema,
  checkTexts,
  dialectFileText,
  duplicateDialect,
  importDialect,
  loadDialects,
  modelSlot,
  parseDialectFile,
  placeOf,
  promoteDialect,
  readDialect,
  resolveApiChain,
  resolveChain,
  resolveSessionChain,
  saveDialect,
  setDialectOn,
  textProblem,
  writeDialectFile,
  type DialectFile,
  type DialectSchema
} from '../src/main/dialects'
import HISTORY from '../src/main/bundledHistory.json'
import { tempDir } from './tempDir'

/** A schema of a few texts, as agent-text/schema holds them. */
const SCHEMA: DialectSchema = {
  'a.plain': {},
  'a.named': { project: 'plain' },
  'a.count': { n: 'plural' },
  'a.flag': { on: 'select', name: 'plain' },
  'a.num': { n: 'number' }
}

const file = (texts: Record<string, string>, extra: Partial<DialectFile> = {}): DialectFile => ({ name: 'x', texts: Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, { text, why: 'a test' }])), ...extra })
const write = (dir: string, path: string, f: DialectFile | string): void => {
  const p = join(dir, ...path.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof f === 'string' ? f : JSON.stringify(f))
}

describe('the format and its check', () => {
  it('reads a file: name, model and texts; refuses what is not one', () => {
    expect(parseDialectFile('{"name":"Opus 5.5","model":" claude-opus-5-5 ","texts":{}}')).toEqual({ file: { name: 'Opus 5.5', model: 'claude-opus-5-5', texts: {} } })
    expect(parseDialectFile('﻿{"name":"W","texts":{}}')).toMatchObject({ file: { name: 'W' } })
    expect(parseDialectFile('{')).toEqual({ problem: { problem: 'json' } })
    expect(parseDialectFile('[]')).toEqual({ problem: { problem: 'shape', field: 'file' } })
    expect(parseDialectFile('{"texts":{}}')).toEqual({ problem: { problem: 'shape', field: 'name' } })
    expect(parseDialectFile('{"name":"x","model":"","texts":{}}')).toEqual({ problem: { problem: 'shape', field: 'model' } })
    expect(parseDialectFile('{"name":"x","texts":[]}')).toEqual({ problem: { problem: 'shape', field: 'texts' } })
  })

  it('passes an override with exactly its id’s placeholders, whatever it says', () => {
    expect(textProblem(SCHEMA, 'a.plain', { text: 'Anything at all, even bad advice.' })).toBeNull()
    expect(textProblem(SCHEMA, 'a.named', { text: 'In {project}.', why: 'shorter' })).toBeNull()
    expect(textProblem(SCHEMA, 'a.count', { text: '{n, plural, one {# card} other {# cards}}' })).toBeNull()
    expect(textProblem(SCHEMA, 'a.flag', { text: '{on, select, yes {{name} on} other {off}}' })).toBeNull()
  })

  it('fails an unknown id, a bad entry, unparsable ICU, and placeholders missing, extra or of another kind', () => {
    expect(textProblem(SCHEMA, 'a.gone', { text: 'x' })).toEqual({ id: 'a.gone', problem: 'unknown' })
    expect(textProblem(SCHEMA, '__proto__', { text: 'x' })).toEqual({ id: '__proto__', problem: 'unknown' })
    expect(textProblem(SCHEMA, 'a.plain', 'x')).toEqual({ id: 'a.plain', problem: 'shape' })
    expect(textProblem(SCHEMA, 'a.plain', { text: 'x', why: 3 })).toEqual({ id: 'a.plain', problem: 'shape' })
    expect(textProblem(SCHEMA, 'a.plain', { text: 'an {unclosed' })).toMatchObject({ id: 'a.plain', problem: 'unparsable' })
    expect(textProblem(SCHEMA, 'a.named', { text: 'Somewhere.' })).toEqual({ id: 'a.named', problem: 'placeholders', missing: ['project'], extra: [], changed: [] })
    expect(textProblem(SCHEMA, 'a.plain', { text: 'In {project}.' })).toEqual({ id: 'a.plain', problem: 'placeholders', missing: [], extra: ['project'], changed: [] })
    expect(textProblem(SCHEMA, 'a.count', { text: '{n} cards' })).toEqual({ id: 'a.count', problem: 'placeholders', missing: [], extra: [], changed: ['n'] })
    expect(textProblem(SCHEMA, 'a.num', { text: '{n} cards' })).toMatchObject({ problem: 'placeholders', changed: ['n'] })
  })

  it('splits a file’s overrides into those that apply and those outdated', () => {
    const r = checkTexts(file({ 'a.plain': 'P', 'a.gone': 'G', 'a.named': 'no placeholder' }), SCHEMA)
    expect(r.texts).toEqual({ 'a.plain': 'P' })
    expect(r.outdated.map((p) => [p.id, p.problem])).toEqual([['a.gone', 'unknown'], ['a.named', 'placeholders']])
  })

  it('writes a file in a stable form: fields in order, ids sorted', () => {
    const text = dialectFileText({ texts: { 'b.x': { text: 'B' }, 'a.x': { text: 'A', why: 'w' } }, model: 'm', name: 'N' })
    expect(text).toBe('{\n  "name": "N",\n  "model": "m",\n  "texts": {\n    "a.x": {\n      "text": "A",\n      "why": "w"\n    },\n    "b.x": {\n      "text": "B"\n    }\n  }\n}\n')
  })

  it('this Combwork’s schema is the extracted one, bundled into main', () => {
    const schema = agentTextSchema()
    expect(Object.keys(schema).length).toBeGreaterThan(10)
    expect(schema['contract.agent.host']).toEqual({ hasProject: 'select', project: 'plain' })
  })
})

describe('model IDs', () => {
  it('reduce to the base ID: no context suffix or snapshot date', () => {
    expect(baseModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(baseModelId('claude-haiku-5-5-20261015')).toBe('claude-haiku-5-5')
    expect(baseModelId('gpt-6.1-sol')).toBe('gpt-6.1-sol')
  })

  it('are the real ID: an alias through the CLI’s catalogue, else unknown; never the friendly name', () => {
    const info = { catalog: { source: 'cli' as const, version: null, at: '', models: [{ value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5' }] }, defaultModel: 'claude-sonnet-5-5' }
    expect(dialectModelId('claude-code', info, 'opus')).toBe('claude-opus-5-5')
    expect(dialectModelId('claude-code', info, 'claude-haiku-5-5')).toBe('claude-haiku-5-5')
    // The CLI's default, when Combwork knows it.
    expect(dialectModelId('claude-code', info, '')).toBe('claude-sonnet-5-5')
    // An alias the catalogue doesn't resolve, and no choice with no known default: unknown.
    expect(dialectModelId('claude-code', null, 'sonnet')).toBeNull()
    expect(dialectModelId('claude-code', null, 'opus[1m]')).toBeNull()
    expect(dialectModelId('claude-code', null, null)).toBeNull()
  })
})

describe('the chain', () => {
  const base = tempDir('hive-dialects-chain-')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  let n = 0
  /** A dialects folder with the usual layers, each overriding what is above it in the list. */
  const layered = (): string => {
    const dir = join(base, `d${++n}`)
    write(dir, 'workspace.json', file({ 'a.plain': 'workspace', 'a.named': 'ws {project}', 'a.num': 'ws {n, number}' }))
    write(dir, 'claude-code/cli.json', file({ 'a.plain': 'cli', 'a.named': 'cli {project}' }))
    write(dir, 'claude-code/Opus 5.5.json', file({ 'a.plain': 'opus' }, { name: 'Opus 5.5', model: 'claude-opus-5-5' }))
    write(dir, 'claude-code/Opus 5.5 1M.json', file({ 'a.plain': 'opus 1m' }, { name: 'Opus 5.5 1M', model: 'claude-opus-5-5[1m]' }))
    write(dir, 'claude-code/Opus 5.5 v2.json', file({ 'a.plain': 'opus v2' }, { name: 'Opus 5.5 v2' }))
    write(dir, 'claude-code/Haiku 5.5.json', file({}, { name: 'Haiku 5.5', model: 'claude-haiku-5-5' }))
    write(dir, 'api/cli.json', file({ 'a.plain': 'api' }))
    return dir
  }

  it('takes each id from the highest layer that has it: model file, CLI, Workspace, then the Default', async () => {
    const c = await resolveSessionChain(layered(), { cli: 'claude-code', modelId: 'claude-opus-5-5' }, SCHEMA)
    expect(c.texts).toEqual({ 'a.plain': 'opus', 'a.named': 'cli {project}', 'a.num': 'ws {n, number}' })
    expect(c.sources).toEqual({ 'a.plain': 'claude-code/Opus 5.5.json', 'a.named': 'claude-code/cli.json', 'a.num': 'workspace.json' })
    expect(c.files).toEqual(['claude-code/Opus 5.5.json', 'claude-code/cli.json', 'workspace.json'])
    expect(c.layers.map((l) => l.layer)).toEqual(['model', 'cli', 'workspace'])
    expect(c.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(c.modelUnknown).toBeUndefined()
  })

  it('an empty model file adds nothing: the layers below show through', async () => {
    const c = await resolveSessionChain(layered(), { cli: 'claude-code', modelId: 'claude-haiku-5-5' }, SCHEMA)
    expect(c.files[0]).toBe('claude-code/Haiku 5.5.json')
    expect(c.texts['a.plain']).toBe('cli')
  })

  it('another CLI has its own folder: no link between the same model under two CLIs', async () => {
    const dir = layered()
    const c = await resolveSessionChain(dir, { cli: 'codex', modelId: 'claude-opus-5-5' }, SCHEMA)
    expect(c.texts).toEqual({ 'a.plain': 'workspace', 'a.named': 'ws {project}', 'a.num': 'ws {n, number}' })
    expect(c.layers).toEqual([{ layer: 'model', file: null }, { layer: 'cli', file: null }, { layer: 'workspace', file: 'workspace.json' }])
  })

  it('a caller with no session: API → Workspace → Default', async () => {
    const c = await resolveApiChain(layered(), SCHEMA)
    expect(c.texts['a.plain']).toBe('api')
    expect(c.texts['a.named']).toBe('ws {project}')
    expect(c.layers.map((l) => [l.layer, l.file])).toEqual([['api', 'api/cli.json'], ['workspace', 'workspace.json']])
  })

  it('nothing at all is the Default: no overrides, no hash', async () => {
    const c = await resolveSessionChain(join(base, 'none'), { cli: 'claude-code', modelId: 'claude-opus-5-5' }, SCHEMA)
    expect(c).toMatchObject({ texts: {}, files: [], hash: '' })
  })

  it('a file switched off is skipped, as if its slot were empty; switched on again, it applies', async () => {
    const dir = layered()
    await setDialectOn(dir, 'claude-code/Opus 5.5.json', false)
    await setDialectOn(dir, 'claude-code/cli.json', false)
    let c = await resolveSessionChain(dir, { cli: 'claude-code', modelId: 'claude-opus-5-5' }, SCHEMA)
    expect(c.texts['a.plain']).toBe('workspace')
    expect(c.slot).toMatchObject({ file: null, chosen: 'claude-code/Opus 5.5.json' })
    expect(JSON.parse(readFileSync(join(dir, '.state.json'), 'utf8'))).toEqual({ off: ['claude-code/Opus 5.5.json', 'claude-code/cli.json'] })
    await setDialectOn(dir, 'claude-code/Opus 5.5.json', true)
    c = await resolveSessionChain(dir, { cli: 'claude-code', modelId: 'claude-opus-5-5' }, SCHEMA)
    expect(c.texts['a.plain']).toBe('opus')
    // Switching doesn't touch the file (a shipped copy stays unedited).
    await expect(readDialect(dir, 'claude-code/Opus 5.5.json')).resolves.toMatchObject({ model: 'claude-opus-5-5' })
  })

  it('an outdated override falls through to the layer below, for its id only, and is flagged', async () => {
    const dir = layered()
    // The model file's a.named lost its placeholder (a Combwork update changed it): the CLI's applies.
    write(dir, 'claude-code/Opus 5.5.json', file({ 'a.plain': 'opus', 'a.named': 'no project', 'a.removed': 'gone' }, { name: 'Opus 5.5', model: 'claude-opus-5-5' }))
    const c = await resolveSessionChain(dir, { cli: 'claude-code', modelId: 'claude-opus-5-5' }, SCHEMA)
    expect(c.texts).toMatchObject({ 'a.plain': 'opus', 'a.named': 'cli {project}' })
    expect(c.texts['a.removed']).toBeUndefined()
    const set = await loadDialects(dir, SCHEMA)
    expect(set.folders['claude-code'].files.find((f) => f.path === 'claude-code/Opus 5.5.json')!.outdated.map((p) => p.id)).toEqual(['a.named', 'a.removed'])
    // The file itself is left as it is.
    expect((await readDialect(dir, 'claude-code/Opus 5.5.json'))!.texts['a.named'].text).toBe('no project')
  })

  it('a file that is not a dialect adds nothing, and is marked', async () => {
    const dir = layered()
    write(dir, 'claude-code/cli.json', '{ not json')
    const c = await resolveSessionChain(dir, { cli: 'claude-code', modelId: 'claude-opus-5-5' }, SCHEMA)
    expect(c.texts['a.named']).toBe('ws {project}')
    expect((await loadDialects(dir, SCHEMA)).folders['claude-code'].cli!.broken).toEqual({ problem: 'json' })
  })

  it('is what say() renders when registered as the resolver, with the code’s English beneath', () => {
    const m = agentMsg({ id: 'a.named', text: 'Working in {project}.' })
    const other = agentMsg({ id: 'a.plain', text: 'Default.' })
    const chain = resolveChain({ workspace: null, folders: {} }, { kind: 'api' })
    setChainResolver(() => ({ ...chain, texts: { 'a.named': 'In {project}.' } }))
    try {
      // Through a scope (6b registers the service; here a scope is opened by hand).
      expect(inDialectOf({ projectPath: 'p', agentId: 'a' }, () => say(m, { project: 'alpha' }))).toBe('In alpha.')
      expect(inDialectOf({ projectPath: 'p', agentId: 'a' }, () => say(other))).toBe('Default.')
    } finally {
      setChainResolver(null)
    }
  })
})

describe('matching the model slot', () => {
  const base = tempDir('hive-dialects-match-')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  let set: Awaited<ReturnType<typeof loadDialects>>
  beforeAll(async () => {
    write(base, 'claude-code/Opus 5.5.json', file({}, { name: 'Opus 5.5', model: 'claude-opus-5-5' }))
    write(base, 'claude-code/Opus 5.5 1M.json', file({}, { name: 'Opus 5.5 1M', model: 'claude-opus-5-5[1m]' }))
    write(base, 'claude-code/Opus 5.5 v2.json', file({}, { name: 'Opus 5.5 v2' }))
    // Named for a model it doesn't claim: the name is only a label.
    write(base, 'claude-code/Haiku 5.5.json', file({}, { name: 'Haiku 5.5' }))
    set = await loadDialects(base, SCHEMA)
  })
  const cc = () => set.folders['claude-code']

  it('Auto: the exact ID first', () => {
    expect(modelSlot(cc(), 'claude-opus-5-5').chosen).toBe('claude-code/Opus 5.5.json')
    expect(modelSlot(cc(), 'claude-opus-5-5[1m]').chosen).toBe('claude-code/Opus 5.5 1M.json')
  })

  it('Auto: else the base ID (a context suffix or snapshot date removed)', () => {
    expect(modelSlot(cc(), 'claude-opus-5-5-20261015').chosen).toBe('claude-code/Opus 5.5.json')
    expect(modelSlot(cc(), 'claude-opus-5-5[200k]').chosen).toBe('claude-code/Opus 5.5.json')
  })

  it('Auto: no file, an empty slot; never the friendly name', () => {
    expect(modelSlot(cc(), 'claude-haiku-5-5')).toEqual({ file: null, chosen: null, modelUnknown: false })
    expect(modelSlot(cc(), 'Opus 5.5')).toMatchObject({ file: null })
  })

  it('Auto with no model ID: an empty slot, "model unknown"', () => {
    expect(modelSlot(cc(), null)).toEqual({ file: null, chosen: null, modelUnknown: true })
  })

  it('the agent’s pick fills the slot whatever model runs (the A/B test); a pick that is gone falls back to Auto', () => {
    expect(modelSlot(cc(), 'claude-opus-5-5', { file: 'claude-code/Opus 5.5 v2.json' })).toMatchObject({ chosen: 'claude-code/Opus 5.5 v2.json', modelUnknown: false })
    expect(modelSlot(cc(), null, { file: 'claude-code/Opus 5.5 v2.json' }).file?.path).toBe('claude-code/Opus 5.5 v2.json')
    expect(modelSlot(cc(), 'claude-opus-5-5', { file: 'claude-code/Gone.json' })).toMatchObject({ chosen: 'claude-code/Opus 5.5.json', pickMissing: true })
  })

  it('the pick changes only the model slot: the layers below are as on Auto', () => {
    const withCli = { ...set, folders: { ...set.folders, 'claude-code': { ...cc(), cli: { path: 'claude-code/cli.json', name: 'cli', texts: { 'a.named': 'cli {project}' }, outdated: [], on: true } } } }
    const slot = modelSlot(withCli.folders['claude-code'], 'claude-opus-5-5', { file: 'claude-code/Opus 5.5 v2.json' })
    const c = resolveChain(withCli, { kind: 'session', cli: 'claude-code', modelFile: slot.file })
    expect(c.layers).toEqual([{ layer: 'model', file: 'claude-code/Opus 5.5 v2.json' }, { layer: 'cli', file: 'claude-code/cli.json' }, { layer: 'workspace', file: null }])
  })

  it('records "model unknown" in the chain', async () => {
    const c = await resolveSessionChain(base, { cli: 'claude-code', modelId: null }, SCHEMA)
    expect(c.modelUnknown).toBe(true)
    expect(c.layers[0]).toEqual({ layer: 'model', file: null })
  })
})

describe('one file per model in a CLI folder', () => {
  const base = tempDir('hive-dialects-claims-')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  let n = 0
  const folder = (): string => {
    const dir = join(base, `d${++n}`)
    write(dir, 'claude-code/Opus 5.5.json', file({ 'a.plain': 'opus' }, { name: 'Opus 5.5', model: 'claude-opus-5-5' }))
    write(dir, 'claude-code/Opus 5.5 v2.json', file({ 'a.plain': 'v2' }, { name: 'Opus 5.5 v2' }))
    return dir
  }

  it('a save that gives a second file the same model is refused, naming the file that has it', async () => {
    const dir = folder()
    expect(await saveDialect(dir, 'claude-code/Opus 5.5 v2.json', file({ 'a.plain': 'v2' }, { name: 'v2', model: 'Claude-Opus-5-5' }), SCHEMA)).toEqual({ refused: 'modelClaimed', model: 'Claude-Opus-5-5', by: 'claude-code/Opus 5.5.json' })
    expect((await readDialect(dir, 'claude-code/Opus 5.5 v2.json'))!.model).toBeUndefined()
    // The file that has it saves as it is.
    expect(await saveDialect(dir, 'claude-code/Opus 5.5.json', file({ 'a.plain': 'opus 2' }, { name: 'Opus 5.5', model: 'claude-opus-5-5' }), SCHEMA)).toBeNull()
    // The same model under another CLI is another folder: allowed.
    expect(await saveDialect(dir, 'codex/Opus.json', file({}, { name: 'Opus', model: 'claude-opus-5-5' }), SCHEMA)).toBeNull()
  })

  it('two files made outside Combwork that claim one model: Auto takes the first by name, the other is marked', async () => {
    const dir = folder()
    write(dir, 'claude-code/Zed.json', file({}, { name: 'Zed', model: 'claude-opus-5-5' }))
    const set = await loadDialects(dir, SCHEMA)
    expect(set.folders['claude-code'].files.find((f) => f.path === 'claude-code/Zed.json')!.claimTaken).toBe('claude-code/Opus 5.5.json')
    expect(modelSlot(set.folders['claude-code'], 'claude-opus-5-5').chosen).toBe('claude-code/Opus 5.5.json')
  })

  it('an import whose model the folder already has comes in as a test copy', async () => {
    const dir = folder()
    const raw = JSON.stringify(file({ 'a.plain': 'imported' }, { name: 'Imported', model: 'claude-opus-5-5' }))
    expect(await importDialect(dir, 'claude-code/Imported.json', raw, SCHEMA)).toEqual({ testCopy: true })
    expect(await readDialect(dir, 'claude-code/Imported.json')).toEqual({ name: 'Imported', texts: { 'a.plain': { text: 'imported', why: 'a test' } } })
    // A free model is kept; a name taken is refused; so is a text that fails the schema.
    expect(await importDialect(dir, 'claude-code/Haiku.json', JSON.stringify(file({}, { name: 'Haiku', model: 'claude-haiku-5-5' })), SCHEMA)).toEqual({ testCopy: false })
    expect((await readDialect(dir, 'claude-code/Haiku.json'))!.model).toBe('claude-haiku-5-5')
    expect(await importDialect(dir, 'claude-code/imported.json', raw, SCHEMA)).toEqual({ refused: 'nameTaken', path: 'claude-code/imported.json' })
    expect(await importDialect(dir, 'claude-code/Bad.json', JSON.stringify(file({ 'a.gone': 'x' })), SCHEMA)).toEqual({ refused: 'texts', problems: [{ id: 'a.gone', problem: 'unknown' }] })
    expect(await importDialect(dir, 'claude-code/Bad.json', '{', SCHEMA)).toEqual({ refused: 'file', problem: { problem: 'json' } })
  })

  it('Promote moves the claim onto a test copy; the file that had it keeps its texts as a test copy', async () => {
    const dir = folder()
    expect(await promoteDialect(dir, 'claude-code/Opus 5.5 v2.json', 'claude-opus-5-5')).toEqual({ from: 'claude-code/Opus 5.5.json' })
    expect(await readDialect(dir, 'claude-code/Opus 5.5 v2.json')).toMatchObject({ model: 'claude-opus-5-5', texts: { 'a.plain': { text: 'v2' } } })
    const old = await readDialect(dir, 'claude-code/Opus 5.5.json')
    expect(old!.model).toBeUndefined()
    expect(old!.texts['a.plain'].text).toBe('opus')
    const c = await resolveSessionChain(dir, { cli: 'claude-code', modelId: 'claude-opus-5-5' }, SCHEMA)
    expect(c.texts['a.plain']).toBe('v2')
    // Not in a CLI file, the API folder or the Workspace file.
    expect(await promoteDialect(dir, 'claude-code/cli.json', 'claude-opus-5-5')).toEqual({ refused: 'path' })
    expect(await promoteDialect(dir, 'api/x.json', 'claude-opus-5-5')).toEqual({ refused: 'path' })
    expect(await promoteDialect(dir, 'claude-code/Missing.json', 'claude-opus-5-5')).toEqual({ refused: 'missing', path: 'claude-code/Missing.json' })
  })

  it('Promote onto a test copy with an entry that is not an override keeps it as written, and moves the claim (HR1 r1)', async () => {
    const dir = folder()
    write(dir, 'claude-code/New.json', '{"name":"New","texts":{"a.gone":null,"a.plain":{"text":"new","extra":1}}}')
    expect(await promoteDialect(dir, 'claude-code/New.json', 'claude-opus-5-5')).toEqual({ from: 'claude-code/Opus 5.5.json' })
    expect(JSON.parse(readFileSync(join(dir, 'claude-code', 'New.json'), 'utf8'))).toEqual({ name: 'New', model: 'claude-opus-5-5', texts: { 'a.gone': null, 'a.plain': { text: 'new', extra: 1 } } })
    const set = await loadDialects(dir, SCHEMA)
    expect(set.folders['claude-code'].files.filter((f) => f.model).map((f) => f.path)).toEqual(['claude-code/New.json'])
  })

  it('a Promote whose write fails puts back what it changed: the model keeps its claim (HR1 r1)', async () => {
    const dir = folder()
    const before = readFileSync(join(dir, 'claude-code', 'Opus 5.5.json'), 'utf8')
    const v2Before = readFileSync(join(dir, 'claude-code', 'Opus 5.5 v2.json'), 'utf8')
    vi.resetModules()
    vi.doMock('../src/main/fsutil', async (orig) => {
      const real = await orig<typeof import('../src/main/fsutil')>()
      // The target's write fails (as a rename Windows refuses past its retries), after the old owner's was written.
      return { ...real, writeTextAtomic: async (p: string, text: string, o?: { mkdir?: boolean }) => (p.endsWith('Opus 5.5 v2.json') ? Promise.reject(Object.assign(new Error('EPERM: rename'), { code: 'EPERM' })) : real.writeTextAtomic(p, text, o)) }
    })
    try {
      const store = await import('../src/main/dialects/store')
      await expect(store.promoteDialect(dir, 'claude-code/Opus 5.5 v2.json', 'claude-opus-5-5')).rejects.toThrow('EPERM')
    } finally {
      vi.doUnmock('../src/main/fsutil')
      vi.resetModules()
    }
    expect(readFileSync(join(dir, 'claude-code', 'Opus 5.5.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, 'claude-code', 'Opus 5.5 v2.json'), 'utf8')).toBe(v2Before)
    expect(modelSlot((await loadDialects(dir, SCHEMA)).folders['claude-code'], 'claude-opus-5-5').chosen).toBe('claude-code/Opus 5.5.json')
  })

  it('Duplicate makes a test copy beside it, with every text as it was', async () => {
    const dir = folder()
    write(dir, 'claude-code/Opus 5.5.json', file({ 'a.plain': 'opus', 'a.gone': 'outdated' }, { name: 'Opus 5.5', model: 'claude-opus-5-5' }))
    expect(await duplicateDialect(dir, 'claude-code/Opus 5.5.json', 'Opus 5.5 v3')).toEqual({ path: 'claude-code/Opus 5.5 v3.json' })
    expect(await readDialect(dir, 'claude-code/Opus 5.5 v3.json')).toEqual({ name: 'Opus 5.5 v3', texts: { 'a.gone': { text: 'outdated', why: 'a test' }, 'a.plain': { text: 'opus', why: 'a test' } } })
    expect(await duplicateDialect(dir, 'claude-code/Opus 5.5.json', 'Opus 5.5 v2')).toEqual({ refused: 'nameTaken', path: 'claude-code/Opus 5.5 v2.json' })
  })
})

describe('saving', () => {
  const dir = tempDir('hive-dialects-save-')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('is refused, writing nothing, when a text fails the schema', async () => {
    const r = await saveDialect(dir, 'workspace.json', file({ 'a.plain': 'ok', 'a.named': 'lost it', 'a.gone': 'x', 'a.count': '{n' }), SCHEMA)
    expect(r).toMatchObject({ refused: 'texts' })
    expect((r as { problems: { id: string; problem: string }[] }).problems.map((p) => [p.id, p.problem])).toEqual([['a.count', 'unparsable'], ['a.gone', 'unknown'], ['a.named', 'placeholders']])
    expect(existsSync(join(dir, 'workspace.json'))).toBe(false)
  })

  it('writes a file that passes, in Combwork’s form', async () => {
    expect(await saveDialect(dir, 'workspace.json', file({ 'a.named': 'At {project}.' }, { name: 'Workspace' }), SCHEMA)).toBeNull()
    expect(readFileSync(join(dir, 'workspace.json'), 'utf8')).toBe(dialectFileText(file({ 'a.named': 'At {project}.' }, { name: 'Workspace' })))
  })

  it('a model only on a model file or test copy of a CLI folder; only dialect paths', async () => {
    expect(await saveDialect(dir, 'workspace.json', file({}, { model: 'm-1' }), SCHEMA)).toEqual({ refused: 'modelHere' })
    expect(await saveDialect(dir, 'codex/cli.json', file({}, { model: 'm-1' }), SCHEMA)).toEqual({ refused: 'modelHere' })
    expect(await saveDialect(dir, 'api/Other.json', file({}, { model: 'm-1' }), SCHEMA)).toEqual({ refused: 'modelHere' })
    for (const p of ['../x.json', 'a/b/c.json', 'claude-code/x.txt', 'claude-code/.hidden.json', 'Claude Code/x.json', '.state.json']) expect(placeOf(p), p).toBeNull()
    expect(await saveDialect(dir, '../escape.json', file({}), SCHEMA)).toEqual({ refused: 'path' })
  })
})

describe('a session’s resolved texts for hive-mcp.js', () => {
  const dir = tempDir('hive-dialects-launch-')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('go in a CW_DIALECT_FILE the process loader reads', async () => {
    write(dir, 'ws/claude-code/cli.json', file({ 'a.named': 'At {project}.' }))
    const chain = await resolveSessionChain(join(dir, 'ws'), { cli: 'claude-code', modelId: 'claude-opus-5-5' }, SCHEMA)
    const launch = join(dir, 'launch')
    mkdirSync(launch)
    const { file: f, env } = await writeDialectFile(launch, chain)
    expect(env).toEqual({ CW_DIALECT_FILE: f, CW_DIALECT: chain.hash })
    expect(chainFromFile(readFileSync(f, 'utf8'))).toEqual({ texts: { 'a.named': 'At {project}.' }, files: ['claude-code/cli.json'], hash: chain.hash })
  })
})

describe('the bundled dialect files', () => {
  const base = tempDir('hive-dialects-bundled-')
  const res = join(base, 'resources')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  let mod: typeof import('../src/main/bundled')
  let wsMod: typeof import('../src/main/workspace')
  const OLD = JSON.stringify(file({}, { name: 'Opus 5.5', model: 'claude-opus-5-5' }))
  const NOW = JSON.stringify(file({ 'a.plain': 'measured' }, { name: 'Opus 5.5', model: 'claude-opus-5-5' }))

  beforeAll(async () => {
    write(res, 'dialects/claude-code/Opus 5.5.json', NOW)
    write(res, 'dialects/claude-code/cli.json', file({}, { name: 'Claude Code' }))
    write(res, 'dialects/api/cli.json', file({}, { name: 'API' }))
    write(base, 'old-opus.json', OLD)
    const history = { ...structuredClone(HISTORY), dialects: { 'claude-code/Opus 5.5': [await contentHash(join(base, 'old-opus.json')), await contentHash(join(res, 'dialects', 'claude-code', 'Opus 5.5.json'))] } }
    vi.resetModules()
    vi.doMock('../src/main/bundledHistory.json', () => ({ default: history }))
    vi.doMock('../src/main/paths', async (orig) => ({ ...(await orig<typeof import('../src/main/paths')>()), resourcesDir: () => res }))
    mod = await import('../src/main/bundled')
    wsMod = await import('../src/main/workspace')
  })
  afterAll(() => {
    vi.doUnmock('../src/main/paths')
    vi.doUnmock('../src/main/bundledHistory.json')
    rmSync(base, { recursive: true, force: true })
  })

  const opened = async (path: string) => {
    const w = wsMod.createWorkspaceService()
    await w.open(path)
    return w
  }

  it('are listed by folder and label', async () => {
    expect(await mod.bundledIds('dialects')).toEqual(['api/cli', 'claude-code/Opus 5.5', 'claude-code/cli'])
  })

  it('reach a workspace; an untouched older copy follows the update, an edited one is kept and offered Revert', async () => {
    const ws = join(base, 'ws')
    mkdirSync(ws, { recursive: true })
    const w = await opened(ws)
    try {
      await wsMod.inWorkspace(w, () => mod.syncBundled({ fresh: true }))
      const dialects = join(ws, '.combwork', 'dialects')
      expect(readdirSync(join(dialects, 'claude-code')).sort()).toEqual(['Opus 5.5.json', 'cli.json'])
      expect(readFileSync(join(dialects, 'api', 'cli.json'), 'utf8')).toBe(JSON.stringify(file({}, { name: 'API' })))
      const m = JSON.parse(readFileSync(join(ws, '.combwork', 'bundled.json'), 'utf8'))
      expect(Object.keys(m.dialects).sort()).toEqual(['api/cli', 'claude-code/Opus 5.5', 'claude-code/cli'])

      // An untouched copy of the version before: updated.
      writeFileSync(join(dialects, 'claude-code', 'Opus 5.5.json'), OLD)
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(readFileSync(join(dialects, 'claude-code', 'Opus 5.5.json'), 'utf8')).toBe(NOW)

      // Edited: kept, and its status says so; Revert brings the shipped one back.
      const edited = JSON.stringify(file({ 'a.plain': 'mine' }, { name: 'Opus 5.5', model: 'claude-opus-5-5' }))
      writeFileSync(join(dialects, 'claude-code', 'Opus 5.5.json'), edited)
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(readFileSync(join(dialects, 'claude-code', 'Opus 5.5.json'), 'utf8')).toBe(edited)
      expect(await wsMod.inWorkspace(w, () => mod.bundledStatus('dialects', 'claude-code/Opus 5.5', join(dialects, 'claude-code', 'Opus 5.5.json')))).toEqual({ bundled: 'changed' })
      await wsMod.inWorkspace(w, () => mod.restoreBundled('dialects', 'claude-code/Opus 5.5'))
      expect(readFileSync(join(dialects, 'claude-code', 'Opus 5.5.json'), 'utf8')).toBe(NOW)

      // Deleted: stays deleted.
      rmSync(join(dialects, 'api', 'cli.json'))
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(existsSync(join(dialects, 'api', 'cli.json'))).toBe(false)
    } finally {
      await wsMod.disposeWorkspaceService(w)
    }
  })
})
