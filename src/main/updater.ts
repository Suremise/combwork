import { msg, tr } from '../shared/i18n'
import { app } from 'electron'
import { writeFileSync } from 'original-fs'
import { join } from 'path'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '../shared/types'
import { APP_NAME } from '../shared/appName'
import { config } from './config'
import { emit, toast } from './events'
import { resolveOffer, resolveOffers } from './notify'
import { OUTCOME } from './outcomes'
import { createLogger, userText } from './logger'
import { exitBy } from './exitLog'
import { testQuiet } from './testQuiet'
import { installedCopy, runningIdentity } from './buildIdentity'
import { installDecision, updateDecision, type BuildIdentity } from '../shared/updates'
import { RELEASES_REPO } from '../shared/defaults'
import { HiveGitHubProvider } from './updateFeed'

const log = createLogger('updates')

const FIRST_CHECK_DELAY = 30_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

/**
 * The resources folder whose build identity and app are read (#1647): this build's own, or in an unpackaged test build
 * with a test feed the one HIVE_TEST_RESOURCES names (a stand-in installed copy).
 */
const resourcesDir = (): string => (!app.isPackaged && process.env.HIVE_UPDATE_FEED && process.env.HIVE_TEST_RESOURCES ? process.env.HIVE_TEST_RESOURCES : process.resourcesPath)
/** What this build is (#1647): a local build is never replaced by a release of its own version. */
let running: BuildIdentity = { version: app.getVersion(), commit: null, local: false }
const localOf = (b: BuildIdentity): UpdateState['local'] => (b.local ? { commit: b.commit } : undefined)
/** The same-version release last offered to a local build by a notice, so each is told once. */
let offered: string | null = null

let state: UpdateState = { status: 'idle', current: app.getVersion() }
let timer: ReturnType<typeof setInterval> | null = null
/** The first automatic check, 30 s after Hive starts: cancelled when automatic checks are turned off before it (HI-2324). */
let firstCheck: ReturnType<typeof setTimeout> | null = null
/** An automatic check (the first one, the 6-hourly one), which runs only while automatic checks are on (HI-2324). */
const autoCheck = (): void => {
  if (config.settings.updates.checkAutomatically) void check(false)
}
let restartForUpdate: () => void = () => undefined
/** The check in progress was started by the user, so its result is shown even if nothing is found. */
let manualCheck = false

function set(patch: Partial<UpdateState>, replace = false): void {
  state = replace ? ({ current: app.getVersion(), local: localOf(running), ...patch } as UpdateState) : { ...state, ...patch }
  emit({ type: 'update-state', state })
  // A Restart and Update offered for a version no longer the one ready loses its button (HI-2320).
  const ready = state.status === 'ready' ? `update:${state.version}` : null
  resolveOffers((o) => o.startsWith('update:') && o !== ready, tr(OUTCOME.notReady))
}

export function updateState(): UpdateState {
  return state
}

/**
 * Updates come from GitHub Releases (electron-updater reads latest.yml there and checks the
 * installer's SHA-512). Development builds never update, except in tests, which point
 * HIVE_UPDATE_FEED at a local server.
 */
const testFeed = (): string | undefined => (app.isPackaged ? undefined : process.env.HIVE_UPDATE_FEED)
/** The test download cache's folder in %LOCALAPPDATA%: hive-test-updater, or the one HIVE_UPDATE_CACHE names (an e2e lane's). */
const testCache = (): string => {
  const name = process.env.HIVE_UPDATE_CACHE ?? ''
  return /^hive-test-updater-[\w-]+$/.test(name) ? name : 'hive-test-updater'
}

/**
 * A packaged Hive a test started (HIVE_TEST_QUIET=1, testQuiet: the packaged suites, the Sandbox checks) never checks
 * GitHub for updates (#1332): each check fetches the release's latest.yml, which counts as a download there. The
 * installed app is never started with it.
 */
const packagedTestCopy = (): boolean => app.isPackaged && testQuiet()

function enabledReason(): string | null {
  if (packagedTestCopy()) return tr(msg({ id: 'main.update.testCopy', defaultMessage: "A test copy of Combwork doesn't check for updates.", description: 'Settings → Updates in a copy of Hive started by its tests, which never checks for updates.' }))
  if (app.isPackaged) return null
  if (testFeed()) return null
  return tr(msg({ id: 'main.update.devBuild', defaultMessage: 'Updates are checked by the installed app, not development builds.', description: 'Settings → Updates in a development build of Hive, which never updates.' }))
}

