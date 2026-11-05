import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BROWSE_LIMITS, JOURNAL_KINDS, KEPT_IMPORTANCE, type JournalEdit, type JournalEntryView, type JournalFilter, type JournalKind, type JournalPage, type JournalRow, type JournalSettings, type JournalSource } from '@shared/journal'
import { formatDateTime, formatLongDay, formatTime, daysAgo } from '@shared/dates'
import { msg, tr } from '@shared/i18n'
import { formatSize } from '@shared/units'
import { call, errorMessage } from '../api'
import { confirm, notify, set, setActivity, useDateStyle, useLanguage, useStore } from '../store'
import { cardNumberOf } from '../projectKeys'
import { cx } from '../util'
import { AssistantMark } from './AssistantMark'
import { TaskChip } from './CardChip'
import { journalBuildDetail, journalSummary } from './journalBuilds'
import { Icon, IconButton, InfoTip, Markdown, SearchInput, Tooltip } from './ui'

/**
 * The journal browser (#1033), the Assistant view's main area: the workspace's Assistant journal (#1031) as a timeline
 * of one-line entries, newest first, searched and filtered (kind, project, source, dates), the weekly digests on their
 * own; an entry opened beside it for its detail, why, links and tags, to correct or delete; Forget deletes everything a
 * search found, after saying how many. Read on or off (off keeps the data); the size and retention in its footer.
 */

const KIND: Record<JournalKind, ReturnType<typeof msg>> = {
  decision: msg({ id: 'assistant.journal.kind.decision', defaultMessage: 'Decision', description: "A kind of entry in the Assistant's journal: something decided." }),
  plan: msg({ id: 'assistant.journal.kind.plan', defaultMessage: 'Plan', description: "A kind of journal entry: something planned." }),
  event: msg({ id: 'assistant.journal.kind.event', defaultMessage: 'Event', description: 'A kind of journal entry: something that happened (Combwork records lanes, merges and unexpected closes as events).' }),
  incident: msg({ id: 'assistant.journal.kind.incident', defaultMessage: 'Incident', description: 'A kind of journal entry: something that went wrong.' }),
  insight: msg({ id: 'assistant.journal.kind.insight', defaultMessage: 'Insight', description: 'A kind of journal entry: something learned.' }),
  preference: msg({ id: 'assistant.journal.kind.preference', defaultMessage: 'Preference', description: 'A kind of journal entry: how the user likes things done.' }),
  moment: msg({ id: 'assistant.journal.kind.moment', defaultMessage: 'Moment', description: 'A kind of journal entry: a memorable moment of working together.' }),
  digest: msg({ id: 'assistant.journal.kind.digest', defaultMessage: 'Digest', description: "A kind of journal entry: the Assistant's summary of a week." })
}

/** Each kind's mark: a codicon, so it reads the same in both themes and by shape, not colour. */
const KIND_ICON: Record<JournalKind, string> = { decision: 'law', plan: 'checklist', event: 'pulse', incident: 'warning', insight: 'lightbulb', preference: 'heart', moment: 'star-empty', digest: 'calendar' }

const IMPORTANCE = [
  msg({ id: 'assistant.journal.importance.0', defaultMessage: 'Trivia', description: "A journal entry's importance, the lowest: goes first when the journal is pruned." }),
  msg({ id: 'assistant.journal.importance.1', defaultMessage: 'Everyday', description: "A journal entry's importance, the default: kept for the retention (Settings → Assistant → Journal)." }),
  msg({ id: 'assistant.journal.importance.2', defaultMessage: 'Important', description: "A journal entry's importance: kept past the retention and the size cap." }),
  msg({ id: 'assistant.journal.importance.3', defaultMessage: 'Essential', description: "A journal entry's importance, the highest: kept past the retention and the size cap." })
]

const SOURCE: Record<JournalSource, ReturnType<typeof msg>> = {
  assistant: msg({ id: 'assistant.journal.source.assistant', defaultMessage: 'The Assistant', description: 'Who wrote a journal entry: the Combwork Assistant.' }),
  hive: msg({ id: 'assistant.journal.source.hive', defaultMessage: 'Combwork', description: "Who wrote a journal entry: Combwork itself (its own facts: lanes, merges, unexpected closes). Combwork's name stays as it is." })
}

