// Dialects wired into sessions (HI-2443, dialects card 6b; plans/2026-11-03-dialects-design.md, sections 3 and 7): the
// Dialect setting as a pick, a session's chain from the files as loaded and the key that tells "restart to apply", the
// API chain kept per workspace and loaded again when its files change, and the guidance revision per chain. The launch
// itself (pinned chain, CW_DIALECT_FILE, the launch record) is the dialectlaunch e2e suite's.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { inDialectOf, setChainResolver, type DialectChain } from '../src/shared/agentText'
import { chainKey, loadDialects, pickOf, sessionChainOf, type DialectFile, type DialectSchema } from '../src/main/dialects'
import { apiChain, apiChainChanged, apiChainReady, forgetApiChain, inApiWorkspace, requestApiChain } from '../src/main/dialects/apiChain'
import { chainGuidanceRevision, GUIDANCE_REVISION } from '../src/main/guidance'
import { tempDir } from './tempDir'

const SCHEMA: DialectSchema = { 'a.plain': {}, 'a.named': { project: 'plain' } }
const file = (texts: Record<string, string>, extra: Partial<DialectFile> = {}): DialectFile => ({ name: 'x', texts: Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, { text, why: 'a test' }])), ...extra })
const write = (dir: string, path: string, f: DialectFile): void => {
  const p = join(dir, ...path.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(f))
}

const base = tempDir('hive-dialects-sessions-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
let n = 0
const folder = (): string => join(base, `d-${++n}`)

describe('the Dialect setting', () => {
  it('is Auto when absent, empty or "auto"; else the file it names', () => {
    expect(pickOf(undefined)).toBe('auto')
    expect(pickOf(null)).toBe('auto')
    expect(pickOf('  ')).toBe('auto')
    expect(pickOf('Auto')).toBe('auto')
    expect(pickOf(' claude-code/Opus 5.5 v2.json ')).toEqual({ file: 'claude-code/Opus 5.5 v2.json' })
  })
})

describe('a session’s chain and its key', () => {
  it('fills the model slot from the files as loaded: the pick, else Auto by the real model ID', async () => {
    const dir = folder()
    write(dir, 'claude-code/Opus 5.5.json', file({ 'a.plain': 'opus' }, { model: 'claude-opus-5-5' }))
    write(dir, 'claude-code/Opus 5.5 v2.json', file({ 'a.plain': 'v2' }))
    const set = await loadDialects(dir, SCHEMA)
    expect(sessionChainOf(set, { cli: 'claude-code', modelId: 'claude-opus-5-5', pick: 'auto' }).texts['a.plain']).toBe('opus')
    expect(sessionChainOf(set, { cli: 'claude-code', modelId: 'claude-opus-5-5', pick: { file: 'claude-code/Opus 5.5 v2.json' } }).texts['a.plain']).toBe('v2')
    const unknown = sessionChainOf(set, { cli: 'claude-code', modelId: null, pick: 'auto' })
    expect(unknown.modelUnknown).toBe(true)
    expect(unknown.hash).toBe('')
  })

  it('changes when a file in it changes what it says, or is switched off; not for a reason (why) alone', async () => {
    const dir = folder()
    const s = { cli: 'codex', modelId: 'gpt-6.1-sol', pick: 'auto' as const }
    write(dir, 'workspace.json', file({ 'a.named': 'In {project}.' }))
    const key = async () => chainKey(sessionChainOf(await loadDialects(dir, SCHEMA), s))
    const first = await key()
    write(dir, 'workspace.json', { name: 'x', texts: { 'a.named': { text: 'In {project}.', why: 'another reason' } } })
    expect(await key()).toBe(first)
    write(dir, 'workspace.json', file({ 'a.named': 'Working in {project}.' }))
    const edited = await key()
    expect(edited).not.toBe(first)
    writeFileSync(join(dir, '.state.json'), JSON.stringify({ off: ['workspace.json'] }))
    expect(await key()).not.toBe(edited)
  })

  it('changes when a file comes to fill an empty layer, even one that overrides nothing yet', async () => {
    const dir = folder()
    const s = { cli: 'codex', modelId: 'gpt-6.1-sol', pick: 'auto' as const }
    const key = async () => chainKey(sessionChainOf(await loadDialects(dir, SCHEMA), s))
    const before = await key()
    write(dir, 'codex/GPT-6.1 Sol.json', file({}, { model: 'gpt-6.1-sol' }))
    expect(await key()).not.toBe(before)
  })
})

describe('the API chain', () => {
  it('is loaded once per workspace, then kept; the Default until loaded and where nothing overrides', async () => {
    const hive = folder()
    expect(apiChain(hive)).toBeNull()
    await apiChainReady(hive)
    expect(apiChain(hive)).toBeNull()
    forgetApiChain(hive)
    write(join(hive, 'dialects'), 'api/cli.json', file({ 'a.plain': 'api' }))
    write(join(hive, 'dialects'), 'workspace.json', file({ 'a.plain': 'ws', 'a.named': 'ws {project}' }))
    await apiChainReady(hive)
    // Ids of a real catalogue only: these test ids aren't in this Combwork's schema, so nothing applies.
    expect(apiChain(hive)).toBeNull()
    forgetApiChain(hive)
  })

  it('follows its files: a change loads it again, and a load that started before it never lands', async () => {
    const hive = folder()
    const dir = join(hive, 'dialects')
    const id = 'api.http.noRoute'
    const say = (t: string) => ({ name: 'x', texts: { [id]: { text: `${t} {method} {path}`, why: 'a test' } } })
    mkdirSync(join(dir, 'api'), { recursive: true })
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify(say('one')))
    await apiChainReady(hive)
    expect(apiChain(hive)?.texts[id]).toBe('one {method} {path}')
    writeFileSync(join(dir, 'api', 'cli.json'), JSON.stringify(say('two')))
    apiChainChanged(hive)
    writeFileSync(join(dir, 'api', 'cli.json'), JSON.stringify(say('three')))
    apiChainChanged(hive)
    await apiChainReady(hive)
    expect(apiChain(hive)?.texts[id]).toBe('three {method} {path}')
    expect(apiChain(hive)?.files).toEqual(['api/cli.json', 'workspace.json'])
    forgetApiChain(hive)
  })
})

