import { RELEASES_URL } from '@shared/defaults'
import type { UpdateState } from '@shared/types'
import { formatDate } from '@shared/dates'
import { APP_NAME, appName } from '@shared/appName'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { set, useStore } from '../store'
import { cx, formatKeybinding, timeAgo } from '../util'
import { Icon, Markdown, Modal, Tooltip } from './ui'
import { M as TEAM, TeamPauseBand, pauseTheTeam, useTeamPaused } from './TeamPause'
import { useTeamPause } from '../teamPause'
import { msg, tr } from '@shared/i18n'

const M = {
  mb: msg({ id: 'workspace.updates.mb', defaultMessage: '{mb, number, ::.0} MB', description: 'A size in megabytes (an update\'s download). Keep MB unless your language writes it otherwise.' }),
  off: msg({ id: 'workspace.updates.off', defaultMessage: 'Updates are off in this build.', description: "Combwork's updates, in Settings → Updates and About: this build doesn't update itself." }),
  checking: msg({ id: 'workspace.updates.checking', defaultMessage: 'Checking for updates…', description: "Combwork's updates: a check is running." }),
  available: msg({ id: 'workspace.updates.available', defaultMessage: '{skipped, select, yes {Version {version} is available (skipped).} other {Version {version} is available.}}', description: "Combwork's updates, in Settings → Updates and About: a newer version; (skipped) when you chose Skip This Version." }),
  downloading: msg({ id: 'workspace.updates.downloading', defaultMessage: 'Downloading version {version}… {percent, number, ::percent}', description: "Combwork's updates: the download's progress." }),
  ready: msg({ id: 'workspace.updates.ready', defaultMessage: 'Version {version} is ready to install.', description: "Combwork's updates: downloaded, installed on restart." }),
  upToDate: msg({ id: 'workspace.updates.upToDate', defaultMessage: '{checked, select, yes {Up to date, checked {when}.} other {Up to date.}}', description: "Combwork's updates: no newer version ({when}: \"4 minutes ago\")." }),
  failed: msg({ id: 'workspace.updates.failed', defaultMessage: 'The last check failed.', description: "Combwork's updates: the last check didn't work." }),
  notChecked: msg({ id: 'workspace.updates.notChecked', defaultMessage: 'Not checked yet.', description: "Combwork's updates: no check since Combwork started." }),
  itemAvailable: msg({ id: 'workspace.updates.itemAvailable', defaultMessage: '{app} {version} available', description: "The status bar: a newer Combwork ({app}: Combwork's name) can be downloaded. Keep it short." }),
  itemDownloading: msg({ id: 'workspace.updates.itemDownloading', defaultMessage: 'Downloading {app} {version}… {percent, number, ::percent}', description: "The status bar: Combwork's update downloading. Keep it short." }),
  itemReady: msg({ id: 'workspace.updates.itemReady', defaultMessage: 'Restart to update to {version}', description: "The status bar: Combwork's update is downloaded. Keep it short." }),
  tipReady: msg({ id: 'workspace.updates.tipReady', defaultMessage: "{app} {version} has been downloaded. Click to see what's new and restart.", description: "Tooltip on the status bar's update item." }),
  tipHave: msg({ id: 'workspace.updates.tipHave', defaultMessage: 'You have {app} {version}. Click for details.', description: "Tooltip on the status bar's update item." }),
  versionTip: msg({ id: 'workspace.updates.versionTip', defaultMessage: '{app} {version}{dev, select, yes { (development build)} other {}} · Electron {electron}{hasSummary, select, yes { · {summary}} other {}}', description: "Tooltip on the status bar's version: Combwork's version, Electron's, and the update state ({summary}). Keep Electron as it is." }),
  titleReady: msg({ id: 'workspace.updates.titleReady', defaultMessage: 'Update Ready', description: "The update dialog's title: Combwork's update is downloaded." }),
  titleAvailable: msg({ id: 'workspace.updates.titleAvailable', defaultMessage: 'Update Available', description: "The update dialog's title: a newer Combwork." }),
  titleSoftware: msg({ id: 'workspace.updates.titleSoftware', defaultMessage: 'Software Update', description: "The update dialog's title otherwise." }),
  ok: msg({ id: 'workspace.updates.ok', defaultMessage: 'OK', description: "The update dialog's button that closes it." }),
  latest: msg({ id: 'workspace.updates.latest', defaultMessage: '{app} {version} is the latest version.', description: 'The update dialog: no newer Combwork.' }),
  releasesPage: msg({ id: 'workspace.updates.releasesPage', defaultMessage: 'Releases Page', description: "The update dialog after a failed check: opens Combwork's releases on GitHub." }),
  tryAgain: msg({ id: 'workspace.updates.tryAgain', defaultMessage: 'Try Again', description: 'The update dialog after a failed check: checks again.' }),
  headReady: msg({ id: 'workspace.updates.headReady', defaultMessage: '{app} {version} is ready to install', description: 'The update dialog\'s heading: the update is downloaded.' }),
  headAvailable: msg({ id: 'workspace.updates.headAvailable', defaultMessage: '{app} {version} is available', description: "The update dialog's heading: a newer Combwork." }),
  youHave: msg({ id: 'workspace.updates.youHave', defaultMessage: 'You have {version}', description: 'The update dialog, under its heading: the version installed (released and size follow).' }),
  released: msg({ id: 'workspace.updates.released', defaultMessage: 'released {date}', description: "The update dialog, under its heading: when the new version was released. Lower case: it follows a ·." }),
  progress: msg({ id: 'workspace.updates.progress', defaultMessage: '{percent, number, ::percent} · {done} of {total}', description: "The update dialog: the download's progress ({done}, {total}: sizes in MB)." }),
  perSecond: msg({ id: 'workspace.updates.perSecond', defaultMessage: '{size}/s', description: "The update dialog: the download's speed ({size}: \"1.2 MB\")." }),
  noNotes: msg({ id: 'workspace.updates.noNotes', defaultMessage: 'No release notes were published with this version.', description: 'The update dialog when the release has no notes.' }),
  readyNote: msg({ id: 'workspace.updates.readyNote', defaultMessage: '{auto, select, yes {It installs automatically when you quit Combwork. } other {}}Restart and Update closes Combwork, installs the update and opens Combwork again.{busy, select, yes { Some agents are busy: Combwork asks before stopping them, and you can wait for them to finish.} other { Running sessions are stopped and can be resumed afterwards.}}', description: 'The update dialog when the update is downloaded. Restart and Update is its button.' }),
  onGitHub: msg({ id: 'workspace.updates.onGitHub', defaultMessage: 'On GitHub', description: "The update dialog's button: the release on GitHub." }),
  skip: msg({ id: 'workspace.updates.skip', defaultMessage: 'Skip This Version', description: "The update dialog's button: don't offer this version again." }),
  later: msg({ id: 'workspace.updates.later', defaultMessage: 'Later', description: "The update dialog's button that closes it for now." }),
  download: msg({ id: 'workspace.updates.download', defaultMessage: 'Download', description: "The update dialog's button: downloads the update." }),
  restartUpdate: msg({ id: 'workspace.updates.restartUpdate', defaultMessage: 'Restart and Update', description: "The update dialog's button: installs the downloaded update." }),
  details: msg({ id: 'workspace.updates.details', defaultMessage: 'Details', description: 'Settings → Updates: opens the update dialog.' }),
  checkTip: msg({ id: 'workspace.updates.checkTip', defaultMessage: '{hasKey, select, yes {Check GitHub for a newer Combwork now ({key})} other {Check GitHub for a newer Combwork now}}', description: 'Tooltip on Check Now, with its shortcut ({key}).' }),
  checkNow: msg({ id: 'workspace.updates.checkNow', defaultMessage: 'Check Now', description: 'Settings → Updates and About: checks for a newer Combwork.' }),
  localBuild: msg({ id: 'workspace.updates.localBuild', defaultMessage: 'Local build {version}{hasCommit, select, yes { ({commit})} other {}}', description: 'Settings → Updates and About: the running Combwork is a local build (one built on this computer with npm run dist, not a published release), with the commit it was built from.' }),
  published: msg({ id: 'workspace.updates.published', defaultMessage: 'A published {version} is available. Combwork doesn’t install a release of the same version over your local build.', description: "Combwork's updates: the user runs a local build, and a published release of the same version exists; it is offered (its page), never installed by itself." }),
  openReleasePage: msg({ id: 'workspace.updates.openReleasePage', defaultMessage: 'Open Release Page', description: "The update dialog's button: opens that release's page on GitHub in the browser (it doesn't install anything)." }),
  notInstalledUnreadable: msg({ id: 'workspace.updates.notInstalledUnreadable', defaultMessage: "Version {version} is downloaded, but Combwork couldn't read the copy installed on this computer, so it won't replace it.", description: "Combwork's updates: a downloaded update isn't installed, since the installed copy couldn't be read (another installer may be replacing it)." }),
  notInstalledNotNewer: msg({ id: 'workspace.updates.notInstalledNotNewer', defaultMessage: "Version {version} is downloaded, but the copy installed on this computer is the same version or newer, so Combwork won't install it.", description: "Combwork's updates: a downloaded update isn't installed, since what is installed (a local build, say) isn't older." })
}

