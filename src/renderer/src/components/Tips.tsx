import { useEffect, useRef, useState, type RefObject } from 'react'
import { cornerPlacement } from '@shared/corner'
import { TIP_GROUP_TEXT, TIP_GROUPS, TIPS, type Tip } from '@shared/tips'
import { msg, tr, tRich } from '@shared/i18n'
import type { Msg } from '@shared/i18n/msg'
import { commandKeybinding, commands, runCommand } from '../commands'
import { call } from '../api'
import { set, useStore } from '../store'
import { closeTip, openGuideAt, showNextTip, turnOffTips } from '../tips'
import { cx, formatKeybinding } from '../util'
import { Icon, IconButton, Modal, SearchInput, Switch } from './ui'

/**
 * The tip, as a pop-up of its own quieter style (HI-2320: in Popups.tsx's stack, shown only when nothing else goes on),
 * and Help → Tips…. Which tip shows, and when, is in ../tips.ts and @shared/tips.
 */

/** A tip's command, when it can run now (Try it). */
const runnable = (tip: Tip): boolean => {
  const c = tip.command ? commands.find((x) => x.id === tip.command) : undefined
  return !!c && !c.hidden?.() && (!c.when || c.when())
}

/** A tip's title or text in the language shown (#767), with its values; its {key} as nothing, for searching. */
const words = (tip: Tip, t: string | Msg): string => (typeof t === 'string' ? t : tr(t, { ...tip.values?.(), key: '' }))

/** Where a tip's {key} goes in its text, whatever the language put around it. */
const KEY = { key: true } as const

/** A tip's text with its shortcut as it is now: {key} shows the user's shortcut for the tip's `key` command. */
function TipText({ tip }: { tip: Tip }) {
  if (typeof tip.text === 'string') return <>{tip.text}</>
  const parts = tRich<typeof KEY>(tip.text, { ...tip.values?.(), key: KEY })
  return (
    <>
      {parts.map((p, i) => {
        if (p !== KEY) return p
        const id = tip.key ?? ''
        const keys = commandKeybinding(id)
        if (keys) return <kbd key={i}>{formatKeybinding(keys)}</kbd>
        // No shortcut: left out at the end, named by the command elsewhere.
        const last = parts.slice(i + 1).every((x) => typeof x === 'string' && !x.trim())
        return last ? null : tr(msg({ id: 'tips.commandName', defaultMessage: '“{command}”', description: "A command's name in a tip's text, where its shortcut would be when it has none. Use your language's quotation marks." }), { command: commands.find((c) => c.id === id)?.label ?? id })
      })}
    </>
  )
}

/**
 * Try it and Learn more, for the card and the list. Each calls its callback before it goes: Help → Tips… closes
 * for both, as it's modal; the card closes for Try it and stays beside the guide for Learn more.
 */
function TipActions({ tip, onTry, onLearn }: { tip: Tip; onTry?: () => void; onLearn?: () => void }) {
  return (
    <>
      {runnable(tip) && (
        <button
          className="btn small primary"
          onClick={() => {
            onTry?.()
            runCommand(tip.command!)
          }}
        >
          {tr(msg({ id: 'tips.ui.tryIt', defaultMessage: 'Try it', description: 'Button on a tip: runs the command it is about.' }))}
        </button>
      )}
      {tip.docs && (
        <button
          className="btn small subtle"
          onClick={() => {
            onLearn?.()
            openGuideAt(tip.docs!)
          }}
        >
          {tr(msg({ id: 'tips.ui.learnMore', defaultMessage: 'Learn more', description: 'Button on a tip: opens the user guide where it explains it.' }))}
        </button>
      )}
    </>
  )
}