function applySettings(): void {
  const s = config.settings.updates
  // Downloads are started here rather than by electron-updater, so skipped versions and the
  // "download automatically" setting are honoured.
  autoUpdater.autoDownload = false
  // Hive installs on its own quit (installsOnQuit, at the end of index.ts' quit flow), only once the copy on disk is read
  // and older (#1647): electron-updater's own install on quit never runs.
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = s.prerelease
  autoUpdater.allowDowngrade = false
  log.info(`Update settings: check ${s.checkAutomatically ? 'on' : 'off'}, download ${s.downloadAutomatically ? 'auto' : 'manual'}, install ${s.install}, pre-releases ${s.prerelease ? 'on' : 'off'}`)
  if (timer) clearInterval(timer)
  timer = s.checkAutomatically && !enabledReason() ? setInterval(autoCheck, CHECK_INTERVAL) : null
  if (!s.checkAutomatically && firstCheck) {
    clearTimeout(firstCheck)
    firstCheck = null
  }
}

function notesOf(info: UpdateInfo): string | undefined {
  const n = info.releaseNotes
  if (!n) return undefined
  if (typeof n === 'string') return n
  return n.map((x) => (x.note ? `### ${x.version}\n\n${x.note}` : '')).filter(Boolean).join('\n\n')
}

function friendlyError(e: unknown): string {
  const said = String((e as Error)?.message ?? e)
  if (/\b404\b|not found|no published versions|unable to find latest version|cannot find latest\.yml/i.test(said)) return tr(msg({ id: 'main.update.noRelease', defaultMessage: 'No release of Combwork has been published yet.', description: 'Why checking for updates found none.' }))
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|net::ERR_/i.test(said)) return tr(msg({ id: 'main.update.offline', defaultMessage: "Couldn't reach GitHub to check for updates. Check your internet connection.", description: 'Why checking for updates failed. GitHub is a name.' }))
  if (/sha512|checksum/i.test(said)) return tr(msg({ id: 'main.update.checksum', defaultMessage: 'The downloaded update did not match its checksum and was discarded.', description: 'Why a downloaded update was thrown away.' }))
  return said.split('\n')[0].slice(0, 300)
}

const skipped = (version: string): boolean => config.get().skippedUpdate === version

export async function check(manual: boolean): Promise<UpdateState> {
  const reason = enabledReason()
  if (reason) {
    set({ status: 'disabled', error: reason }, true)
    return state
  }
  if (state.status === 'checking' || state.status === 'downloading') return state
  if (state.status === 'ready') {
    // Already downloaded; a manual check shows it again, with the installed copy read again (#1647: one unreadable a
    // moment ago, as another installer replaced it, may be readable and older now, and the update installable again).
    if (manual) {
      if (state.notInstalled) mayInstall()
      emit({ type: 'update-state', state })
    }
    return state
  }
  manualCheck = manual
  set({ status: 'checking', error: undefined, manual }, false)
  try {
    const r = await autoUpdater.checkForUpdates()
    if (!r || !r.isUpdateAvailable) {
      // A local build and a release of its own version (#1647): offered (its page), never downloaded or installed.
      const published = r?.updateInfo?.version
      const same = published && updateDecision(running, published) === 'offer' ? published : undefined
      set({ status: 'up-to-date', skipped: false, checkedAt: new Date().toISOString(), manual, published: same })
      if (same && !manual && offered !== same) {
        offered = same
        toast(
          'info',
          tr(msg({ id: 'main.update.sameVersion', defaultMessage: 'A published {app} {version} is available', description: "A notice: the user runs a local build (one they built themselves) of a version, and a published release of the same version exists. {app} is Hive's name." }), { app: APP_NAME, version: same }),
          tr(msg({ id: 'main.update.sameVersionBody', defaultMessage: "You're running a local build of {version}{hasCommit, select, yes { ({commit})} other {}}. Combwork doesn't install a release of the same version over it.", description: "The notice that a published release has the same version as the user's local build. {commit} is the commit it was built from." }), { version: same, hasCommit: running.commit ? 'yes' : 'no', commit: running.commit?.slice(0, 7) ?? '' }),
          [{ label: tr(msg({ id: 'main.update.openReleasePage', defaultMessage: 'Open Release Page', description: "The notice's button: opens that release's page on GitHub in the browser (it doesn't install anything)." })), command: 'update.releaseNotes', args: [same] }]
        )
      }
    }
    // Otherwise the update-available handler has set the state (and maybe started the download).
  } catch (e) {
    log.warn('Update check failed', e)
    set({ status: 'error', error: friendlyError(e), checkedAt: new Date().toISOString(), manual })
  }
  return state
}

export async function download(): Promise<void> {
  if (state.status !== 'available') return
  set({ status: 'downloading', progress: { percent: 0, transferred: 0, total: state.size ?? 0, bytesPerSecond: 0 }, error: undefined })
  try {
    await autoUpdater.downloadUpdate()
  } catch (e) {
    log.warn('Update download failed', e)
    set({ status: 'error', error: friendlyError(e), progress: undefined })
  }
}

