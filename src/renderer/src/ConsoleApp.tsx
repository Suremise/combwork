import { Children, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ConsoleEvent, ConsoleRecordingInfo, ConsoleSource } from '@shared/devConsole'
import { language, msg, onLanguageChange, tr, tRich, type Msg } from '@shared/i18n'
import { clockTime, filterChoices, filterEvents, mergeEvents, sourceGroups, sourceOption, startsOpen } from '@shared/consoleView'
import type { AppSettings, CombworkEvent } from '@shared/types'
import { providerName } from '@shared/providers'
import { FLIGHT_TRIGGER_NAME, readFlightWhat, FLIGHT_WHAT, type FlightTrigger } from '@shared/flightRecorder'
import { timeAgo } from './util'
import { call, errorMessage } from './api'
import { Icon, IconButton, SearchInput } from './components/ui'
import { cx } from './util'
import './styles/console.css'

/**
 * The developer console window (#366, #637): pick a source (an agent's session, the Assistant or Hive itself) and watch
 * what comes in next to what Hive made of it. Capture runs while this window watches a source (#636); pause stops the
 * list moving (capture goes on, and resuming fills in from the ring), clear hides what came before. Record writes the
 * source's events from then on to a file in main (#638), redacted unless the user ticks text for that recording. While
 * Settings → Advanced → Developer console: show text is on (#699), main sends this window the text too (never secrets):
 * a banner says so, and the recording box starts ticked.
 */

function applyTheme(s: AppSettings | null): void {
  if (!s) return
  const t = s.appearance.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : s.appearance.theme
  document.documentElement.dataset.theme = t
  document.documentElement.style.setProperty('--ui-font-size', `${s.appearance.uiFontSize}px`)
}

const NO_SOURCES: ConsoleSource[] = []

