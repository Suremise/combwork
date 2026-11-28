// The Preview tab (HI-3615, design HI-3597 s8/s16, SPEC §16.21): a place's running dev server, shown in Combwork's guarded
// view (main's PreviewGuard: its own partition, its filtering proxy, nothing of Combwork in it). The tab draws its header
// (the place, the stamp, Start, Stop, Reload, a hard reload, DevTools), the bar when the page tried to leave, and an area
// whose bounds main puts the native view at: shown while the area is, taken out when it isn't (another tab, another
// view: a native view would sit over them). Only while Settings → Advanced's Preview switch is on.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import { previewConfigOf, type PreviewEnd, type PreviewView } from '@shared/preview'
import { msg, tr } from '@shared/i18n'
import { PREVIEW_ENABLED } from '@shared/advanced'
import { cardRef } from '@shared/projectKeys'
import { useAdvancedValue } from '../advanced'
import * as actions from '../actions'
import { call } from '../api'
import { openProjectSettings } from '../store'
import { Icon, IconButton, InfoTip } from './ui'

const M = {
  projectFolder: msg({ id: 'preview.tab.projectFolder', defaultMessage: 'Project folder', description: "A place in the Preview tab's picker: the project's own folder (not a slot or a review copy)." }),
  place: msg({ id: 'preview.tab.place', defaultMessage: 'Place', description: "The Preview tab's picker's label: where the previewed dev server runs (the project folder, a slot, a review copy)." }),
  start: msg({ id: 'preview.tab.start', defaultMessage: 'Start', description: "A button (the Preview tab): starts the project's dev server in the chosen place." }),
  stop: msg({ id: 'preview.tab.stop', defaultMessage: 'Stop', description: 'A button (the Preview tab): stops the dev server.' }),
  reload: msg({ id: 'preview.tab.reload', defaultMessage: 'Reload', description: "A button (the Preview tab): reloads the previewed page." }),
  hardReload: msg({ id: 'preview.tab.hardReload', defaultMessage: 'Reload, bypassing the cache', description: "A button's tooltip (the Preview tab): reloads the previewed page, fetching everything again." }),
  devTools: msg({ id: 'preview.tab.devTools', defaultMessage: 'Developer Tools', description: "A button's tooltip (the Preview tab): opens the browser's developer tools for the previewed page (yours only, never an agent's)." }),
  restart: msg({ id: 'preview.tab.restart', defaultMessage: 'Restart', description: "A button beside \"stale\" (the Preview tab): stops the dev server and starts it again from the place's files now." }),
  stale: msg({ id: 'preview.tab.stale', defaultMessage: 'stale: its files changed after it started', description: "Beside the Preview tab's stamp: the place's files changed after the dev server started, so the page may not show them. Keep it short." }),
  starting: msg({ id: 'preview.tab.starting', defaultMessage: 'Starting on port {port}…', description: "The Preview tab while the dev server starts. {port} is a port number." }),
  starting0: msg({ id: 'preview.tab.startingNoPort', defaultMessage: 'Starting…', description: 'The Preview tab while the dev server starts, before it has a port.' }),
  notStarted: msg({ id: 'preview.tab.notStarted', defaultMessage: "The dev server isn't running here. Start runs {command}.", description: "The Preview tab before a start. {command} is the project's preview command (a command line: keep it as it is)." }),
  setUpTitle: msg({ id: 'preview.tab.setUpTitle', defaultMessage: 'Set up a preview', description: "The Preview tab's heading in a project with no preview command yet." }),
  setUp: msg({ id: 'preview.tab.setUp', defaultMessage: "Set the command that runs this project's dev server in Project Settings → Preview, and the Preview tab shows its page here.", description: "The Preview tab in a project with no preview command. Project Settings → Preview is a section: use its names as translated there." }),
  openSettings: msg({ id: 'preview.tab.openSettings', defaultMessage: 'Open Project Settings → Preview', description: "A button (the Preview tab, no command yet): opens that section. Project Settings → Preview: use its names as translated there." }),
  tried: msg({ id: 'preview.tab.tried', defaultMessage: 'The page tried to open {url}', description: "A bar over the Preview tab's page: the page tried to leave its own address (a link, a script, a new window). Combwork didn't follow it. {url} is the address." }),
  openInBrowser: msg({ id: 'preview.tab.openInBrowser', defaultMessage: 'Open in Browser', description: "A button on the bar \"The page tried to open …\" (the Preview tab): opens that address in the user's own web browser." }),
  dismiss: msg({ id: 'preview.tab.dismiss', defaultMessage: 'Dismiss', description: "A button's tooltip: closes the bar \"The page tried to open …\" (the Preview tab)." }),
  about: msg({ id: 'preview.tab.about', defaultMessage: "The page runs in a guarded view of its own: it reaches only its own dev server and the internet over https, never this computer's other services or your network, and asks for no permissions. The dev server's command is yours and runs with your rights. Turn the Preview off in Settings → Advanced (Preview: run projects' dev servers).", description: "The Preview tab's info tip: what the previewed page can and can't reach, and where to turn the Preview off. Settings → Advanced and the setting's title: use them as translated there." }),
  failed: msg({ id: 'preview.tab.failed', defaultMessage: "Couldn't do that in the Preview", description: "An error's title: a Preview tab action (start, stop, show, reload) failed." }),
  end: {
    stopped: msg({ id: 'preview.end.stopped', defaultMessage: 'Stopped.', description: "The Preview tab's line: the dev server was stopped." }),
    exited: msg({ id: 'preview.end.exited', defaultMessage: '{known, select, yes {The dev server exited (code {code}).} other {The dev server exited.}}', description: "The Preview tab's line: the dev server's process ended. known: yes when there is an exit code ({code}, a number): keep the select keys." }),
    placeEnded: msg({ id: 'preview.end.placeEnded', defaultMessage: "Stopped: its slot's lease or its review ended.", description: "The Preview tab's line: the place it ran in (a slot lent to a card, a review copy) was given back." }),
    projectClosed: msg({ id: 'preview.end.projectClosed', defaultMessage: 'Stopped: the project or its workspace closed.', description: "The Preview tab's line." }),
    turnedOff: msg({ id: 'preview.end.turnedOff', defaultMessage: 'Stopped: the Preview was turned off.', description: "The Preview tab's line." }),
    quitting: msg({ id: 'preview.end.quitting', defaultMessage: 'Stopped as Combwork quit.', description: "The Preview tab's line." }),
    noFreePort: msg({ id: 'preview.end.noFreePort', defaultMessage: 'No free preview port in {first}–{last}.', description: "The Preview tab's line: every port of the Preview's range is in use. {first} and {last} are port numbers." }),
    stranger: msg({ id: 'preview.end.stranger', defaultMessage: 'Port {port} is held by another program (process {pid}), so its page isn\'t shown.', description: "The Preview tab's line: another program listens on the dev server's port. {port} and {pid} are numbers." }),
    otherPort: msg({ id: 'preview.end.otherPort', defaultMessage: 'The server listens on {ports}, not on {port}: pass the port it is given, such as --port %PORT%.', description: "The Preview tab's line: the dev server ignored the port it was given (in PORT). {ports} lists the ports it listens on, {port} is the one it was given; --port %PORT% is a command-line example: keep it." }),
    notListening: msg({ id: 'preview.end.notListening', defaultMessage: 'Nothing listened on port {port} within {seconds} s.', description: "The Preview tab's line: the dev server didn't start listening in time. {port} is a port number, {seconds} a number of seconds." }),
    noStart: msg({ id: 'preview.end.noStart', defaultMessage: "The dev server couldn't start: {detail}", description: "The Preview tab's line. {detail} is why, in English as the log has it." }),
    placeHeld: msg({ id: 'preview.end.placeHeld', defaultMessage: "An earlier dev server here couldn't be ended, so nothing starts here until it is.", description: "The Preview tab's line: a previous server in this place couldn't be proved stopped." }),
    guardStopped: msg({ id: 'preview.end.guardStopped', defaultMessage: 'Stopped: network guard stopped.', description: "The Preview tab's line: the Preview's network guard (the filtering proxy every request of the page goes through) stopped, so the page was closed." })
  }
}

