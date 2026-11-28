// A preview generation's guarded page (HI-3615, design HI-3597 s16 §C, s21 §C′, SPEC §16.21): its in-memory partition,
// its filtering proxy (a utility process, previewProxy.ts) as the partition's only route, and the WebContentsView that shows
// the page. The proxy is the boundary; webRequest checks the same policy first (previewPolicy.ts).
//
// - Order: the proxy starts and says its port; setProxy (fixed_servers, no DIRECT, loopback's bypass removed) is
//   awaited; only then is the view made and its first URL loaded. No view ever exists on a session without the proxy.
// - The proxy's loss (it exits, misses its health check): the view is destroyed, the partition's connections closed, and
//   the guard says it is lost (the preview then shows "network guard stopped"); nothing loads again until a new start.
// - The partition: in memory (`preview:<place>:<generation>`, never `persist:`), no Combwork protocol in it, every
//   permission refused, downloads cancelled. The view: sandbox and context isolation, no Node, no preload, webSecurity on,
//   WebRTC's UDP only through the proxy (disable_non_proxied_udp). window.open is denied and a navigation off its own
//   origin cancelled: the URL is offered in Combwork's own bar, opened only by the user's click there.
// - Closing: the view's page closed, closeAllConnections, the proxy ended. A new generation gets a new partition.

import { app, BrowserWindow, session, utilityProcess, WebContentsView, type Session, type UtilityProcess } from 'electron'
import type { ConsoleEntry } from './previewCapture'
import { join } from 'path'
import { createLogger } from './logger'
import { checkUrl, openableUrl, sameOrigin } from '../shared/previewPolicy'
import type { ProxyEvent } from './previewProxyCore'

const log = createLogger('preview')

/** How long the proxy gets to say it is ready. */
const READY_MS = 15_000
/** How often its health is asked, and how long an answer may take. */
const PING_MS = 5_000

/** The agents' page of a preview (HI-3616): its offscreen window, its console's errors and warnings, its last load. */
export interface AgentPage {
  win: BrowserWindow
  console: ConsoleEntry[]
  /** Every error and warning since it was made (the list keeps the newest 50). */
  consoleTotal: number
  loadedAt: number | null
}

/** What refused something: a request's layer, or the partition's permission and download handlers. */
export type Layer = 'webRequest' | 'proxy' | 'permission' | 'download'

/** What a guard reports to its owner. */
export interface GuardEvents {
  /** The guard was lost (its proxy exited or stopped answering): the view is gone. */
  lost: (why: string) => void
  /** The page tried to leave its origin (a navigation, window.open): the URL, for Combwork's own bar. */
  tried: (url: string) => void
  /** A request refused, by which layer (tests and the log). */
  refused?: (layer: Layer, url: string, why: string) => void
}

export interface GuardOptions {
  /** The partition's name parts: the place's key and the generation. */
  placeKey: string
  generation: string
  /** The preview's own ports (its server's, and its hot reload one). */
  ownPorts: number[]
  events: GuardEvents
}

/** Test copies only (unpackaged): the proxy's test resolver and address map, the fixture certificate to trust, webRequest off. */
function testOptions(): { dns?: Record<string, string[][]>; connect?: Record<string, string>; cert?: string; proxyOnly?: boolean } {
  if (app.isPackaged) return {}
  const json = <T>(name: string): T | undefined => {
    try {
      const v = process.env[name]
      return v ? (JSON.parse(v) as T) : undefined
    } catch {
      return undefined
    }
  }
  return {
    dns: json<Record<string, string[][]>>('CW_TEST_PREVIEW_DNS'),
    connect: json<Record<string, string>>('CW_TEST_PREVIEW_CONNECT'),
    cert: process.env.CW_TEST_PREVIEW_CERT || undefined,
    proxyOnly: process.env.CW_TEST_PREVIEW_PROXY_ONLY === '1'
  }
}

let partitions = 0

