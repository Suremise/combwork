import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CloseCommandRun, CloseCommandStep } from '@shared/types'
import { msg, tr } from '@shared/i18n'
import { durationText } from '@shared/tasks'
import { call } from '../api'
import { useLanguage, useStore } from '../store'
import { useNow } from '../usage'
import { Icon, Tooltip, useBackdrop } from './ui'

const M = {
  running: msg({ id: 'workspace.closeCommand.running', defaultMessage: '{kind, select, quit {Running your quit command…} other {Running your close command…}}', description: "The heading of the panel Hive shows while it runs the user's own command as a workspace closes (kind other: Settings → Workspace → When this workspace closes, run) or as Hive quits (kind quit: Settings → General → When Hive quits, run)." }),
  runningPoint: msg({ id: 'workspace.commands.running', defaultMessage: '{point, select, open {Running your commands for when {workspace} opens…} close {Running your commands for when {workspace} closes…} quit {Running your commands for when Hive quits…} other {Running your command…}}', description: "The heading of the dialog Hive shows while it runs the user's own commands (HI-1954): as a workspace opens or closes ({workspace}: its folder name), as Hive quits, or one the user ran by hand (other)." }),
  elapsed: msg({ id: 'workspace.closeCommand.elapsed', defaultMessage: 'Running for {time}', description: 'In the close command panel: how long the command has run so far. {time} is a short duration ("40 s", "2 min").' }),
  output: msg({ id: 'workspace.closeCommand.output', defaultMessage: "The command's last output", description: "In the close command panel: the accessible name of the command's last lines of output." }),
  command: msg({ id: 'workspace.closeCommand.command', defaultMessage: 'The command', description: 'In the close command panel: the accessible name of the command Hive runs, shown as it runs.' }),
  steps: msg({ id: 'workspace.commands.steps', defaultMessage: 'The commands, in the order they run', description: "In the commands dialog (HI-1954): the accessible name of the list of the user's commands it runs." }),
  dontWait: msg({ id: 'workspace.closeCommand.dontWait', defaultMessage: "Don't wait", description: 'A button of the close command panel: Hive stops waiting for the command and goes on closing; the command keeps running.' }),
  saving: msg({ id: 'workspace.closeCommand.saving', defaultMessage: 'Waiting for {workspace} to finish saving…', description: "The heading of the close command panel's first step: Hive waits until it has finished writing the closing workspace's files before it runs the user's close command (or When Hive quits, run). {workspace} is the workspace's folder name." }),
  savingNote: msg({ id: 'workspace.closeCommand.savingNote', defaultMessage: 'Hive finishes saving first. If you skip, it won\'t run your close command or the "When Hive quits" one.', description: "Under the close command panel's Skip the command button, while Hive is still closing and saving the workspace (the close always finishes). The quoted When Hive quits names the setting Settings → General → When Hive quits, run: keep it in quotes." }),
  skip: msg({ id: 'workspace.closeCommand.skip', defaultMessage: 'Skip the command', description: "A button of the close command panel while Hive is still closing and saving the workspace: the user's close command (and When Hive quits, run) won't run; Hive still finishes closing the workspace." }),
  skipped: msg({ id: 'workspace.closeCommand.skipped', defaultMessage: "Skipped: the command won't run. Hive is finishing closing the workspace.", description: 'In the close command panel once the user has pressed Skip the command, while Hive finishes closing the workspace (the panel then goes).' }),
  dontWaitNote: msg({ id: 'workspace.closeCommand.dontWaitNote', defaultMessage: "If you don't wait, Hive goes on and the command keeps running by itself.", description: "Under the close command panel's Don't wait button." }),
  dontWaitList: msg({ id: 'workspace.commands.dontWaitNote', defaultMessage: "{point, select, open {If you don't wait, Hive goes on and the rest run by themselves, in order. Agents start now.} other {If you don't wait, Hive goes on and the rest run by themselves, in order.}}", description: "Under the commands dialog's Don't wait button (HI-1954): the commands not finished keep running in the background, one after another. point open: the workspace is opening, and its agents, held back meanwhile, can start now." }),
  failedExit: msg({ id: 'workspace.closeCommand.failedExit', defaultMessage: '{kind, select, quit {Your quit command failed (exit code {code})} other {Your close command failed (exit code {code})}}', description: "The heading of the close command panel when the user's command ended with an error. {code} is its exit code (a number, kept as it is). kind quit: the command run as Hive quits; other: as a workspace closes." }),
  failed: msg({ id: 'workspace.closeCommand.failed', defaultMessage: '{kind, select, quit {Your quit command failed} other {Your close command failed}}', description: "The heading of the close command panel when the user's command failed with no exit code. kind quit: the command run as Hive quits; other: as a workspace closes." }),
  stepFailedExit: msg({ id: 'workspace.commands.failedExit', defaultMessage: '"{name}" failed (exit code {code})', description: "The heading of the commands dialog when one of the user's commands ended with an error (HI-1954). {name} is the command's name, {code} its exit code (a number, kept as it is)." }),
  stepSpawn: msg({ id: 'workspace.commands.spawn', defaultMessage: '"{name}" couldn\'t be started', description: "The heading of the commands dialog when Windows couldn't start one of the user's commands (HI-1954); the system's reason follows. {name} is the command's name." }),
  stepPlaceholder: msg({ id: 'workspace.commands.placeholder', defaultMessage: '"{name}" didn\'t run: {placeholders} can\'t be filled', description: "The heading of the commands dialog when one of the user's commands didn't run because placeholders in it have no value now (HI-1954): {placeholders} lists them as written, such as {project:api} or {workspace}. {name} is the command's name." }),
  stepFolder: msg({ id: 'workspace.commands.folder', defaultMessage: '"{name}" didn\'t run: its folder isn\'t there', description: "The heading of the commands dialog when one of the user's commands didn't run because its working folder doesn't exist (HI-1954); the folder follows. {name} is the command's name." }),
  drain: msg({ id: 'workspace.closeCommand.drain', defaultMessage: "Hive couldn't finish saving this workspace in time, so your command didn't run.", description: "The heading of the close command panel when Hive didn't run the user's command because saving the workspace as it closed took too long." }),
  spawn: msg({ id: 'workspace.closeCommand.spawn', defaultMessage: "{kind, select, quit {Your quit command couldn't be started} other {Your close command couldn't be started}}", description: "The heading of the close command panel when Windows couldn't start the user's command (the system's reason follows). kind quit: the command run as Hive quits; other: as a workspace closes." }),
  runner: msg({ id: 'workspace.closeCommand.runner', defaultMessage: 'Hive stopped following your command before it ended. It may still be running.', description: 'The heading of the close command panel when Hive lost track of the command it was running (it may carry on by itself).' }),
  close: msg({ id: 'workspace.closeCommand.close', defaultMessage: 'Close', description: 'The button of the close command panel after the command failed: closes the panel, and Hive goes on closing.' }),
  rerun: msg({ id: 'workspace.commands.rerun', defaultMessage: 'Rerun', description: "A button of the commands dialog when one of the user's commands failed (HI-1954): runs that command again." }),
  skipContinue: msg({ id: 'workspace.commands.skipContinue', defaultMessage: 'Skip it and continue', description: "A button of the commands dialog when one of the user's commands failed (HI-1954): leaves it failed and runs the rest of the list." }),
  stopHere: msg({ id: 'workspace.commands.stopHere', defaultMessage: 'Stop here', description: "A button of the commands dialog when one of the user's commands failed (HI-1954): runs none of the rest of the list; Hive goes on (a workspace opening still starts its agents)." }),
  neededWarn: msg({ id: 'workspace.commands.neededWarn', defaultMessage: 'The commands after it need it: skipping it may make them fail.', description: "In the commands dialog when a failed command has \"The commands after this need it\" ticked (HI-1954): a warning beside Skip it and continue." }),
  waiting: msg({ id: 'workspace.commands.waiting', defaultMessage: 'waiting', description: "In the commands dialog's list (HI-1954): a command not run yet." }),
  ranFor: msg({ id: 'workspace.commands.ranFor', defaultMessage: '{time}', description: 'In the commands dialog\'s list (HI-1954): how long a command took or has run so far. {time} is a short duration ("12 s", "2 min"); usually kept as it is.' }),
  exitCode: msg({ id: 'workspace.commands.exitCode', defaultMessage: 'exit code {code}', description: "In the commands dialog's list (HI-1954): a command that failed, its exit code (a number, kept as it is)." }),
  notRun: msg({ id: 'workspace.commands.notRun', defaultMessage: "didn't run", description: "In the commands dialog's list (HI-1954): a command that failed before it started (a placeholder, its folder, or Windows couldn't start it)." }),
  skippedStep: msg({ id: 'workspace.commands.skipped', defaultMessage: 'skipped', description: "In the commands dialog's list (HI-1954): a command skipped (Stop here, or after a failure)." })
}

