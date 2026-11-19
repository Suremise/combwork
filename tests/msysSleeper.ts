// HI-3421: a Git Bash (MSYS) `sleep 30` started in the background by a shell that then exits, the sleep's winpid written
// once it is sleep: what HI-3047's tests end by its marker (tests/msysMarked.test.ts, tests/gitFolderChanges.test.ts).
//
// Under a full run's load MSYS can refuse the background sleep (a fork or exec that fails, the shell saying why on its
// stderr). The script used to look for the sleep in /proc forever then, writing nothing and spinning a core, and the test's
// wait ran out with no reason given (rc.15, HI-3357). Now the script says so and exits once the sleep is gone, and
// startSleeper starts it again (it's the test's own setup, not what the test checks), saying each try's exit and stderr
// if none starts. Until it hands a sleep's winpid to its caller, what it started is its own to end: a shell that doesn't
// exit within the wait is ended, with the sleep it started, before it throws.
import { spawn } from 'child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { boundedOutput } from '../src/main/processTree'
import { tempDir } from './tempDir'
import { timing, waitUntil } from './waits'

const req = createRequire(import.meta.url)
type Ids = { pid: number; started: number }[]
const { identify, endExactly } = req('./e2e/folderProcesses.cjs') as { identify: (pids: number[]) => Ids; endExactly: (targets: Ids) => number }

const fwd = (p: string): string => p.replace(/\\/g, '/')

/**
 * Git Bash: a background `sleep 30`, its winpid appended to `file` once it is sleep (until MSYS's exec, `$!` names the
 * forked sh.exe, another Windows process). Should the sleep be gone before that (MSYS refused it), it says so on stderr
 * and exits 1, rather than looking for it forever. Builtins only after the sleep: it starts nothing else. `sleep`: the
 * command it starts (a test of MSYS refusing it names one that isn't there). `msysPidFile`: where the sleep's MSYS pid
 * (`$!`, the same across its exec) is written as soon as it is forked, for ending it should the shell be ended first.
 */
export const sleeperScript = (file: string, sleep = 'sleep', msysPidFile?: string): string =>
  `${sleep} 30 & s=$!; ${msysPidFile ? `echo "$s" > "${fwd(msysPidFile)}"; ` : ''}while :; do kill -0 "$s" 2>/dev/null || { echo "the background sleep ($s) ended before it was seen as sleep" >&2; exit 1; }; e=; { read -r e < /proc/$s/exename; } 2>/dev/null; case "$e" in */sleep*) break;; esac; done; read -r w < /proc/$s/winpid; echo "$w" >> "${fwd(file)}"`

/** How many times startSleeper starts the shell before it gives up: each failed try is MSYS refusing the sleep. */
const TRIES = 3

/** The winpids in `file`, as sleeperScript writes them. */
export const winpidsIn = (file: string): number[] => (existsSync(file) ? readFileSync(file, 'utf8').split(/\s+/).map(Number).filter((pid) => pid > 0) : [])

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A try's files: the sleep's winpid, its MSYS pid, the shell's stderr. */
type TryFiles = { file: string; msysPidFile: string; errFile: string }

/**
 * How startSleeper waits for a try's shell to exit: `check` throws until it has. A test of the wait running out passes
 * one that throws on its own (given the try's files, to choose when).
 */
type ExitWait = (check: () => void, files: TryFiles) => Promise<unknown>

/**
 * Starts sleeperScript with Git's own sh (`bin`, its MSYS folder) and `env`, the shell's exit awaited: replies with the
 * sleep's winpid, the caller's to end from then on. A shell that exits without one (MSYS refused the sleep) is started
 * again, up to TRIES times; then it throws with each try's exit code and stderr. A shell that doesn't exit within the wait
 * is ended by its handle, and the sleep it started by its winpid (identified) or, before that is known, by its MSYS pid,
 * before it throws with the shell's state and stderr.
 */
