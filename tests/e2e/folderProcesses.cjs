// What still runs of a test once its Hive has closed (#542): a command an agent started (Codex through the profile's
// hive-progress shim, a shell command Claude Code ran in the folder) can outlive its session and hold the folder. Only
// what is the test's own, never by name: what its Hive started (its process tree, taken before it closes, each by pid
// and start time, so a reused pid is never taken), and what names its folder on the command line (a path boundary, so
// `scenario` never takes `scenario-2`'s) and started after the test did.
const fs = require('fs')
const path = require('path')
const { execFile, execFileSync } = require('child_process')
const { baseEnv } = require('./runContext.cjs')

/** A folder or command line in one spelling: lower case, backslashes, no trailing separator. */
const norm = (s) => String(s).replace(/\//g, '\\').toLowerCase()

/** Does `commandLine` name `folder` itself or something inside it (not a folder whose name only starts the same)? */
function namesFolder(commandLine, folder) {
  const cmd = norm(commandLine)
  const dir = norm(path.resolve(folder)).replace(/\\+$/, '')
  for (let i = cmd.indexOf(dir); i >= 0; i = cmd.indexOf(dir, i + 1)) {
    const next = cmd[i + dir.length]
    if (next === undefined || next === '\\' || next === '"' || next === "'" || /\s/.test(next)) return true
  }
  return false
}

/**
 * Whether a process in `list` names the file `name` (no folder) on its command line as a whole name, not the end of a
 * longer one: `bg-done-x.txt` is never `other-bg-done-x.txt`. With a name of the run's own, another suite's never counts.
 */
function namesFile(list, name) {
  const want = String(name).toLowerCase()
  return list.some((p) => {
    const cmd = String(p.commandLine ?? '').toLowerCase()
    for (let i = cmd.indexOf(want); i >= 0; i = cmd.indexOf(want, i + 1)) {
      const before = cmd[i - 1]
      const after = cmd[i + want.length]
      if ((before === undefined || /[\s"'\\/=:]/.test(before)) && (after === undefined || /[\s"';|]/.test(after))) return true
    }
    return false
  })
}

/**
 * The processes `list` ({ pid, commandLine, started (ms) }) that are the test's own: they name `folder` and started at
 * or after `since` (ms; 0 for any). Never `self`.
 */
const ownedBy = (list, folder, since = 0, self = process.pid) =>
  list.filter((p) => p.pid > 0 && p.pid !== self && p.commandLine && namesFolder(p.commandLine, folder) && !(since && p.started < since)).map((p) => p.pid)

/**
 * Every process: { pid, parent, started, commandLine } (empty when Windows doesn't show it). A line each, the command line in base64:
 * PowerShell 5.1's ConvertTo-Json leaves some control characters in a command line unescaped (a prompt's, say).
 */
function processes() {
  return parseProcesses(execFileSync('powershell.exe', ['-NoProfile', '-Command', PROCESS_LIST], { encoding: 'utf8', env: baseEnv(), maxBuffer: 64 * 1024 * 1024 }))
}
const PROCESS_LIST = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)) }"
/** PROCESS_LIST's output, as processes() returns it. */
function parseProcesses(out) {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split(' '))
    .filter((p) => p.length >= 3 && Number(p[0]) > 0)
    .map(([pid, parent, started, cmd = '']) => ({ pid: Number(pid), parent: Number(parent), started: Number(started), commandLine: Buffer.from(cmd, 'base64').toString('utf8') }))
}

/** `root`'s descendants in `list` (not `root` itself), each { pid, started }; a child started before its parent is a reused pid's, not a child. */
function descendantsIn(list, root) {
  const byParent = new Map()
  for (const p of list) byParent.set(p.parent, [...(byParent.get(p.parent) ?? []), p])
  const rootStarted = list.find((p) => p.pid === root)?.started ?? 0
  const out = []
  const walk = (pid, started) => {
    for (const k of byParent.get(pid) ?? []) {
      if (k.pid === pid || k.started < started || out.some((x) => x.pid === k.pid)) continue
      out.push({ pid: k.pid, started: k.started })
      walk(k.pid, k.started)
    }
  }
  walk(root, rootStarted)
  return out
}

/** The process tree under `pid` (a test Hive's main process), to stop what of it is left once it closed. [] off Windows. */
function processTree(pid) {
  if (process.platform !== 'win32' || !pid) return []
  try {
    return descendantsIn(processes(), pid)
  } catch {
    return []
  }
}

/** Of `tree` (processTree's), those still running as the same process (pid and start time): in `list`. */
const stillRunning = (list, tree) => tree.filter((t) => list.some((p) => p.pid === t.pid && p.started === t.started)).map((t) => t.pid)

