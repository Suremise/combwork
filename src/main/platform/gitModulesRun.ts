// The submodules-and-LFS step's git, run as one of Combwork's runs (HI-1182): each git with no shell, in the run's job
// (its spawn), its environment the run's own, bounded by the run's time limit (then every git it started is ended and
// nothing more starts) and ended with the run (the workspace closing). Changing steps' output goes to the run's log;
// reads keep theirs, logging only git's error when one fails.

import type { ChildProcess } from 'child_process'
import { gitExe } from '../gitTool'
import { withLauncherEnv } from '../gitWorker'
import { treeEnding, type TreeEnding } from '../processTree'
import type { GitFilesExec, GitFilesRun } from './gitModules'
import type { WorkspaceFilesRunOptions } from './workspacePort'

/** The most of a read's output kept (a big repository's ls-files). */
const MAX_OUT = 32 * 1024 * 1024

export type GitFilesRunOptions = WorkspaceFilesRunOptions

/** A GitFilesExec for one run, and how it ended: `timedOut` at its limit, `close()` once the step is done. */
export function gitFilesExec(o: GitFilesRunOptions): GitFilesExec & { timedOut(): boolean; close(): void } {
  const platform = o.platform ?? process.platform
  // Each running git and how its tree is ended: off main's thread (HI-3009), its result given once that teardown is over.
  const children = new Map<ChildProcess, TreeEnding>()
  let timedOut = false
  const stopped = (): boolean => timedOut || !!o.signal?.aborted
  const endAll = (): void => {
    for (const [c, ending] of children) ending.end(c)
  }
  const timer = setTimeout(() => {
    timedOut = true
    endAll()
  }, o.timeoutMs)
  timer.unref?.()
  o.signal?.addEventListener('abort', endAll)
  const write = (s: string): void => o.log.write(Buffer.from(s))
  return {
    timedOut: () => timedOut,
    close: () => {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', endAll)
    },
    stopped,
    baseEnv: () => ({ ...o.env }),
    note: (line) => write(`${line}\n`),
    git: (cwd, args, opt = {}) =>
      new Promise<GitFilesRun>((resolve) => {
        if (stopped()) return resolve({ ok: false, code: null, out: '', err: 'ended' })
        const exe = gitExe()
        const env0: NodeJS.ProcessEnv = { ...o.env, ...opt.env }
        const env = exe.launcherEnv ? withLauncherEnv(env0, exe.launcherEnv) : env0
        if (opt.log) write(`$ git ${args.join(' ')}\n`) // i18n-ignore: the run's log: the command run, as it is
        let child: ChildProcess
        try {
          child = o.spawn(exe.exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e)
          write(`${err}\n`)
          return resolve({ ok: false, code: null, out: '', err })
        }
        const ending = treeEnding(platform)
        children.set(child, ending)
        const out: Buffer[] = []
        let outBytes = 0
        const err: Buffer[] = []
        child.stdout?.on('data', (c: Buffer) => {
          if (opt.log) o.log.write(c)
          if (outBytes < MAX_OUT) {
            out.push(c)
            outBytes += c.length
          }
        })
        child.stderr?.on('data', (c: Buffer) => {
          if (opt.log) o.log.write(c)
          err.push(c)
        })
        let done = false
        const finish = (code: number | null): void => {
          if (done) return
          done = true
          children.delete(child)
          const r: GitFilesRun = { ok: code === 0 && !stopped(), code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }
          // A read that failed: git's words in the log too, so the run's log says why.
          if (!opt.log && !r.ok && r.err.trim()) write(`$ git ${args.join(' ')}\n${r.err.trim()}\n`) // i18n-ignore: the run's log: the command and git's own words
          ending.after(() => resolve(r))
        }
        child.on('error', (e) => {
          write(`${e.message}\n`)
          finish(null)
        })
        child.on('close', (code) => finish(code))
      })
  }
}
