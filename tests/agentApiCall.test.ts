// The hive MCP server's Agent API calls (#371): Node's http rather than fetch, whose 300 s limit on a reply's headers
// cut waits short. Against a fake slow server: a reply whose headers come late still arrives; the call's own deadline
// is the only limit, and ends the request; errors and the request itself come through as before.
import { createServer, type IncomingMessage, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { agentApiCall } from '../src/main/mcp/agentApiCall'
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

/** A server answering each request after `delayMs` (headers included), recording what it got and when a client left. */
async function slowServer(delayMs: number, status = 200, reply = '{"ok":true}'): Promise<{ url: string; got: { method?: string; headers: IncomingMessage['headers']; body: string }[]; closed: number[] }> {
  const got: { method?: string; headers: IncomingMessage['headers']; body: string }[] = []
  const closed: number[] = []
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      got.push({ method: req.method, headers: req.headers, body })
      const t = setTimeout(() => {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json')
        res.end(reply)
      }, delayMs)
      res.on('close', () => {
        clearTimeout(t)
        if (!res.writableFinished) closed.push(Date.now())
      })
    })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, got, closed }
}

describe('agentApiCall (#371)', () => {
  it('waits for headers as long as its deadline allows, sending the method, headers and body', async () => {
    const s = await slowServer(1200, 200, '{"changes":[]}')
    const started = Date.now()
    const r = await agentApiCall(`${s.url}/v1/tasks/wait`, 'POST', { Authorization: 'Bearer t', 'Content-Type': 'application/json', 'X-Hive-Workspace': 'C%3A%5Cws' }, JSON.stringify({ cards: [3], timeoutSeconds: 600 }), 10_000)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1100)
    expect(r).toEqual({ status: 200, text: '{"changes":[]}' })
    expect(s.got[0]).toMatchObject({ method: 'POST', body: '{"cards":[3],"timeoutSeconds":600}' })
    expect(s.got[0].headers).toMatchObject({ authorization: 'Bearer t', 'content-type': 'application/json', 'x-hive-workspace': 'C%3A%5Cws', 'content-length': '34' })
  })

  it('a reply later than its deadline fails, saying so, and the request ends (the server sees it go)', async () => {
    const s = await slowServer(3000)
    await expect(agentApiCall(`${s.url}/v1/agents/wait`, 'POST', {}, '{}', 300)).rejects.toThrow("Combwork didn't reply within 1 s")
    await expect.poll(() => s.closed.length, { timeout: HUNG_MS }).toBe(1)
  })

  it('an error status comes back as the status and text (api() turns it into its error), and a GET has no body', async () => {
    const s = await slowServer(0, 404, '{"error":"Unknown card #9"}')
    expect(await agentApiCall(`${s.url}/v1/tasks/9`, 'GET', {}, undefined)).toEqual({ status: 404, text: '{"error":"Unknown card #9"}' })
    expect(s.got[0]).toMatchObject({ method: 'GET', body: '' })
    expect(s.got[0].headers['content-length']).toBeUndefined()
  })

  it('no Combwork listening: the call fails at once', async () => {
    const s = await slowServer(0)
    const url = s.url
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
    await expect(agentApiCall(`${url}/v1/projects`, 'GET', {}, undefined, 5000)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('text in any language arrives whole, however the reply is split', async () => {
    const reply = JSON.stringify({ title: 'Ünïcödé — ✓ '.repeat(5000) })
    const s = await slowServer(0, 200, reply)
    expect((await agentApiCall(`${s.url}/v1/tasks/1`, 'GET', {}, undefined)).text).toBe(reply)
  })

  it("passes on Combwork's X-Hive-Notice header (#357's new-decision flag), still encoded", async () => {
    const line = encodeURIComponent('[CW] #4 has 1 new decision since you last read it: read the card (cw_read_task) at your next checkpoint.')
    server = createServer((_req, res) => {
      res.setHeader('X-Hive-Notice', line)
      res.end('{}')
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
    expect(await agentApiCall(`${url}/v1/projects/alpha`, 'GET', {}, undefined)).toEqual({ status: 200, text: '{}', notice: line })
  })
})
