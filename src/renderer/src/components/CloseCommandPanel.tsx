import { useEffect, useRef } from 'react'
import type { CloseCommandRun } from '@shared/types'
import { msg, tr } from '@shared/i18n'
import { durationText } from '@shared/tasks'
import { call } from '../api'
import { useLanguage, useStore } from '../store'
import { useNow } from '../usage'
import { Icon, useBackdrop } from './ui'

const M = {
  running: msg({ id: 'workspace.closeCommand.running', defaultMessage: '{kind, select, quit {Running your quit command…} other {Running your close command…}}', description: "The heading of the panel Hive shows while it runs the user's own command as a workspace closes (kind other: Settings → Workspace → When this workspace closes, run) or as Hive quits (kind quit: Settings → General → When Hive quits, run)." }),
  elapsed: msg({ id: 'workspace.closeCommand.elapsed', defaultMessage: 'Running for {time}', description: 'In the close command panel: how long the command has run so far. {time} is a short duration ("40 s", "2 min").' }),
  output: msg({ id: 'workspace.closeCommand.output', defaultMessage: "The command's last output", description: "In the close command panel: the accessible name of the command's last lines of output." }),
  command: msg({ id: 'workspace.closeCommand.command', defaultMessage: 'The command', description: 'In the close command panel: the accessible name of the command Hive runs, shown as it runs.' }),
  dontWait: msg({ id: 'workspace.closeCommand.dontWait', defaultMessage: "Don't wait", description: 'A button of the close command panel: Hive stops waiting for the command and goes on closing; the command keeps running.' }),
  saving: msg({ id: 'workspace.closeCommand.saving', defaultMessage: 'Waiting for {workspace} to finish saving…', description: "The heading of the close command panel's first step: Hive waits until it has finished writing the closing workspace's files before it runs the user's close command (or When Hive quits, run). {workspace} is the workspace's folder name." }),
  savingNote: msg({ id: 'workspace.closeCommand.savingNote', defaultMessage: "If you don't wait, Hive goes on without running your close command, nor When Hive quits, run: the workspace's files may not be fully saved.", description: "Under the close command panel's Don't wait button while Hive is still saving the closing workspace. Settings → General → When Hive quits, run is a setting's name: keep it as Hive shows it." }),
  dontWaitNote: msg({ id: 'workspace.closeCommand.dontWaitNote', defaultMessage: "If you don't wait, Hive goes on and the command keeps running by itself.", description: "Under the close command panel's Don't wait button." }),
  failedExit: msg({ id: 'workspace.closeCommand.failedExit', defaultMessage: '{kind, select, quit {Your quit command failed (exit code {code})} other {Your close command failed (exit code {code})}}', description: "The heading of the close command panel when the user's command ended with an error. {code} is its exit code (a number, kept as it is). kind quit: the command run as Hive quits; other: as a workspace closes." }),
  failed: msg({ id: 'workspace.closeCommand.failed', defaultMessage: '{kind, select, quit {Your quit command failed} other {Your close command failed}}', description: "The heading of the close command panel when the user's command failed with no exit code. kind quit: the command run as Hive quits; other: as a workspace closes." }),
  drain: msg({ id: 'workspace.closeCommand.drain', defaultMessage: "Hive couldn't finish saving this workspace in time, so your command didn't run.", description: "The heading of the close command panel when Hive didn't run the user's command because saving the workspace as it closed took too long." }),
  spawn: msg({ id: 'workspace.closeCommand.spawn', defaultMessage: "{kind, select, quit {Your quit command couldn't be started} other {Your close command couldn't be started}}", description: "The heading of the close command panel when Windows couldn't start the user's command (the system's reason follows). kind quit: the command run as Hive quits; other: as a workspace closes." }),
  runner: msg({ id: 'workspace.closeCommand.runner', defaultMessage: 'Hive stopped following your command before it ended. It may still be running.', description: 'The heading of the close command panel when Hive lost track of the command it was running (it may carry on by itself).' }),
  close: msg({ id: 'workspace.closeCommand.close', defaultMessage: 'Close', description: 'The button of the close command panel after the command failed: closes the panel, and Hive goes on closing.' })
}

/** The failed panel's heading: its exit code, or why it has none. */
function failedTitle(run: CloseCommandRun): string {
  if (run.failure === 'drain') return tr(M.drain)
  if (run.failure === 'spawn') return tr(M.spawn, { kind: run.kind })
  if (run.failure === 'runner') return tr(M.runner)
  return run.exitCode === null ? tr(M.failed, { kind: run.kind }) : tr(M.failedExit, { kind: run.kind, code: String(run.exitCode) })
}

