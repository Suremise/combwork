import { Children, useCallback, useEffect, useRef, useState } from 'react'
import { DEV_DRIVE_URL, KIND_LABEL, type AntivirusStatus, type AvAction, type AvChangeResult, type AvDevDrive, type AvPath } from '@shared/antivirus'
import { formatDateTime } from '@shared/dates'
import { call, errorMessage } from '../api'
import { confirm, get, pushToast, set, setActivity, useStore } from '../store'
import { awayFromProject } from '../agentPlace'
import { resolveLocal } from '../entryConditions'
import { cx, timeAgo } from '../util'
import { Icon, LoadFailed } from './ui'
import { fmt, msg, tr, tRich, type Msg } from '@shared/i18n'

/**
 * Antivirus scanning of the workspace (#316; main/antivirus.ts): whether Microsoft Defender scans the folders Hive's work
 * goes through, the exclusions Hive can add (with consent, one UAC prompt) and remove, and Dev Drive. Settings →
 * Workspace shows it in full; Performance says when scanning likely slows the workspace; the window suggests it once
 * when it matters. Answers for a workspace the window no longer shows are dropped.
 */

/** How a folder's scanning is worded and coloured, here and in Repair's Defender rows (#1302). */
export const AV_STATE: Record<AvPath['state'], { label: Msg; tone: string; tip: Msg }> = {
  excluded: { label: msg({ id: 'workspace.antivirus.stateExcluded', defaultMessage: 'Excluded', description: "A folder's scanning in Settings → Workspace's antivirus table: Defender skips it." }), tone: 'good-text', tip: msg({ id: 'workspace.antivirus.stateExcludedTip', defaultMessage: 'Defender doesn’t scan it.', description: 'Tooltip on Excluded.' }) },
  'not-excluded': { label: msg({ id: 'workspace.antivirus.stateScanned', defaultMessage: 'Scanned', description: "A folder's scanning: Defender scans it." }), tone: 'warn-text', tip: msg({ id: 'workspace.antivirus.stateScannedTip', defaultMessage: 'Defender scans every file Hive’s work creates or opens here.', description: 'Tooltip on Scanned.' }) },
  unknown: { label: msg({ id: 'workspace.antivirus.stateUnknown', defaultMessage: 'Unknown', description: "A folder's scanning: Defender hides its exclusions without administrator rights." }), tone: 'faint', tip: msg({ id: 'workspace.antivirus.stateUnknownTip', defaultMessage: 'Defender shows its exclusions only to administrators: Check with administrator rights to see them.', description: 'Tooltip on Unknown. Check with administrator rights is a button below.' }) },
  added: { label: msg({ id: 'workspace.antivirus.stateAdded', defaultMessage: 'Added by Hive', description: "A folder's scanning: Hive added its exclusion (not confirmed)." }), tone: 'good-text', tip: msg({ id: 'workspace.antivirus.stateAddedTip', defaultMessage: 'Hive added this exclusion; Defender hides its list without administrator rights, so it isn’t confirmed.', description: 'Tooltip on Added by Hive.' }) }
}

