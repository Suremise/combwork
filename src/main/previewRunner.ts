// The Preview runner (HI-3614, design HI-3597 s8/s16/s21, SPEC §16.21): a place's dev server, on ports of its own taken
// from one range across the profile, its ownership of them checked before anyone is shown it. No Electron here: previewApp.ts
// gives it the app's ways (the process supervisor, the TCP table, git, a watcher), unit tests their own.
//
// - At most one preview per place (a folder): starting one where one runs gives it, unless its place's generation moved on
//   (a new lease), which stops the old one first, awaited, before the new one does anything there.
// - One lifetime per preview (HI-3614 round 1): a start is registered at once, with its owner (the app's workspace), so a
//   stop by owner, place or switch finds it whatever it is doing; it is admitted again (`admit`) just before its server
//   starts; and a stop is over only once a launch still under way has finished and its server's tree has gone. Its ports
//   are given back only once that is proved; otherwise they stay held.
// - Ports: never Combwork's own (the Agent API's, the hook server's), never one another preview holds, never one the TCP
//   table shows listened on or that can't be bound on 127.0.0.1 and ::1 at that moment. One, or two with hmrPort.
// - Started, it waits (startSeconds) for its port to be listened on; every listener on any of its ports (the hot reload
//   one too) must be in the server's own process tree: a stranger fails the start, naming its pid and port; a tree
//   listening on other ports only fails it, naming them. checkOwnership looks again later (a hot reload socket that
//   listens only once a page connects), stopping it at a stranger.
// - Once it has exited, a preview is stopped for good: nothing ever reattaches to whoever takes its port after.
// - The stamp: the source at its start (previewSource.ts), and when its files last changed.

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
  /** Ends its whole tree and waits until it has gone: true once that is proved, false when it can't be (asked again later, it tries again). */
  stop: () => Promise<boolean>
  /** Its job on the process supervisor, by name: what a pool keeps on the slot or copy while its end isn't proved. */
  job?: string
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

/** A start's own: who it is for (the app's workspace), and whether it may still start (null: yes; else why not). */
export interface StartOptions {
  owner?: string
  admit?: () => Promise<PreviewEnd | null>
}

/** At most this many stopped previews are kept, for their why (the oldest forgotten first). */
export const KEPT_STOPPED = 50

interface Running {
  view: PreviewView
  config: PreviewConfig
  owner: string | null
  launched: Launched | null
  /** Its launch while it is under way (a stop waits for it). */
  launching: Promise<Launched | { problem: string }> | null
  unwatch: (() => void) | null
  /** Its ports while they are held. */
  ports: number[]
  /** Settles once its start has ended, running or not. */
  started: Promise<PreviewView>
  /** Ending it now: its stop under way, or over. */
  stopping: Promise<void> | null
  /** Its server, once known to its stop (a launch it awaited included). */
  server: Launched | null
  /**
   * Its server's end couldn't be proved (HI-3614 round 2): its place stays held. Its ports stay taken, no other preview
   * starts there until a later try proves it, and it is never forgotten meanwhile.
   */
  unproved: boolean
}

const placeKey = (folder: string): string => folder.replace(/[\\/]+$/, '').toLowerCase()

export class PreviewRunner {
  private readonly previews = new Map<string, Running>()
  /** Ports given to previews and not yet proved free of them. */
  private readonly held = new Set<number>()
  /** One port allocation at a time: two starts never take the same free port. */
  private allocating: Promise<unknown> = Promise.resolve()
  /** Each place's starts, one after another. */
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

  /** Every preview known (live ones and the last stopped one of each place), a project's only when given. */
  views(projectPath?: string): PreviewView[] {
    const all = [...this.previews.values()].map((r) => ({ ...r.view }))
    return projectPath ? all.filter((v) => v.projectPath.toLowerCase() === projectPath.toLowerCase()) : all
  }

  /** The preview of a place (its folder): the live one, else the last one stopped. */
  at(folder: string): PreviewView | null {
    const here = [...this.previews.values()].filter((x) => placeKey(x.view.place.folder) === placeKey(folder))
    const r = here.find((x) => x.view.state !== 'stopped') ?? here[here.length - 1]
    return r ? { ...r.view } : null
  }

