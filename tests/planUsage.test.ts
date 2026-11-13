import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempRoot } from './tempDir'

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot(), isPackaged: false, getVersion: () => '0.0.0' },
  // eslint-disable-next-line typescript/no-extraneous-class
  // Windows notifications, recorded (supported only where a test says so).
  Notification: class {
    static isSupported(): boolean {
      return (globalThis as { __osSupported?: boolean }).__osSupported === true
    }
    constructor(readonly options: { title: string }) {}
    on(): this {
      return this
    }
    show(): void {
      ;((globalThis as { __osShown?: string[] }).__osShown ??= []).push(this.options.title)
    }
  }
}))

const { config } = await import('../src/main/config')
const { connectionLoginChanged, forgetConnectionUsage, mergePlanUsage, nextWarning, planNotice, readingAges, reportPlanUsage, usageLogin, warnedAfterDrop, warningKey } = await import('../src/main/planUsage')
const { parseClaudePlanUsage } = await import('../src/main/providers/claude/adapter')
const { rolloutPlanUsage } = await import('../src/main/providers/codex/rollout')
const { onCombworkEvent } = await import('../src/main/events')
const { setNotifyHost } = await import('../src/main/notify')
const { DEFAULT_SETTINGS } = await import('../src/shared/defaults')

// Resets ahead of now, as a current reading's are (one past its reset is an old period's: #383).
const FIVE_RESETS = new Date(Date.now() + 3 * 3600e3).toISOString()
const WEEK_RESETS = new Date(Date.now() + 4 * 86400e3).toISOString()
const usage = (five: number, week = 10) => ({
  provider: 'claude-code',
  plan: null,
  limits: [
    { id: 'five_hour', label: '5-hour', windowMinutes: 300, usedPercent: five, resetsAt: FIVE_RESETS },
    { id: 'seven_day', label: 'weekly', windowMinutes: 10080, usedPercent: week, resetsAt: WEEK_RESETS }
  ],
  updatedAt: new Date().toISOString()
})

describe('reportPlanUsage', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('saves only when a shown value changes, and at most once a minute', () => {
    const saves: number[] = []
    const update = vi.spyOn(config, 'update').mockImplementation(() => void saves.push(Date.now()))
    // Reports several times a second for a minute, as while agents work: same values, new report times.
    for (let i = 0; i < 200; i++) {
      reportPlanUsage('claude-code', usage(12.2))
      vi.advanceTimersByTime(300)
    }
    expect(saves.length).toBe(1) // the first report
    expect(config.get().planUsage['claude-code']?.limits[0].usedPercent).toBe(12.2)
    // Values changing every second for three minutes: still no more than one save a minute.
    for (let s = 0; s < 180; s++) {
      reportPlanUsage('claude-code', usage(13 + s / 10))
      vi.advanceTimersByTime(1000)
    }
    vi.advanceTimersByTime(60_000)
    for (let i = 1; i < saves.length; i++) expect(saves[i] - saves[i - 1]).toBeGreaterThanOrEqual(60_000)
    expect(saves.length).toBeLessThanOrEqual(5)
    // The latest report is always in memory, for the status bar and for the save on quit.
    expect(config.get().planUsage['claude-code']?.limits[0].usedPercent).toBeCloseTo(30.9)
    update.mockRestore()
  })
})

