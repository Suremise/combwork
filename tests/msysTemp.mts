// HI-3447: a test run never leaves Git Bash's /tmp at its own temp folder. MSYS (Git for Windows' bash, sh and the rest of
// usr\bin) keeps one mount table per Windows session and installation, shared by all its processes and made by the first
// of them while none is running, its /tmp (`usertemp` in Git's etc\fstab) from that process's temp folder (TMP, then
// TEMP); it lasts while any of them runs. A run makes its own folder the temp folder of all it starts (runTemp.mts,
// HI-2102), so a hook's sh, a lane's shell or a test's Git Bash, started while no other MSYS process ran, fixed /tmp there
// for the whole session, and agents' shells kept it so after the run had removed the folder: every Git Bash on the PC
// then said "could not find /tmp", and a script writing there failed.
// So before it changes the temp folder, a run starts a keeper: Git's own cat.exe, with the user's temp folder. Started
// first, it makes the table (or joins one already made, which it leaves as it is: a table some other process made isn't a
// run's to change). It reads its stdin, a pipe the run holds, and ends when that closes, as the run ends however it ends.
// A keeper that doesn't start stops the run before it starts anything. Off Windows, or without Git for Windows' usr\bin,
// there is nothing to keep.
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'

// Read when called, never at module scope (HI-3451): tests bundle Combwork's code for a child process with esbuild as
// CommonJS (electron-stub.ts → tempDir.ts → runTemp.mts → here), where import.meta.url is undefined, and a module-scope
// createRequire(undefined) threw as the bundle loaded: the child ended before it did anything.
const timing = (name: string): number => (createRequire(import.meta.url)('./timing.cjs') as { timing: (name: string) => number }).timing(name)

/** Git for Windows' MSYS folder (`<root>\usr\bin`, with msys-2.0.dll and cat.exe), from git's exec path; null without one. */
export function gitMsysBin(): string | null {
  if (process.platform !== 'win32') return null
  // tests/msysTemp.test.ts: a copy of it, with a mount table of its own (an MSYS installation's is its folder's).
  if (process.env.CW_TEST_MSYS_BIN) return process.env.CW_TEST_MSYS_BIN
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const exec = r.status === 0 ? r.stdout.trim() : ''
  if (!exec) return null
  // `<root>\<mingw>\libexec\git-core`
  const bin = join(dirname(dirname(dirname(exec))), 'usr', 'bin')
  return existsSync(join(bin, 'msys-2.0.dll')) && existsSync(join(bin, 'cat.exe')) ? bin : null
}

/** A keeper started: `ready` resolves once MSYS has started it (or with why it couldn't), never rejects. */
export interface MsysKeeper {
  child: ChildProcess | null
  ready: Promise<string | null>
}

/**
 * Starts `bin`'s cat.exe with `temp` as its temp folder (TMP and TEMP: Windows' GetTempPath reads TMP first), so the
 * session's MSYS mount table, if none is made yet, maps /tmp there. It ends when this process does (its stdin closes);
 * nothing of it keeps this process running. `ready`: null once cat has echoed a line back, MSYS started in it; else why
 * not (it couldn't be started, it ended first, or it didn't answer within `readyMs`), and one still running is ended, by
 * its own handle (HR1's round 1).
 */
export function startMsysKeeper(bin: string, temp: string, readyMs = timing('msys.keeperReadyMs')): MsysKeeper {
  let child: ChildProcess
  try {
    child = spawn(join(bin, 'cat.exe'), [], { env: { SystemRoot: process.env.SystemRoot, PATH: bin, TMP: temp, TEMP: temp }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  } catch (e) {
    return { child: null, ready: Promise.resolve(`it couldn't be started: ${(e as Error).message}`) }
  }
  const ready = new Promise<string | null>((resolve) => {
    const bound = setTimeout(() => done(`it didn't answer within ${readyMs} ms`), readyMs)
    let answered = false
    const done = (why: string | null): void => {
      if (answered) return
      answered = true
      clearTimeout(bound)
      if (why && child.exitCode === null && child.signalCode === null) child.kill()
      resolve(why)
    }
    child.once('error', (e) => done(`it couldn't be started: ${e.message}`))
    child.once('exit', (code) => done(`it ended (${code}) before it answered`))
    child.stdout!.once('data', () => done(null))
    child.stdin!.on('error', () => undefined)
    child.stdin!.write('up\n')
  })
  void ready.then(() => {
    child.stdout!.removeAllListeners('data')
    child.stdout!.resume()
    // Nothing of it holds the run's event loop: it goes with the run.
    child.unref()
    ;(child.stdin as unknown as { unref?: () => void }).unref?.()
    ;(child.stdout as unknown as { unref?: () => void }).unref?.()
  })
  return { child, ready }
}

/**
 * The run's keeper's `ready`, on the process: Vitest loads its config (which starts it) and its global setup (which awaits
 * it, tests/tempRun.ts) as separate copies of this module, in the same process.
 */
const KEPT = Symbol.for('combwork.test.msysKeeper')
const store = globalThis as { [KEPT]?: Promise<string | null> }

/**
 * The run's keeper (runTemp.mts's startRunTemp starts it, with the temp folder as it was before the run's): a no-op off
 * Windows or without Git for Windows.
 */
export function keepMsysTemp(temp: string | undefined): void {
  const bin = temp ? gitMsysBin() : null
  if (bin && temp) store[KEPT] = startMsysKeeper(bin, temp).ready
}

/**
 * Resolves once the run's keeper has started (at once where none is needed: off Windows, or without Git for Windows): the
 * runners await it before they start anything that may run Git Bash. A keeper tried that didn't start rejects, and the
 * run starts nothing (HR1's round 1): its first Git Bash could otherwise still set /tmp to the run's folder.
 */
export async function msysTempKept(): Promise<void> {
  const why = await (store[KEPT] ?? null)
  if (why) throw new Error(`Git Bash's /tmp keeper didn't start (HI-3447): ${why}. The run starts nothing: its first Git Bash could set /tmp, for every Git Bash on this PC, to the run's temp folder, which goes with it.`)
}
