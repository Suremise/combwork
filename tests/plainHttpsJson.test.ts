// plainHttpsJson (#1582): the version checks' GET, which never lets a network reply reach a decoder. It asks for an
// unencoded reply and refuses an encoded one; and the three version checks use it, answering null when it fails.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { plainHttpsJson } from '../src/main/plainHttpsJson'

type Handler = (req: IncomingMessage, res: ServerResponse) => void
const routes = new Map<string, Handler>()
const seen: IncomingMessage[] = []
let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req)
    const handler = routes.get(req.url ?? '')
    if (handler) handler(req, res)
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function json(body: unknown, headers: Record<string, string> = {}): Handler {
  return (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body))
}

describe('plainHttpsJson', () => {
  it('asks for an unencoded reply, with fetch’s caller headers and the caller’s own, and parses it', async () => {
    routes.set('/plain', json({ version: '1.2.3' }))
    expect(await plainHttpsJson(`${base}/plain`, { headers: { Accept: 'application/vnd.github+json' } })).toEqual({ version: '1.2.3' })
    const req = seen.filter((r) => r.url === '/plain').at(-1)!
    expect(req.headers['accept-encoding']).toBe('identity')
    expect(req.headers['user-agent']).toBe('node')
    expect(req.headers.accept).toBe('application/vnd.github+json')
  })

  it('keeps Accept-Encoding identity even when a caller asks for another', async () => {
    routes.set('/asked', json({ ok: true }))
    await plainHttpsJson(`${base}/asked`, { headers: { 'Accept-Encoding': 'br' } })
    expect(seen.filter((r) => r.url === '/asked').at(-1)!.headers['accept-encoding']).toBe('identity')
  })

  it('takes a reply marked identity', async () => {
    routes.set('/identity', json({ a: 1 }, { 'Content-Encoding': 'identity' }))
    expect(await plainHttpsJson(`${base}/identity`)).toEqual({ a: 1 })
  })

  it.each(['br', 'gzip', 'deflate', 'gzip, br'])('refuses a reply encoded %s, without reading it', async (encoding) => {
    const path = `/encoded-${encoding.replace(/\W/g, '')}`
    // Not valid in that encoding: the point is that nothing tries to decode it.
    routes.set(path, (_req, res) => res.writeHead(200, { 'Content-Encoding': encoding }).end('\x1b\x00garbage'))
    await expect(plainHttpsJson(`${base}${path}`)).rejects.toThrow(/encoded reply/)
  })

  it('refuses a body over the limit', async () => {
    routes.set('/big', json({ pad: 'x'.repeat(4096) }))
    await expect(plainHttpsJson(`${base}/big`, { maxBytes: 1024 })).rejects.toThrow(/over 1024 bytes/)
  })

  it('gives up when the whole reply hasn’t come in time', async () => {
    // Headers sent, the body never finished: the deadline covers the body too.
    routes.set('/hang', (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).write('{"version":'))
    await expect(plainHttpsJson(`${base}/hang`, { timeoutMs: 200 })).rejects.toThrow(/No reply within/)
  })

  it('rejects a status other than 2xx, and JSON that doesn’t parse', async () => {
    routes.set('/missing', (_req, res) => res.writeHead(404).end('{}'))
    routes.set('/notjson', (_req, res) => res.writeHead(200).end('<html>'))
    await expect(plainHttpsJson(`${base}/missing`)).rejects.toThrow(/HTTP 404/)
    await expect(plainHttpsJson(`${base}/notjson`)).rejects.toThrow()
  })

  it('follows a redirect, as fetch did, and checks the reply it ends at', async () => {
    routes.set('/moved', (_req, res) => res.writeHead(301, { Location: '/plain' }).end())
    routes.set('/moved-br', (_req, res) => res.writeHead(302, { Location: '/encoded-br' }).end())
    routes.set('/loop', (_req, res) => res.writeHead(302, { Location: '/loop' }).end())
    expect(await plainHttpsJson(`${base}/moved`)).toEqual({ version: '1.2.3' })
    await expect(plainHttpsJson(`${base}/moved-br`)).rejects.toThrow(/encoded reply/)
    await expect(plainHttpsJson(`${base}/loop`)).rejects.toThrow(/Too many redirects/)
  })

  it('refuses a URL that isn’t http(s)', async () => {
    await expect(plainHttpsJson('file:///C:/x.json')).rejects.toThrow(/Not an http/)
  })
})

describe('the version checks', () => {
  it('ask through plainHttpsJson, with their headers and timeouts, and answer null when it fails', async () => {
    vi.resetModules()
    const calls: { url: string; opts: unknown }[] = []
    let reply: () => Promise<unknown> = async () => ({})
    vi.doMock('../src/main/plainHttpsJson', () => ({
      plainHttpsJson: (url: string, opts: unknown) => {
        calls.push({ url, opts })
        return reply()
      }
    }))
    try {
      const { claudeCode } = await import('../src/main/providers/claude/adapter')
      const { codex } = await import('../src/main/providers/codex/adapter')
      const { copilotLatestVersion } = await import('../src/main/providers/copilot/install')

      reply = async () => ({ version: '2.1.300', tag_name: 'rust-v0.130.1' })
      expect(await claudeCode.latestVersion()).toBe('2.1.300')
      expect(await codex.latestVersion()).toBe('0.130.1')
      expect(await copilotLatestVersion()).toBe('2.1.300')
      expect(calls).toEqual([
        { url: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest', opts: { timeoutMs: 6000 } },
        { url: 'https://api.github.com/repos/openai/codex/releases/latest', opts: { timeoutMs: 6000, headers: { Accept: 'application/vnd.github+json' } } },
        { url: expect.stringMatching(/^https:\/\/registry\.npmjs\.org\/.+\/latest$/), opts: { timeoutMs: 6000 } }
      ])

      reply = () => Promise.reject(new Error('Refused an encoded reply (br)'))
      expect(await claudeCode.latestVersion()).toBeNull()
      expect(await codex.latestVersion()).toBeNull()
      expect(await copilotLatestVersion()).toBeNull()
    } finally {
      vi.doUnmock('../src/main/plainHttpsJson')
      vi.resetModules()
    }
  })
})
