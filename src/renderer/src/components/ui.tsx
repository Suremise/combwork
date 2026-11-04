import { Children, createContext, Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { LiveSessionState, SessionStatus } from '@shared/types'
import { actClass, cx, type SessionAction } from '../util'
import type { AgentState } from '@shared/agentState'
import { StateMark } from './StateMark'
import { call, errorMessage } from '../api'
import { formatWhen } from '@shared/dates'
import { runtimeLabel, shownMergeSlot, shownStatusMessage, unknownStateText } from '@shared/runtime'
import { shownText } from '@shared/advanced'
import { providerDescriptor, providerName } from '@shared/providers'
import { safeguardText } from '@shared/safeguards'
import { placeTip, type Box } from '@shared/tipPlacement'
import { placeMenu } from '@shared/menuPlacement'
import { msg, tr, tRich, type Msg } from '@shared/i18n'
import { watchStatus } from './watchLine'
import { dialogOpened } from '../windowHealth'
import { headingId, slugOf } from '@shared/docSections'

export function Icon({ name, className, title, spin }: { name: string; className?: string; title?: string; spin?: boolean }) {
  return <i className={cx('codicon', `codicon-${name}`, spin && 'spin', className)} title={title} aria-hidden={!title} />
}

/**
 * Which ends of a sideways-scrolling row have more out of view ('left', 'right', both or ''), for its `data-more`: a
 * `.scroll-fade` row fades out at those ends, so a tab scrolled away still shows there is more (#886). Follows its
 * scrolling, its size and what is in it.
 */
export function useScrollEdges(ref: { current: HTMLElement | null }): string {
  const [more, setMore] = useState('')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      const left = el.scrollLeft > 1
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setMore([left && 'left', right && 'right'].filter(Boolean).join(' '))
    }
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const mo = new MutationObserver(() => {
      for (const c of el.children) ro.observe(c)
      update()
    })
    mo.observe(el, { childList: true })
    for (const c of el.children) ro.observe(c)
    el.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      ro.disconnect()
      mo.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [ref])
  return more
}

/** Room a roomier fold needs to spare before a row goes back to it, so it doesn't flicker at the switching point. */
const FOLD_SPARE = 12

/**
 * How far a row of controls folds to fit (#886: the project header, the agent strip), from 0 (everything labelled) to
 * `max`. Measured rather than set by fixed widths, so a longer language folds sooner: `need` gives the width the row's
 * content needs at the fold shown (null: not laid out yet), and the row folds further while that is more than its room,
 * and unfolds once the fold below was seen to fit with room to spare. `content` names what changes the widths
 * (language, counts, states): when it changes, the widths seen are forgotten and the row is fitted again from no folding,
 * before it paints.
 */
export function useFolds(row: { current: HTMLElement | null }, width: number, content: string, max: number, need: (el: HTMLElement) => number | null): number {
  const [folds, setFolds] = useState(0)
  const seen = useRef<{ content: string; need: number[] }>({ content, need: [] })
  useLayoutEffect(() => {
    const el = row.current
    if (!el || width <= 0) return
    if (seen.current.content !== content) {
      seen.current = { content, need: [] }
      if (folds) return setFolds(0)
    }
    const needed = need(el)
    if (needed === null) return
    seen.current.need[folds] = needed
    const style = getComputedStyle(el)
    const room = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    if (needed > room && folds < max) setFolds(folds + 1)
    else if (folds > 0 && (seen.current.need[folds - 1] ?? Infinity) + FOLD_SPARE <= room) setFolds(folds - 1)
  }, [row, width, content, folds, max, need])
  return folds
}

/**
 * Whether an element's text is cut short (an ellipsis, #886; or its last line, with `lines`: a line clamp, #1145), so its
 * tooltip can give it in full. Follows the element's size and its text.
 */
export function useClipped<T extends HTMLElement>(lines = false): [(el: T | null) => void, boolean] {
  const [clipped, setClipped] = useState(false)
  const observers = useRef<{ ro: ResizeObserver; mo: MutationObserver } | null>(null)
  const ref = useCallback((el: T | null) => {
    observers.current?.ro.disconnect()
    observers.current?.mo.disconnect()
    observers.current = null
    if (!el) return
    const update = (): void => setClipped(el.scrollWidth > el.clientWidth + 1 || (lines && el.scrollHeight > el.clientHeight + 1))
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const mo = new MutationObserver(update)
    mo.observe(el, { childList: true, characterData: true, subtree: true })
    observers.current = { ro, mo }
    update()
  }, [lines])
  return [ref, clipped]
}

/**
 * A row's sign that it has more out of view at one end (useScrollEdges): a chevron that scrolls it that way, bringing the
 * next item cut off at that end fully into view (past the fade). Decorative for screen readers, who reach the row's items
 * themselves.
 */
/** How wide `.scroll-fade` fades a row's ends (app.css): an item scrolled into view clears it. */
const SCROLL_FADE = 24

export function ScrollMore({ dir, target }: { dir: 'left' | 'right'; target: { current: HTMLElement | null } }) {
  return (
    <span
      className={cx('scroll-more', dir)}
      aria-hidden
      onClick={() => {
        const el = target.current
        if (!el) return
        const view = el.getBoundingClientRect()
        const items = [...el.children].map((c) => c.getBoundingClientRect())
        const next = dir === 'right' ? items.find((r) => r.right > view.right + 1) : items.findLast((r) => r.left < view.left - 1)
        const by = next ? (dir === 'right' ? next.right - view.right + SCROLL_FADE : next.left - view.left - SCROLL_FADE) : (dir === 'right' ? 1 : -1) * el.clientWidth
        el.scrollBy({ left: by, behavior: 'smooth' })
      }}
    >
      <Icon name={`chevron-${dir}`} />
    </span>
  )
}

/** An id such as `settings.open` that, short of room, breaks after a dot rather than mid-word (#887). */
export function DottedId({ id }: { id: string }) {
  return (
    <>
      {id.split('.').map((part, i, all) => (
        <Fragment key={i}>
          {part}
          {i < all.length - 1 && (
            <>
              .<wbr />
            </>
          )}
        </Fragment>
      ))}
    </>
  )
}

/**
 * Whether a text box is too narrow for its placeholder (#892), so the full hint can be given on hover. Measured with the
 * box's own font; follows the box's size.
 */