export async function startSleeper(o: { bin: string; env: Record<string, string>; sleep?: string; waitExit?: ExitWait }): Promise<number> {
  const dir = tempDir('msys-sleeper-')
  const waitExit: ExitWait = o.waitExit ?? ((check) => waitUntil(check))
  const stderrOf = (errFile: string): string => readFileSync(errFile, 'utf8').trim().replace(/\r?\n/g, ' | ')
  const tries: string[] = []
  for (let n = 1; n <= TRIES; n++) {
    const files: TryFiles = { file: join(dir, `winpid-${n}`), msysPidFile: join(dir, `msyspid-${n}`), errFile: join(dir, `stderr-${n}`) }
    const fd = openSync(files.errFile, 'w')
    let ended: string | null = null
    let child: ReturnType<typeof spawn> | undefined
    try {
      child = spawn(join(o.bin, 'sh.exe'), ['-c', sleeperScript(files.file, o.sleep, files.msysPidFile)], { stdio: ['ignore', 'ignore', fd], windowsHide: true, env: o.env })
      child.on('error', (e) => void (ended = `didn't start: ${e.message}`))
      child.on('exit', (code, signal) => void (ended = `exited ${code ?? signal}`))
    } finally {
      closeSync(fd)
    }
    try {
      await waitExit(() => {
        if (ended === null) throw new Error(`try ${n}: Git Bash's sh hasn't exited yet`)
      }, files)
    } catch (e) {
      throw new Error(`${(e as Error).message}; ${await endTry(child, () => ended, files, o)}; stderr: ${stderrOf(files.errFile)}`, { cause: e })
    }
    const winpids = winpidsIn(files.file)
    if (winpids.length === 1) return winpids[0]
    tries.push(`try ${n}: ${ended}, winpids ${JSON.stringify(winpids)}, stderr: ${stderrOf(files.errFile)}`)
  }
  throw new Error(`Git Bash's sleep didn't start in ${TRIES} tries:\n${tries.join('\n')}`)
}

/**
 * Ends a try whose shell didn't exit in time: the shell by its handle (its exit awaited), the sleep by its winpid once
 * written (identified, so only that process), else by its MSYS pid through Git's own kill (it names the forked sh before
 * the exec and the sleep after). Replies with what it found and did, for the error.
 */
async function endTry(child: ReturnType<typeof spawn> | undefined, ended: () => string | null, files: TryFiles, o: { bin: string; env: Record<string, string> }): Promise<string> {
  const said: string[] = []
  if (child?.pid && ended() === null) {
    said.push(`the shell (pid ${child.pid}) was still running`)
    child.kill()
    await waitUntil(() => {
      if (ended() === null) throw new Error(`the shell (pid ${child.pid}) hasn't exited since it was ended`)
    })
    said.push(`ended (${ended()})`)
  } else said.push(`the shell ${ended() ?? "didn't start"}`)
  const [winpid] = winpidsIn(files.file)
  const msysPid = existsSync(files.msysPidFile) ? Number(readFileSync(files.msysPidFile, 'utf8').trim()) : 0
  if (winpid) {
    const ids = identify([winpid])
    endExactly(ids)
    await waitUntil(() => {
      if (alive(winpid)) throw new Error(`the sleep (winpid ${winpid}) hasn't ended`)
    })
    said.push(`its sleep (winpid ${winpid}) ended`)
  } else if (msysPid > 0) {
    const r = await boundedOutput(join(o.bin, 'sh.exe'), ['-c', `kill -9 ${msysPid} 2>/dev/null; echo done`], { timeoutMs: timing('spawn.hang'), maxBuffer: 64 * 1024, env: o.env })
    said.push('out' in r ? `its sleep (MSYS pid ${msysPid}, no winpid yet) killed` : `its sleep (MSYS pid ${msysPid}) not killed: ${r.error}`)
  } else said.push('no sleep forked yet')
  return said.join(', ')
}