const DEV_DRIVE: Record<AvDevDrive, { label: Msg; tip: Msg }> = {
  trusted: { label: msg({ id: 'workspace.antivirus.devTrusted', defaultMessage: 'yes, trusted', description: "Whether a folder is on a Dev Drive (a Windows volume for code), in Settings → Workspace's antivirus table. Lower case." }), tip: msg({ id: 'workspace.antivirus.devTrustedTip', defaultMessage: 'A trusted Dev Drive: with Defender’s performance mode on, it is scanned much more lightly.', description: 'Tooltip on yes, trusted.' }) },
  untrusted: { label: msg({ id: 'workspace.antivirus.devUntrusted', defaultMessage: 'yes, not trusted', description: 'Whether a folder is on a Dev Drive. Lower case.' }), tip: msg({ id: 'workspace.antivirus.devUntrustedTip', defaultMessage: 'A Dev Drive that isn’t trusted: Defender scans it like any other drive.', description: 'Tooltip on yes, not trusted.' }) },
  refs: { label: msg({ id: 'workspace.antivirus.devRefs', defaultMessage: 'maybe (ReFS)', description: 'Whether a folder is on a Dev Drive: its volume is ReFS, as Dev Drives are. Lower case; keep ReFS.' }), tip: msg({ id: 'workspace.antivirus.devRefsTip', defaultMessage: 'A ReFS volume, as Dev Drives are. Only a check with administrator rights can tell whether it is a trusted Dev Drive.', description: 'Tooltip on maybe (ReFS).' }) },
  no: { label: msg({ id: 'workspace.antivirus.devNo', defaultMessage: 'no', description: 'Whether a folder is on a Dev Drive. Lower case.' }), tip: msg({ id: 'workspace.antivirus.devNoTip', defaultMessage: 'Not a Dev Drive.', description: 'Tooltip on no.' }) },
  unknown: { label: msg({ id: 'workspace.antivirus.devUnknown', defaultMessage: 'unknown', description: 'Whether a folder is on a Dev Drive. Lower case.' }), tip: msg({ id: 'workspace.antivirus.devUnknownTip', defaultMessage: 'Its volume couldn’t be read.', description: 'Tooltip on unknown.' }) }
}

