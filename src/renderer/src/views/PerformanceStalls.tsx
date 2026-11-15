import { useEffect, useMemo } from 'react'
import { fmt, msg, tr } from '@shared/i18n'
import { formatDateTime, formatWhen } from '@shared/dates'
import { MAIN_DELAY_HOURS_KEPT, MAIN_STALLS_KEPT, mostlyWaiting, type MainDelayHour, type MainStall, type MainStalls, type MainStallWork } from '@shared/mainStalls'
import { call } from '../api'
import { InfoTip, LoadFailed } from '../components/ui'
import { CellLines, DataTable, useDateColumns, type DataColumn } from '../components/DataTable'
import { useLanguage } from '../store'
import { useScopedLoad } from '../scopedLoad'
import { timeAgo } from '../util'

/**
 * Performance's Main process stalls (HI-1135): the main process's recent stalls since Combwork started, as combwork.log's "The
 * main process was busy" lines note them (main/mainStalls.ts), with the step that held the thread and the work that
 * overlapped it. Combwork's, not a workspace's: no range or filter applies. Read with the page, and again as it refreshes.
 */

const M = {
  heading: msg({ id: 'performance.stalls.heading', defaultMessage: 'Main process stalls', description: "Heading of the Performance page's table of the times Combwork's main process was busy long enough to be felt." }),
  since: msg({ id: 'performance.stalls.since', defaultMessage: 'since Combwork started', description: 'After the Main process stalls heading: the table covers the time since Combwork started, not the page\'s range. Lower case.' }),
  tip: msg({
    id: 'performance.stalls.tip',
    defaultMessage:
      "Times Combwork's main process was busy for more than 250 ms. Every pane's typing goes through it, so a stall is felt as lag. Step is the work that held it, where Combwork knows it (a database or file step); During it is what else was under way, which may only have waited behind it. Little CPU means it was waiting (on the disk, a lock, another program); it is measured from half a second before, so it can be a little more than the length. The last {kept, number} since Combwork started, kept in memory only; combwork.log notes them too, at most one line a minute.",
    description: 'Info tip beside the Main process stalls heading of the Performance page. Step and During it are its columns: keep them as named there. combwork.log is a file name.'
  }),
  when: msg({ id: 'performance.stalls.when', defaultMessage: 'When', description: "Column header of the Performance page's Main process stalls table: when the stall ended (a time)." }),
  length: msg({ id: 'performance.stalls.length', defaultMessage: 'Length', description: "Column header of the Performance page's Main process stalls table: how long the main process was busy." }),
  cpu: msg({ id: 'performance.stalls.cpu', defaultMessage: 'Main thread CPU', description: "Column header of the Performance page's Main process stalls table: the main thread's CPU time during the stall." }),
  step: msg({ id: 'performance.stalls.step', defaultMessage: 'Step', description: "Column header of the Performance page's Main process stalls table: the database or file step that held the main process." }),
  during: msg({ id: 'performance.stalls.during', defaultMessage: 'During it', description: "Column header of the Performance page's Main process stalls table: the other work under way during the stall (calls from the window, Agent API requests, hooks)." }),
  waiting: msg({ id: 'performance.stalls.waiting', defaultMessage: 'mostly waiting', description: "Under a stall's CPU time in the Performance page's Main process stalls table: it used under half its length, so it was waiting. Lower case." }),
  cpuUnknown: msg({ id: 'performance.stalls.cpuUnknown', defaultMessage: 'unknown', description: "A stall's CPU time in the Performance page's Main process stalls table when it couldn't be measured. Lower case." }),
  none: msg({ id: 'performance.stalls.none', defaultMessage: 'none known', description: "A stall's Step or During it cell in the Performance page's Main process stalls table when Combwork knows of none. Lower case." }),
  more: msg({ id: 'performance.stalls.more', defaultMessage: 'and {n, number} more', description: "The last line of a stall's Step or During it cell in the Performance page's Main process stalls table: how many more were under way. Lower case." }),
  ms: msg({ id: 'performance.stalls.ms', defaultMessage: '{ms, number} ms', description: 'A length in milliseconds ("750 ms") in the Performance page\'s Main process stalls table.' }),
  seconds: msg({ id: 'performance.stalls.seconds', defaultMessage: '{s} s', description: 'A length in seconds ("1.5 s", the number already formatted) in the Performance page\'s Main process stalls table.' }),
  running: msg({ id: 'performance.stalls.running', defaultMessage: '{length}, still running', description: "A work's length in a stall's During it or Step cell, while it was still under way when the stall was recorded ({length}: \"1.5 s\")." }),
  repeated: msg({ id: 'performance.stalls.repeated', defaultMessage: '×{n, number} · {length}', description: "After a work's name in a stall's During it or Step cell when there were several of it: how many ({n}) and their length in all ({length}: \"81 ms\", or \"1.5 s, still running\")." }),
  count: msg({ id: 'performance.stalls.count', defaultMessage: '{total, plural, one {# stall since Combwork started} other {# stalls since Combwork started}}{listed, select, all {} other {; the last {kept, number} are listed}}.', description: "Under the Performance page's Main process stalls table: how many stalls there were since Combwork started, and that only the last {kept} are listed when there were more. {listed} is a key (all or some): don't translate the keys, only the texts." }),
  emptyHours: msg({ id: 'performance.stalls.hours.empty', defaultMessage: 'No delays of 50 ms or more since Combwork started.', description: "The Performance page's Delays by hour table when there were none." }),
  empty: msg({ id: 'performance.stalls.empty', defaultMessage: 'No stalls since Combwork started.', description: "The Performance page's Main process stalls table when there were none." }),
  hoursHeading: msg({ id: 'performance.stalls.hours.heading', defaultMessage: 'Delays by hour', description: "Heading of the Performance page's table counting, hour by hour, the times Combwork's main process was held up, short ones included." }),
  hoursTip: msg({
    id: 'performance.stalls.hours.tip',
    defaultMessage:
      "How often Combwork's main process was held up, by the hour, short delays included: from 50 ms they can be felt while typing. A short delay is counted once per half second, the longest in it. Stalls are those over 250 ms, every one, with the work each names first, where combwork.log names at most one a minute; it notes each hour in a line too. The last {kept, number} hours with any, since Combwork started, kept in memory only.",
    description: 'Info tip beside the Delays by hour heading of the Performance page. combwork.log is a file name.'
  }),
  hour: msg({ id: 'performance.stalls.hours.hour', defaultMessage: 'Hour', description: "Column header of the Performance page's Delays by hour table: the hour counted (its start, a date and time)." }),
  d50: msg({ id: 'performance.stalls.hours.d50', defaultMessage: '50–100 ms', description: "Column header of the Performance page's Delays by hour table: how many delays of 50 ms up to 100 ms. Keep the numbers." }),
  d100: msg({ id: 'performance.stalls.hours.d100', defaultMessage: '100–250 ms', description: "Column header of the Performance page's Delays by hour table: how many delays of 100 ms up to 250 ms. Keep the numbers." }),
  stalls: msg({ id: 'performance.stalls.hours.stalls', defaultMessage: 'Stalls', description: "Column header of the Performance page's Delays by hour table: how many stalls (over 250 ms) in the hour." }),
  unlogged: msg({ id: 'performance.stalls.hours.unlogged', defaultMessage: '{n, number} not logged', description: "Under an hour's stall count in the Performance page's Delays by hour table: how many of them combwork.log didn't name. Lower case." }),
  causes: msg({ id: 'performance.stalls.hours.causes', defaultMessage: 'Named first', description: "Column header of the Performance page's Delays by hour table: for the hour's stalls, the work each named first, with how many times." }),
  unnamed: msg({ id: 'performance.stalls.hours.unnamed', defaultMessage: 'nothing marked', description: "A line of an hour's Named first cell in the Performance page's Delays by hour table: stalls with no work known to Combwork under way. Lower case." }),
  times: msg({ id: 'performance.stalls.hours.times', defaultMessage: '×{n, number}', description: "After a work's name, or after nothing marked, in the Performance page's Delays by hour table: how many stalls named it first." }),
  loadTarget: msg({ id: 'performance.stalls.loadTarget', defaultMessage: "the main process's stalls", description: 'What could not be read on the Performance page: shown in "Could not load {what}: {error}".' })
}