export class PreviewGuard {
  private proxy: UtilityProcess | null = null
  private ses: Session | null = null
  private viewNow: WebContentsView | null = null
  private ping: NodeJS.Timeout | null = null
  private lastPong = 0
  private closed = false
  /** Its close, shared by every caller. */
  private closing: Promise<boolean> | null = null
  /** Settles when the proxy's process has exited (resolved at once when it never started). */
  private proxyExit: Promise<void> = Promise.resolve()
  private readonly own: { ports: number[] }
  /** Every request refused, by layer (tests read them; bounded). */
  readonly refusals: { layer: Layer; url: string; why: string }[] = []

  private constructor(private readonly o: GuardOptions) {
    this.own = { ports: [...o.ownPorts] }
  }

  /** Starts the proxy, awaits the partition's proxy setting, and makes the view: the guard, or why it couldn't. */
  static async open(o: GuardOptions): Promise<PreviewGuard> {
    const g = new PreviewGuard(o)
    try {
      await g.start()
      return g
    } catch (e) {
      await g.close()
      throw e
    }
  }

  get view(): WebContentsView | null {
    return this.viewNow
  }

  get alive(): boolean {
    return !this.closed && !!this.viewNow
  }

  /** Tests: ends the proxy's process by its handle, as a crash would; its pid, or null with none. */
  crashProxyForTests(): number | null {
    const p = this.proxy
    const pid = p?.pid ?? null
    p?.kill()
    return pid
  }

  private refused(layer: Layer, url: string, why: string): void {
    if (this.refusals.length < 500) this.refusals.push({ layer, url, why })
    this.o.events.refused?.(layer, url, why)
  }