const M = {
  realTimeOn: msg({ id: 'workspace.antivirus.realTimeOn', defaultMessage: 'Microsoft Defender scans files as they are created and opened (real-time protection is on).', description: "Settings → Workspace's antivirus status." }),
  realTimeOff: msg({ id: 'workspace.antivirus.realTimeOff', defaultMessage: 'Microsoft Defender is the antivirus, with real-time protection off: it doesn’t slow Hive’s work now.', description: "Settings → Workspace's antivirus status." }),
  other: msg({ id: 'workspace.antivirus.other', defaultMessage: 'Another antivirus is active ({names}). Hive can only manage Microsoft Defender: see its own settings for exclusions.', description: "Settings → Workspace's antivirus status ({names}: the other antivirus products)." }),
  none: msg({ id: 'workspace.antivirus.none', defaultMessage: 'No active antivirus was found.', description: "Settings → Workspace's antivirus status." }),
  notWindows: msg({ id: 'workspace.antivirus.notWindows', defaultMessage: 'Only Windows has Defender to check.', description: "Settings → Workspace's antivirus status, on another system." }),
  testCopy: msg({ id: 'workspace.antivirus.testCopy', defaultMessage: 'A test copy of Hive: it never asks Defender.', description: "Settings → Workspace's antivirus status, in a test copy." }),
  unavailable: msg({ id: 'workspace.antivirus.unavailable', defaultMessage: 'Hive couldn’t read Defender’s status{hasError, select, yes {: {error}} other {.}}', description: "Settings → Workspace's antivirus status when it couldn't be read ({error}: why)." }),
  addTitle: msg({ id: 'workspace.antivirus.addTitle', defaultMessage: 'Stop Defender scanning these folders?', description: 'Confirmation before Add Exclusions.' }),
  addMessage: msg({ id: 'workspace.antivirus.addMessage', defaultMessage: 'Hive asks Defender to exclude:', description: 'Confirmation before Add Exclusions; the folders follow.' }),
  addDetail: msg({ id: 'workspace.antivirus.addDetail', defaultMessage: 'Defender won’t scan anything in them, including node_modules and whatever agents download there. Windows asks for administrator rights once. You can remove them again here.', description: 'Confirmation before Add Exclusions. Keep node_modules as it is.' }),
  addConfirm: msg({ id: 'workspace.antivirus.addConfirm', defaultMessage: 'Add Exclusions', description: "Add Exclusions' confirmation: its button." }),
  removeTitle: msg({ id: 'workspace.antivirus.removeTitle', defaultMessage: 'Remove the exclusions Hive added?', description: "Confirmation before Remove Hive's Exclusions." }),
  removeMessage: msg({ id: 'workspace.antivirus.removeMessage', defaultMessage: 'Hive asks Defender to scan again:', description: "Confirmation before Remove Hive's Exclusions; the folders follow." }),
  removeDetail: msg({ id: 'workspace.antivirus.removeDetail', defaultMessage: 'Defender scans these folders again. Exclusions Hive didn’t add stay. Windows asks for administrator rights once.', description: "Confirmation before Remove Hive's Exclusions." }),
  removeConfirm: msg({ id: 'workspace.antivirus.removeConfirm', defaultMessage: 'Remove Exclusions', description: "Remove Hive's Exclusions' confirmation: its button." }),
  noWorkspace: msg({ id: 'workspace.antivirus.noWorkspace', defaultMessage: 'Open a workspace to check how Defender treats it.', description: "Settings → Workspace's antivirus with no workspace open." }),
  loadTarget: msg({ id: 'workspace.antivirus.loadTarget', defaultMessage: 'the antivirus status', description: 'What could not be loaded: shown in "Could not load {what}: {error}", with Retry.' }),
  checkingDefender: msg({ id: 'workspace.antivirus.checkingDefender', defaultMessage: 'Checking Defender…', description: "Settings → Workspace's antivirus while it checks." }),
  folder: msg({ id: 'workspace.antivirus.folder', defaultMessage: 'Folder', description: "Settings → Workspace's antivirus table: a column." }),
  scanning: msg({ id: 'workspace.antivirus.scanning', defaultMessage: 'Scanning', description: "Settings → Workspace's antivirus table: a column (whether Defender scans the folder)." }),
  devDrive: msg({ id: 'workspace.antivirus.devDrive', defaultMessage: 'Dev Drive', description: "Settings → Workspace's antivirus table: a column (whether the folder is on a Dev Drive). Keep Windows' name for Dev Drive." }),
  notOffered: msg({ id: 'workspace.antivirus.notOffered', defaultMessage: 'Not offered: {why}.', description: "Under a folder Hive won't offer to exclude; {why} says why (lower case)." }),
  live: msg({ id: 'workspace.antivirus.live', defaultMessage: 'As Defender lists its exclusions now.', description: "Settings → Workspace's antivirus: where the table's states come from." }),
  adminCheck: msg({ id: 'workspace.antivirus.adminCheck', defaultMessage: 'As Defender listed its exclusions with administrator rights, {when}.', description: "Settings → Workspace's antivirus: the states come from the last check with administrator rights ({when}: a date and time)." }),
  hidden: msg({ id: 'workspace.antivirus.hidden', defaultMessage: 'Defender shows its exclusions only to administrators, so Hive can’t see them without asking.', description: "Settings → Workspace's antivirus: why the states are unknown." }),
  advice: msg({ id: 'workspace.antivirus.advice', defaultMessage: 'Excluded folders aren’t scanned at all, so only exclude folders whose contents you trust. A trusted Dev Drive, with Defender’s performance mode{mode, select, on { (on here)} off { (off here)} other {}}, is the alternative Microsoft recommends for code.', description: "Settings → Workspace's antivirus, under the table." }),
  checking: msg({ id: 'workspace.antivirus.checking', defaultMessage: 'Checking…', description: "Settings → Workspace's antivirus while it checks again." }),
  checked: msg({ id: 'workspace.antivirus.checkedAt', defaultMessage: 'Checked {when}', description: 'When the antivirus status was checked ({when}: "4 minutes ago").' }),
  checkAgain: msg({ id: 'workspace.antivirus.checkAgain', defaultMessage: 'Check Again', description: "Settings → Workspace's antivirus: a button." }),
  checkAdmin: msg({ id: 'workspace.antivirus.checkAdmin', defaultMessage: 'Check with Administrator Rights…', description: "Settings → Workspace's antivirus: a button (Windows asks for administrator rights)." }),
  goneTitle: msg({ id: 'workspace.antivirus.goneTitle', defaultMessage: 'Hive’s exclusions of folders that are gone', description: "Settings → Workspace's antivirus: a heading over a list of exclusions Hive added for folders that no longer exist (moved or deleted)." }),
  goneHint: msg({ id: 'workspace.antivirus.goneHint', defaultMessage: '{n, plural, one {Hive excluded this folder, which no longer exists (moved or deleted). Remove Hive’s Exclusions… takes it away too.} other {Hive excluded these folders, which no longer exist (moved or deleted). Remove Hive’s Exclusions… takes them away too.}}', description: "Settings → Workspace's antivirus, under the heading for exclusions of folders that are gone. {n}: how many. Remove Hive’s Exclusions… is the button below: use its name as shown." }),
  removeHive: msg({ id: 'workspace.antivirus.removeHive', defaultMessage: 'Remove Hive’s Exclusions…', description: "Settings → Workspace's antivirus: a button." }),
  addExclusions: msg({ id: 'workspace.antivirus.addExclusions', defaultMessage: 'Add Exclusions…', description: "Settings → Workspace's antivirus: a button." }),
  aboutDevDrive: msg({ id: 'workspace.antivirus.aboutDevDrive', defaultMessage: 'About Dev Drive', description: "Settings → Workspace's antivirus: opens Microsoft's Dev Drive documentation." }),
  slowLine: msg({ id: 'workspace.antivirus.slowLine', defaultMessage: 'Microsoft Defender scans this workspace’s folders as Hive’s work changes them, which slows builds, tests and git. <link>Antivirus scanning…</link>', description: "Performance, when Defender likely slows the workspace. <link> opens Settings → Workspace's antivirus." }),
  whyAgents: msg({ id: 'workspace.antivirus.whyAgents', defaultMessage: 'several agents are running', description: 'Why Hive suggests exclusions now. Lower case: it goes in brackets in the suggestion.' }),
  whySlow: msg({ id: 'workspace.antivirus.whySlow', defaultMessage: 'a long command just ran', description: 'Why Hive suggests exclusions now. Lower case: it goes in brackets in the suggestion.' }),
  stillTitle: msg({ id: 'workspace.antivirus.stillTitle', defaultMessage: 'Defender is still scanning this workspace', description: "The suggestion's title, as a reminder." }),
  title: msg({ id: 'workspace.antivirus.title', defaultMessage: 'Defender is scanning this workspace', description: "The suggestion's title." }),
  reminder: msg({ id: 'workspace.antivirus.reminder', defaultMessage: 'A reminder: Microsoft Defender still scans every file Hive’s work creates or opens ({why}). Excluding the workspace’s folders, or a Dev Drive, can make builds, tests and git much faster. Hive reminds you at most once a day; Don’t Ask Again stops it for this workspace.', description: 'The suggestion, as a reminder ({why}: why now). Don’t Ask Again is its button.' }),
  suggestion: msg({ id: 'workspace.antivirus.suggestion', defaultMessage: 'Microsoft Defender scans every file Hive’s work creates or opens ({why}). Excluding the workspace’s folders, or a Dev Drive, can make builds, tests and git much faster.', description: 'The suggestion ({why}: why now).' }),
  review: msg({ id: 'workspace.antivirus.review', defaultMessage: 'Review…', description: "The suggestion's button: opens the antivirus status." }),
  excludedNow: msg({ id: 'workspace.antivirus.excludedNow', defaultMessage: 'Excluded now: Defender no longer scans these folders', description: "What the suggestion to exclude the workspace from Defender's scanning says once every folder it named is excluded (HI-2320), in place of its buttons." }),
  wontAsk: msg({ id: 'workspace.antivirus.wontAsk', defaultMessage: 'Hive won’t suggest it again for this workspace', description: "What the suggestion to exclude the workspace from Defender's scanning says after Don't Ask Again (HI-2320), in place of its buttons." }),
  dontAsk: msg({ id: 'workspace.antivirus.dontAsk', defaultMessage: 'Don’t Ask Again', description: "The suggestion's button: no more suggestions for this workspace." })
}

