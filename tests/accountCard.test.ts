// Settings → Accounts & Connections' tidied cards (HI-2528, Darren's approved mockup v2): what each card and connection
// row shows, worked out apart from the components.
import { afterEach, describe, expect, it } from 'vitest'
import type { PlanLimit } from '../src/shared/types'
import { setDateStyle } from '../src/shared/dates'
import { connectionCells, currentLimits, planName, resetText, usageLevel, windowOf } from '../src/renderer/src/components/accountCard'

const limit = (id: string, windowMinutes: number, usedPercent: number, resetsAt: string | null): PlanLimit => ({ id, label: id, windowMinutes, usedPercent, resetsAt })

describe("an account's usage (HI-2528)", () => {
  afterEach(() => setDateStyle({ date: 'ymd', time: '24h' }))
  const now = new Date(2026, 10, 4, 21, 30)
  it('shows only the limits whose period is still running, in the order reported', () => {
    const later = new Date(now.getTime() + 3600e3).toISOString()
    const gone = new Date(now.getTime() - 60e3).toISOString()
    expect(currentLimits([limit('five_hour', 300, 42, later), limit('old', 300, 99, gone), limit('seven_day', 10080, 6, null)], now.getTime()).map((l) => l.id)).toEqual(['five_hour', 'seven_day'])
    expect(currentLimits(undefined)).toEqual([])
  })
  it('names the 5-hour and weekly windows, else the provider’s own', () => {
    expect([windowOf({ windowMinutes: 300 }), windowOf({ windowMinutes: 10080 }), windowOf({ windowMinutes: 60 }), windowOf({ windowMinutes: null })]).toEqual(['fiveHour', 'weekly', 'other', 'other'])
  })
  it('says when it resets as the plan notices do: a time today, a weekday and time this week, a date further out', () => {
    setDateStyle({ date: 'ymd', time: '24h' })
    expect(resetText(new Date(2026, 10, 4, 23, 0).toISOString(), now)).toBe('resets at 23:00')
    expect(resetText(new Date(2026, 10, 6, 9, 0).toISOString(), now)).toMatch(/^resets \S+ 09:00$/)
    expect(resetText(new Date(2026, 10, 20, 9, 0).toISOString(), now)).toMatch(/^resets 2026-11-20/)
    expect(resetText(null, now)).toBe('')
    expect(resetText('soon', now)).toBe('')
  })
  it('colours a bar amber from 80% and red from 95%', () => {
    expect([usageLevel(0), usageLevel(79.9), usageLevel(80), usageLevel(94.9), usageLevel(95), usageLevel(120)]).toEqual(['ok', 'ok', 'high', 'high', 'full', 'full'])
  })
  it('shows the plan as the CLI names it, title-cased, never mapped', () => {
    expect([planName('max'), planName('pro'), planName('Ultra'), planName('team plus')]).toEqual(['Max', 'Pro', 'Ultra', 'Team plus'])
  })
})

describe("a connection's row (HI-2528)", () => {
  const claude = { provider: 'claude-code' as const, kind: undefined }
  it("reads CLI's own for a value the CLI decides, none for no extra arguments", () => {
    const v = connectionCells({}, claude, null)
    expect(v.model).toEqual({ text: "CLI's own", own: true })
    expect(v.effort).toEqual({ text: "CLI's own", own: true })
    expect(v.context).toEqual({ text: "CLI's own", own: true })
    expect(v.mode).toEqual({ text: "CLI's own", own: true })
    expect(v.args).toEqual({ text: 'none', own: true })
  })
  it('shows each chosen value in its own cell', () => {
    const v = connectionCells({ model: 'opus', effort: 'high', use200kContext: true, permissionMode: 'auto', extraArgs: '--verbose' }, claude, null)
    expect(v.model.text).toMatch(/Opus/)
    expect(v.effort.own).toBeUndefined()
    expect(v.context).toEqual({ text: '200K' })
    expect(v.mode.own).toBeUndefined()
    expect(v.args).toEqual({ text: '--verbose' })
  })
  it('a dash where the setting does not apply: a server’s effort and context, a CLI without a context choice', () => {
    const server = connectionCells({ model: 'lab-large' }, { provider: 'claude-code', kind: 'server' }, null)
    expect(server.model).toEqual({ text: 'lab-large' })
    expect(server.effort).toEqual({ text: '—', none: true })
    expect(server.context).toEqual({ text: '—', none: true })
    expect(connectionCells({}, { provider: 'codex', kind: undefined }, null).context).toEqual({ text: '—', none: true })
  })
})