/** A length as the table shows it: milliseconds under a second, else seconds to one decimal. */
const length = (ms: number): string => (ms < 1000 ? tr(M.ms, { ms }) : tr(M.seconds, { s: fmt.figure(ms / 1000, 1) }))

/** A work's length, and how many there were when more than one ("×52 · 81 ms"). */
const workLength = (w: MainStallWork): string => {
  const shown = w.running ? tr(M.running, { length: length(w.ms) }) : length(w.ms)
  return w.count > 1 ? tr(M.repeated, { n: w.count, length: shown }) : shown
}

/** A cell's work, a line per label (its fixed name as Combwork gives it, how many, and their length), and how many more. */
function WorkLines({ list, more }: { list: MainStallWork[]; more: number }) {
  if (!list.length) return <span className="faint">{tr(M.none)}</span>
  return (
    <span className="perf-stall-work">
      {list.map((w) => (
        <span key={w.label} className="perf-stall-item">
          <code>{w.label}</code> <span className="faint">{workLength(w)}</span>
        </span>
      ))}
      {more > 0 && <span className="faint">{tr(M.more, { n: more })}</span>}
    </span>
  )
}

/** The table's columns, in the window's language (made again when it changes). */
const stallColumns = (): DataColumn<MainStall>[] => [
  { key: 'when', header: tr(M.when), descFirst: true, className: 'nowrap', cell: (s) => <span title={`${formatDateTime(s.at)} (${timeAgo(new Date(s.at).toISOString())})`}>{formatWhen(s.at)}</span>, sortValue: (s) => s.at },
  { key: 'length', header: tr(M.length), num: true, descFirst: true, cell: (s) => length(s.ms), sortValue: (s) => s.ms },
  {
    key: 'cpu',
    header: tr(M.cpu),
    num: true,
    descFirst: true,
    cell: (s) => (s.cpuMs === null ? <span className="faint">{tr(M.cpuUnknown)}</span> : <CellLines main={length(s.cpuMs)} sub={mostlyWaiting(s) ? tr(M.waiting) : ''} />),
    sortValue: (s) => s.cpuMs
  },
  { key: 'step', header: tr(M.step), cell: (s) => <WorkLines list={s.steps} more={s.stepsMore} />, sortValue: (s) => s.steps[0]?.label ?? '' },
  { key: 'during', header: tr(M.during), cell: (s) => <WorkLines list={s.work} more={s.workMore} />, sortValue: (s) => s.work[0]?.label ?? '' }
]
/** An hour's first-named work, a line per label with how many stalls named it, and the stalls with none. */
function Causes({ h }: { h: MainDelayHour }) {
  if (!h.top.length && !h.unnamed) return <span className="faint">{tr(M.none)}</span>
  return (
    <span className="perf-stall-work">
      {h.top.map((t) => (
        <span key={t.label} className="perf-stall-item">
          <code>{t.label}</code> <span className="faint">{tr(M.times, { n: t.count })}</span>
        </span>
      ))}
      {h.unnamed > 0 && (
        <span className="perf-stall-item faint">
          {tr(M.unnamed)} {tr(M.times, { n: h.unnamed })}
        </span>
      )}
    </span>
  )
}

