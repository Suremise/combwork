// Ending a process and everything it started, by identity (#549, #655): moved here from cw-progress's wrapper (HI-2793)
// so jj's runner ends a jj command's tree as cw-progress ends its command's. Node built-ins only: cw-progress, which runs
// outside the asar, loads it as a chunk (AGENTS.md, cw-mcp.js and cw-progress.js).

import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

/** A process as Windows lists it: its id, the id its parent had, and when it started (Unix ms). */
export type ListedProcess = { pid: number; parent: number; started: number }

const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const LIST_PS = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }"

/** HI-3376: how long each of endTree's blocking PowerShell runs (its listing, its end) may take: cw-progress's own process only. */
export const END_TREE_SYNC_MS = 30_000

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
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', endListedPs(targets)], { windowsHide: true, encoding: 'utf8', timeout: END_TREE_SYNC_MS })
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
function powershell(command: string, timeoutMs: number): Promise<string> {
  return powershellRun(command, timeoutMs).then((r) => r.out)
}

/** A PowerShell command's output, and whether it exited by itself with 0 (not ended at its bound, nor failed to run). */
function powershellRun(command: string, timeoutMs: number): Promise<{ out: string; ok: boolean }> {
  return new Promise((res) => {
    let c: ChildProcess
    try {
      c = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return res({ out: '', ok: false })
    }
    const out: Buffer[] = []
    let ended = false
    const t = setTimeout(() => {
      ended = true
      try {
        c.kill()
      } catch {
        // gone
      }
    }, timeoutMs)
    c.stdout?.on('data', (d: Buffer) => out.push(d))
    c.once('error', () => {
      clearTimeout(t)
      res({ out: '', ok: false })
    })
    c.once('close', (code: number | null) => {
      clearTimeout(t)
      res({ out: Buffer.concat(out).toString('utf8'), ok: !ended && code === 0 })
    })
  })
}

/**
 * HI-3376 (HR1's round 1): every process, listed without blocking, or null unless the listing is known complete: its
 * PowerShell exited by itself with 0 within `timeoutMs`, every line it printed is a process's, and its last is `end`
 * (printed after the whole listing). A listing cut short (ended at its bound, or failing part way) is no answer, never a
 * list missing what it didn't get to.
 */
export async function listProcesses(timeoutMs = TREE_END_BOUNDS.listMs): Promise<ListedProcess[] | null> {
  const r = await powershellRun(`${LIST_PS}; 'end'`, timeoutMs)
  return completeProcessList(r.out, r.ok)
}

/** listProcesses' reading of a listing's output (`ok`: its PowerShell exited by itself with 0): the processes, or null. */
export function completeProcessList(out: string, ok: boolean): ListedProcess[] | null {
  if (!ok) return null
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.at(-1) !== 'end') return null
  const rows = lines.slice(0, -1)
  const list = parseProcessList(rows.join('\n'))
  return rows.length && list.length === rows.length ? list : null
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
export const MSYS_FIND_BOUNDS = { timeoutMs: 10_000, maxBuffer: 1024 * 1024 }

/**
 * The script findMsysMarked runs in that Git's sh.exe, the marker as `$1` (argv, never put into the script), then the
 * MSYS pids whose environment it must not read (HI-3065, below). Builtins only (for, read, [, echo, cd, if), no command
 * substitution, pipe, subshell or background job: it starts no process, so ending the shell at its bound leaves nothing
 * behind. First the time, before any read (`t`, `$EPOCHREALTIME`); then three passes over `/proc`: each MSYS pid's
 * winpid (`a`); the pids with an environment entry exactly `COMBWORK_RUN=$1`, compared whole, NUL-separated (`m`), each
 * pid named first (`x`); each pid's winpid again (`b`); then `end`. It prints ids and the time only.
 *
 * HI-3065: reading `/proc/<pid>/environ` of a native Windows process while it is still starting (another lane's `npx`,
 * run from Git Bash) ends the shell reading it outright (exit status 256, no trap run, nothing said), for as long as
 * that process takes to start. The `x` line before each read names the entry it died on.
 */
export const MSYS_FIND_SCRIPT = [
  'cd /proc || exit 3',
  'echo "t $EPOCHREALTIME"',
  'for d in [0-9]*; do read -r w < "$d/winpid" && echo "a $d $w"; done 2>/dev/null',
  `for d in [0-9]*; do k=; for s in "$@"; do [ "$s" = "$d" ] && k=1; done; if [ -z "$k" ]; then echo "x $d"; while IFS= read -r -d '' e; do if [ "$e" = "${RUN_MARK_VAR}=$1" ]; then read -r w < "$d/winpid" && echo "m $d $w"; break; fi; done < "$d/environ"; fi; done 2>/dev/null`,
  'for d in [0-9]*; do read -r w < "$d/winpid" && echo "b $d $w"; done 2>/dev/null',
  'echo end'
].join('\n')