const mb = (bytes?: number): string => (bytes ? tr(M.mb, { mb: bytes / 1024 / 1024 }) : '')

/** Checks now and shows the result in the update dialog. */
export async function checkForUpdates(): Promise<void> {
  set({ updateOpen: true })
  set({ update: await call('update:check') })
}

export function openReleaseNotes(version?: string): void {
  void call('app:openExternal', version ? `${RELEASES_URL}/tag/v${version}` : RELEASES_URL)
}

/** One line describing the update state, for Settings and About. */
export function updateSummary(u: UpdateState | null): string {
  if (!u) return ''
  switch (u.status) {
    case 'disabled':
      return u.error ?? tr(M.off)
    case 'checking':
      return tr(M.checking)
    case 'available':
      return tr(M.available, { skipped: u.skipped ? 'yes' : 'no', version: u.version ?? '' })
    case 'downloading':
      return tr(M.downloading, { version: u.version ?? '', percent: Math.round(u.progress?.percent ?? 0) / 100 })
    case 'ready':
      if (u.notInstalled) return tr(u.notInstalled === 'unreadable' ? M.notInstalledUnreadable : M.notInstalledNotNewer, { version: u.version ?? '' })
      return tr(M.ready, { version: u.version ?? '' })
    case 'up-to-date':
      if (u.published) return tr(M.published, { version: u.published })
      return tr(M.upToDate, { checked: u.checkedAt ? 'yes' : 'no', when: u.checkedAt ? timeAgo(u.checkedAt) : '' })
    case 'error':
      return u.error ?? tr(M.failed)
    default:
      return tr(M.notChecked)
  }
}