/**
 * Ends each of `targets` ({ pid, started }) only while that pid is still the same process: a handle to it is opened, its
 * start time checked against `started`, and it is ended through that same handle. So a pid Windows has given another
 * process since the list was read (one that ended with its parent, say) is never what is ended (#547). Returns how many
 * were ended.
 */
function endExactly(targets) {
  if (process.platform !== 'win32' || !targets.length) return 0
  const list = targets.map((t) => `${Number(t.pid)}:${Number(t.started)}`).join(',')
  const ps = `$ended = 0; foreach ($t in '${list}'.Split(',')) { $id, $at = $t.Split(':'); try { $p = [Diagnostics.Process]::GetProcessById([int]$id); $null = $p.Handle; if ([Math]::Abs(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() - [long]$at) -le 1) { $p.Kill(); $ended++ } } catch {} }; $ended`
  try {
    return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: baseEnv() }).trim()) || 0
  } catch {
    return 0
  }
}

/**
 * Suspends (or, `resume`, resumes) each of `targets` ({ pid, started }) only while that pid is still the same process, as
 * endExactly ends them (#600: a busy CLI in wakepaste-codex/-copilot): a handle to it is opened, its start time checked
 * against `started`, and it is suspended or resumed through that same handle. Returns { done: the targets it was done to,
 * failed: [{ pid, why }] } (why: `gone`, `another process` when the pid names another one by now, or the call's NTSTATUS),
 * so a caller can tell a suspension that didn't happen, and resumes exactly what it suspended. Off Windows: none done.
 */
function suspendExactly(targets, resume = false) {
  const out = { done: [], failed: [] }
  if (process.platform !== 'win32' || !targets.length) return out
  const fn = resume ? 'NtResumeProcess' : 'NtSuspendProcess'
  const list = targets.map((t) => `${Number(t.pid)}:${Number(t.started)}`).join(',')
  const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class HiveSuspend{[DllImport("ntdll.dll")]public static extern int ${fn}(IntPtr h);}'; foreach ($t in '${list}'.Split(',')) { $id, $at = $t.Split(':'); try { $p = [Diagnostics.Process]::GetProcessById([int]$id); $h = $p.Handle; if ([Math]::Abs(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() - [long]$at) -le 1) { $s = [HiveSuspend]::${fn}($h); if ($s -eq 0) { "ok $id" } else { "fail $id 0x{0:X8}" -f $s } } else { "fail $id another-process" } } catch { "fail $id gone" } }`
  let text = ''
  try {
    text = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: baseEnv(), windowsHide: true })
  } catch (e) {
    for (const t of targets) out.failed.push({ pid: t.pid, why: `powershell: ${e.message}` })
    return out
  }
  for (const t of targets) {
    const line = text.split(/\r?\n/).find((l) => l.split(' ')[1] === String(t.pid)) ?? `fail ${t.pid} no-answer`
    if (line.startsWith('ok ')) out.done.push(t)
    else out.failed.push({ pid: t.pid, why: line.split(' ').slice(2).join(' ').replace('another-process', 'another process') })
  }
  return out
}

/**
 * The processes a test has suspended and not resumed yet (#600), the one list every resume goes by, each by the identity
 * it was suspended as: `suspend(targets)` adds those suspended; `resume()` resumes them, and those resumed or gone
 * meanwhile (their identity names no process now) leave the list while those that failed stay, so nothing suspended is
 * forgotten; `release()` (cleanup) resumes what is left and ends, by its identity, what still can't be resumed, so no
 * process of the test stays suspended. `act` and `end` are suspendExactly and endExactly (a unit test passes stubs).
 */
function suspensions(act = suspendExactly, end = endExactly) {
  let held = []
  const resume = () => {
    if (!held.length) return []
    const r = act(held, true)
    const settled = (t) => r.done.some((d) => d.pid === t.pid) || r.failed.some((f) => f.pid === t.pid && (f.why === 'gone' || f.why === 'another process'))
    held = held.filter((t) => !settled(t))
    return r.failed
  }
  return {
    held: () => [...held],
    suspend(targets) {
      const r = act(targets)
      held.push(...r.done)
      return r
    },
    resume,
    release() {
      const failed = resume()
      const ended = held
      if (held.length) end(held)
      held = []
      return { failed, ended }
    }
  }
}

/**
 * `targets` ({ pid, started }) ordered so each comes before its parent when its parent is one of them (by `list`'s
 * parent links, a parent started after its child being a reused pid's): children are ended first. Ending a parent first
 * can take its children with it before they are reached: Node starts each child in a job that ends with its parent
 * (libuv's kill-on-close job), and the GitHub runner ends them before the next is reached (#615).
 */
