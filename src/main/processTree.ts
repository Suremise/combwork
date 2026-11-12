// Ending a process and everything it started, by identity (#549, #655): moved here from cw-progress's wrapper (HI-2793)
// so jj's runner ends a jj command's tree as cw-progress ends its command's. Node built-ins only: cw-progress, which runs
// outside the asar, loads it as a chunk (AGENTS.md, cw-mcp.js and cw-progress.js).

import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

/** A process as Windows lists it: its id, the id its parent had, and when it started (Unix ms). */
export type ListedProcess = { pid: number; parent: number; started: number }

const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const LIST_PS = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }"

/** Every process, as `LIST_PS` prints them (a line each: pid, parent, started). */
export function parseProcessList(out: string): ListedProcess[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split(' ').map(Number))
    .filter((p) => p.length === 3 && p.every(Number.isFinite) && p[0] > 0)
    .map(([pid, parent, started]) => ({ pid, parent, started }))
}

/**
 * `root` and what it started, from `list`, children before their parents (ended in that order, a parent can't start
 * another meanwhile). A parent id is only a number: one whose process ended may be another's by now, so a process that
 * started before the one its parent id names isn't its child but an older orphan, and is left alone with what it
 * started (#655). [] when `root` isn't in `list`.
 */
export function treeToEnd(list: ListedProcess[], root: number): ListedProcess[] {
  const top = list.find((p) => p.pid === root)
  if (!top) return []
  const byParent = new Map<number, ListedProcess[]>()
  for (const p of list) byParent.set(p.parent, [...(byParent.get(p.parent) ?? []), p])
  const found = [top]
  const walk = (parent: ListedProcess): void => {
    for (const k of byParent.get(parent.pid) ?? []) {
      if (k.started < parent.started || found.some((x) => x.pid === k.pid)) continue
      found.push(k)
      walk(k)
    }
  }
  walk(top)
  return found.reverse()
}

/**
 * Ends each of `targets` only while its pid still names the process listed (a handle opened, its start time checked,
 * ended through that handle), so a pid given to another process since the list was read is never ended. Returns the
 * pids it ended.
 */
function endListed(targets: ListedProcess[]): number[] {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', endListedPs(targets)], { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
  return pidsOf(String(r.stdout ?? ''))
}

/** The PowerShell that ends each listed process through a handle whose start time it checked (endListed's). */
function endListedPs(targets: ListedProcess[]): string {
  const list = targets.map((t) => `${t.pid}:${t.started}`).join(',')
  return `foreach ($t in '${list}'.Split(',')) { $id, $at = $t.Split(':'); try { $p = [Diagnostics.Process]::GetProcessById([int]$id); $null = $p.Handle; if ([Math]::Abs(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() - [long]$at) -le 1) { $p.Kill(); $id } } catch {} }`
}

/** The pids a PowerShell run printed, a line each. */
const pidsOf = (out: string): number[] => out.split(/\r?\n/).map(Number).filter((n) => n > 0)

/** A PowerShell command's output, run without blocking (bounded; '' when it couldn't run). */
function powershell(command: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((res) => {
    let c: ChildProcess
    try {
      c = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return res('')
    }
    const out: Buffer[] = []
    const t = setTimeout(() => {
      try {
        c.kill()
      } catch {
        // gone
      }
    }, timeoutMs)
    c.stdout?.on('data', (d: Buffer) => out.push(d))
    c.once('error', () => {
      clearTimeout(t)
      res('')
    })
    c.once('close', () => {
      clearTimeout(t)
      res(Buffer.concat(out).toString('utf8'))
    })
  })
}

/**
 * HI-3047: a command whose MSYS programs (Git Bash's own: its `sleep`, `cat`, `perl`) are ended with its tree. MSYS's
 * exec starts such a program from a forked sh.exe that then exits, so its Windows parent id names a process already gone
 * and no tree walk finds it. The command is started with `RUN_MARK_VAR=<mark>` in its environment, which everything it
 * starts inherits, and at its end that MSYS installation is asked which of its programs carry exactly that entry
 * (findMsysMarked). Not found: a program started with its environment cleared (`env -i`), and, as for native programs, one
 * whose parent had already exited and that has no marker.
 */
export interface MsysMark {
  /** The marker's value: fresh random hex per command. */
  mark: string
  /** That Git's MSYS folder (`<root>\usr\bin`: its sh.exe and msys-2.0.dll). */
  bin: string
  /** Told why its MSYS programs couldn't be looked for (only its process tree was ended then). Never environment contents. */
  onIncomplete?: (why: string) => void
  /** For tests: the discovery run in place of findMsysMarked's. */
  discover?: (m: MsysMark) => Promise<{ out: string } | { error: string }>
}

