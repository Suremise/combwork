import { fmt, msg, tr } from '@shared/i18n'
import type { ParkedItem, TeamPauseView } from '@shared/teamPause'
import { call } from '../api'
import { confirm, notify, useLanguage, useStore } from '../store'
import { basename } from '../util'
import { refreshTeamPause, useTeamPause } from '../teamPause'
import { Icon } from './ui'

/**
 * Pausing the team before an update (HI-2081): the Lanes section's Pause the Team / Resume the Team, and while a team is
 * paused, its band: what still runs (End It on a process, after a question), or All parked: safe to install, with Install
 * Now once an update is ready. The Updates dialog shows the same band. Install Now is checked again in main.
 * End It is offered for the window's own workspace only: another open workspace's blockers are listed with Show Its
 * Window, which brings forward the window that can end them (HI-2095).
 */

export const M = {
  pause: msg({ id: 'board.team.pause', defaultMessage: 'Pause the Team', description: "A button and command (the Progress panel's Lanes, the command palette, Help → Check for Updates) (HI-2081): before an update, Hive starts no lane card, wakes no agent with card events and gives no reviews out in every open workspace, and tells each running agent once to finish its turn, end its runs and commit. 'The team' is every agent of the workspace." }),
  resume: msg({ id: 'board.team.resume', defaultMessage: 'Resume the Team', description: 'A button and command (HI-2081): lifts the pause of every open workspace, so lanes start their cards and agents are woken again.' }),
  pauseFirst: msg({ id: 'board.team.pauseFirst', defaultMessage: 'Pause the Team First', description: "A button in Help → Check for Updates, when an update is ready and agents are running (HI-2081): pauses the team (see Pause the Team) so it can be installed once every agent has parked." }),
  pausing: msg({ id: 'board.team.pausing', defaultMessage: '{n, plural, one {Pausing the team: # still running} other {Pausing the team: # still running}}', description: "The band in the Progress panel's Lanes while the team is paused (HI-2081) and not every agent has parked yet: n things still run (agents working, runs, processes), listed below." }),
  parked: msg({ id: 'board.team.parked', defaultMessage: 'All parked: safe to install', description: "The band in the Progress panel's Lanes (HI-2081): the team is paused and nothing runs in any open workspace, so an update can be installed." }),
  install: msg({ id: 'board.team.install', defaultMessage: 'Install Now', description: 'A button on the paused team’s band (HI-2081), once all are parked and an update is ready: restarts Hive and installs the update (checked again first).' }),
  notParked: msg({ id: 'board.team.notParked', defaultMessage: "The team isn't parked any more, so the update wasn't installed.", description: 'A notice (HI-2081): the user chose Install Now, and as Hive checked again something had started running (an agent, a run) in an open workspace.' }),
  pauseFailed: msg({ id: 'board.team.pauseFailed', defaultMessage: "{n, plural, one {# workspace couldn't be paused: {names}} other {# workspaces couldn't be paused: {names}}}", description: 'A notice (HI-2081): Pause the Team could not save the pause of some open workspaces (their folder names in {names}); they are not held, and the app is never shown as parked while one is not.' }),
  thisWorkspace: msg({ id: 'board.team.thisWorkspace', defaultMessage: 'This workspace', description: "A heading in the paused team's band, over what still runs in the window's own workspace (HI-2081), when several are open." }),
  notPaused: msg({ id: 'board.team.otherNotPaused', defaultMessage: '{name} isn’t paused', description: "A line in the paused team's band (HI-2081): another open workspace ({name}, its folder's name) isn't paused, so the update can't be installed yet." }),
  endIt: msg({ id: 'board.team.endIt', defaultMessage: 'End It…', description: "A button beside a process the paused team's band names (HI-2081): ends it and what it started, after a question (…)." }),
  endTitle: msg({ id: 'board.team.endTitle', defaultMessage: 'End this process?', description: "Title of the question before ending a process the paused team's band names (HI-2081)." }),
  endMessage: msg({ id: 'board.team.endMessage', defaultMessage: "End {agent}'s {label} (process {pid}) and everything it started?", description: "The question before ending a process (HI-2081). {agent} is the agent's name, {label} what the process runs, {pid} its id." }),
  endDetail: msg({ id: 'board.team.endDetail', defaultMessage: 'Only that process and what it started end, and only while they are still the ones listed. Work they had not saved is lost.', description: "Detail of the question before ending a process from the paused team's band (HI-2081)." }),
  showWindow: msg({ id: 'board.team.showWindow', defaultMessage: 'Show Its Window', description: "A button beside another open workspace's name in the paused team's band (HI-2095): brings forward the Hive window showing that workspace, where what still runs in it can be ended." }),
  showWindowTitle: msg({ id: 'board.team.showWindowTitle', defaultMessage: 'Its processes are ended from its own window', description: "The tooltip of Show Its Window in the paused team's band (HI-2095): End It is offered only in the window of the workspace a process belongs to." }),
  windowGone: msg({ id: 'board.team.windowGone', defaultMessage: '{name} isn’t open in a window any more', description: "A notice (HI-2095): the user chose Show Its Window for another workspace ({name}, its folder's name) in the paused team's band, but no window shows it now." }),
  endFailed: msg({ id: 'board.team.endFailed', defaultMessage: "{label} couldn't be ended", description: 'A notice (HI-2081): ending a process from the paused team’s band failed, or it was no longer the one listed. {label} is what it runs.' }),
  item: msg({
    id: 'board.team.item',
    defaultMessage:
      "{kind, select, working {{agent} is working} starting {{agent} is starting} background {{agent} has background tasks running} run {{agent}: {label} (a run)} merge {A merge: {label}} copy {A check in a copy: {label}} process {{agent}: {label} (process {pid})} writer {{agent}: its slot {label} is still held} status {{agent}: Hive can’t tell what it is doing} other {{agent}: can’t be checked now}}",
    description: "One thing that still runs while the team is paused (HI-2081), a line in its band. {agent} is an agent's name (or Assistant); {label} the user's own words for it (a run's title, a process's command, a slot's name); {pid} a process id. kind: working or starting; background tasks; a run (a test run through hive-progress); a merge of the merge queue; a check in a copy (a folder Hive keeps at one revision); a process (a test runner, a dev server, a test copy of Hive); its slot (a working folder Hive lends) still held by its processes; its state unknown; or (other) its processes can't be read now. Keep the select keys."
  })
}

