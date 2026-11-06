// New Model File, Duplicate with a model, and Set Model (HI-2523; design HI-2523/s13, Darren's decision: the model is
// typed, free text first): a file's name (unique in its folder, safe on Windows), the model ID it claims (normalised
// only where the CLI recognises it, else kept exactly), the claimed-model handover (all or nothing), and a later launch
// with that exact ID matching the file, through the launch's own resolver (dialectModelId) and the chain.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { dialectLabelProblem } from '../src/shared/dialects'
import { dialectModelId, dialectModelOf, dialectModelProblem, isUnresolvedAlias } from '../src/shared/models'
import { dialectModelSuggestions } from '../src/main/dialects/suggestions'
import { createDialect, loadDialects, modelSlot, promoteDialect, readDialect, resolveSessionChain, type DialectFile, type DialectSchema } from '../src/main/dialects'
import { tempDir } from './tempDir'

const SCHEMA: DialectSchema = { 'a.plain': {} }
const isCli = (f: string): boolean => ['claude-code', 'codex', 'copilot'].includes(f)
const file = (text: string | null, extra: Partial<DialectFile> = {}): DialectFile => ({ name: 'x', texts: text === null ? {} : { 'a.plain': { text, why: 'a test' } }, ...extra })
const write = (dir: string, path: string, f: DialectFile): void => {
  const p = join(dir, ...path.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(f))
}

