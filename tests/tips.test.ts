// Tips: which one shows (one a day, unseen first, skipping what the user already does, in rounds), the moments
// that show one once, and the content itself (unique ids, a user guide heading behind each Learn more).
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tr } from '../src/shared/i18n'
import { docOutline } from '../src/shared/docSections'
import { EMPTY_TIPS_STATE, TIP_ENTRIES, TIP_GROUPS, TIP_MOMENTS, TIPS, applyTipsChange, localDay, nextTip, queuedToday, quietNow, sawTip, TYPING_QUIET_MS, tipForMoment, tipForToday, tipsChange, tipsState, usedCommand, type Tip, type TipsChange, type TipsState } from '../src/shared/tips'

const t = (id: string, command?: string, knownBy?: string[]): Tip => ({ id, group: 'Sessions', order: 0, title: id, text: id, command, knownBy })
const tips = [t('a', 'cmd.a'), t('b'), t('c', 'cmd.c'), t('d', 'cmd.d', [])]

describe('choosing a tip', () => {
  it('shows one a day', () => {
    const today = new Date(2026, 9, 2, 9)
    expect(tipForToday(EMPTY_TIPS_STATE, today, tips)?.id).toBe('a')
    expect(tipForToday({ ...EMPTY_TIPS_STATE, shownOn: localDay(today) }, new Date(2026, 9, 2, 23), tips)).toBeNull()
    expect(tipForToday({ ...EMPTY_TIPS_STATE, shownOn: localDay(today) }, new Date(2026, 9, 3, 0, 5), tips)?.id).toBe('a')
  })

  it("doesn't repeat a tip until the round is over, then starts again", () => {
    let s: TipsState = EMPTY_TIPS_STATE
    const shown: string[] = []
    for (let i = 0; i < 6; i++) {
      const tip = nextTip(s, shown.at(-1) ?? null, tips)!
      shown.push(tip.id)
      s = sawTip(s, tip.id, tips)
    }
    expect(shown).toEqual(['a', 'b', 'c', 'd', 'a', 'b'])
    // Starting again after a restart: the next unseen one.
    expect(nextTip(sawTip(sawTip(EMPTY_TIPS_STATE, 'a', tips), 'b', tips), null, tips)?.id).toBe('c')
  })

  it("skips tips about what the user already does (knownBy, by default the tip's command)", () => {
    const s = usedCommand(usedCommand(EMPTY_TIPS_STATE, 'cmd.a'), 'cmd.d')
    expect(nextTip(s, null, tips)?.id).toBe('b')
    expect(nextTip(s, 'b', tips)?.id).toBe('c')
    // d's knownBy is empty: running its command doesn't hide it.
    expect(nextTip(s, 'c', tips)?.id).toBe('d')
    expect(nextTip(usedCommand(usedCommand(EMPTY_TIPS_STATE, 'cmd.a'), 'cmd.c'), null, [t('a', 'cmd.a'), t('c', 'cmd.c')])).toBeNull()
  })

  it('shows a moment\'s tip once, and not when the user knows it', () => {
    const tip = TIPS.find((x) => x.id === TIP_MOMENTS['compact-suggested'])!
    expect(tipForMoment(EMPTY_TIPS_STATE, 'compact-suggested')?.id).toBe(tip.id)
    expect(tipForMoment({ ...EMPTY_TIPS_STATE, moments: ['compact-suggested'] }, 'compact-suggested')).toBeNull()
    expect(tipForMoment(usedCommand(EMPTY_TIPS_STATE, tip.command!), 'compact-suggested')).toBeNull()
  })

  it('reads a damaged saved state safely', () => {
    expect(tipsState(null)).toEqual(EMPTY_TIPS_STATE)
    expect(tipsState({ seen: ['a', 3], moments: 'x', used: ['c'], shownOn: 5 })).toEqual({ seen: ['a'], moments: [], used: ['c'] })
  })
})

describe('the tips', () => {
  const guide = readFileSync(join(__dirname, '..', 'docs', 'USER_GUIDE.md'), 'utf8')
  // Learn more goes by a heading's explicit id (#1535), never its text.
  const headings = new Set(docOutline(guide).filter((h) => h.fixed).map((h) => h.slug))

  it('have unique ids, known groups, short texts and the id of a user guide heading behind Learn more', () => {
    expect(TIPS.length).toBeGreaterThanOrEqual(25)
    expect(new Set(TIPS.map((x) => x.id)).size).toBe(TIPS.length)
    for (const tip of TIPS) {
      expect(TIP_GROUPS).toContain(tip.group)
      expect((typeof tip.text === 'string' ? tip.text : tr(tip.text, { ...tip.values?.(), key: '' })).length, tip.id).toBeLessThanOrEqual(260)
      if (tip.docs) expect(headings.has(tip.docs), `${tip.id}: "${tip.docs}"`).toBe(true)
    }
  })

  it('are listed in id order (fewer merge conflicts) and shown in their own order', () => {
    const ids = TIP_ENTRIES.map((x) => x.id)
    expect(ids).toEqual([...ids].sort())
    expect(new Set(TIPS.map((x) => x.order)).size, 'two tips share an order').toBe(TIPS.length)
    expect(TIPS.map((x) => x.order)).toEqual(TIP_ENTRIES.map((x) => x.order).sort((a, b) => a - b))
  })

  it('cover every moment', () => {
    for (const id of Object.values(TIP_MOMENTS)) expect(TIPS.some((x) => x.id === id), id).toBe(true)
  })
})

