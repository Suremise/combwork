// The processes of the merge queue's runner (#1360): this process's identity, whether a holder process still runs,
// and ending exactly the processes a dead runner recorded, with what they started. A process is its pid and its start
// time, never its pid alone (Windows gives a pid again) nor its name; nothing else is ever ended.
//
// Node can't read a process's start time, so these ask PowerShell (hidden, once per question): only at a runner's start,
// a takeover and the checks Unused Worktrees makes, never per git command.

import { execFile } from 'child_process'
import { join } from 'path'

/** A process as listed: its id, its parent's id and when it started (Unix ms). */
export type Listed = { pid: number; parent: number; started: number }

export interface ProcessProbe {
  /** This process: its pid and start (Unix ms). */
  self(): Promise<{ pid: number; started: number }>
  /** Whether the process with this pid that started then still runs; null when that can't be told. */
  alive(pid: number, started: number): Promise<boolean | null>
  /** Every process now, or null when they can't be listed. */
  list(): Promise<Listed[] | null>
  /** Ends exactly these, each only while its pid still names the process started then; the pids it ended. */
  end(targets: Listed[]): Promise<number[]>
}

const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const LIST_PS = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }"
const startPs = (pid: number): string => `try { $p = [Diagnostics.Process]::GetProcessById(${pid}); ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } catch [ArgumentException] { 'gone' }`

/** PowerShell's output for a script, or null when it couldn't run or failed. */
function ps(script: string): Promise<string | null> {
  return new Promise((res) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => res(err ? null : String(out)))
  })
}

/** Every process, as `LIST_PS` prints them (a line each: pid, parent, started). */
export function parseList(out: string): Listed[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split(' ').map(Number))
    .filter((p) => p.length === 3 && p.every(Number.isFinite) && p[0] > 0)
    .map(([pid, parent, started]) => ({ pid, parent, started }))
}

/**
 * `root` and what it started, from `list`, children before their parents. A parent id is only a number: a process that
 * started before the one its parent id names isn't its child but an older orphan, and is left alone (as hive-progress's
 * treeToEnd, #655).
 */
export function treeOf(list: Listed[], root: Listed): Listed[] {
  const byParent = new Map<number, Listed[]>()
  for (const p of list) byParent.set(p.parent, [...(byParent.get(p.parent) ?? []), p])
  const found = [root]
  const walk = (parent: Listed): void => {
    for (const k of byParent.get(parent.pid) ?? []) {
      if (k.started < parent.started || found.some((x) => x.pid === k.pid)) continue
      found.push(k)
      walk(k)
    }
  }
  walk(root)
  return found.reverse()
}

/** The probe on Windows, through PowerShell. */
export const windowsProbe: ProcessProbe = {
  async self() {
    const out = await ps(startPs(process.pid))
    const started = Number(out?.trim())
    // Unreadable (PowerShell blocked): 0, an unknown start, which `alive` takes as running while the pid does, so a
    // takeover never takes a lease from a living process for want of its start time.
    return { pid: process.pid, started: Number.isFinite(started) && started > 0 ? started : 0 }
  },
  async alive(pid, started) {
    const out = (await ps(startPs(pid)))?.trim()
    if (out === 'gone') return false
    const at = Number(out)
    if (!out || !Number.isFinite(at)) return null
    return started === 0 || Math.abs(at - started) <= 1
  },
  async list() {
    const out = await ps(LIST_PS)
    return out === null ? null : parseList(out)
  },
  async end(targets) {
    if (!targets.length) return []
    const list = targets.map((t) => `${t.pid}:${t.started}`).join(',')
    const out = await ps(`foreach ($t in '${list}'.Split(',')) { $id, $at = $t.Split(':'); try { $p = [Diagnostics.Process]::GetProcessById([int]$id); $null = $p.Handle; if ([Math]::Abs(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() - [long]$at) -le 1) { $p.Kill(); $id } } catch {} }`)
    return (out ?? '').split(/\r?\n/).map(Number).filter((n) => n > 0)
  }
}

/** Elsewhere (Combwork is Windows-only; a fallback for completeness): a pid alone, nothing listed or ended. */
const otherProbe: ProcessProbe = {
  self: async () => ({ pid: process.pid, started: Math.round(Date.now() - process.uptime() * 1000) }),
  alive: async (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  list: async () => null,
  end: async () => []
}

export const defaultProbe = (): ProcessProbe => (process.platform === 'win32' ? windowsProbe : otherProbe)