/** One thing still running, worded. */
function itemText(i: ParkedItem): string {
  return tr(M.item, { kind: i.kind, agent: i.agent || tr(msg({ id: 'board.team.hive', defaultMessage: 'Hive', description: "Who runs something while the team is paused when no agent does (HI-2081): Hive itself (a slot's setup, a merge). Hive is the product's name." })), label: i.label ?? '', pid: i.process?.pid ?? 0 }) // i18n-ignore: select keys, never shown
}

/** End It (the window's own workspace only): after the question, the process and what it started, found again in main by its recorded identity. */
async function endIt(v: TeamPauseView, i: ParkedItem): Promise<void> {
  const ws = useStore.getState().workspace
  if (!i.process || !ws || ws.path.toLowerCase() !== v.workspacePath.toLowerCase()) return
  const label = i.label ?? i.process.name
  const ok = await confirm({ title: tr(M.endTitle), message: tr(M.endMessage, { agent: i.agent, label, pid: i.process.pid }), detail: tr(M.endDetail), confirmLabel: tr(M.endIt).replace(/…$/, ''), danger: true })
  if (!ok) return
  const path = i.project ? `${v.workspacePath}\\${i.project}` : (ws.assistant?.path ?? '')
  const r = await call('team:endProcess', path, i.agentId, i.process.pid, i.process.created).catch(() => 'failed' as const)
  if (r !== 'ended') notify('warning', tr(M.endFailed, { label }))
  void refreshTeamPause()
}

/** Show Its Window: another open workspace's window brought forward, where its own End It is. */
async function showItsWindow(v: TeamPauseView): Promise<void> {
  const shown = await call('team:showWorkspace', v.workspacePath).catch(() => false)
  if (!shown) notify('warning', tr(M.windowGone, { name: basename(v.workspacePath) }))
  void refreshTeamPause()
}

export async function pauseTheTeam(): Promise<void> {
  const r = await call('team:pause')
  if (r.failed.length) notify('warning', tr(M.pauseFailed, { n: r.failed.length, names: fmt.list(r.failed.map((f) => basename(f.workspacePath))) }))
  void refreshTeamPause()
}