export function usePlaceholderClipped(placeholder: string): [(el: HTMLInputElement | null) => void, boolean] {
  const [clipped, setClipped] = useState(false)
  const observer = useRef<ResizeObserver | null>(null)
  // A callback ref: a box remounted (wrapped in its tooltip once clipped) is measured again.
  const ref = useCallback(
    (el: HTMLInputElement | null) => {
      observer.current?.disconnect()
      observer.current = null
      const ctx = el && document.createElement('canvas').getContext('2d')
      if (!el || !ctx) return
      const update = (): void => {
        const cs = getComputedStyle(el)
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
        const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        setClipped(room > 0 && ctx.measureText(placeholder).width > room + 0.5)
      }
      const ro = new ResizeObserver(update)
      ro.observe(el)
      observer.current = ro
      update()
    },
    [placeholder]
  )
  return [ref, clipped]
}

/** A heading that stays on one line beside its buttons, cut with "…" and then given in full on hover (#886). */
export function OneLineTitle({ text, className }: { text: string; className?: string }) {
  const [ref, clipped] = useClipped<HTMLSpanElement>()
  return (
    <span ref={ref} className={cx('one-line-title', className)}>
      <Tooltip content={clipped ? text : null}>{text}</Tooltip>
    </span>
  )
}

/**
 * A list row's description kept to one line (HI-2527, Darren: "They look good on one row"), cut with "…" and then given
 * in full on hover. The same size and look as the `.desc` it replaces. While cut, its text is also a stop for Tab (list
 * rows aren't), so the keyboard shows the same tooltip; one that fits is no stop.
 */
export function OneLineDesc({ text, className }: { text: string | null | undefined; className?: string }) {
  const [ref, clipped] = useClipped<HTMLDivElement>()
  const cut = clipped && !!text
  return (
    <div ref={ref} className={cx(/* i18n-ignore: class names */ 'desc one-line-desc', className)}>
      <Tooltip content={cut ? text : null} focus>
        {cut ? <span tabIndex={0}>{text}</span> : text}
      </Tooltip>
    </div>
  )
}

/** A tooltip's way to tell the one around it that it is showing, so only the innermost one shows (#287). */
const TipParent = createContext<((inner: boolean) => void) | null>(null)

/**
 * HI-2052: the hover tooltip showing now, so only one shows at a time: another one showing hides it, unless it is
 * around the new one (an outer tooltip gives way to an inner one by TipParent, and shows again when the inner one goes).
 */
let hovered: { owner: object; wrap: HTMLElement; hide: () => void } | null = null
/** Whether a hover tooltip holds the slot, and whether its anchor is still in the page, for tests (HI-2084). */
;(window as unknown as { __hiveHoveredTip?: () => { connected: boolean } | null }).__hiveHoveredTip = () => (hovered ? { connected: hovered.wrap.isConnected } : null)

/**
 * Two sentences one after the other, each with its own full stop, spaced as the language does: a space in English,
 * none in Japanese or Chinese (#893). Either can be markup.
 */
export function sentences(first: ReactNode, second: ReactNode): ReactNode[] {
  return Children.toArray(tRich<ReactNode>(msg({ id: 'shell.text.sentences', defaultMessage: '{first} {second}', description: "Two sentences one after the other, each ending in its own full stop: put the space your language leaves between sentences (none in Japanese or Chinese)." }), { first, second }))
}

/**
 * Hover tooltip rendered in a portal so it is never clipped by scroll containers. It is measured hidden first, then
 * placed by its real size next to its anchor (placeTip), so one near the window's edge stays beside its button. One
 * inside another's (an icon in an agent tab) hides the outer one while it shows. `focus`: also shown while what it
 * wraps has the keyboard focus. `className` styles the tooltip itself (the agents table's is wider, #529).
 */
export function Tooltip({ content, children, delay = 350, block, side, focus, className }: { content: ReactNode; children: ReactNode; delay?: number; block?: boolean; side?: 'right'; focus?: boolean; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  // Who holds the hovered slot (HI-2084): this tooltip for as long as it is mounted. Its anchor's ref is already null when
  // its unmount's cleanup runs, so the slot is released by this, never by the anchor.
  const owner = useRef({})
  const tipRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<Box | null>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)
  // Taller than the window at its usual width: as wide as the window (and, still too tall, cut at its height and faded).
  const [fit, setFit] = useState<'normal' | 'wide' | 'clipped'>('normal')
  const [inner, setInner] = useState(false)
  const parent = useContext(TipParent)
  const shown = !!anchor
  useEffect(() => {
    if (!parent || !shown) return
    parent(true)
    return () => parent(false)
  }, [parent, shown])
  const timer = useRef<number | undefined>(undefined)
  // Shown by the pointer (else by the keyboard's focus): only then does the pointer's leaving close it.
  const byHover = useRef(false)
  const show = (how: 'hover' | 'focus'): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const wrap = ref.current
      const r = wrap?.getBoundingClientRect()
      if (!wrap || !r) return
      byHover.current = how === 'hover'
      if (byHover.current) {
        // HI-2052: one hover tooltip at a time (an outer one stays, given way to this one by TipParent).
        if (hovered && hovered.wrap !== wrap && !hovered.wrap.contains(wrap)) hovered.hide()
        hovered = { owner: owner.current, wrap, hide }
      }
      setPlaced(null)
      setFit('normal')
      setAnchor({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    }, delay)
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    if (hovered?.owner === owner.current) hovered = null
    setAnchor(null)
    setPlaced(null)
    setFit('normal')
  }
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      if (hovered?.owner === owner.current) hovered = null
    },
    []
  )
  // HI-2052: shown by the pointer, it closes once the pointer is over anything but what it wraps, however that got away
  // from under it (moved, re-laid out: no mouseleave comes for a still pointer). The tip itself takes no pointer events.
  useEffect(() => {
    if (!shown || !byHover.current) return
    const moved = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) hide()
    }
    document.addEventListener('pointermove', moved, { capture: true, passive: true })
    return () => document.removeEventListener('pointermove', moved, { capture: true })
  }, [shown])
  // Shown, Esc hides it (WCAG 1.4.13: dismissable without moving the pointer or the focus), as the lanes' legend needs (#1421).
  useEffect(() => {
    if (!shown) return
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [shown])
  // Before it paints, and again when its content changes while shown (placed by its new size; set only on a change).
  useLayoutEffect(() => {
    const el = tipRef.current
    const tip = el?.getBoundingClientRect()
    if (!anchor || !el || !tip) return
    // Taller than the window has room for (its max-height cuts it): measured again as wide as the window allows before
    // it is placed, and only if it still doesn't fit, cut and faded (#372).
    const cut = el.scrollHeight > el.clientHeight + 1
    if (cut && fit === 'normal') return setFit('wide')
    if (cut && fit === 'wide') return setFit('clipped')
    const next = placeTip(anchor, { width: tip.width, height: tip.height }, { width: window.innerWidth, height: window.innerHeight }, side)
    if (!placed || next.left !== placed.left || next.top !== placed.top) setPlaced(next)
  }, [anchor, placed, side, content, fit])
  if (!content) return <>{children}</>
  return (
    <span
      className="tip-wrap"
      style={block ? { display: 'flex' } : undefined}
      ref={ref}
      onMouseEnter={() => show('hover')}
      onMouseLeave={hide}
      onMouseDown={hide}
      onFocus={focus ? (e) => (e.target as Element).matches(':focus-visible') && show('focus') : undefined}
      onBlur={focus ? hide : undefined}
    >
      <TipParent.Provider value={setInner}>{children}</TipParent.Provider>
      {anchor &&
        !inner &&
        createPortal(
          <div ref={tipRef} className={cx('tip', className, fit !== 'normal' && 'wide', fit === 'clipped' && 'clipped')} style={placed ?? { left: 0, top: 0, visibility: 'hidden' }}>
            {content}
          </div>,
          document.body
        )}
    </span>
  )
}