/** Combwork's mark as a line drawing in the text colour (hexagon, prompt and cursor), like the status bar's other icons. */
export function CombworkMark({ className = 'status-hex' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="478,256 367,448 145,448 34,256 145,64 367,64" />
      <polyline points="170,190 246,256 170,322" />
      <line x1="280" y1="322" x2="348" y2="322" />
    </svg>
  )
}

/** The status bar's version item: plain when there is nothing new, otherwise what the update is doing. */
export function UpdateStatusItem() {
  const info = useStore((s) => s.appInfo)
  const u = useStore((s) => s.update)
  if (!info) return null
  const label = `${appName(info.isPackaged)} ${info.version}`
  const open = (): void => set({ updateOpen: true })
  // A downloaded update Combwork won't install (#1647: the installed copy isn't older, or unreadable) isn't offered here.
  if (u && !u.skipped && (u.status === 'available' || u.status === 'downloading' || (u.status === 'ready' && !u.notInstalled))) {
    const version = u.version ?? ''
    const text = u.status === 'available' ? tr(M.itemAvailable, { app: APP_NAME, version }) : u.status === 'downloading' ? tr(M.itemDownloading, { app: APP_NAME, version, percent: Math.round(u.progress?.percent ?? 0) / 100 }) : tr(M.itemReady, { version })
    const tip = u.status === 'ready' ? tr(M.tipReady, { app: APP_NAME, version }) : tr(M.tipHave, { app: APP_NAME, version: info.version })
    return (
      <Tooltip content={tip}>
        <div className={cx('status-item update-item', u.status === 'ready' && 'ready')} onClick={open}>
          <Icon name={u.status === 'downloading' ? 'loading' : u.status === 'ready' ? 'debug-restart' : 'cloud-download'} spin={u.status === 'downloading'} /> {text}
        </div>
      </Tooltip>
    )
  }
  return (
    <Tooltip content={tr(M.versionTip, { app: APP_NAME, version: info.version, dev: info.isPackaged ? 'no' : 'yes', electron: info.electron, hasSummary: u && u.status !== 'disabled' ? 'yes' : 'no', summary: u && u.status !== 'disabled' ? updateSummary(u) : '' })}>
      <div className="status-item" onClick={() => set({ aboutOpen: true })}>
        {u?.status === 'checking' ? <Icon name="loading" spin /> : <CombworkMark />} {label}
      </div>
    </Tooltip>
  )
}