/** HI-3065: how many times findMsysMarked's search is run, each time it dies reading an entry, that entry then skipped. */
export const MSYS_FIND_TRIES = 3

/** HI-3376: the longest endTreeAsync takes with an MSYS search (TREE_END_MS, and each of its tries at its bound). */
export const msysTreeEndMs = (): number => TREE_END_MS + MSYS_FIND_BOUNDS.timeoutMs * MSYS_FIND_TRIES

/**
 * The processes of `list` that MSYS_FIND_SCRIPT's output says carry the marker, or null when the output is malformed or
 * cut short (the search incomplete). A match counts only when its MSYS pid named the same winpid in the reads before and
 * after the environment's, and that winpid is in `list` (read after the search) with a start no later than the time
 * taken before any read (HR2's round 1): that process then ran, with that pid, from before the first read until the
 * listing, so it is the one each read named, the one whose environment carried the marker. A program that started during
 * the search, or a pid given to another process since, adds nothing; so does anything else.
 */
export function msysMatches(out: string, list: ListedProcess[]): ListedProcess[] | null {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const t = /^t (\d+)(?:\.(\d{1,6}))?$/.exec(lines[0] ?? '')
  if (!t || lines.at(-1) !== 'end') return null
  const bound = Number(t[1]) * 1000 + Math.floor(Number((t[2] ?? '0').padEnd(6, '0')) / 1000)
  const before = new Map<number, number>()
  const after = new Map<number, number>()
  const matched: [number, number][] = []
  for (const l of lines.slice(1, -1)) {
    // The entry about to be read (HI-3065): nothing found by itself.
    if (/^x \d+$/.test(l)) continue
    const m = /^([amb]) (\d+) (\d+)$/.exec(l)
    if (!m) return null
    const [pid, win] = [Number(m[2]), Number(m[3])]
    if (m[1] === 'a') before.set(pid, win)
    else if (m[1] === 'm') matched.push([pid, win])
    else after.set(pid, win)
  }
  const found: ListedProcess[] = []
  for (const [pid, win] of matched) {
    if (before.get(pid) !== win || after.get(pid) !== win) continue
    const p = list.find((x) => x.pid === win)
    if (p && p.started <= bound && !found.includes(p)) found.push(p)
  }
  return found
}

/**
 * `file` with `args`, its output once it exits, bounded: ended (it alone: findMsysMarked's starts nothing) past
 * `timeoutMs` or `maxBuffer`, and then an error. Hidden, no shell, the environment given. An error from its own exit
 * (`exited`, not ended here) has what it printed by then (`partial`).
 */
export function boundedOutput(file: string, args: string[], o: { timeoutMs: number; maxBuffer: number; env: NodeJS.ProcessEnv }): Promise<{ out: string } | { error: string; pid?: number; exited?: true; partial?: string }> {
  return new Promise((res) => {
    let c: ChildProcess | undefined
    try {
      c = execFile(file, args, { windowsHide: true, shell: false, env: o.env, timeout: o.timeoutMs, maxBuffer: o.maxBuffer, encoding: 'utf8' }, (err, stdout) => {
        if (!err) return res({ out: String(stdout) })
        const e = err as Error & { code?: unknown; killed?: boolean }
        const why = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'its output passed the cap' : e.killed ? 'it ran past its time limit' : typeof e.code === 'number' ? `it exited with ${e.code}` : `it couldn't run (${String(e.code ?? 'error')})` // i18n-ignore: for the log
        const exited = typeof e.code === 'number' && !e.killed
        res({ error: why, ...(c?.pid ? { pid: c.pid } : {}), ...(exited ? { exited: true as const, partial: String(stdout ?? '') } : {}) })
      })
    } catch (e) {
      res({ error: `it couldn't run (${(e as Error).message})` }) // i18n-ignore: for the log
    }
  })
}

/**
 * Asks that MSYS installation's sh.exe which of its programs carry the marker (MSYS_FIND_SCRIPT), bounded
 * (MSYS_FIND_BOUNDS). HI-3065: a shell that died reading an entry's environment (its output's last line `x <pid>`) is
 * run again with that entry skipped, up to MSYS_FIND_TRIES times: its environment unread, as an entry unreadable any
 * other way, and every other one searched. Died elsewhere, ended at its bound, or still dying: the error, as before.
 */
