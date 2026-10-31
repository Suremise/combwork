// HI-2199, HI-2200: a Hive that ended without quitting leaves a WAL database's -shm, which another process can still have
// mapped. SQLite 3.53's first connection truncates it, which Windows refuses while it is mapped: every open fails with
// SQLITE_IOERR_TRUNCATE (1546) until it is let go. These make that state for a test, and let it go whatever happens.
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

// The longest a wait here waits for what it waits on: a bound for a hung run (tests/README.md).
const HUNG_MS = 10_000
let n = 0

/** Leaves `file` as a process that ended without closing it leaves it: written to, its -wal and -shm there. */
export async function leftByAKill(file: string): Promise<void> {
  const script = "const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(process.argv[1]); d.exec('PRAGMA journal_mode = WAL'); d.exec('PRAGMA wal_autocheckpoint = 0'); d.exec('CREATE TABLE IF NOT EXISTS left (x)'); d.exec('INSERT INTO left VALUES (1)'); console.log('written'); setInterval(() => {}, 1000)"
  const child = spawn(process.execPath, ['-e', script, file], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env: { SystemRoot: process.env.SystemRoot } })
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  let out = ''
  child.stdout!.on('data', (d) => (out += String(d)))
  try {
    await vi.waitFor(() => {
      if (child.exitCode !== null) throw new Error(`the writer exited (${child.exitCode}) before it wrote`)
      expect(out).toContain('written')
    }, { timeout: HUNG_MS, interval: 20 })
  } finally {
    // Ended from outside, its handle held (TerminateProcess): the file isn't closed.
    child.kill()
    await exited
  }
  expect(existsSync(`${file}-shm`)).toBe(true)
}

/**
 * Runs `body` while another process maps `shm` with no handle or lock on it (as a process being torn down, or a scanner,
 * can); `dir` is a folder of the test's own for the holder's script. `release()` lets it go. Whatever happens, readiness
 * failing included, the holder is released and waited for, and ended if it hasn't gone by HUNG_MS.
 */
export async function whileMapped(dir: string, shm: string, body: (release: () => void) => Promise<void>): Promise<void> {
  const own = join(dir, `holder-${process.pid}-${++n}`)
  mkdirSync(own, { recursive: true })
  const ps1 = join(own, 'map-shm.ps1')
  const releaseFile = join(own, 'release')
  writeFileSync(ps1, [
    'param([string]$File, [string]$Release)',
    "$fs = [System.IO.File]::Open($File, 'Open', 'ReadWrite', 'ReadWrite, Delete')",
    "$mm = [System.IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($fs, ('hive-test-' + [guid]::NewGuid()), 0, 'ReadWrite', 'None', $true)",
    '$view = $mm.CreateViewAccessor()',
    '$fs.Dispose()',
    "[Console]::Out.WriteLine('mapped')",
    'while (-not (Test-Path -LiteralPath $Release)) { Start-Sleep -Milliseconds 20 }',
    '$view.Dispose(); $mm.Dispose()'
  ].join('\r\n'))
  const release = (): void => writeFileSync(releaseFile, '')
  const ps: ChildProcess = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-File', shm, '-Release', releaseFile], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } })
  const exited = new Promise<void>((r) => (ps.exitCode !== null ? r() : ps.once('exit', () => r())))
  let out = ''
  ps.stdout!.on('data', (d) => (out += String(d)))
  try {
    await vi.waitFor(() => {
      if (ps.exitCode !== null) throw new Error(`the holder exited (${ps.exitCode}) before it mapped the file`)
      expect(out).toContain('mapped')
    }, { timeout: HUNG_MS, interval: 20 })
    await body(release)
  } finally {
    release()
    const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), HUNG_MS).unref())])
    if (!gone) {
      ps.kill()
      await exited
    }
  }
}

/** An open of `file` as SQLite 3.53 makes it while the -shm is mapped: its error code, or null when it opened. */
export function refusedNow(file: string): unknown {
  const d = new DatabaseSync(file, { readOnly: true })
  try {
    d.prepare('SELECT 1 FROM sqlite_master').get()
    return null
  } catch (e) {
    return (e as { errcode?: number }).errcode
  } finally {
    d.close()
  }
}