/** Where the states come from, as the panel says it; Repair's Defender rows say it the same way (#1302). */
export const AV_SOURCE = { live: M.live, adminCheck: M.adminCheck }

const antivirusLink = (c: React.ReactNode[]): React.ReactNode => <a onClick={showAntivirus}>{c}</a>

/** One line saying what scans the workspace. */
function scanLine(s: AntivirusStatus): string {
  switch (s.scan) {
    case 'defender':
      return tr(s.realTime ? M.realTimeOn : M.realTimeOff)
    case 'other':
      return tr(M.other, { names: fmt.list(s.others, 'unit') })
    case 'none':
      return tr(M.none)
    case 'not-applicable':
      return tr(M.notWindows)
    case 'test-copy':
      return tr(M.testCopy)
    default:
      return tr(M.unavailable, { hasError: s.error ? 'yes' : 'no', error: s.error ?? '' })
  }
}

/**
 * The suggestion to exclude the workspace (HI-2320): once a status read here shows no folder Defender scans (excluded
 * from the dialog, or by hand), its Review… and Don't Ask Again no longer apply, and it says so.
 */
function useSuggestionSettled(status: AntivirusStatus | null): void {
  useEffect(() => {
    if (status?.scan === 'defender' && status.paths.length && status.paths.every((p) => p.state === 'excluded')) resolveLocal('antivirus', tr(M.excludedNow))
  }, [status])
}

