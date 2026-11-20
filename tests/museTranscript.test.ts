// Muse Code's session log (HI-3202): found by its session id under a data home, read for usage and the conversation view,
// against a real 1.4.20 session recorded offline (the echo provider: no model, no tokens).
import { copyFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { isMuseSessionId, museSessionFile, MuseConversationParser, MuseUsageParser, parseMuseTranscript } from '../src/main/providers/muse/transcript'

const FIXTURE = join(__dirname, 'fixtures', 'muse', 'session-1.4.20-echo.jsonl')
const SESSION = '01a1d9f5-1276-7eb3-a2dd-59e1830f2856'
const text = readFileSync(FIXTURE, 'utf8')

describe("Muse's session log (HI-3202)", () => {
  it('is found by its session id under a data home, in its YYYY/MM/DD folder; a bad id never is', async () => {
    const other = tempDir('cw-muse-other-')
    const home = tempDir('cw-muse-data-')
    const dir = join(home, 'muse', 'sessions', '2026', '11', '14', SESSION)
    mkdirSync(dir, { recursive: true })
    copyFileSync(FIXTURE, join(dir, 'session.jsonl'))
    expect(await museSessionFile([other, home], SESSION)).toBe(join(dir, 'session.jsonl'))
    expect(await museSessionFile([other], SESSION)).toBeNull()
    for (const bad of ['..', `../${SESSION}`, `${SESSION}/..`, 'a\\b', '']) {
      expect(isMuseSessionId(bad)).toBe(false)
      expect(await museSessionFile([home], bad)).toBeNull()
    }
  })

  it('reads its usage: one turn, one request of no tokens (echo), its build, no model and no cost of its own', () => {
    const u = parseMuseTranscript(text, SESSION, 'a title')
    expect(u).toMatchObject({ provider: 'muse', sessionId: SESSION, title: 'a title', userMessages: 1, lastPrompt: 'probe trustA: hello', requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, model: null, cliVersion: '1.4.20', costUsd: null })
    expect(u.firstActivity).toMatch(/^2026-11-1\dT/)
  })

  it('reads incrementally as a whole, a record read twice counted once, a line that isn’t JSON left out', () => {
    const p = new MuseUsageParser(SESSION)
    const lines = text.split('\n')
    p.feed(lines.slice(0, 40).join('\n'))
    p.feed(['{ not json', ...lines.slice(30)].join('\n'))
    expect(p.result()).toMatchObject({ userMessages: 1, requests: 1, lastPrompt: 'probe trustA: hello' })
  })

  it('shows its prompt and its reply in the conversation view, and nothing else of the log', () => {
    const c = new MuseConversationParser()
    const buf = Buffer.from(`${text}\n{ broken\n`)
    const read = c.feed(buf)
    expect(read).toBe(buf.length)
    expect(c.items.map((i) => [i.kind, 'text' in i ? i.text : null])).toEqual([
      ['user', 'probe trustA: hello'],
      ['assistant', 'echo: probe trustA: hello']
    ])
  })

  it('counts a model request’s tokens, its cached part apart, and a model a record names', () => {
    const rec = (seq: number, event: Record<string, unknown>) => JSON.stringify({ id: `r${seq}`, recorded_at: 1794658083000000 + seq, payload_type: 'runtime.session', payload: { kind: 'run', event } })
    const u = parseMuseTranscript([rec(1, { kind: 'started', prompt: 'go' }), rec(2, { kind: 'model_completed', model: 'muse-spark-1.2', usage: { input_tokens: 100, cached_tokens: 40, output_tokens: 20, reasoning_tokens: 5 } })].join('\n'), SESSION)
    expect(u).toMatchObject({ model: 'muse-spark-1.2', inputTokens: 100, cacheReadTokens: 40, outputTokens: 20, reasoningTokens: 5, contextTokens: 160, requests: 1 })
  })
})
