// HI-3552: the pull request host in the app (prHost.ts does the work). An `openPr` action opens its request's pull
// request; a workspace opening takes up any request left waiting (a crash or a close between its write and its push)
// and reads the pull requests of its cards in PR open; and, while any card of an open workspace waits in PR open, they
// are read again on a timer (Settings → Advanced, Pull requests: how often their state is read). Only open workspaces,
// one read per card at a time; a failed read leaves the card as it was, its view marked stale.

import { advanced } from '../advanced'
import { boardRead, boardReadOnly } from '../boardStore'
import { onCombworkEvent } from '../events'
import { createLogger } from '../logger'
import { openWorkspaces, type WorkspaceService } from '../workspace'
import { onAction } from './actionWorker'
import { workflowFor } from './service'
import { followPr, openPr, prViewOf, type Alive, type PrView } from './prHost'
import { GITHUB_PR_FOLLOW_MINUTES } from '../../shared/advanced'

const log = createLogger('workflow')

/** The project of a card on a workspace's board, by its board name: its folder, or null. */
function projectOf(ws: WorkspaceService, card: number): string | null {
  const name = boardRead(ws, (db) => (db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string } | undefined)?.project) // i18n-ignore: SQL
  if (!name) return null
  return ws.info()?.projects.find((p) => p.name.toLowerCase() === name.toLowerCase())?.path ?? null
}

/** The host's runs since it started: stopping it (a quit) ends every run's ownership. */
let hostRun = 0

/**
 * A run's owner (HR1): the workspace as it is now, for its lifetime (the merge queue's host and the action worker's
 * test), while this host runs. Closed, switched or stopped, its runs push, open, write and keep nothing more.
 */
function ownerOf(ws: WorkspaceService): Alive {
  const life = ws.lifetime
  const path = ws.path
  const run = hostRun
  return () => run === hostRun && stop !== null && !life.aborted && ws.lifetime === life && ws.path === path
}

/** Each project of an open workspace with cards waiting on a pull request: those in Approved asked, and in PR open. */
async function sweep(ws: WorkspaceService, opening: boolean): Promise<void> {
  if (!ws.path || boardReadOnly(ws)) return
  const alive = ownerOf(ws)
  for (const p of ws.info()?.projects ?? []) {
    if (!p.platform) continue
    const wf = await workflowFor(ws, p.path).catch(() => null)
    if (!wf || !alive()) continue
    for (const card of wf.store.cards()) {
      if (card.stage === 'prOpen') void followPr(wf, card.id, undefined, alive).catch((e) => log.warn(`reading #${card.id}'s pull request`, e))
      else if (opening && card.stage === 'approved') {
        const r = wf.state(card).pullRequest
        if (r && !r.opened && !r.failed) void openPr(wf, card.id, r.requested.request, undefined, alive).catch((e) => log.warn(`opening #${card.id}'s pull request`, e))
      }
    }
  }
}

let stop: (() => void) | null = null

/** Starts the pull request host (index.ts, once). */
export function startPrHosts(): void {
  if (stop) return
  hostRun++
  onAction('openPr', async (a, ws) => {
    const alive = ownerOf(ws)
    const project = projectOf(ws, a.card)
    const wf = project ? await workflowFor(ws, project) : null
    if (wf && alive()) void openPr(wf, a.card, String(a.payload.request ?? ''), undefined, alive).catch((e) => log.warn(`opening #${a.card}'s pull request`, e))
  })
  const seen = new WeakSet<AbortSignal>()
  const off = onCombworkEvent((e) => {
    if (e.type !== 'workspace-changed') return
    for (const ws of openWorkspaces()) {
      if (!ws.path || seen.has(ws.lifetime)) continue
      seen.add(ws.lifetime)
      void sweep(ws, true).catch((x) => log.warn('taking up the pull requests of a workspace', x))
    }
  })
  let timer: ReturnType<typeof setTimeout> | null = null
  const tick = (): void => {
    const minutes = Number(advanced.get(GITHUB_PR_FOLLOW_MINUTES))
    timer = setTimeout(
      () => {
        for (const ws of openWorkspaces()) void sweep(ws, false).catch((x) => log.warn('reading the pull requests of a workspace', x))
        tick()
      },
      (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60_000
    )
    timer.unref?.()
  }
  tick()
  stop = () => {
    hostRun++
    off()
    if (timer) clearTimeout(timer)
    timer = null
  }
}

/** Stops the timer and the workspace watch (a quit). */
export function stopPrHosts(): void {
  stop?.()
  stop = null
}

/**
 * A card's pull request read now (its board or card opened: IPC `tasks:prStatus`), following it to Done or Todo; or the
 * last read when a read is going on. Null for a card with none in PR open.
 */
export async function prStatus(ws: WorkspaceService, card: number): Promise<PrView | null> {
  const alive = ownerOf(ws)
  const project = projectOf(ws, card)
  const wf = project ? await workflowFor(ws, project) : null
  if (!wf || !alive()) return null
  return (await followPr(wf, card, undefined, alive).catch(() => null)) ?? (alive() ? prViewOf(wf, card) : null)
}

/** Reads every card's pull request in PR open in a workspace now (its board opened). */
export function followAll(ws: WorkspaceService): Promise<void> {
  return sweep(ws, false)
}
