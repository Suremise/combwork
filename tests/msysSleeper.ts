// HI-3421: a Git Bash (MSYS) `sleep 30` started in the background by a shell that then exits, the sleep's winpid written
// once it is sleep: what HI-3047's tests end by its marker (tests/msysMarked.test.ts, tests/gitFolderChanges.test.ts).
//
// The shell's PATH starts with Git's MSYS folder (HI-3455), as findMsysMarked's own does: a run started from PowerShell or
// cmd has Git's `cmd` folder on its PATH but not `usr\bin`, so MSYS's PATH had no /usr/bin and `sleep` wasn't found
// ("sleep: command not found", every time). That, not load, was rc.15's failure: first a script that looked for the gone
// sleep in /proc forever (HI-3357), then, once it said so and exited (HI-3421), three tries failing alike (HI-3455). The
// script still says so and exits once the sleep is gone, and startSleeper throws with its exit and stderr: one try, since
// nothing seen called for another.
//
// Until it hands a sleep's winpid to its caller, what the shell started is its own to end (HR1's rounds 1 and 2): the
// shell gets a marker of its own in its environment, which everything it starts inherits from the moment it is forked
// (the forked sh before MSYS's exec, the sleep after). A shell that doesn't exit within the wait is ended by its handle,
// and then whatever carries that marker, found as HI-3047 finds a timed command's MSYS programs (processTree's
// findMsysMarked and msysMatches: each by its winpid and start time) and ended by that identity, until a search finds none.
// Never by a pid read from a file: a pid written earlier may name another process by then.
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { closeSync, existsSync, openSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { boundedOutput, findMsysMarked, msysMatches, MSYS_FIND_SCRIPT, RUN_MARK_VAR, type ListedProcess } from '../src/main/processTree'
import { tempDir } from './tempDir'
import { waitUntil } from './waits'

const req = createRequire(import.meta.url)
type Ids = { pid: number; started: number }[]
const { endExactly, processes } = req('./e2e/folderProcesses.cjs') as { endExactly: (targets: Ids) => number; processes: () => ListedProcess[] }
const { envValue, withPathFirst } = req('./e2e/runContext.cjs') as {
  envValue: (env: Record<string, string>, name: string) => string | undefined
  withPathFirst: (env: Record<string, string>, dirs: string | string[], rest?: string) => Record<string, string>
}

const fwd = (p: string): string => p.replace(/\\/g, '/')

/**
 * Git Bash: a background `sleep 30`, its winpid appended to `file` once it is sleep (until MSYS's exec, `$!` names the
 * forked sh.exe, another Windows process). Should the sleep be gone before that (it didn't start), it says so on stderr
 * and exits 1, rather than looking for it forever. Builtins only after the sleep: it starts nothing else. `sleep`: the
 * command it starts (a test of one that doesn't start names one that isn't there).
 */
export const sleeperScript = (file: string, sleep = 'sleep'): string =>
  `${sleep} 30 & s=$!; while :; do kill -0 "$s" 2>/dev/null || { echo "the background sleep ($s) ended before it was seen as sleep" >&2; exit 1; }; e=; { read -r e < /proc/$s/exename; } 2>/dev/null; case "$e" in */sleep*) break;; esac; done; read -r w < /proc/$s/winpid; echo "$w" >> "${fwd(file)}"`

/**
 * The variable a try's marker is in: not Combwork's own (RUN_MARK_VAR), which tests/msysMarked.test.ts sets on some of its
 * sleepers and must leave unset on others.
 */
export const SLEEPER_MARK_VAR = 'CW_TEST_SLEEPER'
/** findMsysMarked's script, looking for SLEEPER_MARK_VAR's entry in place of RUN_MARK_VAR's. */
const SLEEPER_FIND_SCRIPT = MSYS_FIND_SCRIPT.replace(`"${RUN_MARK_VAR}=$1"`, `"${SLEEPER_MARK_VAR}=$1"`)
if (SLEEPER_FIND_SCRIPT === MSYS_FIND_SCRIPT) throw new Error(`MSYS_FIND_SCRIPT no longer matches "${RUN_MARK_VAR}=$1": tests/msysSleeper.ts looks for its own variable through it`)

/**
 * How many searches a try's ending makes for what carries its marker: each ends what it found, and the next looks again
 * (a forked sh exec'ing meanwhile is another Windows process, a process just ended can still be listed). One that finds
 * nothing ends it.
 */
const END_SEARCHES = 5

/** The winpids in `file`, as sleeperScript writes them. */
export const winpidsIn = (file: string): number[] => (existsSync(file) ? readFileSync(file, 'utf8').split(/\s+/).map(Number).filter((pid) => pid > 0) : [])

/**
 * The MSYS programs of Git's MSYS folder `bin` carrying `mark` in SLEEPER_MARK_VAR now, each by its winpid and start time
 * (msysMatches: the same winpid around the read of its environment, in a listing taken after the search, started before
 * it), or why they couldn't be looked for.
 */
export async function markedNow(mark: string, bin: string): Promise<ListedProcess[] | { error: string }> {
  const found = await findMsysMarked({ mark, bin }, (file, args, o) => boundedOutput(file, args.map((a) => (a === MSYS_FIND_SCRIPT ? SLEEPER_FIND_SCRIPT : a)), o))
  if ('error' in found) return { error: found.error }
  // The tests' own listing (written while processTree's listProcesses gave no answer on Windows, HI-3433).
  let list: ListedProcess[]
  try {
    list = processes().map((p) => ({ pid: p.pid, parent: p.parent, started: p.started }))
  } catch (e) {
    return { error: `the process listing failed: ${(e as Error).message}` }
  }
  return msysMatches(found.out, list) ?? { error: "the search's answer was malformed" }
}

/** A try's marker (SLEEPER_MARK_VAR's value) and files: the sleep's winpid, the shell's stderr. */
export type SleeperTry = { mark: string; file: string; errFile: string }

/**
 * How startSleeper waits for a try's shell to exit: `check` throws until it has. A test of the wait running out passes
 * one that throws on its own (given the try, to choose when).
 */
type ExitWait = (check: () => void, t: SleeperTry) => Promise<unknown>

/**
 * `env` for the sleeper's shell: `bin` first on its PATH (HI-3455), before env's own (whatever its spelling), and the try's
 * marker.
 */
export const sleeperEnv = (env: Record<string, string>, bin: string, mark: string): Record<string, string> =>
  withPathFirst({ ...env, [SLEEPER_MARK_VAR]: mark }, bin, envValue(env, 'PATH'))

/**
 * Starts sleeperScript with Git's own sh (`bin`, its MSYS folder, first on its PATH) and `env`, the shell's exit awaited:
 * replies with the sleep's winpid, the caller's to end from then on. A shell that exits without one throws with its exit
 * code and stderr. A shell that doesn't exit within the wait is ended, and everything carrying its marker (endTry), before
 * it throws with what that found and the stderr.
 */
export async function startSleeper(o: { bin: string; env: Record<string, string>; sleep?: string; waitExit?: ExitWait }): Promise<number> {
  const dir = tempDir('msys-sleeper-')
  const waitExit: ExitWait = o.waitExit ?? ((check) => waitUntil(check))
  const stderrOf = (errFile: string): string => readFileSync(errFile, 'utf8').trim().replace(/\r?\n/g, ' | ')
  const t: SleeperTry = { mark: randomBytes(16).toString('hex'), file: join(dir, 'winpid'), errFile: join(dir, 'stderr') }
  const fd = openSync(t.errFile, 'w')
  let ended: string | null = null
  let child: ReturnType<typeof spawn> | undefined
  try {
    child = spawn(join(o.bin, 'sh.exe'), ['-c', sleeperScript(t.file, o.sleep)], { stdio: ['ignore', 'ignore', fd], windowsHide: true, env: sleeperEnv(o.env, o.bin, t.mark) })
    child.on('error', (e) => void (ended = `didn't start: ${e.message}`))
    child.on('exit', (code, signal) => void (ended = `exited ${code ?? signal}`))
  } finally {
    closeSync(fd)
  }
  try {
    await waitExit(() => {
      if (ended === null) throw new Error("Git Bash's sh hasn't exited yet")
    }, t)
  } catch (e) {
    throw new Error(`${(e as Error).message}; ${await endTry(child, () => ended, t.mark, o.bin)}; stderr: ${stderrOf(t.errFile)}`, { cause: e })
  }
  const winpids = winpidsIn(t.file)
  if (winpids.length === 1) return winpids[0]
  throw new Error(`Git Bash's sleep didn't start: ${ended}, winpids ${JSON.stringify(winpids)}, stderr: ${stderrOf(t.errFile)}`)
}

/**
 * Ends a try whose shell didn't exit in time: the shell by its handle (its exit awaited), then whatever carries the try's
 * `mark`, by the identity each search gives it, until a search finds nothing (at most END_SEARCHES). Replies with what it
 * found, did and verified, for the error.
 */
async function endTry(child: ReturnType<typeof spawn> | undefined, ended: () => string | null, mark: string, bin: string): Promise<string> {
  const said: string[] = []
  if (child?.pid && ended() === null) {
    said.push(`the shell (pid ${child.pid}) was still running`)
    child.kill()
    await waitUntil(() => {
      if (ended() === null) throw new Error(`the shell (pid ${child.pid}) hasn't exited since it was ended`)
    })
    said.push(`ended (${ended()})`)
  } else said.push(`the shell ${ended() ?? "didn't start"}`)
  for (let n = 1; n <= END_SEARCHES; n++) {
    const found = await markedNow(mark, bin)
    if ('error' in found) return [...said, `what carries its marker couldn't be looked for: ${found.error}`].join(', ')
    if (!found.length) return [...said, n === 1 ? 'nothing carries its marker' : 'nothing carries its marker now'].join(', ')
    endExactly(found.map((p) => ({ pid: p.pid, started: p.started })))
    said.push(`ended what carried its marker: winpids ${found.map((p) => p.pid).join(' ')}`)
  }
  return [...said, `something still carried its marker after ${END_SEARCHES} searches`].join(', ')
}