/** The variable that carries a command's MsysMark. */
export const RUN_MARK_VAR = 'COMBWORK_RUN'

/** How long findMsysMarked's shell may take, and how much it may print, before it is ended and the search given up. */
export const MSYS_FIND_BOUNDS = { timeoutMs: 3000, maxBuffer: 1024 * 1024 }

/**
 * The script findMsysMarked runs in that Git's sh.exe, the marker as `$1` (argv, never put into the script). Builtins
 * only (for, read, [, echo, cd), no command substitution, pipe, subshell or background job: it starts no process, so
 * ending the shell at its bound leaves nothing behind. Three passes over `/proc`: each MSYS pid's winpid (`a`); the pids
 * with an environment entry exactly `COMBWORK_RUN=$1`, compared whole, NUL-separated (`m`); each pid's winpid again, with
 * the time just before it was read (`b`, `$EPOCHREALTIME`); then `end`. It prints ids and times only.
 */
export const MSYS_FIND_SCRIPT = [
  'cd /proc || exit 3',
  'for d in [0-9]*; do read -r w < "$d/winpid" && echo "a $d $w"; done 2>/dev/null',
  `for d in [0-9]*; do while IFS= read -r -d '' e; do if [ "$e" = "${RUN_MARK_VAR}=$1" ]; then read -r w < "$d/winpid" && echo "m $d $w"; break; fi; done < "$d/environ"; done 2>/dev/null`,
  'for d in [0-9]*; do t=$EPOCHREALTIME; read -r w < "$d/winpid" && echo "b $d $w $t"; done 2>/dev/null',
  'echo end'
].join('\n')

/**
 * The processes of `list` that MSYS_FIND_SCRIPT's output says carry the marker, or null when the output is malformed or
 * cut short (the search incomplete). A match counts only when its MSYS pid named the same winpid in the reads before and
 * after the environment's (the program that carried the marker is the one with that winpid), and that winpid is in
 * `list` with a start no later than the time its second read began (so it was that process then, and the same one,
 * alive, when `list` was read after). Anything else adds nothing.
 */
export function msysMatches(out: string, list: ListedProcess[]): ListedProcess[] | null {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.at(-1) !== 'end') return null
  const before = new Map<number, number>()
  const after = new Map<number, { win: number; at: number }>()
  const matched: [number, number][] = []
  for (const l of lines.slice(0, -1)) {
    const m = /^(?:([am]) (\d+) (\d+)|b (\d+) (\d+) (\d+)(?:\.(\d{1,6}))?)$/.exec(l)
    if (!m) return null
    if (m[1] === 'a') before.set(Number(m[2]), Number(m[3]))
    else if (m[1] === 'm') matched.push([Number(m[2]), Number(m[3])])
    else after.set(Number(m[4]), { win: Number(m[5]), at: Number(m[6]) * 1000 + Math.floor(Number((m[7] ?? '0').padEnd(6, '0')) / 1000) })
  }
  const found: ListedProcess[] = []
  for (const [pid, win] of matched) {
    const b = after.get(pid)
    if (before.get(pid) !== win || b?.win !== win) continue
    const p = list.find((x) => x.pid === win)
    if (p && p.started <= b.at && !found.includes(p)) found.push(p)
  }
  return found
}

/**
 * `file` with `args`, its output once it exits, bounded: ended (it alone: findMsysMarked's starts nothing) past
 * `timeoutMs` or `maxBuffer`, and then an error. Hidden, no shell, the environment given.
 */
export function boundedOutput(file: string, args: string[], o: { timeoutMs: number; maxBuffer: number; env: NodeJS.ProcessEnv }): Promise<{ out: string } | { error: string; pid?: number }> {
  return new Promise((res) => {
    let c: ChildProcess | undefined
    try {
      c = execFile(file, args, { windowsHide: true, shell: false, env: o.env, timeout: o.timeoutMs, maxBuffer: o.maxBuffer, encoding: 'utf8' }, (err, stdout) => {
        if (!err) return res({ out: String(stdout) })
        const e = err as Error & { code?: unknown; killed?: boolean }
        const why = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'its output passed the cap' : e.killed ? 'it ran past its time limit' : typeof e.code === 'number' ? `it exited with ${e.code}` : `it couldn't run (${String(e.code ?? 'error')})`
        res({ error: why, ...(c?.pid ? { pid: c.pid } : {}) })
      })
    } catch (e) {
      res({ error: `it couldn't run (${(e as Error).message})` })
    }
  })
}