export async function resumeTheTeam(): Promise<void> {
  await call('team:resume')
  void refreshTeamPause()
}

/** Install Now: main scans again under the pauses' locks and installs only if every workspace is paused and parked. */
async function installNow(): Promise<void> {
  const r = await call('team:install')
  if (!r.installed) notify('warning', tr(M.notParked))
  void refreshTeamPause()
}

/** Whether this window's workspace is paused, as last read. */
export function useTeamPaused(): boolean {
  const ws = useStore((s) => s.workspace?.path ?? '')
  return useTeamPause((s) => !!ws && !!s.state?.workspaces.some((w) => w.workspacePath.toLowerCase() === ws.toLowerCase() && w.pause))
}

/** Pause the Team or Resume the Team, as the window's workspace is (the Lanes section's header). */
export function TeamPauseButton({ className }: { className?: string }): React.JSX.Element {
  useLanguage()
  const paused = useTeamPaused()
  return (
    <button type="button" className={className ?? 'btn small subtle'} onClick={() => void (paused ? resumeTheTeam() : pauseTheTeam())}>
      <Icon name={paused ? 'debug-continue' : 'debug-pause'} /> {tr(paused ? M.resume : M.pause)}
    </button>
  )
}

/** The paused team's band: what still runs in each open workspace, or All parked, with Install Now once an update is ready. */
export function TeamPauseBand(): React.JSX.Element | null {
  useLanguage()
  const state = useTeamPause((s) => s.state)
  const ws = useStore((s) => s.workspace?.path ?? '')
  const ready = useStore((s) => s.update?.status === 'ready')
  if (!state || !state.workspaces.some((w) => w.pause)) return null
  const own = state.workspaces.find((w) => w.workspacePath.toLowerCase() === ws.toLowerCase())
  const others = state.workspaces.filter((w) => w !== own)
  const left = state.workspaces.reduce((n, w) => n + w.items.length, 0) + state.workspaces.filter((w) => !w.pause).length
  const several = state.workspaces.length > 1
  const list = (v: TeamPauseView, endable: boolean): React.JSX.Element | null =>
    v.items.length ? (
      <ul className="team-pause-items">
        {v.items.map((i, k) => (
          <li key={`${i.agentId}-${i.kind}-${i.process?.pid ?? i.label ?? k}`} className={i.state === 'unknown' ? 'unknown' : undefined}>
            <span>{itemText(i)}</span>
            {endable && i.process && (
              <button type="button" className="btn small subtle" onClick={() => void endIt(v, i)}>
                {tr(M.endIt)}
              </button>
            )}
          </li>
        ))}
      </ul>
    ) : null
  return (
    <div className={`team-pause-band${state.allParked ? ' parked' : ''}`} role="status" aria-live="polite">
      <div className="team-pause-head">
        <Icon name={state.allParked ? 'check' : 'debug-pause'} />
        <span className="team-pause-title">{state.allParked ? tr(M.parked) : tr(M.pausing, { n: left })}</span>
        {state.allParked && ready && (
          <button type="button" className="btn small primary" onClick={() => void installNow()}>
            {tr(M.install)}
          </button>
        )}
        <button type="button" className="btn small subtle" onClick={() => void resumeTheTeam()}>
          {tr(M.resume)}
        </button>
      </div>
      {/* Each workspace with something to name: what still runs in it, or that it isn't paused. */}
      {own && several && own.items.length > 0 && <div className="team-pause-ws">{tr(M.thisWorkspace)}</div>}
      {own && list(own, true)}
      {others
        .filter((o) => !o.pause || o.items.length)
        .map((o) => (
          <div key={o.workspacePath} data-team-workspace={o.workspacePath}>
            <div className="team-pause-ws other">
              <span>{o.pause ? basename(o.workspacePath) : tr(M.notPaused, { name: basename(o.workspacePath) })}</span>
              <button type="button" className="btn small subtle" title={tr(M.showWindowTitle)} onClick={() => void showItsWindow(o)}>
                {tr(M.showWindow)}
              </button>
            </div>
            {list(o, false)}
          </div>
        ))}
    </div>
  )
}