export function UpdateDialog() {
  const open = useStore((s) => s.updateOpen)
  const u = useStore((s) => s.update)
  const settings = useStore((s) => s.settings)
  const working = useStore((s) => s.workspace?.projects.some((p) => p.agents.some((a) => a.live?.status === 'working' || a.live?.status === 'waiting' || a.live?.status === 'background')) ?? false)
  // The team paused for it (HI-2081): its band here, and Install Now (checked again in main) in place of Restart and Update.
  const paused = useTeamPaused()
  const allParked = useTeamPause((s) => !!s.state?.allParked)
  if (!open || !u) return null
  const close = (): void => set({ updateOpen: false })
  const auto = settings?.updates.install === 'auto'
  const title = tr(u.status === 'ready' ? M.titleReady : u.status === 'available' || u.status === 'downloading' ? M.titleAvailable : M.titleSoftware)

  let body: React.ReactNode
  let footer: React.ReactNode = (
    <button className="btn primary" onClick={close}>
      {tr(M.ok)}
    </button>
  )
  switch (u.status) {
    case 'checking':
    case 'idle':
      body = (
        <p className="update-line">
          <Icon name="loading" spin /> {tr(M.checking)}
        </p>
      )
      break
    case 'up-to-date':
      body = u.published ? (
        <p className="update-line">
          <Icon name="info" /> {tr(M.published, { version: u.published })}
        </p>
      ) : (
        <p className="update-line">
          <Icon name="pass-filled" className="ok" /> {tr(M.latest, { app: APP_NAME, version: u.current })}
        </p>
      )
      if (u.published) {
        const published = u.published
        footer = (
          <>
            <button className="btn subtle" onClick={() => openReleaseNotes(published)}>
              <Icon name="link-external" /> {tr(M.openReleasePage)}
            </button>
            <button className="btn primary" onClick={close}>
              {tr(M.ok)}
            </button>
          </>
        )
      }
      break
    case 'disabled':
      body = (
        <p className="update-line">
          <Icon name="info" /> {u.error}
        </p>
      )
      break
    case 'error':
      body = (
        <p className="update-line">
          <Icon name="warning" className="warn" /> {u.error}
        </p>
      )
      footer = (
        <>
          <button className="btn subtle" onClick={() => openReleaseNotes()}>
            {tr(M.releasesPage)}
          </button>
          <button className="btn subtle" onClick={() => void checkForUpdates()}>
            {tr(M.tryAgain)}
          </button>
          <button className="btn primary" onClick={close}>
            {tr(M.ok)}
          </button>
        </>
      )
      break
    default: {
      const pct = Math.round(u.progress?.percent ?? 0)
      body = (
        <>
          <div className="update-head">
            <Icon name={u.status === 'ready' ? 'debug-restart' : 'cloud-download'} />
            <div>
              <strong>
                {tr(u.status === 'ready' ? M.headReady : M.headAvailable, { app: APP_NAME, version: u.version ?? '' })}
                {u.releaseName && u.releaseName !== u.version && u.releaseName !== `v${u.version}` ? ` — ${u.releaseName}` : ''}
              </strong>
              <div className="faint">
                {tr(M.youHave, { version: u.current })}
                {u.releaseDate ? ` · ${tr(M.released, { date: formatDate(u.releaseDate) })}` : ''}
                {u.size ? ` · ${mb(u.size)}` : ''}
              </div>
            </div>
          </div>
          {u.status === 'downloading' && (
            <div className="update-progress">
              <div className="bar">
                <span style={{ width: `${pct}%` }} />
              </div>
              <span className="faint">
                {tr(M.progress, { percent: pct / 100, done: mb(u.progress?.transferred), total: mb(u.progress?.total || u.size) })}
                {u.progress?.bytesPerSecond ? ` · ${tr(M.perSecond, { size: mb(u.progress.bytesPerSecond) })}` : ''}
              </span>
            </div>
          )}
          {u.releaseNotes ? (
            <div className="update-notes">
              <Markdown source={u.releaseNotes} />
            </div>
          ) : (
            <p className="faint">{tr(M.noNotes)}</p>
          )}
          {u.status === 'ready' && u.notInstalled && <p className="update-note">{updateSummary(u)}</p>}
          {u.status === 'ready' && !u.notInstalled && (
            <p className="faint update-note">
              {tr(M.readyNote, { auto: auto ? 'yes' : 'no', busy: working ? 'yes' : 'no' })}
            </p>
          )}
        </>
      )
      footer = (
        <>
          <button className="btn subtle" onClick={() => openReleaseNotes(u.version)}>
            <Icon name="link-external" /> {tr(M.onGitHub)}
          </button>
          {u.status === 'available' && !u.skipped && (
            <button
              className="btn subtle"
              onClick={() => {
                void call('update:skip', u.version!)
                close()
              }}
            >
              {tr(M.skip)}
            </button>
          )}
          <button className="btn subtle" onClick={close}>
            {tr(M.later)}
          </button>
          {u.status === 'available' && (
            <button className="btn primary" onClick={() => void call('update:download')}>
              <Icon name="cloud-download" /> {tr(M.download)}
            </button>
          )}
          {u.status === 'ready' && !paused && working && (
            <button className="btn" onClick={() => void pauseTheTeam()}>
              <Icon name="debug-pause" /> {tr(TEAM.pauseFirst)}
            </button>
          )}
          {u.status === 'ready' && paused && (
            <button
              className="btn primary"
              disabled={!allParked}
              onClick={() => {
                void call('team:install').then((r) => {
                  if (r.installed) close()
                })
              }}
            >
              <Icon name="debug-restart" /> {tr(TEAM.install)}
            </button>
          )}
          {u.status === 'ready' && !paused && (
            <button
              className="btn primary"
              onClick={() => {
                close()
                void call('update:install')
              }}
            >
              <Icon name="debug-restart" /> {tr(M.restartUpdate)}
            </button>
          )}
        </>
      )
    }
  }
  return (
    <Modal title={title} icon="cloud-download" onClose={close} footer={footer} wide={!!u.releaseNotes && ['available', 'downloading', 'ready'].includes(u.status)}>
      {u.status === 'ready' && paused && <TeamPauseBand />}
      <div className="update-dialog">{body}</div>
    </Modal>
  )
}

