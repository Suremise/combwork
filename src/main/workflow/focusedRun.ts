// Each card's focused tests (G20, HI-1367): the project's picker run on a change, and a change read path by path. Used
// by the submission (in the card's folder, bracketed: the pick counts only for the exact submitted revision) and by the
// merge queue (in its own folder, at the test merge's result). The shared, pure part is shared/workflow/focused.ts.
//
// - The picker is the project's `focused.pick`, run as a check is (cmd's command line, hidden, its environment a check's
//   with Combwork's own variables taken out) with CW_FOCUSED_BASE, the change's paths on stdin, its stdout read as the
//   selection and its stderr kept apart as diagnostics, both bounded. At its time limit its whole tree is ended.
// - Its outcome is never "pass by default": a failure, a time-out or output Combwork can't read is `unknown`.

import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { open } from 'original-fs/promises'
import { lineHistory } from '../platform/historyPorts'
import { treeEnding } from '../processTree'
import { shellSpec } from '../progressReporters/wrapper'
import { bracketEnd, bracketStart, checkEnv, programFound, type Spawn } from './queueChecks'
import { FOCUSED_MAX_DIAGNOSTICS, FOCUSED_MAX_OUTPUT, changePaths, parsePick, type FocusedPickState, type FocusedPickWhy, type FocusedTest, type PathChange } from '../../shared/workflow/focused'
import { agentMsg, say } from '../../shared/agentText'

/** A pick's outcome: the selection, or why there is none, and the picker's diagnostics. */
/** What the picker's run says (HI-2463: Combwork's name). */
const FOCUSED_TEXT = {
  programMissing: agentMsg({ id: 'workflow.focused.programMissing', text: "Combwork couldn't find the program this command starts: {command}", note: "The focused-test picker's diagnostics: its command's program isn't found. command: the command as written." })
}

export interface PickOutcome {
  state: FocusedPickState
  tests: FocusedTest[]
  why?: FocusedPickWhy
  diagnostics?: string
}

/** How long a picker's output may stay open after it was ended at its time limit, before the pick ends anyway. */
const CLOSE_AFTER_KILL_MS = 10_000

/**
 * The change from `from` to `to`, path by path, exactly (HR4's s22): git's raw diff with full blob ids, both modes and
 * a rename's endpoints (git's own rename detection, the same on both sides). Null when it couldn't be read.
 */
export async function pathChanges(folder: string, from: string, to: string): Promise<PathChange[] | null> {
  const out = await lineHistory().rawDiff(folder, from, to)
  return out === null ? null : parseRaw(out)
}

/** `git diff --raw -z` output as changes; null when it isn't that. */
export function parseRaw(out: string): PathChange[] | null {
  const parts = out.split('\0')
  const changes: PathChange[] = []
  const none = (mode: string, blob: string): boolean => /^0+$/.test(mode) || /^0+$/.test(blob)
  for (let i = 0; i < parts.length; ) {
    const head = parts[i]
    if (!head) {
      i++
      continue
    }
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(head)
    if (!m) return null
    const [, oldMode, newMode, oldBlob, newBlob, letter] = m
    const two = letter === 'R' || letter === 'C'
    const a = parts[i + 1]
    const b = two ? parts[i + 2] : undefined
    if (a === undefined || (two && b === undefined)) return null
    i += two ? 3 : 2
    const gone = none(oldMode, oldBlob)
    const made = none(newMode, newBlob)
    changes.push({
      status: letter,
      oldPath: letter === 'A' ? null : a,
      newPath: letter === 'D' ? null : two ? b! : a,
      oldMode: gone ? null : oldMode,
      newMode: made ? null : newMode,
      oldBlob: gone ? null : oldBlob,
      newBlob: made ? null : newBlob
    })
  }
  return changes
}

export interface PickDeps {
  spawn?: Spawn
  platform?: NodeJS.Platform
  /** A session command's environment (the app's `childEnv()`); `checkEnv` takes out what a check never gets. */
  env: () => Record<string, string>
  timeoutMs: number
  /** Ends the pick early (a newer submission of its card, its workspace closing): its tree ended, `cancelled`. */
  signal?: AbortSignal
}

/**
 * Runs the project's picker in `folder` over `changes` from `base`: its selection, `tooBroad`, or `unknown` with why.
 * Never throws. Its stdin is the changes' paths (both sides of a rename), one a line.
 */
