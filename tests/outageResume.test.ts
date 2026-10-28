// Resuming agents after a connection drops (HI-1612): which failed turns count as a dropped connection (each CLI's
// recorded words; never a usage limit, a sign-in or "overloaded"), the checks backing off, the resume and its note, the
// wait's limit, the stop after three resumes in an hour, the switch, and the reachability check itself.
import { createServer, type Server } from 'http'
import { createServer as createNetServer } from 'net'
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { advancedDef, outagePatternId, OUTAGE_NOT_CONNECTION } from '../src/shared/advanced'
import type { ProviderId } from '../src/shared/types'
import { checkDelay, connectionDropped, OutageResume, reachable, resumeNote, type OutageAgent, type OutageEnd, type OutageHost } from '../src/main/outageCore'

const ROOT = join(__dirname, '..')
const fixture = (name: string): string => readFileSync(join(ROOT, 'tests/fixtures/advanced', name), 'utf8')
/** The defaults, as Hive reads them with no override. */
const pattern = (id: string): RegExp => {
  const d = advancedDef(id)!
  return new RegExp(d.default as string, d.flags ?? '')
}
const dropped = (provider: ProviderId, words: string): boolean => connectionDropped(provider, words, pattern)

describe('a dropped connection, by what the CLI said (connectionDropped)', () => {
  it("reads each CLI's recorded connection errors", () => {
    const claude = JSON.parse(fixture('stopfailure-connection-claude-2.1.312.json'))
    expect(dropped('claude-code', claude.refused.hook.last_assistant_message)).toBe(true)
    expect(dropped('claude-code', claude.notFound.hook.last_assistant_message)).toBe(true)
    const codex = fixture('turn-failed-codex-0.164.0.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(dropped('codex', codex.find((r) => r.payload?.error).payload.error.message)).toBe(true)
    for (const line of fixture('connection-error-copilot-1.0.105.jsonl').split('\n').filter(Boolean)) expect(dropped('copilot', JSON.parse(line).data.message)).toBe(true)
  })

  it.each([
    ['a usage limit', 'claude-code', "Claude AI usage limit reached|1792990800. You've hit your limit · resets 3pm"],
    ['a rate limit', 'claude-code', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'],
    ['an overloaded server', 'claude-code', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}} · Connection error after retries'],
    ['a sign-in', 'claude-code', 'Not logged in · Please run /login'],
    ["Codex's usage limit", 'codex', "You've hit your usage limit. Upgrade to Pro, or try again at 3:00 PM. stream disconnected"],
    ["Copilot's refused key", 'copilot', 'Authentication failed with provider at http://127.0.0.1:50713/v1 (HTTP 401). error sending request'],
    ['a server error that names no connection', 'claude-code', 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'],
    ['no words', 'claude-code', '   ']
  ] as const)('never %s', (_what, provider, words) => {
    expect(dropped(provider, words)).toBe(false)
  })

  it('never takes a turn its CLI gave up on for a rate limit (429) as a dropped connection: no resume adds to the throttle (HI-1973)', () => {
    // Claude Code 2.1.312's words after its ten tries against a 429 (HI-1973's recording, its last assistant message).
    expect(dropped('claude-code', 'API Error: Request rejected (429) · Number of request tokens has exceeded your per-minute rate limit')).toBe(false)
    for (const line of fixture('rate-limit-copilot-1.0.105.jsonl').split('\n').filter(Boolean)) expect(dropped('copilot', JSON.parse(line).data.message)).toBe(false)
  })

  it("keeps each CLI's words to its own pattern, and Hive's exclusions win", () => {
    // Codex's dropped stream isn't how Claude Code says it, nor Copilot's.
    expect(dropped('claude-code', 'stream disconnected before completion: Transport error')).toBe(false)
    expect(dropped('copilot', 'stream disconnected before completion: Transport error')).toBe(false)
    expect(pattern(OUTAGE_NOT_CONNECTION).test('API Error: Connection refused (ECONNREFUSED)')).toBe(false)
    for (const p of ['claude-code', 'codex', 'copilot'] as const) expect(advancedDef(outagePatternId(p))?.group).toBe(p)
  })
})

describe('the checks back off (checkDelay)', () => {
  it('doubles from the first wait to the longest, then stays there', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map((n) => checkDelay(n, 30_000, 300_000))).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000])
  })
})

