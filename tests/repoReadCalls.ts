// The window's repository reads as ipc.ts makes them (HI-2785): tests/repoReadTraces.test.ts traces these. Recorded at
// cd19d0e60, before the port, calling the functions directly (that commit's copy of this file); now through the
// repository reads port, as ipc.ts calls it, with the same trace.
import { lineRepoReads } from '../src/main/platform/repoReadsPorts'
import type { ReadSlot } from '../src/main/platform/repoReads'
import type { WorkspaceService } from '../src/main/workspace'

const R = lineRepoReads
export const summary = (p: string): Promise<unknown> => R().summary(p)
export const workTarget = (p: string): Promise<unknown> => R().workTarget(p)
export const info = async (p: string): Promise<unknown> => R().info(p, await R().workTarget(p))
export const leftovers = async (p: string): Promise<unknown> => R().leftovers(p, await R().workTarget(p))
export const history = async (p: string, ref: string | null, page: number): Promise<unknown> => R().history(p, { ref, page, workTarget: await R().workTarget(p) })
export const compareLines = async (p: string, slots: ReadSlot[]): Promise<unknown> => R().compareLines(p, await R().workTarget(p), slots)
export const compare = (p: string, base: string, head: string, page: number, pinBase?: string, pinHead?: string): Promise<unknown> => R().compare(p, base, head, page, { base: pinBase, head: pinHead })
export const compareDiff = (p: string, base: string, head: string, file: string, pinned?: { base?: string; head?: string }): Promise<unknown> => R().compareDiff(p, base, head, file, pinned)
export const branchDrops = (p: string, branch: string): Promise<unknown> => R().lineDrops(p, branch)
export const updatePlan = (p: string, branch: string): Promise<unknown> => R().updatePlan(p, branch)
export const lineStatus = (w: WorkspaceService, p: string, folder: string, branch: string): Promise<unknown> => {
  const project = w.info()!.projects.find((x) => x.path.toLowerCase() === p.toLowerCase())!
  return R().lineStatus({ project, worktree: { path: folder, branch, base: '' } })
}
export const mergeBranches = (p: string): Promise<unknown> => R().mergeLines(p)
export const branchMergeStatus = (p: string, branch: string, target: string): Promise<unknown> => R().lineMergeStatus(p, branch, target)
