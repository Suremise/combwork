import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { PAGE_SIZES, choices, nextSort, rememberedSort, sortPanes, tableView, type ColumnRules, type Sort } from '@shared/tableView'
import { call } from '../api'
import { msg, tr } from '@shared/i18n'
import { set, useDateStyle, useStore } from '../store'
import { cx } from '../util'
import { Icon, IconButton, InfoTip, SearchInput, Tooltip } from './ui'

/**
 * A table that can grow: sorting by a header, quick filters under the headers, and pages under it (with rows per page,
 * remembered per table). The same look as Hive's other tables (.table in .table-wrap, as Performance's): real table
 * markup, aria-sort on the sorted header, labelled filters and paging buttons. Only the current page is rendered. Its
 * rows per page and its sort are remembered per table (`id`).
 */

export interface DataColumn<T> extends ColumnRules<T> {
  header: string
  cell: (row: T) => React.ReactNode
  /** A number: right-aligned, tabular figures. */
  num?: boolean
  /** Its first sort is descending (dates newest first, the biggest numbers first). */
  descFirst?: boolean
  /** How a choice filter names a value (default: the value). */
  choiceLabel?: (value: string) => string
  /** An (i) after the header, saying what the column is. */
  headerTip?: string
  /** A class for its header and cells (e.g. nowrap). */
  className?: string
}

/**
 * Columns whose cells, filters or sorting read the date and time format (formatDateTime): a new array when the format
 * changes, so the table filters by what it shows now (#236). The table itself knows nothing of dates.
 */
export function useDateColumns<T>(columns: DataColumn<T>[]): DataColumn<T>[] {
  const style = useDateStyle()
  return useMemo(() => (style ? [...columns] : columns), [columns, style])
}