const M = {
  title: msg({ id: 'assistant.journal.title', defaultMessage: 'Journal', description: "The heading of the Assistant's journal browser (the Assistant view's main area)." }),
  digestsTitle: msg({ id: 'assistant.journal.digestsTitle', defaultMessage: 'Weekly Digests', description: "The heading of the journal browser showing only the Assistant's weekly digests." }),
  titleTip: msg({ id: 'assistant.journal.titleTip', defaultMessage: "What the Assistant keeps in its journal in this workspace, and Combwork's own facts (lanes, merges, unexpected closes), newest first. Open an entry to read it in full, correct it or delete it. It stays on this computer.", description: "The info tip of the journal browser's heading." }),
  refresh: msg({ id: 'assistant.journal.refresh', defaultMessage: 'Refresh', description: 'The journal browser: a button that reads the journal again.' }),
  search: msg({ id: 'assistant.journal.search', defaultMessage: 'Search the journal: summaries, details, why', description: "The journal browser's search box: what it searches (every word must be found)." }),
  filters: msg({ id: 'assistant.journal.filters', defaultMessage: 'Filters', description: "The accessible name of the journal browser's filters (kind, project, source, dates)." }),
  allKinds: msg({ id: 'assistant.journal.allKinds', defaultMessage: 'All kinds', description: "The journal browser's kind filter: every kind of entry." }),
  kindLabel: msg({ id: 'assistant.journal.kindLabel', defaultMessage: 'Kind', description: "The accessible name of the journal browser's kind filter, and the label of an entry's kind when editing it." }),
  allProjects: msg({ id: 'assistant.journal.allProjects', defaultMessage: 'All projects', description: "The journal browser's project filter: entries of every project and of the workspace." }),
  workspaceOnly: msg({ id: 'assistant.journal.workspaceOnly', defaultMessage: 'The workspace (no project)', description: "The journal browser's project filter: entries about the workspace as a whole, not one project." }),
  projectLabel: msg({ id: 'assistant.journal.projectLabel', defaultMessage: 'Project', description: "The accessible name of the journal browser's project filter." }),
  allSources: msg({ id: 'assistant.journal.allSources', defaultMessage: 'Combwork and the Assistant', description: "The journal browser's source filter: entries written by either." }),
  sourceLabel: msg({ id: 'assistant.journal.sourceLabel', defaultMessage: 'Written by', description: "The accessible name of the journal browser's source filter (Combwork or the Assistant), and a label in an entry's detail." }),
  from: msg({ id: 'assistant.journal.from', defaultMessage: 'From', description: "The journal browser's first date filter: entries on or after this day." }),
  to: msg({ id: 'assistant.journal.to', defaultMessage: 'To', description: "The journal browser's second date filter: entries on or before this day." }),
  clearFilters: msg({ id: 'assistant.journal.clearFilters', defaultMessage: 'Clear Filters', description: "The journal browser: a button that empties the search and resets every filter." }),
  forget: msg({ id: 'assistant.journal.forget', defaultMessage: 'Forget These…', description: 'The journal browser: a button that deletes every entry the search and filters found, after asking. The … says it asks: keep it.' }),
  forgetTip: msg({ id: 'assistant.journal.forgetTip', defaultMessage: 'Forget everything this search found: every matching entry is deleted, after asking.', description: 'The tooltip of the journal browser\'s "Forget These…" button.' }),
  forgetNeedsFilter: msg({ id: 'assistant.journal.forgetNeedsFilter', defaultMessage: 'Search or filter first: Forget deletes what they find. To delete the whole journal, use Settings → Assistant → Journal.', description: 'The tooltip of the journal browser\'s "Forget These…" button while no search or filter is set.' }),
  forgetTitle: msg({ id: 'assistant.journal.forgetTitle', defaultMessage: '{query, select, none {Forget {count, plural, one {# entry} other {# entries}}?} other {Forget everything about “{query}”?}}', description: 'Title of the question before Forget deletes entries: with a search ({query}, the user\'s words), "everything about" it; without one (none), how many.' }),
  forgetMessage: msg({ id: 'assistant.journal.forgetMessage', defaultMessage: '{count, plural, one {# entry matches} other {# entries match}} this search and its filters. {count, plural, one {It is} other {They are}} deleted for good (not to the Recycle Bin), and the Assistant can no longer recall {count, plural, one {it} other {them}}.', description: "The question before Forget deletes entries: how many. Recycle Bin is Windows' name for it." }),
  forgetButton: msg({ id: 'assistant.journal.forgetButton', defaultMessage: 'Forget {count, plural, one {# Entry} other {# Entries}}', description: 'The button of the question before Forget: deletes that many entries.' }),
  forgetNone: msg({ id: 'assistant.journal.forgetNone', defaultMessage: 'Nothing matches this search now: nothing to forget.', description: 'A notice: Forget was clicked, but no entry matches the search and filters any more.' }),
  forgetChanged: msg({ id: 'assistant.journal.forgetChanged', defaultMessage: 'Nothing was forgotten: the entries matching this search changed while you were asked. {count, plural, =0 {None match now.} one {# entry matches now.} other {# entries match now.}} Check them and use Forget These… again.', description: 'A notice after Forget: an entry was written, changed or deleted meanwhile, so the confirmed set no longer matched and nothing was deleted. {count} is how many match now. Forget These… is the button: use its translation.' }),
  forgot: msg({ id: 'assistant.journal.forgot', defaultMessage: 'Forgot {count, plural, one {# entry} other {# entries}}', description: 'A notice after Forget deleted entries.' }),
  failed: msg({ id: 'assistant.journal.failed', defaultMessage: "Couldn't change the journal", description: "An error's title: an edit, a delete or Forget in the journal browser failed (why follows)." }),
  loadFailed: msg({ id: 'assistant.journal.loadFailed', defaultMessage: "Couldn't read the journal", description: "An error's title: the journal browser couldn't read the journal (why follows)." }),
  count: msg({ id: 'assistant.journal.count', defaultMessage: '{total, plural, one {# entry} other {# entries}}', description: 'Above the journal timeline: how many entries match.' }),
  countOf: msg({ id: 'assistant.journal.countOf', defaultMessage: '{shown, number} of {total, plural, one {# entry} other {# entries}}', description: 'Above the journal timeline when only some are shown: how many of how many.' }),
  more: msg({ id: 'assistant.journal.more', defaultMessage: 'Show More', description: 'The journal timeline: a button at its end that shows older entries.' }),
  timeline: msg({ id: 'assistant.journal.timeline', defaultMessage: 'Journal entries, newest first', description: "The journal timeline's accessible name." }),
  today: msg({ id: 'assistant.journal.today', defaultMessage: 'Today', description: "A day's heading in the journal timeline." }),
  yesterday: msg({ id: 'assistant.journal.yesterday', defaultMessage: 'Yesterday', description: "A day's heading in the journal timeline." }),
  empty: msg({ id: 'assistant.journal.empty', defaultMessage: 'No entries yet. The Assistant writes decisions, plans and what it learns as it works, and Combwork adds its own facts: lanes, merges, unexpected closes.', description: 'The journal browser when the journal has no entries.' }),
  emptyDigests: msg({ id: 'assistant.journal.emptyDigests', defaultMessage: 'No weekly digests yet: the Assistant sums up each week in one.', description: 'The journal browser showing digests when there are none.' }),
  noMatch: msg({ id: 'assistant.journal.noMatch', defaultMessage: 'No entries match.', description: 'The journal browser when nothing matches the search and filters.' }),
  noWorkspace: msg({ id: 'assistant.journal.noWorkspace', defaultMessage: "Open a workspace to see its Assistant's journal.", description: 'The journal browser with no workspace open.' }),
  off: msg({ id: 'assistant.journal.off', defaultMessage: "The journal is off: the Assistant doesn't write to it and Combwork records nothing. What it has is kept, and you can still read, correct and delete it here.", description: 'A note at the top of the journal browser while the journal is off (Settings → Assistant → Journal).' }),
  turnOn: msg({ id: 'assistant.journal.turnOn', defaultMessage: 'Turn On', description: 'A button in the note that the journal is off: turns it on.' }),
  turnedOn: msg({ id: 'assistant.journal.turnedOn', defaultMessage: "Journal on: the Assistant's journal tools come with its next start.", description: 'A notice after the journal browser turned the journal on.' }),
  footer: msg({ id: 'assistant.journal.footer', defaultMessage: '{size} · {entries, plural, one {# entry} other {# entries}} · everyday entries kept {days, plural, one {# day} other {# days}} · {cap, select, none {no size cap} other {cap {cap} MB}}', description: "The journal browser's footer: its size on disk ({size}: \"1.2 MB\"), how many entries, how long everyday entries are kept, and the size cap in MB (none: no cap)." }),
  footerNone: msg({ id: 'assistant.journal.footerNone', defaultMessage: 'No journal yet · everyday entries kept {days, plural, one {# day} other {# days}} · {cap, select, none {no size cap} other {cap {cap} MB}}', description: "The journal browser's footer before anything is written: how long everyday entries are kept and the size cap in MB (none: no cap)." }),
  settings: msg({ id: 'assistant.journal.settings', defaultMessage: 'Journal Settings', description: "A link in the journal browser's footer: opens Settings → Assistant → Journal." }),
  close: msg({ id: 'assistant.journal.close', defaultMessage: 'Close', description: "The journal browser: closes the entry shown beside the timeline." }),
  edit: msg({ id: 'assistant.journal.edit', defaultMessage: 'Edit', description: 'The journal browser: a button that edits the entry shown.' }),
  delete: msg({ id: 'assistant.journal.delete', defaultMessage: 'Delete…', description: 'The journal browser: a button that deletes the entry shown, after asking. The … says it asks: keep it.' }),
  deleteTitle: msg({ id: 'assistant.journal.deleteTitle', defaultMessage: 'Delete this journal entry?', description: 'Title of the question before a journal entry is deleted.' }),
  deleteMessage: msg({ id: 'assistant.journal.deleteMessage', defaultMessage: '“{summary}” is deleted for good (not to the Recycle Bin), and the Assistant can no longer recall it.', description: "The question before a journal entry is deleted; {summary} is its one line. Recycle Bin is Windows' name for it." }),
  deleteButton: msg({ id: 'assistant.journal.deleteButton', defaultMessage: 'Delete', description: 'The button of the question before a journal entry is deleted.' }),
  deleted: msg({ id: 'assistant.journal.deleted', defaultMessage: 'Journal entry deleted', description: 'A notice after a journal entry was deleted.' }),
  gone: msg({ id: 'assistant.journal.gone', defaultMessage: 'This entry is no longer in the journal.', description: 'The journal browser: the entry opened was deleted meanwhile (or pruned).' }),
  save: msg({ id: 'assistant.journal.save', defaultMessage: 'Save', description: 'The journal browser: saves the edited entry.' }),
  cancel: msg({ id: 'assistant.journal.cancel', defaultMessage: 'Cancel', description: "The journal browser: leaves the entry's edit without saving." }),
  summary: msg({ id: 'assistant.journal.summary', defaultMessage: 'Summary', description: "A journal entry's one line (a label when editing it)." }),
  detail: msg({ id: 'assistant.journal.detail', defaultMessage: 'Detail', description: "A journal entry's detail (a heading in the entry, and a label when editing it)." }),
  why: msg({ id: 'assistant.journal.why', defaultMessage: 'Why it mattered', description: "A journal entry's why (a heading in the entry, and a label when editing it)." }),
  importance: msg({ id: 'assistant.journal.importance', defaultMessage: 'Importance', description: "A journal entry's importance (a label in the entry and when editing it)." }),
  links: msg({ id: 'assistant.journal.links', defaultMessage: 'Links', description: "A journal entry's links (cards, commits, notes, other entries): a heading in the entry." }),
  tags: msg({ id: 'assistant.journal.tags', defaultMessage: 'Tags', description: "A journal entry's tags: a heading in the entry." }),
  when: msg({ id: 'assistant.journal.when', defaultMessage: 'When', description: 'A label in a journal entry: when it was written.' }),
  edited: msg({ id: 'assistant.journal.edited', defaultMessage: 'edited {when}', description: 'After when a journal entry was written: when it was last changed.' }),
  digestOf: msg({ id: 'assistant.journal.digestOf', defaultMessage: 'Sums up {period}', description: 'A weekly digest in the journal: the period it sums up ({period}: "2026-W42").' }),
  workspace: msg({ id: 'assistant.journal.workspace', defaultMessage: 'Workspace', description: "A journal entry's project when it is about the workspace as a whole." }),
  supersededBy: msg({ id: 'assistant.journal.supersededBy', defaultMessage: 'Superseded by entry {id}', description: "A journal entry replaced by a newer one ({id}): a link that opens it." }),
  superseded: msg({ id: 'assistant.journal.superseded', defaultMessage: 'Superseded', description: 'A mark on a journal entry replaced by a newer one.' }),
  supersedes: msg({ id: 'assistant.journal.supersedes', defaultMessage: 'Supersedes entry {id}', description: 'A journal entry that replaced an older one ({id}): a link that opens it.' }),
  entryLink: msg({ id: 'assistant.journal.entryLink', defaultMessage: 'Entry {id}', description: 'A link from a journal entry to another entry ({id}): opens it.' }),
  openEntry: msg({ id: 'assistant.journal.openEntry', defaultMessage: '{kind}, {when}: {summary}', description: "A journal timeline row's accessible name: its kind, when, and its one line." }),
  summaryRequired: msg({ id: 'assistant.journal.summaryRequired', defaultMessage: 'An entry needs a summary.', description: 'The journal browser: saving an edited entry with an empty summary.' })
}