// A warning is told once (HI-2320): a pop-up in the window you are using (kept in its bell), or a Windows notification
// with Combwork in the background (its bell row kept quietly), never both, never a second copy.
describe('a plan usage warning', () => {
  const g = globalThis as { __osSupported?: boolean; __osShown?: string[] }
  const seen: { type: string; toast?: { quiet?: boolean; title: string; kind?: string }; notice?: { title: string }; windows?: true }[] = []
  let off: () => void
  const win = { isDestroyed: () => false, webContents: { id: 7, send: () => undefined } }
  let focused = false
  beforeEach(() => {
    g.__osSupported = true
    g.__osShown = []
    seen.length = 0
    focused = false
    off = onCombworkEvent((e) => void seen.push(e as never))
    vi.spyOn(config, 'update').mockImplementation((fn: (c: ReturnType<typeof config.get>) => void) => fn(config.get()))
    config.get().planWarnings = {}
    setNotifyHost({ focused: () => (focused ? { win: win as never, workspacePath: 'C:\\Work\\A', projectPath: 'C:\\Work\\A\\alpha' } : null), fallback: () => win as never, workspaceOf: () => null })
  })
  afterEach(() => {
    off()
    vi.restoreAllMocks()
    setNotifyHost({ focused: () => null, fallback: () => null, workspaceOf: () => null })
    Object.assign(config.settings.notifications, DEFAULT_SETTINGS.notifications)
    g.__osSupported = false
  })
  const warn = () => {
    reportPlanUsage('claude-code', usage(96))
    const toasts = seen.filter((e) => e.type === 'toast').map((e) => e.toast!)
    return {
      // One entry, of the usage kind, in the window's bell either way.
      entries: toasts.filter((t) => t.kind === 'usage' && /96% of your Claude Code 5-hour limit/.test(t.title)).length,
      popups: toasts.filter((t) => !t.quiet).length,
      windows: g.__osShown!.length,
      // The Agent API's stream hears of it, marked when it went to a Windows notification (#620).
      told: seen.filter((e) => e.type === 'notice' && e.windows).length
    }
  }

  it('Combwork in the background: a Windows notification, its row kept in the bell, no pop-up', () => {
    expect(warn()).toEqual({ entries: 1, popups: 0, windows: 1, told: 1 })
  })
  it('a Combwork window focused: a pop-up in it, no Windows notification', () => {
    focused = true
    expect(warn()).toEqual({ entries: 1, popups: 1, windows: 0, told: 0 })
  })
  it('focused, pop-ups about agents only in the bell: plan usage is about no project, so it still pops up', () => {
    focused = true
    config.settings.notifications.bannerScope = 'none'
    expect(warn()).toEqual({ entries: 1, popups: 1, windows: 0, told: 0 })
  })
  it('notifications off: nothing at all, focused or not', () => {
    config.settings.notifications.desktopNotifications = false
    expect(warn()).toEqual({ entries: 0, popups: 0, windows: 0, told: 0 })
  })
})