/** Asks that MSYS installation's sh.exe which of its programs carry the marker (MSYS_FIND_SCRIPT), bounded (MSYS_FIND_BOUNDS). */
export function findMsysMarked(m: MsysMark): Promise<{ out: string } | { error: string }> {
  const env = { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: m.bin }
  return boundedOutput(join(m.bin, 'sh.exe'), ['-c', MSYS_FIND_SCRIPT, 'sh', m.mark], { ...MSYS_FIND_BOUNDS, env })
}

/**
 * The trees to end for `root` (treeToEnd, from `list`) and for each of `extra` (MSYS programs it started, each with what it
 * started in turn), each process once, children before their parents.
 */
export function treesToEnd(list: ListedProcess[], root: number, extra: ListedProcess[]): ListedProcess[] {
  const out: ListedProcess[] = []
  for (const p of [...extra.flatMap((x) => treeToEnd(list, x.pid)), ...treeToEnd(list, root)]) if (!out.some((x) => x.pid === p.pid)) out.push(p)
  return out
}

/**
 * endTree without blocking the caller's thread (HI-1185: Electron's main thread carries every keystroke): the same
 * listing, identity check and order, through PowerShell runs it awaits rather than spawnSync. With `msys` (HI-3047), the
 * MSYS programs carrying its marker are found first and ended with the tree; a search that fails ends the tree alone, as
 * without it, and says why (onIncomplete).
 */
export async function endTreeAsync(child: ChildProcess, platform = process.platform, msys?: MsysMark): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (platform === 'win32' && child.pid) {
    // Searched before the listing: a match's process must still be the one listed (msysMatches).
    const found = msys ? await (msys.discover ?? findMsysMarked)(msys).catch((e: Error) => ({ error: `it couldn't run (${e.message})` })) : null
    const list = parseProcessList(await powershell(LIST_PS))
    let extra: ListedProcess[] = []
    if (msys && found) {
      const matches = 'out' in found ? msysMatches(found.out, list) : null
      if (matches) extra = matches
      else msys.onIncomplete?.('error' in found ? found.error : 'its answer was malformed')
    }
    const tree = treesToEnd(list, child.pid, extra)
    if (tree.length && pidsOf(await powershell(endListedPs(tree))).includes(child.pid)) return
  }
  try {
    child.kill()
  } catch {
    // already gone
  }
}

/** A command's tree ended at most once, off the thread (treeEnding's). */
export interface TreeEnding {
  /** Begins ending `child`'s tree (endTreeAsync); later calls, or none given, do nothing. */
  end(child: ChildProcess | undefined): void
  /** Runs `fn` once the teardown begun is over, or at once when none began: an outcome given after an end still comes after the tree has gone. */
  after(fn: () => void): void
  /** Settles once the teardown begun is over (at once when none began). */
  ended(): Promise<void>
}

/**
 * How a caller on main's thread ends a command's tree (HI-3009, after HI-2997's jj runner): endTreeAsync, never endTree's
 * spawnSync (about 2.4 s of the thread for PowerShell's listing and ending), and whatever waited on the tree having ended
 * (an outcome, a time-out's grace) waits on the teardown instead. Never rejects.
 */
export function treeEnding(platform = process.platform, msys?: MsysMark): TreeEnding {
  let teardown: Promise<void> | null = null
  return {
    end: (child) => {
      if (child && !teardown) teardown = endTreeAsync(child, platform, msys).catch(() => undefined)
    },
    after: (fn) => {
      if (teardown) void teardown.then(fn)
      else fn()
    },
    ended: () => teardown ?? Promise.resolve()
  }
}

/**
 * Ends the command and everything it started (#549). Blocks the thread it runs on (two spawnSync PowerShell runs): only for
 * cw-progress's own process; Combwork's main process uses treeEnding (HI-3009, tests/endTreeImports.test.ts). On Windows a command that isn't an .exe runs through cmd.exe (npm,
 * a .cmd server): ending cmd alone would leave the server running, holding its port, its folder and the output pipes,
 * so the whole tree goes: listed with start times (treeToEnd: never an older process whose parent id is only a reused
 * number, as `taskkill /T` would end, #655) and each ended as the process it was when listed. If that can't run, the
 * command itself is ended (its handle is held, so its pid is still its own).
 */
export function endTree(child: ChildProcess, platform = process.platform): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (platform === 'win32' && child.pid) {
    try {
      const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', LIST_PS], { windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
      const tree = treeToEnd(parseProcessList(String(r.stdout ?? '')), child.pid)
      if (tree.length && endListed(tree).includes(child.pid)) return
    } catch {
      // ended below
    }
  }
  try {
    child.kill()
  } catch {
    // already gone
  }
}
