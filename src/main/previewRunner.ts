// The Preview runner (HI-3614, design HI-3597 s8/s16/s21, SPEC §16.21): a place's dev server, on ports of its own taken
// from one range across the profile, its ownership of them checked before anyone is shown it. No Electron here: previewApp.ts
// gives it the app's ways (the process supervisor, the TCP table, git, a watcher), unit tests their own.
//
// - At most one preview per place (a folder): starting one where one runs gives it, unless its place's generation moved on
//   (a new lease), which stops the old one first.
// - Ports: never Combwork's own (the Agent API's, the hook server's), never one another preview holds, never one the TCP
//   table shows listened on or that can't be bound on 127.0.0.1 and ::1 at that moment. One, or two with hmrPort.
// - Started, it waits (startSeconds) for its port to be listened on, then checks every listener on it is in the server's
//   own process tree: a stranger fails the start, naming its pid; a tree listening on other ports only fails it, naming them.
// - Once it has exited, a preview is stopped for good: nothing ever reattaches to whoever takes its port after.
// - The stamp: the source at its start (its commit, and its files' tree when they differ), and when its files last changed.

import { randomBytes } from 'crypto'
import { previewRange, previewUrl, PREVIEW_ENV, sameSource, type PreviewConfig, type PreviewEnd, type PreviewPlace, type PreviewSource, type PreviewView } from '../shared/preview'

/** A socket listening on a TCP port, and its process. */
export interface Listener {
  port: number
  pid: number
}

/** A server started: its end, its process tree now, and how to end it. */
export interface Launched {
  /** Settles when its process has exited (its exit code, when it had one). */
  exited: Promise<{ code: number | null }>
  /** The process ids in its tree now; null when they can't be told. */
  tree: () => Promise<number[] | null>
  /** Ends its whole tree and waits until it has gone (or that can't be done). */
  stop: () => Promise<void>
}

export interface RunnerDeps {
  /** The first and last port of the range. */
  range: () => [number, number]
  /** Combwork's own ports now: never given out. */
  reserved: () => ReadonlySet<number>
  /** How long a server gets to listen on its port. */
  startSeconds: () => number
  /** Whether a port can be bound now on 127.0.0.1 and ::1. */
  bindFree: (port: number) => Promise<boolean>
  /** The TCP table's listening sockets now (off main's thread); null when it can't be read. */
  listeners: () => Promise<Listener[] | null>
  /** Starts the command in the folder with that environment added, its output in the log. */
  launch: (o: { id: string; place: PreviewPlace; projectPath: string; command: string; env: Record<string, string>; logPath: string | null }) => Promise<Launched | { problem: string }>
  /** The place's source now. */
  source: (folder: string) => Promise<PreviewSource>
  /** Watches the place's files; calls back on each change; returns its end. */
  watch: (folder: string, changed: () => void) => () => void
  /** Where its server's log goes, or null. */
  logPath: (id: string, place: PreviewPlace) => string | null
  /** How often a start looks at the TCP table (default 250 ms). */
  pollMs?: number
  now?: () => number
  log?: { info: (line: string) => void; warn: (line: string, e?: unknown) => void }
}

/** At most this many stopped previews are kept, for their why (the oldest forgotten first). */
export const KEPT_STOPPED = 50

interface Running {
  view: PreviewView
  config: PreviewConfig
  launched: Launched | null
  unwatch: (() => void) | null
  /** Its ports while they are held. */
  ports: number[]
  /** Settles once its start has ended, running or not. */
  started: Promise<PreviewView>
  /** Ending it now: its stop under way. */
  stopping: Promise<void> | null
}

const placeKey = (folder: string): string => folder.replace(/[\\/]+$/, '').toLowerCase()

/** A start's answer: the preview (running or not, with its why). */
export type StartAnswer = PreviewView