/** Whether a focused terminal lies under the card: then it steps aside, so it never covers what you type. */
function useOverTerminal(ref: RefObject<HTMLDivElement | null>, on: boolean): boolean {
  const [over, setOver] = useState(false)
  useEffect(() => {
    if (!on) return setOver(false)
    const check = (): void => {
      const term = (document.activeElement as HTMLElement | null)?.closest?.('.xterm')
      const card = ref.current
      if (!term || !card) return setOver(false)
      const a = term.getBoundingClientRect()
      const b = card.getBoundingClientRect()
      setOver(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
    }
    // Focus moving out lands on the next element after the event.
    const later = (): void => void setTimeout(check, 0)
    check()
    document.addEventListener('focusin', check)
    document.addEventListener('focusout', later)
    window.addEventListener('resize', check)
    return () => {
      document.removeEventListener('focusin', check)
      document.removeEventListener('focusout', later)
      window.removeEventListener('resize', check)
    }
  }, [on, ref])
  return over
}

/**
 * Keeps the bottom-right pop-ups out of the way (@shared/corner): left of the Assistant's panel while it is open, and
 * just above an ended or couldn't-start bar under them, so its buttons can always be clicked. Sets --corner-right and
 * --corner-lift, which the pop-ups use (bottom right; the other places use --corner-right on the right); worked out
 * again (at most once a frame) as the window, the panel or the bars change.
 */
export function CornerPlacement() {
  useEffect(() => {
    const root = document.documentElement
    let frame = 0
    const measure = (): void => {
      frame = 0
      // Only on the right is the Assistant's panel in the corner's way.
      const panel = document.querySelector<HTMLElement>('.assistant-panel:not(.on-left)')
      const bars = [...document.querySelectorAll<HTMLElement>('.session-ended')].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
      // The lowest pop-up, nearest the status bar: what a bar under it would cover.
      const popups = document.querySelector<HTMLElement>('.popups.at-bottom-right')
      const lowest = popups?.lastElementChild as HTMLElement | null | undefined
      const w = popups?.offsetWidth || 380
      const h = lowest?.offsetHeight || 0
      const { right, lift } = cornerPlacement(window.innerWidth, window.innerHeight, panel ? panel.getBoundingClientRect().left : null, bars, w, h)
      // Written only when they change: a property set on the root restyles the whole document, even to the same value (#1629).
      if (right !== placed.right) root.style.setProperty('--corner-right', `${right}px`)
      if (lift !== placed.lift) root.style.setProperty('--corner-lift', `${lift}px`)
      placed = { right, lift }
    }
    let placed: { right: number | null; lift: number | null } = { right: null, lift: null }
    const soon = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    // A terminal's own DOM (its rows, its input's position) changes with every frame of output: none of it moves the
    // corner, and measuring for it forced a layout on each frame while agents streamed (#1629).
    const outsideTerminals = (records: MutationRecord[]): boolean => records.some((r) => !(r.target instanceof Element ? r.target : r.target.parentElement)?.closest('.xterm'))
    measure()
    const watch = new MutationObserver((records) => {
      if (outsideTerminals(records)) soon()
    })
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', soon)
    return () => {
      watch.disconnect()
      window.removeEventListener('resize', soon)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])
  return null
}

/**
 * The tip showing, as a pop-up (HI-2320: Popups.tsx's frame, the quieter style): steps aside while a focused terminal
 * lies under it, so it never covers what you type. Closes for Try it; Learn more opens the guide beside it.
 */
export function TipPopup() {
  const id = useStore((s) => s.tipShown)
  const tip = id ? TIPS.find((t) => t.id === id) : undefined
  const ref = useRef<HTMLDivElement>(null)
  const over = useOverTerminal(ref, !!tip)
  if (!tip) return null
  return (
    <div
      ref={ref}
      className={cx('toast', 'popup', 'info', 'kind-tip', 'tip-card', over && 'stepped-aside')}
      data-kind="tip"
      role="complementary"
      aria-label={tr(msg({ id: 'tips.ui.tip', defaultMessage: 'Tip', description: 'The name, for screen readers, of the tip card.' }))}
      aria-hidden={over || undefined}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        closeTip()
      }}
    >
      <Icon name="lightbulb" className="lead" />
      <div className="toast-text">
        <div className="tip-head">
          <span className="grow">{tr(msg({ id: 'tips.ui.counter', defaultMessage: '{total, plural, one {Tip · {n, number} of #} other {Tip · {n, number} of #}}', description: "The tip card's heading: which tip ({n}) of how many ({total}) it is. A plural on {total}, for a language whose words change with it." }), { n: TIPS.indexOf(tip) + 1, total: TIPS.length })}</span>
        </div>
        <div className="toast-title tip-title">{words(tip, tip.title)}</div>
        <div className="toast-msg tip-text">
          <TipText tip={tip} />
        </div>
        <div className="toast-actions tip-actions">
          <TipActions tip={tip} onTry={closeTip} />
          <button className="btn small subtle" onClick={showNextTip}>
            {tr(msg({ id: 'tips.ui.next', defaultMessage: 'Next tip', description: 'Button on the tip card: shows the next tip.' }))}
          </button>
        </div>
        <button className="link tip-off" onClick={() => void turnOffTips()}>
          {tr(msg({ id: 'tips.ui.off', defaultMessage: "Don't show tips", description: 'A link on the tip card: turns off the tip when Combwork starts.' }))}
        </button>
      </div>
      <IconButton icon="close" action="close-tip" title={tr(msg({ id: 'tips.ui.close', defaultMessage: 'Close', description: 'Closes the tip card or Help → Tips.' }))} onClick={closeTip} />
    </div>
  )
}