export async function findMsysMarked(m: MsysMark, run: typeof boundedOutput = boundedOutput): Promise<{ out: string } | { error: string }> {
  const env = { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: m.bin }
  const skip: string[] = []
  for (let t = 1; ; t++) {
    const r = await run(join(m.bin, 'sh.exe'), ['-c', MSYS_FIND_SCRIPT, 'sh', m.mark, ...skip], { ...MSYS_FIND_BOUNDS, env })
    if ('out' in r) return r
    const at = r.exited ? /^x (\d+)$/.exec(r.partial?.trim().split(/\r?\n/).at(-1) ?? '')?.[1] : undefined
    if (!at || skip.includes(at) || t >= MSYS_FIND_TRIES) return { error: r.error }
    skip.push(at)
  }
}

/**
 * The trees to end for `root` (treeToEnd, from `list`; null: none, its process gone) and for each of `extra` (MSYS
 * programs it started, each with what it started in turn), each process once, children before their parents.
 */
export function treesToEnd(list: ListedProcess[], root: number | null, extra: ListedProcess[]): ListedProcess[] {
  const out: ListedProcess[] = []
  for (const p of [...extra.flatMap((x) => treeToEnd(list, x.pid)), ...(root === null ? [] : treeToEnd(list, root))]) if (!out.some((x) => x.pid === p.pid)) out.push(p)
  return out
}

/** HI-3358: at most this many more ends after the first, for what the ended processes started after their listing. */
export const LATE_ROUNDS = 3

/**
 * How long each step of endTreeAsync may take before it is ended (HI-3376: a listing of every process takes seconds
 * itself on a busy 2-4 core machine, as queueProcs.ts's own does): its first listing (`listMs`); then, in its ending
 * session (HI-3358), the session's start with its first end (`firstEndMs`), each listing after an end (`listMs`), each
 * late end (`lateEndMs`), and the whole session (`sessionMs`). TREE_END_MS is the longest endTreeAsync takes without an
 * MSYS search, TREE_END_MSYS_MS with one: a caller that waits for a teardown (opencode's shutdown) waits at least that.
 */
export const TREE_END_BOUNDS = { listMs: 30_000, firstEndMs: 30_000, lateEndMs: 15_000, sessionMs: 90_000 }
export const TREE_END_MS = TREE_END_BOUNDS.listMs + TREE_END_BOUNDS.sessionMs

/** What a teardown tells its caller, for the log. */
export interface TeardownNotes {
  /** HI-3358: the teardown may have left some of the tree running (its ending session didn't finish, or the late rounds ran out), and why. */
  onLateLeft?: (why: string) => void
}

/**
 * HI-3358: the PowerShell session endTreeAsync ends a tree with. It reads requests a line each and answers each, ending
 * with `ok`: `end <pid>:<started>,…` ends each process only through a handle whose start time it checked, and keeps
 * that handle until the session ends (`held <pid>:<started>`, then `ended <pid>` once ended); `list` prints every
 * process as LIST_PS does. A process whose handle is held keeps its pid (Windows gives a pid to another process only
 * once every handle to its process is closed), so while the session runs, a listed parent id that names a held process
 * names that process.
 */
const END_SESSION_PS = [
  '$held = New-Object System.Collections.ArrayList',
  '$out = [Console]::Out',
  'while ($null -ne ($l = [Console]::In.ReadLine())) {',
  "  if ($l -eq 'list') { Get-CimInstance Win32_Process | ForEach-Object { $out.WriteLine(('{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())) } }",
  "  elseif ($l.StartsWith('end ')) { foreach ($t in $l.Substring(4).Split(',')) { $id, $at = $t.Split(':'); try { $p = [Diagnostics.Process]::GetProcessById([int]$id); $null = $p.Handle; if ([Math]::Abs(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() - [long]$at) -le 1) { $null = $held.Add($p); $out.WriteLine(\"held $t\"); $p.Kill(); $out.WriteLine(\"ended $id\") } } catch {} } }",
  "  $out.WriteLine('ok'); $out.Flush()",
  '}'
].join('\n')

/** A running END_SESSION_PS: each request's answer (its lines before `ok`), null once the session has gone. */
interface EndSession {
  /** `request`'s answer; past `timeoutMs` unanswered, the session is ended (`why` says so) and it is null. */
  ask(request: string, timeoutMs: number, what: string): Promise<string[] | null>
  /** Why the session ended before it was closed (a request or the session past its bound, or it exited), else null. */
  why(): string | null
  /** Ends the session (its stdin closed, so it exits), its handles released. */
  close(): void
}