// Each window sends its changes, and main applies them to what is saved (#266): one window's older copy can't undo another's.
describe('changes from several windows', () => {
  it("applies each change to what is saved, keeping the other windows' changes", () => {
    const saved: TipsState = { ...EMPTY_TIPS_STATE, seen: ['a'] }
    // Window 1 saw b; window 2, which loaded before that, ran a command and used a moment.
    const changes: TipsChange[] = [{ seen: 'b' }, { used: 'cmd.x' }, { moment: 'second-agent' }, { shownOn: '2026-10-06' }]
    const after = changes.reduce((s, c) => applyTipsChange(s, c, tips), saved)
    expect(after).toEqual({ seen: ['a', 'b'], used: ['cmd.x'], moments: ['second-agent'], shownOn: '2026-10-06' })
    expect(saved).toEqual({ ...EMPTY_TIPS_STATE, seen: ['a'] })
  })

  it('gives the same state when a change comes twice (a window reapplies its own over what main sends)', () => {
    const changes: TipsChange[] = [{ seen: 'b' }, { used: 'cmd.x' }, { moment: 'image-pasted' }]
    const once = changes.reduce((s, c) => applyTipsChange(s, c, tips), EMPTY_TIPS_STATE)
    expect(changes.reduce((s, c) => applyTipsChange(s, c, tips), once)).toEqual(once)
  })

  it('starts a new round as seeing a tip does', () => {
    const s: TipsState = { ...EMPTY_TIPS_STATE, seen: ['a', 'b', 'c'] }
    expect(applyTipsChange(s, { seen: 'd' }, tips)).toEqual(sawTip(s, 'd', tips))
  })

  it('keeps only well-formed changes', () => {
    expect(tipsChange({ seen: 'a' })).toEqual({ seen: 'a' })
    expect(tipsChange({ used: 'view.projects' })).toEqual({ used: 'view.projects' })
    expect(tipsChange({ moment: 'second-agent' })).toEqual({ moment: 'second-agent' })
    expect(tipsChange({ shownOn: '2026-10-06' })).toEqual({ shownOn: '2026-10-06' })
    for (const bad of [null, 'a', [], {}, { seen: '' }, { seen: 1 }, { seen: 'a', used: 'b' }, { moment: 'toString' }, { moment: 'nope' }, { shownOn: 'today' }, { tips: { seen: [] } }]) expect(tipsChange(bad)).toBeUndefined()
  })
})

// HI-2320 (Darren: "tips should be shown at a time that nothing else is going on only, otherwise they are ignored").
describe('a tip only when nothing else goes on (quietNow)', () => {
  const now = 1_000_000
  const quiet = { focused: true, popups: 0, finishesPending: 0, waiting: 0, lastKeyAt: null, now }

  it('quiet: the window focused, no pop-up showing or queued, no finishes about to be told, nobody waiting, no typing', () => {
    expect(quietNow(quiet)).toBe(true)
    expect(quietNow({ ...quiet, lastKeyAt: now - TYPING_QUIET_MS })).toBe(true)
  })

  it('each of them alone holds a tip back', () => {
    expect(quietNow({ ...quiet, focused: false })).toBe(false)
    // A pop-up showing, or queued behind "+N more", or paused for the focus: all in the window's list.
    expect(quietNow({ ...quiet, popups: 1 })).toBe(false)
    expect(quietNow({ ...quiet, finishesPending: 2 })).toBe(false)
    expect(quietNow({ ...quiet, waiting: 1 })).toBe(false)
    expect(quietNow({ ...quiet, lastKeyAt: now - TYPING_QUIET_MS + 1 })).toBe(false)
  })

  it('a queued tip is for its own day: one that never found a quiet moment is not shown the next', () => {
    const q = { id: 'agent-layouts', day: '2026-11-02' }
    expect(queuedToday(q, new Date(2026, 10, 2, 23, 59))).toBe(true)
    expect(queuedToday(q, new Date(2026, 10, 3, 0, 0))).toBe(false)
  })
})
