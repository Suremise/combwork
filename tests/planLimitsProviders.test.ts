import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempRoot } from './tempDir'
import type { PlanUsage } from '../src/shared/types'

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot(), isPackaged: false, getVersion: () => '0.0.0' },
  // eslint-disable-next-line typescript/no-extraneous-class
  Notification: class {
    static isSupported(): boolean {
      return false
    }
    on(): this {
      return this
    }
    show(): void {}
  }
}))

const { config } = await import('../src/main/config')
const { mergePlanUsage, reportPlanUsage, planNotice } = await import('../src/main/planUsage')
const { agyPlanUsage, agyStatusDetails } = await import('../src/main/providers/antigravity/status')
const { copilotPlanUsage } = await import('../src/main/providers/copilot/quota')
const { eventsDetails } = await import('../src/main/providers/copilot/events')
const { onCombworkEvent } = await import('../src/main/events')
const { isoTime, limitName, limitWindow } = await import('../src/shared/planLimits')
const { setLanguage } = await import('../src/shared/i18n')

// HI-2734: the plan's limits as Antigravity and Copilot record them.
// agy 1.5.0's status lines (HI-2545's run), with a quota (gemini-weekly, 3p-weekly) in most and its plan's name in some.
const FIX = join(__dirname, 'fixtures')
const agyLines: Record<string, any>[] = readFileSync(join(FIX, 'advanced', 'statusline-run-antigravity-1.5.0.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
// A Copilot 1.0.93 model call's quota snapshots, from the user's own session (Darren's OK, 7 Nov), every other field stripped.
const copilotLine = readFileSync(join(FIX, 'copilot', 'quota-snapshots-1.0.93.jsonl'), 'utf8')
const copilotSnapshots = JSON.parse(copilotLine).data.quotaSnapshots
const WEEK = 7 * 24 * 60
// A time inside the recorded quotas' week, so their resets are ahead of it.
const AT = Date.parse('2026-11-07T13:00:00Z')

describe("Antigravity's plan limits (agy's status line)", () => {
  it('reads every recorded line with a quota: a weekly limit for Gemini models and one for the other models, with the plan', () => {
    const withQuota = agyLines.filter((l) => l.quota)
    expect(withQuota.length).toBeGreaterThan(10)
    for (const line of withQuota) {
      const u = agyPlanUsage(line, new Date(AT))!
      expect(u.provider).toBe('antigravity')
      expect(u.limits.map((l) => [l.id, l.models, l.windowMinutes])).toEqual([['3p-weekly', 'otherModels', WEEK], ['gemini-weekly', 'gemini', WEEK]])
      const gemini = u.limits.find((l) => l.id === 'gemini-weekly')!
      expect(gemini.usedPercent).toBeCloseTo((1 - line.quota['gemini-weekly'].remaining_fraction) * 100, 6)
      expect(gemini.resetsAt).toBe(new Date(line.quota['gemini-weekly'].reset_time).toISOString())
      expect(u.plan).toBe(line.plan_tier ?? null)
    }
    expect(withQuota.some((l) => l.plan_tier === 'Antigravity Starter Quota')).toBe(true)
  })

  it('a line with neither is no report; the plan alone is a report of its name, with no limit made up', () => {
    const bare = agyLines.find((l) => !l.quota && !l.plan_tier)!
    expect(agyPlanUsage(bare)).toBeNull()
    expect(agyStatusDetails(bare).planUsage).toBeUndefined()
    const planOnly = agyPlanUsage({ plan_tier: 'Antigravity Starter Quota' })!
    expect(planOnly.plan).toBe('Antigravity Starter Quota')
    expect(planOnly.limits).toEqual([])
    expect(agyPlanUsage({ quota: {}, plan_tier: '  ' })).toBeNull()
  })

  it('leaves out a quota without a share from 0 to 1; one of another window keeps its own name and no window', () => {
    const u = agyPlanUsage({
      quota: {
        'gemini-weekly': { remaining_fraction: 1.5, reset_time: '2026-11-14T00:00:00Z' },
        '3p-weekly': { remaining_fraction: '0.5' },
        'x-weekly': { remaining_fraction: Number.NaN },
        'y-weekly': [0.5],
        'flash-daily': { remaining_fraction: 0.25, reset_time: 'soon' }
      }
    })!
    expect(u.limits).toEqual([{ id: 'flash-daily', label: 'flash-daily', windowMinutes: null, usedPercent: 75, resetsAt: null, models: 'flash-daily' }])
  })

  it('the status line carries it to the session with its model and context window', () => {
    const line = agyLines.find((l) => l.quota && l.model)!
    const d = agyStatusDetails(line, new Date(AT))
    expect(d.planUsage?.limits).toHaveLength(2)
    expect(d.contextWindow).toBeGreaterThan(0)
  })
})

describe("Copilot's plan limits (a model call's quota snapshots)", () => {
  it('reads the recorded snapshots: chat and completions with their counts; premium requests not in this plan', () => {
    const u = copilotPlanUsage(copilotSnapshots, '2026-10-20T10:00:00Z')!
    expect(u.provider).toBe('copilot')
    expect(u.updatedAt).toBe('2026-10-20T10:00:00.000Z')
    expect(u.limits.map((l) => [l.id, l.models, l.windowMinutes, l.used, l.entitlement])).toEqual([['chat', 'chat', null, 2, 200], ['completions', 'completions', null, 0, 2000], ['premium_interactions', 'premium', null, undefined, 0]])
    expect(u.limits[0].usedPercent).toBeCloseTo(0.8, 6)
    expect(u.limits[0].resetsAt).toBe('2026-11-01T00:00:00.000Z')
    // premium_interactions: entitlement 0, 0% left: known (not in the plan), never a share (it would read all used and warn).
    expect(u.limits[2]).toMatchObject({ notIncluded: true, entitlement: 0, usedPercent: 0 })
    expect(u.limits[2].unlimited).toBeUndefined()
  })

  it('an unlimited quota is reported as unlimited, not as a figure or as nothing', () => {
    for (const s of [{ isUnlimitedEntitlement: true, entitlementRequests: 1000, remainingPercentage: 100 }, { isUnlimitedEntitlement: false, entitlementRequests: -1, remainingPercentage: 100 }]) {
      const u = copilotPlanUsage({ premium_interactions: { ...s, usedRequests: 3, resetDate: '2026-12-01T00:00:00Z' } }, '2026-11-07T10:00:00Z')!
      expect(u.limits).toEqual([{ id: 'premium_interactions', label: 'premium_interactions', windowMinutes: null, usedPercent: 0, resetsAt: '2026-12-01T00:00:00.000Z', models: 'premium', unlimited: true }])
    }
  })

  it("a custom provider's {} and invalid figures are no report", () => {
    expect(copilotPlanUsage({}, '2026-11-07T10:00:00Z')).toBeNull()
    expect(copilotPlanUsage(undefined, '2026-11-07T10:00:00Z')).toBeNull()
    expect(copilotPlanUsage([], '2026-11-07T10:00:00Z')).toBeNull()
    const bad = { a: { entitlementRequests: 100, remainingPercentage: 120 }, b: { entitlementRequests: 100, remainingPercentage: Number.NaN }, c: { entitlementRequests: '100', remainingPercentage: 50 }, d: null }
    expect(copilotPlanUsage(bad, '2026-11-07T10:00:00Z')).toBeNull()
  })

  it("the session file's event carries it to the session; Copilot's offline run ({}) carries none", () => {
    const line = JSON.stringify({ ...JSON.parse(copilotLine), timestamp: '2026-10-20T10:00:00Z' })
    expect(eventsDetails(line).planUsage?.limits.map((l) => l.id)).toEqual(['chat', 'completions', 'premium_interactions'])
    expect(eventsDetails(readFileSync(join(FIX, 'copilot', 'compaction-1.0.98.jsonl'), 'utf8')).planUsage).toBeUndefined()
  })
})

describe('plan limits of part of a plan, kept and shown (HI-2734)', () => {
  const agy = (gemini: number, other = 1, at = AT, extra: Record<string, unknown> = {}): PlanUsage =>
    agyPlanUsage({ quota: { 'gemini-weekly': { remaining_fraction: gemini, reset_time: '2026-11-14T02:04:21Z' }, '3p-weekly': { remaining_fraction: other, reset_time: new Date(at + WEEK * 60e3).toISOString() } }, ...extra }, new Date(at))!
  const pct = (u: PlanUsage, id: string) => u.limits.find((l) => l.id === id)?.usedPercent

  it('merges each limit by its id: a lower reading later keeps the higher; one left out stays until its reset', () => {
    let kept = mergePlanUsage(undefined, agy(0.9, 0.8), AT)
    kept = mergePlanUsage(kept, agy(0.95, 0.6, AT + 60e3), AT + 60e3)
    expect(pct(kept, 'gemini-weekly')).toBeCloseTo(10, 6)
    expect(pct(kept, '3p-weekly')).toBeCloseTo(40, 6)
    const onlyGemini = { ...agy(0.85), limits: agy(0.85).limits.filter((l) => l.id === 'gemini-weekly') }
    kept = mergePlanUsage(kept, onlyGemini, AT + 120e3)
    expect(kept.limits.map((l) => l.id).sort()).toEqual(['3p-weekly', 'gemini-weekly'])
    expect(pct(kept, 'gemini-weekly')).toBeCloseTo(15, 6)
  })

  it("agy's third-party quota, unused, moves its reset on with each report: kept as one period, its figure as reported", () => {
    let kept = mergePlanUsage(undefined, agy(0.9, 1, AT), AT)
    for (let m = 1; m <= 10; m++) kept = mergePlanUsage(kept, agy(0.9, 1, AT + m * 60e3), AT + m * 60e3)
    const other = kept.limits.find((l) => l.id === '3p-weekly')!
    expect(other.usedPercent).toBe(0)
    expect(other.resetsAt).toBe(new Date(AT + 10 * 60e3 + WEEK * 60e3).toISOString())
  })

  it("a report of the plan's name alone keeps the limits and when they were reported", () => {
    const kept = mergePlanUsage(undefined, agy(0.9), AT)
    const next = mergePlanUsage(kept, agyPlanUsage({ plan_tier: 'Antigravity Pro' }, new Date(AT + 3600e3))!, AT + 3600e3)
    expect(next.plan).toBe('Antigravity Pro')
    expect(next.limits).toEqual(kept.limits)
    expect(next.updatedAt).toBe(kept.updatedAt)
  })

  it('the higher reading kept takes what the latest one says the limit is', () => {
    const kept = mergePlanUsage(undefined, agy(0.5), AT)
    const renamed = { ...agy(0.6, 1, AT + 60e3), limits: agy(0.6, 1, AT + 60e3).limits.map((l) => ({ ...l, models: 'gemini-pro' })) }
    const next = mergePlanUsage(kept, renamed, AT + 60e3)
    const g = next.limits.find((l) => l.id === 'gemini-weekly')!
    expect(g.usedPercent).toBeCloseTo(50, 6)
    expect(g.models).toBe('gemini-pro')
  })

  it('a delayed report never rolls back what a later one said the limit is, whether its share is lower or higher', () => {
    const named = (models: string, gemini: number, at: number) => ({ ...agy(gemini, 1, at), limits: agy(gemini, 1, at).limits.map((l) => (l.id === 'gemini-weekly' ? { ...l, models } : l)) })
    const g = (u: PlanUsage) => u.limits.find((l) => l.id === 'gemini-weekly')!
    // A at t0 (50% used); C at t2 (40%: lower, kept share A's) says gemini-pro; B from t1 arrives last.
    const afterC = mergePlanUsage(mergePlanUsage(undefined, named('gemini', 0.5, AT), AT), named('gemini-pro', 0.6, AT + 120e3), AT + 120e3)
    expect([Math.round(g(afterC).usedPercent), g(afterC).models]).toEqual([50, 'gemini-pro'])
    for (const left of [0.55, 0.45]) {
      const afterB = mergePlanUsage(afterC, named('gemini', left, AT + 60e3), AT + 130e3)
      expect(g(afterB).models, `B at ${left}`).toBe('gemini-pro')
      expect(Math.round(g(afterB).usedPercent), `B at ${left}`).toBe(Math.max(50, Math.round((1 - left) * 100)))
    }
  })

  describe('what the plan allows changing within a period (unlimited now or no longer, another entitlement)', () => {
    const resets = '2026-12-01T00:00:00Z'
    const premium = (s: Record<string, unknown>, at: number): PlanUsage => copilotPlanUsage({ premium_interactions: { usedRequests: 0, resetDate: resets, ...s } }, new Date(at).toISOString())!
    const metered = (entitlement: number, left: number, at: number) => premium({ isUnlimitedEntitlement: false, entitlementRequests: entitlement, usedRequests: entitlement * (1 - left / 100), remainingPercentage: left }, at)
    const unlimited = (at: number) => premium({ isUnlimitedEntitlement: true, entitlementRequests: -1, remainingPercentage: 100 }, at)
    const merged = (...reports: [PlanUsage, number][]) => reports.reduce<PlanUsage | undefined>((kept, [r, now]) => mergePlanUsage(kept, r, now), undefined)!.limits[0]

    it('finite then unlimited: unlimited, with no figure of the finite one', () => {
      const l = merged([metered(300, 20, AT), AT], [unlimited(AT + 60e3), AT + 60e3])
      expect(l).toMatchObject({ unlimited: true, usedPercent: 0 })
      expect(l.used).toBeUndefined()
      expect(l.entitlement).toBeUndefined()
    })

    it('unlimited then finite: the finite figure, unlimited no more', () => {
      const l = merged([unlimited(AT), AT], [metered(300, 20, AT + 60e3), AT + 60e3])
      expect(l.unlimited).toBeUndefined()
      expect(l.usedPercent).toBeCloseTo(80, 6)
      expect(l.entitlement).toBe(300)
    })

    it('out of order, either way: the one reported later stands', () => {
      expect(merged([unlimited(AT + 60e3), AT + 60e3], [metered(300, 20, AT), AT + 60e3]).unlimited).toBe(true)
      const l = merged([metered(300, 20, AT + 60e3), AT + 60e3], [unlimited(AT), AT + 60e3])
      expect(l.unlimited).toBeUndefined()
      expect(l.usedPercent).toBeCloseTo(80, 6)
    })

    it('another entitlement (a plan changed): the later reading, though its share is lower; out of order, still the later', () => {
      const upgraded = merged([metered(300, 20, AT), AT], [metered(1500, 84, AT + 60e3), AT + 60e3])
      expect([upgraded.entitlement, Math.round(upgraded.usedPercent)]).toEqual([1500, 16])
      const late = merged([metered(1500, 84, AT + 60e3), AT + 60e3], [metered(300, 20, AT), AT + 60e3])
      expect([late.entitlement, Math.round(late.usedPercent)]).toEqual([1500, 16])
    })

    it('not in the plan, then in it (a plan changed): the later reading, either way and out of order', () => {
      const none = (at: number) => premium({ isUnlimitedEntitlement: false, entitlementRequests: 0, remainingPercentage: 0 }, at)
      const l = merged([none(AT), AT], [metered(300, 90, AT + 60e3), AT + 60e3])
      expect([l.notIncluded, Math.round(l.usedPercent)]).toEqual([undefined, 10])
      expect(merged([metered(300, 90, AT + 60e3), AT + 60e3], [none(AT), AT + 60e3]).notIncluded).toBeUndefined()
      expect(merged([metered(300, 90, AT), AT], [none(AT + 60e3), AT + 60e3])).toMatchObject({ notIncluded: true, entitlement: 0 })
    })

    it('a delayed report of another allowance never replaces a newer one, though the share kept is older (HR1, round 1)', () => {
      // 10:00 entitlement 100 at 90% used; 12:00 the same entitlement at 80% (90% kept, as reported at 10:00); then a
      // report from 11:00 arrives, of another allowance: unlimited, not included, or an entitlement of 200.
      const at = Date.parse('2026-11-07T10:00:00Z')
      const report = (share: number, hours: number, extra: Record<string, unknown> = {}): PlanUsage => ({ provider: 'copilot', plan: null, updatedAt: new Date(at + hours * 3600e3).toISOString(), limits: [{ id: 'premium_interactions', label: 'premium_interactions', models: 'premium', windowMinutes: null, usedPercent: share, resetsAt: resets, entitlement: 100, ...extra }] })
      const latest = mergePlanUsage(mergePlanUsage(undefined, report(90, 0), at), report(80, 2), at + 7200e3)
      expect(latest.limits[0]).toMatchObject({ usedPercent: 90, reportedAt: new Date(at).toISOString(), allowanceAt: new Date(at + 7200e3).toISOString() })
      for (const [name, extra] of [['unlimited', { unlimited: true, entitlement: undefined }], ['not included', { notIncluded: true, entitlement: 0 }], ['entitlement 200', { entitlement: 200 }]] as const) {
        const late = mergePlanUsage(latest, report(name === 'entitlement 200' ? 10 : 0, 1, extra), at + 7200e3).limits[0]
        expect([late.unlimited, late.notIncluded, late.entitlement, late.usedPercent], name).toEqual([undefined, undefined, 100, 90])
        // The share kept says when it was reported: 10:00, not the delayed report's 11:00.
        expect(late.reportedAt, name).toBe(new Date(at).toISOString())
      }
      // A report of another allowance later than every one seen: it stands.
      expect(mergePlanUsage(latest, report(0, 3, { unlimited: true, entitlement: undefined }), at + 3 * 3600e3).limits[0].unlimited).toBe(true)
    })

    it('the same entitlement: the higher share within the period, as before', () => {
      const l = merged([metered(300, 20, AT), AT], [metered(300, 50, AT + 60e3), AT + 60e3])
      expect(Math.round(l.usedPercent)).toBe(80)
      expect(l.used).toBe(240)
    })
  })

  describe('reported', () => {
    afterEach(() => {
      delete config.get().planUsage.antigravity
      delete config.get().planUsage.copilot
    })

    it('tells the windows when only what a limit is changes, its figures the same', () => {
      const update = vi.spyOn(config, 'update').mockImplementation(() => undefined)
      const told: string[] = []
      const off = onCombworkEvent((e) => {
        if (e.type === 'plan-usage') told.push(JSON.stringify(e.usage.limits.map((l) => l.models)))
      })
      try {
        reportPlanUsage('antigravity', agy(0.9))
        reportPlanUsage('antigravity', agy(0.9))
        const renamed = { ...agy(0.9), limits: agy(0.9).limits.map((l) => (l.id === 'gemini-weekly' ? { ...l, models: 'gemini-pro' } : l)) }
        reportPlanUsage('antigravity', renamed)
        expect(told).toHaveLength(2)
        expect(told[1]).toContain('gemini-pro')
        // Copilot's counts alone changing (its share and reset the same): told too.
        const counts = (used: number) => copilotPlanUsage({ chat: { isUnlimitedEntitlement: false, entitlementRequests: 200, usedRequests: used, remainingPercentage: 99, resetDate: '2099-12-01T00:00:00Z' } }, new Date().toISOString())!
        reportPlanUsage('copilot', counts(2))
        reportPlanUsage('copilot', counts(3))
        expect(told).toHaveLength(4)
      } finally {
        off()
        update.mockRestore()
      }
    })

    it('never warns of an unlimited limit; a metered one at the same figure is warned of', () => {
      // Its warnings as kept (config.update applied, not saved).
      const update = vi.spyOn(config, 'update').mockImplementation(((fn: (c: ReturnType<typeof config.get>) => void) => fn(config.get())) as never)
      const key = 'copilot:premium_interactions'
      try {
        delete config.get().planWarnings[key]
        const snapshot = (unlimited: boolean) => ({ premium_interactions: { isUnlimitedEntitlement: unlimited, entitlementRequests: unlimited ? -1 : 300, usedRequests: 297, remainingPercentage: 1, resetDate: '2099-12-01T00:00:00Z' } })
        const u = copilotPlanUsage(snapshot(true), new Date().toISOString())!
        reportPlanUsage('copilot', { ...u, limits: u.limits.map((l) => ({ ...l, usedPercent: 99 })) })
        expect(config.get().planWarnings[key]).toBeUndefined()
        // Nor of one the plan doesn't include (its allowance 0), whatever its placeholder says.
        delete config.get().planUsage.copilot
        const none = copilotPlanUsage({ premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 0, usedRequests: 0, remainingPercentage: 0, resetDate: '2099-12-01T00:00:00Z' } }, new Date().toISOString())!
        reportPlanUsage('copilot', { ...none, limits: none.limits.map((l) => ({ ...l, usedPercent: 100 })) })
        expect(config.get().planWarnings[key]).toBeUndefined()
        delete config.get().planUsage.copilot
        reportPlanUsage('copilot', copilotPlanUsage(snapshot(false), new Date().toISOString())!)
        expect(config.get().planWarnings[key]?.level).toBe(95)
      } finally {
        delete config.get().planWarnings[key]
        update.mockRestore()
      }
    })
  })

  it('names them by their models, weekly ones as weekly; others as before', () => {
    const gemini = agy(0.9).limits.find((l) => l.id === 'gemini-weekly')!
    const other = agy(0.9).limits.find((l) => l.id === '3p-weekly')!
    expect(limitName(gemini)).toBe('Gemini models, weekly')
    expect(limitName(other)).toBe('Other models, weekly')
    expect(limitWindow(gemini)).toBe('other')
    const copilot = copilotPlanUsage(copilotSnapshots, '2026-10-20T10:00:00Z')!.limits
    expect(copilot.map(limitName)).toEqual(['Chat messages', 'Code completions', 'Premium requests'])
    expect(limitName({ label: 'x', models: 'flash', windowMinutes: null })).toBe('flash')
    expect(limitName({ label: 'weekly', windowMinutes: WEEK })).toBe('weekly')
    expect(limitWindow({ windowMinutes: WEEK })).toBe('weekly')
    expect(limitWindow({ windowMinutes: 300 })).toBe('fiveHour')
    expect(planNotice('antigravity', { ...gemini, usedPercent: 85 }, 80).title).toBe('85% of your Antigravity Gemini models, weekly limit used')
  })

  it("a notice's title is in the window's language, the Agent API's whole in English (HR1, round 1)", () => {
    const gemini = { label: 'gemini-weekly', models: 'gemini', windowMinutes: WEEK, usedPercent: 85, resetsAt: null }
    try {
      setLanguage('de', {
        'project.limit.models': '{models, select, gemini {Gemini-Modelle} other {Andere Modelle}}{window, select, weekly {, wöchentlich} other {}}',
        'main.plan.used': '{share, number, ::percent} deines {provider}-Limits {window, select, weekly {(wöchentlich)} other {„{label}“}} verbraucht'
      })
      const n = planNotice('antigravity', gemini, 80)
      expect(n.apiTitle).toBe('85% of your Antigravity Gemini models, weekly limit used')
      expect(n.title).toContain('Gemini-Modelle, wöchentlich')
      expect(n.title).not.toContain('Gemini models')
    } finally {
      setLanguage('en', {})
    }
  })

  it('reads a reset time as ISO, or epoch seconds or milliseconds; nothing else', () => {
    expect(isoTime('2026-11-14T02:04:21Z')).toBe('2026-11-14T02:04:21.000Z')
    expect(isoTime(1_794_621_861)).toBe(new Date(1_794_621_861_000).toISOString())
    expect(isoTime(1_794_621_861_000)).toBe(new Date(1_794_621_861_000).toISOString())
    for (const v of ['soon', '', 0, -1, Number.NaN, null, undefined, {}]) expect(isoTime(v), String(v)).toBeNull()
  })
})