const ICONS: Record<CloseCommandStep['state'], string> = { waiting: 'circle-large-outline', running: 'loading', ok: 'check', failed: 'error', skipped: 'dash' }

/** The failed panel's heading: its exit code, or why it has none. */
function failedTitle(run: CloseCommandRun): string {
  const a = run.awaiting
  const step = a ? run.steps?.[a.step] : undefined
  if (step) {
    if (step.failure === 'spawn') return tr(M.stepSpawn, { name: step.name })
    if (step.failure === 'placeholder') return tr(M.stepPlaceholder, { name: step.name, placeholders: step.detail ?? '' })
    if (step.failure === 'folder') return tr(M.stepFolder, { name: step.name })
    return tr(M.stepFailedExit, { name: step.name, code: String(step.exitCode ?? '') })
  }
  if (run.failure === 'drain') return tr(M.drain)
  if (run.failure === 'spawn') return tr(M.spawn, { kind: run.kind })
  if (run.failure === 'runner') return tr(M.runner)
  return run.exitCode === null ? tr(M.failed, { kind: run.kind }) : tr(M.failedExit, { kind: run.kind, code: String(run.exitCode) })
}

/**
 * The panel over the window while its commands run, or after one failed (HI-1368, HI-1954): what runs, how long, its
 * last lines of output, and Don't wait; on a failed command of a list, Rerun, Skip it and continue or Stop here; on a
 * failure Hive can't go past, Close. Main sends it with close-command; nothing behind takes input.
 */
