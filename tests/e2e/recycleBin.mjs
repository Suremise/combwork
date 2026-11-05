// How many items the user's Recycle Bin holds, read only (#414): the e2e runner counts it before and after a run and
// says so in the summary and the run record, so a test copy of Combwork that sends something there is seen. Test copies
// put what they delete in their suite's trash folder (src/main/trash.ts); nothing here ever changes the Recycle Bin.
import { spawnSync } from 'child_process'
import runContext from './runContext.cjs'

/** The number of items in the Recycle Bin (every drive's), or null where it can't be read (not Windows, no shell). */
export function recycleBinCount() {
  if (process.platform !== 'win32') return null
  // Shell.Application's namespace 10 is the Recycle Bin; Items().Count only reads it.
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Shell.Application).NameSpace(10).Items().Count'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: runContext.baseEnv() })
  const n = Number.parseInt(String(r.stdout ?? '').trim(), 10)
  return r.status === 0 && Number.isFinite(n) ? n : null
}

/** The summary's line: the counts before and after, and what a change means. */
export function recycleBinLine(before, after) {
  if (before === null || after === null) return "Recycle Bin: couldn't be counted."
  if (before === after) return `Recycle Bin: ${before} item${before === 1 ? '' : 's'} before and after the run (unchanged: test copies use their own trash folders, #414).`
  const d = after - before
  return `Recycle Bin: ${before} item${before === 1 ? '' : 's'} before the run, ${after} after (${d > 0 ? '+' : ''}${d}). Test copies of Combwork never use it (#414): ${d > 0 ? 'something else put items there meanwhile (you, another program), or a test did: check the suites that delete things' : 'it was emptied or restored from meanwhile'}.`
}
