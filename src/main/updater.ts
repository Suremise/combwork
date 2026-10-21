import { msg, tr } from '../shared/i18n'
import { app } from 'electron'
import { writeFileSync } from 'original-fs'
import { join } from 'path'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '../shared/types'
import { APP_NAME } from '../shared/appName'
import { config } from './config'
import { emit, toast } from './events'
import { createLogger } from './logger'
import { exitBy } from './exitLog'
import { testQuiet } from './testQuiet'

const log = createLogger('updates')

const FIRST_CHECK_DELAY = 30_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

let state: UpdateState = { status: 'idle', current: app.getVersion() }
let timer: ReturnType<typeof setInterval> | null = null
let restartForUpdate: () => void = () => undefined
/** The check in progress was started by the user, so its result is shown even if nothing is found. */
let manualCheck = false

function set(patch: Partial<UpdateState>, replace = false): void {
  state = replace ? { current: app.getVersion(), ...patch } as UpdateState : { ...state, ...patch }
  emit({ type: 'update-state', state })
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
  if (packagedTestCopy()) return tr(msg({ id: 'main.update.testCopy', defaultMessage: "A test copy of Hive doesn't check for updates.", description: 'Settings → Updates in a copy of Hive started by its tests, which never checks for updates.' }))
  if (app.isPackaged) return null
  if (testFeed()) return null
  return tr(msg({ id: 'main.update.devBuild', defaultMessage: 'Updates are checked by the installed app, not development builds.', description: 'Settings → Updates in a development build of Hive, which never updates.' }))
}

function applySettings(): void {
  const s = config.settings.updates
  // Downloads are started here rather than by electron-updater, so skipped versions and the
  // "download automatically" setting are honoured.
  autoUpdater.autoDownload = false
  // Test builds (HIVE_UPDATE_FEED) never run what they download.
  autoUpdater.autoInstallOnAppQuit = s.install === 'auto' && !testFeed()
  autoUpdater.allowPrerelease = s.prerelease
  autoUpdater.allowDowngrade = false
  log.info(`Update settings: check ${s.checkAutomatically ? 'on' : 'off'}, download ${s.downloadAutomatically ? 'auto' : 'manual'}, install ${s.install}, pre-releases ${s.prerelease ? 'on' : 'off'}`)
  if (timer) clearInterval(timer)
  timer = s.checkAutomatically && !enabledReason() ? setInterval(() => void check(false), CHECK_INTERVAL) : null
}

function notesOf(info: UpdateInfo): string | undefined {
  const n = info.releaseNotes
  if (!n) return undefined
  if (typeof n === 'string') return n
  return n.map((x) => (x.note ? `### ${x.version}\n\n${x.note}` : '')).filter(Boolean).join('\n\n')
}

function friendlyError(e: unknown): string {
  const said = String((e as Error)?.message ?? e)
  if (/\b404\b|not found|no published versions|unable to find latest version|cannot find latest\.yml/i.test(said)) return tr(msg({ id: 'main.update.noRelease', defaultMessage: 'No release of Hive has been published yet.', description: 'Why checking for updates found none.' }))
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
    // Already downloaded; a manual check just shows it again.
    if (manual) emit({ type: 'update-state', state })
    return state
  }
  manualCheck = manual
  set({ status: 'checking', error: undefined, manual }, false)
  try {
    const r = await autoUpdater.checkForUpdates()
    if (!r || !r.isUpdateAvailable) set({ status: 'up-to-date', skipped: false, checkedAt: new Date().toISOString(), manual })
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

/** Restart and Update: quit through the normal flow (which asks if agents are working), then install. */
export function restartAndInstall(): void {
  if (state.status !== 'ready') return
  restartForUpdate()
}

/** Called at the very end of quitting when the user chose Restart and Update. */
export function installNow(): void {
  if (testFeed()) {
    log.info(`Test mode: would install ${state.version} and restart`)
    exitBy('app.quit', 'the update would be installed (test feed)', () => app.quit())
    return
  }
  log.info(`Installing ${state.version} and restarting`)
  exitBy('autoUpdater.quitAndInstall', 'installing the update', () => autoUpdater.quitAndInstall(true, true))
}

export function initUpdater(opts: { restart: () => void }): void {
  restartForUpdate = opts.restart
  autoUpdater.logger = { info: (m: unknown) => log.info(String(m)), warn: (m: unknown) => log.warn(String(m)), error: (m: unknown) => log.error(String(m)), debug: () => undefined }

  const feed = testFeed()
  if (feed) {
    // Tests: a generic feed, with its own download cache so the installed Hive's is never touched.
    const file = join(app.getPath('userData'), 'test-app-update.yml')
    writeFileSync(file, `provider: generic\nurl: ${feed}\nupdaterCacheDirName: ${testCache()}\n`) // i18n-ignore: a file's content, not text
    autoUpdater.updateConfigPath = file
    autoUpdater.forceDevUpdateConfig = true
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
      progress: undefined
    })
    if (config.settings.updates.downloadAutomatically && !isSkipped) void download()
  })
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    set({ status: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond } })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    set({ status: 'ready', version: info.version, progress: undefined })
    const auto = config.settings.updates.install === 'auto'
    toast(
      'info',
      tr(msg({ id: 'main.update.ready', defaultMessage: '{app} {version} is ready', description: "A notice: an update was downloaded. {app} is Hive's name, {version} the new version." }), { app: APP_NAME, version: info.version }),
      auto ? tr(msg({ id: 'main.update.readyAuto', defaultMessage: 'It installs when you quit Hive, or restart now.', description: 'The notice that an update is ready, with updates installed automatically.' })) : tr(msg({ id: 'main.update.readyManual', defaultMessage: 'Restart Hive to install it.', description: 'The notice that an update is ready, with updates installed manually.' })),
      [{ label: tr(msg({ id: 'main.update.restart', defaultMessage: 'Restart and Update', description: "The notice's button: restarts Hive and installs the update." })), command: 'update.install' }]
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
  else if (config.settings.updates.checkAutomatically) setTimeout(() => void check(false), Number(process.env.HIVE_UPDATE_DELAY) || FIRST_CHECK_DELAY)

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