export function CloseCommandPanel() {
  const run = useStore((s) => s.closeCommand)
  if (!run || (run.state !== 'saving' && run.state !== 'running' && run.state !== 'failed')) return null
  return <Panel run={run} />
}

/** The panel up now: its card and its buttons, which keep the keyboard while it is. */
let modal: { card: HTMLDivElement | null; buttons: HTMLButtonElement[] } | null = null

const inside = (t: EventTarget | null): boolean => !!modal?.card && t instanceof Node && modal.card.contains(t)

/**
 * Keeps the keyboard in the panel while it is up (HR6's round 1, finding 4, and round 2, finding 2): Tab goes from
 * button to button, focus that leaves the panel comes back, and no other key reaches anything behind it, a dialog's or a
 * menu's own listener included. Listening from when this module loads, before any dialog or menu adds its listener, each
 * key is stopped here first (stopImmediatePropagation); the panel is the top backdrop too (useBackdrop), so a dialog
 * behind it takes no Escape by its own rule either. Escape does nothing: never an implicit Don't wait or choice. Enter
 * and Space press the button that has the focus, as usual.
 */
window.addEventListener(
  'keydown',
  (e) => {
    if (!modal) return
    const buttons = modal.buttons
    const at = buttons.indexOf(e.target as HTMLButtonElement)
    if (at >= 0 && (e.key === 'Enter' || e.key === ' ')) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (!buttons.length) return
    if (e.key === 'Tab') buttons[at < 0 ? 0 : (at + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus()
    else if (!inside(e.target)) buttons[0]?.focus()
  },
  true
)
window.addEventListener(
  'focusin',
  (e) => {
    if (modal && !inside(e.target)) modal.buttons[0]?.focus()
  },
  true
)

/** A footer's buttons, and the one to focus first (the lead choice, else the first). */
const footerButtons = (f: HTMLDivElement | null): HTMLButtonElement[] => [...(f?.querySelectorAll('button') ?? [])]
const leadButton = (f: HTMLDivElement | null): HTMLButtonElement | undefined => f?.querySelector<HTMLButtonElement>('button[data-lead]') ?? footerButtons(f)[0]

function useKeyboardModal(card: React.RefObject<HTMLDivElement | null>, footer: React.RefObject<HTMLDivElement | null>): void {
  useBackdrop()
  useEffect(() => {
    const mine = { card: card.current, buttons: footerButtons(footer.current) }
    modal = mine
    if (!inside(document.activeElement)) leadButton(footer.current)?.focus()
    return () => {
      if (modal === mine) modal = null
    }
  }, [card, footer])
  // The buttons change (Don't wait, then the choices or Close): the ones to keep the focus among, the lead one focused.
  useEffect(() => {
    if (!modal) return
    const was = modal.buttons
    modal.buttons = footerButtons(footer.current)
    if (!modal.buttons.some((b) => was.includes(b))) leadButton(footer.current)?.focus()
  })
}

/**
 * The command Hive runs (HI-2031): at most two lines, cut with an ellipsis, and the whole line in a tooltip on hover when
 * it is cut. A screen reader reads it whole: only its look is cut.
 */
function CommandLine({ command }: { command: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    setCut(!!el && el.scrollHeight > el.clientHeight + 1)
  }, [command])
  return (
    <Tooltip content={cut ? command : null} block className="close-command-tip">
      <div ref={ref} className="close-command-text close-command-line" aria-label={tr(M.command)} data-cut={cut || undefined}>
        {command}
      </div>
    </Tooltip>
  )
}

function StepRow({ step, current, command, now, lines }: { step: CloseCommandStep; current: boolean; command: string; now: number; lines: string[] }) {
  const started = step.startedAt ? Date.parse(step.startedAt) : NaN
  const ended = step.endedAt ? Date.parse(step.endedAt) : now
  const time = Number.isFinite(started) ? tr(M.ranFor, { time: durationText(ended - started, tr) }) : ''
  const said =
    step.state === 'waiting'
      ? tr(M.waiting)
      : step.state === 'skipped'
        ? tr(M.skippedStep)
        : step.state === 'failed'
          ? step.exitCode !== null
            ? tr(M.exitCode, { code: String(step.exitCode) })
            : tr(M.notRun)
          : time
  return (
    <li className="close-command-step" data-state={step.state}>
      <div className="flex close-command-step-line">
        <Icon name={ICONS[step.state]} spin={step.state === 'running'} className={step.state === 'failed' ? 'close-command-error' : undefined} />
        <span className="grow">{step.name}</span>
        <span className="faint">{said}</span>
      </div>
      {current && (command || step.detail || lines.length > 0) && (
        <>
          {command && <CommandLine command={command} />}
          {step.detail && <div className="close-command-text">{step.detail}</div>}
          {lines.length > 0 && (
            <pre className="close-command-output" aria-label={tr(M.output)}>
              {lines.join('\n')}
            </pre>
          )}
        </>
      )}
    </li>
  )
}

function Panel({ run }: { run: CloseCommandRun }) {
  useLanguage()
  const card = useRef<HTMLDivElement>(null)
  const footer = useRef<HTMLDivElement>(null)
  useKeyboardModal(card, footer)
  const saving = run.state === 'saving'
  const running = run.state === 'running'
  const awaiting = run.state === 'failed' ? run.awaiting : null
  // Waiting, while saving or running: the spinner and Don't wait.
  const waiting = saving || running
  const now = useNow(running ? 1000 : 60000)
  const started = Date.parse(run.startedAt)
  const lines = run.lines.slice(-8)
  const steps = run.steps
  const currentStep = awaiting ? awaiting.step : (steps?.findIndex((s) => s.state === 'running') ?? -1)
  const needed = !!awaiting?.needed
  const choose = (action: 'rerun' | 'skip' | 'stop'): void => void (awaiting && call('closeCommand:control', run.id, action, awaiting.step, awaiting.attempt))
  const title = saving ? tr(M.saving, { workspace: run.workspace ?? '' }) : running ? (steps ? tr(M.runningPoint, { point: run.point ?? 'manual', workspace: run.workspace ?? '' }) : tr(M.running, { kind: run.kind })) : failedTitle(run)
  return (
    <div className="overlay close-command" data-state={run.state} data-kind={run.kind} data-point={run.point}>
      <div ref={card} className="dialog close-command-card" role="alertdialog" aria-modal="true" aria-labelledby="close-command-title" aria-describedby="close-command-state">
        <div className="dialog-header">
          {waiting ? <Icon name="loading" spin /> : <Icon name="error" className="close-command-error" />}
          <h2 id="close-command-title" aria-live="polite">
            {title}
          </h2>
        </div>
        <div className="dialog-body">
          {steps ? (
            <ol className="close-command-steps" aria-label={tr(M.steps)}>
              {steps.map((s, i) => (
                <StepRow key={i} step={s} current={i === currentStep} command={i === currentStep ? run.command : ''} now={now} lines={i === currentStep ? lines : []} />
              ))}
            </ol>
          ) : (
            <>
              {run.command && <CommandLine command={run.command} />}
              {lines.length > 0 && (
                <pre className="close-command-output" aria-label={tr(M.output)}>
                  {lines.join('\n')}
                </pre>
              )}
            </>
          )}
          <div id="close-command-state" className="faint" aria-live="polite">
            {running && !steps && Number.isFinite(started) ? tr(M.elapsed, { time: durationText(now - started, tr) }) : !steps && run.failure === 'spawn' && run.error ? run.error : ''}
          </div>
          {waiting && <p className="faint close-command-note">{tr(saving ? (run.skipped ? M.skipped : M.savingNote) : steps ? M.dontWaitList : M.dontWaitNote, { point: run.point ?? 'manual' })}</p>}
          {needed && (
            <p className="close-command-note close-command-warn">
              <Icon name="warning" /> {tr(M.neededWarn)}
            </p>
          )}
        </div>
        <div ref={footer} className="dialog-footer">
          {waiting ? (
            // While saving, Skip the command (once pressed it stays, done: the panel goes as the close ends); then Don't wait.
            <button className="btn" data-lead autoFocus aria-disabled={saving && run.skipped ? true : undefined} onClick={() => void (!(saving && run.skipped) && call('closeCommand:dontWait', run.id))}>
              {tr(saving ? M.skip : M.dontWait)}
            </button>
          ) : awaiting ? (
            <>
              <button className="btn" onClick={() => choose('rerun')}>
                {tr(M.rerun)}
              </button>
              <button className={needed ? 'btn' : 'btn primary'} data-lead={needed ? undefined : true} onClick={() => choose('skip')}>
                {tr(M.skipContinue)}
              </button>
              <button className={needed ? 'btn primary' : 'btn'} data-lead={needed ? true : undefined} onClick={() => choose('stop')}>
                {tr(M.stopHere)}
              </button>
            </>
          ) : (
            <button className="btn primary" data-lead autoFocus onClick={() => void call('closeCommand:dismiss', run.id)}>
              {tr(M.close)}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