function childrenFirst(list, targets) {
  const byPid = new Map(list.map((p) => [p.pid, p]))
  const picked = new Map(targets.map((t) => [t.pid, t]))
  // How many of its ancestors are among `targets`.
  const depth = (t) => {
    const seen = new Set([t.pid])
    let p = byPid.get(t.pid)
    while (p) {
      const up = picked.get(p.parent)
      if (!up || seen.has(up.pid) || up.started > p.started) break
      seen.add(up.pid)
      p = byPid.get(up.pid)
    }
    return seen.size - 1
  }
  return targets.map((t, i) => ({ t, i, d: depth(t) })).sort((a, b) => b.d - a.d || a.i - b.i).map((x) => x.t)
}

/**
 * Stops the processes that are the test's own (above), each with its children: those naming `folder` that started at
 * or after `since`, and those of `tree` (processTree's, taken before its Hive closed) still running. Each is ended as
 * the process it was when listed (endExactly), never by a pid alone, and children before their parents (childrenFirst);
 * what one started meanwhile is found by the next look (a few at most). Returns how many were ended.
 */
function stopProcessesIn(folder, since = 0, tree = []) {
  if (process.platform !== 'win32') return 0
  let ended = 0
  for (let look = 0; look < 3; look++) {
    let list
    try {
      list = processes()
    } catch {
      return ended
    }
    const pick = new Map()
    const add = (p) => p && p.pid !== process.pid && pick.set(p.pid, p.started)
    for (const pid of [...ownedBy(list, folder, since), ...stillRunning(list, tree)]) {
      add(list.find((p) => p.pid === pid))
      for (const d of descendantsIn(list, pid)) add(d)
    }
    if (!pick.size) break
    const now = endExactly(childrenFirst(list, [...pick].map(([pid, started]) => ({ pid, started }))))
    ended += now
    if (!now) break
  }
  return ended
}

/**
 * The identities ({ pid, started }) of the processes `pids` names now: taken while they are known to be the test's own
 * (just after they reported their pid), so a later check or ending (stillSame, endExactly) never takes a process that
 * got one of those pids since (#603: a remembered pid killed after its process ended could be a Vitest worker's, which
 * then exits with code 1). [] off Windows.
 */
function identify(pids) {
  if (process.platform !== 'win32' || !pids.length) return []
  const list = processes()
  return pids.map((pid) => list.find((p) => p.pid === pid)).filter(Boolean).map((p) => ({ pid: p.pid, started: p.started }))
}

/** Which of `ids` (identify's) still run as the same processes: their pids. */
const stillSame = (ids) => (process.platform !== 'win32' || !ids.length ? [] : stillRunning(processes(), ids))

/**
 * Ends `root` and what it started (each started after its parent: a child whose parent id was reused isn't one), each
 * through a handle checked against its start time, children first. `root` is an identity ({ pid, started }) taken while
 * the process was known to be the test's own (identify): only while that pid still names that process is anything
 * ended, so a root that has gone, or whose pid names another process by now, ends nothing (#603: never take a process
 * from a pid at ending time, nor `taskkill /T`, which follows parent ids that may be stale). `list`: the processes now
 * (processes()). Returns how many were ended.
 */
function endTreeExactly(root, list) {
  if (process.platform !== 'win32' || !root?.pid || !root.started) return 0
  list ??= processes()
  const now = list.find((p) => p.pid === root.pid)
  if (!now || Math.abs(now.started - root.started) > 1) return 0
  return endExactly(childrenFirst(list, [{ pid: now.pid, started: now.started }, ...descendantsIn(list, now.pid)]))
}

/**
 * Ends a ChildProcess the test started and still holds, with what it started. While it hasn't exited, Node holds its
 * handle, so its pid can't name another process: its identity is read now. Once it has exited, nothing is ended.
 */
function endChildTree(child) {
  if (process.platform !== 'win32' || !child?.pid || child.exitCode !== null || child.signalCode !== null) return 0
  const list = processes()
  const now = list.find((p) => p.pid === child.pid)
  return now ? endTreeExactly({ pid: now.pid, started: now.started }, list) : 0
}

// --- Test copies of Hive that outlive their suite (HI-1453: one ran 12 h after its run, its parent gone).

/** Where a suite's test copies of Hive are recorded as they start: a line each in its work folder (lib.cjs). */
const COPIES_FILE = '.hive-copies.jsonl'
/** How far a copy's start may be from the window it was launched in (ms): Windows' and Node's clocks round apart. */
const COPY_SLACK_MS = 1000