/** A preview's end in the window's words. */
function endText(e: PreviewEnd): string {
  switch (e.kind) {
    case 'exited':
      return tr(M.end.exited, { known: e.code === null ? 'no' : 'yes', code: String(e.code ?? '') })
    case 'noFreePort':
      return tr(M.end.noFreePort, { first: String(e.first), last: String(e.last) })
    case 'stranger':
      return tr(M.end.stranger, { port: String(e.port), pid: String(e.pid) })
    case 'otherPort':
      return tr(M.end.otherPort, { ports: e.listening.join(', '), port: String(e.port) })
    case 'notListening':
      return tr(M.end.notListening, { port: String(e.port), seconds: String(e.seconds) })
    case 'noStart':
      return tr(M.end.noStart, { detail: e.detail })
    default:
      return tr(M.end[e.kind])
  }
}

const sameFolder = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/** The stamp: the place, its card (a slot's), and its source at start (commit, and its files' tree when they differed). */
function stampOf(v: PreviewView, card: number | null): string {
  const parts = [v.place.kind === 'project' ? tr(M.projectFolder) : v.place.name]
  if (card !== null) parts.push(cardRef(card))
  const s = v.source
  if (s.kind === 'clean') parts.push(s.commit.slice(0, 7))
  // agent-protocol: git's ids and the stamp's own word, as the agents' replies (HI-3616) have them
  else if (s.kind === 'dirty') parts.push(`${s.commit ? s.commit.slice(0, 7) : '-'} + tree ${s.content.slice(0, 7)}`) // i18n-ignore: git's ids and the stamp's own word, as the agents' replies have them
  return parts.join(' · ')
}

