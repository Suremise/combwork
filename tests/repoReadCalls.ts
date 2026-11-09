// The window's repository reads as ipc.ts makes them (HI-2785): tests/repoReadTraces.test.ts traces these. Recorded at
// a49568305 calling today's functions directly; the port's routing replaces each call here, the trace unchanged.
import { branchDrops, branchUpdatePlan, leftoverInfo, repoHistory, repoInfo, repoSummary, workTargetOf } from '../src/main/gitRepo'
import { compareBranches, compareDiff as diffOf, compareLines as linesOf, type SlotRecord } from '../src/main/gitCompare'
import { lineStatus as statusOf } from '../src/main/branchWatch'
import { branchMergeStatus as mergeStatusOf, mergeBranches as mergeListOf } from '../src/main/branchMerge'
import type { WorkspaceService } from '../src/main/workspace'

export const summary = (p: string): Promise<unknown> => repoSummary(p)
export const workTarget = (p: string): Promise<unknown> => workTargetOf(p)
export const info = async (p: string): Promise<unknown> => repoInfo(p, await workTargetOf(p))
export const leftovers = async (p: string): Promise<unknown> => leftoverInfo(p, await workTargetOf(p))
export const history = async (p: string, ref: string | null, page: number): Promise<unknown> => repoHistory(p, { ref, page, workTarget: await workTargetOf(p) })
export const compareLines = async (p: string, slots: SlotRecord[]): Promise<unknown> => linesOf(p, await workTargetOf(p), slots)
export const compare = (p: string, base: string, head: string, page: number, pinBase?: string, pinHead?: string): Promise<unknown> => compareBranches(p, base, head, page, { base: pinBase, head: pinHead })
export const compareDiff = (p: string, base: string, head: string, file: string, pinned?: { base?: string; head?: string }): Promise<unknown> => diffOf(p, base, head, file, pinned)
export const branchDrops_ = branchDrops
export { branchDrops_ as branchDrops }
export const updatePlan = (p: string, branch: string): Promise<unknown> => branchUpdatePlan(p, branch)
export const lineStatus = (w: WorkspaceService, p: string, folder: string, branch: string): Promise<unknown> => {
  const project = w.info()!.projects.find((x) => x.path.toLowerCase() === p.toLowerCase())!
  return statusOf({ project, worktree: { path: folder, branch, base: '' } })
}
export const mergeBranches = (p: string): Promise<unknown> => mergeListOf(p)
export const branchMergeStatus = (p: string, branch: string, target: string): Promise<unknown> => mergeStatusOf(p, branch, target)