/** Starts END_SESSION_PS, ended at `capMs` if it hasn't exited by then (whatever was asked of it then gets null). */
function endSession(capMs: number): EndSession {
  let c: ChildProcess | null = null
  try {
    c = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', END_SESSION_PS], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  } catch {
    // answered null below
  }
  const waiting: ((lines: string[] | null) => void)[] = []
  let lines: string[] = []
  let rest = ''
  let gone = !c
  let why: string | null = c ? null : "it couldn't start" // i18n-ignore: for the log
  let step: ReturnType<typeof setTimeout> | undefined
  const end = (reason: string): void => {
    if (!gone) why = reason
    gone = true
    clearTimeout(t)
    clearTimeout(step)
    for (const w of waiting.splice(0)) w(null)
  }
  const kill = (reason: string): void => {
    try {
      c?.kill()
    } catch {
      // gone
    }
    end(reason)
  }
  const t = setTimeout(() => kill(`it passed its ${Math.round(capMs / 1000)} s`), capMs) // i18n-ignore: for the log
  c?.stdout?.on('data', (d: Buffer) => {
    const parts = (rest + d.toString('utf8')).split(/\r?\n/)
    rest = parts.pop() ?? ''
    for (const l of parts.map((x) => x.trim())) {
      if (l !== 'ok') lines.push(l)
      else {
        clearTimeout(step)
        waiting.shift()?.(lines)
        lines = []
      }
    }
  })
  c?.stdin?.on('error', () => undefined)
  c?.once('error', () => end("it couldn't run")) // i18n-ignore: for the log
  c?.once('close', () => end('it exited')) // i18n-ignore: for the log
  return {
    ask: (request, timeoutMs, what) =>
      new Promise((res) => {
        if (gone || !c?.stdin?.writable) return res(null)
        waiting.push(res)
        step = setTimeout(() => kill(`${what} took over ${Math.round(timeoutMs / 1000)} s`), timeoutMs) // i18n-ignore: for the log
        c.stdin.write(`${request}\n`)
      }),
    why: () => why,
    close: () => {
      try {
        c?.stdin?.end()
      } catch {
        // gone
      }
    }
  }
}

/** The request that ends `targets` (END_SESSION_PS's `end`). */
const endRequest = (targets: ListedProcess[]): string => `end ${targets.map((t) => `${t.pid}:${t.started}`).join(',')}` // i18n-ignore: a request to PowerShell

/** Of `targets`, those an `end` answer says it holds (`held <pid>:<started>`). */
const heldOf = (answer: string[], targets: ListedProcess[]): ListedProcess[] => targets.filter((t) => answer.includes(`held ${t.pid}:${t.started}`))

/** The pids an `end` answer says it ended. */
const endedOf = (answer: string[]): number[] => answer.flatMap((l) => (/^ended (\d+)$/.test(l) ? [Number(l.slice(6))] : []))

/**
 * HI-3358: the processes of `list` (read while `held` were held: END_SESSION_PS) that a held process started, each with
 * what it started in turn (treeToEnd, read from the same listing), children before their parents, none of `tried`
 * again. A process counts only when its parent id names a held process and it started no earlier than that process:
 * that pid has named the held process from its start until now, so the parent id is it. One whose parent was never
 * held (it had exited before its end, or its pid named another process by then) is left: its parent id is only a
 * number, which may name a process started since.
 */
export function lateStarted(list: ListedProcess[], held: ListedProcess[], tried: ListedProcess[]): ListedProcess[] {
  const same = (a: ListedProcess, b: ListedProcess): boolean => a.pid === b.pid && a.started === b.started
  const late = list.filter((k) => !tried.some((d) => same(d, k)) && held.some((p) => p.pid === k.parent && k.started >= p.started))
  return treesToEnd(list, null, late).filter((p) => !tried.some((d) => same(d, p)))
}

/**
 * Ends `tree` in one END_SESSION_PS (each step and the whole session bounded: TREE_END_BOUNDS), then (HI-3358) lists
 * again and ends what the held processes started since (lateStarted), until a listing finds none or LATE_ROUNDS more
 * ends have run; what may be left is said (onLateLeft), with why the session ended when it did. Returns the pids the
 * first end ended.
 */