export class PreviewRunner {
  private readonly previews = new Map<string, Running>()
  /** Ports given to previews that haven't stopped yet. */
  private readonly held = new Set<number>()
  /** One port allocation at a time: two starts never take the same free port. */
  private allocating: Promise<unknown> = Promise.resolve()
  /** Starts per place, one at a time. */
  private readonly placeTurn = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<(v: PreviewView) => void>()

  constructor(private readonly deps: RunnerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /** Calls fn with each preview as it changes (started, running, stopped, its files changed); returns its removal. */
  onChange(fn: (v: PreviewView) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private changed(r: Running): void {
    const v = { ...r.view }
    for (const fn of this.listeners) {
      try {
        fn(v)
      } catch (e) {
        this.deps.log?.warn('a preview listener', e)
      }
    }
  }

  /** Every preview known (running ones and the last stopped one of each place), a project's only when given. */
  views(projectPath?: string): PreviewView[] {
    const all = [...this.previews.values()].map((r) => ({ ...r.view }))
    return projectPath ? all.filter((v) => v.projectPath.toLowerCase() === projectPath.toLowerCase()) : all
  }

  /** The preview of a place (its folder), running or the last one stopped. */
  at(folder: string): PreviewView | null {
    const r = [...this.previews.values()].find((x) => placeKey(x.view.place.folder) === placeKey(folder))
    return r ? { ...r.view } : null
  }

  /** The source of a preview's place now, and whether it differs from the source at its start. */
  async sourceNow(id: string): Promise<{ now: PreviewSource; changed: boolean } | null> {
    const r = this.previews.get(id)
    if (!r) return null
    const now = await this.deps.source(r.view.place.folder)
    return { now, changed: !sameSource(now, r.view.source) }
  }

  /**
   * Starts a place's preview, or gives the one running there (still starting: once it has). One in the same place under
   * another generation (its lease ended, a new one began) is stopped first.
   */
  start(projectPath: string, place: PreviewPlace, config: PreviewConfig): Promise<StartAnswer> {
    const key = placeKey(place.folder)
    const turn = (this.placeTurn.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.startNow(projectPath, place, config))
    this.placeTurn.set(key, turn)
    void turn.finally(() => {
      if (this.placeTurn.get(key) === turn) this.placeTurn.delete(key)
    }).catch(() => undefined)
    return turn
  }

  private async startNow(projectPath: string, place: PreviewPlace, config: PreviewConfig): Promise<StartAnswer> {
    const key = placeKey(place.folder)
    for (const r of [...this.previews.values()]) {
      if (placeKey(r.view.place.folder) !== key) continue
      if (r.view.state !== 'stopped' && r.view.place.generation === place.generation && r.view.projectPath.toLowerCase() === projectPath.toLowerCase()) return r.started
      if (r.view.state !== 'stopped') await this.stop(r.view.id, { kind: 'placeEnded' })
      // The last stopped one of this place makes way for the new one.
      this.previews.delete(r.view.id)
    }
    const id = `pv-${randomBytes(6).toString('hex')}`
    const view: PreviewView = { id, projectPath, place, state: 'starting', port: 0, hmrPort: null, url: null, startedAt: this.iso(), readyAt: null, stoppedAt: null, end: null, source: { commit: null, content: null }, changedAt: null, logPath: null }
    let resolveStarted!: (v: PreviewView) => void
    const r: Running = { view, config, launched: null, unwatch: null, ports: [], started: new Promise((res) => (resolveStarted = res)), stopping: null }
    this.previews.set(id, r)
    this.forgetOld()
    try {
      resolveStarted(await this.run(r))
    } catch (e) {
      this.deps.log?.warn('a preview start', e)
      this.finish(r, { kind: 'noStart', detail: e instanceof Error ? e.message : String(e) })
      resolveStarted({ ...r.view })
    }
    return r.started
  }

  private async run(r: Running): Promise<PreviewView> {
    const ports = await this.allocate(r.config.hmrPort ? 2 : 1)
    if (!ports.ok) {
      this.finish(r, { kind: 'noFreePort', first: ports.first, last: ports.last })
      return { ...r.view }
    }
    r.ports = ports.ports
    r.view.port = ports.ports[0]
    r.view.hmrPort = ports.ports[1] ?? null
    if (this.ended(r)) return this.release(r)
    // The stamp: the source at its start, and its files watched from now on.
    r.view.source = await this.deps.source(r.view.place.folder)
    if (this.ended(r)) return this.release(r)
    r.unwatch = this.deps.watch(r.view.place.folder, () => {
      if (r.view.state === 'stopped') return
      r.view.changedAt = this.iso()
      this.changed(r)
    })
    r.view.logPath = this.deps.logPath(r.view.id, r.view.place)
    const env: Record<string, string> = { [PREVIEW_ENV.port]: String(r.view.port), [PREVIEW_ENV.preview]: String(r.view.port), ...(r.view.hmrPort ? { [PREVIEW_ENV.hmr]: String(r.view.hmrPort) } : {}) }
    this.changed(r)
    const launched = await this.deps.launch({ id: r.view.id, place: r.view.place, projectPath: r.view.projectPath, command: r.config.command, env, logPath: r.view.logPath })
    if ('problem' in launched) {
      this.finish(r, { kind: 'noStart', detail: launched.problem })
      return { ...r.view }
    }
    if (this.ended(r)) {
      // Stopped while it was starting: its tree ended now it is known.
      await launched.stop().catch((e) => this.deps.log?.warn(`ending preview ${r.view.id}`, e))
      return { ...r.view }
    }
    r.launched = launched
    let exit: { code: number | null } | null = null
    void launched.exited.then((e) => {
      exit = e
      // Exited: stopped for good (never reattached to whoever takes its port next), its tree ended with it.
      if (r.view.state !== 'stopped') void this.stop(r.view.id, { kind: 'exited', code: e.code })
    })
    if (this.ended(r)) return { ...r.view }
    const verdict = await this.awaitListening(r, () => exit)
    if (r.view.state === 'stopped') return { ...r.view }
    if (verdict.ok) {
      r.view.state = 'running'
      r.view.readyAt = this.iso()
      r.view.url = previewUrl(r.view.port, r.config.path ?? '/')
      this.deps.log?.info(`Preview ${r.view.id} runs on port ${r.view.port}`)
      this.changed(r)
      return { ...r.view }
    }
    await this.stop(r.view.id, verdict.end)
    return { ...r.view }
  }

  /** Whether a preview has stopped meanwhile (a Stop, its place ending): its ports given back. */
  private ended(r: Running): boolean {
    return r.view.state === 'stopped'
  }

  private release(r: Running): PreviewView {
    for (const p of r.ports) this.held.delete(p)
    r.ports = []
    return { ...r.view }
  }

  /**
   * Waits for its port to be listened on, then checks who listens: every listener on it in the server's tree (ok); one
   * that isn't (a stranger, named by its pid); past startSeconds, the tree listening on other ports only, or nothing.
   */
  private async awaitListening(r: Running, exited: () => { code: number | null } | null): Promise<{ ok: true } | { ok: false; end: PreviewEnd }> {
    const seconds = this.deps.startSeconds()
    const until = this.now() + seconds * 1000
    const port = r.view.port
    let elsewhere: number[] = []
    for (;;) {
      if (r.view.state === 'stopped') return { ok: false, end: r.view.end ?? { kind: 'stopped' } }
      const gone = exited()
      if (gone) return { ok: false, end: { kind: 'exited', code: gone.code } }
      const table = await this.deps.listeners()
      const on = (table ?? []).filter((l) => l.port === port)
      if (on.length || this.now() >= until) {
        const tree = await r.launched!.tree()
        if (on.length) {
          const stranger = tree ? on.find((l) => !tree.includes(l.pid)) : on[0]
          if (!stranger) return { ok: true }
          // A listener not in its tree, or its tree unknown: never shown as the server's.
          return { ok: false, end: { kind: 'stranger', port, pid: stranger.pid } }
        }
        const ours = new Set(tree ?? [])
        elsewhere = [...new Set((table ?? []).filter((l) => ours.has(l.pid) && !r.ports.includes(l.port)).map((l) => l.port))].sort((a, b) => a - b)
        return { ok: false, end: elsewhere.length ? { kind: 'otherPort', port, listening: elsewhere.slice(0, 5) } : { kind: 'notListening', port, seconds } }
      }
      await new Promise((res) => setTimeout(res, this.deps.pollMs ?? 250))
    }
  }

  /**
   * Ports for a preview from the range: never Combwork's own, another preview's, one listened on or that can't be bound
   * now. One allocation at a time.
   */
  private allocate(count: number): Promise<{ ok: true; ports: number[] } | { ok: false; first: number; last: number }> {
    const next = this.allocating.then(async () => {
      const [first, last] = this.deps.range()
      const reserved = this.deps.reserved()
      const table = await this.deps.listeners()
      const listened = new Set((table ?? []).map((l) => l.port))
      const got: number[] = []
      for (let p = first; p <= last && got.length < count; p++) {
        if (reserved.has(p) || this.held.has(p) || listened.has(p)) continue
        if (!(await this.deps.bindFree(p))) continue
        got.push(p)
      }
      if (got.length < count) return { ok: false as const, first, last }
      for (const p of got) this.held.add(p)
      return { ok: true as const, ports: got }
    })
    this.allocating = next.catch(() => undefined)
    return next
  }

  /** Ends a preview: its tree ended and gone, its ports given back, its watcher closed. */
  stop(id: string, end: PreviewEnd = { kind: 'stopped' }): Promise<void> {
    const r = this.previews.get(id)
    if (!r) return Promise.resolve()
    if (r.stopping) return r.stopping
    if (r.view.state === 'stopped' && !r.launched) return Promise.resolve()
    r.stopping = (async () => {
      const launched = r.launched
      this.finish(r, end)
      if (launched) await launched.stop().catch((e) => this.deps.log?.warn(`ending preview ${id}`, e))
      // Its ports given back only once its tree has gone.
      this.release(r)
    })()
    return r.stopping
  }

  /** Marks it stopped with its why (once), its watcher closed. Its ports are released by stop, or at once with no server. */
  private finish(r: Running, end: PreviewEnd): void {
    if (r.view.state === 'stopped') return
    r.view.state = 'stopped'
    r.view.end = end
    r.view.url = null
    r.view.stoppedAt = this.iso()
    r.unwatch?.()
    r.unwatch = null
    if (!r.launched) this.release(r)
    this.deps.log?.info(`Preview ${r.view.id} stopped (${end.kind})`)
    this.changed(r)
  }

  /** Stops every preview that matches (a place's generation ended, a project closed, the switch turned off). */
  async stopWhere(match: (v: PreviewView) => boolean, end: PreviewEnd): Promise<number> {
    const due = [...this.previews.values()].filter((r) => r.view.state !== 'stopped' && match(r.view))
    await Promise.all(due.map((r) => this.stop(r.view.id, end)))
    return due.length
  }

  /** Forgets the oldest stopped previews past KEPT_STOPPED. */
  private forgetOld(): void {
    const stopped = [...this.previews.values()].filter((r) => r.view.state === 'stopped')
    for (const r of stopped.slice(0, Math.max(0, stopped.length - KEPT_STOPPED))) this.previews.delete(r.view.id)
  }

  /** The ports held now (tests). */
  heldPorts(): number[] {
    return [...this.held].sort((a, b) => a - b)
  }
}

/** The range from its setting: the first port as set, a development build's the next 1000 while left at its default. */
export function rangeOf(first: number, packaged: boolean, defaultFirst: number): [number, number] {
  const start = !packaged && first === defaultFirst ? first + 1000 : first
  return previewRange(start)
}
