import { useEffect, useRef, useState, type ReactNode } from 'react'
import { kindOf, MAX_POPUPS, popupMs, popupRole, staysUntilHandled } from '@shared/notify'
import type { ToastAction, ToastMessage } from '@shared/types'
import { msg, tr } from '@shared/i18n'
import { runCommandAsync } from '../commands'
import { openNoticeTarget } from '../noticeTarget'
import { call } from '../api'
import { dismissToast, isAssistantPath, set, updateToasts, useStore } from '../store'
import { cx } from '../util'
import { TipPopup } from './Tips'
import { Icon } from './ui'

/**
 * Combwork's one pop-up system (HI-2320): every notification this window is given (components/Popups, from the store's
 * `toasts`) and the tip, in one place (Settings → Notifications → Pop-up position; bottom right by default, left of the
 * Assistant's panel), with one look, one stacking, one timing, hover and keyboard handling. The bell's list
 * (Overlays.tsx NotificationCenter) shows the same entries with the same text and buttons.
 */

const M = {
  more: msg({ id: 'workspace.banners.more', defaultMessage: '+{count} more', description: 'Under the pop-ups when more arrived than fit: shows the rest. Keep it short.' }),
  region: msg({ id: 'workspace.banners.region', defaultMessage: 'Notifications', description: 'The pop-ups (notifications and tips), for screen readers.' }),
  dismiss: msg({ id: 'shell.toast.dismiss', defaultMessage: 'Dismiss', description: 'Button on a notice in the corner: closes it.' }),
  agent: msg({ id: 'shell.toast.openAgent', defaultMessage: "Open {agent}'s pane", description: "Tooltip on a notification an agent or the Assistant sent about an agent (HI-1961): clicking it shows that agent's pane (where its terminal is). {agent} is the agent's name." }),
  card: msg({ id: 'shell.toast.openCard', defaultMessage: 'Open {card}', description: 'Tooltip on a notification an agent or the Assistant sent about a card (HI-1961): clicking it opens the card ({card}, its key, e.g. HI-12).' }),
  unfinished: msg({ id: 'shell.entry.unfinished', defaultMessage: "Didn't finish: try again", description: "What a notification says above its buttons when one of them, run in another Combwork window, didn't say it had finished (that window reloaded, closed, or took too long; HI-2320). The buttons stay, to try again." }),
  project: msg({ id: 'shell.toast.openProject', defaultMessage: 'Show {project}', description: 'Tooltip on a notification about a project (HI-2320): clicking it shows the project ({project}, its name).' })
}

const LEVEL_ICON = { info: 'info', success: 'pass', warning: 'warning', error: 'error' } as const

/** An entry's icon: by its kind where that says more than its level. */
export function entryIcon(t: ToastMessage): string {
  const kind = kindOf(t)
  if (kind === 'needsYou') return 'question'
  if (kind === 'finished') return 'pass'
  if (kind === 'tip') return 'lightbulb'
  return LEVEL_ICON[t.level]
}

/**
 * Runs an entry's button (HI-2320): its command, awaited, with the button's spinner until it settles. What it did comes
 * back as the entry's resolution (main's resolveOffer, or the window's own check); a failure is its own notice and
 * leaves the buttons.
 */
export async function runEntryAction(t: ToastMessage, a: ToastAction): Promise<void> {
  set((s) => ({ entryBusy: { ...s.entryBusy, [t.id]: a.label } }))
  try {
    // About a project (an agent's, or the project itself): it runs in the window that has it, with the project shown
    // (#1437, as the banners' buttons did), whichever window this is. What it did comes back as the entry's resolution.
    const where = t.target && t.target.kind !== 'card' && !isAssistantPath(t.target.projectPath) ? t.target.projectPath : null
    // Run elsewhere and not finished there (its window didn't say in time, reloaded or went): never passed for done; its
    // buttons stay, and the entry says so.
    if (where) await call('notice:action', where, a.command, a.args ?? []).catch(() => updateToasts([t.id], [], tr(M.unfinished)))
    else await runCommandAsync(a.command, ...(a.args ?? []))
  } finally {
    set((s) => {
      const { [t.id]: _done, ...rest } = s.entryBusy
      return { entryBusy: rest }
    })
  }
}

/** Whether an entry's buttons act on something that resolves it (an offer, a condition): it stays until it says what happened. */
const resolves = (t: ToastMessage): boolean => !!t.offer || !!t.condition

/**
 * An entry's title and message, and what goes under them. With a target (an agent, a card, a project), a button that
 * opens it (after `onOpen`), its text as written and a chevron after it; its buttons are beside it, never inside.
 */
export function EntryText({ t, onOpen, children }: { t: ToastMessage; onOpen: () => void; children?: ReactNode }) {
  const text = (
    <>
      <div className="toast-title">{t.title}</div>
      {t.message && <div className="toast-msg">{t.message}</div>}
    </>
  )
  const target = t.target
  if (!target) return <div className="toast-text">{text}{children}</div>
  const tip = target.kind === 'agent' ? tr(M.agent, { agent: target.name }) : target.kind === 'card' ? tr(M.card, { card: target.label }) : tr(M.project, { project: target.project })
  return (
    <div className="toast-text">
      <button
        type="button"
        className="toast-open"
        data-opens={target.kind}
        title={tip}
        onClick={() => {
          onOpen()
          openNoticeTarget(target)
        }}
      >
        <div className="toast-open-text">{text}</div>
        {/* It opens something, which a plain notice doesn't: the chevron says so (with the pointer and the hover). */}
        <Icon name="chevron-right" className="toast-open-chevron" />
      </button>
      {children}
    </div>
  )
}

