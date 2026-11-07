import { homedir } from 'os'
import { app } from 'electron'
import type { AgentInstallInfo, ModelCatalog, ProviderId, ProviderTask } from '../shared/types'
import { observedEffortKey } from '../shared/models'
import { autoProviderPending, isProviderEnabled, providerSettings, setInstalledCheck } from '../shared/providers'
import { ptyArgs, shownInstallInfo, toSpawnable, withoutAccountEnv, withServerEnv } from './providers/common'
import { allProviders, provider } from './providers'
import type { KeySteps, UpdateRetry } from './providers/types'
import { msg, onLanguageChange, tr } from '../shared/i18n'
import { combworkError } from './combworkError'
import { config } from './config'
import { advanced } from './advanced'
import { overrides } from './advancedValues'
import { overrideId } from '../shared/advanced'
import { noteCliFolder, refreshPath } from './freshPath'
import { emit, onCombworkEvent, toast } from './events'
import { createLogger } from './logger'
import { childEnv, hasPty, killPty, spawnPty, startSize, writePty } from './ptyHost'
import { connectionsManaged } from './connectionSeam'
import { KeyGate } from './taskKeys'
import { KeysStopped, PickNotFound, typeKeySteps } from './keySteps'
import { compareTested, noteSelectedCli, testedVersion } from './testedClis'

/** How long a key waits for a busy CLI before Combwork stops typing a setup task's keys. */
const BUSY_SECONDS = 30
/** Why Combwork stopped typing into a setup task (KeysStopped's reason, English for the log), and how the window says it (#850). */
const STOPPED = { closed: 'its terminal closed', busy: `it stayed busy for ${BUSY_SECONDS} seconds` } // i18n-ignore: the log's words; the toast says them with STOPPED_TEXT
const STOPPED_TEXT = {
  closed: msg({ id: 'service.providers.stoppedClosed', defaultMessage: 'its terminal closed', description: "Why Combwork stopped typing a coding agent CLI's setup keys: its terminal closed. A clause, lower case (it follows \"as\")." }),
  busy: msg({ id: 'service.providers.stoppedBusy', defaultMessage: '{seconds, plural, one {it stayed busy for # second} other {it stayed busy for # seconds}}', description: "Why Combwork stopped typing a coding agent CLI's setup keys: it stayed busy for {seconds} seconds. A clause, lower case (it follows \"as\")." })
}
const stoppedText = (why: string): string => (why === STOPPED.closed ? tr(STOPPED_TEXT.closed) : why === STOPPED.busy ? tr(STOPPED_TEXT.busy, { seconds: BUSY_SECONDS }) : why)

/** A CLI task's name in the window (its toasts): "Codex install", "Claude Code sign-in". */
const TASK = msg({ id: 'service.providers.task', defaultMessage: '{task, select, install {{cli} install} update {{cli} update} login {{cli} sign-in} other {{cli} setup}}', description: "A coding agent CLI's task Combwork runs in a terminal, as its notifications name it: {cli} is the CLI (\"Codex\"), {task} which task (install, update, sign-in, or another setup)." })

const log = createLogger('providers')
/** How many models' default efforts are kept per provider (observeDefaultEffort). */
const OBSERVED_EFFORTS = 50

const blank = (id: ProviderId): AgentInstallInfo => ({
  provider: id,
  found: false,
  path: null,
  version: null,
  source: null,
  latestVersion: null,
  updateAvailable: false,
  loggedIn: null,
  authMethod: null,
  checking: true,
  defaultModel: null,
  readiness: []
})

/** Tracks each provider's installed CLI and runs its install, update, sign-in and setup tasks in visible terminals. */
class ProviderService {
  private infos = new Map<ProviderId, AgentInstallInfo>(allProviders().map((p) => [p.id, blank(p.id)]))
  private liveSessionCount: (provider: ProviderId) => number = () => 0
  /** At most one retry per provider, bound to the executable and version that failed. */
  private updateRetries = new Map<ProviderId, { path: string; version: string | null; retry: UpdateRetry }>()