  /** The source of a preview's place now, and whether it differs from the source at its start (null: can't be told). */
  async sourceNow(id: string): Promise<{ now: PreviewSource; changed: boolean | null } | null> {
    const r = this.previews.get(id)
    if (!r) return null
    const now = await this.deps.source(r.view.place.folder)
    const same = sameSource(now, r.view.source)
    return { now, changed: same === null ? null : !same }
  }

  /**
   * Starts a place's preview, or gives the one live there (still starting: once it has). It is registered at once, with
   * its owner; its work waits for the place's earlier starts and stops (another generation's preview is stopped first).
   */
  start(projectPath: string, place: PreviewPlace, config: PreviewConfig, opts: StartOptions = {}): Promise<PreviewView> {
    const key = placeKey(place.folder)
    for (const r of this.previews.values()) {
      if (placeKey(r.view.place.folder) === key && r.view.state !== 'stopped' && !r.stopping && r.view.place.generation === place.generation && r.view.projectPath.toLowerCase() === projectPath.toLowerCase()) return r.started
    }
    const id = `pv-${randomBytes(6).toString('hex')}`
    const view: PreviewView = { id, projectPath, place, state: 'starting', port: 0, hmrPort: null, url: null, startedAt: this.iso(), readyAt: null, stoppedAt: null, end: null, source: { kind: 'unknown', commit: null, why: 'not read yet' }, changedAt: null, logPath: null, held: false } // i18n-ignore: a stamp's reason, until it is read
    const r: Running = { view, config, owner: opts.owner ?? null, launched: null, launching: null, unwatch: null, ports: [], started: Promise.resolve(view), stopping: null, server: null, unproved: false }
    this.previews.set(id, r)
    this.forgetOld()
    const turn = (this.placeTurn.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      // Whatever else is at this place stops first, and is gone, before this one does anything there. One whose server
      // can't be proved ended (tried again now) keeps the place: this start is refused, and nothing runs beside it.
      for (const o of [...this.previews.values()]) {
        if (o === r || placeKey(o.view.place.folder) !== key) continue
        await this.stop(o.view.id, { kind: 'placeEnded' })
        if (o.unproved && !(await this.retryHeld(o))) {
          await this.stop(r.view.id, { kind: 'placeHeld', preview: o.view.id })
          return { ...r.view }
        }
        this.previews.delete(o.view.id)
      }
      try {
        await this.run(r, opts.admit)
      } catch (e) {
        this.deps.log?.warn('a preview start', e)
        await this.stop(r.view.id, { kind: 'noStart', detail: e instanceof Error ? e.message : String(e) })
      }
      return { ...r.view }
    })
    r.started = turn
    this.placeTurn.set(key, turn)
    void turn.finally(() => {
      if (this.placeTurn.get(key) === turn) this.placeTurn.delete(key)
    }).catch(() => undefined)
    return turn
  }

  private async run(r: Running, admit?: () => Promise<PreviewEnd | null>): Promise<void> {
    const admitted = async (): Promise<boolean> => {
      if (this.ended(r)) return false
      const no = admit ? await admit() : null
      if (no && !this.ended(r)) await this.stop(r.view.id, no)
      return !this.ended(r)
    }
    if (!(await admitted())) return
    const ports = await this.allocate(r.config.hmrPort ? 2 : 1)
    if (!ports.ok) return void (await this.stop(r.view.id, { kind: 'noFreePort', first: ports.first, last: ports.last }))
    if (this.ended(r)) {
      for (const p of ports.ports) this.held.delete(p)
      return
    }
    r.ports = ports.ports
    r.view.port = ports.ports[0]
    r.view.hmrPort = ports.ports[1] ?? null
    // The stamp: the source at its start, and its files watched from now on.
    r.view.source = await this.deps.source(r.view.place.folder)
    if (this.ended(r)) return
    r.unwatch = this.deps.watch(r.view.place.folder, () => {
      if (r.view.state === 'stopped') return
      r.view.changedAt = this.iso()
      this.changed(r)
    })
    r.view.logPath = this.deps.logPath(r.view.id, r.view.place)
    this.changed(r)
    // Admitted again just before its server starts: the switch, its workspace, its place's generation.
    if (!(await admitted())) return
    const env: Record<string, string> = { [PREVIEW_ENV.port]: String(r.view.port), [PREVIEW_ENV.preview]: String(r.view.port), ...(r.view.hmrPort ? { [PREVIEW_ENV.hmr]: String(r.view.hmrPort) } : {}) }
    r.launching = this.deps.launch({ id: r.view.id, place: r.view.place, projectPath: r.view.projectPath, command: r.config.command, env, logPath: r.view.logPath })
    const launched = await r.launching
    if ('problem' in launched) {
      r.launching = null
      return void (await this.stop(r.view.id, { kind: 'noStart', detail: launched.problem }))
    }
    r.launched = launched
    r.launching = null
    // Stopped while it launched: that stop ends this server (it awaited the launch), and is over only once it has.
    if (this.ended(r)) return
    let exit: { code: number | null } | null = null
    void launched.exited.then((e) => {
      exit = e
      // Exited: stopped for good (never reattached to whoever takes its port next), its tree ended with it.
      if (r.view.state !== 'stopped') void this.stop(r.view.id, { kind: 'exited', code: e.code })
    })
    const verdict = await this.awaitListening(r, () => exit)
    if (this.ended(r)) return
    if (verdict.ok) {
      r.view.state = 'running'
      r.view.readyAt = this.iso()
      r.view.url = previewUrl(r.view.port, r.config.path ?? '/')
      this.deps.log?.info(`Preview ${r.view.id} runs on port ${r.view.port}`)
      this.changed(r)
      return
    }
    await this.stop(r.view.id, verdict.end)
  }

  /** Whether a preview has stopped (a Stop, its place, owner or switch ending). */
  private ended(r: Running): boolean {
    return r.view.state === 'stopped'
  }

  /**
   * Who listens on its ports now: every listener on any of them in its tree (ok, `listening` saying whether its own port
   * is listened on), or the first that isn't (a stranger; its tree unknown counts as a stranger).
   */
  private async owners(r: Running, table: Listener[]): Promise<{ ok: true; listening: boolean } | { ok: false; end: PreviewEnd }> {
    const mine = table.filter((l) => r.ports.includes(l.port))
    if (!mine.length) return { ok: true, listening: false }
    const tree = await r.launched!.tree()
    const stranger = mine.find((l) => !tree || !tree.includes(l.pid))
    if (stranger) return { ok: false, end: { kind: 'stranger', port: stranger.port, pid: stranger.pid } }
    return { ok: true, listening: mine.some((l) => l.port === r.view.port) }
  }

  /**
   * Waits for its own port to be listened on, then checks who listens on its ports; past startSeconds, the tree listening
   * on other ports only, or nothing.
   */
  private async awaitListening(r: Running, exited: () => { code: number | null } | null): Promise<{ ok: true } | { ok: false; end: PreviewEnd }> {
    const seconds = this.deps.startSeconds()
    const until = this.now() + seconds * 1000
    for (;;) {
      if (this.ended(r)) return { ok: false, end: r.view.end ?? { kind: 'stopped' } }
      const gone = exited()
      if (gone) return { ok: false, end: { kind: 'exited', code: gone.code } }
      const table = (await this.deps.listeners()) ?? []
      const who = await this.owners(r, table)
      if (!who.ok) return who
      if (who.listening) return { ok: true }
      if (this.now() >= until) {
        const ours = new Set((await r.launched!.tree()) ?? [])
        const elsewhere = [...new Set(table.filter((l) => ours.has(l.pid) && !r.ports.includes(l.port)).map((l) => l.port))].sort((a, b) => a - b)
        return { ok: false, end: elsewhere.length ? { kind: 'otherPort', port: r.view.port, listening: elsewhere.slice(0, 5) } : { kind: 'notListening', port: r.view.port, seconds } }
      }
      await new Promise((res) => setTimeout(res, this.deps.pollMs ?? 250))
    }
  }

  /**
   * Checks a running preview's ports again (before its page is loaded: a hot reload socket listens later): a stranger on
   * any of them stops it. Its answer: ok, or why not (stopped, or not listening on its own port now).
   */
  async checkOwnership(id: string): Promise<{ ok: true } | { ok: false; end: PreviewEnd }> {
    const r = this.previews.get(id)
    if (!r || r.view.state !== 'running' || !r.launched) return { ok: false, end: r?.view.end ?? { kind: 'stopped' } }
    const table = await this.deps.listeners()
    if (!table) return { ok: false, end: { kind: 'notListening', port: r.view.port, seconds: 0 } }
    const who = await this.owners(r, table)
    if (this.ended(r)) return { ok: false, end: r.view.end ?? { kind: 'stopped' } }
    if (!who.ok) {
      await this.stop(r.view.id, who.end)
      return who
    }
    return who.listening ? { ok: true } : { ok: false, end: { kind: 'notListening', port: r.view.port, seconds: 0 } }
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

  /**
   * Ends a preview: marked stopped at once (nothing more of its start happens), then a launch still under way awaited and
   * its server's tree ended. Over once that is done. Its ports are given back only when its tree's end is proved (or it
   * never had a server); otherwise they stay held, so no other preview is given them.
   */
  stop(id: string, end: PreviewEnd = { kind: 'stopped' }): Promise<void> {
    const r = this.previews.get(id)
    if (!r) return Promise.resolve()
    if (r.stopping) return r.stopping
    if (r.view.state === 'stopped' && !r.launched && !r.launching) return Promise.resolve()
    r.stopping = (async () => {
      // Marked stopped first (below, before this runs on), so nothing more of its start happens.
      await Promise.resolve()
      let server = r.launched
      if (!server && r.launching) {
        const got = await r.launching.catch(() => null)
        server = got && !('problem' in got) ? got : null
      }
      r.server = server
      const proved = server ? await server.stop().catch(() => false) : true
      if (proved) this.release(r)
      else this.hold(r)
    })()
    this.finish(r, end)
    return r.stopping
  }

  /** Its server's end not proved: its place and ports stay held until a later try proves it (retryHeld). */
  private hold(r: Running): void {
    r.unproved = true
    r.view.held = true
    this.deps.log?.warn(`Preview ${r.view.id}'s server could not be proved ended: its place and its ports ${r.ports.join(', ')} stay held`)
    this.changed(r)
  }

  /** Tries again to end a held preview's server: true once proved (its place and ports then given back). */
  private async retryHeld(r: Running): Promise<boolean> {
    if (!r.unproved) return true
    const proved = r.server ? await r.server.stop().catch(() => false) : true
    if (!proved) return false
    r.unproved = false
    r.view.held = false
    this.release(r)
    this.deps.log?.info(`Preview ${r.view.id}'s server is now proved ended: its place is free`)
    this.changed(r)
    return true
  }

  private release(r: Running): void {
    for (const p of r.ports) this.held.delete(p)
    r.ports = []
  }

  /** Marks it stopped with its why (once), its watcher closed; its ports go back at once when it never had a server. */
  private finish(r: Running, end: PreviewEnd): void {
    if (r.view.state === 'stopped') return
    r.view.state = 'stopped'
    r.view.end = end
    r.view.url = null
    r.view.stoppedAt = this.iso()
    r.unwatch?.()
    r.unwatch = null
    if (!r.launched && !r.launching) this.release(r)
    this.deps.log?.info(`Preview ${r.view.id} stopped (${end.kind})`)
    this.changed(r)
  }

  /**
   * Stops every preview that matches (a place's generation ended, a project or a workspace closed, the switch turned off),
   * starting ones included, and waits until each stop is over.
   */
  async stopWhere(match: (v: PreviewView, owner: string | null) => boolean, end: PreviewEnd): Promise<{ stopped: number; held: string[] }> {
    const due = [...this.previews.values()].filter((r) => (r.view.state !== 'stopped' || r.stopping) && match(r.view, r.owner))
    await Promise.all(due.map((r) => this.stop(r.view.id, end)))
    // Those whose server's end isn't proved (now, or before): their jobs, for whoever must keep the place held.
    const held = [...this.previews.values()].filter((r) => r.unproved && match(r.view, r.owner)).map((r) => r.server?.job ?? r.view.id)
    return { stopped: due.filter((r) => r.view.end === end).length, held }
  }

  /** Forgets the oldest stopped previews past KEPT_STOPPED (only those whose stop is over). */
  private forgetOld(): void {
    const stopped = [...this.previews.values()].filter((r) => r.view.state === 'stopped' && !r.launching && !r.unproved)
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
