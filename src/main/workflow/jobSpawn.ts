// A spawn whose every process is a lease job's (HI-2938/s11 §3): a command's launcher started waiting, put in the job,
// then told to run it, as the merge queue runner's are (queueRunner.ts' letGo). A launcher the job can't take is never
// told to run: its input ends and it is ended. The job, and the copies pool's barrier that settles it, own the tree.

import type { ChildProcess, SpawnOptions } from 'child_process'
import { createLogger } from '../logger'
import { startLauncher } from './launcher'
import type { LeaseJob } from './queueJobs'

const log = createLogger('queue')

/** What a job spawn needs of a lease job: putting a waiting launcher in it. */
export type Assignable = Pick<LeaseJob, 'assign'>

/** A spawn (queueChecks.ts' Spawn) starting each process in `job`. */
export function jobSpawn(job: Assignable): (file: string, args: string[], opts: SpawnOptions) => ChildProcess {
  return (file, args, opts) => {
    const { child, after, before } = startLauncher({ command: file, args, shell: !!opts.shell, verbatim: !!opts.windowsVerbatimArguments }, { cwd: opts.cwd as string | undefined, env: opts.env })
    for (const st of [child.stdin, child.stdout, child.stderr]) st?.on('error', (e) => log.warn("a candidate check's launcher pipe", e))
    const giveUp = (): void => {
      child.stdin?.end()
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill()
        } catch (e) {
          log.warn("ending a candidate check's launcher", e)
        }
      }
    }
    void (async () => {
      if (!child.pid) return
      try {
        if (!(await job.assign(child.pid, after, before))) return giveUp()
        child.stdin!.write('go\n') // i18n-ignore: the launcher's go-ahead (queueJobs.ts), not text
        child.stdin!.end()
      } catch (e) {
        log.warn("putting a candidate check's launcher in its job", e)
        giveUp()
      }
    })()
    return child
  }
}
