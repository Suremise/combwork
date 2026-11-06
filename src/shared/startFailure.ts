/**
 * Why an agent's CLI exited before its session had started (a missing or broken CLI, bad arguments, a config
 * error): the CLI's last error lines from its terminal, and a hint where its adapter recognises the error.
 */

import type { SessionStatus } from './types'
import { msg, tr } from './i18n'

/** Where the hint's fix is: the agent's settings (model, extra arguments), Provider Setup (install, sign-in), or its terminal. */
export type StartFix = 'agent-settings' | 'agent-setup' | 'terminal'

export interface StartHint {
  hint: string
  fix?: StartFix
}

export interface StartFailure extends Partial<StartHint> {
  /** The CLI's last error lines, trimmed (the terminal keeps the full output). */
  reason: string
  exitCode: number
  /** The launch was a resume: Retry resumes the conversation again rather than starting a new one. */
  resumed: boolean
  at: string
}

const MAX_LINES = 3
const MAX_CHARS = 300
const ERROR_WORD = /\b(error|errors|failed|fail|not found|unknown|invalid|cannot|can't|couldn't|denied|unexpected|missing|not recognized|panicked)\b/i
// Frames and prompts a TUI draws, with no words in them.
const DECORATION = /^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝>›»•·*_=~|+-]*$/

/** Terminal output as the lines a user would read: escape sequences removed, a line redrawn after \r as its last text. */
export function terminalLines(output: string): string[] {
  const plain = output
    // OSC (titles, links), then CSI (colours, cursor moves; a move right is a space), then any other escape.
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.min(Number(n || 1), 8)))
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  return plain
    .split('\n')
    .map((line) => (line.split('\r').filter((x) => x.trim()).pop() ?? '').replace(/\s+/g, ' ').trim())
    .filter((line) => line && !DECORATION.test(line))
}

/**
 * The lines that say why: from the first line naming an error among the last few (else the last lines), at most
 * three, shortened to fit a bar.
 */
export function lastErrorLines(output: string): string {
  const lines = terminalLines(output).slice(-12)
  const first = lines.findIndex((l) => ERROR_WORD.test(l))
  const picked = first >= 0 ? lines.slice(first, first + MAX_LINES) : lines.slice(-MAX_LINES)
  const text = picked.join('\n')
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1).trimEnd()}…` : text
}

/** What Combwork knows of an agent when its CLI exits. */
export interface ExitInput {
  status: SessionStatus
  /** Its worktree setup still ran: a setup failure is reported by itself. */
  settingUp?: boolean
  /** The user stopped it, or Combwork is quitting. */
  stopRequested: boolean
  /** The CLI refused the conversation because it runs it as a background job (reported by itself). */
  backgroundJob: boolean
  /** The launch was a resume. */
  resumed: boolean
}

/**
 * A failed start: the CLI exited before its session started (still starting) and nobody stopped it. Its reason is
 * what the CLI last said, and the hint its adapter (`cli`) gives for it. Any other exit is a plain stop: undefined.
 */
export function failedStart(s: ExitInput, code: number, output: string, cli: { name: string; startHint?(text: string): StartHint | null }, at = new Date().toISOString()): StartFailure | undefined {
  if (s.status !== 'starting' || s.settingUp || s.stopRequested || s.backgroundJob) return undefined
  const reason = lastErrorLines(output) || tr(msg({ id: 'agents.start.exited', defaultMessage: '{cli} exited with code {code}.', description: "Why an agent couldn't start, when its CLI ({cli}) said nothing: it exited with an exit code ({code}, a number)." }), { cli: cli.name, code })
  return { reason, exitCode: code, resumed: s.resumed, at, ...cli.startHint?.(terminalLines(output).slice(-12).join('\n')) }
}
