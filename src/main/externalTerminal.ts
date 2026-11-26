import { spawn } from 'child_process'
import { access } from 'original-fs/promises'
import { join } from 'path'
import { withValues, type TextPart } from '../shared/advancedDef'
import { msg } from '../shared/i18n'
import { EXTERNAL_TERMINAL_NAME, externalTerminalSetting } from '../shared/externalTerminal'
import { combworkError } from './combworkError'
import { envWithCliFolders } from './freshPath'

type Spawn = typeof spawn
type Exists = (path: string) => Promise<boolean>
/** Why a terminal didn't open, or null: it did. */
type Why = TextPart | null
type WindowsTerminal = keyof typeof EXTERNAL_TERMINAL_NAME
export type ExternalTerminal = WindowsTerminal | 'x-terminal-emulator'

/**
 * How long a terminal's launcher is watched once it has started (HI-3582): an error or a non-zero exit by then means it
 * didn't open. Windows Terminal's wt.exe hands over to the terminal and ends; `cmd /c start` ends once it has started
 * the new window. One still running by then has opened.
 */
export const SETTLE_MS = 2000

/** cmd.exe's arguments before the program it opens in a window of its own: `start`'s first quoted argument is the title. */
export const IN_WINDOW = ['/c', 'start', '']

const M = {
  failed: msg({ id: 'project.externalTerminal.failed', defaultMessage: "{terminal} didn't open: {reason}", description: "Why Open External Terminal Here opened nothing (HI-3582), shown under the error's title. {terminal} is the terminal's name (Windows Terminal, Command Prompt, PowerShell); {reason} is why, Windows' error or one of Combwork's reasons." }),
  exited: msg({ id: 'project.externalTerminal.exited', defaultMessage: 'it ended at once with exit code {code}', description: "Why a terminal didn't open (HI-3582): its program started and ended at once with this exit code. Follows \"Windows Terminal didn't open: \"." }),
  missing: msg({ id: 'project.externalTerminal.missing', defaultMessage: "{path} isn't there", description: "Why a terminal didn't open (HI-3582): its program isn't at this path. Follows \"PowerShell didn't open: \"." })
}

/**
 * Starts a terminal's launcher detached, with `env`, without a shell: a shell would start whether or not the program
 * can, and hide why (HI-3582: a `wt.exe` app alias on the PATH without Windows Terminal behind it opened nothing and
 * said nothing). Resolves null once it has opened, else why not, as text.
 */
function start(spawnFn: Spawn, file: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<Why> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const done = (why: Why): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(why)
    }
    let child: ReturnType<Spawn>
    try {
      child = spawnFn(file, args, { cwd, env, detached: true, stdio: 'ignore', windowsHide: false })
    } catch (e) {
      done(e instanceof Error ? e.message : String(e))
      return
    }
    // Always listened to: an error after it settled mustn't become an uncaught one.
    child.on('error', (e: Error) => done(e.message))
    child.once('exit', (code: number | null) => done(code === null || code === 0 ? null : withValues(M.exited, { code: String(code) })))
    child.once('spawn', () => {
      timer = setTimeout(() => done(null), SETTLE_MS)
      timer.unref?.()
    })
    child.unref()
  })
}

const exists: Exists = (path) => access(path).then(
  () => true,
  () => false
)

/**
 * Open External Terminal Here: the terminal the External terminal setting names (HI-3582) in `dir`; Automatic is
 * Windows Terminal, else Command Prompt. Elsewhere the system's terminal. It gets Combwork's environment with the folders
 * of the CLIs Combwork found (#1103), as sessions do, so `claude` found off PATH runs in it by name; Combwork's own PATH
 * is left as it is. Resolves to which one opened; throws, saying which and why, when none did: a named terminal that
 * can't open is never swapped for another.
 */
export async function openExternalTerminal(dir: string, setting: unknown = 'auto', spawnFn: Spawn = spawn, platform: NodeJS.Platform = process.platform, fileExists: Exists = exists): Promise<ExternalTerminal> {
  const env = envWithCliFolders({ ...process.env })
  if (platform !== 'win32') {
    const why = await start(spawnFn, 'x-terminal-emulator', [], dir, env)
    if (why === null) return 'x-terminal-emulator'
    throw combworkError(M.failed, { terminal: 'x-terminal-emulator', reason: why }) // i18n-ignore: a program's name
  }
  const system = join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32') // i18n-ignore: Windows' own folder
  const cmd = join(system, 'cmd.exe') // i18n-ignore: a program's file name
  /** cmd.exe's start opens it in a console window of its own (a detached child has none), after checking it's there. */
  const inWindow = async (program: string): Promise<Why> => {
    for (const path of [cmd, program]) if (!(await fileExists(path))) return withValues(M.missing, { path })
    return start(spawnFn, cmd, [...IN_WINDOW, program], dir, env)
  }
  const open = (terminal: WindowsTerminal): Promise<Why> => {
    // wt splits its command line at `;` (a new tab): one in the folder's name is escaped.
    if (terminal === 'wt') return start(spawnFn, 'wt.exe', ['-d', dir.replace(/;/g, '\\;')], undefined, env) // i18n-ignore: a program's file name
    if (terminal === 'cmd') return inWindow(cmd)
    return inWindow(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe')) // i18n-ignore: Windows PowerShell's place
  }
  const chosen = externalTerminalSetting(setting)
  const order: WindowsTerminal[] = chosen === 'auto' ? ['wt', 'cmd'] : [chosen]
  let failure: { terminal: WindowsTerminal; why: TextPart } | undefined
  for (const terminal of order) {
    const why = await open(terminal)
    if (why === null) return terminal
    failure = { terminal, why }
  }
  throw combworkError(M.failed, { terminal: EXTERNAL_TERMINAL_NAME[failure!.terminal], reason: failure!.why })
}