export function InfoTip({ text }: { text: ReactNode }) {
  // No text, no ⓘ: an icon that opens an empty tooltip (HI-2149).
  if (text == null || text === '' || text === false) return null
  return (
    <Tooltip content={text} delay={100}>
      <Icon name="info" className="info-icon" />
    </Tooltip>
  )
}

/**
 * A load that failed with nothing to show: says so, with Retry, so it doesn't read as an empty result. `inline` fits
 * a list pane; without it, the panel's empty state.
 */
export function LoadFailed({ what, error, onRetry, inline }: { what: string; error: string; onRetry: () => void; inline?: boolean }) {
  return (
    <div className={cx(inline ? 'pane-empty' : 'empty-state', 'load-failed')} role="alert">
      <Icon name="error" /> {tr(msg({ id: 'shell.loadFailed', defaultMessage: 'Could not load {what}: {error}', description: 'A load that failed. {what} names what (the sessions, the diagnostics…), given by each view; {error} is why.' }), { what, error })}
      <div>
        <button className="btn small" onClick={onRetry}>
          <Icon name="refresh" /> {tr(msg({ id: 'shell.retry', defaultMessage: 'Retry', description: 'Button: tries a load that failed again.' }))}
        </button>
      </div>
    </div>
  )
}

/** A refresh that failed while the last results stay on screen: when they're from (the error on hover), and Retry. */
export function StaleNote({ what, error, at, onRetry }: { what: string; error: string; at: number; onRetry: () => void }) {
  return (
    <div className="banner warn load-stale" role="status">
      <Tooltip content={error}>
        <span>
          <Icon name="warning" /> {at ? tr(msg({ id: 'shell.refreshFailedAt', defaultMessage: 'Could not refresh {what}; last updated {when}.', description: 'A refresh that failed while the last results stay shown. {what} names what; {when} is when they are from.' }), { what, when: formatWhen(at) }) : tr(msg({ id: 'shell.refreshFailed', defaultMessage: 'Could not refresh {what}.', description: 'A refresh that failed while the last results stay shown. {what} names what.' }), { what })}
        </span>
      </Tooltip>
      <button className="btn small" onClick={onRetry}>
        {tr(msg({ id: 'shell.retry', defaultMessage: 'Retry', description: 'Button: tries a load that failed again.' }))}
      </button>
    </div>
  )
}

const COPY_CODE = {
  copy: msg({ id: 'shell.copyCode.copy', defaultMessage: 'Copy {code}', description: 'Tooltip of the small Copy button beside a command or path shown as code (Provider Setup, say): {code} is exactly what it copies.' }),
  label: msg({ id: 'shell.copyCode.label', defaultMessage: 'Copy', description: 'The accessible name of the small Copy button beside a command or path shown as code. Keep it short.' }),
  copied: msg({ id: 'shell.copyCode.copied', defaultMessage: 'Copied', description: 'Shown for a moment beside a command or path after its Copy button copied it.' })
}

/**
 * A command or path shown as code, with a small Copy button beside it (#1204) that copies exactly it, nothing around it,
 * and says Copied for a moment.
 */
export function CopyableCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <span className="copy-code">
      <code>{code}</code>
      <button
        type="button"
        className="copy-code-btn"
        data-copy-code={code}
        aria-label={tr(COPY_CODE.label)}
        title={tr(COPY_CODE.copy, { code })}
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => setCopied(true), () => undefined)
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} />
      </button>
      {copied && (
        <span className="copy-code-done" role="status">
          {tr(COPY_CODE.copied)}
        </span>
      )}
    </span>
  )
}

/** Text with `code` and **bold** spans, as provider notes are written: each code span copyable on its own (#1204). */
export function CodeText({ text }: { text: string }) {
  const code = (s: string, k: number) => s.split('`').map((part, i) => (i % 2 ? <CopyableCode key={`${k}.${i}`} code={part} /> : <span key={`${k}.${i}`}>{part}</span>))
  return <>{text.split('**').map((part, k) => (k % 2 ? <strong key={k}>{code(part, k)}</strong> : code(part, k)))}</>
}

export function IconButton({
  icon,
  title,
  onClick,
  disabled,
  active,
  className,
  expanded,
  spin,
  action
}: {
  icon: string
  title: string
  onClick?: (e: React.MouseEvent) => void
  disabled?: boolean
  active?: boolean
  className?: string
  /** For a button that opens and closes something: whether it is open (aria-expanded). */
  expanded?: boolean
  /** Its icon turns (a loading icon, while what it does runs). */
  spin?: boolean
  /** What it does, as data-action: a hook for tests that can't read its name, which is translated (the i18nshots route, #769). */
  action?: string
}) {
  return (
    <Tooltip content={title}>
      <button
        className={cx('icon-btn', active && 'active', className)}
        onClick={(e) => {
          e.stopPropagation()
          onClick?.(e)
        }}
        disabled={disabled}
        aria-label={title}
        aria-expanded={expanded}
        data-action={action}
      >
        <Icon name={icon} spin={spin} />
      </button>
    </Tooltip>
  )
}