describe('the API chain of a request (HR1 on HI-2443)', () => {
  it('is the chain of the workspace the request is bound to, through its awaits; bound to none, or unbound, the Default', async () => {
    const id = 'api.http.noRoute'
    const a = folder()
    const b = folder()
    for (const [hive, mark] of [[a, 'A'], [b, 'B']]) {
      mkdirSync(join(hive, 'dialects'), { recursive: true })
      writeFileSync(join(hive, 'dialects', 'workspace.json'), JSON.stringify({ name: 'x', texts: { [id]: { text: `${mark} {method} {path}`, why: 'a test' } } }))
      await apiChainReady(hive)
    }
    const after = async (dir: string | null) =>
      inApiWorkspace(dir, async () => {
        // Across an await: the binding holds through the request's async work.
        await Promise.resolve()
        return requestApiChain()?.texts[id] ?? null
      })
    expect(await Promise.all([after(a), after(b), after(null)])).toEqual(['A {method} {path}', 'B {method} {path}', null])
    expect(requestApiChain()).toBeNull()
    forgetApiChain(a)
    forgetApiChain(b)
  })
})

describe('the guidance revision per chain', () => {
  const chain = (texts: Record<string, string>, hash: string): DialectChain => ({ texts, files: ['x'], hash })
  const inChain = <T>(c: DialectChain | null, fn: () => T): T => {
    setChainResolver(() => c)
    try {
      return inDialectOf({ projectPath: 'p', agentId: 'a' }, fn)
    } finally {
      setChainResolver(null)
    }
  }

  it('is the Default’s with no chain, or one that overrides none of the guidance', () => {
    expect(chainGuidanceRevision()).toBe(GUIDANCE_REVISION)
    expect(inChain(null, chainGuidanceRevision)).toBe(GUIDANCE_REVISION)
    expect(inChain(chain({ 'api.http.noRoute': 'x {method} {path}' }, 'aaaa'), chainGuidanceRevision)).toBe(GUIDANCE_REVISION)
  })

  it('is its own where the chain changes the guidance’s text, the same for every launch on that chain', () => {
    const c = chain({ 'contract.agent.host': 'Mine{hasProject, select, yes { ({project})} other {}}.' }, 'bbbb')
    const r = inChain(c, chainGuidanceRevision)
    expect(r).toMatch(/^[0-9a-f]{16}$/)
    expect(r).not.toBe(GUIDANCE_REVISION)
    expect(inChain(c, chainGuidanceRevision)).toBe(r)
    // The Default's own stays as it was, whatever chain is in force.
    expect(inChain(c, () => GUIDANCE_REVISION)).not.toBe(r)
  })
})