// HI-1756 (Connections S5): a session on a connection reports that login's own limits, kept and warned of per
// connection, never mixed into its CLI's (two logins, Max 1 near its limit and Max 2 not, are two sets of figures).
describe('plan usage per connection (HI-1756)', () => {
  const ONE = { email: 'one@example.com', orgId: 'org-1' }
  const TWO = { email: 'two@example.com', orgId: 'org-1' }
  const THREE = { email: 'three@example.com', orgId: 'org-3' }
  // A session's launchedConnection: its connection, and who it launched as.
  const MAX1 = { id: 'a-11111111', name: 'Max 1', login: usageLogin(ONE)! }
  const MAX2 = { id: 'a-22222222', name: 'Max 2', login: usageLogin(TWO)! }
  const events: { type: string; provider?: string; connection?: string; toast?: { title: string } }[] = []
  let off: () => void
  /** The connections Combwork keeps, each accepted as (and now signed in as) its login. */
  const signedIn = (id: string, who: { email: string; orgId: string }, observed: { email: string; orgId: string } = who) => {
    const all = (config.get().accounts ?? []).filter((c) => c.id !== id)
    config.get().accounts = [...all, { id, provider: 'claude-code', name: id, createdAt: '2026-10-27T00:00:00Z', accepted: who, observed: { at: '2026-10-27T00:00:00Z', loggedIn: true, ...observed } }]
  }
  beforeEach(() => {
    events.length = 0
    off = onCombworkEvent((e) => void events.push(e as never))
    // A window owns the warnings (HI-2320: told once, to one window), whose events the listeners hear.
    setNotifyHost({ focused: () => null, fallback: () => ({ isDestroyed: () => false, webContents: { id: 8, send: () => undefined } }) as never, workspaceOf: () => null })
    vi.spyOn(config, 'update').mockImplementation((fn: (c: ReturnType<typeof config.get>) => void) => fn(config.get()))
    config.get().planWarnings = {}
    config.get().planUsage = {}
    config.get().connectionPlanUsage = {}
    config.get().accounts = []
    signedIn(MAX1.id, ONE)
    signedIn(MAX2.id, TWO)
  })
  afterEach(() => {
    off()
    vi.restoreAllMocks()
  })
  const toasts = (): string[] => events.filter((e) => e.type === 'toast').map((e) => e.toast!.title)

  it("keys a report by its connection's id, apart from its CLI's and the other connection's", () => {
    reportPlanUsage('claude-code', usage(62), 'HB1', MAX1)
    reportPlanUsage('claude-code', usage(30), 'HB2', MAX2)
    reportPlanUsage('claude-code', usage(5), 'Other')
    const kept = config.get().connectionPlanUsage!
    expect(kept[MAX1.id].limits[0]).toMatchObject({ usedPercent: 62, reportedBy: 'HB1' })
    expect(kept[MAX2.id].limits[0]).toMatchObject({ usedPercent: 30, reportedBy: 'HB2' })
    expect(config.get().planUsage['claude-code']?.limits[0].usedPercent).toBe(5)
    // The windows are told which connection each is for (none for the CLI's own).
    expect(events.filter((e) => e.type === 'plan-usage').map((e) => [e.provider, e.connection ?? null])).toEqual([
      ['claude-code', MAX1.id],
      ['claude-code', MAX2.id],
      ['claude-code', null]
    ])
  })

  it('warns per connection, naming it: one at 96% is warned of, the other at 30% not, and each only once a period', () => {
    reportPlanUsage('claude-code', usage(96), 'HB1', MAX1)
    reportPlanUsage('claude-code', usage(30), 'HB2', MAX2)
    reportPlanUsage('claude-code', usage(97), 'HB1', MAX1)
    expect(toasts()).toEqual(['96% of the 5-hour limit used on Max 1'])
    expect(Object.keys(config.get().planWarnings)).toEqual([warningKey('claude-code', 'five_hour', MAX1.id)])
    expect(warningKey('claude-code', 'five_hour', MAX1.id)).toBe(`connection:${MAX1.id}:five_hour`)
    // Max 2 crossing it later is its own warning; the CLI's own key is untouched by either.
    reportPlanUsage('claude-code', usage(85), 'HB2', MAX2)
    expect(toasts()).toEqual(['96% of the 5-hour limit used on Max 1', '85% of the 5-hour limit used on Max 2'])
    expect(config.get().planWarnings['claude-code:five_hour']).toBeUndefined()
  })

  it("a connection's notice names it; the CLI's names the CLI, as before", () => {
    const l = usage(96).limits[0]
    expect(planNotice('claude-code', l, 95, 'Max 1').title).toBe('96% of the 5-hour limit used on Max 1')
    expect(planNotice('claude-code', l, 95, 'Max 1').apiTitle).toBe('96% of the 5-hour limit used on Max 1')
    expect(planNotice('claude-code', { ...l, windowMinutes: 10080, label: 'weekly' }, 95, 'Max 2').title).toBe('96% of the weekly limit used on Max 2')
    expect(planNotice('claude-code', l, 95).title).toBe('96% of your Claude Code 5-hour limit used')
  })

  it("is a login's (HR2's round 1): another login kept on the connection clears its figures and warnings, here and in the windows", () => {
    reportPlanUsage('claude-code', usage(96), 'HB2', MAX2)
    expect(config.get().connectionPlanUsage![MAX2.id].login).toBe(MAX2.login)
    // Max 2 signed in again as another login, and that kept (accounts.ts: observed, then accepted, each a record change).
    signedIn(MAX2.id, TWO, THREE)
    connectionLoginChanged(MAX2.id)
    expect(config.get().connectionPlanUsage![MAX2.id]).toBeUndefined()
    expect(Object.keys(config.get().planWarnings)).toEqual([])
    expect(events.filter((e) => e.type === 'plan-usage-cleared').map((e) => e.connection)).toEqual([MAX2.id])
    signedIn(MAX2.id, THREE)
    connectionLoginChanged(MAX2.id)
    // The old login's session, still running, can't fill the new login's figures...
    reportPlanUsage('claude-code', usage(97), 'HB2', MAX2)
    expect(config.get().connectionPlanUsage![MAX2.id]).toBeUndefined()
    // ...a session launched as the new one does, from nothing: 1%, and warned of afresh when it crosses 80%.
    const asThree = { ...MAX2, login: usageLogin(THREE)! }
    reportPlanUsage('claude-code', usage(1, 1), 'HB2', asThree)
    expect(config.get().connectionPlanUsage![MAX2.id]).toMatchObject({ login: asThree.login, limits: [{ usedPercent: 1 }, { usedPercent: 1 }] })
    reportPlanUsage('claude-code', usage(85), 'HB2', asThree)
    expect(toasts()).toEqual(['96% of the 5-hour limit used on Max 2', '85% of the 5-hour limit used on Max 2'])
    // Max 1's own figures are untouched throughout.
    reportPlanUsage('claude-code', usage(62), 'HB1', MAX1)
    expect(config.get().connectionPlanUsage![MAX1.id].limits[0].usedPercent).toBe(62)
  })

  it('a sign-in again as the same login keeps its figures and warnings; a launch whose login is unknown reports nothing', () => {
    reportPlanUsage('claude-code', usage(96), 'HB2', MAX2)
    signedIn(MAX2.id, { email: 'TWO@example.com', orgId: 'org-1' })
    connectionLoginChanged(MAX2.id)
    expect(config.get().connectionPlanUsage![MAX2.id].limits[0].usedPercent).toBe(96)
    expect(Object.keys(config.get().planWarnings)).toEqual([warningKey('claude-code', 'five_hour', MAX2.id)])
    expect(events.some((e) => e.type === 'plan-usage-cleared')).toBe(false)
    reportPlanUsage('claude-code', usage(20), 'HB3', { id: MAX1.id, name: MAX1.name })
    expect(config.get().connectionPlanUsage![MAX1.id]).toBeUndefined()
  })

  it("a login changed in a pane, not yet answered: its new sessions' figures count, the old login's sessions' no longer", () => {
    reportPlanUsage('claude-code', usage(70), 'HB1', MAX1)
    // Max 1 now signed in as three@ (a /login in a pane): accepted is still one@, but new sessions launch as three@.
    signedIn(MAX1.id, ONE, THREE)
    connectionLoginChanged(MAX1.id)
    expect(config.get().connectionPlanUsage![MAX1.id]).toBeUndefined()
    reportPlanUsage('claude-code', usage(75), 'HB1', MAX1)
    expect(config.get().connectionPlanUsage![MAX1.id]).toBeUndefined()
    reportPlanUsage('claude-code', usage(10), 'HB4', { ...MAX1, login: usageLogin(THREE)! })
    expect(config.get().connectionPlanUsage![MAX1.id].limits[0].usedPercent).toBe(10)
  })

  // HI-1882: Codex's login check gives an email and a plan, no organisation, so no Codex launch had a login and every
  // report from its rollouts was dropped (no Codex-1 in the status bar).
  it("a Codex connection's login is its email alone, and its rollout's rate limits are kept as that connection's", () => {
    // Accepted as accounts.ts keeps a Codex login (acceptable(…, false): an empty organisation), observed with none.
    const codex = { email: 'me@example.com', orgId: '' }
    expect(usageLogin(codex)).toMatch(/^[0-9a-f]{16}$/)
    expect(usageLogin({ email: 'ME@example.com' })).toBe(usageLogin(codex))
    expect(usageLogin(codex)).not.toBe(usageLogin({ ...codex, orgId: 'org-1' }))
    expect(usageLogin({ orgId: 'org-1' })).toBeNull()
    const id = 'a-5d629d1e'
    config.get().accounts = [...config.get().accounts!, { id, provider: 'codex', name: 'Codex-1', createdAt: '2026-10-27T00:00:00Z', accepted: codex, observed: { at: '2026-10-27T00:00:00Z', loggedIn: true, email: codex.email, plan: 'prolite' } }]
    const report = rolloutPlanUsage({ primary: { used_percent: 57, window_minutes: 10080, resets_at: Math.floor(Date.parse(WEEK_RESETS) / 1000) }, plan_type: 'prolite' }, new Date().toISOString())!
    reportPlanUsage('codex', report, 'HR3', { id, name: 'Codex-1', login: usageLogin(codex)! })
    expect(config.get().connectionPlanUsage![id]).toMatchObject({ plan: 'prolite', login: usageLogin(codex), limits: [{ id: 'w10080', usedPercent: 57, reportedBy: 'HR3' }] })
    expect(events.filter((e) => e.type === 'plan-usage').map((e) => [e.provider, e.connection])).toEqual([['codex', id]])
  })

  it('a connection removed takes its usage and warnings with it, and leaves the others', () => {
    reportPlanUsage('claude-code', usage(96), 'HB1', MAX1)
    reportPlanUsage('claude-code', usage(90), 'HB2', MAX2)
    forgetConnectionUsage(MAX1.id)
    expect(Object.keys(config.get().connectionPlanUsage!)).toEqual([MAX2.id])
    expect(Object.keys(config.get().planWarnings)).toEqual([warningKey('claude-code', 'five_hour', MAX2.id)])
  })
})

