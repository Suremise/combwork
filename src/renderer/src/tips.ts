import { applyTipsChange, localDay, nextTip, tipForMoment, tipForToday, type TipMoment, type TipsChange, type TipsState } from '@shared/tips'
import { call } from './api'
import { msg, tr } from '@shared/i18n'
import { get, notify, set, setActivity } from './store'

/**
 * What the tip card shows and what the tips remember (`ui.tips` in the profile). Each change shows at once from this
 * window's store and goes to main as that one change, applied to what is saved (#266), so another window's older copy
 * of the state can't undo it; every window's store follows (tips-changed). The card and Help → Tips… are in
 * components/Tips.tsx.
 */

/** This window's changes main hasn't answered yet. */
const pending: TipsChange[] = []

function update(change: TipsChange): void {
  set((st) => ({ tips: applyTipsChange(st.tips, change) }))
  pending.push(change)
  const done = (): void => void pending.splice(pending.indexOf(change), 1)
  void call('ui:changeTips', change).then(done, done)
}

/** What the tips know, as main saved it (after any window's change), with this window's changes still on their way. */
export const applyTipsState = (tips: TipsState): void => set({ tips: pending.reduce((s, c) => applyTipsChange(s, c), tips) })

const tipsOn = (): boolean => get().settings?.general.showTips !== false

function show(id: string): void {
  update({ seen: id })
  set({ tipShown: id })
}

/** Notes a command the user ran, so tips about it aren't shown by themselves. */
export function noteCommandUsed(id: string): void {
  if (!get().tips.used.includes(id)) update({ used: id })
}

/** The day's tip, when Hive starts: at most one a day, and only with tips on. */
export function showTodaysTip(): void {
  if (!tipsOn() || get().tipShown) return
  const now = new Date()
  const tip = tipForToday(get().tips, now)
  if (!tip) return
  update({ shownOn: localDay(now) })
  show(tip.id)
}

/** A moment a tip helps with (the first long transcript, the first pasted image…): its tip, the first time. */
export function offerTip(moment: TipMoment): void {
  if (!tipsOn() || get().tips.moments.includes(moment)) return
  const tip = tipForMoment(get().tips, moment)
  update({ moment })
  if (tip) show(tip.id)
}

/** Next tip in the card (also with tips turned off: the user asked). */
export function showNextTip(): void {
  const tip = nextTip(get().tips, get().tipShown)
  if (tip) show(tip.id)
}

export const closeTip = (): void => set({ tipShown: null })

/** "Don't show tips": turns the setting off; Help → Tips… still has them. */
export async function turnOffTips(): Promise<void> {
  closeTip()
  try {
    set({ settings: await call('settings:update', { general: { showTips: false } }) })
    notify('info', tr(msg({ id: 'tips.off.title', defaultMessage: 'Tips are off', description: 'A notice after "Don\'t show tips" on the tip card.' })), tr(msg({ id: 'tips.off.message', defaultMessage: 'Help → Tips… still has them, and Settings → General turns them back on.', description: 'More in the notice after the tips were turned off. Help → Tips… and Settings → General are names in Hive: keep them as Hive shows them.' })))
  } catch {
    // The card is closed either way; the setting is still in Settings → General.
  }
}

/** Opens the user guide at a heading, by its id (#1535: `<a id="…"></a>` on the heading, kept when it's renamed). */
export function openGuideAt(id: string): void {
  set({ docsPage: 'guide', docsAnchor: id })
  if (get().activity !== 'docs') setActivity('docs')
}
