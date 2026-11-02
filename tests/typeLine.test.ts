// lib.typeLine's readiness (HI-1918): with `strict`, a line is never typed into an agent before its `ready` holds, nor
// once the wait for it has run out (HR2's round 1: the fallback typed anyway, the race the wait was for). A pending
// doorbell holds readiness false here, then drains; the terminal is a stand-in that logs what is typed as the fake's
// input log does, and the line counts as taken at its Enter.
import { createRequire } from 'module'
import { writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

type Lost = { attempt: number; lost: string[] }
const { typeLine } = createRequire(import.meta.url)('./e2e/lib.cjs') as {
  typeLine: (inv: (ch: string, key: string, data: string) => Promise<unknown>, key: string, home: string, agent: string, text: string, o: Record<string, unknown>) => Promise<Lost>
}
/** A hung run's bound: never reached by a working one (the waits below end on their conditions). */
const HUNG_MS = 10_000

/** A fake agent's terminal: what is typed is logged (fake-input.jsonl), and a line ending in Enter is taken. */
function terminal() {
  const home = tempDir('typeline-')
  writeFileSync(join(home, 'fake-log-input.txt'), '')
  const writes: { at: number; data: string }[] = []
  let entered = 0
  const inv = async (channel: string, _key: string, data: string): Promise<unknown> => {
    if (channel !== 'pty:write') return null
    writes.push({ at: Date.now(), data })
    appendFileSync(join(home, 'fake-input.jsonl'), `${JSON.stringify({ agent: 'B1', data })}\n`)
    if (data === '\r') entered++
    return null
  }
  return { home, inv, writes, taken: async () => entered > 0 }
}

describe('typeLine waits for its readiness (HI-1918)', () => {
  it('strict: nothing typed while a doorbell is pending; typed once it drains, and taken', async () => {
    const t = terminal()
    let pending = true
    let asked = 0
    const going = typeLine(t.inv, 'k', t.home, 'B1', 'shell: echo hi', { strict: true, taken: t.taken, hungMs: HUNG_MS, ready: async () => (asked++, !pending) })
    // It has asked several times and typed nothing while the doorbell is pending.
    await vi.waitFor(() => expect(asked).toBeGreaterThanOrEqual(5), { timeout: HUNG_MS })
    expect(t.writes).toEqual([])
    const drained = Date.now()
    pending = false
    const r = await going
    expect(r).toEqual({ attempt: 1, lost: [] })
    expect(t.writes.map((w) => w.data)).toEqual(['shell: echo hi', '\r'])
    expect(t.writes.every((w) => w.at >= drained)).toBe(true)
  })

  it('strict: never ready, never typed, each try lost as not typed (no fallback after the wait)', async () => {
    const t = terminal()
    const r = await typeLine(t.inv, 'k', t.home, 'B1', 'shell: echo hi', { strict: true, taken: t.taken, tries: 2, hungMs: 300, ready: async () => false })
    expect(r).toEqual({ attempt: 0, lost: ['not ready within 0.3 s, not typed', 'not ready within 0.3 s, not typed'] })
    expect(t.writes).toEqual([])
  })

  it('not strict, as before: never ready, typed anyway once the wait runs out (said so)', async () => {
    const t = terminal()
    const r = await typeLine(t.inv, 'k', t.home, 'B1', 'shell: echo hi', { taken: t.taken, tries: 1, hungMs: 300, ready: async () => false })
    expect(r).toEqual({ attempt: 1, lost: ['not ready within 0.3 s, typed anyway'] })
    expect(t.writes.map((w) => w.data)).toEqual(['shell: echo hi', '\r'])
  })
})