export function runPick(deps: PickDeps, command: string, folder: string, base: string, changes: PathChange[]): Promise<PickOutcome> {
  const platform = deps.platform ?? process.platform
  const spawn = deps.spawn ?? nodeSpawn
  return new Promise<PickOutcome>((resolve) => {
    let child: ChildProcess | undefined
    let out = ''
    let err = ''
    let over = false
    let timedOut = false
    let settled = false
    let after: NodeJS.Timeout | undefined
    // Its tree is ended off main's thread (HI-3009): the outcome, and a time-out's grace, wait for that teardown.
    const ending = treeEnding(platform)
    const diagnostics = (): Pick<PickOutcome, 'diagnostics'> => (err.trim() ? { diagnostics: err.trim().slice(-FOCUSED_MAX_DIAGNOSTICS) } : {})
    const done = (o: PickOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(after)
      deps.signal?.removeEventListener('abort', cancel)
      ending.after(() => resolve(o))
    }
    const timer = setTimeout(() => {
      timedOut = true
      ending.end(child)
      ending.after(() => {
        if (settled) return
        after = setTimeout(() => done({ state: 'unknown', tests: [], why: 'timedOut', ...diagnostics() }), CLOSE_AFTER_KILL_MS) // i18n-ignore: codes (a why, a check name), never shown as text
        after.unref?.()
      })
    }, deps.timeoutMs)
    timer.unref?.()
    const cancel = (): void => {
      ending.end(child)
      done({ state: 'unknown', tests: [], why: 'cancelled', ...diagnostics() }) // i18n-ignore: codes (a why), never shown as text
    }
    if (deps.signal?.aborted) return cancel()
    deps.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const env = { ...checkEnv(deps.env()), CW_FOCUSED_BASE: base }
      if (!programFound(command, env, folder, platform)) return done({ state: 'unknown', tests: [], why: 'failed', diagnostics: say(FOCUSED_TEXT.programMissing, { command }) }) // i18n-ignore: the picker's state (a code) and its diagnostics, agent text
      const sh = shellSpec(command, env, platform)
      child = spawn(sh.file, sh.args, { cwd: folder, env, windowsHide: true, windowsVerbatimArguments: sh.verbatim, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return done({ state: 'unknown', tests: [], why: 'failed', diagnostics: e instanceof Error ? e.message : String(e) }) // i18n-ignore: codes (a why, a check name), never shown as text
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => {
      if (over) return
      out += c
      if (out.length > FOCUSED_MAX_OUTPUT) {
        // More than a selection can be: ended, and not read.
        over = true
        ending.end(child)
      }
    })
    child.stderr?.on('data', (c: string) => {
      if (err.length < FOCUSED_MAX_DIAGNOSTICS * 2) err += c
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(`${changePaths(changes).join('\n')}\n`)
    child.on('error', (e) => {
      err += `${e.message}\n`
      done({ state: 'unknown', tests: [], why: 'failed', ...diagnostics() }) // i18n-ignore: codes (a why, a check name), never shown as text
    })
    child.on('close', (code) => {
      if (timedOut) return done({ state: 'unknown', tests: [], why: 'timedOut', ...diagnostics() }) // i18n-ignore: codes (a why, a check name), never shown as text
      if (over) return done({ state: 'unknown', tests: [], why: 'tooMany', ...diagnostics() }) // i18n-ignore: codes (a why, a check name), never shown as text
      if (code !== 0) return done({ state: 'unknown', tests: [], why: 'failed', ...diagnostics() }) // i18n-ignore: codes (a why, a check name), never shown as text
      const p = parsePick(out)
      done(p.state === 'chosen' ? { state: 'chosen', tests: p.tests, ...diagnostics() } : p.state === 'tooBroad' ? { state: 'tooBroad', tests: [], ...diagnostics() } : { state: 'unknown', tests: [], why: p.why, ...diagnostics() })
    })
  })
}

/**
 * A submission's pick (G20, HI-1367; HR4's s24): in the card's own folder, under a check's bracket (§16.13), so it counts
 * only for exactly the submitted revision: the folder at `revision` and clean at its start and end, no tracked file
 * written and no HEAD reflog entry made in between. Anything else is `unknown` (moved, dirty, changed), never recorded as
 * chosen. A check copy would need its dependencies installed first: Combwork's own picker reads them (vitest).
 */
export async function pickAtRevision(deps: PickDeps, command: string, folder: string, revision: string, base: string, changes: PathChange[]): Promise<PickOutcome> {
  const start = await bracketStart(folder)
  if (start.head !== revision) return { state: 'unknown', tests: [], why: 'moved' } // i18n-ignore: codes (a why, a check name), never shown as text
  const picked = await runPick(deps, command, folder, base, changes)
  if (deps.signal?.aborted) return { state: 'unknown', tests: [], why: 'cancelled' } // i18n-ignore: codes (a why), never shown as text
  const end = await bracketEnd(folder, revision, start)
  if (!end.counted) return { state: 'unknown', tests: [], why: end.whyNot === 'dirty' ? 'dirty' : end.whyNot === 'changed' ? 'changed' : 'moved', ...(picked.diagnostics ? { diagnostics: picked.diagnostics } : {}) } // i18n-ignore: codes (a why, a check name), never shown as text
  return picked
}

/**
 * A file another process wrote, read only up to `max` bytes (G20's results, HI-1367: a runner's output is never read
 * whole into Combwork's main process): its text; null when it isn't there; false when it holds more than `max`, also when
 * it grows past it while read.
 */
export async function boundedRead(file: string, max: number): Promise<string | null | false> {
  let h: Awaited<ReturnType<typeof open>> | null = null
  try {
    h = await open(file, 'r')
  } catch {
    return null
  }
  try {
    if ((await h.stat()).size > max) return false
    const buf = Buffer.alloc(max + 1)
    let n = 0
    while (n < buf.length) {
      const { bytesRead } = await h.read(buf, n, buf.length - n, n)
      if (!bytesRead) break
      n += bytesRead
    }
    return n > max ? false : buf.subarray(0, n).toString('utf8')
  } catch {
    return null
  } finally {
    await h.close().catch(() => undefined)
  }
}