describe('the note (resumeNote)', () => {
  it('says when the connection dropped and came back, and what to do, in English', () => {
    const note = resumeNote(Date.parse('2026-10-25T11:47:00'), Date.parse('2026-10-25T11:57:00'))
    expect(note).toMatch(/^The connection dropped at 11:47 \(UTC[+-]\d\d:\d\d\) and came back at 11:57 \(UTC[+-]\d\d:\d\d\): check what was cut off, rerun it, and carry on\.$/)
  })
})

/** A host of the test's own: a clock and timers it moves, a network it says is up or down, and what the wait did. */
function fakeHost(o: { on?: boolean; up?: boolean; perHour?: number; waitMs?: number } = {}) {
  let now = Date.parse('2026-10-25T11:47:00')
  let waitMs = o.waitMs ?? 2 * 3_600_000
  /** Run as a check asks the network, before it answers (a check that takes long: the clock moved on meanwhile). */
  let duringCheck: (() => void) | null = null
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  const h = {
    on: o.on ?? true,
    up: o.up ?? false,
    stopped: true,
    giveResume: true,
    checks: 0,
    notes: [] as string[],
    waiting: [] as string[],
    ended: [] as OutageEnd['kind'][],
    endsSeen: [] as OutageEnd[]
  }
  const host: OutageHost = {
    on: () => h.on,
    dropped: (provider, words) => dropped(provider, words),
    reachable: async () => {
      h.checks++
      duringCheck?.()
      return h.up
    },
    stillStopped: () => h.stopped,
    waiting: (a) => void h.waiting.push(a.key),
    ended: (_a, end) => {
      h.ended.push(end.kind)
      h.endsSeen.push(end)
    },
    resume: async (_a, note) => {
      if (!h.giveResume) return false
      h.notes.push(note)
      return true
    },
    now: () => now,
    later: (fn, ms) => {
      const t = { at: now + ms, fn, live: true }
      timers.push(t)
      return () => void (t.live = false)
    },
    checkFirstMs: () => 30_000,
    checkMostMs: () => 300_000,
    waitMs: () => waitMs,
    resumesPerHour: () => o.perHour ?? 3
  }
  /** Moves the clock on, running the timers due, and lets each check's promises settle. */
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      // A timer held by sleep runs late: the clock never goes back.
      now = Math.max(now, next.at)
      next.live = false
      next.fn()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    now = end
  }
  const pending = (): number => timers.filter((t) => t.live).length
  /** The clock moved on with no timer run: the PC asleep, its timers held until it wakes. */
  const jumpClock = (ms: number): void => void (now += ms)
  return {
    h,
    host,
    advance,
    pending,
    jumpClock,
    at: () => now,
    setWait: (ms: number) => void (waitMs = ms),
    onCheck: (fn: (() => void) | null) => void (duringCheck = fn)
  }
}

const agent = (o: Partial<OutageAgent> = {}): OutageAgent => ({ key: 'c:\\work\\alpha|a1', projectPath: 'C:\\work\\alpha', agentId: 'a1', runId: 'r1', provider: 'claude-code', turn: '2026-10-25T11:47:00.000Z', assistant: false, ...o })
const REFUSED = 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)'

