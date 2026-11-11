// Ending a process and everything it started, by identity (#549, #655): moved here from cw-progress's wrapper (HI-2793)
// so jj's runner ends a jj command's tree as cw-progress ends its command's. Node built-ins only: cw-progress, which runs
// outside the asar, loads it as a chunk (AGENTS.md, cw-mcp.js and cw-progress.js).

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
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
 * endTree without blocking the caller's thread (HI-1185: Electron's main thread carries every keystroke): the same
 * listing, identity check and order, through PowerShell runs it awaits rather than spawnSync.
 */
export async function endTreeAsync(child: ChildProcess, platform = process.platform): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (platform === 'win32' && child.pid) {
    const tree = treeToEnd(parseProcessList(await powershell(LIST_PS)), child.pid)
    if (tree.length && pidsOf(await powershell(endListedPs(tree))).includes(child.pid)) return
  }
  try {
    child.kill()
  } catch {
    // already gone
  }
}

/**
 * Ends the command and everything it started (#549). On Windows a command that isn't an .exe runs through cmd.exe (npm,
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
