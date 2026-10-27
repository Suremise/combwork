// A server connection's rules (HI-1772, shared/serverConnection.ts): which base URLs are taken and which are this PC's,
// what a key and a model id may be, how models stand in for the CLI's aliases, and a model listing's reply.
import { describe, expect, it } from 'vitest'
import { aliasModels, cleanModels, isLoopbackHost, keyProblem, keepListedRemote, listedIds, listedRemote, listingUrl, LISTED_MAX, mergeListed, parseBaseUrl, serverDefaultModel, serverModelOf, withRemote } from '../src/shared/serverConnection'
import { providerDescriptor } from '../src/shared/providers'
import { serverModelLabel } from '../src/shared/models'

describe('a base URL (parseBaseUrl)', () => {
  it('https anywhere, its trailing slashes dropped, its origin what a key is bound to', () => {
    expect(parseBaseUrl('https://api.deepseek.com/anthropic/')).toEqual({ ok: true, url: 'https://api.deepseek.com/anthropic', origin: 'https://api.deepseek.com', local: false })
    expect(parseBaseUrl('  https://gw.example.com:8443  ')).toMatchObject({ ok: true, origin: 'https://gw.example.com:8443' })
  })
  it('http only to this PC: localhost, 127.0.0.0/8 (as the URL parser writes it) and [::1]', () => {
    for (const u of ['http://localhost:11434', 'http://127.0.0.1:8080/x', 'http://127.5.6.7', 'http://[::1]:1234', 'http://2130706433/', 'http://LOCALHOST']) expect(parseBaseUrl(u), u).toMatchObject({ ok: true, local: true })
    for (const u of ['http://localhost.example.com', 'http://127.0.0.1.nip.io', 'http://[::ffff:7f00:1]', 'http://10.0.0.1', 'http://example.com']) expect(parseBaseUrl(u), u).toEqual({ ok: false, why: 'remoteHttp' })
    expect(isLoopbackHost('127.0.0.256')).toBe(false)
  })
  it('no user name or password, query or fragment (a key would be kept in config), nor another scheme', () => {
    expect(parseBaseUrl('http://127.0.0.1@evil.example.com')).toEqual({ ok: false, why: 'userinfo' })
    expect(parseBaseUrl('https://user:pw@api.example.com')).toEqual({ ok: false, why: 'userinfo' })
    expect(parseBaseUrl('https://api.example.com/?key=abc')).toEqual({ ok: false, why: 'extra' })
    expect(parseBaseUrl('https://api.example.com/#k')).toEqual({ ok: false, why: 'extra' })
    expect(parseBaseUrl('https://api.example.com/?')).toEqual({ ok: false, why: 'extra' })
    expect(parseBaseUrl('ftp://api.example.com')).toEqual({ ok: false, why: 'scheme' })
    expect(parseBaseUrl('api.example.com')).toEqual({ ok: false, why: 'invalid' })
  })
})

describe('a key and model ids', () => {
  it('a key: printable ASCII, no spaces, 16 to 512 characters', () => {
    expect(keyProblem('Zq!7#mP2&vL9^tR4')).toBeNull()
    expect(keyProblem('short')).toBe('length')
    expect(keyProblem('x'.repeat(513))).toBe('length')
    expect(keyProblem('has a space in it!!')).toBe('chars')
    expect(keyProblem('line\nbreak-0123456789')).toBe('chars')
    expect(keyProblem('ünïcödé-0123456789')).toBe('chars')
  })
  it('models made consistent: valid ids once each, each alias on one model (its first), a model on several', () => {
    const m = cleanModels([{ id: 'a', as: ['opus', 'sonnet'] }, { id: 'a', as: ['haiku'] }, { id: 'b', as: ['opus', 'haiku'] }, { id: 'bad id' }, { id: 'c[1m]' }])
    expect(m).toEqual([{ id: 'a', as: ['opus', 'sonnet'] }, { id: 'b', as: ['haiku'] }, { id: 'c[1m]' }])
    expect(aliasModels(m)).toEqual({ opus: 'a', sonnet: 'a', haiku: 'b' })
    expect(serverDefaultModel(m)).toBe('a')
    expect(serverDefaultModel([{ id: 'x' }, { id: 'y', as: ['sonnet'] }])).toBe('y')
    expect(serverDefaultModel([{ id: 'x' }])).toBe('x')
  })
})