describe('the wait (OutageResume)', () => {
  it('waits on a connection error, checks backing off, and resumes once with the note when it is back', async () => {
    const { h, host, advance, pending } = fakeHost()
    const o = new OutageResume(host)
    o.failed(agent(), REFUSED)
    expect(h.waiting).toEqual([agent().key])
    expect(o.waitingKeys()).toEqual([agent().key])
    await advance(29_999)
    expect(h.checks).toBe(0)
    await advance(1)
    expect(h.checks).toBe(1)
    // Down: the next check a minute later, then two.
    await advance(60_000)
    expect(h.checks).toBe(2)
    h.up = true
    await advance(119_999)
    expect(h.checks).toBe(2)
    await advance(1)
    expect(h.checks).toBe(3)
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0]).toMatch(/^The connection dropped at 11:47 .* and came back at 11:50 /)
    expect(h.ended).toEqual(['resumed'])
    expect(o.waitingKeys()).toEqual([])
    expect(pending()).toBe(0)
  })

  it.each([
    ['the switch is off', { on: false }, REFUSED],
    ['a usage limit', {}, "Claude AI usage limit reached. You've hit your limit"],
    ['an overloaded server', {}, 'API Error: 529 overloaded_error · Connection error'],
    ['a sign-in', {}, 'Not logged in · Please run /login']
  ] as const)('does nothing when %s', async (_what, opts, words) => {
    const { h, host, advance, pending } = fakeHost({ ...opts, up: true })
    const o = new OutageResume(host)
    o.failed(agent(), words)
    await advance(3_600_000)
    expect(h.waiting).toEqual([])
    expect(h.checks).toBe(0)
    expect(h.notes).toEqual([])
    expect(pending()).toBe(0)
  })

  it('ends the wait, with no note, when the agent carries on another way or its launch ends', async () => {
    const { h, host, advance, pending } = fakeHost({ up: true })
    const o = new OutageResume(host)
    o.failed(agent(), REFUSED)
    o.cleared(agent().key)
    expect(h.ended).toEqual(['cancelled'])
    expect(pending()).toBe(0)
    await advance(3_600_000)
    expect(h.notes).toEqual([])
    // Found at a check: no longer stopped on that turn.
    o.failed(agent(), REFUSED)
    h.stopped = false
    await advance(30_000)
    expect(h.checks).toBe(0)
    expect(h.ended).toEqual(['cancelled', 'cancelled'])
    expect(h.notes).toEqual([])
  })

  it('is cancelled, not resumed, when the note can no longer be given', async () => {
    const { h, host, advance } = fakeHost({ up: true })
    h.giveResume = false
    const o = new OutageResume(host)
    o.failed(agent(), REFUSED)
    await advance(30_000)
    expect(h.ended).toEqual(['cancelled'])
    // Not counted as a resume: three more failures still each wait.
    h.giveResume = true
    for (let i = 0; i < 3; i++) {
      o.failed(agent({ turn: `t${i}` }), REFUSED)
      await advance(30_000)
    }
    expect(h.ended).toEqual(['cancelled', 'resumed', 'resumed', 'resumed'])
  })

  it('waits once per agent, and for each agent on its own', async () => {
    const { h, host, advance } = fakeHost({ up: true })
    const o = new OutageResume(host)
    o.failed(agent(), REFUSED)
    o.failed(agent(), REFUSED)
    o.failed(agent({ key: 'c:\\work\\alpha|a2', agentId: 'a2' }), REFUSED)
    expect(h.waiting).toHaveLength(2)
    await advance(30_000)
    expect(h.notes).toHaveLength(2)
  })

  it('gives up once the wait passes its limit, and says how long it waited', async () => {
    const { h, host, advance, pending } = fakeHost({ waitMs: 10 * 60_000 })
    const o = new OutageResume(host)
    o.failed(agent(), REFUSED)
    await advance(10 * 60_000)
    // 30 s, 1, 2 and 4 min: the next (5 min) would end past 10 min.
    expect(h.checks).toBe(4)
    expect(h.endsSeen).toEqual([{ kind: 'timedOut', minutes: 10 }])
    expect(h.notes).toEqual([])
    expect(pending()).toBe(0)
  })

  it('stops after three resumes in an hour that end on a connection error again, and starts again after the hour', async () => {
    const { h, host, advance } = fakeHost({ up: true })
    const o = new OutageResume(host)
    for (let i = 0; i < 3; i++) {
      o.failed(agent({ turn: `t${i}` }), REFUSED)
      await advance(30_000)
    }
    expect(h.notes).toHaveLength(3)
    o.failed(agent({ turn: 't3' }), REFUSED)
    expect(h.endsSeen.at(-1)).toEqual({ kind: 'gaveUp', resumes: 3 })
    expect(h.waiting).toHaveLength(3)
    await advance(3_600_000)
    expect(h.notes).toHaveLength(3)
    // A drop more than an hour after those resumes is a new outage.
    o.failed(agent({ turn: 't4' }), REFUSED)
    await advance(30_000)
    expect(h.notes).toHaveLength(4)
  })

  it('keeps the resumes after giving up: another drop within the hour gives up again, one after it resumes (HR2 round 1, finding 1)', async () => {
    const { h, host, advance } = fakeHost({ up: true })
    const o = new OutageResume(host)
    for (let i = 0; i < 3; i++) {
      o.failed(agent({ turn: `t${i}` }), REFUSED)
      await advance(30_000)
    }
    o.failed(agent({ turn: 't3' }), REFUSED)
    expect(h.ended).toEqual(['resumed', 'resumed', 'resumed', 'gaveUp'])
    // The user carries it on by hand, and it drops again at 2 minutes: still within the hour of the three.
    await advance(30_000)
    o.failed(agent({ turn: 't4' }), REFUSED)
    await advance(60_000)
    expect(h.notes).toHaveLength(3)
    expect(h.endsSeen.at(-1)).toEqual({ kind: 'gaveUp', resumes: 3 })
    expect(h.waiting).toHaveLength(3)
    // An hour after the first resume, it has fallen out: two are left, so a drop waits and resumes again.
    await advance(3_600_000 - 3 * 30_000 - 30_000)
    o.failed(agent({ turn: 't5' }), REFUSED)
    await advance(30_000)
    expect(h.notes).toHaveLength(4)
    expect(h.ended.at(-1)).toBe('resumed')
  })

  it('never resumes past the wait: a timer the PC slept through times out, the host up or not (HR2 round 1, finding 2)', async () => {
    const { h, host, advance, jumpClock, pending } = fakeHost({ up: true })
    const o = new OutageResume(host)
    o.failed(agent(), REFUSED)
    jumpClock(12 * 3_600_000)
    await advance(0)
    expect(h.checks).toBe(0)
    expect(h.notes).toEqual([])
    expect(h.endsSeen).toEqual([{ kind: 'timedOut', minutes: 120 }])
    expect(pending()).toBe(0)
  })

  it('never resumes when the check itself ends past the wait, though the host answered', async () => {
    const { h, host, advance, jumpClock, onCheck } = fakeHost({ up: true })
    const o = new OutageResume(host)
    o.failed(agent(), REFUSED)
    onCheck(() => jumpClock(2 * 3_600_000))
    await advance(30_000)
    expect(h.checks).toBe(1)
    expect(h.notes).toEqual([])
    expect(h.endsSeen).toEqual([{ kind: 'timedOut', minutes: 120 }])
  })

  it('takes a wait shortened while it runs at its next check', async () => {
    const { h, host, advance, setWait } = fakeHost({ up: false })
    const o = new OutageResume(host)
    o.failed(agent(), REFUSED)
    await advance(90_000)
    expect(h.checks).toBe(2)
    // Down to a minute: 90 s have passed, so the next check (due at 3.5 min) ends the wait without asking the network.
    setWait(60_000)
    h.up = true
    await advance(120_000)
    expect(h.checks).toBe(2)
    expect(h.notes).toEqual([])
    expect(h.endsSeen).toEqual([{ kind: 'timedOut', minutes: 1 }])
  })

  it('ends every wait when the switch is turned off', async () => {
    const { h, host, advance, pending } = fakeHost({ up: true })
    const o = new OutageResume(host)
    o.failed(agent(), REFUSED)
    o.failed(agent({ key: 'k2', agentId: 'a2' }), REFUSED)
    h.on = false
    o.turnedOff()
    expect(h.ended).toEqual(['cancelled', 'cancelled'])
    expect(pending()).toBe(0)
    await advance(60_000)
    expect(h.notes).toEqual([])
  })
})

describe('the reachability check (reachable)', () => {
  let server: Server | null = null
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    server = null
  })

  const closedPort = (): Promise<number> =>
    new Promise((resolve) => {
      const s = createNetServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port
        s.close(() => resolve(port))
      })
    })

  it('counts any answer, an error status too', async () => {
    server = createServer((_req, res) => {
      res.writeHead(401)
      res.end('no')
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    expect(await reachable(`http://127.0.0.1:${port}/`)).toBe(true)
  })

  it('is false for a refused port, a host that does not resolve, and an address that is not http(s)', async () => {
    expect(await reachable(`http://127.0.0.1:${await closedPort()}/`)).toBe(false)
    expect(await reachable('http://hive-outage-test.invalid/')).toBe(false)
    expect(await reachable('ftp://example.com/')).toBe(false)
    expect(await reachable('not a url')).toBe(false)
  })

  it('is false for a host that never answers, within its timeout', async () => {
    server = createServer(() => undefined)
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    expect(await reachable(`http://127.0.0.1:${port}/`, 300)).toBe(false)
    server.closeAllConnections()
  })
})