/** Settings → Workspace: the status, each folder's, and the actions. */
export function AntivirusPanel() {
  const workspace = useStore((s) => s.workspace?.path ?? null)
  const [status, setStatus] = useState<AntivirusStatus | null>(null)
  useSuggestionSettled(status)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<AvChangeResult | null>(null)
  const latest = useRef(0)
  // Each answer applies only if nothing newer was asked and the window still shows the workspace it was asked for.
  const current = (n: number, ws: string | null): boolean => n === latest.current && get().workspace?.path === ws
  const load = useCallback((refresh: boolean) => {
    const n = ++latest.current
    const ws = get().workspace?.path ?? null
    const now = (): boolean => n === latest.current && get().workspace?.path === ws
    setChecking(true)
    setError(null)
    call('antivirus:status', refresh)
      .then((s) => now() && setStatus(s), (e) => now() && setError(errorMessage(e)))
      .finally(() => now() && setChecking(false))
  }, [])
  useEffect(() => {
    latest.current++
    setStatus(null)
    setResult(null)
    setChecking(false)
    if (workspace) load(false)
  }, [workspace, load])

  const change = async (action: AvAction): Promise<void> => {
    const n = ++latest.current
    const ws = get().workspace?.path ?? null
    setChecking(true)
    setResult(null)
    try {
      // Main works out exactly what would change; the user confirms that, and only that is run.
      const op = await call('antivirus:prepare', action)
      if (!current(n, ws)) return
      if (action !== 'check') {
        const ok = await confirm(
          action === 'add'
            ? { title: tr(M.addTitle), message: tr(M.addMessage), list: op.paths, detail: tr(M.addDetail), confirmLabel: tr(M.addConfirm) }
            : { title: tr(M.removeTitle), message: tr(M.removeMessage), list: op.paths, detail: tr(M.removeDetail), confirmLabel: tr(M.removeConfirm) }
        )
        if (!ok || !current(n, ws)) return
      }
      const r = await call('antivirus:apply', op.id)
      if (!current(n, ws)) return
      setResult(r.result)
      if (r.status) setStatus(r.status)
    } catch (e) {
      if (current(n, ws)) setResult({ outcome: 'error', message: errorMessage(e) })
    } finally {
      if (current(n, ws)) setChecking(false)
    }
  }

  if (!workspace) return <div className="faint">{tr(M.noWorkspace)}</div>
  if (error && !status) return <LoadFailed inline what={tr(M.loadTarget)} error={error} onRetry={() => load(true)} />
  if (!status)
    return (
      <div className="faint">
        <Icon name="loading" spin /> {tr(M.checkingDefender)}
      </div>
    )
  const defender = status.scan === 'defender'
  const offerable = status.paths.filter((p) => !p.unsafe)
  const toAdd = offerable.filter((p) => p.state !== 'excluded')
  const hiveAdded = offerable.some((p) => p.addedByHive) || !!status.gone?.length
  return (
    <div className="antivirus">
      <p className={cx('antivirus-scan', status.slowed && 'warn-text')}>
        <Icon name={status.slowed ? 'warning' : defender || status.scan === 'other' ? 'shield' : 'info'} /> {scanLine(status)}
      </p>
      {status.paths.length > 0 && status.scan !== 'not-applicable' && status.scan !== 'test-copy' && (
        <div className="table-wrap">
          <table className="table antivirus-folders">
            <thead>
              <tr>
                <th>{tr(M.folder)}</th>
                <th>{tr(M.scanning)}</th>
                <th>{tr(M.devDrive)}</th>
              </tr>
            </thead>
            <tbody>
              {status.paths.map((p) => (
                <tr key={p.path}>
                  <td>
                    {tr(KIND_LABEL[p.kind])} <span className="faint small mono">{p.path}</span>
                    {p.unsafe && <div className="warn-text small">{tr(M.notOffered, { why: p.unsafe })}</div>}
                  </td>
                  <td className="nowrap">
                    <span className={AV_STATE[p.state].tone} title={tr(AV_STATE[p.state].tip)}>
                      {tr(AV_STATE[p.state].label)}
                    </span>
                  </td>
                  <td className="nowrap faint" title={tr(DEV_DRIVE[p.devDrive].tip)}>
                    {tr(DEV_DRIVE[p.devDrive].label)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {defender && !!status.gone?.length && (
        <div className="antivirus-gone">
          <h4>{tr(M.goneTitle)}</h4>
          <p className="hint">{tr(M.goneHint, { n: status.gone.length })}</p>
          <div className="table-wrap">
            <table className="table antivirus-folders">
              <thead>
                <tr>
                  <th>{tr(M.folder)}</th>
                  <th>{tr(M.scanning)}</th>
                </tr>
              </thead>
              <tbody>
                {status.gone.map((g) => (
                  <tr key={g.path}>
                    <td className="mono small">{g.path}</td>
                    <td className="nowrap">
                      {/* Muted, never the good colour: a leftover exclusion isn't good news (the Assistant's call). */}
                      <span className="faint" title={tr(AV_STATE[g.state].tip)}>
                        {tr(AV_STATE[g.state].label)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {defender && (
        <p className="hint">
          {status.exclusionsFrom === 'live' ? tr(M.live) : status.exclusionsFrom === 'admin-check' ? tr(M.adminCheck, { when: formatDateTime(status.adminCheckedAt!) }) : tr(M.hidden)}{' '}
          {tr(M.advice, { mode: status.performanceMode === null ? 'unknown' : status.performanceMode ? 'on' : 'off' })}
        </p>
      )}
      {result && <p className={cx('antivirus-result', result.outcome === 'done' ? 'good-text' : 'warn-text')}>{result.message}</p>}
      <div className="storage-actions">
        <span className="faint small">{checking ? tr(M.checking) : tr(M.checked, { when: timeAgo(status.checkedAt) })}</span>
        <button className="btn subtle small" disabled={checking} onClick={() => load(true)}>
          <Icon name="refresh" /> {tr(M.checkAgain)}
        </button>
        {defender && (
          <button className="btn subtle small" disabled={checking} onClick={() => void change('check')}>
            <Icon name="shield" /> {tr(M.checkAdmin)}
          </button>
        )}
        {defender && hiveAdded && (
          <button className="btn subtle small" disabled={checking} onClick={() => void change('remove')}>
            <Icon name="discard" /> {tr(M.removeHive)}
          </button>
        )}
        {defender && toAdd.length > 0 && (
          <button className="btn small" disabled={checking} onClick={() => void change('add')}>
            <Icon name="shield" /> {tr(M.addExclusions)}
          </button>
        )}
        {(defender || status.scan === 'none') && (
          <button className="btn subtle small" onClick={() => void call('app:openExternal', DEV_DRIVE_URL)}>
            <Icon name="link-external" /> {tr(M.aboutDevDrive)}
          </button>
        )}
      </div>
    </div>
  )
}

/** Shows Settings → Workspace, where the antivirus status is. */
export function showAntivirus(): void {
  set({ settingsSection: 'workspace', settingsQuery: '' })
  setActivity('settings')
}

/** Performance (the workspace): a line when Defender likely slows the workspace, linking to the status. */
export function AntivirusLine() {
  const workspace = useStore((s) => s.workspace?.path ?? null)
  const [status, setStatus] = useState<AntivirusStatus | null>(null)
  useSuggestionSettled(status)
  useEffect(() => {
    let live = true
    setStatus(null)
    if (workspace) call('antivirus:status', false).then((s) => live && setStatus(s), () => undefined)
    return () => {
      live = false
    }
  }, [workspace])
  if (!status?.slowed) return null
  return (
    <p className="hint perf-antivirus">
      <Icon name="shield" /> {Children.toArray(tRich<React.ReactNode>(M.slowLine, { link: antivirusLink }))}
    </p>
  )
}

/** Two or more agents running, or a command in the Progress panel that took this long: when scanning matters. */
const SLOW_RUN_MS = 2 * 60_000

type StoreState = ReturnType<typeof get>
const hostsOf = (s: StoreState) => [...(s.workspace?.projects ?? []), ...(s.workspace?.assistant ? [s.workspace.assistant] : [])]

/** A reminder's wait is checked at least this often, so a computer that slept doesn't push it back. */
const RECHECK_MS = 60 * 60_000

/**
 * Suggests the exclusions when scanning matters (#316): when several agents run at once, or a command in the Progress
 * panel took two minutes or more; and again, while that lasts, when an agent gets a worktree (its folder may be new).
 * Main decides (scanning slows the workspace, not declined for good, these folders not offered in the last day, #348)
 * and claims the offer: folders added since are suggested at once, the same ones again as a reminder at most once a day.
 * While agents keep running, the window asks again when main says a reminder may come; a long command is a reason once
 * (each new one asks again), not for a day later.
 */
export function useAntivirusOffer(): void {
  const workspace = useStore((s) => s.workspace?.path ?? null)
  const agents = useStore((s) => hostsOf(s).reduce((n, p) => n + p.agents.filter((a) => a.live && !a.live.settingUp).length, 0))
  // The workspace's agents working outside their project folders (slots, worktrees: #1442), as a count: a new one may
  // have made the worktrees folder.
  const worktrees = useStore((s) => hostsOf(s).reduce((n, p) => n + p.agents.filter((a) => awayFromProject(a)).length, 0))
  // When the latest long command finished (0: none): each new one is a reason to ask.
  const slowRun = useStore((s) => s.progressRuns.reduce((t, r) => (r.finishedAt !== null && r.finishedAt - r.startedAt >= SLOW_RUN_MS ? Math.max(t, r.finishedAt) : t), 0))
  const reason = agents >= 2 ? 'agents' : slowRun ? 'slow' : null
  // Asks once per key: when the reason comes (back), the worktrees change, or another long command finishes.
  const key = workspace && reason ? `${workspace.toLowerCase()}|${reason}|${worktrees}|${reason === 'slow' ? slowRun : ''}` : null
  useEffect(() => {
    if (!key || !workspace || !reason) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = (due: number): void => {
      timer = setTimeout(() => (Date.now() >= due ? ask() : wait(due)), Math.min(Math.max(due - Date.now(), 1000), RECHECK_MS))
    }
    const ask = (): void => {
      call('antivirus:suggestion').then(
        (r) => {
          // An answer for a workspace the window no longer shows is dropped. One that came after the reason went is
          // still shown (main has counted it), but asks nothing more.
          if (r.offer && get().workspace?.path === workspace) showOffer(r.offer.count, reason)
          if (live && reason === 'agents' && r.remindAt) wait(Date.parse(r.remindAt))
        },
        () => undefined
      )
    }
    ask()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key, workspace, reason])
}

/** Don't Ask Again (HI-2320: the suggestion then says so, in place of its buttons). */
export async function dismissAntivirusOffer(): Promise<void> {
  try {
    await call('antivirus:dismiss')
    resolveLocal('antivirus', tr(M.wontAsk))
  } catch {
    // The suggestion stays, with its buttons, to try again.
  }
}

function showOffer(count: number, reason: 'agents' | 'slow'): void {
  const why = tr(reason === 'agents' ? M.whyAgents : M.whySlow)
  const reminder = count > 1
  pushToast({
    id: 'antivirus',
    level: 'info',
    title: tr(reminder ? M.stillTitle : M.title),
    message: tr(reminder ? M.reminder : M.suggestion, { why }),
    actions: [
      { label: tr(M.review), command: 'antivirus.show' },
      { label: tr(M.dontAsk), command: 'antivirus.dismiss' }
    ],
    timestamp: new Date().toISOString()
  })
}
