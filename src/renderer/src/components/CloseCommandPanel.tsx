import { useEffect, useRef } from 'react'
import type { CloseCommandRun } from '@shared/types'
import { msg, tr } from '@shared/i18n'
import { durationText } from '@shared/tasks'
import { call } from '../api'
import { useLanguage, useStore } from '../store'
import { useNow } from '../usage'
import { Icon } from './ui'

const M = {
  running: msg({ id: 'workspace.closeCommand.running', defaultMessage: '{kind, select, quit {Running your quit command…} other {Running your close command…}}', description: "The heading of the panel Hive shows while it runs the user's own command as a workspace closes (kind other: Settings → Workspace → When this workspace closes, run) or as Hive quits (kind quit: Settings → General → When Hive quits, run)." }),
  elapsed: msg({ id: 'workspace.closeCommand.elapsed', defaultMessage: 'Running for {time}', description: 'In the close command panel: how long the command has run so far. {time} is a short duration ("40 s", "2 min").' }),
  output: msg({ id: 'workspace.closeCommand.output', defaultMessage: "The command's last output", description: "In the close command panel: the accessible name of the command's last lines of output." }),
  command: msg({ id: 'workspace.closeCommand.command', defaultMessage: 'The command', description: 'In the close command panel: the accessible name of the command Hive runs, shown as it runs.' }),
  dontWait: msg({ id: 'workspace.closeCommand.dontWait', defaultMessage: "Don't wait", description: 'A button of the close command panel: Hive stops waiting for the command and goes on closing; the command keeps running.' }),
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
  if (!run || (run.state !== 'running' && run.state !== 'failed')) return null
  return <Panel run={run} />
}

/**
 * Keeps the keyboard in the panel while it is up (HR6's round 1, finding 4): Tab stays on its button, focus that leaves
 * the panel comes back, and no other key reaches the window behind (its shortcuts included). Escape does nothing: it is
 * never an implicit Don't wait. Enter and Space press the button, as usual.
 */
function useKeyboardModal(card: React.RefObject<HTMLDivElement | null>, button: React.RefObject<HTMLButtonElement | null>): void {
  useEffect(() => {
    const inside = (t: EventTarget | null): boolean => !!card.current && t instanceof Node && card.current.contains(t)
    const onKey = (e: KeyboardEvent): void => {
      const own = e.target === button.current && (e.key === 'Enter' || e.key === ' ')
      if (own) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Tab' || !inside(e.target)) button.current?.focus()
    }
    const onFocus = (e: FocusEvent): void => {
      if (!inside(e.target)) button.current?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('focusin', onFocus, true)
    if (!inside(document.activeElement)) button.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('focusin', onFocus, true)
    }
  }, [card, button])
}

function Panel({ run }: { run: CloseCommandRun }) {
  useLanguage()
  const card = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useKeyboardModal(card, button)
  const running = run.state === 'running'
  const now = useNow(running ? 1000 : 60000)
  const started = Date.parse(run.startedAt)
  const lines = run.lines.slice(-8)
  return (
    <div className="overlay close-command" data-state={run.state} data-kind={run.kind}>
      <div ref={card} className="dialog close-command-card" role="alertdialog" aria-modal="true" aria-labelledby="close-command-title" aria-describedby="close-command-state">
        <div className="dialog-header">
          {running ? <Icon name="loading" spin /> : <Icon name="error" className="close-command-error" />}
          <h2 id="close-command-title" aria-live="polite">
            {running ? tr(M.running, { kind: run.kind }) : failedTitle(run)}
          </h2>
        </div>
        <div className="dialog-body">
          <div className="close-command-text" aria-label={tr(M.command)}>
            {run.command}
          </div>
          <div id="close-command-state" className="faint" aria-live="polite">
            {running && Number.isFinite(started) ? tr(M.elapsed, { time: durationText(now - started, tr) }) : run.failure === 'spawn' && run.error ? run.error : ''}
          </div>
          {lines.length > 0 && (
            <pre className="close-command-output" aria-label={tr(M.output)}>
              {lines.join('\n')}
            </pre>
          )}
          {running && <p className="faint close-command-note">{tr(M.dontWaitNote)}</p>}
        </div>
        <div className="dialog-footer">
          {running ? (
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