/** Claude Code's catalogue as its initialize reply gives it: aliases with the IDs they stand for, and versions. */
const CLAUDE_INFO = {
  catalog: {
    source: 'cli' as const,
    version: null,
    at: '',
    models: [
      { value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5' },
      { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5-5' },
      { value: 'claude-haiku-5-5', label: 'Haiku 5.5' }
    ]
  },
  defaultModel: null
}

describe('a dialect file’s name (HI-2523)', () => {
  it('is one Windows takes and shows as typed, and not the CLI’s own file', () => {
    for (const ok of ['Opus 5.5', 'Qwen3 32b (fast)', 'gpt-6.1 sol v2', 'a'.repeat(100), 'CONSOLE', 'nul-ish']) expect(dialectLabelProblem(ok)).toBeNull()
    expect(dialectLabelProblem('')).toBe('empty')
    expect(dialectLabelProblem('   ')).toBe('empty')
    for (const bad of ['a/b', 'a\\b', 'qwen3:32b', 'what?', 'a*', 'a"b', 'a<b', 'a>b', 'a|b', 'tab\there']) expect(dialectLabelProblem(bad)).toBe('chars')
    expect(dialectLabelProblem('.hidden')).toBe('dot')
    expect(dialectLabelProblem('trailing.')).toBe('end')
    expect(dialectLabelProblem('trailing ')).toBe('end')
    for (const dev of ['CON', 'con', 'NUL', 'nul.txt', 'COM1', 'lpt9', 'AUX', 'PRN']) expect(dialectLabelProblem(dev)).toBe('reserved')
    expect(dialectLabelProblem('cli')).toBe('cli')
    expect(dialectLabelProblem('CLI')).toBe('cli')
    expect(dialectLabelProblem('a'.repeat(101))).toBe('long')
  })
})

describe('the model ID a file claims (HI-2523)', () => {
  it('is any ID typed, kept exactly: IDs never seen, Ollama-style ones, unknown date and bracket endings', () => {
    for (const id of ['qwen3:32b', 'hf.co/org/model:Q4_K_M', 'llama3.1:8b-instruct', 'hf.co/org/custom-20261104', 'my-model[beta]', 'gemma', 'Some-Future-Model-7']) {
      expect(dialectModelOf('claude-code', CLAUDE_INFO, id)).toEqual({ model: id, normalised: false, unresolvedAlias: false })
      expect(dialectModelOf('codex', null, id)).toEqual({ model: id, normalised: false, unresolvedAlias: false })
    }
    // Only the whitespace around it goes.
    expect(dialectModelOf('codex', null, '  qwen3:32b \t')).toEqual({ model: 'qwen3:32b', normalised: false, unresolvedAlias: false })
  })

  it('is normalised only where the CLI recognises it: an alias resolved, a context suffix or snapshot date dropped', () => {
    expect(dialectModelOf('claude-code', CLAUDE_INFO, 'opus')).toEqual({ model: 'claude-opus-5-5', normalised: true, unresolvedAlias: false })
    // An alias with a context suffix resolves as its unsuffixed form does.
    expect(dialectModelOf('claude-code', CLAUDE_INFO, 'opus[1m]')).toEqual({ model: 'claude-opus-5-5', normalised: true, unresolvedAlias: false })
    expect(dialectModelOf('claude-code', CLAUDE_INFO, 'claude-haiku-5-5-20261015')).toEqual({ model: 'claude-haiku-5-5', normalised: true, unresolvedAlias: false })
    expect(dialectModelOf('claude-code', CLAUDE_INFO, 'claude-haiku-5-5')).toEqual({ model: 'claude-haiku-5-5', normalised: false, unresolvedAlias: false })
    // With no catalogue, the descriptor's models list is what the CLI recognises.
    expect(dialectModelOf('claude-code', null, 'claude-opus-4-6[1m]')).toEqual({ model: 'claude-opus-4-6', normalised: true, unresolvedAlias: false })
    expect(dialectModelOf('codex', null, 'gpt-6.1-sol-20261101')).toEqual({ model: 'gpt-6.1-sol', normalised: true, unresolvedAlias: false })
  })

  it('says when it is one of the CLI’s aliases Combwork can’t resolve now, and keeps it as typed', () => {
    expect(dialectModelOf('claude-code', null, 'opus')).toEqual({ model: 'opus', normalised: false, unresolvedAlias: true })
    expect(dialectModelOf('copilot', null, 'auto')).toEqual({ model: 'auto', normalised: false, unresolvedAlias: true })
    expect(isUnresolvedAlias('claude-code', CLAUDE_INFO, 'opus')).toBe(false)
    expect(isUnresolvedAlias('claude-code', CLAUDE_INFO, 'haiku')).toBe(true)
    // A word that isn't one of the CLI's aliases is a model ID of its own.
    expect(isUnresolvedAlias('claude-code', null, 'gemma')).toBe(false)
    expect(isUnresolvedAlias('codex', null, 'auto')).toBe(false)
  })

  it('is refused only when empty, or with a control character or a line break', () => {
    expect(dialectModelProblem('')).toBe('empty')
    expect(dialectModelProblem('  ')).toBe('empty')
    expect(dialectModelProblem('qwen3:32b\nrm')).toBe('control')
    expect(dialectModelProblem('a\u0007b')).toBe('control')
    expect(dialectModelProblem('hf.co/org/model:Q4_K_M')).toBeNull()
  })
})

describe('the model field’s suggestions (HI-2523)', () => {
  const accounts = [
    { id: 'acc-claude', provider: 'claude-code' as const },
    { id: 'acc-ollama', provider: 'claude-code' as const, server: { models: [{ id: 'qwen3:32b' }, { id: 'llama3.1:8b-instruct' }] } as never },
    { id: 'acc-codex', provider: 'codex' as const }
  ]
  const connections = [
    { account: 'acc-claude', model: 'claude-sonnet-5-5' },
    { account: 'acc-codex', model: 'gpt-6.1-sol' },
    { account: 'acc-claude' }
  ]
  const live = [
    { cli: 'claude-code', modelId: 'gemma-local', workspace: 'D:\\A' },
    { cli: 'claude-code', modelId: 'only-in-b', workspace: 'D:\\B' },
    { cli: 'codex', modelId: 'gpt-6-astra', workspace: 'D:\\A' },
    { cli: 'claude-code', modelId: null, workspace: 'D:\\A' }
  ]

  it('are this workspace’s running launches, then the CLI’s connections’ models, each once', () => {
    expect(dialectModelSuggestions('claude-code', 'd:\\a', live, accounts, connections)).toEqual(['gemma-local', 'claude-sonnet-5-5', 'qwen3:32b', 'llama3.1:8b-instruct'])
    expect(dialectModelSuggestions('codex', 'D:\\A', live, accounts, connections)).toEqual(['gpt-6-astra', 'gpt-6.1-sol'])
  })

  it('never take another workspace’s running session (HR2 r1): two windows, two workspaces', () => {
    expect(dialectModelSuggestions('claude-code', 'D:\\B', live, accounts, connections)).toEqual(['only-in-b', 'claude-sonnet-5-5', 'qwen3:32b', 'llama3.1:8b-instruct'])
    expect(dialectModelSuggestions('claude-code', 'D:\\B', live, accounts, connections)).not.toContain('gemma-local')
    // No workspace: the connections' models only.
    expect(dialectModelSuggestions('claude-code', null, live, accounts, connections)).toEqual(['claude-sonnet-5-5', 'qwen3:32b', 'llama3.1:8b-instruct'])
  })
})

describe('a launch’s model ID (dialectModelId, HI-2523)', () => {
  it('is a word that isn’t one of the CLI’s aliases as typed; an alias it can’t resolve stays unknown', () => {
    expect(dialectModelId('claude-code', null, 'gemma')).toBe('gemma')
    expect(dialectModelId('codex', null, 'gpt')).toBe('gpt')
    expect(dialectModelId('claude-code', null, 'opus')).toBeNull()
    expect(dialectModelId('claude-code', null, 'opus[1m]')).toBeNull()
    expect(dialectModelId('copilot', null, 'auto')).toBeNull()
    expect(dialectModelId('claude-code', CLAUDE_INFO, 'opus')).toBe('claude-opus-5-5')
    expect(dialectModelId('claude-code', CLAUDE_INFO, 'opus[1m]')).toBe('claude-opus-5-5')
    expect(dialectModelId('codex', null, 'hf.co/org/custom-20261104')).toBe('hf.co/org/custom-20261104')
  })
})

describe('New Model File, Duplicate and Set Model (HI-2523)', () => {
  const base = tempDir('cw-dialects-create-')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  let n = 0
  const folder = (): string => {
    const dir = join(base, `d${++n}`)
    write(dir, 'claude-code/cli.json', file('cli', { name: 'Claude Code' }))
    write(dir, 'claude-code/Opus 5.5.json', file('opus', { name: 'Opus 5.5', model: 'claude-opus-5-5' }))
    write(dir, 'codex/cli.json', file(null, { name: 'Codex' }))
    return dir
  }
  /** The text a launch of this CLI and chosen model gets, resolved as a launch resolves it (dialectModelId, then the chain). */
  const launched = async (dir: string, cli: 'claude-code' | 'codex' | 'copilot', chosen: string, info: Parameters<typeof dialectModelId>[1] = null) => {
    const c = await resolveSessionChain(dir, { cli, modelId: dialectModelId(cli, info, chosen) }, SCHEMA)
    return { file: c.slot.chosen, text: c.texts['a.plain'] }
  }

  it('New Model File makes an empty file for a model never seen, which a later launch with that exact ID gets', async () => {
    const dir = folder()
    expect(await createDialect(dir, 'codex', 'Qwen3 32b', { model: 'qwen3:32b', isCli })).toEqual({ path: 'codex/Qwen3 32b.json', from: null })
    expect(await readDialect(dir, 'codex/Qwen3 32b.json')).toEqual({ name: 'Qwen3 32b', model: 'qwen3:32b', texts: {} })
    expect(await launched(dir, 'codex', 'qwen3:32b')).toEqual({ file: 'codex/Qwen3 32b.json', text: undefined })
    // A bare word that isn't an alias of the CLI matches too, through the launch's own resolver.
    expect(await createDialect(dir, 'claude-code', 'Gemma', { model: 'gemma', isCli })).toEqual({ path: 'claude-code/Gemma.json', from: null })
    expect((await launched(dir, 'claude-code', 'gemma')).file).toBe('claude-code/Gemma.json')
    // An ID with an unknown date ending is matched exactly as saved.
    expect(await createDialect(dir, 'codex', 'Custom', { model: 'hf.co/org/custom-20261104', isCli })).toEqual({ path: 'codex/Custom.json', from: null })
    expect((await launched(dir, 'codex', 'hf.co/org/custom-20261104')).file).toBe('codex/Custom.json')
    // An alias the launch can't resolve is "model unknown": no file, whatever claims the word.
    expect(await createDialect(dir, 'claude-code', 'Opus word', { model: 'opus', isCli })).toEqual({ path: 'claude-code/Opus word.json', from: null })
    expect((await launched(dir, 'claude-code', 'opus')).file).toBeNull()
    // …while the catalogue resolves it to the ID a file claims.
    expect((await launched(dir, 'claude-code', 'opus[1m]', CLAUDE_INFO)).file).toBe('claude-code/Opus 5.5.json')
  })

  it('New Model File without a model is an empty test copy', async () => {
    const dir = folder()
    expect(await createDialect(dir, 'codex', 'Try', { model: '', isCli })).toEqual({ path: 'codex/Try.json', from: null })
    expect(await readDialect(dir, 'codex/Try.json')).toEqual({ name: 'Try', texts: {} })
  })

  it('refuses a name Windows won’t take, the CLI’s own, or one the folder has in any case, writing nothing', async () => {
    const dir = folder()
    expect(await createDialect(dir, 'claude-code', 'a:b', { isCli })).toEqual({ refused: 'name', problem: 'chars' })
    expect(await createDialect(dir, 'claude-code', 'NUL', { isCli })).toEqual({ refused: 'name', problem: 'reserved' })
    expect(await createDialect(dir, 'claude-code', 'cli', { isCli })).toEqual({ refused: 'name', problem: 'cli' })
    expect(await createDialect(dir, 'claude-code', 'trailing.', { isCli })).toEqual({ refused: 'name', problem: 'end' })
    expect(await createDialect(dir, 'claude-code', 'opus 5.5', { isCli })).toEqual({ refused: 'nameTaken', path: 'claude-code/opus 5.5.json' })
    // Not the API's folder, the Workspace, or a folder that isn't a CLI's.
    expect(await createDialect(dir, 'api', 'X', { isCli })).toEqual({ refused: 'path' })
    expect(await createDialect(dir, 'not-a-cli', 'X', { isCli })).toEqual({ refused: 'path' })
    expect(await createDialect(dir, '../x', 'X', { isCli })).toEqual({ refused: 'path' })
    expect(await createDialect(dir, 'codex', 'Bad', { model: 'a\nb', isCli })).toEqual({ refused: 'model', problem: 'control' })
    expect((await loadDialects(dir, SCHEMA)).folders['claude-code'].files.map((f) => f.path)).toEqual(['claude-code/Opus 5.5.json'])
  })

  it('refuses a name a file of the folder has with another case of extension, keeping its bytes (HR2 r1)', async () => {
    const dir = folder()
    const upper = join(dir, 'codex', 'Upper.JSON')
    writeFileSync(upper, 'not even a dialect, but the user’s')
    const before = readFileSync(upper)
    expect(await createDialect(dir, 'codex', 'Upper', { model: 'qwen3:32b', isCli })).toEqual({ refused: 'nameTaken', path: 'codex/Upper.json' })
    expect(await createDialect(dir, 'codex', 'upper', { isCli })).toEqual({ refused: 'nameTaken', path: 'codex/upper.json' })
    write(dir, 'codex/Source.json', file('source', { name: 'Source' }))
    expect(await createDialect(dir, 'codex', 'UPPER', { from: 'codex/Source.json', isCli })).toEqual({ refused: 'nameTaken', path: 'codex/UPPER.json' })
    expect(readFileSync(upper).equals(before)).toBe(true)
  })

  it('Duplicate with a model takes the claim in one step: the file that had it keeps its texts as a test copy', async () => {
    const dir = folder()
    expect(await createDialect(dir, 'claude-code', 'Opus 5.5 copy', { from: 'claude-code/Opus 5.5.json', model: 'claude-opus-5-5', isCli })).toEqual({ path: 'claude-code/Opus 5.5 copy.json', from: 'claude-code/Opus 5.5.json' })
    expect(await readDialect(dir, 'claude-code/Opus 5.5 copy.json')).toEqual({ name: 'Opus 5.5 copy', model: 'claude-opus-5-5', texts: { 'a.plain': { text: 'opus', why: 'a test' } } })
    expect(await readDialect(dir, 'claude-code/Opus 5.5.json')).toEqual({ name: 'Opus 5.5', texts: { 'a.plain': { text: 'opus', why: 'a test' } } })
    expect((await launched(dir, 'claude-code', 'claude-opus-5-5')).file).toBe('claude-code/Opus 5.5 copy.json')
    // Without a model it is a test copy, and the claim stays.
    expect(await createDialect(dir, 'claude-code', 'Plain copy', { from: 'claude-code/Opus 5.5 copy.json', isCli })).toEqual({ path: 'claude-code/Plain copy.json', from: null })
    expect((await readDialect(dir, 'claude-code/Plain copy.json'))!.model).toBeUndefined()
    // From another folder, or a CLI file: refused.
    expect(await createDialect(dir, 'codex', 'Cross', { from: 'claude-code/Opus 5.5.json', isCli })).toEqual({ refused: 'path' })
    expect(await createDialect(dir, 'claude-code', 'From CLI', { from: 'claude-code/cli.json', isCli })).toEqual({ refused: 'path' })
    expect(await createDialect(dir, 'claude-code', 'Gone', { from: 'claude-code/Gone.json', isCli })).toEqual({ refused: 'missing', path: 'claude-code/Gone.json' })
  })

  it('a new file whose write fails puts back the file it took the claim from (all or nothing)', async () => {
    const dir = folder()
    const before = readFileSync(join(dir, 'claude-code', 'Opus 5.5.json'), 'utf8')
    vi.resetModules()
    vi.doMock('../src/main/fsutil', async (orig) => {
      const real = await orig<typeof import('../src/main/fsutil')>()
      return { ...real, writeTextAtomic: async (p: string, text: string, o?: { mkdir?: boolean }) => (p.endsWith('New Opus.json') ? Promise.reject(Object.assign(new Error('EPERM: rename'), { code: 'EPERM' })) : real.writeTextAtomic(p, text, o)) }
    })
    try {
      const store = await import('../src/main/dialects/store')
      await expect(store.createDialect(dir, 'claude-code', 'New Opus', { model: 'claude-opus-5-5', isCli })).rejects.toThrow('EPERM')
    } finally {
      vi.doUnmock('../src/main/fsutil')
      vi.resetModules()
    }
    expect(readFileSync(join(dir, 'claude-code', 'Opus 5.5.json'), 'utf8')).toBe(before)
    expect(modelSlot((await loadDialects(dir, SCHEMA)).folders['claude-code'], 'claude-opus-5-5').chosen).toBe('claude-code/Opus 5.5.json')
  })

  it('Set Model retargets the user’s own file, refuses a blank ID and a shipped file', async () => {
    const dir = folder()
    expect(await createDialect(dir, 'claude-code', 'Mine', { isCli })).toEqual({ path: 'claude-code/Mine.json', from: null })
    expect(await promoteDialect(dir, 'claude-code/Mine.json', 'qwen3:32b', { shipped: new Set(['claude-code/Opus 5.5']) })).toEqual({ from: null })
    expect((await readDialect(dir, 'claude-code/Mine.json'))!.model).toBe('qwen3:32b')
    expect(await promoteDialect(dir, 'claude-code/Mine.json', '  ', { shipped: new Set() })).toEqual({ refused: 'model', problem: 'empty' })
    expect(await promoteDialect(dir, 'claude-code/Opus 5.5.json', 'other', { shipped: new Set(['claude-code/Opus 5.5']) })).toEqual({ refused: 'notYours' })
    expect(await promoteDialect(dir, 'claude-code/Mine.json', 'claude-opus-5-5', { shipped: new Set(['claude-code/Opus 5.5']) })).toEqual({ from: 'claude-code/Opus 5.5.json' })
    expect((await readDialect(dir, 'claude-code/Opus 5.5.json'))!.model).toBeUndefined()
  })
})
