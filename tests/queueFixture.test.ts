// The merge queue's e2e fixture (tests/e2e/queueFixture.cjs): Release Slot on a slot a Combwork that ended at a seam left
// held (`releaseHeld`). HI-2177: Combwork may free that writer itself meanwhile (HI-2055), so a refusal counts as released
// only once a read shows that run no longer holds the slot (HR2's round 1).
import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const req = createRequire(import.meta.url)
const { releaseHeld } = req('./e2e/queueFixture.cjs') as { releaseHeld: (fx: { alpha: string }, h: { inv: (channel: string, ...args: unknown[]) => Promise<unknown> }) => Promise<string[]> }

const fx = { alpha: 'C:\\ws\\alpha' }
const refused = new Error('slot-a changed meanwhile: its writer is no longer the one shown. Look again.')

/** A window whose slot-a is held by run r-1: its release refused; `after`, what reading its writer again gives. */
function heldWindow(after: () => Promise<unknown>) {
  let reads = 0
  return {
    inv: async (channel: string): Promise<unknown> => {
      if (channel === 'slots:list') return [{ name: 'slot-a', writer: { held: true } }]
      if (channel === 'slots:heldWriter') return reads++ === 0 ? { run: 'r-1' } : after()
      if (channel === 'slots:releaseWriter') throw refused
      throw new Error(`unexpected ${channel}`)
    }
  }
}

describe("the queue fixture's Release Slot (HI-2177)", () => {
  it('refused, the writer then gone or another run: released (Combwork freed it itself)', async () => {
    expect(await releaseHeld(fx, heldWindow(async () => null))).toEqual(['slot-a'])
    expect(await releaseHeld(fx, heldWindow(async () => ({ run: 'r-2' })))).toEqual(['slot-a'])
  })

  it('refused, the same run still holding it: the release’s own error', async () => {
    await expect(releaseHeld(fx, heldWindow(async () => ({ run: 'r-1' })))).rejects.toBe(refused)
  })

  it('refused, its writer unreadable: that error, never taken as released', async () => {
    const unreadable = new Error('the board could not be read')
    await expect(
      releaseHeld(
        fx,
        heldWindow(async () => {
          throw unreadable
        })
      )
    ).rejects.toBe(unreadable)
  })
})

// HI-2740: an agent a workflow change restarted (HI-2694: its tool list changed) has a new launch, and its old token is
// refused. act() reads the new run's token and sends the intent again; it never retries anything but a 401.
describe("the queue fixture's act (HI-2740)", () => {
  type Who = { id: string; token: string | null }
  const { act } = req('./e2e/queueFixture.cjs') as {
    act: (fx: object, h: object, who: Who, n: number, name: string, body?: object) => Promise<{ status: number; body: unknown }>
  }
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** A workspace whose agent a-1 runs as `run`, its launch's token `token` (the files liveToken reads). */
  function launched(run: string, token: string) {
    const home = tempDir('queue-act')
    const dir = path.join(home, run)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'token.json'), JSON.stringify({ token }))
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { combwork: { env: { CW_API_TOKEN_FILE: path.join(dir, 'token.json') } } } }))
    fs.writeFileSync(path.join(home, 'fake-launches.jsonl'), JSON.stringify({ opts: { '--mcp-config': path.join(dir, 'mcp.json') } }) + '\n')
    const at = { alpha: 'C:\\ws\\alpha', claudeHome: home }
    const h = { port: 1, inv: async () => [{ projectPath: at.alpha, agentId: 'a-1', runId: run }] }
    return { at, h }
  }
  /** Agent API replies: 200 for `valid`, 401 otherwise; the tokens sent, in order. */
  function api(valid: string) {
    const sent: string[] = []
    globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      const token = init.headers.Authorization.replace('Bearer ', '')
      sent.push(token)
      return new Response(JSON.stringify(token === valid ? { ok: true } : { error: 'Missing or invalid bearer token' }), { status: token === valid ? 200 : 401 })
    }) as typeof fetch
    return sent
  }

  it("refused (401) after a restart: sent again with the new run's token, kept in who", async () => {
    const { at, h } = launched('run-2', 'new')
    const sent = api('new')
    const who: Who = { id: 'a-1', token: 'old' }
    expect((await act(at, h, who, 7, 'verdict', { pass: true })).status).toBe(200)
    expect(sent).toEqual(['old', 'new'])
    expect(who.token).toBe('new')
  })

  it('its token still good: sent once', async () => {
    const { at, h } = launched('run-1', 'same')
    const sent = api('same')
    expect((await act(at, h, { id: 'a-1', token: 'same' }, 7, 'start-review')).status).toBe(200)
    expect(sent).toEqual(['same'])
  })

  it('another refusal (not a 401): returned as it is, never sent again', async () => {
    const { at, h } = launched('run-1', 'same')
    const sent: string[] = []
    globalThis.fetch = (async () => {
      sent.push('x')
      return new Response(JSON.stringify({ error: 'refused', rule: 'review.self' }), { status: 409 })
    }) as unknown as typeof fetch
    const r = await act(at, h, { id: 'a-1', token: 'same' }, 7, 'verdict')
    expect(r.status).toBe(409)
    expect(sent).toHaveLength(1)
  })
})
