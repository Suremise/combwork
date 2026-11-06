/**
 * One Agent API call from the combwork MCP server (#371), with Node's own http/https rather than the global fetch: fetch
 * (undici) gives up on a reply whose headers take over 300 s, and the Agent API sends its headers only when a wait
 * ends, so a wait of up to 840 s failed after 300. Here the only limit is the call's own deadline, which a wait sets
 * past its longest. Node built-ins only: cw-mcp.js runs outside the asar (AGENTS.md).
 */
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'

export interface ApiReply {
  status: number
  text: string
  /** Combwork's X-Combwork-Notice header (#357: a new decision on the caller's card), URL-encoded, when it sent one. */
  notice?: string
}

/** How long a call that isn't a wait may take, as fetch allowed before. */
export const REPLY_MS = 300_000

/**
 * How long a stop waits for the user's answer (HI-1994): less than a call may take (REPLY_MS), so the caller hears it
 * timed out, rather than "Combwork didn't reply" with the question left open.
 */
export const STOP_ASK_MS = REPLY_MS - 30_000

/** Sends a request and reads the whole reply; rejects if it hasn't all come within `replyMs`, or can't be sent. */
export function agentApiCall(url: string, method: string, headers: Record<string, string>, body: string | undefined, replyMs = REPLY_MS): Promise<ApiReply> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest
    const data = body === undefined ? undefined : Buffer.from(body, 'utf8')
    const req = send(u, { method, headers: { ...headers, ...(data ? { 'Content-Length': String(data.length) } : {}) } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        clearTimeout(deadline)
        const notice = res.headers['x-combwork-notice']
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), ...(typeof notice === 'string' && notice ? { notice } : {}) })
      })
      res.on('error', fail)
    })
    function fail(e: Error): void {
      clearTimeout(deadline)
      reject(e)
    }
    const deadline = setTimeout(() => req.destroy(new Error(`Combwork didn't reply within ${Math.ceil(replyMs / 1000)} s`)), replyMs)
    req.on('error', fail)
    req.end(data)
  })
}
