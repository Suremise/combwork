import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { fmt, msg, tr } from '@shared/i18n'
import { tabAfterKey } from '@shared/tabs'
import { cx } from '../util'
import { Icon, Tooltip } from './ui'

/**
 * Tabs (HI-1837): a row of tabs switching between separate pages or forms of one view, such as Settings → Version
 * Control's Hive and workspace defaults or a project's Version Control sections. A segmented control picks a value or a
 * filter for the same view (None · Git, Files | Commits, Today / 7 days…) and stays one: the two look different on
 * purpose. Each tab can carry an icon, a count and an unsaved mark; the keyboard moves along them (arrows, Home, End,
 * roving focus), and with `fold` the tabs not selected fold to their icons when the row is short of room.
 * The selection is the caller's (`value`), or remembered across restarts with `useRememberedTab` (store.ts).
 */

export interface TabItem<T extends string = string> {
  id: T
  label: string
  /** A codicon's name, or a node of its own (a CLI's `ProviderIcon`). */
  icon?: string | React.ReactNode
  /** A number after the label (cards, files…). */
  count?: number
  /** The tab's page has changes not saved yet: marked, and said in its accessible name. */
  unsaved?: boolean
  /**
   * Dimmed but still chosen as any other (Settings → Advanced's tab of a CLI turned off, HI-1839): why, which is its
   * tooltip and part of its accessible name.
   */
  muted?: string
  /** A short word after the label, such as "off" (a CLI turned off). */
  tag?: string
  /** Its tooltip (else its name, when folded to its icon; else why it is dimmed). */
  tip?: React.ReactNode
  /** Attributes the tab's button carries too (`data-section` for the tests and links that knew the old row). */
  attrs?: Record<`data-${string}`, string>
}

const T = {
  unsaved: msg({ id: 'tabs.unsaved', defaultMessage: 'Unsaved changes', description: "Tooltip of the dot on a tab whose page has changes not saved yet (Settings → Version Control's Hive defaults, say), and read out with the tab's name." }),
  named: msg({ id: 'tabs.unsavedNamed', defaultMessage: '{tab} (unsaved changes)', description: "A tab's accessible name while its page has changes not saved yet; {tab} is its name." }),
  withNote: msg({ id: 'tabs.withNote', defaultMessage: '{tab} ({note})', description: "A dimmed tab's accessible name: {tab} is its name, {note} why it is dimmed (a CLI turned off, say)." })
}

/** A tab's icon: a codicon by name, or the node given, hidden from screen readers (the tab's name says it: a CLI's icon names it again). */
const tabIcon = (icon: TabItem['icon']): React.ReactNode => (typeof icon === 'string' ? <Icon name={icon} /> : icon ? <span className="hive-tab-icon" aria-hidden="true">{icon}</span> : null)

/** The ids a tab and its panel take: unique per row of tabs, so two on one page never share one. */
export const tabIds = (base: string, id: string): { tab: string; panel: string } => ({ tab: `${base}-tab-${id}`, panel: `${base}-panel-${id}` })

export function Tabs<T extends string>({ items, value, onChange, label, fold, reserve = 0, className, idBase }: { items: TabItem<T>[]; value: T; onChange: (id: T) => void; label: string; fold?: boolean; reserve?: number; className?: string; idBase?: string }) {
  const own = useId()
  const base = idBase ?? own
  const rowRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  // The room the row's container has, and the width the tabs need with every name (measured off screen, so in any language).
  const [fit, setFit] = useState({ room: 0, need: 0 })
  useLayoutEffect(() => {
    const host = rowRef.current?.parentElement
    const row = measureRef.current
    if (!fold || !host || !row) return
    const measure = (): void => {
      const cs = getComputedStyle(host)
      const room = host.clientWidth - parseFloat(cs.paddingInlineStart) - parseFloat(cs.paddingInlineEnd)
      const need = Math.ceil(row.getBoundingClientRect().width)
      // Nothing to measure while the row isn't shown: keep the last fit.
      if (room > 0 && need > 0) setFit((f) => (f.room === room && f.need === need ? f : { room, need }))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    ro.observe(row)
    measure()
    return () => ro.disconnect()
  }, [fold])
  const icons = !!fold && fit.need > 0 && fit.need + reserve > fit.room
  // The selected tab stays in view when even the icons don't fit and the row scrolls.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [value, fit, icons])
  const ids = items.map((x) => x.id)
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const next = tabAfterKey(ids, value, e.key)
    if (next === null) return
    e.preventDefault()
    if (next !== value) onChange(next)
    // The focus moves with the selection (roving: only the selected tab is in the Tab order).
    listRef.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next)}"]`)?.focus()
  }
  return (
    <div ref={rowRef} className="hive-tabs-row">
      <div ref={listRef} className={cx('hive-tabs', icons && 'icons', className)} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((x) => {
          const selected = x.id === value
          const folded = icons && !selected && !!x.icon
          const named = x.unsaved ? tr(T.named, { tab: x.label }) : x.label
          const name = x.muted ? tr(T.withNote, { tab: named, note: x.muted }) : named
          return (
            <Tooltip key={x.id} content={x.tip ?? (folded ? name : (x.muted ?? null))}>
              <button type="button" role="tab" id={tabIds(base, x.id).tab} aria-controls={tabIds(base, x.id).panel} aria-selected={selected} {...(x.unsaved || x.muted ? { 'aria-label': name } : {})} tabIndex={selected ? 0 : -1} data-tab={x.id} {...(x.muted ? { 'data-muted': '' } : {})} {...x.attrs} className={cx('hive-tab', selected && 'active', folded && 'icon-only', x.muted && 'muted')} onClick={() => onChange(x.id)}>
                {tabIcon(x.icon)}
                <span className="hive-tab-label">{x.label}</span>
                {x.tag && <span className="hive-tab-tag">{x.tag}</span>}
                {x.count !== undefined && <span className="hive-tab-count">{fmt.number(x.count)}</span>}
                {x.unsaved && (
                  <Tooltip content={tr(T.unsaved)}>
                    <span className="hive-tab-unsaved" data-unsaved="" />
                  </Tooltip>
                )}
              </button>
            </Tooltip>
          )
        })}
      </div>
      {fold && (
        // The tabs with every name, for measuring; the names are CSS content, so no text here repeats a tab's.
        <div ref={measureRef} className="hive-tabs hive-tabs-measure" aria-hidden inert>
          {items.map((x) => (
            <span key={x.id} className="hive-tab" data-label={x.label}>
              {tabIcon(x.icon)}
              {x.tag && <span className="hive-tab-tag">{x.tag}</span>}
              {x.count !== undefined && <span className="hive-tab-count">{fmt.number(x.count)}</span>}
              {x.unsaved && <span className="hive-tab-unsaved" />}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** A tab's page: labelled by its tab; a page not selected stays mounted (its drafts kept) but hidden, out of the keyboard's way. */
export function TabPanel({ idBase, id, selected, className, children, ...rest }: { idBase: string; id: string; selected: boolean; className?: string; children: React.ReactNode } & Record<`data-${string}`, string>) {
  const ids = tabIds(idBase, id)
  return (
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} hidden={!selected} className={className} {...rest}>
      {children}
    </div>
  )
}
