import { msg } from '../shared/i18n'
import { hiveError } from './combworkError'
import { ConsoleRing, hiveSourceId, makeEvent, sessionSourceId, type CapturedEvent, type ConsoleEvent } from '../shared/devConsole'

/**
 * The developer console's capture (#636): rings of events per source, kept only while the console is open on them
 * (#366 decision 4). A source is captured from its first subscriber to its last: before and after, `capture()` returns
 * at once without building its event, and no ring is kept, so a Hive with no console open does no work and holds no
 * memory for it.
 *
 * Subscribers are the console's windows (and, with #638, their recordings). Readers (agents' and the Assistant's hive
 * tools) subscribe to nothing: they read what an open console is capturing, and are told when it isn't. Every event is
 * redacted as it is kept (shared/devConsole.ts); a subscriber that opted into text (the user's own recording, or a window
 * while Settings → Advanced → Developer console: show text is on, #699) is sent a second copy with text kept, and only it.
 * While a source has such a subscriber, those copies are kept in a ring of their own too, which only text subscribers
 * read (a window's backlog after a pause); readers only ever get the redacted ring.
 *
 * The flight recorder (#698) is the one exception to "nothing while nobody watches": while one of its triggers is on, it
 * sets which sources it keeps (`setFlight`, every agent's session) and each of them is captured whether a console watches
 * it or not, into a small ring of its own (redacted, never text) that only the recorder reads. With every trigger off it
 * keeps nothing, and capture is free again.
 */

/** At most this many sources per subscriber, and this many subscribers: each holds rings while it lasts. */
export const MAX_SOURCES = 40
export const MAX_SUBSCRIBERS = 50
/** Events waiting to be sent to one subscriber, at most (by count and bytes): past either, the oldest are dropped and counted. */
export const QUEUE_MAX_EVENTS = 500
export const QUEUE_MAX_BYTES = 1024 * 1024
/** The flight recorder's ring per source (#698): smaller than a console's, kept for at most this many sources (the least recently written go first). */
export const FLIGHT_RING_EVENTS = 200
export const FLIGHT_RING_BYTES = 256 * 1024
export const FLIGHT_MAX_SOURCES = 100

export interface ConsoleSubscription {
  /** Live events as they are kept, batched after the current task; `dropped`: how many didn't fit its queue since the last batch. */
  deliver?: (events: ConsoleEvent[], dropped: number) => void
  /** Keep text in the events it is sent (the user's own recording, or a window while the setting is on; never a reader). */
  includeText?: boolean
}

interface Subscriber extends ConsoleSubscription {
  sources: Set<string>
  queue: ConsoleEvent[]
  queueBytes: number
  dropped: number
}

export class DevConsole {
  private rings = new Map<string, ConsoleRing>()
  private subs = new Map<string, Subscriber>()
  /** Sources with a subscriber that keeps text, by how many such subscribers. */
  private textual = new Map<string, number>()
  /** The events with text of each source in `textual`, kept from its first text subscriber to its last. */
  private textRings = new Map<string, ConsoleRing>()
  private seq = 0
  private flushing = false
  /** The flight recorder's sources (#698): kept whether watched or not, while it is on. */
  private flight: ((source: string) => boolean) | null = null
  private flightKept: ((e: ConsoleEvent) => void) | null = null
  private flightRings = new Map<string, ConsoleRing>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether a source is being captured: callers ask before building anything (zero cost when nobody watches). */
  capturing(source: string): boolean {
    return this.rings.has(source) || !!this.flight?.(source)
  }

  /** The sources being captured whose ids start so ("hive:" for every workspace's Hive events). */
  capturedLike(prefix: string): string[] {
    return [...this.rings.keys()].filter((s) => s.startsWith(prefix))
  }

  /**
   * Keeps an event in each of `sources` being captured (null entries are skipped): `build` runs only if one is, once,
   * and may return null to keep nothing. A capture point never fails its caller.
   */
  capture(sources: (string | null | undefined)[], build: () => CapturedEvent | null): void {
    if (!this.rings.size && !this.flight) return
    const flying = (s: string): boolean => !!this.flight?.(s)
    const live = [...new Set(sources)].filter((s): s is string => !!s && (this.rings.has(s) || flying(s)))
    if (!live.length) return
    let c: CapturedEvent | null
    try {
      c = build()
    } catch {
      return
    }
    if (!c) return
    const at = new Date(this.now()).toISOString()
    for (const source of live) {
      const e = makeEvent(++this.seq, at, source, c)
      if (flying(source)) this.keepFlight(e)
      const ring = this.rings.get(source)
      if (!ring) continue
      ring.push(e)
      const withText = this.textual.get(source) ? makeEvent(e.seq, at, source, c, { includeText: true }) : null
      if (withText) this.textRings.get(source)?.push(withText)
      for (const sub of this.subs.values()) if (sub.deliver && sub.sources.has(source)) this.enqueue(sub, sub.includeText && withText ? withText : e)
    }
    this.scheduleFlush()
  }