// The window's own words (#1104). The events it lists (names, kinds, summaries, payloads) are Hive's records, as
// recordings save them: they stay English.
const M = {
  source: msg({ id: 'console.source', defaultMessage: 'Source', description: "The developer console's source picker (accessible name): which agent's session, the Assistant or Combwork itself it watches." }),
  pickSource: msg({ id: 'console.pickSource', defaultMessage: 'Pick a source…', description: "The developer console's source picker, while it watches none." }),
  refresh: msg({ id: 'console.refresh', defaultMessage: 'Refresh the sources', description: "The developer console's button that lists the sources (agents, the Assistant, Combwork) again." }),
  notWatching: msg({ id: 'console.notWatching', defaultMessage: 'Not watching', description: "The developer console's indicator: no source is picked, so nothing is captured." }),
  paused: msg({ id: 'console.paused', defaultMessage: '{waiting, plural, =0 {Paused} other {Paused ({waiting, number} new)}}', description: "The developer console's indicator while paused: the list holds still; {waiting} events came meanwhile (shown on resume)." }),
  live: msg({ id: 'console.live', defaultMessage: 'Live', description: "The developer console's indicator: events show as they come." }),
  resume: msg({ id: 'console.resume', defaultMessage: 'Resume', description: "The developer console's button: the list moves again, filled in with what came while paused." }),
  pause: msg({ id: 'console.pause', defaultMessage: 'Pause', description: "The developer console's button: the list stops moving (capture goes on)." }),
  clear: msg({ id: 'console.clear', defaultMessage: 'Clear', description: "The developer console's button: hides the events so far; only later ones show." }),
  stopRecording: msg({ id: 'console.stopRecording', defaultMessage: 'Stop recording', description: "The developer console's button while it records the source's events to a file." }),
  recordToFile: msg({ id: 'console.recordToFile', defaultMessage: 'Record to a file', description: "The developer console's button that opens the recording box: the source's events from now on go to a file." }),
  record: msg({ id: 'console.record', defaultMessage: 'Record', description: "The developer console's recording box (accessible name)." }),
  recordWhat: msg({ id: 'console.recordWhat', defaultMessage: 'Record {source} to a file, from now until you stop. Redacted unless you tick text: no prompt or reply text, commands, tokens or sign-ins.', description: "The developer console's recording box. {source} is the watched agent's name, the Assistant, Combwork, or the words 'this source'. 'Tick text' refers to the box below it (include prompt and reply text)." }),
  thisSource: msg({ id: 'console.thisSource', defaultMessage: 'this source', description: "The developer console's recording box, where the watched source's name goes when it isn't known: 'Record this source to a file…'." }),
  includeText: msg({ id: 'console.includeText', defaultMessage: 'Include prompt and reply text in this recording (tokens and sign-ins stay masked)', description: "A check box in the developer console's recording box: the recording keeps the prompts', replies' and commands' text; secrets stay hidden." }),
  cancel: msg({ id: 'console.cancel', defaultMessage: 'Cancel', description: "The developer console's recording box: closes it without recording." }),
  startRecording: msg({ id: 'console.startRecording', defaultMessage: 'Start recording', description: "The developer console's recording box: starts recording the source's events to a file." }),
  search: msg({ id: 'console.search', defaultMessage: 'Search events (Ctrl+F)', description: "The developer console's search box (placeholder). Ctrl+F is its shortcut: keep it." }),
  searchLabel: msg({ id: 'console.searchLabel', defaultMessage: 'Search events', description: "The developer console's search box (accessible name)." }),
  provider: msg({ id: 'console.provider', defaultMessage: 'Provider', description: "The developer console's filter by coding agent CLI (Claude Code, Codex, Copilot), accessible name." }),
  allProviders: msg({ id: 'console.allProviders', defaultMessage: 'All providers', description: "The developer console's provider filter: no filter, every coding agent CLI's events." }),
  eventTypes: msg({ id: 'console.eventTypes', defaultMessage: 'Event types', description: "The developer console's row of buttons that show or hide each kind of event (accessible name)." }),
  unredacted: msg({ id: 'console.unredacted', defaultMessage: '<b>Unredacted:</b> this console shows prompt, reply and command text (Settings → Advanced → Developer console: show prompt, reply and command text). Tokens, API keys and sign-in details stay masked.', description: "A warning banner in the developer console while the setting that shows text is on. Settings → Advanced → Developer console: show prompt, reply and command text is where it is: use those translated names. <b> is bold: keep the tags." }),
  emptyRedacted: msg({ id: 'console.emptyRedacted', defaultMessage: 'Pick a source to watch. Combwork captures a source only while this window watches it, and what it captures is redacted: no prompt or reply text, commands, tokens or sign-in details.', description: 'The developer console while no source is picked.' }),
  emptyText: msg({ id: 'console.emptyText', defaultMessage: 'Pick a source to watch. Combwork captures a source only while this window watches it, and what it captures is redacted: no tokens or sign-in details (this window shows prompt, reply and command text while the setting is on).', description: 'The developer console while no source is picked, with the setting that shows text on (Settings → Advanced).' }),
  noMatch: msg({ id: 'console.noMatch', defaultMessage: 'No events match.', description: "The developer console's list: the search and filters hide every event." }),
  waiting: msg({ id: 'console.waiting', defaultMessage: 'Waiting for events…', description: "The developer console's list: the source is watched, and nothing has come yet." }),
  outlineTip: msg({ id: 'console.outlineTip', defaultMessage: 'Cut down to its outline (too large)', description: "The developer console: an event's payload was too large to keep, so only its shape (fields, sizes) was kept." }),
  bytes: msg({ id: 'console.bytes', defaultMessage: '{n, plural, one {# byte} other {# bytes}}', description: "The developer console's event detail: the payload's size." }),
  outline: msg({ id: 'console.outline', defaultMessage: 'cut down to its outline', description: "The developer console's event detail: the payload was too large to keep, so only its shape (fields, sizes) was kept." }),
  close: msg({ id: 'console.close', defaultMessage: 'Close (Esc)', description: "The developer console's event detail: closes it. Esc is its key: keep it." }),
  raw: msg({ id: 'console.raw', defaultMessage: 'Raw', description: "The developer console's event detail: the heading of what came in, as it came (from the CLI)." }),
  made: msg({ id: 'console.made', defaultMessage: 'What Combwork made of it', description: "The developer console's event detail: the heading of what Combwork read from what came in." }),
  events: msg({ id: 'console.events', defaultMessage: '{n, plural, one {# event} other {# events}}{cleared, select, yes { (cleared)} other {}}', description: "The developer console's status bar: how many events it lists; (cleared) when Clear hid the earlier ones." }),
  eventsOf: msg({ id: 'console.eventsOf', defaultMessage: '{shown, number} of {n, plural, one {# event} other {# events}}{cleared, select, yes { (cleared)} other {}}', description: "The developer console's status bar: how many events the search and filters show, of how many; (cleared) when Clear hid the earlier ones." }),
  dropped: msg({ id: 'console.dropped', defaultMessage: '{n, number} not delivered (too many at once)', description: "The developer console's status bar: events that came too fast for the window, so it never got them." }),
  capturing: msg({ id: 'console.capturing', defaultMessage: 'Capturing', description: "The developer console's status bar: Combwork is capturing the watched source's events." }),
  notCapturing: msg({ id: 'console.notCapturing', defaultMessage: 'Not capturing', description: "The developer console's status bar: Combwork isn't capturing the watched source's events." }),
  recording: msg({ id: 'console.recording', defaultMessage: 'Recording {n, plural, one {# event} other {# events}} to {name}{withText, select, yes { (with text)} other {}}', description: "The developer console's status bar while it records: how many events so far, to the file {name}; (with text) when prompt and reply text are kept." }),
  failed: msg({ id: 'console.failed', defaultMessage: 'Recording failed after {n, plural, one {# event} other {# events}} in {name}: {error}', description: "The developer console's status bar: a recording to the file {name} stopped as it couldn't be written; {error} says why." }),
  notWritten: msg({ id: 'console.notWritten', defaultMessage: 'it could not be written', description: "The developer console: why a recording failed, when there's no other reason: 'Recording failed after 3 events in <file>: it could not be written'." }),
  saved: msg({ id: 'console.saved', defaultMessage: 'Saved {n, plural, one {# event} other {# events}} to {name}{limit, select, yes { (it reached its size limit)} other {}}', description: "The developer console's status bar: a recording ended, with how many events, in the file {name}; the note when it stopped at its largest size." }),
  showInFolder: msg({ id: 'console.showInFolder', defaultMessage: 'Show in folder', description: "The developer console's status bar: shows the recording's file in File Explorer." }),
  unredactedStatus: msg({ id: 'console.unredactedStatus', defaultMessage: 'Unredacted: text shown; tokens and sign-ins masked', description: "The developer console's status bar while the setting that shows text is on." }),
  redactedStatus: msg({ id: 'console.redactedStatus', defaultMessage: 'Redacted: no prompt or reply text, commands, tokens or sign-ins', description: "The developer console's status bar: what it hides." }),
  nothing: msg({ id: 'console.nothing', defaultMessage: 'Nothing', description: "The developer console's event detail: an empty side (nothing came in, or Combwork made nothing of it)." }),
  captures: msg({ id: 'console.captures', defaultMessage: 'Captures', description: "The developer console's button and list of the flight recorder's captures: recent events Combwork saved by itself when something rare happened to an agent." }),
  capturesNone: msg({ id: 'console.capturesNone', defaultMessage: 'No captures yet. Turn on a flight recorder trigger in Settings → Advanced, and Combwork saves an agent\'s recent events by itself when it fires.', description: "The developer console's list of captures, while there are none. Settings → Advanced is where the triggers are: use its name as Combwork shows it." }),
  captureRow: msg({ id: 'console.captureRow', defaultMessage: 'Captured {trigger} on {agent}, {when}', description: "A capture in the developer console's list, as the flight recorder's notice says it: what it caught (\"a safeguard stop\"), on which agent, and how long ago (\"5 minutes ago\")." }),
  captureEvents: msg({ id: 'console.captureEvents', defaultMessage: '{events, plural, one {# event} other {# events}}', description: "A capture in the developer console's list: how many events it holds." }),
  showCapture: msg({ id: 'console.showCapture', defaultMessage: 'Show in folder', description: "A link beside a capture in the developer console's list: shows its file in File Explorer." })
}

