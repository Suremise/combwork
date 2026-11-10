// Each sign-in account's own models (HI-2852): Claude Code offers each account its own (recorded with 2.1.321: one
// account offered Fable 5.2 while another, and ~/.claude, offered Fable 5.1), so each is read in its own folder. The
// recorded reply parsed; the selector the pickers, the save checks and the launch share (no default or list borrowed from
// the CLI's own home or another account); and the reads' lifecycle: each in its own folder, never awaited by the CLI's
// check, coalesced, fenced against removal, a CLI change and a newer read, falling back only to the account's own last
// answer. All in this file's temp folders: the CLI is never run (its status and listing are faked).
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { Account, AgentInstallInfo, CatalogModel, ModelCatalog } from '../src/shared/types'
import type { CatalogRead } from '../src/main/providers/types'
import { tempDir } from './tempDir'

vi.mock('../src/main/ptyHost', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/ptyHost')>()
  return { ...real, hasPty: () => false, killPty: () => undefined, ptyGone: async () => true }
})

const base = tempDir('cw-account-models-')
const home = join(base, 'claude-home')
process.env.CW_USER_DATA = join(base, 'profile')
process.env.CLAUDE_CONFIG_DIR = home
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const accounts = await import('../src/main/accounts')
const { config } = await import('../src/main/config')
const { advanced } = await import('../src/main/advanced')
const { provider } = await import('../src/main/providers')
const { providerService } = await import('../src/main/providerService')
const { parseClaudeInitialize } = await import('../src/main/providers/claude/models')
const { accountInfo, connectionModels, modelGroups } = await import('../src/shared/models')

const CLI = 'claude-code' as const
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'claude-initialize-2.1.321-account.json'), 'utf8'))
const recorded = parseClaudeInitialize(fixture.response.response)!

/** The install info the service holds (its own map: the service publishes into it). */
const infos = (providerService as unknown as { infos: Map<string, AgentInstallInfo> }).infos
const setCli = (patch: Partial<AgentInstallInfo>): void => void infos.set(CLI, { ...providerService.info(CLI), ...patch })
const own = (a: Account) => providerService.info(CLI).accountCatalogs?.[a.id]
/** The service's account source, as accounts.ts registered it (what the CLI's check starts). */
const source = (providerService as unknown as { accountModels: { refresh(id: string): void; cached(id: string, v: string | null | undefined): Record<string, unknown> | undefined } }).accountModels

const model = (value: string, label: string, efforts?: string[]): CatalogModel => ({ value, label, ...(efforts ? { efforts } : {}) })
const read = (...models: CatalogModel[]): CatalogRead => ({ models })

/** What the faked listing says, per account folder (lower-cased): a function, to hold it or fail it. */
const listing = new Map<string, () => Promise<CatalogRead | null>>()
const listed: string[] = []
/** A promise and its release, to hold a step until the test lets it go. */
function gate<T = void>(): { wait: Promise<T>; open: (v: T) => void } {
  let open!: (v: T) => void
  const wait = new Promise<T>((r) => (open = r))
  return { wait, open }
}
/** Waits for a condition (a microtask turn at a time), bounded for a hung run. */
async function until(fn: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !fn(); i++) await new Promise((r) => setTimeout(r, 1))
  if (!fn()) throw new Error(`never: ${what}`)
}

beforeAll(() => {
  mkdirSync(join(base, 'profile'), { recursive: true })
  advanced.load(join(base, 'profile'))
  mkdirSync(home, { recursive: true })
  config.settings.providers[CLI].enabled = true
  vi.spyOn(provider(CLI), 'accountStatus').mockResolvedValue({ ok: true, loggedIn: false })
  vi.spyOn(provider(CLI), 'listModels').mockImplementation(async (_exe, env) => {
    const dir = (env.CLAUDE_CONFIG_DIR ?? '').toLowerCase()
    listed.push(dir)
    const f = listing.get(dir)
    return f ? f() : null
  })
})
afterAll(() => {
  accounts.stopAccountWatches()
  advanced.stop()
})
beforeEach(() => {
  listing.clear()
  listed.length = 0
  setCli({ found: true, path: 'claude.exe', version: '2.1.321', catalog: { source: 'cli', version: '2.1.321', at: '', models: [model('claude-fable-5-1[1m]', 'Fable')], defaultModel: 'claude-opus-5-5' }, defaultModel: 'claude-opus-5-5', accountCatalogs: {} })
})
afterEach(async () => {
  accounts.accountModelHooks.queued = undefined
  accounts.accountModelHooks.started = undefined
  for (const a of [...(config.get().accounts ?? [])]) await accounts.removeAccount(a.id).catch(() => undefined)
  config.update((c) => void ((c.accounts = []), (c.connections = []), (c.accountModelCatalogs = {})))
})

