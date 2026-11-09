// HI-2753 (design s18): git's own ref locks held while Combwork records something it proved about those refs. A
// `git update-ref --stdin` transaction verifies each ref at the commit it was checked at and `prepare`s, which takes git's
// own `<ref>.lock` files: while they are held, every git writer of those refs (an agent's commit, reset or update-ref
// included) fails with "cannot lock ref" instead of slipping past. Nothing is updated: the hold ends with `abort`, or with
// git's stdin closing (git aborts a transaction that never got `commit` and removes its locks itself, Combwork quitting
// included). Combwork never deletes a lock file: one git left behind (a git killed hard) or someone else's is a refusal
// that names it.

import { spawn, type ChildProcess } from 'child_process'
import { GIT_PREFIX } from '../git'
import { gitExe } from '../gitTool'
import { withLauncherEnv } from '../gitWorker'

// A ref and the commit it must be at, a hold and its refusal: the repository context port's (SPEC §16.3.6).
import type { HoldOptions, RefAt, RefHold, RefHoldRefused } from './repoContext'
export type { RefAt, RefHold, RefHoldRefused } from './repoContext'

/** Tests: told once the hold is prepared, before `holdRefs` answers (a seam between the prepare and the caller's write). */
export const refHoldTestHooks: { prepared?: (child: ChildProcess) => void | Promise<void> } = {}

/**
 * Prepares a transaction verifying `refs` in the repository at `repo` and holds its locks. Answers the hold once git says
 * `prepare: ok`; a refusal otherwise, its child ended (`closeMs` to exit, else killed). `prepareMs` bounds only the wait
 * for the prepare: once prepared, nothing but `close()` (or git dying) ends the hold, so no timer releases the locks
 * while the caller writes.
 */
export async function holdRefs(repo: string, refs: readonly RefAt[], o: HoldOptions): Promise<{ hold: RefHold } | { refused: RefHoldRefused }> {
  let child: ChildProcess
  try {
    const use = gitExe()
    child = spawn(use.exe, [...GIT_PREFIX, 'update-ref', '--stdin'], { cwd: repo, env: use.launcherEnv ? withLauncherEnv(process.env, use.launcherEnv) : process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    return { refused: { why: 'failed', detail: e instanceof Error ? e.message : String(e) } } // i18n-ignore: a reason's code, said in words where it is shown
  }
  let out = ''
  let err = ''
  let lost = false
  let exited = false
  const exit = new Promise<void>((done) => {
    child.once('exit', () => {
      exited = true
      lost = true
      done()
    })
    child.once('error', () => {
      lost = true
      if (!child.pid) {
        exited = true
        done()
      }
    })
  })
  child.stdin?.on('error', () => {
    lost = true
  })
  child.stderr?.on('data', (d: Buffer) => {
    err += d.toString('utf8')
  })
  const close = async (): Promise<void> => {
    if (!exited) {
      try {
        child.stdin?.write('abort\n')
        child.stdin?.end()
      } catch {
        // Its input already broken: git aborts on it.
      }
      let timer: NodeJS.Timeout | undefined
      await Promise.race([exit, new Promise<void>((r) => (timer = setTimeout(r, o.closeMs)))])
      clearTimeout(timer)
      if (!exited) {
        child.kill()
        await Promise.race([exit, new Promise<void>((r) => setTimeout(r, o.closeMs))])
      }
    }
  }
  const prepared = await new Promise<'ok' | 'timeout' | 'ended'>((done) => {
    const timer = setTimeout(() => done('timeout'), o.prepareMs)
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8')
      if (/^prepare: ok$/m.test(out)) {
        clearTimeout(timer)
        done('ok')
      }
    })
    void exit.then(() => {
      clearTimeout(timer)
      done('ended')
    })
    const lines = ['start', ...refs.map((r) => `verify ${r.ref} ${r.oid}`), 'prepare', ''] // i18n-ignore: a reason's code, said in words where it is shown
    try {
      child.stdin?.write(lines.join('\n'))
    } catch {
      // Its input broken at once: git ends, told as ended.
    }
  })
  if (prepared === 'ok' && !lost) {
    await refHoldTestHooks.prepared?.(child)
    return { hold: { lost: () => lost, close } }
  }
  await close()
  if (prepared === 'timeout') return { refused: { why: 'timeout', detail: `git update-ref didn't prepare within ${o.prepareMs} ms` } } // i18n-ignore: a reason's detail for the log and the result (English, as git's)
  return { refused: refusalOf(err.trim() || out.trim(), refs) }
}

/** What git's error says: a lock someone else holds (its file), a ref not at the commit verified, or a failure. */
export function refusalOf(text: string, refs: readonly RefAt[]): RefHoldRefused {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? text
  const lock = /Unable to create '([^']+\.lock)'/i.exec(text)?.[1]
  const named = refs.find((r) => text.includes(r.ref))?.ref
  if (lock) return { why: 'locked', lock, ...(named ? { ref: named } : {}), detail: line } // i18n-ignore: a reason's code, said in words where it is shown
  if (/but expected|is at .* but|unable to resolve reference|reference already exists|does not exist/i.test(text)) return { why: 'moved', ...(named ? { ref: named } : {}), detail: line } // i18n-ignore: a reason's code, said in words where it is shown
  return { why: 'failed', ...(named ? { ref: named } : {}), detail: line || 'git update-ref failed' } // i18n-ignore: a reason's detail (English, as git's)
}