async function endFollowing(tree: ListedProcess[], notes: TeardownNotes): Promise<number[]> {
  const s = endSession(TREE_END_BOUNDS.sessionMs)
  const because = (): string => (s.why() ? ` (${s.why()})` : '')
  try {
    const first = await s.ask(endRequest(tree), TREE_END_BOUNDS.firstEndMs, 'its start and first end') // i18n-ignore: for the log
    if (!first) {
      notes.onLateLeft?.(`its ending session ended before it answered the end${because()}`) // i18n-ignore: for the log
      return []
    }
    const held = heldOf(first, tree)
    const tried = [...tree]
    for (let round = 1; ; round++) {
      const listed = await s.ask('list', TREE_END_BOUNDS.listMs, 'a listing') // i18n-ignore: for the log
      if (!listed) {
        notes.onLateLeft?.(`its ending session ended before a listing after the end${because()}`) // i18n-ignore: for the log
        break
      }
      const late = lateStarted(parseProcessList(listed.join('\n')), held, tried)
      if (!late.length) break
      if (round > LATE_ROUNDS) {
        notes.onLateLeft?.(`it was still starting processes after ${LATE_ROUNDS} more ends`) // i18n-ignore: for the log
        break
      }
      const answer = await s.ask(endRequest(late), TREE_END_BOUNDS.lateEndMs, 'a late end') // i18n-ignore: for the log
      if (!answer) {
        notes.onLateLeft?.(`its ending session ended during a late end${because()}`) // i18n-ignore: for the log
        break
      }
      held.push(...heldOf(answer, late))
      tried.push(...late)
    }
    return endedOf(first)
  } finally {
    s.close()
  }
}

/**
 * endTree without blocking the caller's thread (HI-1185: Electron's main thread carries every keystroke): the same
 * listing, identity check and order, through PowerShell runs it awaits rather than spawnSync. With `msys` (HI-3047), the
 * MSYS programs carrying its marker are found first and ended with the tree; a search that fails ends the tree alone, as
 * without it, and says why (onIncomplete).
 *
 * HI-3054: the root is ended only when `child` hasn't exited by the time the listing is read. Node holds its process's
 * handle until it reports the exit (exitCode or signalCode set, then the handle closed), so until then its pid can't be
 * another's and the listing's entry is that process; once it has exited during the search or the listing, its pid may
 * already name another process, so no tree is walked from that number. Its marked MSYS programs, found by their marker,
 * not their parent, are still ended with what they started; native programs it started, whose parent is then only a
 * number, are left, as when it exits before any teardown.
 *
 * HI-3358: the listing is one moment, and a process the tree starts after it, before the end, wasn't in it. The end
 * runs in a session that holds each process it ends, then lists again and ends what those started since (endFollowing,
 * by identity), so a command still starting processes as its bound fires leaves none of them running (notes.onLateLeft
 * says what may have been). Bounded: TREE_END_MS, plus the MSYS search's bounds with `msys`. The promise settles once
 * those rounds are over.
 */
export async function endTreeAsync(child: ChildProcess, platform = process.platform, msys?: MsysMark, notes: TeardownNotes = {}): Promise<void> {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
  if (exited()) return
  if (platform === 'win32' && child.pid) {
    // Searched before the listing: a match's process must still be the one listed (msysMatches).
    const found = msys ? await (msys.discover ?? findMsysMarked)(msys).catch((e: Error) => ({ error: `it couldn't run (${e.message})` })) : null // i18n-ignore: for the log
    const list = parseProcessList(await powershell(LIST_PS, TREE_END_BOUNDS.listMs))
    // Read after the listing, in the same turn as the walk (HI-3054): not exited yet, so the listing's entry is its own.
    const root = exited() ? null : child.pid
    let extra: ListedProcess[] = []
    if (msys && found) {
      const matches = 'out' in found ? msysMatches(found.out, list) : null
      if (matches) extra = matches
      else msys.onIncomplete?.('error' in found ? found.error : 'its answer was malformed') // i18n-ignore: for the log
    }
    const tree = treesToEnd(list, root, extra)
    const ended = tree.length ? await endFollowing(tree, notes) : []
    if (root === null || ended.includes(root)) return
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
export function treeEnding(platform = process.platform, msys?: MsysMark, notes: TeardownNotes = {}): TreeEnding {
  let teardown: Promise<void> | null = null
  return {
    end: (child) => {
      if (child && !teardown) teardown = endTreeAsync(child, platform, msys, notes).catch(() => undefined)
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
      const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', LIST_PS], { windowsHide: true, encoding: 'utf8', timeout: END_TREE_SYNC_MS, maxBuffer: 16 * 1024 * 1024 })
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