/**
 * An entry's buttons while it is unresolved (each runs its command; one that resolves the entry shows its spinner until
 * it says what happened), or what happened once it is resolved. `onNavigate`: a button that resolves nothing (Show,
 * Open…) was pressed.
 */
export function EntryActions({ t, onNavigate }: { t: ToastMessage; onNavigate?: () => void }) {
  const busy = useStore((s) => s.entryBusy[t.id])
  if (t.resolved)
    return (
      <div className="entry-outcome" role="status">
        <Icon name="check" /> {t.resolved}
      </div>
    )
  const note = t.note ? (
    <div className="entry-outcome" role="status">
      <Icon name="check" /> {t.note}
    </div>
  ) : null
  if (!t.actions?.length) return note
  return (
    <>
    {note}
    <div className="toast-actions">
      {t.actions.map((a) => (
        <button
          key={a.label}
          className="btn small primary"
          disabled={!!busy}
          aria-busy={busy === a.label || undefined}
          onClick={(e) => {
            e.stopPropagation()
            if (!resolves(t)) onNavigate?.()
            void runEntryAction(t, a)
          }}
        >
          {busy === a.label && <Icon name="loading" spin />} {a.label}
        </button>
      ))}
    </div>
    </>
  )
}

/**
 * One pop-up: closes by itself after its time (shared/notify.ts popupMs), kept while the pointer or the keyboard focus
 * is on it, or while the window isn't focused (HI-2320: Combwork's own messages wait for you to come back); one that waits
 * for you stays until handled. Escape with the focus in it closes it.
 */
function Popup({ t }: { t: ToastMessage }) {
  const seconds = useStore((s) => s.settings?.notifications.bannerSeconds ?? 6)
  const waitingStays = useStore((s) => s.settings?.notifications.waitingBannerStays ?? true)
  const windowFocused = useStore((s) => s.windowFocused)
  const busy = useStore((s) => !!s.entryBusy[t.id])
  const stays = staysUntilHandled(t, waitingStays)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const ms = popupMs(t, seconds)
  // Time left before it closes, kept while it is held.
  const left = useRef(ms)
  const resolved = t.resolved
  useEffect(() => {
    // Resolved: its own time again from now, to read what happened.
    left.current = ms
  }, [resolved, ms])
  useEffect(() => {
    if (stays || hovered || focused || busy || !windowFocused) return
    const started = Date.now()
    const timer = window.setTimeout(() => dismissToast(t.id), left.current)
    return () => {
      window.clearTimeout(timer)
      left.current = Math.max(500, left.current - (Date.now() - started))
    }
  }, [stays, hovered, focused, busy, windowFocused, t.id, resolved])
  return (
    <div
      className={cx('toast', 'popup', t.level, `kind-${kindOf(t)}`, t.resolved && 'resolved')}
      data-entry={t.id}
      data-kind={kindOf(t)}
      role={popupRole(t)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        dismissToast(t.id)
      }}
    >
      <Icon name={entryIcon(t)} className="lead" />
      <EntryText t={t} onOpen={() => dismissToast(t.id)}>
        <EntryActions t={t} onNavigate={() => dismissToast(t.id)} />
      </EntryText>
      <button className="icon-btn popup-close" aria-label={tr(M.dismiss)} title={tr(M.dismiss)} onClick={() => dismissToast(t.id)}>
        <Icon name="close" />
      </button>
    </div>
  )
}

/**
 * Every pop-up of this window, where Settings → Notifications puts them, the newest nearest the edge: four, and "+N more"
 * for the rest (those that wait for you are never dropped). A tip shows only when nothing else does (../tips.ts).
 */
export function Popups() {
  const toasts = useStore((s) => s.toasts)
  const tip = useStore((s) => s.tipShown)
  const position = useStore((s) => s.settings?.notifications.bannerPosition ?? 'bottom-right')
  // The bell's panel open lists the same entries: the pop-ups give way to it (they come back as it closes).
  const bellOpen = useStore((s) => s.showNotifications)
  const [expanded, setExpanded] = useState(false)
  const overflow = toasts.length > MAX_POPUPS
  useEffect(() => {
    if (!overflow) setExpanded(false)
  }, [overflow])
  if ((!toasts.length && !tip) || bellOpen) return null
  const shown = expanded ? toasts : toasts.slice(0, MAX_POPUPS)
  const more = toasts.length - shown.length
  const moreRow = more > 0 && (
    <button className="notice-more" onClick={() => setExpanded(true)}>
      {tr(M.more, { count: more })}
    </button>
  )
  // Nearest the edge first: the newest at the top for pop-ups at the top, at the bottom for those at the bottom.
  const bottom = position.startsWith('bottom')
  const list = bottom ? [...shown].reverse() : shown
  return (
    <div className={cx('popups', 'toasts', `at-${position}`, expanded && overflow && 'expanded')} role="region" aria-label={tr(M.region)}>
      {bottom && moreRow}
      {!bottom && tip && <TipPopup />}
      {list.map((t) => (
        <Popup key={t.id} t={t} />
      ))}
      {bottom && tip && <TipPopup />}
      {!bottom && moreRow}
    </div>
  )
}