const folder = (a: Account): string => accounts.accountFolder(a.id).toLowerCase()
/** An account added, once the read its adding starts has settled (it answers nothing here), the listing log cleared. */
async function added(name: string): Promise<Account> {
  const a = await accounts.addAccount(CLI, name)
  await until(() => !!own(a), `${name}'s first read`)
  listed.length = 0
  return a
}
const answers = (a: Account, r: (() => Promise<CatalogRead | null>) | CatalogRead | null): void => void listing.set(folder(a), typeof r === 'function' ? r : async () => r)

describe('the recorded reply (Claude Code 2.1.321, one account’s folder)', () => {
  it('offers Fable 5.2 as fable, with Fable 5.1 beside it, and Opus 5.5 as its default', () => {
    const fable = recorded.models.find((m) => m.value === 'fable')
    expect(fable).toMatchObject({ label: 'Fable 5.2', resolved: 'claude-fable-5-2' })
    expect(recorded.models.find((m) => m.value === 'claude-fable-5-1')?.label).toBe('Fable 5.1')
    expect(recorded.defaultModel).toBe('claude-opus-5-5')
  })
})

describe('accountInfo: one account’s models, never another home’s', () => {
  const p: ModelCatalog = { source: 'cli', version: '1', at: '', models: [model('claude-fable-5-1[1m]', 'Fable')], defaultModel: 'claude-opus-5-5' }
  const a1: ModelCatalog = { source: 'cli', version: '1', at: '', models: recorded.models, defaultModel: 'claude-opus-5-5' }
  const info = { catalog: p, defaultModel: 'claude-opus-5-5', accountCatalogs: { 'a-1': { catalog: a1, defaultModel: 'claude-sonnet-5-5' }, 'a-2': { catalog: null, defaultModel: null } } }
  const signIn = (id: string) => ({ id, kind: 'signIn' as const })

  it('an account read: its catalogue and its own default', () => {
    expect(accountInfo(info, signIn('a-1'))).toMatchObject({ catalog: a1, defaultModel: 'claude-sonnet-5-5' })
  })
  it('an account with nothing read or kept, or not read yet: none, and no default (not the CLI home’s)', () => {
    expect(accountInfo(info, signIn('a-2'))).toMatchObject({ catalog: null, defaultModel: null })
    expect(accountInfo(info, signIn('a-new'))).toMatchObject({ catalog: null, defaultModel: null })
  })
  it('a server account, one on the CLI’s own home, no account, or a CLI whose accounts aren’t read: the info as it is', () => {
    expect(accountInfo(info, { id: 'a-1', kind: 'server' })).toBe(info)
    expect(accountInfo(info, { id: 'a-1', kind: 'signIn', home: 'cli' })).toBe(info)
    expect(accountInfo(info, null)).toBe(info)
    const plain = { catalog: p, defaultModel: 'x' }
    expect(accountInfo(plain, signIn('a-1'))).toBe(plain)
  })
  it('a connection’s picker lists its account’s models: Fable 5.2 for the one offering it, not for the other', () => {
    const names = (id: string) => modelGroups(CLI, connectionModels({ id, kind: 'signIn' }, info), null).flatMap((g) => g.models.map((m) => m.label))
    expect(names('a-1').some((l) => l.includes('Fable 5.2'))).toBe(true)
    expect(names('a-2').some((l) => l.includes('Fable 5.2'))).toBe(false)
  })
})