// #383: what the CLIs really send (tests/fixtures/planusage-2026-10-19.json, recorded through the developer console):
// each session relays the reading of its own latest API call, so reports come out of order, and a resumed Codex
// session reports the last reading in its rollout, however old. Combwork keeps the truth: usage never goes down within a
// reset period.
describe('the plan usage Combwork keeps from its sessions (#383)', () => {
  const recorded = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'planusage-2026-10-19.json'), 'utf8'))
  const statusLines: { at: string; agent: string; rate_limits: Record<string, { used_percentage: number; resets_at: number }> | null }[] = recorded.claude.statusLines
  const reading = statusLines.find((s) => s.rate_limits)!
  const at = Date.parse(reading.at)
  /** A Claude Code status line as recorded, with the weekly figure changed, parsed as Combwork does. */
  const claude = (weekly: number, when = at, resets = reading.rate_limits!.seven_day.resets_at) =>
    parseClaudePlanUsage({ rate_limits: { ...reading.rate_limits, seven_day: { used_percentage: weekly, resets_at: resets } } }, new Date(when))!
  const weekly = (u: { limits: { id: string; usedPercent: number }[] }) => u.limits.find((l) => l.id === 'seven_day')?.usedPercent

  it("reads the recorded status lines: one session's or another's, the same limits", () => {
    const parsed = statusLines.filter((s) => s.rate_limits).map((s) => parseClaudePlanUsage(s as never, new Date(s.at))!)
    expect(new Set(parsed.map((p) => JSON.stringify(p.limits)))).toEqual(new Set([JSON.stringify(parsed[0].limits)]))
    expect(parsed[0].limits.map((l) => l.id)).toEqual(['five_hour', 'seven_day'])
    // A session's first status line, fresh or resumed, has no limits until it calls the API: nothing to report.
    expect(statusLines.some((s) => s.rate_limits === null)).toBe(true)
    expect(parseClaudePlanUsage({ rate_limits: null }, new Date(at))).toBeNull()
  })

  it('two sessions reporting 98% and 96% for the same week, alternating, keep showing 98%', () => {
    let kept = mergePlanUsage(undefined, claude(98), at, 'A')
    for (let i = 1; i <= 6; i++) kept = mergePlanUsage(kept, claude(i % 2 ? 96 : 98, at + i * 1000), at + i * 1000, i % 2 ? 'B' : 'A')
    expect(weekly(kept)).toBe(98)
    // Who reported the figure kept, and when.
    expect(kept.limits.find((l) => l.id === 'seven_day')).toMatchObject({ reportedBy: 'A', reportedAt: new Date(at + 6000).toISOString() })
    // A higher reading still takes over at once.
    expect(weekly(mergePlanUsage(kept, claude(98.5, at + 7000), at + 7000, 'B'))).toBe(98.5)
  })

  it('takes the new period at once when the reset passes, and never a reading of a period already over', () => {
    const resets = reading.rate_limits!.seven_day.resets_at
    const kept = mergePlanUsage(undefined, claude(99), at)
    const after = resets * 1000 + 60_000
    // The week reset: the first reading of the new week is taken, though lower.
    const next = mergePlanUsage(kept, claude(2, after, resets + 7 * 86400), after, 'A')
    expect(weekly(next)).toBe(2)
    // A session still relaying last week's reading (its reset passed) is ignored.
    expect(weekly(mergePlanUsage(next, claude(99, after + 1000), after + 1000, 'B'))).toBe(2)
    // An earlier period's reading, its reset not yet passed but before the kept one's, is ignored too.
    expect(weekly(mergePlanUsage(next, claude(50, after, resets + 3600), after, 'B'))).toBe(2)
    // With nothing kept, an over period's reading isn't shown at all.
    expect(mergePlanUsage(undefined, claude(99, after), after).limits.find((l) => l.id === 'seven_day')).toBeUndefined()
  })

  it("a resumed Codex session's old rollout reading doesn't replace the current one", () => {
    const record = recorded.codex.tokenCount
    const old = rolloutPlanUsage(record.payload.rate_limits, record.timestamp)!
    expect(old.limits.map((l) => [l.id, l.usedPercent])).toEqual([['w10080', 17]])
    const week = Date.parse(old.limits[0].resetsAt!)
    // Now: a week later, the next period, 5% used; then the resumed session reads its rollout's last record.
    const now = week + 3600e3
    const current = { ...old, limits: [{ ...old.limits[0], usedPercent: 5, resetsAt: new Date(week + 7 * 86400e3).toISOString() }], updatedAt: new Date(now).toISOString() }
    const kept = mergePlanUsage(undefined, current, now, 'C1')
    expect(mergePlanUsage(kept, old, now, 'C2').limits).toEqual(kept.limits)
  })

  it('keeps a reading through a reset time that wobbles either way (round 3, finding 1)', () => {
    const t = Date.parse('2026-10-19T12:00:00Z')
    const limit = (used: number, resetsAt: string, updatedAt: string) => ({ provider: 'claude-code' as const, plan: null, limits: [{ id: 'five_hour', label: '5-hour', windowMinutes: 300, usedPercent: used, resetsAt }], updatedAt })
    let kept = mergePlanUsage(undefined, limit(97, '2026-10-19T12:10:20.000Z', '2026-10-19T12:00:00Z'), t)
    for (const used of [97, 98]) {
      const k = mergePlanUsage(kept, limit(used, '2026-10-19T12:10:00.000Z', '2026-10-19T12:05:00Z'), t + 5 * 60e3)
      // The later reset time is kept, so the reading stays until its own reset.
      expect(k.limits[0]).toMatchObject({ usedPercent: used, resetsAt: '2026-10-19T12:10:20.000Z' })
      expect(mergePlanUsage(k, limit(0, '2026-10-19T17:10:00Z', '2026-10-19T12:10:05Z'), t + 605e3).limits[0].usedPercent).toBe(0)
      kept = k
    }
  })

  it('a lower reading, however close, never clears a warning or the figure (round 3, finding 2)', () => {
    for (const [high, low] of [[95.1, 94.9], [80.2, 79.8]]) {
      const kept = mergePlanUsage(undefined, claude(high), at)
      const next = mergePlanUsage(kept, claude(low, at + 1000), at + 1000)
      expect(weekly(next)).toBe(high)
      // Warned once at the level crossed; the lower reading doesn't make it warn again or drop it.
      const warned = { resetsAt: next.limits[1].resetsAt, level: nextWarning(kept.limits[1], undefined)! }
      expect(warned.level).toBe(high >= 95 ? 95 : 80)
      expect(nextWarning(next.limits[1], warned)).toBeNull()
    }
  })

  it('tells the windows of a raw change across a warning threshold, though it rounds the same (round 4, finding 1)', () => {
    const told: number[] = []
    const off = onCombworkEvent((e) => {
      if (e.type === 'plan-usage') told.push((e as { usage: { limits: { id: string; usedPercent: number }[] } }).usage.limits.find((l) => l.id === 'seven_day')!.usedPercent)
    })
    const update = vi.spyOn(config, 'update').mockImplementation((fn: (c: ReturnType<typeof config.get>) => void) => fn(config.get()))
    try {
      for (const [low, high] of [[94.9, 95.1], [79.8, 80.2]]) {
        // A period of its own each, so what was kept before doesn't count.
        const resets = new Date(Date.now() + (low > 90 ? 5 : 6) * 86400e3).toISOString()
        const report = (used: number) => ({ ...claude(used), limits: claude(used).limits.map((l) => ({ ...l, resetsAt: resets })) })
        delete config.get().planUsage['claude-code']
        reportPlanUsage('claude-code', report(low), 'A')
        reportPlanUsage('claude-code', report(high), 'A')
        expect(told.slice(-2)).toEqual([low, high])
      }
    } finally {
      off()
      update.mockRestore()
    }
  })

  describe('a usage reset that lowers the share mid-period (HI-3181)', () => {
    /** Sessions reporting in turn, each with its readings' ages as reportPlanUsage works them out. */
    const run = (kept: ReturnType<typeof mergePlanUsage> | undefined, steps: [string, number][], memo = new Map(), from = at) => {
      steps.forEach(([who, used], i) => {
        const t = from + (i + 1) * 60_000
        const report = claude(used, t)
        kept = mergePlanUsage(kept, report, t, who, readingAges(who, report, memo))
      })
      return kept!
    }

    it("is shown at the session's next report with the lower figure; an idle session's older, higher one can't raise it back", () => {
      const memo = new Map()
      // A worked up to 96% and went idle, repeating it; B read 96% too; then the reset, and B's next call reads 77%.
      let kept = run(undefined, [['A', 95], ['A', 96], ['B', 96], ['A', 96], ['B', 96]], memo)
      kept = run(kept, [['B', 77]], memo, at + 5 * 60_000)
      expect(weekly(kept)).toBe(77)
      expect(kept.limits.find((l) => l.id === 'seven_day')).toMatchObject({ reportedBy: 'B' })
      // A still repeats its 96% from before the reset: older than B's 77%, it stays 77%.
      kept = run(kept, [['A', 96], ['B', 77], ['A', 96]], memo, at + 6 * 60_000)
      expect(weekly(kept)).toBe(77)
      // Usage climbing again after the reset is shown as before, from either session.
      kept = run(kept, [['B', 78], ['A', 79]], memo, at + 9 * 60_000)
      expect(weekly(kept)).toBe(79)
    })

    it('a session changing its figure on the very next report is shown, with no repeat between (HR3, round 2)', () => {
      for (const steps of [[['A', 96], ['A', 77]], [['A', 95], ['A', 96], ['A', 77]]] as [string, number][][]) {
        const memo = new Map()
        let kept = run(undefined, steps, memo)
        expect(weekly(kept)).toBe(77)
        kept = run(kept, [['A', 77], ['A', 77]], memo, at + steps.length * 60_000)
        expect(weekly(kept)).toBe(77)
      }
    })

    it('a figure kept before HI-3181, with no ages, gives way to a session reading lower since it was reported', () => {
      const old = mergePlanUsage(undefined, claude(96), at, 'HB5')
      expect(old.limits.find((l) => l.id === 'seven_day')!.firstSeenAt).toBeUndefined()
      const memo = new Map()
      // A session's first report can't be dated: the higher figure stays (#383) until that session's figure changes.
      let kept = run(old, [['C', 77]], memo)
      expect(weekly(kept)).toBe(96)
      kept = run(kept, [['C', 78]], memo, at + 60_000)
      expect(weekly(kept)).toBe(78)
    })

    it("after a drop, a session's first report or a forgotten session's repeat, higher, can't raise it back (HR1's round 1)", () => {
      const memo = new Map()
      let kept = run(undefined, [['A', 96], ['A', 96], ['A', 77]], memo)
      expect(weekly(kept)).toBe(77)
      // B, never seen (or forgotten: a restart, the memo's cap), reports its older 96% and repeats it; A repeats its 77%.
      kept = run(kept, [['B', 96], ['A', 77], ['B', 96], ['A', 77]], memo, at + 3 * 60_000)
      expect(weekly(kept)).toBe(77)
      // B's figure changing shows it read since: its next call's reading counts.
      kept = run(kept, [['B', 78]], memo, at + 7 * 60_000)
      expect(weekly(kept)).toBe(78)
    })

    it("a session's first report, or an older one it repeats, still never lowers the figure (#383)", () => {
      const memo = new Map()
      // A reads 98% now; B, resumed, reports its older 96% and repeats it: kept at 98%.
      expect(weekly(run(undefined, [['A', 98], ['B', 96], ['A', 98], ['B', 96]], memo))).toBe(98)
    })

    it('lowers the warning level with the figure, so a climb back past a level warns again', () => {
      const resetsAt = WEEK_RESETS
      const warned = { resetsAt, level: 95 }
      expect(warnedAfterDrop({ usedPercent: 77, resetsAt }, warned)).toBe(0)
      expect(warnedAfterDrop({ usedPercent: 85, resetsAt }, warned)).toBe(80)
      expect(warnedAfterDrop({ usedPercent: 96, resetsAt }, warned)).toBeNull()
      expect(warnedAfterDrop({ usedPercent: 50, resetsAt: new Date(Date.parse(resetsAt) + 7 * 86400e3).toISOString() }, warned)).toBeNull()
      expect(nextWarning({ usedPercent: 81, resetsAt }, { resetsAt, level: 0 })).toBe(80)
    })
  })

  it('with no reset time to tell periods apart, the latest report, as before; a limit not reported stays until its reset', () => {
    const plain = (used: number) => ({ provider: 'codex' as const, plan: null, limits: [{ id: 'primary', label: 'primary', windowMinutes: null, usedPercent: used, resetsAt: null }], updatedAt: new Date(at).toISOString() })
    expect(mergePlanUsage(mergePlanUsage(undefined, plain(40), at), plain(30), at).limits[0].usedPercent).toBe(30)
    const both = mergePlanUsage(undefined, claude(60), at)
    const onlyWeekly = { ...claude(61), limits: claude(61).limits.filter((l) => l.id === 'seven_day') }
    const next = mergePlanUsage(both, onlyWeekly, at)
    expect(next.limits.map((l) => [l.id, l.usedPercent])).toEqual([['seven_day', 61], ['five_hour', 0]])
  })
})