  info(id: ProviderId): AgentInstallInfo {
    return this.infos.get(id) ?? blank(id)
  }

  all(): Record<ProviderId, AgentInstallInfo> {
    return Object.fromEntries(this.infos)
  }

  /** Each provider's install info as the window shows it: its readiness and notes in the language shown (#797). */
  shown(): Record<ProviderId, AgentInstallInfo> {
    return Object.fromEntries([...this.infos].map(([id, info]) => [id, shownInstallInfo(info)]))
  }

  /** The language Combwork shows changed (#797): the windows are sent each provider's install info in it. */
  relabel(): void {
    for (const [id, info] of this.infos) emit({ type: 'provider-install', provider: id, info: shownInstallInfo(info) })
  }

  /**
   * The CLI's own default: its settings, else what its catalog says runs when no model is passed (Claude Code's
   * "default"), else the model last seen in a session started without a model choice.
   */
  private resolveDefaultModel(id: ProviderId, catalog?: ModelCatalog | null): string | null {
    // Its connections' settings are each their own (HI-1755: a launch reads its connection's); ~/.claude's isn't theirs.
    const own = connectionsManaged(id) ? null : provider(id).configuredDefaultModel()
    return own ?? catalog?.defaultModel ?? config.get().observedDefaultModel[id] ?? null
  }

  /** The efforts sessions started without an effort choice ran with, per model (the CLI's own defaults). */
  private observedEfforts(id: ProviderId): Record<string, string> {
    return { ...config.get().observedDefaultEffort?.[id] }
  }

  /**
   * Records the effort a session started without an effort choice reports for its model: the CLI's default for that
   * model, which the footer then shows ("Medium (default)") for agents with no effort set (#125).
   */
  observeDefaultEffort(id: ProviderId, model: string, effort: string): void {
    const key = observedEffortKey(model)
    if (!key || !effort || config.get().observedDefaultEffort?.[id]?.[key] === effort) return
    config.update((c) => {
      // Bounded: the newest OBSERVED_EFFORTS models (custom model ids would otherwise add up for ever).
      const kept = Object.entries({ ...c.observedDefaultEffort?.[id] }).filter(([k]) => k !== key).slice(-(OBSERVED_EFFORTS - 1))
      c.observedDefaultEffort = { ...c.observedDefaultEffort, [id]: { ...Object.fromEntries(kept), [key]: effort } }
    })
    this.set(id, { ...this.info(id), observedEfforts: this.observedEfforts(id) })
  }

  /** The last good catalog this provider's CLI gave, as a cache (for its version only). */
  private cachedCatalog(id: ProviderId, version?: string | null): ModelCatalog | null {
    const c = config.get().modelCatalogs?.[id]
    if (!c || !Array.isArray(c.models) || !c.models.length) return null
    return version === undefined || c.version === version ? { ...c, source: 'cache' } : null
  }

  /** Records the model seen answering in a session started without a model choice. */
  observeDefaultModel(id: ProviderId, model: string): void {
    if (!provider(id).ownsModel(model) || config.get().observedDefaultModel[id] === model) return
    config.update((c) => {
      c.observedDefaultModel = { ...c.observedDefaultModel, [id]: model }
    })
    const cur = this.info(id)
    const next = this.resolveDefaultModel(id, cur.catalog)
    if (next !== cur.defaultModel) this.set(id, { ...cur, defaultModel: next })
  }

  setLiveSessionCounter(fn: (provider: ProviderId) => number): void {
    this.liveSessionCount = fn
  }

  private signedInListeners: ((provider: ProviderId) => void)[] = []

  /**
   * Called when a CLI is signed in again: its check says so after saying it wasn't, or its Sign in task ended well
   * (agents stopped by a refused sign-in can carry on, #309).
   */
  onSignedIn(fn: (provider: ProviderId) => void): void {
    this.signedInListeners.push(fn)
  }

  private signedIn(id: ProviderId): void {
    for (const fn of this.signedInListeners) fn(id)
  }

