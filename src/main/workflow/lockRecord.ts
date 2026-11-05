// G16's lock records (#1481): the paths each agent takes Combwork's file locks on while it works a card, kept with that
// card's facts (`FilesLocked`), so "another agent's files" in a shared folder is known after the lock is released and
// after a restart. Sessions publish an agent's locks as they change (`lockedFiles` in its `session-status`); this
// records them on the agent's current card. Each write is queued as the event comes, in order, per project, and an
// intent that reads the records (a submit) waits for those queued before it (`locksSettled`), so a lock taken before a
// submission is always in it. Without file locks (Settings: Off) sessions take none, and nothing is recorded.
import { isAbsolute, relative, resolve } from 'path'
import { inBoardWrite } from '../boardStore'
import { onCombworkEvent } from '../events'
import { createLogger, userText } from '../logger'
import { workspaceOf, type WorkspaceService } from '../workspace'
import type { CombworkEvent } from '../../shared/types'
import type { LockSeen } from './runtime'
import { workflowFor, workflowNow } from './service'

const log = createLogger('workflow')

/** Each project's queued record writes, by workspace and project: what an intent reading the records waits for. */
const queued = new WeakMap<WorkspaceService, Map<string, Promise<void>>>()
/** What each live session's locks last were, with its current card then: an event saying the same again writes nothing. */
const seen = new Map<string, string>()

const keyOf = (p: string): string => p.toLowerCase()
const liveKey = (projectPath: string, agentId: string): string => `${keyOf(projectPath)}#${agentId}`

/** The records still being written for a project. Inside a write to its board they can't be waited for (they wait for it). */
export function locksSettled(ws: WorkspaceService, projectPath: string): Promise<void> {
  if (ws.path && inBoardWrite(ws.path)) return Promise.resolve()
  return queued.get(ws)?.get(keyOf(projectPath)) ?? Promise.resolve()
}

/** A session's locked paths relative to the project folder, with `/`; those outside it (an agent's own worktree) left out. */
function projectPaths(projectPath: string, cwd: string, files: readonly string[]): string[] {
  const out: string[] = []
  for (const f of files) {
    const rel = relative(projectPath, resolve(cwd, f))
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) out.push(rel.replace(/\\/g, '/'))
  }
  return [...new Set(out)].sort()
}

/** Handles one event, synchronously: what to record is decided and queued now, in the order events come. */
export function onLockEvent(e: CombworkEvent): void {
  if (e.type === 'session-exit') {
    seen.delete(liveKey(e.projectPath, e.agentId))
    return
  }
  if (e.type !== 'session-status' || !e.state.projectPath) return
  const { projectPath, agentId, cwd } = e.state
  const id = liveKey(projectPath, agentId)
  const paths = projectPaths(projectPath, cwd, e.state.lockedFiles ?? [])
  if (!paths.length) {
    if (seen.has(id)) seen.set(id, '')
    return
  }
  const ws = workspaceOf(projectPath)
  // The agent's current card as the runtime has it (none made yet this launch: none started since), so the same locks
  // held on into the agent's next card are recorded on that one too.
  const current = workflowNow(ws, projectPath)?.currentCard(agentId)
  const key = `${paths.join('\n')}|${current ? `${current.card.id}:${current.s.cycle}` : ''}`
  if (seen.get(id) === key) return
  seen.set(id, key)
  const seenOn: LockSeen = current ? { card: current.card.id, cycle: current.s.cycle } : { at: new Date().toISOString() }
  let byProject = queued.get(ws)
  if (!byProject) queued.set(ws, (byProject = new Map()))
  const p = keyOf(projectPath)
  const run = (byProject.get(p) ?? Promise.resolve()).then(async () => {
    const wf = await workflowFor(ws, projectPath)
    if (wf) await wf.recordLocks(agentId, paths, seenOn)
  })
  const tail = run.catch((err: Error) => log.info(`File locks of ${userText(agentId)} not recorded on its card: ${userText(err.message)}`))
  byProject.set(p, tail)
  void tail.then(() => {
    if (byProject.get(p) === tail) byProject.delete(p)
  })
}

/** Starts recording (the app, as it starts); returns the stop. */
export function startLockRecords(): () => void {
  return onCombworkEvent(onLockEvent)
}