describe('reading each account’s models in its own folder', () => {
  it('reads each in its folder, keeps and publishes each its own; the CLI’s own catalogue stays', async () => {
    const a = await added('Two')
    const b = await added('One')
    answers(a, recorded)
    answers(b, read(model('claude-fable-5-1', 'Fable 5.1')))
    await Promise.all([accounts.readAccountModels(a.id), accounts.readAccountModels(b.id)])
    expect(listed.sort()).toEqual([folder(a), folder(b)].sort())
    expect(own(a)?.catalog?.models.find((m) => m.value === 'fable')?.label).toBe('Fable 5.2')
    expect(own(a)?.defaultModel).toBe('claude-opus-5-5')
    expect(own(b)?.catalog?.models.map((m) => m.value)).toEqual(['claude-fable-5-1'])
    expect(config.get().accountModelCatalogs?.[a.id]?.version).toBe('2.1.321')
    expect(providerService.info(CLI).catalog?.models[0].value).toBe('claude-fable-5-1[1m]')
  })

  it('a default its folder’s settings name wins over its catalogue’s, and isn’t another account’s', async () => {
    const a = await added('Set')
    const b = await added('Unset')
    writeFileSync(join(accounts.accountFolder(a.id), 'settings.json'), JSON.stringify({ model: 'claude-fable-5-2' }))
    answers(a, recorded)
    answers(b, read(model('sonnet', 'Sonnet')))
    await Promise.all([accounts.readAccountModels(a.id), accounts.readAccountModels(b.id)])
    expect(own(a)?.defaultModel).toBe('claude-fable-5-2')
    // b's catalogue names no default and its folder none: unknown, not a's nor the CLI home's.
    expect(own(b)?.defaultModel).toBeNull()
  })

  it('a failed read keeps its own last answer for this version, never another account’s; a new version, none', async () => {
    const a = await added('Kept')
    const b = await added('Never')
    answers(a, recorded)
    await accounts.readAccountModels(a.id)
    answers(a, null)
    answers(b, null)
    await Promise.all([accounts.readAccountModels(a.id), accounts.readAccountModels(b.id)])
    expect(own(a)?.catalog).toMatchObject({ source: 'cache', version: '2.1.321' })
    expect(own(b)?.catalog).toBeNull()
    // Another version of the CLI: the last answer was another version's.
    setCli({ version: '2.1.322' })
    await accounts.readAccountModels(a.id)
    expect(own(a)?.catalog).toBeNull()
  })

  it('the CLI’s check starts every eligible account’s read without awaiting it: a slow one doesn’t hold a usable one', async () => {
    const slow = await added('Slow')
    const quick = await added('Quick')
    const held = gate<CatalogRead | null>()
    answers(slow, () => held.wait)
    answers(quick, read(model('fable', 'Fable 5.2')))
    expect(source.refresh(CLI)).toBeUndefined()
    await until(() => !!own(quick)?.catalog, "the quick account's models published")
    expect(own(slow)?.catalog).toBeNull()
    held.open(read(model('opus', 'Opus')))
    await until(() => !!own(slow)?.catalog, "the slow account's models published")
    expect(own(slow)?.catalog?.models[0].value).toBe('opus')
  })

  it('coalesces: requests while one runs run it once more after it, never once each', async () => {
    const a = await added('Busy')
    const first = gate<CatalogRead | null>()
    let n = 0
    answers(a, () => (++n === 1 ? first.wait : Promise.resolve(read(model('fable', 'Fable 5.2')))))
    const running = accounts.readAccountModels(a.id)
    await until(() => n === 1, 'the first read started')
    void accounts.readAccountModels(a.id)
    void accounts.readAccountModels(a.id)
    first.open(read(model('claude-fable-5-1', 'Fable 5.1')))
    await running
    expect(n).toBe(2)
    expect(own(a)?.catalog?.models[0].value).toBe('fable')
  })

  it('removed while its read waits its turn: nothing is read, kept or published for it', async () => {
    const a = await added('Queued')
    answers(a, read(model('fable', 'Fable 5.2')))
    const held = gate()
    let waiting = false
    accounts.accountModelHooks.queued = async () => {
      waiting = true
      await held.wait
    }
    const r = accounts.readAccountModels(a.id)
    await until(() => waiting, 'the read waiting its turn')
    await accounts.removeAccount(a.id)
    held.open()
    await r
    expect(listed).toEqual([])
    expect(own(a)).toBeUndefined()
    expect(config.get().accountModelCatalogs?.[a.id]).toBeUndefined()
  })

  it('removed while its CLI answers: the answer is dropped, not brought back', async () => {
    const a = await added('Inflight')
    const held = gate<CatalogRead | null>()
    answers(a, () => held.wait)
    const r = accounts.readAccountModels(a.id)
    await until(() => listed.length === 1, 'its CLI asked')
    await accounts.removeAccount(a.id)
    held.open(read(model('fable', 'Fable 5.2')))
    await r
    expect(own(a)).toBeUndefined()
    expect(config.get().accountModelCatalogs?.[a.id]).toBeUndefined()
  })

  it('the CLI changing while it answers (another version found): the older answer is dropped', async () => {
    const a = await added('Moved')
    const held = gate<CatalogRead | null>()
    answers(a, () => held.wait)
    const r = accounts.readAccountModels(a.id)
    await until(() => listed.length === 1, 'its CLI asked')
    setCli({ version: '2.1.322' })
    held.open(read(model('fable', 'Fable 5.2')))
    await r
    expect(own(a)?.catalog).toBeNull()
    expect(config.get().accountModelCatalogs?.[a.id]).toBeUndefined()
  })

  it('the checks take the account’s own models: an effort its model takes there is usable, as the CLI home’s list says not', async () => {
    const a = await added('Efforts')
    setCli({ catalog: { source: 'cli', version: '2.1.321', at: '', models: [model('opus', 'Opus', ['low'])] } })
    answers(a, read(model('opus', 'Opus', ['low', 'max'])))
    await accounts.readAccountModels(a.id)
    expect(accounts.effortUsable(CLI, 'opus', a, 'max')).toBe(true)
    expect(accounts.effortUsable(CLI, 'opus', null, 'max')).toBe(false)
  })

  it('at start, each account’s kept catalogue of this version, with its folder’s default', async () => {
    const a = await added('Cached')
    answers(a, recorded)
    await accounts.readAccountModels(a.id)
    expect(source.cached(CLI, '2.1.321')?.[a.id]).toMatchObject({ catalog: { source: 'cache' }, defaultModel: 'claude-opus-5-5' })
    expect(source.cached(CLI, '2.1.322')?.[a.id]).toMatchObject({ catalog: null })
  })
})
