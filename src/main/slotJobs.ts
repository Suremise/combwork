// Settling a slot command's job (#1429, HR1's round 2): #1360's recovery protocol for a job on Combwork's process supervisor
// and its journal (queueJobs.ts), for a slot's setup, install or archive command. Each step only once the one before
// has succeeded, so a failure or a crash at any point leaves the evidence (the slot's `job`, the journal's parts) for
// the next try:
// 1. the job ended by its name (never the supervisor holding it, which may be another Combwork's) and seen empty, or gone;
// 2. its journal sealed: closed to writers for good, so a process a supervisor that outlived its Combwork follows can no
//    longer be written down after the read (it ends what it can't write down instead);
// 3. one read of it (unreadable or damaged: unknown, never empty), then every process it names that still runs (by pid
//    and start) ended with what it started, and seen gone;
// 4. only then its journal cleared (the seal stays until its job is gone: the caller retires it, HI-1723), and the
//    caller clears the slot's `job`.

import { clearJournal, journalOf, sealJournal } from './workflow/queueJobs'
import { treeOf, type Listed, type ProcessProbe } from './workflow/queueProcs'

/** How long a settle waits for the processes it ended to be gone. */
const END_WAIT_MS = 15_000

export interface JobSettling {
  /** Ends the job by its name and waits for it to be empty: true once it is (or it is gone). */
  endJob: (job: string) => Promise<boolean>
  probe: ProcessProbe
  /** The project's worktrees folder, and the folder its slot jobs' journals are in. */
  root: string
  dir: string
  /** How long to wait for the processes it ended to be gone (default END_WAIT_MS). */
  waitMs?: number
  /** Tests: runs once the journal is sealed, before it is read (a supervisor trying to write then). */
  afterSeal?: () => Promise<void> | void
}

/** Whether a listed process is one a journal names (its pid, started within a millisecond of the record). */
const named = (p: Listed, j: { pid: number; started: number }): boolean => p.pid === j.pid && Math.abs(p.started - j.started) <= 1

/** Settles a job (the protocol above): true once nothing it ran or followed runs, its journal then cleared. */
export async function settleSlotJob(o: JobSettling, job: string): Promise<boolean> {
  if (!(await o.endJob(job))) return false
  if (!(await sealJournal(o.root, job, o.dir))) return false
  await o.afterSeal?.()
  const j = await journalOf(o.root, job, o.dir)
  if (j.state === 'unknown') return false
  if (j.state === 'read' && j.entries.length) {
    const list = await o.probe.list()
    if (!list) return false
    const roots = list.filter((p) => j.entries.some((e) => named(p, e)))
    if (roots.length) {
      const tree = [...new Map(roots.flatMap((r) => treeOf(list, r)).map((p) => [p.pid, p])).values()]
      await o.probe.end(tree)
      if (!(await allGone(o.probe, tree, o.waitMs ?? END_WAIT_MS))) return false
    }
  }
  await clearJournal(o.root, job, o.dir)
  return true
}

/** Waits (bounded) until none of these processes runs; false when one still does, or that can't be told. */
async function allGone(probe: ProcessProbe, targets: Listed[], waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs
  for (;;) {
    const list = await probe.list()
    if (!list) return false
    if (!targets.some((t) => list.some((p) => named(p, t)))) return true
    if (Date.now() > until) return false
    await new Promise((r) => setTimeout(r, 200))
  }
}