/** The hours table's columns, in the window's language. */
const hourColumns = (): DataColumn<MainDelayHour>[] => [
  { key: 'hour', header: tr(M.hour), descFirst: true, className: 'nowrap', cell: (h) => formatDateTime(h.at), sortValue: (h) => h.at },
  { key: 'd50', header: tr(M.d50), num: true, descFirst: true, cell: (h) => fmt.number(h.d50), sortValue: (h) => h.d50 },
  { key: 'd100', header: tr(M.d100), num: true, descFirst: true, cell: (h) => fmt.number(h.d100), sortValue: (h) => h.d100 },
  { key: 'stalls', header: tr(M.stalls), num: true, descFirst: true, cell: (h) => <CellLines main={fmt.number(h.stalls)} sub={h.unlogged ? tr(M.unlogged, { n: h.unlogged }) : ''} />, sortValue: (h) => h.stalls },
  { key: 'causes', header: tr(M.causes), cell: (h) => <Causes h={h} />, sortValue: (h) => h.top[0]?.label ?? '' }
]
const LATEST_HOUR = { key: 'hour', desc: true }

const NEWEST = { key: 'when', desc: true }
const SCOPE = 'main-stalls'

export function StallsTable({ refreshAt }: { refreshAt: number }) {
  const language = useLanguage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useDateColumns(useMemo(() => stallColumns(), [language]))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hours = useDateColumns(useMemo(() => hourColumns(), [language]))
  const loaded = useScopedLoad<MainStalls>(SCOPE)
  const { load } = loaded
  // With the page, and each time it refreshes.
  useEffect(() => {
    load(SCOPE, () => call('performance:stalls'))
  }, [load, refreshAt])
  const data = loaded.data
  return (
    <>
      <h2 className="section" data-section="main-stalls">
        {tr(M.heading)} <InfoTip text={tr(M.tip, { kept: MAIN_STALLS_KEPT })} />
        <span className="faint perf-unfiltered"> {tr(M.since)}</span>
      </h2>
      {loaded.error && !data && <LoadFailed what={tr(M.loadTarget)} error={loaded.error} onRetry={() => load(SCOPE, () => call('performance:stalls'))} />}
      {data && (
        <>
          <DataTable id="perf-stalls" rows={data.stalls} columns={columns} rowKey={(s) => `${s.at}-${s.ms}`} defaultSort={NEWEST} defaultPageSize={10} empty={tr(M.empty)} />
          {data.total > 0 && <p className="hint" data-stalls-count>{tr(M.count, { total: data.total, listed: data.total > data.stalls.length ? 'some' : 'all', kept: data.stalls.length })}</p>}
          {/* HI-3293: the short delays the table above leaves out, and every stall's cause, by the hour. */}
          <h3 className="section" data-section="main-delay-hours">
            {tr(M.hoursHeading)} <InfoTip text={tr(M.hoursTip, { kept: MAIN_DELAY_HOURS_KEPT })} />
          </h3>
          <DataTable id="perf-delay-hours" rows={data.hours ?? []} columns={hours} rowKey={(h) => String(h.at)} defaultSort={LATEST_HOUR} defaultPageSize={6} empty={tr(M.emptyHours)} />
        </>
      )}
    </>
  )
}
