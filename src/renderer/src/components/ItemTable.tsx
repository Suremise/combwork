import type { ReactNode } from 'react'
import { msg, tr, type Msg } from '@shared/i18n'
import { shortPath } from '@shared/shortPath'
import { agentRowsText } from '@shared/agentTable'
import { IconButton, Tooltip } from './ui'
import { cx } from '../util'
import { notify, useLanguage } from '../store'

/**
 * A path as the part that matters (#1317): its folder's name, or beside `other` (Was and Now) the part that differs
 * (`shortPath`), cut with an ellipsis where it's narrow. The full path is its tooltip and what screen readers read, and
 * copying it (a selection, Ctrl+C) copies the full path. Monospace only where the path is what the row is about (`mono`).
 */
export function ShortPath({ path, other, mono, className }: { path: string; other?: string; mono?: boolean; className?: string }) {
  // Cut in the middle when it doesn't fit (#1447): its last name kept whole, the rest shortened with an ellipsis, so a
  // slot's or worktree's own folder, often the part that differs, stays in sight.
  const shown = shortPath(path, other)
  const cut = Math.max(shown.lastIndexOf('\\'), shown.lastIndexOf('/'))
  return (
    <Tooltip content={path} className="short-path-tip">
      <span
        className={cx('short-path', mono && 'mono', className)}
        data-path={path}
        onCopy={(e) => {
          e.clipboardData.setData('text/plain', path)
          e.preventDefault()
        }}
      >
        <span className={cx('short-path-text', cut > 0 && 'short-path-split')} aria-hidden="true">
          {cut > 0 ? (
            <>
              <span className="short-path-head">{shown.slice(0, cut)}</span>
              <span className="short-path-tail">{shown.slice(cut)}</span>
            </>
          ) : (
            shown
          )}
        </span>
        <span className="visually-hidden">{path}</span>
      </span>
    </Tooltip>
  )
}

/** Copies a path in full, saying so: a row's Copy action beside its ShortPath. */
export function copyPath(path: string): void {
  void navigator.clipboard.writeText(path).then(
    () => notify('success', tr(msg({ id: 'shell.path.copied', defaultMessage: 'Path copied', description: 'A notification: a path (a folder or a worktree in a list) was copied to the clipboard in full.' }))),
    () => notify('error', tr(msg({ id: 'shell.path.copyFailed', defaultMessage: "Couldn't copy the path", description: 'A notification: copying a path to the clipboard failed.' })))
  )
}

/** A row's Copy action for a path (an icon button at the row's right edge): copies it in full (`copyPath`). */
export function CopyPathButton({ path }: { path: string }) {
  useLanguage()
  return <IconButton icon="copy" className="item-table-copy" title={tr(msg({ id: 'shell.path.copy', defaultMessage: 'Copy path', description: "A list's per-row button: copies the row's full path (a folder or a worktree) to the clipboard." }))} onClick={() => copyPath(path)} />
}

/**
 * A column after the first: its heading (a message, or text a caller hasn't converted yet), its cells' class (an agents
 * table's kinds: agents-table-card…) and its cell in the plain text, a message with the cell as {value} ("card {value}").
 */
export interface ItemColumn {
  label: string | Msg
  className?: string
  cell?: Msg
}

/** A row: the item in the first column (an icon, a name, a ShortPath), then a cell per column, then its actions. */
export interface ItemRow {
  key: string
  item: ReactNode
  /** The first column's class (an agents table's agents-table-name). */
  itemClassName?: string
  /** The item in the plain text (`itemTableText`): its name, or its full path. */
  text: string
  cells: { content: ReactNode; text: string; className?: string }[]
  /** Buttons at the row's right edge (Copy path, Remove…), aligned down the table. */
  actions?: ReactNode
  className?: string
  /** The row's data-* attributes (an agents table's data-agent), for tests and styling. */
  data?: Record<string, string>
}

/** A heading row across the table (a group's name: the quit dialog's agents under their workspace). */
export interface ItemGroup {
  key: string
  group: ReactNode
  text: string
  title?: string
  className?: string
}

const words = (t: string | Msg): string => (typeof t === 'string' ? t : tr(t))

/**
 * Items as a table (#1317, grown from the agents table, #529, #572: Darren's model for list dialogs): a header row,
 * hairline rules, one line an item; the first column any item (`first` its heading), columns after it, and each row's
 * actions at the right edge, aligned down the table, in a column of their own without a heading (a row without them gives
 * its last cell that room). Group headings span it.
 * How cells cut or wrap is the caller's className (the agents tables' cuts and shares, app.css). `presentation`: a
 * screen reader reads each row as the sentence its first cell holds (the table's role and headings left out), so the
 * caller hides the cells' visible text from it and keeps the actions reachable.
 */
export function ItemTable({ first, columns, rows, className, bodyClassName, data, presentation }: { first: string | Msg; columns: ItemColumn[]; rows: (ItemRow | ItemGroup)[]; className?: string; bodyClassName?: string; data?: Record<string, string>; presentation?: boolean }) {
  useLanguage()
  const actions = rows.some((r) => 'cells' in r && r.actions)
  const span = columns.length + 1 + (actions ? 1 : 0)
  return (
    <table className={cx('table', 'item-table', className)} role={presentation ? 'presentation' : undefined} {...dataAttrs(data)}>
      <thead aria-hidden={presentation || undefined}>
        <tr>
          <th>{words(first)}</th>
          {columns.map((c, i) => (
            <th key={i}>{words(c.label)}</th>
          ))}
          {actions && <th className="item-table-actions" />}
        </tr>
      </thead>
      <tbody className={bodyClassName}>
        {rows.map((r) =>
          'group' in r ? (
            <tr key={r.key} className={cx('item-table-group', r.className)} title={r.title}>
              <td colSpan={span}>{r.group}</td>
            </tr>
          ) : (
            <tr key={r.key} className={r.className} {...dataAttrs(r.data)}>
              <td className={r.itemClassName}>{r.item}</td>
              {columns.map((c, i) => (
                // A row without actions lets its last cell take their room (a dialog's Will do, cut later).
                <td key={i} className={cx(c.className, r.cells[i]?.className)} colSpan={actions && !r.actions && i === columns.length - 1 ? 2 : undefined}>
                  {r.cells[i]?.content}
                </td>
              ))}
              {actions && r.actions && <td className="item-table-actions">{r.actions}</td>}
            </tr>
          )
        )}
      </tbody>
    </table>
  )
}

const dataAttrs = (data: Record<string, string> | undefined): Record<string, string> => Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]))

/**
 * The table as plain text (#572), for screen readers and a confirm's copy: a line an item with every cell it shows, in
 * order ("• B1 — Working… · card #12 Lanes"; an empty cell left out), a group's line ("workspace-a:") over its items.
 */
export function itemTableText(columns: readonly ItemColumn[], rows: readonly (ItemRow | ItemGroup)[]): string {
  return agentRowsText(
    columns.map((c) => ({ cell: c.cell && ((text: string) => tr(c.cell!, { value: text })) })),
    rows.map((r) => ('group' in r ? { groupText: r.text } : { name: r.text, cells: r.cells }))
  )
}