  /**
   * Turns the flight recorder's capture on (`keep`: the sources it keeps, whether watched or not; `kept`: told of each
   * event it keeps) or off (null: its rings go, and capture is free again where nobody watches).
   */
  setFlight(keep: ((source: string) => boolean) | null, kept: ((e: ConsoleEvent) => void) | null = null): void {
    this.flight = keep
    this.flightKept = keep ? kept : null
    if (!keep) this.flightRings.clear()
  }

  /** The flight recorder's events of a source, oldest first (redacted). */
  flightEvents(source: string): ConsoleEvent[] {
    return this.flightRings.get(source)?.all() ?? []
  }

  /** Keeps an event in its source's flight ring (the least recently written source goes past the bound), and says so. */
  private keepFlight(e: ConsoleEvent): void {
    let ring = this.flightRings.get(e.source)
    if (ring) this.flightRings.delete(e.source)
    else ring = new ConsoleRing(FLIGHT_RING_EVENTS, FLIGHT_RING_BYTES)
    this.flightRings.set(e.source, ring)
    ring.push(e)
    while (this.flightRings.size > FLIGHT_MAX_SOURCES) this.flightRings.delete(this.flightRings.keys().next().value!)
    try {
      this.flightKept?.(e)
    } catch {
      // A capture point never fails its caller.
    }
  }

  /**
   * Starts or changes a subscription: `sources` replaces its list (capture starts for the new ones and stops for those
   * no other subscriber watches). Returns each source's events so far, oldest first: redacted, or for a subscriber that
   * keeps text, with text where it was kept since the source's first text subscriber.
   */
  subscribe(id: string, sources: string[], opts: ConsoleSubscription = {}): Map<string, ConsoleEvent[]> {
    const wanted = new Set(sources.slice(0, MAX_SOURCES))
    const old = this.subs.get(id)
    if (!old && this.subs.size >= MAX_SUBSCRIBERS) throw hiveError(msg({ id: 'console.tooMany', defaultMessage: 'Too many developer consoles open at once', description: 'An error opening a developer console window or starting a recording: Combwork already watches for as many as it allows. Closing one helps.' }))
    if (old?.includeText) for (const s of old.sources) this.untext(s)
    // A new subscription starts with nothing waiting: what was queued for the old one (its sources, its opt-in to text) is
    // never sent to this one. It gets the rings' redacted events below instead.
    const sub: Subscriber = { ...opts, sources: wanted, queue: [], queueBytes: 0, dropped: 0 }
    this.subs.set(id, sub)
    for (const s of wanted) if (!this.rings.has(s)) this.rings.set(s, new ConsoleRing())
    if (sub.includeText) for (const s of wanted) this.retext(s)
    if (old) for (const s of old.sources) if (!wanted.has(s)) this.dropIfUnwatched(s)
    return new Map([...wanted].map((s) => [s, this.withTextFor(sub, s, this.rings.get(s)!.all())]))
  }

  /**
   * Turns text on or off for a subscription as it is (a window when the setting changes). Turned off, nothing with text
   * is sent to it again: what waits to be sent is dropped (the window reads the redacted ring again). Returns whether it
   * changed.
   */
  setIncludeText(id: string, on: boolean): boolean {
    const sub = this.subs.get(id)
    if (!sub || !!sub.includeText === on) return false
    sub.includeText = on
    for (const s of sub.sources) {
      if (on) this.retext(s)
      else this.untext(s)
    }
    if (!on) {
      sub.queue = []
      sub.queueBytes = 0
      sub.dropped = 0
    }
    return true
  }

  /** Whether a subscription keeps text. */
  includesText(id: string): boolean {
    return !!this.subs.get(id)?.includeText
  }

  /**
   * Ends a subscription. Capture stops for sources nobody else watches. `drain`: what is queued for it is delivered first,
   * at once (a recording's last events before its end line); nothing captured after this joins it.
   */
  unsubscribe(id: string, opts: { drain?: boolean } = {}): void {
    const sub = this.subs.get(id)
    if (!sub) return
    this.subs.delete(id)
    if (opts.drain && (sub.queue.length || sub.dropped)) {
      const batch = sub.queue.splice(0)
      const dropped = sub.dropped
      sub.queueBytes = 0
      sub.dropped = 0
      try {
        sub.deliver?.(batch, dropped)
      } catch {
        // What it delivers to has gone.
      }
    }
    for (const s of sub.sources) {
      if (sub.includeText) this.untext(s)
      this.dropIfUnwatched(s)
    }
  }

