import { useEffect, useMemo } from 'react'
import { fmt, msg, tr } from '@shared/i18n'
import { formatDateTime, formatWhen } from '@shared/dates'
import { MAIN_STALLS_KEPT, mostlyWaiting, type MainStall, type MainStalls, type MainStallWork } from '@shared/mainStalls'
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
  empty: msg({ id: 'performance.stalls.empty', defaultMessage: 'No stalls since Combwork started.', description: "The Performance page's Main process stalls table when there were none." }),
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
const NEWEST = { key: 'when', desc: true }
const SCOPE = 'main-stalls'

export function StallsTable({ refreshAt }: { refreshAt: number }) {
  const language = useLanguage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useDateColumns(useMemo(() => stallColumns(), [language]))
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
        </>
      )}
    </>
  )
}
