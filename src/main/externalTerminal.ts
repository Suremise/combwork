import { spawn } from 'child_process'
import { envWithCliFolders } from './freshPath'

type Spawn = typeof spawn

/**
 * Starts a program detached, in its own window, with `env`; false when it couldn't be started. A shell on Windows, as
 * Open External Terminal Here has always run them.
 */
function spawnDetached(spawnFn: Spawn, file: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv): boolean {
  try {
    const child = spawnFn(file, args, { cwd, env, detached: true, stdio: 'ignore', shell: process.platform === 'win32', windowsHide: false })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Open External Terminal Here: Windows Terminal in `dir`, else cmd; elsewhere the system's terminal. It gets Combwork's
 * environment with the folders of the CLIs Combwork found (#1103), as sessions do, so `claude` found off PATH runs in it by
 * name; Combwork's own PATH is left as it is. Which one started is returned (null: none could).
 */
export function openExternalTerminal(dir: string, spawnFn: Spawn = spawn, platform: NodeJS.Platform = process.platform): 'wt' | 'cmd' | 'x-terminal-emulator' | null {
  const env = envWithCliFolders({ ...process.env })
  if (platform === 'win32') {
    if (spawnDetached(spawnFn, 'wt.exe', ['-d', `"${dir}"`], undefined, env)) return 'wt'
    return spawnDetached(spawnFn, 'cmd.exe', ['/c', 'start', 'cmd.exe'], dir, env) ? 'cmd' : null
  }
  return spawnDetached(spawnFn, 'x-terminal-emulator', [], dir, env) ? 'x-terminal-emulator' : null
}