  /** The sources a subscriber watches (empty if none). */
  sourcesOf(id: string): string[] {
    return [...(this.subs.get(id)?.sources ?? [])]
  }

  /** A source's events after `since`, at most `limit` of the newest (redacted). */
  events(source: string, since = 0, limit = Infinity): ConsoleEvent[] {
    return this.rings.get(source)?.since(since, limit) ?? []
  }

  /** What a subscriber reads of a source it watches after `since`: redacted, or with text where kept when it keeps text. */
  eventsFor(id: string, source: string, since = 0): ConsoleEvent[] {
    const sub = this.subs.get(id)
    if (!sub?.sources.has(source)) return []
    return this.withTextFor(sub, source, this.events(source, since))
  }

  event(source: string, seq: number): ConsoleEvent | undefined {
    return this.rings.get(source)?.find(seq)
  }

  /** How many events a source's ring holds (0 when it isn't captured). */
  count(source: string): number {
    return this.rings.get(source)?.count ?? 0
  }

  /** What is captured now: sources, events (and those kept with text too) and bytes, and what waits to be sent (diagnostics and tests). */
  stats(): { sources: number; events: number; textEvents: number; bytes: number; subscribers: number; queued: number; flightSources: number; flightEvents: number; flightBytes: number } {
    let events = 0
    let bytes = 0
    for (const r of this.rings.values()) {
      events += r.count
      bytes += r.bytes
    }
    let textEvents = 0
    for (const r of this.textRings.values()) {
      textEvents += r.count
      bytes += r.bytes
    }
    let queued = 0
    for (const s of this.subs.values()) queued += s.queue.length
    let flightEvents = 0
    let flightBytes = 0
    for (const r of this.flightRings.values()) {
      flightEvents += r.count
      flightBytes += r.bytes
    }
    return { sources: this.rings.size, events, textEvents, bytes, subscribers: this.subs.size, queued, flightSources: this.flightRings.size, flightEvents, flightBytes }
  }

  /** Queues an event for a subscriber within its bounds: the oldest waiting go first, and are counted. */
  private enqueue(sub: Subscriber, e: ConsoleEvent): void {
    sub.queue.push(e)
    sub.queueBytes += e.bytes
    while (sub.queue.length > QUEUE_MAX_EVENTS || (sub.queueBytes > QUEUE_MAX_BYTES && sub.queue.length > 0)) {
      sub.queueBytes -= sub.queue.shift()!.bytes
      sub.dropped++
    }
  }

  /** Redacted events with each one's copy with text put in their place, for a subscriber that keeps text. */
  private withTextFor(sub: Subscriber, source: string, events: ConsoleEvent[]): ConsoleEvent[] {
    const ring = sub.includeText ? this.textRings.get(source) : undefined
    return ring?.count ? events.map((e) => ring.find(e.seq) ?? e) : events
  }

  private retext(s: string): void {
    this.textual.set(s, (this.textual.get(s) ?? 0) + 1)
    if (!this.textRings.has(s)) this.textRings.set(s, new ConsoleRing())
  }

  private untext(s: string): void {
    const n = (this.textual.get(s) ?? 0) - 1
    if (n > 0) this.textual.set(s, n)
    else {
      this.textual.delete(s)
      this.textRings.delete(s)
    }
  }

  private dropIfUnwatched(source: string): void {
    for (const sub of this.subs.values()) if (sub.sources.has(source)) return
    this.rings.delete(source)
    this.textual.delete(source)
    this.textRings.delete(source)
  }

  private scheduleFlush(): void {
    if (this.flushing) return
    this.flushing = true
    setTimeout(() => {
      this.flushing = false
      for (const sub of this.subs.values()) {
        if (!sub.queue.length && !sub.dropped) continue
        const batch = sub.queue.splice(0)
        const dropped = sub.dropped
        sub.queueBytes = 0
        sub.dropped = 0
        try {
          sub.deliver?.(batch, dropped)
        } catch {
          // A window that has gone: its subscription ends when it closes.
        }
      }
    }, 0)
  }
}

/** Hive's console. */
export const devConsole = new DevConsole()

export { hiveSourceId, sessionSourceId }