export function PreviewTab({ project }: { project: ProjectInfo }) {
  const on = useAdvancedValue<boolean>(PREVIEW_ENABLED) === true
  const cfg = previewConfigOf(project.config.preview)
  const [views, setViews] = useState<PreviewView[]>([])
  const [folder, setFolder] = useState(project.path)
  const [cards, setCards] = useState<Record<string, number>>({})
  const [tried, setTried] = useState<{ id: string; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const area = useRef<HTMLDivElement>(null)
  const load = useCallback(() => {
    if (!on) return
    call('preview:list', project.path).then(setViews, () => setViews([]))
    call('slots:list', project.path).then(
      (slots) => setCards(Object.fromEntries(slots.filter((s) => s.lease?.card !== null && s.lease?.card !== undefined).map((s) => [s.folder.toLowerCase(), s.lease!.card as number]))),
      () => undefined
    )
  }, [on, project.path])
  useEffect(() => {
    load()
    return window.combwork.onEvent((e) => {
      if (e.type === 'preview-changed' && e.preview.projectPath.toLowerCase() === project.path.toLowerCase()) load()
      else if (e.type === 'preview-tried' && e.projectPath.toLowerCase() === project.path.toLowerCase()) setTried({ id: e.id, url: e.url })
    })
  }, [load, project.path])
  const here = views.filter((v) => sameFolder(v.place.folder, folder))
  const v = here.find((x) => x.state !== 'stopped') ?? here[here.length - 1] ?? null
  const running = v?.state === 'running' ? v : null
  const runningId = running?.id ?? null
  // The page shown at the area's bounds (in the window's CSS pixels; main scales them by its zoom) while the area is
  // shown, taken out when it has no size (another tab or view, the window minimised) and when this goes.
  useEffect(() => {
    const el = area.current
    if (!runningId || !el) return
    const id = runningId
    let shownNow = false
    const place = (): void => {
      const r = el.getBoundingClientRect()
      const visible = r.width > 0 && r.height > 0 && el.offsetParent !== null
      const bounds = { x: r.left, y: r.top, width: r.width, height: r.height }
      if (visible && !shownNow) {
        shownNow = true
        void call('preview:show', project.path, id, bounds).catch((err: unknown) => {
          shownNow = false
          void actions.attempt(tr(M.failed), () => Promise.reject(err))
        })
      } else if (visible) void call('preview:place', id, bounds).catch(() => undefined)
      else if (shownNow) {
        shownNow = false
        void call('preview:hide', id).catch(() => undefined)
      }
    }
    const ro = new ResizeObserver(place)
    ro.observe(el)
    window.addEventListener('resize', place)
    place()
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
      if (shownNow) void call('preview:hide', id).catch(() => undefined)
    }
  }, [runningId, project.path])
  if (!on) return null
  if (!cfg)
    return (
      <div className="preview-tab preview-setup" data-preview="setup">
        <h2>{tr(M.setUpTitle)}</h2>
        <p>{tr(M.setUp)}</p>
        <button
          className="btn"
          data-action="preview-settings"
          onClick={() => openProjectSettings(project.path, 'preview')}
        >
          <Icon name="settings-gear" /> {tr(M.openSettings)}
        </button>
      </div>
    )
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    await actions.attempt(tr(M.failed), fn)
    setBusy(false)
    load()
  }
  const places = [{ folder: project.path, label: tr(M.projectFolder) }, ...views.filter((x) => x.state !== 'stopped' && x.place.kind !== 'project').map((x) => ({ folder: x.place.folder, label: x.place.name }))]
  const live = v && v.state !== 'stopped'
  const stale = !!running?.changedAt
  const barFor = tried && v && tried.id === v.id ? tried : null
  return (
    <div className="preview-tab" data-preview-state={v?.state ?? 'none'}>
      <div className="preview-header">
        <label className="preview-place">
          <span className="faint">{tr(M.place)}</span>
          <select className="select" data-preview="place" value={places.some((p) => sameFolder(p.folder, folder)) ? folder : project.path} onChange={(e) => setFolder(e.target.value)}>
            {places.map((p) => (
              <option key={p.folder} value={p.folder}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {v && v.state !== 'stopped' && (
          <span className="preview-stamp mono" data-preview="stamp">
            {stampOf(v, cards[v.place.folder.toLowerCase()] ?? null)}
          </span>
        )}
        {stale && (
          <span className="preview-stale" data-preview="stale">
            {tr(M.stale)}{' '}
            <button
              className="btn small subtle"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await call('preview:stop', project.path, folder)
                  await call('preview:start', project.path, folder)
                })
              }
            >
              {tr(M.restart)}
            </button>
          </span>
        )}
        <span className="grow" />
        {!live ? (
          <button className="btn" data-action="preview-start" disabled={busy} onClick={() => void act(() => call('preview:start', project.path, folder))}>
            <Icon name="play" /> {tr(M.start)}
          </button>
        ) : (
          <button className="btn" data-action="preview-stop" disabled={busy} onClick={() => void act(() => call('preview:stop', project.path, folder))}>
            <Icon name="debug-stop" /> {tr(M.stop)}
          </button>
        )}
        <IconButton icon="refresh" title={tr(M.reload)} disabled={!running} onClick={() => running && void act(() => call('preview:reload', project.path, running.id, false))} />
        <IconButton icon="sync" title={tr(M.hardReload)} disabled={!running} onClick={() => running && void act(() => call('preview:reload', project.path, running.id, true))} />
        <IconButton icon="tools" title={tr(M.devTools)} disabled={!running} onClick={() => running && void call('preview:devtools', project.path, running.id)} />
        <InfoTip text={tr(M.about)} />
      </div>
      {barFor && (
        <div className="preview-tried banner" data-preview="tried">
          <Icon name="link-external" /> <span className="grow">{tr(M.tried, { url: barFor.url })}</span>
          <button className="btn small" data-action="preview-open-browser" onClick={() => void call('preview:openTried', barFor.id, barFor.url).finally(() => setTried(null))}>
            {tr(M.openInBrowser)}
          </button>
          <IconButton icon="close" title={tr(M.dismiss)} onClick={() => setTried(null)} />
        </div>
      )}
      {!running && (
        <div className="preview-status" data-preview="status">
          {v?.state === 'starting' ? (v.port ? tr(M.starting, { port: String(v.port) }) : tr(M.starting0)) : v?.end ? endText(v.end) : tr(M.notStarted, { command: cfg.command })}
        </div>
      )}
      <div className="preview-area" ref={area} data-preview="area" />
    </div>
  )
}
