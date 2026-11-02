import { applyTipsChange, localDay, nextTip, queuedToday, quietNow, tipForMoment, tipForToday, TYPING_QUIET_MS, type QueuedTip, type TipMoment, type TipsChange, type TipsState } from '@shared/tips'
import { asksYou } from '@shared/inbox'
import { call } from './api'
import { msg, tr } from '@shared/i18n'
import { get, notify, set, setActivity, useStore } from './store'

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

/**
 * The tip waiting for a quiet moment (HI-2320): shown only when nothing else goes on (@shared/tips quietNow), dropped
 * if its day ends first. A moment's tip takes the place of the day's (it is about what just happened); the day's tip is
 * then tried again at the next start.
 */
let queued: QueuedTip | null = null
/** When a key was last pressed in this window. */
let lastKeyAt: number | null = null

/** The day's tip, when Hive starts: at most one a day, only with tips on, and when nothing else goes on. */
export function showTodaysTip(): void {
  if (!tipsOn() || get().tipShown) return
  const now = new Date()
  const tip = tipForToday(get().tips, now)
  if (!tip || queued?.moment) return
  queued = { id: tip.id, day: localDay(now) }
  tryQueuedTip()
}

/**
 * A moment a tip helps with (the first long transcript, the first pasted image…): its tip, the first time, once
 * nothing else goes on, so never beside the notice it is about. The moment is used once its tip shows.
 */
export function offerTip(moment: TipMoment): void {
  if (!tipsOn() || get().tips.moments.includes(moment) || queued?.moment === moment) return
  const tip = tipForMoment(get().tips, moment)
  if (!tip) return void update({ moment })
  queued = { id: tip.id, day: localDay(new Date()), moment }
  tryQueuedTip()
}

/** The agents of this window waiting for the user (a prompt, a question, a sign-in). */
function waitingHere(s: ReturnType<typeof get>): number {
  const hosts = [...(s.workspace?.projects ?? []), ...(s.workspace?.assistant ? [s.workspace.assistant] : [])]
  return hosts.reduce((n, p) => n + p.agents.filter((a) => !!a.live && asksYou(a.live)).length, 0)
}

/** Shows the queued tip if this is a quiet moment; drops it once its day is over. */
export function tryQueuedTip(now = Date.now()): void {
  if (!queued) return
  if (!queuedToday(queued, new Date(now)) || !tipsOn()) {
    queued = null
    return
  }
  const s = get()
  if (s.tipShown || !quietNow({ focused: s.windowFocused, popups: s.toasts.length, finishesPending: s.finishesPending, waiting: waitingHere(s), lastKeyAt, now })) return
  const q = queued
  queued = null
  if (q.moment) update({ moment: q.moment })
  else update({ shownOn: q.day })
  show(q.id)
}

/** For tests: the tip waiting for a quiet moment. */
export const queuedTip = (): QueuedTip | null => queued

/**
 * Watches for the quiet moment a queued tip waits for (HI-2320): the keys pressed in the window (terminals too), the
 * pop-ups, the focus and the agents waiting; while a tip is queued, a check every few seconds as well, so the typing
 * pause and the day's end are noticed. Returns the unsubscribe.
 */
export function startTipWatch(): () => void {
  const onKey = (): void => void (lastKeyAt = Date.now())
  window.addEventListener('keydown', onKey, true)
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (queued && (s.toasts !== prev.toasts || s.windowFocused !== prev.windowFocused || s.finishesPending !== prev.finishesPending || s.workspace !== prev.workspace)) tryQueuedTip()
  })
  const timer = window.setInterval(() => queued && tryQueuedTip(), Math.min(5000, TYPING_QUIET_MS / 2))
  return () => {
    window.removeEventListener('keydown', onKey, true)
    unsubscribe()
    window.clearInterval(timer)
  }
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