export function DataTable<T>({
  id,
  rows,
  columns,
  rowKey,
  defaultSort = null,
  onRowClick,
  rowLabel,
  empty,
  pageSizes = PAGE_SIZES,
  defaultPageSize = 20,
  className,
  selection,
  rowClassName,
  detail,
  foot,
  filterFrom = 0,
  filtersAbove = false
}: {
  /** Names the table for its remembered rows per page ("compactions"). */
  id: string
  rows: T[]
  columns: DataColumn<T>[]
  rowKey: (row: T, index: number) => string
  /** The order before any header is clicked (null: the rows' own). */
  defaultSort?: Sort | null
  /** Rows open something when clicked, or with Enter when focused. */
  onRowClick?: (row: T) => void
  /** A clickable row's accessible name: what clicking it does. */
  rowLabel?: (row: T) => string
  /** Said instead of the table when there are no rows at all. */
  empty: string
  pageSizes?: number[]
  defaultPageSize?: number
  className?: string
  /**
   * Rows can be selected (#249): a checkbox before each row, and one in the header for every row the filters let
   * through (on every page). `selected` holds row keys; the caller keeps it and acts on it.
   */
  selection?: { selected: ReadonlySet<string>; onChange: (selected: Set<string>) => void; label: (row: T) => string }
  /** A row's own class (e.g. one being edited). */
  rowClassName?: (row: T) => string | false | undefined
  /** A row's detail, shown in a row of its own under it while it isn't null (a clickable row then has aria-expanded). */
  detail?: (row: T) => React.ReactNode | null
  /** Rows under the table's (totals), in a tfoot: whole `<tr>`s with the same columns. */
  foot?: React.ReactNode
  /** The quick filters show only with more rows than this (a small table needs none), or while one is set. */
  filterFrom?: number
  /**
   * The quick filters in a strip above the table, each named by its column's heading, instead of a row under the
   * headers (HI-1878): for a table that scrolls sideways with its filtered columns last, whose row under the headers
   * would show an empty band where the narrow view starts and the filters out of sight.
   */
  filtersAbove?: boolean
}) {
  const sizeKey = `table-rows:${id}`
  const saved = useStore((s) => s.panes[sizeKey])
  const pageSize = saved && pageSizes.includes(saved) ? saved : defaultPageSize
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [page, setPage] = useState(1)
  // The sort, remembered per table with its rows per page (#250); the default order keeps nothing. The selector returns
  // a string, so it is stable between renders.
  const sortable = columns.filter((c) => c.sortValue).map((c) => c.key)
  const savedSort = useStore((s) => {
    const r = rememberedSort(s.panes, id, sortable)
    return r ? `${r.desc ? '-' : '+'}${r.key}` : ''
  })
  const sort = useMemo((): Sort | null => (savedSort ? { key: savedSort.slice(1), desc: savedSort[0] === '-' } : defaultSort), [savedSort, defaultSort])
  const setSort = (next: Sort | null): void => {
    const { clear, set: keep } = sortPanes(useStore.getState().panes, id, next, defaultSort)
    set((s) => {
      const panes = { ...s.panes }
      for (const k of clear) delete panes[k]
      if (keep) panes[keep[0]] = keep[1]
      return { panes }
    })
    for (const k of clear) if (k !== keep?.[0]) void call('ui:setPane', k, null)
    if (keep) void call('ui:setPane', keep[0], keep[1])
  }
  const view = useMemo(() => tableView(rows, columns, { sort, filters, page, pageSize }), [rows, columns, sort, filters, page, pageSize])
  // Kept within the pages there are (rows went, a filter narrowed them).
  useEffect(() => {
    if (view.page !== page) setPage(view.page)
  }, [view.page, page])
  // Only the shown columns' filters count: one kept for a column the table no longer has (Keyboard Shortcuts' Category,
  // inside a category's tab, HI-1838) neither narrows the rows nor says they are filtered.
  const filtered = columns.some((c) => c.filter && filters[c.key]?.trim())
  const hasFilters = columns.some((c) => c.filter) && (rows.length > filterFrom || filtered)
  // Selecting every row the filters let through, not only this page's.
  const matchingKeys = useMemo(() => (selection ? tableView(rows, columns, { sort: null, filters, page: 1, pageSize: Math.max(1, rows.length) }).rows.map((r, i) => rowKey(r, i)) : []), [selection, rows, columns, filters, rowKey])
  const allSelected = !!selection && matchingKeys.length > 0 && matchingKeys.every((k) => selection.selected.has(k))
  const someSelected = !!selection && matchingKeys.some((k) => selection.selected.has(k))
  const toggle = (keys: string[], on: boolean): void => {
    if (!selection) return
    const next = new Set(selection.selected)
    for (const k of keys) {
      if (on) next.add(k)
      else next.delete(k)
    }
    selection.onChange(next)
  }

  if (!rows.length) return <div className="pane-empty data-table-empty">{empty}</div>

  const setFilter = (key: string, value: string): void => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }
  /** A column's quick filter: a choice, or a text box. */
  const filterControl = (c: DataColumn<T>): ReactNode => {
    const label = tr(msg({ id: 'shell.table.filterBy', defaultMessage: 'Filter {column}', description: "The name, for screen readers, of a table's filter under a column. {column} is the heading." }), { column: c.header })
    if (c.filter?.kind === 'choice')
      return (
        <select className="select" aria-label={label} value={filters[c.key] ?? ''} onChange={(e) => setFilter(c.key, e.target.value)}>
          <option value="">{tr(msg({ id: 'shell.table.all', defaultMessage: 'All', description: "A table's column filter's first choice: no filter." }))}</option>
          {choices(rows, c.filter.value, c.filter.values).map((v) => (
            <option key={v} value={v}>
              {c.choiceLabel?.(v) ?? v}
            </option>
          ))}
        </select>
      )
    return c.filter ? <SearchInput aria-label={label} placeholder={tr(msg({ id: 'shell.table.filter', defaultMessage: 'Filter', description: "Placeholder of a table's text filter under a column." }))} value={filters[c.key] ?? ''} onChange={(v) => setFilter(c.key, v)} /> : null
  }
  const filterRow = hasFilters && !filtersAbove
  const setSize = (n: number): void => {
    set((s) => ({ panes: { ...s.panes, [sizeKey]: n } }))
    void call('ui:setPane', sizeKey, n)
    setPage(1)
  }

  return (
    <div className={cx('data-table', className)}>
      {hasFilters && filtersAbove && (
        <div className="table-filter-bar">
          {columns
            .filter((c) => c.filter)
            .map((c) => (
              <label key={c.key} className="table-filter-item" data-filter={c.key}>
                <span className="faint">{c.header}</span>
                {filterControl(c)}
              </label>
            ))}
        </div>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {selection && (
                <th className="table-select" rowSpan={filterRow ? 2 : 1}>
                  <input
                    type="checkbox"
                    className="checkbox"
                    aria-label={filtered ? tr(msg({ id: 'shell.table.selectAllMatching', defaultMessage: '{n, plural, one {Select all # matching row} other {Select all # matching rows}}', description: "The name, for screen readers, of a table's tick box that selects every row its filters match (on every page)." }), { n: matchingKeys.length }) : tr(msg({ id: 'shell.table.selectAll', defaultMessage: '{n, plural, one {Select all # row} other {Select all # rows}}', description: "The name, for screen readers, of a table's tick box that selects every row." }), { n: matchingKeys.length })}
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected
                    }}
                    onChange={(e) => toggle(matchingKeys, e.target.checked)}
                  />
                </th>
              )}
              {columns.map((c) => {
                const sorted = sort?.key === c.key
                return (
                  <th key={c.key} className={cx(c.num && 'num', c.sortValue && 'sortable', c.className)} aria-sort={sorted ? (sort!.desc ? 'descending' : 'ascending') : undefined}>
                    {c.sortValue ? (
                      <button type="button" className="th-sort" onClick={() => setSort(nextSort(sort, c.key, !!c.descFirst, defaultSort))} title={tr(msg({ id: 'shell.table.sortBy', defaultMessage: 'Sort by {column}', description: "Tooltip of a table's column heading: sorts by it. {column} is the heading." }), { column: c.header })}>
                        {c.header}
                        {sorted && <Icon name={sort!.desc ? 'chevron-down' : 'chevron-up'} />}
                      </button>
                    ) : (
                      c.header
                    )}
                    {c.headerTip && (
                      <>
                        {' '}
                        <InfoTip text={c.headerTip} />
                      </>
                    )}
                  </th>
                )
              })}
            </tr>
            {filterRow && (
              <tr className="table-filters">
                {columns.map((c) => (
                  // The column's class too, so what styles a column (hidden when narrow, sticky) holds for its filter (HI-1838).
                  <th key={c.key} className={cx(c.num && 'num', c.className)}>
                    {filterControl(c)}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {view.rows.map((r, i) => {
              const key = rowKey(r, (view.page - 1) * pageSize + i)
              const picked = !!selection?.selected.has(key)
              const more = detail ? detail(r) : null
              return (
                <Fragment key={key}>
                <tr
                className={cx(onRowClick && 'clickable', picked && 'selected', rowClassName?.(r))}
                tabIndex={onRowClick ? 0 : undefined}
                aria-label={onRowClick ? rowLabel?.(r) : undefined}
                aria-expanded={detail && onRowClick ? more !== null : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        // A row is a button: Enter or Space on it (not on a control inside it) opens it; Space doesn't
                        // scroll the page.
                        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                          e.preventDefault()
                          onRowClick(r)
                        }
                      }
                    : undefined
                }
              >
                {selection && (
                  <td className="table-select" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="checkbox" aria-label={selection.label(r)} checked={picked} onChange={(e) => toggle([key], e.target.checked)} onKeyDown={(e) => e.stopPropagation()} />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key} className={cx(c.num && 'num', c.className)}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
                {more !== null && (
                  <tr className="table-detail">
                    <td colSpan={columns.length + (selection ? 1 : 0)}>{more}</td>
                  </tr>
                )}
                </Fragment>
              )
            })}
            {view.matched === 0 && (
              <tr className="table-no-match">
                <td colSpan={columns.length + (selection ? 1 : 0)}>
                  {tr(msg({ id: 'shell.table.noMatch', defaultMessage: 'No rows match the filters.', description: 'A table whose filters match nothing.' }))}{' '}
                  {filtered && (
                    <button type="button" className="btn small subtle" onClick={() => (setFilters({}), setPage(1))}>
                      {tr(msg({ id: 'shell.table.clearFilters', defaultMessage: 'Clear filters', description: 'Button in a table whose filters match nothing: clears them.' }))}
                    </button>
                  )}
                </td>
              </tr>
            )}
          </tbody>
          {foot && view.matched > 0 && <tfoot>{foot}</tfoot>}
        </table>
      </div>
      {/* Also on one page while there are more rows than the fewest per page, so a bigger size can be made smaller again. */}
      {(view.pages > 1 || view.matched > Math.min(...pageSizes)) && (
        <Pager
          page={view.page}
          pages={view.pages}
          from={view.from}
          to={view.to}
          total={view.matched}
          onPage={setPage}
          before={
          <label className="table-page-size">
            {tr(msg({ id: 'shell.table.rowsPerPage', defaultMessage: 'Rows per page', description: "Beside a table's choice of how many rows a page shows." }))}
            <select className="select" value={pageSize} onChange={(e) => setSize(Number(e.target.value))}>
              {pageSizes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          }
        />
      )}
    </div>
  )
}

/**
 * A table's page controls (DataTable's, and Git → History's, #1643): which rows the page shows, then first, previous,
 * "Page n of m", next and last. `before`: what comes first (DataTable's rows per page).
 */
export function Pager({ page, pages, from, to, total, onPage, before }: { page: number; pages: number; from: number; to: number; total: number; onPage: (page: number) => void; before?: React.ReactNode }) {
  return (
    <div className="table-paging" role="navigation" aria-label={tr(msg({ id: 'shell.table.pages', defaultMessage: 'Pages', description: "The name, for screen readers, of a table's page controls." }))}>
      {before}
      <span className="faint table-range">
        {tr(msg({ id: 'shell.table.range', defaultMessage: '{from, number}–{to, number} of {total, number}', description: 'Under a table: which of its rows the page shows.' }), { from, to, total })}
      </span>
      <div className="grow" />
      <PageButton label="«" title={tr(msg({ id: 'shell.table.first', defaultMessage: 'First page', description: "A table's button: its first page." }))} disabled={page === 1} onClick={() => onPage(1)} />
      <IconButton icon="chevron-left" title={tr(msg({ id: 'shell.table.previous', defaultMessage: 'Previous page', description: "A table's button." }))} disabled={page === 1} onClick={() => onPage(page - 1)} />
      <span className="table-page">
        {tr(msg({ id: 'shell.table.page', defaultMessage: 'Page {page, number} of {pages, number}', description: 'Under a table: which page it shows.' }), { page, pages })}
      </span>
      <IconButton icon="chevron-right" title={tr(msg({ id: 'shell.table.next', defaultMessage: 'Next page', description: "A table's button." }))} disabled={page === pages} onClick={() => onPage(page + 1)} />
      <PageButton label="»" title={tr(msg({ id: 'shell.table.last', defaultMessage: 'Last page', description: "A table's button: its last page." }))} disabled={page === pages} onClick={() => onPage(pages)} />
    </div>
  )
}

/** First and last page: the codicons have no double chevron, so a character, styled as the icon buttons beside it. */
function PageButton({ label, title, disabled, onClick }: { label: string; title: string; disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip content={title}>
      <button type="button" className="icon-btn table-page-end" aria-label={title} disabled={disabled} onClick={onClick}>
        {label}
      </button>
    </Tooltip>
  )
}

/**
 * A table cell of deliberate lines (#241): the value, and under it a smaller, fainter detail, neither of which wraps,
 * so a narrow table scrolls inside its section (.table-wrap) rather than breaking a value mid-phrase. In a number
 * column both lines align right. A missing detail still takes its line (`sub` null), so rows keep one height.
 */
export function CellLines({ main, sub, subWarn }: { main: React.ReactNode; sub?: React.ReactNode; subWarn?: boolean }) {
  return (
    <span className="cell-lines">
      <span className="cell-main">{main}</span>
      <span className={cx('cell-sub', subWarn && 'warn-text')} aria-hidden={sub ? undefined : true}>
        {sub || ' '}
      </span>
    </span>
  )
}