/** Help → Tips…: every tip, grouped and searchable, and the setting. */
export function TipsDialog() {
  const open = useStore((s) => s.tipsOpen)
  const on = useStore((s) => s.settings?.general.showTips !== false)
  const [query, setQuery] = useState('')
  if (!open) return null
  const close = (): void => {
    set({ tipsOpen: false })
    setQuery('')
  }
  const q = query.trim().toLowerCase()
  const found = TIPS.filter((t) => !q || `${words(t, t.title)} ${words(t, t.text)} ${tr(TIP_GROUP_TEXT[t.group])}`.toLowerCase().includes(q))
  return (
    <Modal
      title={tr(msg({ id: 'tips.ui.title', defaultMessage: 'Tips', description: 'The title of Help → Tips.' }))}
      icon="lightbulb"
      wide
      onClose={close}
      footer={
        <button className="btn primary" onClick={close}>
          {tr(msg({ id: 'tips.ui.close', defaultMessage: 'Close', description: 'Closes the tip card or Help → Tips.' }))}
        </button>
      }
    >
      <div className="tips-top">
        <SearchInput autoFocus placeholder={tr(msg({ id: 'tips.ui.search', defaultMessage: 'Search tips', description: "Placeholder of Help → Tips' search box." }))} value={query} onChange={setQuery} />
        <label className="flex muted tips-switch">
          <Switch checked={on} label={tr(msg({ id: 'tips.ui.showOnStart', defaultMessage: 'Show a tip when Combwork starts', description: 'A switch in Help → Tips: shows a tip of the day when Combwork starts (the same as Settings → General → Show a tip when Combwork starts).' }))} onChange={(v) => void call('settings:update', { general: { showTips: v } }).then((s) => set({ settings: s }))} /> {tr(msg({ id: 'tips.ui.showOnStart', defaultMessage: 'Show a tip when Combwork starts', description: 'A switch in Help → Tips: shows a tip of the day when Combwork starts (the same as Settings → General → Show a tip when Combwork starts).' }))}
        </label>
      </div>
      <div className="tips-list">
        {TIP_GROUPS.map((g) => {
          const list = found.filter((t) => t.group === g)
          if (!list.length) return null
          return (
            <section key={g} data-group={g}>
              <h3>{tr(TIP_GROUP_TEXT[g])}</h3>
              {list.map((t) => (
                <div key={t.id} className="tips-item" data-tip={t.id}>
                  <div className="grow">
                    <div className="tip-title">{words(t, t.title)}</div>
                    <div className="tip-text">
                      <TipText tip={t} />
                    </div>
                  </div>
                  <div className="tip-actions">
                    <TipActions tip={t} onTry={close} onLearn={close} />
                  </div>
                </div>
              ))}
            </section>
          )
        })}
        {!found.length && <div className="pane-empty">{tr(msg({ id: 'tips.ui.noMatch', defaultMessage: 'No tips match “{query}”.', description: "Help → Tips when its search finds nothing. {query} is what was typed; use your language's quotation marks." }), { query })}</div>}
      </div>
    </Modal>
  )
}