/** Records a copy started in `dir`: { pid, from, to } (ms: its launch began and returned), and its profile. */
function recordCopy(dir, copy) {
  fs.appendFileSync(path.join(dir, COPIES_FILE), `${JSON.stringify(copy)}\n`)
}

/**
 * Records the copy of Hive that `launcher` (the pid Playwright started, `from`: ms before it did) is: its child that
 * started since, when Playwright started Electron through `cmd.exe /c` (Windows), else `launcher` itself. Lists the
 * processes without blocking (the launch has returned meanwhile). Off Windows, nothing.
 */
async function recordMainProcess(dir, launcher, from, profile = null) {
  if (process.platform !== 'win32' || !launcher) return
  const out = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-Command', PROCESS_LIST], { encoding: 'utf8', env: baseEnv(), maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (e, stdout) => (e ? reject(e) : resolve(stdout))))
  const list = parseProcesses(out)
  const main = list.find((p) => p.parent === launcher && p.started >= from - COPY_SLACK_MS) ?? list.find((p) => p.pid === launcher && p.started >= from - COPY_SLACK_MS)
  if (main) recordCopy(dir, { pid: main.pid, from, to: Date.now(), profile })
}

/** The copies recorded in `dir` and its folders `depth` deep (a runner inside a suite has its suites in nested/). */
function recordedCopies(dir, depth = 3) {
  const out = []
  const walk = (d, left) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isFile() && e.name === COPIES_FILE) {
        let text = ''
        try {
          text = fs.readFileSync(path.join(d, e.name), 'utf8')
        } catch {
          continue
        }
        for (const line of text.split(/\r?\n/)) {
          try {
            const c = JSON.parse(line)
            if (Number(c.pid) > 0 && Number.isFinite(c.from) && Number.isFinite(c.to)) out.push(c)
          } catch {
            // A line cut short (its writer killed): no copy.
          }
        }
      } else if (e.isDirectory() && left > 0 && !e.isSymbolicLink()) walk(path.join(d, e.name), left - 1)
    }
  }
  walk(dir, depth)
  return out
}

/** Of `list` (processes()), the processes the recorded `copies` are: their pid, started within their launch's window. */
const copiesIn = (list, copies) =>
  list.filter((p) => copies.some((c) => c.pid === p.pid && p.started >= c.from - COPY_SLACK_MS && p.started <= c.to + COPY_SLACK_MS))

/**
 * Whether `commandLine` is a test copy of Hive's with its profile in `folder`: Hive's own main process names it
 * (--hive-test-profile, lib.cjs), Chromium's processes their user data (--user-data-dir). Never by a program's name:
 * the installed Hive is Hive.exe too, and electron.exe runs other apps.
 */
const hiveCopyIn = (commandLine, folder) => /--(hive-test-profile|user-data-dir)=/i.test(String(commandLine ?? '')) && namesFolder(commandLine, folder)

/**
 * Ends the test copies of Hive in `folders` that are still running, each with what it started: those recorded there
 * (recordCopy, by pid and start) and those whose profile is there (hiveCopyIn). `before` (ms): only copies started
 * before it (a sweep's, so a copy a runner that has just claimed the folder starts is never taken). Each is ended as the
 * process it is in `list` (endExactly), children first. Returns how many processes were ended.
 */
function endCopies(folders, { before = Infinity, list } = {}) {
  if (process.platform !== 'win32' || !folders.length) return 0
  try {
    list ??= processes()
  } catch {
    return 0
  }
  const roots = new Map()
  for (const f of folders) {
    for (const p of copiesIn(list, recordedCopies(f))) roots.set(p.pid, p)
    for (const p of list) if (hiveCopyIn(p.commandLine, f)) roots.set(p.pid, p)
  }
  const pick = new Map()
  for (const p of roots.values()) {
    if (p.pid === process.pid || p.started >= before) continue
    pick.set(p.pid, p.started)
    for (const d of descendantsIn(list, p.pid)) pick.set(d.pid, d.started)
  }
  return pick.size ? endExactly(childrenFirst(list, [...pick].map(([pid, started]) => ({ pid, started })))) : 0
}

module.exports = { namesFolder, namesFile, ownedBy, descendantsIn, stillRunning, processTree, processes, endExactly, suspendExactly, suspensions, childrenFirst, stopProcessesIn, identify, stillSame, endTreeExactly, endChildTree, COPIES_FILE, recordCopy, recordMainProcess, recordedCopies, copiesIn, hiveCopyIn, endCopies }
