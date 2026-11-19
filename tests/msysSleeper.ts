// HI-3421: a Git Bash (MSYS) `sleep 30` started in the background by a shell that then exits, the sleep's winpid written
// once it is sleep: what HI-3047's tests end by its marker (tests/msysMarked.test.ts, tests/gitFolderChanges.test.ts).
//
// Under a full run's load MSYS can refuse the background sleep (a fork or exec that fails, the shell saying why on its
// stderr). The script used to look for the sleep in /proc forever then, writing nothing and spinning a core, and the test's
// wait ran out with no reason given (rc.15, HI-3357). Now the script says so and exits once the sleep is gone, and
// startSleeper starts it again (it's the test's own setup, not what the test checks), saying each try's exit and stderr
// if none starts.
import { spawn } from 'child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from './tempDir'
import { waitUntil } from './waits'

const fwd = (p: string): string => p.replace(/\\/g, '/')

/**
 * Git Bash: a background `sleep 30`, its winpid appended to `file` once it is sleep (until MSYS's exec, `$!` names the
 * forked sh.exe, another Windows process). Should the sleep be gone before that (MSYS refused it), it says so on stderr
 * and exits 1, rather than looking for it forever. Builtins only after the sleep: it starts nothing else. `sleep`: the
 * command it starts (a test of MSYS refusing it names one that isn't there).
 */
export const sleeperScript = (file: string, sleep = 'sleep'): string =>
  `${sleep} 30 & s=$!; while :; do kill -0 "$s" 2>/dev/null || { echo "the background sleep ($s) ended before it was seen as sleep" >&2; exit 1; }; e=; { read -r e < /proc/$s/exename; } 2>/dev/null; case "$e" in */sleep*) break;; esac; done; read -r w < /proc/$s/winpid; echo "$w" >> "${fwd(file)}"`

/** How many times startSleeper starts the shell before it gives up: each failed try is MSYS refusing the sleep. */
const TRIES = 3

/** The winpids in `file`, as sleeperScript writes them. */
export const winpidsIn = (file: string): number[] => (existsSync(file) ? readFileSync(file, 'utf8').split(/\s+/).map(Number).filter((pid) => pid > 0) : [])

/**
 * Starts sleeperScript with Git's own sh (`bin`, its MSYS folder) and `env`, the shell's exit awaited: replies with the
 * sleep's winpid. A shell that exits without one (MSYS refused the sleep) is started again, up to TRIES times; then it
 * throws with each try's exit code and stderr.
 */
export async function startSleeper(o: { bin: string; env: Record<string, string>; sleep?: string }): Promise<number> {
  const dir = tempDir('msys-sleeper-')
  const tries: string[] = []
  for (let n = 1; n <= TRIES; n++) {
    const file = join(dir, `winpid-${n}`)
    const errFile = join(dir, `stderr-${n}`)
    const fd = openSync(errFile, 'w')
    let ended: string | null = null
    try {
      const child = spawn(join(o.bin, 'sh.exe'), ['-c', sleeperScript(file, o.sleep)], { stdio: ['ignore', 'ignore', fd], windowsHide: true, env: o.env })
      child.on('error', (e) => void (ended = `didn't start: ${e.message}`))
      child.on('exit', (code, signal) => void (ended = `exited ${code ?? signal}`))
    } finally {
      closeSync(fd)
    }
    await waitUntil(() => {
      if (ended === null) throw new Error(`try ${n}: Git Bash's sh hasn't exited yet`)
    })
    const winpids = winpidsIn(file)
    if (winpids.length === 1) return winpids[0]
    tries.push(`try ${n}: ${ended}, winpids ${JSON.stringify(winpids)}, stderr: ${readFileSync(errFile, 'utf8').trim().replace(/\r?\n/g, ' | ')}`)
  }
  throw new Error(`Git Bash's sleep didn't start in ${TRIES} tries:\n${tries.join('\n')}`)
}
