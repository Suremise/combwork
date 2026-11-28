// Where each running preview's guarded page is shown (HI-3615 round 1): one entry per preview, holding its guard (opened
// once, on the first show), the window it is attached to, and the window that wants it now. No Electron here:
// previewApp.ts gives it the app's ways (open a guard, attach and detach a native view, check the ports' owners), unit
// tests their own.
//
// - A show records its intent (the window, a token) before it awaits anything, and checks it again after every await: a
//   hide, the window closing, a later show or the preview's close in the meantime makes it attach and load nothing.
// - A close is one shared operation: it cancels every intent, waits for a guard still opening, takes the view out of its
//   window and closes the guard (proxy first), and the entry stays (its close discoverable) until all that is done. Its
//   answer says whether the guard's end was proved.

/** A guarded page, as this module uses it. */
export interface ShownGuard {
  readonly view: unknown | null
  load: (url: string) => Promise<void>
  /** Ends it (shared by concurrent callers): true once its proxy is proved gone and its page closed. */
  close: () => Promise<boolean>
}

/** A window, as this module uses it. */
export interface ShownWindow {
  isDestroyed: () => boolean
  once: (event: 'closed', fn: () => void) => unknown
}

export interface ShownDeps<W extends ShownWindow, G extends ShownGuard> {
  /** Opens the preview's guard (its proxy started, its partition set, its view made). */
  open: (id: string) => Promise<G>
  attach: (win: W, guard: G) => void
  detach: (win: W, guard: G) => void
  place: (win: W, guard: G, bounds: unknown) => void
  /** Its ports' owners checked again before its page first loads: whether they are its own. */
  owned: (id: string) => Promise<boolean>
}

interface Entry<W, G> {
  guard: Promise<G>
  /** The window its view is in now. */
  attached: W | null
  /** The window that last asked to show it, while it still wants it. */
  wanted: W | null
  /** Bumped by every show, hide and close: a show acts only while its own is the latest. */
  intent: number
  loaded: boolean
  closing: Promise<boolean> | null
  /** Closed (its preview ended): never shown again, kept while its guard's end isn't proved (round 2). */
  ended: boolean
}

export type ShowAnswer = 'shown' | 'cancelled' | 'notOwned'

export class PreviewShows<W extends ShownWindow, G extends ShownGuard> {
  private readonly entries = new Map<string, Entry<W, G>>()

  constructor(private readonly deps: ShownDeps<W, G>) {}

  /** The preview's guard, once opened (null when it has none, or it couldn't open). */
  async guard(id: string): Promise<G | null> {
    const e = this.entries.get(id)
    return e ? e.guard.catch(() => null) : null
  }

  /**
   * The preview's guard for agents' captures (HI-3616): opened now if it has none, nothing attached to any window. A
   * closing or ended entry is refused.
   */
  ensure(id: string): Promise<G> {
    let e = this.entries.get(id)
    if (e?.closing || e?.ended) return Promise.reject(new Error('closing')) // i18n-ignore: a reason, never shown (the caller says notRunning)
    if (!e) {
      e = { guard: this.deps.open(id), attached: null, wanted: null, intent: 0, loaded: false, closing: null, ended: false }
      const made = e
      made.guard.catch(() => {
        if (this.entries.get(id) === made && !made.closing && !made.ended) this.entries.delete(id)
      })
      this.entries.set(id, e)
    }
    return e.guard
  }

  /** Whether the preview has an entry (shown, opening or closing). */
  has(id: string): boolean {
    return this.entries.has(id)
  }

  /**
   * Shows a preview's page in a window at those bounds, loading `url` the first time: its guard opened on first use. Acts
   * only while this show is still wanted after each await; a closing entry is never shown again.
   */
  async show(id: string, win: W, bounds: unknown, url: string): Promise<ShowAnswer> {
    let e = this.entries.get(id)
    if (e?.closing || e?.ended) return 'cancelled'
    if (!e) {
      e = { guard: this.deps.open(id), attached: null, wanted: null, intent: 0, loaded: false, closing: null, ended: false }
      // A guard that fails to open leaves no entry (a later show tries again); the failure is this show's to throw.
      const made = e
      made.guard.catch(() => {
        if (this.entries.get(id) === made && !made.closing && !made.ended) this.entries.delete(id)
      })
      this.entries.set(id, e)
    }
    const entry = e
    const token = ++entry.intent
    if (entry.wanted !== win) {
      entry.wanted = win
      win.once('closed', () => {
        if (entry.wanted === win) {
          entry.wanted = null
          entry.intent++
        }
        if (entry.attached === win) entry.attached = null
      })
    }
    const current = (): boolean => this.entries.get(id) === entry && !entry.closing && !entry.ended && entry.intent === token && entry.wanted === win && !win.isDestroyed()
    const guard = await entry.guard
    if (!current()) return 'cancelled'
    if (entry.attached !== win) {
      if (entry.attached && !entry.attached.isDestroyed()) this.deps.detach(entry.attached, guard)
      this.deps.attach(win, guard)
      entry.attached = win
    }
    this.deps.place(win, guard, bounds)
    if (entry.loaded) return 'shown'
    const owned = await this.deps.owned(id)
    if (!current()) return 'cancelled'
    if (!owned) return 'notOwned'
    entry.loaded = true
    await guard.load(url)
    return 'shown'
  }

  /** Moves a shown page (the tab resized), when it is in that window. */
  async place(id: string, win: W, bounds: unknown): Promise<void> {
    const e = this.entries.get(id)
    if (!e || e.closing || e.attached !== win) return
    const guard = await e.guard.catch(() => null)
    if (guard && e.attached === win && !win.isDestroyed()) this.deps.place(win, guard, bounds)
  }

  /** Takes a page out of a window (the tab hidden): a show of it for that window still waiting attaches nothing. */
  async hide(id: string, win: W): Promise<void> {
    const e = this.entries.get(id)
    if (!e) return
    if (e.wanted === win) {
      e.wanted = null
      e.intent++
    }
    if (e.attached !== win) return
    e.attached = null
    const guard = await e.guard.catch(() => null)
    if (guard && !win.isDestroyed()) this.deps.detach(win, guard)
  }

  /**
   * Closes a preview's page (its preview ended): every show cancelled, a guard still opening awaited, its view taken out,
   * its guard closed. Shared by concurrent callers while it runs. True once the guard's end is proved (or it had none):
   * then the entry goes. Unproved (round 2), the entry stays, never shown again, and the next close tries the guard's end
   * again; it never answers true without that proof.
   */
  close(id: string): Promise<boolean> {
    const e = this.entries.get(id)
    if (!e) return Promise.resolve(true)
    if (e.closing) return e.closing
    e.intent++
    e.wanted = null
    e.ended = true
    const run = (async () => {
      const guard = await e.guard.catch(() => null)
      if (guard && e.attached && !e.attached.isDestroyed()) this.deps.detach(e.attached, guard)
      e.attached = null
      const proved = guard ? await guard.close().catch(() => false) : true
      if (proved && this.entries.get(id) === e) this.entries.delete(id)
      return proved
    })()
    e.closing = run
    void run.then(() => {
      if (e.closing === run) e.closing = null
    })
    return run
  }
}