/**
 * The panel over the window while its close command runs, or after it failed (HI-1368): the command, how long it has
 * run, its last lines of output, and Don't wait (or Close). Main sends it with close-command; nothing behind takes input.
 */
export function CloseCommandPanel() {
  const run = useStore((s) => s.closeCommand)
  if (!run || (run.state !== 'saving' && run.state !== 'running' && run.state !== 'failed')) return null
  return <Panel run={run} />
}

/** The panel up now: its card and its one button, which keep the keyboard while it is. */
let modal: { card: HTMLDivElement | null; button: HTMLButtonElement | null } | null = null

const inside = (t: EventTarget | null): boolean => !!modal?.card && t instanceof Node && modal.card.contains(t)

/**
 * Keeps the keyboard in the panel while it is up (HR6's round 1, finding 4, and round 2, finding 2): Tab stays on its
 * button, focus that leaves the panel comes back, and no other key reaches anything behind it, a dialog's or a menu's
 * own listener included. Listening from when this module loads, before any dialog or menu adds its listener, each key is
 * stopped here first (stopImmediatePropagation); the panel is the top backdrop too (useBackdrop), so a dialog behind it
 * takes no Escape by its own rule either. Escape does nothing: never an implicit Don't wait. Enter and Space press the
 * button, as usual.
 */
window.addEventListener(
  'keydown',
  (e) => {
    if (!modal) return
    if (e.target === modal.button && (e.key === 'Enter' || e.key === ' ')) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.key === 'Tab' || !inside(e.target)) modal.button?.focus()
  },
  true
)
window.addEventListener(
  'focusin',
  (e) => {
    if (modal && !inside(e.target)) modal.button?.focus()
  },
  true
)

function useKeyboardModal(card: React.RefObject<HTMLDivElement | null>, button: React.RefObject<HTMLButtonElement | null>): void {
  useBackdrop()
  useEffect(() => {
    const mine = { card: card.current, button: button.current }
    modal = mine
    if (!inside(document.activeElement)) mine.button?.focus()
    return () => {
      if (modal === mine) modal = null
    }
  }, [card, button])
  // The button changes (Don't wait, then Close): the one to keep the focus on.
  useEffect(() => {
    if (modal) modal.button = button.current
  })
}

function Panel({ run }: { run: CloseCommandRun }) {
  useLanguage()
  const card = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useKeyboardModal(card, button)
  const saving = run.state === 'saving'
  const running = run.state === 'running'
  // Waiting, while saving or running: the spinner and Don't wait.
  const waiting = saving || running
  const now = useNow(running ? 1000 : 60000)
  const started = Date.parse(run.startedAt)
  const lines = run.lines.slice(-8)
  return (
    <div className="overlay close-command" data-state={run.state} data-kind={run.kind}>
      <div ref={card} className="dialog close-command-card" role="alertdialog" aria-modal="true" aria-labelledby="close-command-title" aria-describedby="close-command-state">
        <div className="dialog-header">
          {waiting ? <Icon name="loading" spin /> : <Icon name="error" className="close-command-error" />}
          <h2 id="close-command-title" aria-live="polite">
            {saving ? tr(M.saving, { workspace: run.workspace ?? '' }) : running ? tr(M.running, { kind: run.kind }) : failedTitle(run)}
          </h2>
        </div>
        <div className="dialog-body">
          {run.command && (
            <div className="close-command-text" aria-label={tr(M.command)}>
              {run.command}
            </div>
          )}
          <div id="close-command-state" className="faint" aria-live="polite">
            {running && Number.isFinite(started) ? tr(M.elapsed, { time: durationText(now - started, tr) }) : run.failure === 'spawn' && run.error ? run.error : ''}
          </div>
          {lines.length > 0 && (
            <pre className="close-command-output" aria-label={tr(M.output)}>
              {lines.join('\n')}
            </pre>
          )}
          {waiting && <p className="faint close-command-note">{tr(saving ? M.savingNote : M.dontWaitNote)}</p>}
        </div>
        <div className="dialog-footer">
          {waiting ? (
            <button ref={button} className="btn" autoFocus onClick={() => void call('closeCommand:dontWait', run.id)}>
              {tr(M.dontWait)}
            </button>
          ) : (
            <button ref={button} className="btn primary" autoFocus onClick={() => void call('closeCommand:dismiss', run.id)}>
              {tr(M.close)}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