/** What a capture saw, in Hive's language when its file says it as a message this Hive knows; else its English. */
const whatOf = (c: ConsoleRecordingInfo['capture']): string => {
  const w = readFlightWhat(c?.whatText)
  return w ? tr(FLIGHT_WHAT[w.id] as Msg, w.values as never) : (c?.what ?? '')
}

/** What the console's list calls a capture's trigger: one Hive knows, in its language; another as its file says it. */
const triggerName = (t: string): string => (Object.hasOwn(FLIGHT_TRIGGER_NAME, t) ? tr(FLIGHT_TRIGGER_NAME[t as FlightTrigger]) : t)

const bold = (chunks: ReactNode[]): ReactNode => <b>{chunks}</b>

/** The window's language: it renders again when it changes (the main window's store does this for App). */
function useLanguage(): string {
  const [code, setCode] = useState(language)
  useEffect(() => onLanguageChange(setCode), [])
  return code
}

export function ConsoleApp() {
  useLanguage()
  const [sources, setSources] = useState<ConsoleSource[]>(NO_SOURCES)
  const [source, setSource] = useState('')
  const [events, setEvents] = useState<ConsoleEvent[]>([])
  const [paused, setPaused] = useState(false)
  const [waiting, setWaiting] = useState(0)
  const [dropped, setDropped] = useState(0)
  const [afterSeq, setAfterSeq] = useState(0)
  const [provider, setProvider] = useState('')
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(() => new Set())
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<number | null>(null)
  const [error, setError] = useState('')
  // This window's recording: going on, or the last one it stopped (#638). Text is asked for each time.
  const [recording, setRecording] = useState<ConsoleRecordingInfo | null>(null)
  const [recordMenu, setRecordMenu] = useState(false)
  // The flight recorder's captures (#698), read when the list is opened.
  const [captures, setCaptures] = useState<ConsoleRecordingInfo[] | null>(null)
  const [withText, setWithText] = useState(false)
  // Settings → Advanced → Developer console: show text (#699); main decides what it sends, this says so.
  const [showText, setShowText] = useState(false)
  const recordingRef = useRef(false)
  recordingRef.current = !!recording?.recording
  const pausedRef = useRef(false)
  const sourceRef = useRef('')
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const searchRef = useRef<HTMLInputElement>(null)
  const eventsRef = useRef(events)
  eventsRef.current = events
  // The newest event received for the source, shown or held while paused: Clear hides everything up to it.
  const latestRef = useRef(0)
  // Clear's boundary: events at or before it never come back (a resume's snapshot included).
  const clearedRef = useRef(0)

  useEffect(() => {
    let settings: AppSettings | null = null
    void call('settings:get').then((s) => {
      settings = s
      applyTheme(s)
    })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = (): void => applyTheme(settings)
    mq.addEventListener('change', onScheme)
    const off = window.combwork.onEvent((e: CombworkEvent) => {
      if (e.type === 'settings-changed') {
        settings = e.settings
        applyTheme(e.settings)
      } else if (e.type === 'console-recording') {
        setRecording(e.recording)
      } else if (e.type === 'console-options') {
        setShowText(e.showText)
      } else if (e.type === 'console-events') {
        const mine = e.events.filter((x) => x.source === sourceRef.current && x.seq > clearedRef.current)
        if (e.dropped) setDropped((n) => n + e.dropped!)
        if (!mine.length) return
        latestRef.current = Math.max(latestRef.current, ...mine.map((x) => x.seq))
        if (pausedRef.current) setWaiting((n) => n + mine.length)
        else setEvents((list) => mergeEvents(list, mine))
      }
    })
    return () => {
      off()
      mq.removeEventListener('change', onScheme)
    }
  }, [])

  const loadSources = useCallback(() => {
    call('console:sources').then(
      (list) => {
        setSources(list)
        setError('')
      },
      (e) => setError(errorMessage(e))
    )
  }, [])

  useEffect(() => {
    void call('console:options').then((o) => setShowText(o.showText), () => undefined)
  }, [])

  // Text turned on or off: what is listed is read again as main now sends it (turned off, no text stays on screen).
  const shownText = useRef<boolean | null>(null)
  useEffect(() => {
    const was = shownText.current
    shownText.current = showText
    const from = sourceRef.current
    if (was === null || was === showText || !from) return
    void call('console:snapshot', from, clearedRef.current).then((got) => {
      if (sourceRef.current !== from) return
      // Paused, the list stays as it was: only what it shows is read again.
      const list = eventsRef.current
      const upTo = pausedRef.current ? (list.length ? list[list.length - 1].seq : 0) : Infinity
      const kept = got.filter((x) => x.seq > clearedRef.current && x.seq <= upTo)
      if (kept.length) latestRef.current = Math.max(latestRef.current, kept[kept.length - 1].seq)
      setEvents(kept)
    })
  }, [showText])

  useEffect(() => {
    loadSources()
    window.addEventListener('focus', loadSources)
    return () => window.removeEventListener('focus', loadSources)
  }, [loadSources])

  // Watching a source starts its capture; another source replaces it, none ends it.
  useEffect(() => {
    sourceRef.current = source
    // A recording is of one source: picking another stops it.
    if (recordingRef.current) void call('console:stopRecording').then((r) => r && setRecording(r), () => undefined)
    setRecordMenu(false)
    setEvents([])
    setPicked(null)
    setWaiting(0)
    setDropped(0)
    setAfterSeq(0)
    latestRef.current = 0
    clearedRef.current = 0
    stick.current = true
    if (!source) {
      void call('console:subscribe', []).catch(() => undefined)
      return
    }
    let stale = false
    call('console:subscribe', [source]).then(
      (got) => {
        if (stale) return
        const first = got[source] ?? []
        if (first.length) latestRef.current = Math.max(latestRef.current, first[first.length - 1].seq)
        setEvents((list) => mergeEvents(list, first))
        loadSources()
      },
      (e) => !stale && setError(errorMessage(e))
    )
    return () => {
      stale = true
    }
  }, [source, loadSources])

  const resume = useCallback(() => {
    pausedRef.current = false
    setPaused(false)
    setWaiting(0)
    const from = sourceRef.current
    if (!from) return
    // What came while paused is still in the source's ring.
    const list = eventsRef.current
    const since = list.length ? list[list.length - 1].seq : 0
    void call('console:snapshot', from, Math.max(since, clearedRef.current)).then((got) => {
      if (sourceRef.current !== from) return
      const kept = got.filter((x) => x.seq > clearedRef.current)
      if (kept.length) latestRef.current = Math.max(latestRef.current, kept[kept.length - 1].seq)
      setEvents((l) => mergeEvents(l, kept))
    })
  }, [])

  const pause = useCallback(() => {
    pausedRef.current = true
    setPaused(true)
  }, [])

  // Clear empties the list through the newest event received, held ones too: only what comes after shows.
  const clear = useCallback(() => {
    const list = eventsRef.current
    const upTo = Math.max(latestRef.current, list.length ? list[list.length - 1].seq : 0)
    clearedRef.current = upTo
    setAfterSeq(upTo)
    setEvents([])
    setWaiting(0)
    setPicked(null)
    setDropped(0)
  }, [])

  const startRecording = (): void => {
    const from = sourceRef.current
    if (!from) return
    setRecordMenu(false)
    call('console:record', from, { includeText: withText }).then(setRecording, (e) => setError(errorMessage(e)))
  }
  // The box starts as the setting says each time the menu opens.
  const toggleCaptures = (): void => {
    if (captures) return setCaptures(null)
    setRecordMenu(false)
    void call('console:captures')
      .then(setCaptures)
      .catch((e) => setError(errorMessage(e)))
  }
  const toggleRecordMenu = (): void => {
    if (!recordMenu) setWithText(showText)
    setRecordMenu(!recordMenu)
  }
  const stopRecording = (): void => void call('console:stopRecording').then((r) => r && setRecording(r), (e) => setError(errorMessage(e)))

  const choices = useMemo(() => filterChoices(events), [events])
  const shown = useMemo(() => filterEvents(events, { provider, hiddenKinds, search, afterSeq }), [events, provider, hiddenKinds, search, afterSeq])
  const current = picked === null ? null : (shown.find((e) => e.seq === picked) ?? events.find((e) => e.seq === picked) ?? null)
  const groups = useMemo(() => sourceGroups(sources), [sources])
  const watched = sources.find((s) => s.id === source)

  // The list follows new events while it is scrolled to the bottom.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [shown])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === 'Escape' && document.activeElement !== searchRef.current) setPicked(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleKind = (k: string): void =>
    setHiddenKinds((h) => {
      const next = new Set(h)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  return (
    <div className="dc">
      <div className="dc-toolbar">
        <select className="dc-source" value={source} onChange={(e) => setSource(e.target.value)} aria-label={tr(M.source)}>
          <option value="">{tr(M.pickSource)}</option>
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {sourceOption(s)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <IconButton icon="refresh" title={tr(M.refresh)} onClick={loadSources} />
        <span className={cx('dc-live', !source ? 'off' : paused ? 'paused' : 'live')} role="status">
          <Icon name={!source ? 'circle-large-outline' : paused ? 'debug-pause' : 'circle-filled'} />
          {!source ? tr(M.notWatching) : paused ? tr(M.paused, { waiting }) : tr(M.live)}
        </span>
        <IconButton icon={paused ? 'debug-start' : 'debug-pause'} title={paused ? tr(M.resume) : tr(M.pause)} onClick={paused ? resume : pause} disabled={!source} className="dc-pause" />
        <IconButton icon="clear-all" title={tr(M.clear)} onClick={clear} disabled={!events.length && !waiting} className="dc-clear" />
        {recording?.recording ? (
          <button className="btn small dc-record-stop" onClick={stopRecording}>
            <Icon name="debug-stop" /> {tr(M.stopRecording)}
          </button>
        ) : (
          <span className="dc-record-wrap">
            <IconButton icon="record" title={tr(M.recordToFile)} onClick={toggleRecordMenu} disabled={!source} className="dc-record" expanded={recordMenu} />
            {recordMenu && (
              <div className="dc-record-menu" role="dialog" aria-label={tr(M.record)}>
                <div>{tr(M.recordWhat, { source: watched ? sourceOption({ ...watched, events: 0 }) : tr(M.thisSource) })}</div>
                <label className="flex dialog-check">
                  <input type="checkbox" className="checkbox" checked={withText} onChange={(e) => setWithText(e.target.checked)} /> {tr(M.includeText)}
                </label>
                <div className="dc-record-actions">
                  <button className="btn small subtle" onClick={() => setRecordMenu(false)}>
                    {tr(M.cancel)}
                  </button>
                  <button className="btn small primary dc-record-start" onClick={startRecording}>
                    {tr(M.startRecording)}
                  </button>
                </div>
              </div>
            )}
          </span>
        )}
        <span className="dc-record-wrap">
          <IconButton icon="history" title={tr(M.captures)} onClick={toggleCaptures} className="dc-captures" expanded={captures !== null} />
          {captures && (
            <div className="dc-record-menu dc-captures-menu" role="dialog" aria-label={tr(M.captures)}>
              {captures.length ? (
                captures.map((c) => (
                  <div key={c.name} className="dc-capture">
                    <div>{tr(M.captureRow, { trigger: triggerName(c.capture?.trigger ?? ''), agent: c.label, when: timeAgo(c.startedAt) })}</div>
                    <div className="faint dc-capture-what">
                      {whatOf(c.capture)} · {tr(M.captureEvents, { events: c.events })} ·{' '}
                      <a className="dc-show-capture" onClick={() => void call('console:showRecording', c.name).catch((e) => setError(errorMessage(e)))}>
                        {tr(M.showCapture)}
                      </a>
                    </div>
                  </div>
                ))
              ) : (
                <div className="faint">{tr(M.capturesNone)}</div>
              )}
            </div>
          )}
        </span>
        <span className="dc-sep" />
        <div className="dc-search">
          <Icon name="search" />
          <SearchInput ref={searchRef} value={search} onChange={setSearch} placeholder={tr(M.search)} aria-label={tr(M.searchLabel)} spellCheck={false} />
        </div>
        <select className="dc-provider" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label={tr(M.provider)}>
          <option value="">{tr(M.allProviders)}</option>
          {choices.providers.map((p) => (
            <option key={p} value={p}>
              {providerName(p as never) || p}
            </option>
          ))}
        </select>
      </div>
      {choices.kinds.length > 0 && (
        <div className="dc-kinds" role="group" aria-label={tr(M.eventTypes)}>
          {choices.kinds.map((k) => (
            <button key={k} className={cx('dc-kind', !hiddenKinds.has(k) && 'on')} aria-pressed={!hiddenKinds.has(k)} onClick={() => toggleKind(k)} data-kind={k}>
              {k}
            </button>
          ))}
        </div>
      )}
      {showText && (
        <div className="banner warn dc-unredacted" role="status">
          <Icon name="unlock" />
          <span>{Children.toArray(tRich<ReactNode>(M.unredacted, { b: bold }))}</span>
        </div>
      )}
      {error && <div className="dc-error">{error}</div>}
      <div className={cx('dc-body', current && 'with-detail')}>
        <div
          className="dc-list"
          ref={listRef}
          role="list"
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {!source && (
            <div className="dc-empty">{showText ? tr(M.emptyText) : tr(M.emptyRedacted)}</div>
          )}
          {source && !shown.length && <div className="dc-empty">{events.length ? tr(M.noMatch) : tr(M.waiting)}</div>}
          {shown.map((e) => (
            <div key={e.seq} role="listitem" className={cx('dc-row', picked === e.seq && 'picked')} data-kind={e.kind} data-seq={e.seq} onClick={() => setPicked(picked === e.seq ? null : e.seq)}>
              <span className="dc-time">{clockTime(e.at)}</span>
              <span className="dc-kind-tag">{e.kind}</span>
              <span className="dc-name">{e.name}</span>
              <span className="dc-summary" title={e.summary}>
                {e.summary}
              </span>
              {e.truncated && <Icon name="fold" title={tr(M.outlineTip)} />}
            </div>
          ))}
        </div>
        {current && (
          <div className="dc-detail">
            <div className="dc-detail-head">
              <span className="dc-name">{current.name}</span>
              <span className="dc-kind-tag">{current.kind}</span>
              {current.provider && <span className="dc-meta">{providerName(current.provider)}</span>}
              <span className="dc-meta">{clockTime(current.at)}</span>
              <span className="dc-meta">{tr(M.bytes, { n: current.bytes })}</span>
              {current.truncated && <span className="dc-meta">{tr(M.outline)}</span>}
              <span className="dc-sep" />
              <IconButton icon="close" title={tr(M.close)} onClick={() => setPicked(null)} />
            </div>
            <div className="dc-summary-full">{current.summary}</div>
            <div className="dc-sides">
              <section className="dc-side dc-raw">
                <h3>{tr(M.raw)}</h3>
                <Payload value={current.raw} />
              </section>
              <section className="dc-side dc-made">
                <h3>{tr(M.made)}</h3>
                <Payload value={current.made} />
              </section>
            </div>
          </div>
        )}
      </div>
      <div className="dc-status">
        <span>{shown.length === events.length ? tr(M.events, { n: events.length, cleared: afterSeq ? 'yes' : 'no' }) : tr(M.eventsOf, { shown: shown.length, n: events.length, cleared: afterSeq ? 'yes' : 'no' })}</span>
        {dropped > 0 && <span className="dc-dropped">{tr(M.dropped, { n: dropped })}</span>}
        {watched && <span>{watched.capturing ? tr(M.capturing) : tr(M.notCapturing)}</span>}
        {recording && (
          <span className={cx('dc-recording', recording.recording && 'on')}>
            {recording.recording ? (
              <>
                <Icon name="record" /> {tr(M.recording, { n: recording.events, name: recording.name, withText: recording.includeText ? 'yes' : 'no' })}
              </>
            ) : (
              <>
                {recording.reason === 'failed' ? (
                  <span className="dc-recording-failed">
                    <Icon name="error" /> {tr(M.failed, { n: recording.events, name: recording.name, error: recording.error ?? tr(M.notWritten) })}
                  </span>
                ) : (
                  tr(M.saved, { n: recording.events, name: recording.name, limit: recording.reason === 'limit' ? 'yes' : 'no' })
                )}
                {' · '}
                <a className="dc-show-recording" onClick={() => void call('console:showRecording', recording.name).catch((e) => setError(errorMessage(e)))}>
                  {tr(M.showInFolder)}
                </a>
              </>
            )}
          </span>
        )}
        <span className="dc-sep" />
        <span className={cx('dc-redaction', showText && 'unredacted')}>{showText ? tr(M.unredactedStatus) : tr(M.redactedStatus)}</span>
      </div>
    </div>
  )
}

/** A payload as a tree; a large node starts collapsed below the top level. */
function Payload({ value }: { value: unknown }) {
  if (value === undefined) return <div className="dc-none">{tr(M.nothing)}</div>
  return (
    <div className="dc-tree">
      <Node value={value} depth={0} />
    </div>
  )
}

function Node({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(() => startsOpen(value, depth))
  const label = name !== undefined && <span className="dc-key">{name}: </span>
  if (value === null || typeof value !== 'object') {
    return (
      <div className="dc-leaf">
        {label}
        <span className={cx('dc-val', `dc-${value === null ? 'null' : typeof value}`)}>{typeof value === 'string' ? JSON.stringify(value) : String(value)}</span>
      </div>
    )
  }
  const list = Array.isArray(value)
  const entries: [string, unknown][] = list ? value.map((v, i) => [String(i), v]) : Object.entries(value as Record<string, unknown>)
  const count = list ? `[${entries.length}]` : `{${entries.length}}`
  return (
    <div className="dc-branch">
      <div className="dc-toggle" onClick={() => setOpen(!open)} role="button" aria-expanded={open}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        {label}
        <span className="dc-count">{count}</span>
      </div>
      {open && (
        <div className="dc-children">
          {entries.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}