/**
 * A search or filter box with a × that clears it (#433): shown only while there is text, inside the box on the right,
 * named "Clear". Clicking it, or Escape with text in the box, clears the text as typing would and keeps the focus in
 * the box; with the box empty, Escape does what it did before (a dialog or the palette closes). It takes the box's
 * place in the layout (`.search-box`, which the parent's rules size); `className` and `style` are the input's.
 */
export function SearchInput({
  value,
  onChange,
  onKeyDown,
  className,
  ref,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onChange: (value: string) => void; ref?: React.Ref<HTMLInputElement> }) {
  const input = useRef<HTMLInputElement | null>(null)
  const setRef = (el: HTMLInputElement | null): void => {
    input.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el
  }
  return (
    <span className={cx('search-box', value && 'has-text')}>
      <input
        {...rest}
        ref={setRef}
        className={cx('input', className)}
        data-clearable=""
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // The first Escape clears the text; the next one is the box's own (or its dialog's).
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            e.stopPropagation()
            onChange('')
            return
          }
          onKeyDown?.(e)
        }}
      />
      {value && (
        <span className="search-clear">
          <IconButton
            icon="close"
            title={tr(msg({ id: 'shell.search.clear', defaultMessage: 'Clear', description: 'The × in a search box: clears it.' }))}
            onClick={() => {
              onChange('')
              input.current?.focus()
            }}
          />
        </span>
      )}
    </span>
  )
}

/** Whether an Escape is for clearing a search box (`SearchInput`) that has text: dialogs leave it to the box. */
export function escapeClearsSearch(e: KeyboardEvent): boolean {
  const t = e.target
  return t instanceof HTMLInputElement && t.hasAttribute('data-clearable') && t.value !== ''
}

export function Switch({ checked, onChange, disabled, small, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; small?: boolean; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx('switch', checked && 'on', small && 'small')}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
    />
  )
}

/** Each status's words, as messages (#767). */
export const STATUS_MSG: Record<SessionStatus | 'idle', Msg> = {
  idle: msg({ id: 'shell.status.idle', defaultMessage: 'No session', description: "An agent's status: it has no session." }),
  stopped: msg({ id: 'shell.status.stopped', defaultMessage: 'Stopped', description: "An agent's status." }),
  starting: msg({ id: 'shell.status.starting', defaultMessage: 'Starting…', description: "An agent's status." }),
  ready: msg({ id: 'shell.status.ready', defaultMessage: 'Ready', description: "An agent's status: started, waiting for a prompt." }),
  working: msg({ id: 'shell.status.working', defaultMessage: 'Working…', description: "An agent's status." }),
  waiting: msg({ id: 'shell.status.waiting', defaultMessage: 'Needs your input', description: "An agent's status: it asks you something, or a permission." }),
  background: msg({ id: 'shell.status.background', defaultMessage: 'Background tasks', description: "An agent's status: its turn ended while background tasks it started still run." }),
  watching: msg({ id: 'shell.status.watching', defaultMessage: 'Waiting on cards', description: "An agent's status: waiting for cards to change (a card watch)." }),
  finished: msg({ id: 'shell.status.finished', defaultMessage: 'Finished', description: "An agent's status: its turn has ended." }),
  error: msg({ id: 'shell.status.error', defaultMessage: 'Error', description: "An agent's status: its CLI failed." }),
  signin: msg({ id: 'shell.status.signin', defaultMessage: 'Needs sign-in', description: "An agent's status: its CLI's sign-in was refused or has expired." })
}

/** Each status's words in the language shown: each a getter, read when rendered (keep the words, not this object's values). */
export const STATUS_TEXT: Readonly<Record<SessionStatus | 'idle', string>> = Object.defineProperties(
  {} as Record<SessionStatus | 'idle', string>,
  Object.fromEntries(Object.entries(STATUS_MSG).map(([k, m]) => [k, { get: () => tr(m), enumerable: true }]))
)

/**
 * What an agent is doing, in words: projected from its runtime's facts (#648: asking, compacting, silent with its state
 * unknown, working…); when no turn runs, Hive's policy words: what its watch waits for, its status message, finished or
 * ready, with any background tasks it is running.
 */
/** A server connection's refused key (HI-1772), where a sign-in connection's agent needs sign-in. */
const KEY_REFUSED = {
  status: msg({ id: 'shell.status.keyRefused', defaultMessage: 'Key refused', description: "An agent's status: its server connection's API key was refused by the server (where a signed-in connection would need sign-in)." }),
  carryOn: msg({ id: 'shell.keyRefused.then', defaultMessage: "{name}'s key was refused. Replace it in Settings → Accounts & Connections, then Resume in the project's header carries on the agents it stopped.", description: "Tooltip of an agent whose server connection's ({name}) API key was refused, its second line. Settings → Accounts & Connections names a section; Resume is a button in the project's header." }),
  stopped: msg({ id: 'shell.keyRefused.stopped', defaultMessage: "Its turn stopped when {name}'s key was refused. Resume in the project's header carries it on.", description: "Tooltip of an agent whose turn stopped because its server connection's ({name}) API key was refused." })
}

export function statusText(live: Pick<LiveSessionState, 'status' | 'statusMessage' | 'statusText' | 'mergeSlot' | 'mergeSlotText' | 'backgroundTasks' | 'question' | 'watch' | 'turn' | 'runtime' | 'launchedConnection'>): string {
  const text = ((): string => {
    // On a server connection (HI-1772) there is no sign-in: its key was refused.
    if (live.status === 'signin' && live.launchedConnection?.server) return tr(KEY_REFUSED.status)
    const projected = live.runtime ? runtimeLabel(live) : unknownStateText(live)
    if (projected) return projected
    // Waiting on cards: what for, in the window's words and its card names ("Waiting for HI-12 → Review", HI-1679: never
    // the watch's `label`, the English agents read).
    if (live.status === 'watching' && live.watch) return watchStatus(live.watch)
    // Hive's own words in the window's language (#847), or the CLI's as they came.
    if (live.statusMessage) return shownStatusMessage(live)!
    // At the merge slot (#350): waiting for it, or merging.
    if (live.mergeSlot) return shownMergeSlot(live)!
    const n = live.backgroundTasks ?? 0
    // Whole sentences with the count, so a language words each count as it needs (#795).
    if (live.status === 'background') return tr(msg({ id: 'shell.status.waitingOnTasks', defaultMessage: '{n, plural, one {Waiting on # background task} other {Waiting on # background tasks}}', description: "An agent's status: its turn ended while background tasks it started still run. {n} is how many." }), { n })
    if (n && live.status === 'finished') return tr(msg({ id: 'shell.status.finishedWithTasks', defaultMessage: '{n, plural, one {Finished · # background task running} other {Finished · # background tasks running}}', description: "An agent's status: finished, while background tasks it started run. {n} is how many." }), { n })
    if (n && live.status === 'ready') return tr(msg({ id: 'shell.status.readyWithTasks', defaultMessage: '{n, plural, one {Ready · # background task running} other {Ready · # background tasks running}}', description: "An agent's status: ready for a prompt, while background tasks it started run. {n} is how many." }), { n })
    return STATUS_TEXT[live.status]
  })()
  // A question it doesn't stop for: it works on meanwhile.
  return live.question && live.status !== 'waiting' ? tr(msg({ id: 'shell.status.question', defaultMessage: '{status} · has a question for you', description: "An agent's status while it works on with a question for you." }), { status: text }) : text
}