type Filters = { query: string; kind: '' | JournalKind; project: string; source: '' | JournalSource; from: string; to: string }
const NO_FILTERS: Filters = { query: '', kind: '', project: '', source: '', from: '', to: '' }
/** The project filter's value for the workspace's own entries (no project): never a project's name. */
const WORKSPACE = '\u0000workspace'

/** A day picked in a date box ("2026-10-18") as the start of that day here, or the end of it. */
function dayIso(day: string, end: boolean): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return undefined
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (end ? 1 : 0))
  return new Date(d.getTime() - (end ? 1 : 0)).toISOString()
}

function filterOf(f: Filters, digests: boolean): JournalFilter {
  return {
    query: f.query.trim() || undefined,
    kinds: digests ? ['digest'] : f.kind ? [f.kind] : undefined,
    project: f.project === WORKSPACE ? '' : f.project || undefined,
    source: f.source || undefined,
    since: dayIso(f.from, false),
    until: dayIso(f.to, true)
  }
}

type Status = { settings: JournalSettings; bytes: number; entries: number }

/** Opens Settings → Assistant (the journal's settings are there). */
function openSettings(): void {
  set({ settingsSection: 'assistant', settingsQuery: '' })
  setActivity('settings')
}

export function JournalView({ digests }: { digests: boolean }) {
  useLanguage()
  useDateStyle()
  const workspace = useStore((s) => s.workspace?.path ?? null)
  const version = useStore((s) => s.journalVersion)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [query, setQuery] = useState('')
  // A page knows the workspace and filter it was read for (`key`): until the current one's arrives, it is only shown.
  const [page, setPage] = useState<(JournalPage & { key: string }) | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [projects, setProjects] = useState<string[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // The words typed settle before the journal is searched.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.query === query ? f : { ...f, query })), 200)
    return () => clearTimeout(t)
  }, [query])
  const filter = useMemo(() => filterOf(filters, digests), [filters, digests])
  const filtered = !!(filter.query || filter.project !== undefined || filter.source || filter.since || filter.until || (!digests && filter.kinds))
  const shown = page?.rows.length ?? 0
  // Read again from the top on any change (the filters, the journal itself), keeping as many rows as were shown.
  const keep = useRef<number>(BROWSE_LIMITS.page)
  keep.current = Math.max(BROWSE_LIMITS.page, shown)
  const key = JSON.stringify([workspace, filter])
  const keyNow = useRef(key)
  keyNow.current = key
  // The rows shown are the search's as it is now, typing settled: only then may Forget act on it (#1033 round 2).
  const current = page?.key === key && query === filters.query
  useEffect(() => {
    if (!workspace) return
    let live = true
    const at = key
    const fresh = page?.key !== at
    void call('journal:browse', filter, 0, fresh ? BROWSE_LIMITS.page : Math.min(BROWSE_LIMITS.max, keep.current)).then(
      (p) => live && keyNow.current === at && setPage({ ...p, key: at }),
      (e) => live && notify('error', tr(M.loadFailed), errorMessage(e))
    )
    void call('journal:status').then((s) => live && setStatus(s), () => {})
    void call('journal:projects').then((p) => live && setProjects(p), () => {})
    return () => {
      live = false
    }
    // key is the workspace and filter; page is read for whether this is a new search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])
  const showMore = (): void => {
    if (!page || !current) return
    const at = key
    // Only onto the rows of the search it was asked for: a change meanwhile drops it.
    void call('journal:browse', filter, page.rows.length).then(
      (p) => keyNow.current === at && setPage((was) => (was?.key === at ? { ...p, key: at, rows: [...was.rows, ...p.rows.filter((r) => !was.rows.some((x) => x.id === r.id))] } : was)),
      (e) => notify('error', tr(M.loadFailed), errorMessage(e))
    )
  }
  const reload = (): void => set((s) => ({ journalVersion: s.journalVersion + 1 }))

  // Forget asks main what this search matches now (a count, and a token for exactly that set), asks the user, and main
  // deletes only that set: an entry in or out of it meanwhile, and nothing goes (#1033 round 2).
  const forget = async (): Promise<void> => {
    if (!current) return
    const f = filter
    setBusy(true)
    try {
      const seen = await call('journal:forgetPreview', f)
      if (!seen.count) return notify('info', tr(M.forgetNone))
      const count = seen.count
      if (!(await confirm({ title: tr(M.forgetTitle, { query: f.query ?? 'none', count }), message: tr(M.forgetMessage, { count }), confirmLabel: tr(M.forgetButton, { count }), danger: true }))) return
      const r = await call('journal:forget', f, seen.token)
      if ('gone' in r) {
        notify('info', tr(M.forgot, { count: r.gone }))
        setSelected(null)
      } else {
        notify('warning', tr(M.forgetChanged, { count: r.changed.count }))
        reload()
      }
    } catch (e) {
      notify('error', tr(M.failed), errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const turnOn = (): void => {
    setBusy(true)
    void call('journal:set', { enabled: true })
      .then(() => {
        notify('info', tr(M.turnedOn))
        reload()
      }, (e) => notify('error', tr(M.failed), errorMessage(e)))
      .finally(() => setBusy(false))
  }

  // Up and down move between the rows, Home and End to the first and last; Enter or Space opens one (a button's own).
  const onListKey = (e: React.KeyboardEvent): void => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('.journal-row-main') ?? [])]
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const go = (i: number): void => {
      e.preventDefault()
      rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus()
    }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at < 0 ? 0 : at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(rows.length - 1)
    else if (e.key === 'Escape' && selected !== null) {
      e.preventDefault()
      e.stopPropagation()
      closeEntry()
    }
  }
  /** Closes the open entry, the keyboard back on its row. */
  const closeEntry = (): void => {
    const id = selected
    setSelected(null)
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-entry="${id}"] .journal-row-main`)?.focus())
  }

  if (!workspace) {
    return (
      <div className="empty-state" style={{ paddingTop: '18vh' }}>
        <Icon name="notebook" />
        {tr(M.noWorkspace)}
      </div>
    )
  }
  const settings = status?.settings
  const groups = groupByDay(page?.rows ?? [])
  return (
    <div
      className="journal"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          searchRef.current?.focus()
          searchRef.current?.select()
        }
      }}
    >
      <div className="journal-main">
        <div className="pane-header journal-header">
          {tr(digests ? M.digestsTitle : M.title)}
          <InfoTip text={tr(M.titleTip)} />
          <div className="actions">
            <Tooltip content={tr(filtered ? M.forgetTip : M.forgetNeedsFilter)}>
              <button className="btn small subtle journal-forget" disabled={busy || !filtered || !current || !page?.total} onClick={() => void forget()}>
                <Icon name="trash" /> {tr(M.forget)}
              </button>
            </Tooltip>
            <IconButton icon="refresh" title={tr(M.refresh)} onClick={reload} />
          </div>
        </div>
        <div className="journal-filters" role="group" aria-label={tr(M.filters)}>
          <span className="journal-search">
            <Icon name="search" />
            <SearchInput
              ref={searchRef}
              placeholder={tr(M.search)}
              aria-label={tr(M.search)}
              value={query}
              onChange={setQuery}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  listRef.current?.querySelector<HTMLElement>('.journal-row-main')?.focus()
                }
              }}
            />
          </span>
          {!digests && (
            <select className="select journal-kind" aria-label={tr(M.kindLabel)} value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value as Filters['kind'] })}>
              <option value="">{tr(M.allKinds)}</option>
              {JOURNAL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {tr(KIND[k])}
                </option>
              ))}
            </select>
          )}
          <select className="select journal-project" aria-label={tr(M.projectLabel)} value={filters.project} onChange={(e) => setFilters({ ...filters, project: e.target.value })}>
            <option value="">{tr(M.allProjects)}</option>
            <option value={WORKSPACE}>{tr(M.workspaceOnly)}</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select className="select journal-source" aria-label={tr(M.sourceLabel)} value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value as Filters['source'] })}>
            <option value="">{tr(M.allSources)}</option>
            <option value="assistant">{tr(SOURCE.assistant)}</option>
            <option value="hive">{tr(SOURCE.hive)}</option>
          </select>
          <label className="journal-date">
            <span className="faint">{tr(M.from)}</span>
            <input type="date" className="input journal-from" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          </label>
          <label className="journal-date">
            <span className="faint">{tr(M.to)}</span>
            <input type="date" className="input journal-to" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
          </label>
          {(filtered || query) && (
            <button
              className="btn small subtle journal-clear"
              onClick={() => {
                setQuery('')
                setFilters(NO_FILTERS)
              }}
            >
              {tr(M.clearFilters)}
            </button>
          )}
        </div>
        {settings && !settings.enabled && (
          <div className="banner info journal-off" role="status">
            <Icon name="circle-slash" />
            <span className="grow">{tr(M.off)}</span>
            <button className="btn small" disabled={busy} onClick={turnOn}>
              {tr(M.turnOn)}
            </button>
          </div>
        )}
        {page && current && page.total > 0 && <div className="journal-count faint" aria-live="polite">{shown < page.total ? tr(M.countOf, { shown, total: page.total }) : tr(M.count, { total: page.total })}</div>}
        <div className={cx('journal-scroll', page && !current && 'pending')} aria-busy={!current || undefined}>
          {page && !page.rows.length && <div className="pane-empty journal-empty">{tr(filtered ? M.noMatch : digests ? M.emptyDigests : M.empty)}</div>}
          {page && page.rows.length > 0 && (
            <ul className="journal-timeline" aria-label={tr(M.timeline)} ref={listRef} onKeyDown={onListKey}>
              {groups.map((g) => (
                <li key={g.day} className="journal-day">
                  <div className="journal-day-head" aria-hidden>
                    {g.label}
                  </div>
                  <ul className="journal-day-rows" aria-label={g.label}>
                    {g.rows.map((r) => (
                      <JournalRowView key={r.id} r={r} selected={selected === r.id} onOpen={() => setSelected(r.id)} />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {page && current && shown < page.total && (
            <button className="btn small subtle journal-more" onClick={showMore}>
              {tr(M.more)}
            </button>
          )}
        </div>
        <div className="journal-footer faint">
          <span className="grow">
            {status &&
              settings &&
              (status.entries || status.bytes
                ? tr(M.footer, { size: formatSize(status.bytes), entries: status.entries, days: settings.retentionDays, cap: settings.capMB === null ? 'none' : String(settings.capMB) })
                : tr(M.footerNone, { days: settings.retentionDays, cap: settings.capMB === null ? 'none' : String(settings.capMB) }))}
          </span>
          <button className="journal-link journal-settings-link" onClick={openSettings}>
            <Icon name="settings-gear" /> {tr(M.settings)}
          </button>
        </div>
      </div>
      {selected !== null && (
        <EntryPane
          key={selected}
          id={selected}
          version={version}
          scope={settings?.scope ?? []}
          onOpen={setSelected}
          onClose={closeEntry}
        />
      )}
    </div>
  )
}

/** The timeline's days, newest first: Today, Yesterday, then the day's name. */
function groupByDay(rows: JournalRow[]): { day: string; label: string; rows: JournalRow[] }[] {
  const out: { day: string; label: string; rows: JournalRow[] }[] = []
  const now = new Date()
  for (const r of rows) {
    const d = new Date(r.at)
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const last = out[out.length - 1]
    if (last?.day === day) last.rows.push(r)
    else {
      const ago = daysAgo(d, now)
      out.push({ day, label: ago === 0 ? tr(M.today) : ago === 1 ? tr(M.yesterday) : formatLongDay(d, now), rows: [r] })
    }
  }
  return out
}

/** Who wrote an entry, as a small mark: the Assistant's own, or Hive's. */
function SourceMark({ source }: { source: JournalSource }) {
  const name = tr(SOURCE[source])
  return source === 'assistant' ? <AssistantMark className="journal-source-mark" title={name} /> : (
    <span className="journal-source-mark" role="img" aria-label={name} title={name}>
      <Icon name="server-process" />
    </span>
  )
}

/**
 * A card a link names, as the board's chip (its column's colour, opens it); one not on the board, as its number. The link
 * names it by its key (HI-1661: `HI-12`, an old key or a moved card's old name) or, written before, by its number.
 */
function CardLink({ refText, short }: { refText: string; short?: boolean }) {
  // Read in the selector, so a card the board gets later (or a key changed) is found then.
  const n = useStore(() => cardNumberOf(refText))
  const card = useStore((s) => (n !== null ? s.tasks.find((c) => c.number === n) : undefined))
  if (n === null) return <span className="badge">{refText}</span>
  return <TaskChip number={n} column={card?.column ?? null} title={card?.title} short={short} blocked={!!card?.blocked} />
}

function JournalRowView({ r, selected, onOpen }: { r: JournalRow; selected: boolean; onOpen: () => void }) {
  const cards = r.links.filter((l) => l.type === 'card')
  const kind = tr(KIND[r.kind])
  const time = formatTime(r.at)
  return (
    <li className={cx('journal-row', selected && 'selected', r.supersededBy !== null && 'superseded')} data-entry={r.id} data-kind={r.kind}>
      <button className="journal-row-main" aria-current={selected || undefined} aria-label={tr(M.openEntry, { kind, when: formatDateTime(r.at), summary: journalSummary(r) })} onClick={onOpen}>
        <span className="journal-time faint">{time}</span>
        <Icon name={KIND_ICON[r.kind]} className="journal-kind-mark" title={kind} />
        <span className="journal-summary">{journalSummary(r)}</span>
        {r.importance >= KEPT_IMPORTANCE && <Icon name={r.importance > KEPT_IMPORTANCE ? 'star-full' : 'star-half'} className="journal-important" title={tr(IMPORTANCE[r.importance])} />}
        {r.supersededBy !== null && <span className="badge journal-superseded-badge">{tr(M.superseded)}</span>}
        {r.digestOf && <span className="badge">{r.digestOf}</span>}
        {r.project && <span className="badge journal-project-badge">{r.project}</span>}
        <SourceMark source={r.source} />
      </button>
      {cards.length > 0 && (
        <span className="journal-chips">
          {cards.slice(0, 3).map((l) => (
            <CardLink key={l.ref} refText={l.ref} short />
          ))}
          {cards.length > 3 && <span className="faint">+{cards.length - 3}</span>}
        </span>
      )}
    </li>
  )
}

/** An entry in full beside the timeline: its detail, why, links and tags; Edit and Delete. */
function EntryPane({ id, version, scope, onOpen, onClose }: { id: number; version: number; scope: readonly string[]; onOpen: (id: number) => void; onClose: () => void }) {
  const [entry, setEntry] = useState<JournalEntryView | null | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    void call('journal:entry', id).then(setEntry, (e) => notify('error', tr(M.loadFailed), errorMessage(e)))
  }, [id])
  useEffect(load, [load, version])
  const remove = (): void => {
    if (!entry) return
    void confirm({ title: tr(M.deleteTitle), message: tr(M.deleteMessage, { summary: journalSummary(entry) }), confirmLabel: tr(M.deleteButton), danger: true }).then((ok) => {
      if (!ok) return
      setBusy(true)
      void call('journal:deleteEntry', entry.id)
        .then(() => {
          notify('info', tr(M.deleted))
          onClose()
        }, (e) => notify('error', tr(M.failed), errorMessage(e)))
        .finally(() => setBusy(false))
    })
  }
  return (
    <aside className="journal-entry" aria-label={entry ? journalSummary(entry) : undefined} onKeyDown={(e) => e.key === 'Escape' && !editing && (e.stopPropagation(), onClose())}>
      <div className="editor-toolbar journal-entry-toolbar">
        <span className="path">{entry && <>
          <Icon name={KIND_ICON[entry.kind]} /> <strong>{tr(KIND[entry.kind])}</strong>
        </>}</span>
        {entry && !editing && (
          <>
            <button className="btn small subtle journal-edit" disabled={busy} onClick={() => setEditing(true)}>
              <Icon name="edit" /> {tr(M.edit)}
            </button>
            <button className="btn small subtle journal-delete" disabled={busy} onClick={remove}>
              <Icon name="trash" /> {tr(M.delete)}
            </button>
          </>
        )}
        <IconButton icon="close" title={tr(M.close)} onClick={onClose} />
      </div>
      <div className="journal-entry-body">
        {entry === null && <div className="pane-empty">{tr(M.gone)}</div>}
        {entry && editing && <EntryEdit entry={entry} scope={scope} onDone={(saved) => (setEditing(false), saved && load())} />}
        {entry && !editing && <EntryRead entry={entry} onOpen={onOpen} />}
      </div>
    </aside>
  )
}

function EntryRead({ entry, onOpen }: { entry: JournalEntryView; onOpen: (id: number) => void }) {
  const entryLink = (n: number, text: string): React.ReactNode => (
    <button key={`e${n}`} className="journal-link journal-entry-link" onClick={() => onOpen(n)}>
      {text}
    </button>
  )
  const buildDetail = journalBuildDetail(entry)
  return (
    <>
      <h2 className="journal-entry-summary">{journalSummary(entry)}</h2>
      <dl className="journal-meta">
        <dt>{tr(M.when)}</dt>
        <dd>
          {formatDateTime(entry.at)}
          {entry.updatedAt && <span className="faint"> · {tr(M.edited, { when: formatDateTime(entry.updatedAt) })}</span>}
        </dd>
        <dt>{tr(M.projectLabel)}</dt>
        <dd>{entry.project ?? tr(M.workspace)}</dd>
        <dt>{tr(M.sourceLabel)}</dt>
        <dd className="flex">
          <SourceMark source={entry.source} /> {tr(SOURCE[entry.source])}
        </dd>
        <dt>{tr(M.importance)}</dt>
        <dd>{tr(IMPORTANCE[entry.importance] ?? IMPORTANCE[1])}</dd>
      </dl>
      {entry.digestOf && <p className="muted">{tr(M.digestOf, { period: entry.digestOf })}</p>}
      {entry.supersededBy !== null && <p className="journal-note">{entryLink(entry.supersededBy, tr(M.supersededBy, { id: entry.supersededBy }))}</p>}
      {entry.supersedes.length > 0 && <p className="journal-note">{entry.supersedes.map((n) => entryLink(n, tr(M.supersedes, { id: n })))}</p>}
      {entry.detail && (
        <section>
          <h3>{tr(M.detail)}</h3>
          {buildDetail ? (
            <div className="journal-detail">
              {buildDetail.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ) : (
            <Markdown source={entry.detail} className="journal-detail" />
          )}
        </section>
      )}
      {entry.why && (
        <section>
          <h3>{tr(M.why)}</h3>
          <p className="journal-why">{entry.why}</p>
        </section>
      )}
      {entry.links.length > 0 && (
        <section>
          <h3>{tr(M.links)}</h3>
          <div className="journal-links">
            {entry.links.map((l) =>
              l.type === 'card' ? (
                <CardLink key={`c${l.ref}`} refText={l.ref} />
              ) : l.type === 'entry' && Number.isInteger(Number(l.ref)) ? (
                entryLink(Number(l.ref), tr(M.entryLink, { id: l.ref }))
              ) : (
                <span key={`${l.type}${l.ref}`} className="badge" data-link={l.type}>
                  <span className="faint">{l.type}</span> <code>{l.ref}</code>
                </span>
              )
            )}
          </div>
        </section>
      )}
      {entry.tags.length > 0 && (
        <section>
          <h3>{tr(M.tags)}</h3>
          <div className="journal-links">
            {entry.tags.map((t) => (
              <span key={t} className="badge">
                {t}
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

/** Edit: summary, kind (those the scope allows, and its own), importance, detail, why. Only what changed is saved. */
function EntryEdit({ entry, scope, onDone }: { entry: JournalEntryView; scope: readonly string[]; onDone: (saved: boolean) => void }) {
  const [summary, setSummary] = useState(entry.summary)
  const [kind, setKind] = useState<JournalKind>(entry.kind)
  const [importance, setImportance] = useState(entry.importance)
  const [detail, setDetail] = useState(entry.detail ?? '')
  const [why, setWhy] = useState(entry.why ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kinds = JOURNAL_KINDS.filter((k) => k === entry.kind || k === 'digest' || scope.includes(k))
  const save = (): void => {
    if (!summary.trim()) return setError(tr(M.summaryRequired))
    const edit: JournalEdit = {}
    if (summary !== entry.summary) edit.summary = summary
    if (kind !== entry.kind) edit.kind = kind
    if (importance !== entry.importance) edit.importance = importance
    if (detail !== (entry.detail ?? '')) edit.detail = detail || null
    if (why !== (entry.why ?? '')) edit.why = why || null
    if (!Object.keys(edit).length) return onDone(false)
    setBusy(true)
    void call('journal:edit', entry.id, edit).then(
      () => onDone(true),
      (e) => {
        setBusy(false)
        setError(errorMessage(e))
      }
    )
  }
  return (
    <form
      className="journal-edit-form"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onDone(false)
        }
      }}
    >
      <label>
        <span>{tr(M.summary)}</span>
        <input className="input journal-edit-summary" value={summary} maxLength={300} autoFocus disabled={busy} onChange={(e) => setSummary(e.target.value)} />
      </label>
      <div className="flex">
        <label>
          <span>{tr(M.kindLabel)}</span>
          <select className="select journal-edit-kind" value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as JournalKind)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {tr(KIND[k])}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{tr(M.importance)}</span>
          <select className="select journal-edit-importance" value={importance} disabled={busy} onChange={(e) => setImportance(Number(e.target.value))}>
            {IMPORTANCE.map((m, i) => (
              <option key={i} value={i}>
                {tr(m)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        <span>{tr(M.detail)}</span>
        <textarea className="input journal-edit-detail" rows={8} value={detail} maxLength={100_000} disabled={busy} onChange={(e) => setDetail(e.target.value)} />
      </label>
      <label>
        <span>{tr(M.why)}</span>
        <textarea className="input journal-edit-why" rows={3} value={why} maxLength={4000} disabled={busy} onChange={(e) => setWhy(e.target.value)} />
      </label>
      {error && (
        <div className="banner danger" role="alert">
          {error}
        </div>
      )}
      <div className="flex">
        <button type="submit" className="btn primary journal-save" disabled={busy}>
          {tr(M.save)}
        </button>
        <button type="button" className="btn subtle" disabled={busy} onClick={() => onDone(false)}>
          {tr(M.cancel)}
        </button>
      </div>
    </form>
  )
}