  private async start(): Promise<void> {
    const t = testOptions()
    // 1. The proxy, in its own process.
    const child = utilityProcess.fork(join(__dirname, 'preview-proxy.js'), [], { serviceName: 'Combwork Preview network guard', stdio: 'ignore' }) // i18n-ignore: the process's name in Task Manager
    this.proxy = child
    this.proxyExit = new Promise<void>((r) => child.once('exit', () => r()))
    const port = await new Promise<number>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('the network guard did not start')), READY_MS) // i18n-ignore: a reason, logged and kept on the preview's end
      child.on('message', (m: { type: string; port?: number; why?: string; event?: ProxyEvent }) => {
        if (m.type === 'ready' && m.port) {
          clearTimeout(timer)
          ok(m.port)
        } else if (m.type === 'failed') {
          clearTimeout(timer)
          fail(new Error(`the network guard failed: ${m.why ?? ''}`)) // i18n-ignore: as above
        } else if (m.type === 'pong') this.lastPong = Date.now()
        else if (m.type === 'log' && m.event && !m.event.ok) this.refused('proxy', `${m.event.how} ${m.event.host}:${m.event.port}`, m.event.why ?? '')
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        fail(new Error(`the network guard exited (${code})`)) // i18n-ignore: as above
        this.lose(`the network guard exited (${code})`) // i18n-ignore: as above
      })
      child.postMessage({ type: 'start', own: this.own.ports, ...(t.dns ? { dns: t.dns } : {}), ...(t.connect ? { connect: t.connect } : {}) })
    })
    if (this.closed) throw new Error('closed while starting') // i18n-ignore: as above
    // 2. The partition, in memory, its only route the proxy (no DIRECT, loopback's implicit bypass removed), awaited.
    const ses = session.fromPartition(`preview:${this.o.placeKey}:${this.o.generation}:${++partitions}`, { cache: false })
    this.ses = ses
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: `127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' })
    await ses.closeAllConnections()
    ses.setPermissionRequestHandler((_wc, perm, cb) => {
      this.refused('permission', perm, 'request')
      cb(false)
    })
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    ses.setDisplayMediaRequestHandler((_req, cb) => {
      this.refused('permission', 'display-capture', 'request')
      cb({})
    })
    ses.on('will-download', (e, item) => {
      this.refused('download', item.getURL(), 'cancelled')
      e.preventDefault()
      item.cancel()
    })
    ses.setSpellCheckerEnabled(false)
    if (t.cert) ses.setCertificateVerifyProc((req, cb) => cb(req.certificate.fingerprint === t.cert ? 0 : -3))
    // The early check, every resource type (test copies may turn it off to prove the proxy alone).
    if (!t.proxyOnly)
      ses.webRequest.onBeforeRequest((d, cb) => {
        const decision = checkUrl(d.url, this.own)
        if (decision.ok) return cb({})
        this.refused('webRequest', d.url, decision.why)
        cb({ cancel: true })
      })
    if (this.closed) throw new Error('closed while starting') // i18n-ignore: as above
    // 3. The view, only now.
    const view = new WebContentsView({ webPreferences: this.prefs() })
    this.viewNow = view
    this.harden(view.webContents, (url) => this.tried(url))
    // Its health: an answer to each ping within the next.
    this.lastPong = Date.now()
    this.ping = setInterval(() => {
      if (Date.now() - this.lastPong > 2 * PING_MS) return this.lose("the network guard stopped answering") // i18n-ignore: as above
      this.proxy?.postMessage({ type: 'ping', n: Date.now() })
    }, PING_MS)
    this.ping.unref?.()
  }

  /** A page's preferences on this partition: sandboxed, isolated, no Node anywhere, no preload, web security on. */
  private prefs(offscreen = false): Electron.WebPreferences {
    return { partition: undefined, session: this.ses!, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, spellcheck: false, devTools: !offscreen, safeDialogs: true, ...(offscreen ? { offscreen: true, backgroundThrottling: false } : {}) }
  }

  /**
   * A page of this partition's handlers: WebRTC's UDP only through the proxy, window.open denied, a navigation off its own
   * origin cancelled (`tried` told of it).
   */
  private harden(wc: Electron.WebContents, tried: (url: string) => void): void {
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    wc.setWindowOpenHandler(({ url }) => {
      tried(url)
      return { action: 'deny' }
    })
    const ownPort = this.own.ports[0]
    const leaving = (e: { preventDefault: () => void; url: string; isMainFrame?: boolean }): void => {
      if (e.isMainFrame === false || sameOrigin(e.url, ownPort)) return
      e.preventDefault()
      tried(e.url)
    }
    wc.on('will-navigate', leaving)
    wc.on('will-redirect', leaving)
    wc.on('will-frame-navigate', leaving)
    wc.on('render-process-gone', (_e, d) => log.warn(`a preview's page ended (${d.reason})`))
  }

  /** The agents' page (HI-3616), once made. */
  private agentNow: AgentPage | null = null

  /**
   * The agents' own page of this preview (HI-3616): an offscreen window on the same partition, so behind the same proxy and
   * handlers, never shown, never the user's view (an agent's goto never moves the page the user looks at). Made on first
   * use, at `size`; its console's errors and warnings recorded from then on. A page leaving its origin is refused, with no
   * bar (no user is there to click it).
   */
  async agentPage(size: { width: number; height: number }): Promise<AgentPage> {
    if (this.closed || !this.ses) throw new Error('closed') // i18n-ignore: a reason, never shown (the caller says notRunning)
    if (this.agentNow && !this.agentNow.win.isDestroyed()) return this.agentNow
    const win = new BrowserWindow({ show: false, width: size.width, height: size.height, useContentSize: true, frame: false, skipTaskbar: true, focusable: false, webPreferences: this.prefs(true) })
    const wc = win.webContents
    this.harden(wc, () => undefined)
    wc.setFrameRate(10)
    const page: AgentPage = { win, console: [], consoleTotal: 0, loadedAt: null }
    wc.on('console-message', (e) => {
      const level = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warning' : null
      if (!level) return
      page.consoleTotal++
      page.console.push({ level, text: String(e.message ?? ''), at: Date.now() })
      if (page.console.length > 50) page.console.shift()
    })
    wc.on('did-finish-load', () => (page.loadedAt = Date.now()))
    // Its own DevTools session (the snapshot's tree, a full page's size), attached as it is made.
    try {
      wc.debugger.attach('1.3')
    } catch (e) {
      log.warn(`the agents' page's DevTools session didn't attach: ${String(e)}`)
    }
    this.agentNow = page
    return page
  }

  /** The agents' page if it was made (and isn't closed). */
  get agentPageNow(): AgentPage | null {
    return this.agentNow && !this.agentNow.win.isDestroyed() ? this.agentNow : null
  }

  private tried(url: string): void {
    const u = openableUrl(url)
    if (u) this.o.events.tried(u)
  }

  /** Loads a URL of its own origin (a hard reload bypasses the cache). */
  load(url: string, hard = false): Promise<void> {
    const wc = this.viewNow?.webContents
    if (!wc || !sameOrigin(url, this.own.ports[0])) return Promise.resolve()
    if (hard) wc.session.clearCache().catch(() => undefined)
    return wc.loadURL(url, hard ? { extraHeaders: 'pragma: no-cache\ncache-control: no-cache\n' } : {}).catch(() => undefined) // i18n-ignore: HTTP headers
  }

  reload(hard: boolean): void {
    const wc = this.viewNow?.webContents
    if (!wc) return
    if (hard) wc.reloadIgnoringCache()
    else wc.reload()
  }

  /** DevTools for the user (Combwork's button); never for agents. */
  devTools(): void {
    this.viewNow?.webContents.openDevTools({ mode: 'detach' })
  }

  private lose(why: string): void {
    if (this.closed) return
    log.warn(`A preview's network guard was lost: ${why}`)
    void this.close().then(() => this.o.events.lost(why))
  }

  /**
   * Ends it. The proxy first: every connection of the page's goes through it, so its end ends them all (a WebSocket or a
   * tunnel opened before, included), whatever the page or the partition does. Then the page, and the partition's
   * connections closed (bounded: nothing here waits on Chromium for long). The partition is in memory and never used again.
   */
  /**
   * Ends it: one operation shared by every caller while it runs. Its answer is cached only once proved; one that couldn't
   * prove its proxy gone is tried again by the next call (the proxy ended again by its handle, its exit awaited).
   */
  close(): Promise<boolean> {
    if (this.closing) return this.closing
    const run = this.closeOnce()
    this.closing = run
    void run.then((proved) => {
      if (!proved && this.closing === run) this.closing = null
    })
    return run
  }

  /** The proxy's process, kept until its exit is seen (a later close ends it again). */
  private ending: UtilityProcess | null = null

  /** close's one run: true once the proxy is seen exited (asked, then ended by its handle) and the page closed. */
  private async closeOnce(): Promise<boolean> {
    this.closed = true
    if (this.ping) clearInterval(this.ping)
    const p = this.proxy ?? this.ending
    this.proxy = null
    this.ending = p
    const view = this.viewNow
    this.viewNow = null
    /** Whether the work finished within the bound. */
    const bounded = (work: Promise<unknown>): Promise<boolean> => Promise.race([work.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), PING_MS).unref?.())])
    let proxyGone = true
    if (p) {
      try {
        p.postMessage({ type: 'close' })
      } catch {
        // Gone already: its exit says so.
      }
      proxyGone = await bounded(this.proxyExit)
      if (!proxyGone) {
        p.kill()
        proxyGone = await bounded(this.proxyExit)
      }
      if (proxyGone) this.ending = null
    }
    if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
    const agent = this.agentNow
    this.agentNow = null
    if (agent && !agent.win.isDestroyed()) agent.win.destroy()
    if (this.ses) await bounded(this.ses.closeAllConnections())
    if (!proxyGone) log.warn("A preview's network guard couldn't be proved ended: tried again at its place's next use")
    return proxyGone
  }
}