/**
 * An action under the CLI's automatic review (Codex's Approve for me): a small shield beside the status, which stays
 * Working…. What is asked shows on hover only; the status, other labels and what is announced never carry it.
 */
export function ReviewMark({ live }: { live: Pick<LiveSessionState, 'review' | 'provider'> | null | undefined }) {
  if (!live?.review) return null
  return (
    <Tooltip
      content={
        <>
          <div>{tr(msg({ id: 'shell.review.checking', defaultMessage: "{provider}'s reviewer is checking an action; you aren't needed.", description: "Tooltip of the shield beside an agent's status while its CLI's automatic review checks an action. {provider} is the coding agent's name." }), { provider: providerName(live.provider) })}</div>
          <div className="faint review-mark-detail">{live.review}</div>
        </>
      }
    >
      <span className="review-mark" role="img" aria-label={tr(msg({ id: 'shell.review.label', defaultMessage: 'An action is being reviewed automatically', description: 'The name, for screen readers, of the shield beside an agent under automatic review.' }))}>
        <Icon name="shield" />
      </span>
    </Tooltip>
  )
}

/**
 * Its CLI's safety classifier stopped a response, or its model changed after one (#606): a shield beside the status,
 * labelled with the model it runs on now when that changed. What happened, when, the names of its last tool calls
 * before it and what to do show on hover; never what was stopped.
 */
export function SafeguardMark({ live }: { live: Pick<LiveSessionState, 'safeguard' | 'provider'> | null | undefined }) {
  const note = live?.safeguard
  if (!note) return null
  const d = providerDescriptor(live.provider)
  const text = safeguardText(note, d.modelLabel)
  const alert = !!note.switched || !!note.prompt || !!note.idle
  return (
    <Tooltip
      content={
        <>
          <div>{text}</div>
          {d.safeguardHelp && <div className="faint review-mark-detail">{d.text?.safeguardHelp ? tr(d.text.safeguardHelp) : d.safeguardHelp}</div>}
        </>
      }
    >
      <span className={cx('safeguard-mark', alert && 'alert')} role="img" aria-label={text}>
        <Icon name="shield" />
        {note.switched && <span className="safeguard-model">{d.modelLabel(note.switched.to)}</span>}
      </span>
    </Tooltip>
  )
}

/**
 * For the tooltips of an agent whose turn a refused sign-in stopped (#309): what its CLI said and how to sign in again
 * (while it needs sign-in), then that Resume (n) carries it on. Null for any other agent.
 */
export function signInNote(live: Pick<LiveSessionState, 'status' | 'signIn' | 'provider' | 'launchedConnection'> | null | undefined): string | null {
  if (!live?.signIn) return null
  const d = providerDescriptor(live.provider)
  // Hive's own message in the window's language (#847), else what the CLI said, as it said it.
  const message = live.signIn.messageText ? shownText(live.signIn.messageText) : live.signIn.message
  const said = message.length > 160 ? `${message.slice(0, 160)}…` : message
  // On a server connection (HI-1772): its key was refused, replaced in Settings → Accounts & Connections (no sign-in).
  const server = live.launchedConnection?.server ? live.launchedConnection.name : null
  if (server && live.status === 'signin') return [tr(msg({ id: 'shell.signIn.said', defaultMessage: '{provider} says: {said}', description: "Tooltip of an agent that needs sign-in, its first line. {provider} is the coding agent's name; {said} what its CLI said, as it said it." }), { provider: d.name, said }), tr(KEY_REFUSED.carryOn, { name: server })].join('\n')
  if (server && (live.status === 'ready' || live.status === 'finished')) return tr(KEY_REFUSED.stopped, { name: server })
  // Two lines: what the CLI said, then how to carry on (a message keeps no line break).
  if (live.status === 'signin')
    return [
      tr(msg({ id: 'shell.signIn.said', defaultMessage: '{provider} says: {said}', description: "Tooltip of an agent that needs sign-in, its first line. {provider} is the coding agent's name; {said} what its CLI said, as it said it." }), { provider: d.name, said }),
      tr(msg({ id: 'shell.signIn.then', defaultMessage: "{help} Then Resume in the project's header carries on the agents it stopped.", description: "Tooltip of an agent that needs sign-in, its second line. {help} says how to sign in again (a sentence or two); Resume is a button in the project's header." }), { help: d.text?.signInHelp ? tr(d.text.signInHelp) : d.signInHelp })
    ].join('\n')
  if (live.status === 'ready' || live.status === 'finished') return tr(msg({ id: 'shell.signIn.stopped', defaultMessage: "Its turn stopped when {provider}'s sign-in expired. Resume in the project's header carries it on.", description: "Tooltip of an agent whose turn stopped for its sign-in. {provider} is the coding agent's name." }), { provider: d.name })
  return null
}

export function StatusDot({ live, active }: { live: LiveSessionState | null; active: boolean }) {
  const status = live?.status ?? (active ? 'idle' : 'stopped')
  const said = live ? (shownStatusMessage(live) ?? shownMergeSlot(live)) : undefined
  const base = !live ? STATUS_TEXT[status] : said ? `${STATUS_TEXT[status]} — ${said}` : statusText(live)
  const reviewed = live?.review ? tr(msg({ id: 'shell.review.status', defaultMessage: '{status} · an action is being reviewed automatically', description: "An agent's status tooltip while its CLI's automatic review checks an action." }), { status: base }) : base
  const note = signInNote(live)
  const text = note ? <span style={{ whiteSpace: 'pre-line' }}>{`${reviewed}\n${note}`}</span> : reviewed
  return (
    <Tooltip content={text}>
      <span className={cx('dot', status, live?.unseen && 'unseen')} />
    </Tooltip>
  )
}