/** Remembers a version the user doesn't want; automatic checks stop offering it. */
export function skip(version: string): void {
  config.update((c) => {
    c.skippedUpdate = version
  })
  if (state.version === version && state.status === 'available') set({ status: 'up-to-date', skipped: true })
}

/**
 * Whether the downloaded update may be installed now (#1647): the copy installed on disk read now, and the update newer
 * by semver. Never when that copy can't be read (it may be a newer local build, installed meanwhile), nor over a copy of
 * its version or newer; the state then says why, for Settings → Updates and the dialog.
 */
function mayInstall(): boolean {
  const copy = installedCopy(resourcesDir())
  const d = installDecision(copy, state.version ?? '')
  if (d.install) {
    // A refusal earlier (a copy unreadable then) no longer holds.
    if (state.notInstalled) set({ notInstalled: undefined })
    return true
  }
  // What the read said quotes the install folder's path (a folder the user chose): their text, left out of diagnostics.
  const why = copy.kind === 'unreadable' ? `the installed copy couldn't be read (${userText(copy.why)})` : `the installed copy is ${copy.identity.version}${copy.identity.local ? ', a local build' : ''}` // i18n-ignore: the log line
  log.warn(`Not installing ${state.version}: ${why}`)
  set({ notInstalled: d.why })
  return false
}

/** Restart and Update: quit through the normal flow (which asks if agents are working), then install. */
export function restartAndInstall(version?: string): void {
  // Checked again (HI-2320): only the version its notice offered, while it is the one ready.
  if (state.status !== 'ready' || (version !== undefined && state.version !== version)) {
    if (version !== undefined) resolveOffer(`update:${version}`, tr(OUTCOME.notReady))
    return
  }
  if (!mayInstall()) {
    toast('warning', tr(msg({ id: 'main.update.notInstalled', defaultMessage: "{app} {version} wasn't installed", description: "A notice: the user chose Restart and Update, and Hive didn't install the downloaded update. {app} is Hive's name." }), { app: APP_NAME, version: state.version ?? '' }), notInstalledText())
    return
  }
  // Its notice keeps its button until the quit goes ahead (HI-2425): the quit may still ask, and Cancel leaves Hive
  // and the offer as they were. markInstalling() says Installing once it does.
  restartForUpdate()
}

/** The quit is going ahead and installs the update (HI-2425): its notice says so in place of Restart and Update. */
export function markInstalling(): void {
  if (state.status === 'ready' && state.version) resolveOffer(`update:${state.version}`, tr(OUTCOME.installing))
}

/** Why a downloaded update isn't installed, for the notice. */
function notInstalledText(): string {
  return state.notInstalled === 'unreadable'
    ? tr(msg({ id: 'main.update.notInstalledUnreadable', defaultMessage: "Combwork couldn't read the copy installed on this computer, so it didn't replace it. Try again once any other Combwork installer has finished.", description: 'Why Hive did not install a downloaded update: it could not read the installed copy (another installer may be replacing it).' }))
    : tr(msg({ id: 'main.update.notInstalledNotNewer', defaultMessage: 'The copy installed on this computer is the same version or newer (a local build, say).', description: 'Why Hive did not install a downloaded update: what is installed is not older than it.' }))
}

/** Whether Hive's quit installs the downloaded update: Install is automatic, and it may be installed now (mayInstall). */
export function installsOnQuit(): boolean {
  return state.status === 'ready' && config.settings.updates.install === 'auto' && mayInstall()
}

/**
 * Called at the very end of quitting (index.ts' quit flow, so never for a quit the user cancelled): Restart and Update
 * (`restart`) installs and opens Hive again; Install automatically, without. Checked again first (mayInstall): the copy
 * on disk read now, and Hive quits without installing when it may not.
 */
export function installNow(restart = true): void {
  if (!mayInstall()) {
    exitBy('app.quit', 'quitting without the update (the installed copy is newer or unreadable)', () => app.quit())
    return
  }
  if (testFeed()) {
    log.info(`Test mode: would install ${state.version}${restart ? ' and restart' : ' (on quit)'}`)
    exitBy('app.quit', 'the update would be installed (test feed)', () => app.quit())
    return
  }
  log.info(`Installing ${state.version}${restart ? ' and restarting' : ' on quit'}`)
  exitBy('autoUpdater.quitAndInstall', 'installing the update', () => autoUpdater.quitAndInstall(true, restart))
}