  private set(id: ProviderId, info: AgentInstallInfo): void {
    const was = this.infos.get(id)?.loggedIn
    const pending = this.updateRetries.get(id)
    if (pending && (pending.path !== info.path || pending.version !== info.version)) this.updateRetries.delete(id)
    info = { ...info, updateRetry: this.updateRetries.get(id)?.retry.notice }
    this.infos.set(id, info)
    emit({ type: 'provider-install', provider: id, info: shownInstallInfo(info) })
    for (const fn of [...this.changed]) fn()
    if (was === false && info.loggedIn === true) this.signedIn(id)
  }

  private changed = new Set<() => void>()

  /**
   * How long a launch or a new agent waits for detection before it is refused (detected, settle). Tests only (unpackaged
   * builds): CW_TEST_DETECT_WAIT_MS shortens it.
   */
  detectWaitMs = (!app.isPackaged && Number(process.env.CW_TEST_DETECT_WAIT_MS)) || 20_000

  /**
   * Waits until Combwork knows (#506): with no `id`, Automatic's provider (every turned-on provider has answered, found or
   * missing); with `id`, only that provider's CLI (turned on or not), so a launch of a known provider never waits for
   * another. True once known; false when it still isn't after detectWaitMs (a CLI that never answers doesn't hold a
   * launch for ever), and then nothing may be decided from a guess.
   */
  async detected(id?: ProviderId): Promise<boolean> {
    const settled = (): boolean => (id ? !(this.info(id).checking && !this.info(id).found) : !autoProviderPending(config.settings))
    if (settled()) return true
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer)
        this.changed.delete(check)
        resolve(ok)
      }
      const check = (): void => {
        if (settled()) done(true)
      }
      const timer = setTimeout(() => {
        log.warn(`Still looking for the coding agent CLIs after ${this.detectWaitMs / 1000} s: nothing decided from a guess`)
        done(false)
      }, this.detectWaitMs)
      this.changed.add(check)
    })
  }

  /** detected(), refusing when Combwork is still looking: what calls it would otherwise commit to a guess (#506). */
  async settle(id?: ProviderId): Promise<void> {
    if (await this.detected(id)) return
    if (!id) throw combworkError(msg({ id: 'service.providers.stillLookingAll', defaultMessage: 'Combwork is still looking for the coding agent CLIs. Try again in a moment.', description: "An error: Combwork hasn't finished finding the coding agent CLIs installed (it does when it starts), so it can't choose one yet." }), undefined, { kind: 'conflict' })
    throw combworkError(msg({ id: 'service.providers.stillLooking', defaultMessage: 'Combwork is still looking for {cli}. Try again in a moment.', description: "An error: Combwork hasn't finished finding the coding agent CLI {cli} (\"Codex\"), so it can't use it yet." }), { cli: provider(id).descriptor.name }, { kind: 'conflict' })
  }

  /**
   * Refreshes one provider, or all of them. Latest versions are only looked up for enabled providers. First Combwork's
   * PATH gets the folders installers have added since it started (#472), so a CLI just installed is found.
   */
  async refresh(id?: ProviderId, checkLatest?: boolean): Promise<AgentInstallInfo[]> {
    const ids = id ? [id] : allProviders().map((p) => p.id)
    await refreshPath()
    return Promise.all(ids.map((p) => this.refreshOne(p, checkLatest)))
  }

  /** Each provider's latest refresh: an older one still running when a newer starts (the path changed) is dropped. */
  private refreshes = new Map<ProviderId, number>()

  private async refreshOne(id: ProviderId, checkLatest?: boolean): Promise<AgentInstallInfo> {
    const adapter = provider(id)
    const prev = this.info(id)
    const run = (this.refreshes.get(id) ?? 0) + 1
    this.refreshes.set(id, run)
    // The last good catalog fills the pickers at once (on start), until this refresh has asked the CLI again.
    this.set(id, { ...prev, catalog: prev.catalog ?? this.cachedCatalog(id), checking: true })
    const latestWanted = checkLatest ?? (isProviderEnabled(config.settings, id) && providerSettings(config.settings, id).checkUpdatesOnLaunch)
    let next: AgentInstallInfo
    try {
      // Tests only (unpackaged builds): CW_TEST_SLOW_DETECT="claude-code=6000" holds that provider's detection (#506).
      const slow = app.isPackaged ? 0 : Number((process.env.CW_TEST_SLOW_DETECT ?? '').split(',').find((x) => x.startsWith(`${id}=`))?.slice(id.length + 1) ?? 0)
      if (slow > 0) await new Promise((r) => setTimeout(r, slow))
      const found = await adapter.locate()
      // Its folder on the PATH of what Combwork starts, so its sessions and terminals find the CLI Provider Setup found (#1103).
      if (this.refreshes.get(id) === run) noteCliFolder(id, found.path)
      // Found is known before its version, models and sign-in are: Automatic's pick needs only that (#506).
      if (found.path && this.refreshes.get(id) === run && !this.info(id).found) this.set(id, { ...this.info(id), found: true, path: found.path })
      // What the found copy's own installer can deliver (HI-2729): a WinGet install's from WinGet, not npm.
      const latest = latestWanted ? await adapter.latestVersion(found.path) : prev.latestVersion
      // The version this release was tested with, against the installed one (#365).
      const tested = await testedVersion(id)
      // The CLI's own models and what each can do, so new models show without a Combwork update (#125). If it can't say,
      // its last good answer for this version, else none (the pickers then use the fallbacks in Settings).
      const read = found.path && adapter.listModels ? await adapter.listModels(found.path, childEnv()).catch(() => null) : null
      let catalog: ModelCatalog | null = null
      if (read) {
        catalog = { source: 'cli', version: found.version, models: read.models, ...(read.defaultModel ? { defaultModel: read.defaultModel } : {}), at: new Date().toISOString() }
        const keep = catalog
        // Only the latest refresh's answer is kept (an older one still running mustn't replace a newer one's).
        if (this.refreshes.get(id) === run)
          config.update((c) => {
            c.modelCatalogs = { ...c.modelCatalogs, [id]: keep }
          })
      } else {
        catalog = this.cachedCatalog(id, found.version)
        if (found.path && adapter.listModels) log.warn(`${adapter.descriptor.name} ${found.version ?? ''} didn't say which models it has: ${catalog ? 'using its last answer' : 'using the fallback list'}`)
      }
      next = {
        ...found,
        provider: id,
        defaultModel: this.resolveDefaultModel(id, catalog),
        latestVersion: latest,
        updateAvailable: !!(found.version && latest && adapter.isNewer(latest, found.version)),
        catalog,
        configuredEffort: adapter.configuredDefaultEffort?.() ?? null,
        observedEfforts: this.observedEfforts(id),
        tested: tested ? compareTested(tested, found.version, (a, b) => adapter.isNewer(a, b)) : null,
        checking: false
      }
    } catch (e) {
      log.error(`Failed to locate ${adapter.descriptor.name}`, e)
      next = { ...prev, checking: false }
    }
    next.readiness = adapter.readiness(next)
    if (this.refreshes.get(id) !== run) return this.info(id)
    this.set(id, next)
    await noteSelectedCli(next, adapter.configHome?.() ?? null)
    return next
  }

  private runTask(id: ProviderId, task: ProviderTask, cmd: { file: string; args: string[]; line?: string }, label: string, typed?: { keys: KeySteps; ready?: RegExp; busyTitle?: RegExp; busyScreen?: (screen: string) => boolean; done?: () => boolean }, shown: () => string = () => label, onExit?: (code: number) => boolean | void, place?: { env?: Record<string, string>; cwd?: string }): string {
    const key = `task:${id}:${task}`
    if (hasPty(key)) return key
    // A command toSpawnable already gave its command line (an adapter's) is started as it is.
    const s = cmd.line !== undefined ? cmd : toSpawnable(cmd.file, cmd.args)
    let sent = !typed
    let finished = false
    // Typed once its screen shows it ready (typeWhenIdle).
    // A key picked from the screen (a menu entry, #396), or a submission checked against it (#363), needs the screen
    // after it is ready too.
    const keepScreen = !!typed?.keys.some((k) => 'pick' in k || ('heldOn' in k && !!k.heldOn))
    const gate = typed?.ready
      ? new KeyGate({ ready: typed.ready, busyTitle: typed.busyTitle, busyScreen: typed.busyScreen, ...startSize(key), onReady: () => typeWhenIdle(), keepScreen })
      : null
    let typeTimer: NodeJS.Timeout | null = null
    // A program that stays open after its job (Codex after its sandbox setup) is closed once the job is done.
    const watch = typed?.done
      ? setInterval(() => {
          if (!hasPty(key) || finished || !typed.done!()) return
          finished = true
          setTimeout(() => killPty(key), 1500)
        }, 1500)
      : null
    // Some tasks are keys typed into the CLI once its interface is ready (Codex's sandbox setup).
    /** Not busy (its title or its screen), and not for half a second (the output changes as it settles). */
    const settled = (): boolean => !gate || gate.settled(500)
    const type = async (): Promise<void> => {
      if (sent || !typed) return
      sent = true
      try {
        await typeKeySteps(typed.keys, {
          write: (keys) => writePty(key, keys),
          screen: () => gate?.text() ?? null,
          // Each key waits while the program is busy (it can get busy again after showing its prompt), at most 30
          // seconds. Still busy then, or closed, nothing more goes in (#363): a key typed into a busy CLI can be held
          // or queued, and the 30-second start above mustn't type into one either.
          ready: async () => {
            for (const t0 = Date.now(); !settled() && hasPty(key) && Date.now() - t0 < BUSY_SECONDS * 1000; ) await new Promise((r) => setTimeout(r, 200))
            if (!hasPty(key)) return STOPPED.closed
            return settled() ? true : STOPPED.busy
          }
        })
      } catch (e) {
        // The CLI doesn't show what the task needs (another version), or wasn't safe to type into: the terminal
        // stays open for the user to do it.
        if (e instanceof PickNotFound) {
          log.warn(`${label}: couldn't find ${e.what}`)
          toast('warning', tr(msg({ id: 'service.providers.pickNotFound', defaultMessage: "{task}: Combwork couldn't find {item}. Do it in the terminal, or update Combwork.", description: "A notification: Combwork types the keys of a coding agent CLI's task ({task}: \"Codex setup\") into its terminal, and couldn't find the menu item {item} (the CLI's own words) on its screen." }), { task: shown(), item: e.what }))
        } else if (e instanceof KeysStopped) {
          log.warn(`${label}: stopped typing: ${e.why}`)
          if (hasPty(key)) toast('warning', tr(msg({ id: 'service.providers.keysStopped', defaultMessage: '{task}: Combwork stopped typing into it, as {why}. Finish it in the terminal.', description: "A notification: Combwork stopped typing the keys of a coding agent CLI's task ({task}: \"Codex setup\") into its terminal; {why} says why (a clause: \"its terminal closed\")." }), { task: shown(), why: stoppedText(e.why) }))
        } else throw e
      } finally {
        gate?.dispose()
      }
    }
    // Typed once the interface is ready and has been idle for a moment (or, failing that, after 30 seconds).
    const typeWhenIdle = (): void => {
      if (sent || typeTimer) return
      const wait = (): void => {
        typeTimer = null
        if (sent || !gate) return
        const idleFor = gate.idleFor()
        if (idleFor < 1000) typeTimer = setTimeout(wait, gate.busy ? 300 : 1000 - idleFor)
        else void type()
      }
      typeTimer = setTimeout(wait, 800)
    }
    if (typed) setTimeout(() => void type(), 30000)
    spawnPty(key, {
      file: s.file,
      args: ptyArgs(s),
      // A setup task's own folder and environment (HI-2547: agy's first-run setup in Combwork's check profile), else the user's.
      cwd: place?.cwd ?? homedir(),
      env: place?.env ?? childEnv(),
      onData: (d) => {
        if (gate && !finished) gate.feed(d)
      },
      onExit: (code) => {
        if (watch) clearInterval(watch)
        gate?.dispose()
        // True from onExit: a code its installer uses for nothing to do (HI-2729), which ended well too.
        const endedWell = onExit?.(code) === true
        if (code === 0 || finished || endedWell) toast('success', tr(msg({ id: 'service.providers.taskDone', defaultMessage: '{task} finished', description: "A notification: a coding agent CLI's task ({task}: \"Codex install\") ended well." }), { task: shown() }))
        else toast('warning', tr(msg({ id: 'service.providers.taskFailed', defaultMessage: '{task} exited with code {code}', description: "A notification: a coding agent CLI's task ({task}: \"Codex install\") ended with the exit code {code}." }), { task: shown(), code: String(code) }))
        if (task === 'login' && code === 0) this.signedIn(id)
        void this.refresh(id, true)
      }
    })
    return key
  }

  /**
   * Signs an account's folder in (HI-980): the CLI's own login in a terminal of Combwork's, with the folder as its home
   * (`env`), and nothing typed into it: the user signs in through the CLI's flow. One per account: a second start gets
   * the open one's key. `onExit` once it ends. The CLI's own sign-in state isn't changed by it (that is ~/.claude's).
   */
  runAccountLogin(id: ProviderId, accountId: string, env: Record<string, string>, onExit: (code: number) => void, setUp?: { env: Record<string, string>; cwd: string }): string {
    const adapter = provider(id)
    const info = this.info(id)
    if (!info.path) throw combworkError(msg({ id: 'service.providers.notInstalled', defaultMessage: '{cli} is not installed.', description: 'An error running a coding agent CLI\'s task (update, sign-in, setup): the CLI {cli} ("Codex") is not installed.' }), { cli: adapter.descriptor.name }, { kind: 'conflict' })
    const key = `task:${id}:login:${accountId}`
    if (hasPty(key)) return key
    // The connection's own sign-in where the CLI has one (HI-1757), without the variables it would read as a login. A
    // server connection's Set Up (HI-1772) runs the CLI itself instead, with its server's variables, for its first-run
    // screens: the user answers them in the CLI's own way.
    const home = env[adapter.descriptor.capabilities.connections?.homeEnv ?? '']
    const cmd = setUp ? { file: info.path, args: (home && adapter.connectionSetUpArgs?.(home)) || [] } : (adapter.accountLoginCommand?.(info.path) ?? adapter.loginCommand(info.path))
    const s = cmd.line !== undefined ? cmd : toSpawnable(cmd.file, cmd.args)
    log.info(`${adapter.descriptor.name} ${setUp ? 'set-up' : 'sign-in'} for account ${accountId}`)
    spawnPty(key, { file: s.file, args: ptyArgs(s), cwd: setUp?.cwd ?? homedir(), env: withServerEnv(setUp?.env, withoutAccountEnv(adapter, childEnv(env))), onExit })
    return key
  }

  /** Starts a provider task in a terminal and returns its terminal key. */
  runProviderTask(id: ProviderId, task: ProviderTask, retryUpdate = false): string {
    const adapter = provider(id)
    const name = adapter.descriptor.name
    const info = this.info(id)
    // The task's name: English for the log, in the window's language when its toasts say it.
    const shown = (): string => tr(TASK, { task, cli: name })
    if (task === 'install') {
      const cmd = adapter.installCommand()
      return this.runTask(id, task, cmd, `${name} install`, undefined, shown) // i18n-ignore: the task's name in the log
    }
    if (!info.path) throw combworkError(msg({ id: 'service.providers.notInstalled', defaultMessage: '{cli} is not installed.', description: 'An error running a coding agent CLI\'s task (update, sign-in, setup): the CLI {cli} ("Codex") is not installed.' }), { cli: name }, { kind: 'conflict' })
    if (task === 'update') {
      if (this.liveSessionCount(id) > 0) throw combworkError(msg({ id: 'service.providers.stopFirst', defaultMessage: 'Stop all running {cli} agents before updating it.', description: 'An error updating the coding agent CLI {cli} ("Codex") while agents run it.' }), { cli: name }, { kind: 'conflict' })
      const pending = this.updateRetries.get(id)
      if (retryUpdate && (!pending || pending.path !== info.path || pending.version !== info.version)) throw combworkError(msg({ id: 'service.providers.retryUnavailable', defaultMessage: 'This update retry is no longer available. Check again, then try Update.', description: 'Provider Setup error when a user tries to retry an update whose failure is no longer current. Check again and Update are buttons.' }), undefined, { kind: 'conflict' })
      if (hasPty(`task:${id}:${task}`)) return `task:${id}:${task}`
      const cmd = retryUpdate ? pending!.retry.command : adapter.updateCommand(info.path)
      const key = this.runTask(id, task, cmd, `${name} update`, undefined, shown, (code) => { // i18n-ignore: the task's name in the log
        // Its installer having nothing newer (WinGet's 0x8A15002B) isn't a failure: the check after it says up to date.
        if (code !== 0 && adapter.updateUpToDate?.(info.path!, code)) return true
        const retry = adapter.updateRetry?.(info.path!, code)
        if (retry && this.info(id).path === info.path && this.info(id).version === info.version) this.updateRetries.set(id, { path: info.path!, version: info.version, retry })
        this.set(id, this.info(id))
      })
      this.updateRetries.delete(id)
      this.set(id, this.info(id))
      return key
    }
    if (task === 'login') {
      // Signed in per connection (HI-1755): its sign-in is Settings → Accounts & Connections', never ~/.claude's.
      if (connectionsManaged(id)) throw combworkError(msg({ id: 'service.providers.signInConnections', defaultMessage: '{cli} signs in per account: sign in from Settings → Accounts & Connections.', description: 'An error: Provider Setup was asked to sign a coding agent CLI ({cli}: "Claude Code") in, but its logins are accounts (Settings → Accounts & Connections names a section).' }), { cli: name }, { kind: 'conflict' })
      const cmd = adapter.loginCommand(info.path)
      return this.runTask(id, task, cmd, `${name} sign-in`, undefined, shown) // i18n-ignore: the task's name in the log
    }
    if (!adapter.setupCommand) throw combworkError(msg({ id: 'service.providers.noSetup', defaultMessage: '{cli} has no setup task.', description: 'An error: the coding agent CLI {cli} ("Codex") has no setup task for Combwork to run.' }), { cli: name }, { kind: 'invalid' })
    const cmd = adapter.setupCommand(info.path)
    return this.runTask(id, task, cmd, `${name} setup`, cmd.keys ? { keys: cmd.keys, ready: cmd.readyPattern, busyTitle: cmd.busyTitle, busyScreen: cmd.busyScreen, done: cmd.done } : undefined, shown, undefined, { env: cmd.env, cwd: cmd.cwd })
  }
}

export const providerService = new ProviderService()
onLanguageChange(() => providerService.relabel())

// A CLI is checked again when an advanced setting its check depends on changes (ProviderAdapter.locateSettings).
// An override among them is read as Combwork's own runs of the CLI read it (HI-2670: from its connections), so a change of
// a connection's launch settings checks it again too.
const locateValue = (p: ProviderId, id: string): unknown => (id.startsWith(overrideId(p, '')) ? overrides(p, id.slice(overrideId(p, '').length)) : advanced.get(id))
const locateValues = (): Map<ProviderId, string> => new Map(allProviders().map((p) => [p.id, JSON.stringify((p.locateSettings ?? []).map((id) => locateValue(p.id, id)))]))
let lastLocateValues = locateValues()
const relocate = (): void => {
  const now = locateValues()
  for (const [id, v] of now) if (v !== lastLocateValues.get(id) && providerService.info(id).found) void providerService.refresh(id)
  lastLocateValues = now
}
advanced.onChange(relocate)
onCombworkEvent((e) => {
  if (e.type === 'connections-changed') relocate()
})

// Automatic's default provider (#474) follows what this process found.
setInstalledCheck((id) => {
  const i = providerService.info(id)
  return i.found ? true : i.checking ? null : false
})