/**
 * One action at a time for a dialog or a button. `run(name, fn)` ignores a second call while one runs; `busy` names
 * the one running (for its button's spinner and "…ing" label), and `error` holds the last failure (cleared by the next
 * run). It resolves to `{ value }` on success and null on failure or when ignored.
 */
export function useBusy() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const run = useCallback(async <T,>(name: string, fn: () => Promise<T>): Promise<{ value: T } | null> => {
    if (running.current) return null
    running.current = true
    setBusy(name)
    setError(null)
    try {
      return { value: await fn() }
    } catch (e) {
      if (mounted.current) setError(errorMessage(e))
      return null
    } finally {
      running.current = false
      if (mounted.current) setBusy(null)
    }
  }, [])
  return { busy, error, run, setError }
}

/** A button for an action that takes a moment: while `busy`, a spinner and its "…ing" label, and it can't be clicked. */
export function BusyButton({
  busy,
  busyLabel,
  className,
  disabled,
  autoFocus,
  onClick,
  children
}: {
  busy: boolean
  busyLabel: string
  className?: string
  disabled?: boolean
  autoFocus?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button className={cx('btn', className)} disabled={disabled || busy} aria-busy={busy || undefined} autoFocus={autoFocus} onClick={onClick}>
      {busy ? (
        <>
          <Icon name="loading" spin /> {busyLabel}
        </>
      ) : (
        children
      )}
    </button>
  )
}

/** The backdrops up in this window, oldest first: dialogs, nested or not, and the command palette. */
const backdrops: symbol[] = []

/**
 * A backdrop is up while the calling component is mounted: the window is dimmed (once more for each backdrop, as their
 * layers stack), and its native buttons (painted by Windows over the page, where the backdrop can't reach) are dimmed
 * to match, as each comes and goes. Returns whether it is the top one: only that one answers Escape.
 */
export function useBackdrop(): () => boolean {
  const me = useRef(Symbol('backdrop'))
  useEffect(() => {
    const id = me.current
    backdrops.push(id)
    void call('window:setBackdrops', backdrops.length).catch(() => undefined)
    return () => {
      const i = backdrops.lastIndexOf(id)
      if (i >= 0) backdrops.splice(i, 1)
      void call('window:setBackdrops', backdrops.length).catch(() => undefined)
    }
  }, [])
  return useCallback(() => backdrops[backdrops.length - 1] === me.current, [])
}

/** Where a moved dialog may go: its header wholly in the window, below Hive's title bar (whose native buttons would cover its ×). */
function clampOffset(dialog: HTMLElement, offset: { x: number; y: number }, want: { x: number; y: number }): { x: number; y: number } {
  const header = dialog.querySelector('.dialog-header')
  if (!header) return want
  const r = dialog.getBoundingClientRect()
  const h = header.getBoundingClientRect()
  // Where it sits unmoved.
  const left = r.left - offset.x
  const top = r.top - offset.y
  const minTop = document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0
  // Wider than the window: its right edge (the ×) stays in it.
  const maxLeft = window.innerWidth - r.width
  const x = Math.min(Math.max(left + want.x, Math.min(0, maxLeft)), maxLeft) - left
  // The header's bottom (below the dialog's border) stays in the window.
  const y = Math.min(Math.max(top + want.y, minTop), Math.max(minTop, window.innerHeight - (h.bottom - r.top))) - top
  return { x: Math.round(x), y: Math.round(y) }
}

/** What a press on a dialog's header leaves alone: its buttons and anything typed in or selected. */
const NOT_A_HANDLE = 'button, a, input, textarea, select, [contenteditable=""], [contenteditable="true"]'

/** The keys held down now, so a dialog that one of them closes can keep the rest of that key press from its opener. */
const heldKeys = new Set<string>()
/** Keys whose press, still going on, is kept from what has the focus now (holdBackKeyPress), each until it is released. */
const heldBack = new Set<string>()
window.addEventListener('keydown', (e) => heldKeys.add(e.key), true)
// Enter's keypress (which presses a button) and Space's keyup (likewise) of a held-back press go nowhere.
window.addEventListener(
  'keypress',
  (e) => {
    if (!heldBack.has(e.key)) return
    e.preventDefault()
    e.stopPropagation()
  },
  true
)
window.addEventListener(
  'keyup',
  (e) => {
    heldKeys.delete(e.key)
    if (!heldBack.delete(e.key)) return
    e.preventDefault()
    e.stopPropagation()
  },
  true
)
// Released in another window, a key's keyup never comes here: nothing stays held, or held back (#355).
window.addEventListener('blur', () => {
  heldKeys.clear()
  heldBack.clear()
})

/**
 * A dialog closed by Enter or Space (Enter in a prompt's field) gives the focus back to its opener while that key is
 * still down: the rest of the press (Enter's keypress, Space's keyup) would press the opener, a button that opens the
 * dialog again (#355). Kept from it until that key is released (each key on its own), or the window loses the focus.
 */
function holdBackKeyPress(): void {
  for (const k of ['Enter', ' ']) if (heldKeys.has(k)) heldBack.add(k) // i18n-ignore: key names
}

/**
 * A dialog. While `busy` (an action it started is running) it can't be closed (Escape, outside, ×) and its fields and
 * other buttons are disabled; `error` shows the action's failure above the buttons. Every dialog can be dragged by its
 * header within the window, busy or not (Escape while dragging puts it back), and opens centred each time (#133);
 * `movable={false}` keeps one in place (the image viewers, sized to their image, with their own controls).
 */
