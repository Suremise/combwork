// Claude Code waiting to retry its model request (HI-1973), read from its transcript's end: the recorded entries of a
// 429 (ten tries) and of a refused port (no HTTP status: its service unreachable), the newest one since the last hook
// with the first as the wait's start, entries before `since` or not believable skipped, a partial first line of the
// tail and a broken line ignored, and only the transcript's last RETRY_TAIL_BYTES read.
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const { claudeRetryWait, retryWaitIn, RETRY_TAIL_BYTES } = await import('../src/main/providers/claude/retry')

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'advanced', 'retry-claude-2.1.312.jsonl'), 'utf8').trim().split('\n')
const entries = FIXTURE.map((l) => JSON.parse(l) as { retryAttempt: number; timestamp: string; retryInMs: number; error: { status?: number } })
/** The recording's 429 tries (1, 2 and 10) and its refused port's (1, 2). */
const limited = FIXTURE.slice(0, 3)
const refused = FIXTURE.slice(3)
const at = (i: number): number => Date.parse(entries[i].timestamp)
const late = at(4) + 60_000

describe("Claude Code's retry wait from its transcript (HI-1973)", () => {
  it('the newest 429 try since the last hook, with the first as its start, its retry time its wait after it', () => {
    const w = retryWaitIn(limited, at(0) - 1, late)
    expect(w).toEqual({ at: entries[2].timestamp, since: entries[0].timestamp, retryAt: new Date(at(2) + entries[2].retryInMs).toISOString(), attempt: 10, max: 10, status: 429 })
    // Only what came after the last hook: an earlier try isn't this wait's start.
    expect(retryWaitIn(limited, at(1), late)).toMatchObject({ since: entries[1].timestamp, attempt: 10 })
    expect(retryWaitIn(limited, at(2) + 1, late)).toBeNull()
  })

  it('a refused port (no HTTP status) is its service unreachable', () => {
    expect(entries[3].error.status).toBeUndefined()
    expect(retryWaitIn(refused, 0, late)).toMatchObject({ attempt: 2, max: 10, status: null, network: true })
  })

  it("skips what isn't such an entry or doesn't hold up: other lines, broken JSON, a try past its tries, a wait over a day, a time far ahead", () => {
    const e = JSON.parse(limited[0]) as Record<string, unknown>
    const bad = [
      JSON.stringify({ type: 'assistant', subtype: 'api_error' }),
      '{"type":"system","subtype":"api_error",',
      JSON.stringify({ ...e, retryAttempt: 11, maxRetries: 10 }),
      JSON.stringify({ ...e, retryInMs: 2 * 24 * 60 * 60_000 }),
      JSON.stringify({ ...e, retryAttempt: 1.5 }),
      JSON.stringify({ ...e, timestamp: new Date(late + 3_600_000).toISOString() }),
      JSON.stringify({ ...e, error: { status: 42 } })
    ]
    expect(bad.slice(0, 6).map((l) => retryWaitIn([l], 0, late))).toEqual([null, null, null, null, null, null])
    // A status that isn't HTTP's: no status (never a made-up one).
    expect(retryWaitIn([bad[6]], 0, late)).toMatchObject({ status: null })
  })

  it("reads only the transcript's end, and ignores the line it cut into", async () => {
    const dir = tempDir('hive-claude-retry-')
    const file = join(dir, 'session.jsonl')
    // An early try, then over RETRY_TAIL_BYTES of other lines, then the turn's last two tries.
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } })
    const lines = [limited[0], ...Array.from({ length: Math.ceil(RETRY_TAIL_BYTES / filler.length) + 2 }, () => filler), limited[1], limited[2]]
    writeFileSync(file, `${lines.join('\n')}\n`)
    const w = await claudeRetryWait(file, 0, late)
    // The early try is outside the tail: the wait starts at the first one read.
    expect(w).toMatchObject({ since: entries[1].timestamp, attempt: 10 })
    expect(await claudeRetryWait(join(dir, 'none.jsonl'), 0, late)).toBeNull()
    expect(await claudeRetryWait(undefined, 0, late)).toBeNull()
  })
})