describe('the model a session reports (serverModelOf)', () => {
  const models = [{ id: 'deepseek-flash[1m]', as: ['opus' as const, 'sonnet' as const] }, { id: 'deepseek-flash', as: ['haiku' as const] }, { id: 'deepseek-v4-pro' }]
  it('its own id, exactly first, then without a suffix the CLI drops', () => {
    expect(serverModelOf(models, 'deepseek-flash')).toEqual({ id: 'deepseek-flash', as: ['haiku'] })
    expect(serverModelOf(models, 'deepseek-flash[1m]')).toEqual({ id: 'deepseek-flash[1m]', as: ['opus', 'sonnet'] })
    expect(serverModelOf(models, 'deepseek-v4-pro')).toEqual({ id: 'deepseek-v4-pro', as: [] })
  })
  it("a Claude name it reports is its alias's model; an id it doesn't know is itself", () => {
    expect(serverModelOf(models, 'claude-sonnet-5-5')).toEqual({ id: 'deepseek-flash[1m]', as: ['opus', 'sonnet'] })
    expect(serverModelOf(models, 'claude-haiku-5-5')).toEqual({ id: 'deepseek-flash', as: ['haiku'] })
    expect(serverModelOf(models, 'other-model')).toEqual({ id: 'other-model', as: [] })
  })
})

describe('a model listing', () => {
  const caps = providerDescriptor('claude-code').capabilities.connections!.server!
  it("its URL: a preset's path from the origin, else under the base URL", () => {
    const deepseek = caps.presets.find((p) => p.id === 'deepseek')!
    expect(listingUrl('https://api.deepseek.com/anthropic', deepseek.listing!)).toBe('https://api.deepseek.com/models')
    expect(listingUrl('http://localhost:11434', caps.presets.find((p) => p.id === 'ollama')!.listing!)).toBe('http://localhost:11434/api/tags')
    expect(listingUrl('https://gw.example.com/v2', caps.listing)).toBe('https://gw.example.com/v2/v1/models')
  })
  it("its reply's ids: valid ones once each, at most LISTED_MAX; not that shape, null", () => {
    expect(listedIds({ data: [{ id: 'a' }, { id: 'a' }, { id: 'bad id' }, { id: 7 }, { id: 'b' }] }, caps.listing)).toEqual(['a', 'b'])
    expect(listedIds({ models: [{ name: 'qwen3:8b' }] }, { path: '/api/tags', list: 'models', id: 'name' })).toEqual(['qwen3:8b'])
    expect(listedIds({ data: Array.from({ length: 900 }, (_, i) => ({ id: `m${i}` })) }, caps.listing)).toHaveLength(LISTED_MAX)
    expect(listedIds({ nope: [] }, caps.listing)).toBeNull()
    expect(listedIds('text', caps.listing)).toBeNull()
  })
  it('read again: mappings of ids still listed kept, the others dropped and said', () => {
    expect(mergeListed([{ id: 'a', as: ['opus'] }, { id: 'gone', as: ['haiku'] }], ['a', 'new'])).toEqual({ models: [{ id: 'a', as: ['opus'] }, { id: 'new' }], dropped: ['gone'] })
  })
})