export function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
  wide,
  busy,
  error,
  movable = true
}: {
  title: string
  icon?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  busy?: boolean
  error?: string | null
  movable?: boolean
}) {
  const busyNow = useRef(busy)
  busyNow.current = busy
  // Open: where the window is, for hive.log's long-task and hang lines (HI-1775).
  useEffect(() => dialogOpened(title), [title])
  // Escape runs this render's onClose, never an earlier one's: a dialog whose fields fill in after it opens would
  // otherwise answer an Escape with its first render's view of them (#288).
  const onCloseNow = useRef(onClose)
  onCloseNow.current = onClose
  // Dialogs open over each other (a question over a card), and the command palette over them: Escape is for the top one.
  const isTop = useBackdrop()
  const dialog = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const offsetNow = useRef(offset)
  offsetNow.current = offset
  const drag = useRef<{ pointer: number; x: number; y: number; from: { x: number; y: number }; header: HTMLElement } | null>(null)
  const [dragging, setDragging] = useState(false)
  const endDrag = (back: boolean): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    setDragging(false)
    // Back where the drag began, as far as the window allows now (it may have shrunk meanwhile).
    if (back) setOffset(dialog.current ? clampOffset(dialog.current, offsetNow.current, d.from) : d.from)
    if (d.header.hasPointerCapture(d.pointer)) d.header.releasePointerCapture(d.pointer)
  }
  // The window got smaller (or was restored): moved back in, so its header and × stay reachable.
  useEffect(() => {
    if (!movable) return
    const onResize = (): void => setOffset((o) => (dialog.current ? clampOffset(dialog.current, o, o) : o))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [movable])
  // Listening from the moment it is on screen (a layout effect), so an Escape straight after it opens closes it.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A search box with text in the dialog takes this Escape to clear itself (#433): the next one closes the dialog.
      if (e.key !== 'Escape' || !isTop() || escapeClearsSearch(e)) return
      // Every dialog listens on the window: only this one may act on this Escape. Once it closes, the one under it is on
      // top, and would close too (or ask again) if its listener came later in the window's list (#133).
      e.stopImmediatePropagation()
      // While it is being dragged, Escape puts it back instead.
      if (drag.current) return endDrag(true)
      if (!busyNow.current) onCloseNow.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // endDrag works through refs and state setters, so the first render's is as good as the latest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTop])
  // Closed, it gives the keyboard back to what had it (a terminal, a list): noted while rendering for the
  // first time, before a field inside takes the focus.
  const opener = useRef(document.activeElement)
  useEffect(() => {
    const before = opener.current
    return () => {
      if (before instanceof HTMLElement && before.isConnected) {
        before.focus()
        holdBackKeyPress()
      }
    }
  }, [])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={dialog}
        className={cx('dialog', wide && 'wide', busy && 'busy', movable && 'movable', dragging && 'dragging')}
        style={offset.x || offset.y ? { translate: `${offset.x}px ${offset.y}px` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy || undefined}
      >
        <div
          className="dialog-header"
          onPointerDown={(e) => {
            if (!movable || e.button !== 0 || (e.target as Element).closest(NOT_A_HANDLE)) return
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, from: offsetNow.current, header: e.currentTarget }
            setDragging(true)
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d || d.pointer !== e.pointerId || !dialog.current) return
            setOffset(clampOffset(dialog.current, offsetNow.current, { x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y }))
          }}
          onPointerUp={() => endDrag(false)}
          onPointerCancel={() => endDrag(false)}
          onLostPointerCapture={() => endDrag(false)}
        >
          {icon && <Icon name={icon} />}
          <h2>{title}</h2>
          <IconButton icon="close" title={busy ? tr(msg({ id: 'shell.dialog.wait', defaultMessage: 'Wait for it to finish', description: "Tooltip of a dialog's close button while what it does runs." })) : tr(msg({ id: 'shell.dialog.close', defaultMessage: 'Close (Esc)', description: "Tooltip of a dialog's close button. Esc is a key: keep it." }))} disabled={busy} onClick={onClose} />
        </div>
        <div className="dialog-body" inert={busy || undefined}>
          {children}
        </div>
        {error && (
          <div className="dialog-error" role="alert">
            <Icon name="error" /> <span>{error}</span>
          </div>
        )}
        {footer && (
          <div className="dialog-footer" inert={busy || undefined}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

marked.setOptions({ gfm: true, breaks: false })
// GitHub-style heading ids, so the docs' #links work in Hive as they do on GitHub; a heading's explicit id
// (`<a id="git"></a>`, #1535) is its id instead, and its empty anchor is dropped.
marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      const id = headingId(text) ?? slugOf(text)
      const inner = this.parser.parseInline(tokens).replace(/\s*<a\s+id="[^"]*"\s*>\s*<\/a>/gi, '')
      return `<h${depth} id="${id}">${inner}</h${depth}>\n` // i18n-ignore: HTML, not text
    }
  }
})

/** Card references Markdown links to their cards (#1221): where each is in a text, the card it names, and opening one. */
export interface MarkdownCards {
  find: (text: string) => { start: number; end: number; number: number }[]
  title: (n: number) => string | null
  open: (n: number) => void
}

/**
 * Wraps the card references in rendered Markdown's text in links (`hive-card:N`), never inside a link, code or a code
 * block. Done on the sanitized HTML, whose text nodes only gain links of Hive's own scheme.
 */
function linkCards(html: string, cards: MarkdownCards): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!(n.parentElement?.closest('a, code, pre'))) texts.push(n as Text)
  for (const t of texts) {
    const text = t.data
    const found = cards.find(text)
    if (!found.length) continue
    const frag = doc.createDocumentFragment()
    let at = 0
    for (const m of found) {
      frag.append(text.slice(at, m.start))
      const a = doc.createElement('a')
      a.setAttribute('href', `hive-card:${m.number}`)
      a.className = 'card-ref'
      const title = cards.title(m.number)
      if (title) a.setAttribute('title', title)
      a.textContent = text.slice(m.start, m.end)
      frag.append(a)
      at = m.end
    }
    frag.append(text.slice(at))
    t.replaceWith(frag)
  }
  return doc.body.innerHTML
}

/**
 * Markdown, sanitized. `cards`: card references (AM-12, #1061) link to their cards, as in a card's description and comments.
 * `breaks`: a single line break is kept (#1637: an agent's question written line by line), not run into its paragraph.
 */