/** Status and a Check button, for Settings → Updates and About. */
export function UpdateStatusRow() {
  const u = useStore((s) => s.update)
  const kb = commandKeybinding('help.checkUpdates')
  return (
    <div className="flex update-status-row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {u?.local && <span className="faint">{tr(M.localBuild, { version: u.current, hasCommit: u.local.commit ? 'yes' : 'no', commit: u.local.commit?.slice(0, 7) ?? '' })}</span>}
      <span className={cx('badge', u?.status === 'ready' || u?.status === 'available' ? 'accent' : u?.status === 'up-to-date' && !u.published ? 'success' : u?.status === 'error' ? 'error' : '')}>{updateSummary(u)}</span>
      {(u?.status === 'available' || u?.status === 'downloading' || u?.status === 'ready') && (
        <button className="btn small primary" onClick={() => set({ updateOpen: true })}>
          {tr(M.details)}
        </button>
      )}
      <Tooltip content={tr(M.checkTip, { hasKey: kb ? 'yes' : 'no', key: kb ? formatKeybinding(kb) : '' })}>
        <button className="btn small subtle" disabled={u?.status === 'disabled' || u?.status === 'checking' || u?.status === 'downloading'} onClick={() => void checkForUpdates()}>
          {tr(M.checkNow)}
        </button>
      </Tooltip>
    </div>
  )
}