describe("the descriptor's presets (vendor docs, 27 Oct 2026)", () => {
  const caps = providerDescriptor('claude-code').capabilities.connections!.server!
  it('Claude Code sends the key as a bearer token, and a placeholder that is not secret for a local server', () => {
    expect(caps.keyEnv).toBe('ANTHROPIC_AUTH_TOKEN')
    expect(caps.baseUrlEnv).toBe('ANTHROPIC_BASE_URL')
    expect(caps.keylessToken).toBe('none')
  })
  it("DeepSeek's: its Anthropic base URL and its guide's models; Ollama's: this PC, no key, models listed", () => {
    const deepseek = caps.presets.find((p) => p.id === 'deepseek')!
    expect(parseBaseUrl(deepseek.baseUrl)).toMatchObject({ ok: true, local: false })
    expect(aliasModels(cleanModels([...deepseek.models!]))).toEqual({ opus: 'deepseek-flash[1m]', sonnet: 'deepseek-flash[1m]', haiku: 'deepseek-flash' })
    const ollama = caps.presets.find((p) => p.id === 'ollama')!
    expect(parseBaseUrl(ollama.baseUrl)).toMatchObject({ ok: true, local: true })
    expect(ollama.keyless && !ollama.models && !!ollama.listing).toBe(true)
  })
  it("Ollama's, per its Claude Code guide (HI-1773): its cloud models marked by the listing, a 64K context recommended, the guide linked", () => {
    const ollama = caps.presets.find((p) => p.id === 'ollama')!
    expect(ollama.listing).toEqual({ path: '/api/tags', list: 'models', id: 'name', remote: 'remote_host' })
    expect(ollama.remoteModels).toBe('claude-code.connections.remoteModels')
    expect(ollama.contextAdvice).toBe(64_000)
    expect(ollama.docs).toBe('https://docs.ollama.com/integrations/claude-code')
  })
})

describe('models a server runs elsewhere (HI-1773: Ollama cloud models)', () => {
  const listing = providerDescriptor('claude-code').capabilities.connections!.server!.presets.find((p) => p.id === 'ollama')!.listing!
  it('a listing marks those whose remote field is set, by name as listed; none without a remote field', () => {
    const reply = { models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }, { name: 'mine', remote_model: 'gpt-oss:120b', remote_host: 'https://ollama.com:443' }, { name: 'empty', remote_host: ' ' }, { name: 7, remote_host: 'x' }] }
    expect(listedRemote(reply, listing)).toEqual(['mine'])
    expect(listedRemote(reply, { ...listing, remote: undefined })).toEqual([])
    expect(listedRemote('text', listing)).toEqual([])
  })
  it('kept by cleanModels; a reading says each afresh, the mappings kept', () => {
    expect(cleanModels([{ id: 'a', remote: true }, { id: 'b', remote: 'yes' as never }])).toEqual([{ id: 'a', remote: true }, { id: 'b' }])
    const before = [{ id: 'a', as: ['opus' as const], remote: true as const }, { id: 'b' }]
    expect(mergeListed(before, ['a', 'b'], (id) => id === 'b').models).toEqual([{ id: 'a', as: ['opus'] }, { id: 'b', remote: true }])
  })
  it("saved from a form: the listing's mark it had stays, the window's own ignored, no pattern saved", () => {
    const before = [{ id: 'mine', remote: true as const }, { id: 'qwen3:8b' }]
    const sent = [{ id: 'mine', as: ['opus' as const] }, { id: 'qwen3:8b', remote: true as const }, { id: ' x:cloud ' }]
    expect(keepListedRemote(sent, before)).toEqual([{ id: 'mine', as: ['opus'], remote: true }, { id: 'qwen3:8b' }, { id: 'x:cloud' }])
  })
  it('as they run: the listing\'s marks, and the pattern as it is now (round 1)', () => {
    const saved = [{ id: 'mine', remote: true as const }, { id: 'qwen3:8b', as: ['opus' as const] }, { id: 'x:cloud' }]
    expect(withRemote(saved, (id: string) => id.endsWith(':cloud'))).toEqual([{ id: 'mine', remote: true }, { id: 'qwen3:8b', as: ['opus'] }, { id: 'x:cloud', remote: true }])
    expect(withRemote(saved, () => false)).toEqual(saved)
  })
  it('the footer and the pickers say cloud', () => {
    expect(serverModelOf([{ id: 'glm-4.6:cloud', as: ['opus'], remote: true }], 'claude-opus-5-5')).toEqual({ id: 'glm-4.6:cloud', as: ['opus'], remote: true })
    expect(serverModelLabel('glm-4.6:cloud', ['opus', 'sonnet'], undefined, true)).toBe('glm-4.6:cloud (cloud, as Opus, Sonnet)')
    expect(serverModelLabel('mine', [], undefined, true)).toBe('mine (cloud)')
    expect(serverModelLabel('qwen3:8b', [])).toBe('qwen3:8b')
  })
})