export function Markdown({ source, className, onLink, cards, breaks, images }: { source: string; className?: string; onLink?: (href: string) => boolean; cards?: MarkdownCards; breaks?: boolean; images?: (src: string) => string | null }) {
  const clean = DOMPurify.sanitize(marked.parse(source, { async: false, ...(breaks ? { breaks: true } : {}) }) as string)
  const html = cards ? linkCards(clean, cards) : clean
  // Images the caller gives a source of its own once shown (HI-1700: a card's attachments, by a relative placeholder the
  // sanitiser keeps; their hive-img: and blob: URLs it wouldn't).
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!images || !ref.current) return
    for (const img of ref.current.querySelectorAll('img')) {
      const to = images(img.getAttribute('src') ?? '')
      if (to) img.setAttribute('src', to)
    }
  }, [html, images])
  return (
    <div
      ref={ref}
      className={cx('markdown', className)}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (!a) return
        const href = a.getAttribute('href') ?? ''
        e.preventDefault()
        const card = /^hive-card:(\d+)$/.exec(href)
        if (card && cards) return cards.open(Number(card[1]))
        if (onLink?.(href)) return
        if (/^https?:/.test(href)) void window.hive.invoke('app:openExternal', href)
        else if (href.startsWith('#')) document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' })
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** Context menu anchored at the mouse position. */
export interface MenuEntry {
  label?: string
  icon?: string
  /** Its keys, as shown: formatKeybinding()'s words. */
  keybinding?: string
  disabled?: boolean
  danger?: boolean
  /** A session action (Stop, Resumeâ€¦): its icon takes that action's colour (#344). */
  action?: SessionAction
  separator?: boolean
  /** A non-clickable heading. */
  header?: boolean
  /** A second, smaller line under the label. */
  detail?: string
  /** Shown greyed out but still clickable. */
  muted?: boolean
  /** An agent's state mark in the icon's place (#975); its words belong in the label or detail, as the mark is decorative. */
  state?: AgentState
  /** Opens another menu in its place (a ▸ at its end; → opens it too). */
  more?: boolean
  /** `keyboard`: chosen with Enter or →, so a menu it opens can take the keys too. */
  onClick?: (keyboard: boolean) => void
}

/** Whether a menu entry can be chosen (with the arrow keys too). */
const choosable = (it: MenuEntry): boolean => !it.separator && !it.header && !it.disabled

/**
 * A menu at x, y. `above`: where its anchor's top is, so a menu that doesn't fit below opens above it instead. ↑ and ↓
 * move through its entries (Home, End), Enter chooses one, → opens one that leads to another menu; `keyboard` (opened
 * from the keyboard) starts on its first entry. It takes the focus while open, naming its chosen entry as its active
 * descendant so screen readers announce it (#974), and gives the focus back to what had it when it closes, unless
 * something else took it meanwhile.
 */
export function ContextMenu({ x, y, above, items, keyboard, onClose }: { x: number; y: number; above?: number; items: MenuEntry[]; keyboard?: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const idBase = useId()
  const [pos, setPos] = useState({ x, y })
  const [active, setActive] = useState(() => (keyboard ? items.findIndex(choosable) : -1))
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const menu = ref.current
    menu?.focus({ preventScroll: true })
    return () => {
      const now = document.activeElement
      if (before?.isConnected && (!now || now === document.body || menu?.contains(now) || !now.isConnected)) before.focus({ preventScroll: true })
    }
  }, [])
  const choose = (it: MenuEntry, byKey: boolean): void => {
    if (it.disabled) return
    onClose()
    it.onClick?.(byKey)
  }
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos(placeMenu({ x, y, above }, r, { width: window.innerWidth, height: window.innerHeight }))
  }, [x, y, above])
  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      // Taken: what listens after it (the focus view's Escape back to the tiles, #1053) leaves it alone.
      if (e.key === 'Escape') {
        e.preventDefault()
        return onClose()
      }
      const order = items.map((it, i) => (choosable(it) ? i : -1)).filter((i) => i >= 0)
      const at = order.indexOf(activeRef.current)
      const it = items[activeRef.current]
      let next: number | undefined
      if (e.key === 'ArrowDown') next = order[at < 0 ? 0 : (at + 1) % order.length]
      else if (e.key === 'ArrowUp') next = order[at <= 0 ? order.length - 1 : at - 1]
      else if (e.key === 'Home') next = order[0]
      else if (e.key === 'End') next = order[order.length - 1]
      else if (e.key === 'Enter' || (e.key === 'ArrowRight' && it?.more)) {
        // Taken from whatever has the focus (a button that opened the menu would open it again).
        e.preventDefault()
        e.stopPropagation()
        if (!it || !choosable(it)) return
        onClose()
        it.onClick?.(true)
        return
      } else return
      e.preventDefault()
      e.stopPropagation()
      if (next !== undefined) setActive(next)
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, items])
  useEffect(() => {
    if (active >= 0) ref.current?.querySelectorAll('[data-menu-index]').forEach((el) => el.getAttribute('data-menu-index') === String(active) && el.scrollIntoView({ block: 'nearest' }))
  }, [active])
  return createPortal(
    <div className="menu" ref={ref} role="menu" tabIndex={-1} aria-activedescendant={active >= 0 ? `${idBase}-${active}` : undefined} style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : it.header ? (
          <div key={i} className="menu-header">
            {it.label}
          </div>
        ) : (
          <div
            key={i}
            id={`${idBase}-${i}`}
            data-menu-index={i}
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            className={cx('menu-item', actClass(it.action), it.disabled && 'disabled', it.muted && 'muted', it.detail && 'two-line', active === i && 'active')}
            onMouseMove={() => active !== i && choosable(it) && setActive(i)}
            onClick={() => choose(it, false)}
          >
            {it.state ? <StateMark state={it.state} decorative className="menu-state" /> : <Icon name={it.icon ?? 'blank'} />}
            {it.detail ? (
              <span className="menu-text">
                <span className="menu-label">{it.label}</span>
                <span className="menu-detail">{it.detail}</span>
              </span>
            ) : (
              <span style={it.danger ? { color: 'var(--error)' } : undefined}>{it.label}</span>
            )}
            {it.keybinding && <span className="menu-key">{it.keybinding}</span>}
            {it.more && (
              <span className="menu-key">
                <Icon name="chevron-right" />
              </span>
            )}
          </div>
        )
      )}
    </div>,
    document.body
  )
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[]; keyboard?: boolean; n: number } | null>(null)
  // Counts openings, so a menu opened from another's entry (closed in the same update) is a new one.
  const opened = useRef(0)
  const open = (e: React.MouseEvent, items: MenuEntry[]): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items, n: ++opened.current })
  }
  /** Opens the menu at a point, e.g. under a button; `keyboard`: opened from the keyboard, on its first entry. */
  const openAt = (x: number, y: number, items: MenuEntry[], keyboard?: boolean): void => setMenu({ x, y, items, keyboard, n: ++opened.current })
  const element = menu ? <ContextMenu key={menu.n} x={menu.x} y={menu.y} items={menu.items} keyboard={menu.keyboard} onClose={() => setMenu(null)} /> : null
  /** `shown`: whether the menu is open (a button that opens it says so with aria-expanded). */
  return { open, openAt, element, shown: !!menu }
}