export function initUpdater(opts: { restart: () => void }): void {
  restartForUpdate = opts.restart
  running = app.isPackaged || testFeed() ? runningIdentity(app.getVersion(), resourcesDir()) : running
  state = { ...state, local: localOf(running) }
  autoUpdater.logger = { info: (m: unknown) => log.info(String(m)), warn: (m: unknown) => log.warn(String(m)), error: (m: unknown) => log.error(String(m)), debug: () => undefined }

  const feed = testFeed()
  if (feed) {
    // Tests: a generic feed, with its own download cache so the installed Hive's is never touched.
    const file = join(app.getPath('userData'), 'test-app-update.yml')
    writeFileSync(file, `provider: generic\nurl: ${feed}\nupdaterCacheDirName: ${testCache()}\n`) // i18n-ignore: a file's content, not text
    autoUpdater.updateConfigPath = file
    autoUpdater.forceDevUpdateConfig = true
  } else if (app.isPackaged) {
    // GitHub's releases through Hive's provider (HI-2311): with pre-releases on, a pre-release install is offered the
    // newest version newer by semver (beta, RC or release), not only a later one of its own pre-release name.
    autoUpdater.setFeedURL({ provider: 'custom', updateProvider: HiveGitHubProvider, ...RELEASES_REPO })
  }

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    const isSkipped = skipped(info.version)
    if (isSkipped && !manualCheck) {
      set({ status: 'up-to-date', skipped: true, checkedAt: new Date().toISOString() })
      return
    }
    set({
      status: 'available',
      version: info.version,
      releaseName: info.releaseName ?? undefined,
      releaseNotes: notesOf(info),
      releaseDate: info.releaseDate,
      size: info.files?.[0]?.size,
      skipped: isSkipped,
      checkedAt: new Date().toISOString(),
      progress: undefined,
      published: undefined,
      notInstalled: undefined
    })
    if (config.settings.updates.downloadAutomatically && !isSkipped) void download()
  })
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    set({ status: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond } })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    set({ status: 'ready', version: info.version, progress: undefined })
    // Not "ready to install" over a copy it won't replace (#1647): the state says why instead.
    if (!mayInstall()) return
    const auto = config.settings.updates.install === 'auto'
    toast(
      'info',
      tr(msg({ id: 'main.update.ready', defaultMessage: '{app} {version} is ready', description: "A notice: an update was downloaded. {app} is Hive's name, {version} the new version." }), { app: APP_NAME, version: info.version }),
      auto ? tr(msg({ id: 'main.update.readyAuto', defaultMessage: 'It installs when you quit Combwork, or restart now.', description: 'The notice that an update is ready, with updates installed automatically.' })) : tr(msg({ id: 'main.update.readyManual', defaultMessage: 'Restart Combwork to install it.', description: 'The notice that an update is ready, with updates installed manually.' })),
      [{ label: tr(msg({ id: 'main.update.restart', defaultMessage: 'Restart and Update', description: "The notice's button: restarts Hive and installs the update." })), command: 'update.install', args: [info.version] }],
      undefined,
      undefined,
      // Its offer (HI-2320): this version, while it is the one ready.
      { offer: `update:${info.version}` }
    )
  })

  applySettings()
  config.onSettingsChanged((s, prev) => {
    if (JSON.stringify(s.updates) === JSON.stringify(prev.updates)) return
    applySettings()
    if (s.updates.checkAutomatically && !prev.updates.checkAutomatically) void check(false)
  })

  const reason = enabledReason()
  if (packagedTestCopy()) log.info('A test copy (HIVE_TEST_QUIET=1): no update checks, automatic or manual')
  if (reason) set({ status: 'disabled', error: reason }, true)
  else if (config.settings.updates.checkAutomatically) {
    firstCheck = setTimeout(() => {
      firstCheck = null
      autoCheck()
    }, Number(process.env.HIVE_UPDATE_DELAY) || FIRST_CHECK_DELAY)
  }

  noticeUpdated()
}

/** After an update: a notification pointing at the release notes, once. */
function noticeUpdated(): void {
  const current = app.getVersion()
  const last = config.get().lastRunVersion
  if (last !== current) {
    config.update((c) => {
      c.lastRunVersion = current
      if (c.skippedUpdate && c.skippedUpdate === current) c.skippedUpdate = undefined
    })
  }
  if (!last || last === current || !app.isPackaged) return
  setTimeout(
    () =>
      toast('success', tr(msg({ id: 'main.update.updated', defaultMessage: '{app} updated to {version}', description: 'A notice after Hive was updated. {app} is its name, {version} the new version.' }), { app: APP_NAME, version: current }), tr(msg({ id: 'main.update.updatedBody', defaultMessage: 'See what changed in this version.', description: 'The notice after Hive was updated.' })), [
        { label: tr(msg({ id: 'main.update.whatsNew', defaultMessage: "What's New", description: "The notice's button: opens the release notes." })), command: 'update.releaseNotes', args: [current] }
      ]),
    4000
  )
}
