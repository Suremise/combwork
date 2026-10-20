// The app's reconciliation (#1217, SPEC §16.4.4; P3 is record-only): what the watcher sees in a project (a line or a
// folder's head moved, a write) is reconciled against its cards' facts, and what is true is recorded as observed facts
// (HeadMoved, Integrated by outside, Stale, CarriedOver, CommitAttributed, MergedInPart, LeftTarget, Gone), deduplicated
// so two Hives on one workspace write each once (§16.17). Nothing moves, wakes or cancels: the runtime here runs with
// `reconcileActs` off, the one switch P4's runtime turns on.
//
// Runs on the watcher's events (debounced: a burst of ref changes reconciles once), when a window is focused, when a
// card's Work section is read, and once as a workspace opens. One run at a time per project; its platform reads are
// made outside the board's lock, its writes inside a change of it (the runtime's `locked`), and a run belongs to its
// workspace's lifetime: once it closes or its window opens another, the run stops and its watch goes.

import { join } from 'path'
import { boardReadOnly, boardWrite } from '../boardStore'
import { onHiveEvent } from '../events'
import { createLogger } from '../logger'
import { observer, type Disposable, type ObserveEvent } from '../platform/observe'
import { openWorkspaces, WorkspaceService } from '../workspace'
import { compile } from '../../shared/workflow/compile'
import { allOff, type WorkflowOptions } from '../../shared/workflow/options'
import type { PlatformId } from '../../shared/platform/descriptors'
import { FactStore } from './factStore'
import { reconcile } from './reconcile'
import { Workflow } from './runtime'

const log = createLogger('workflow')

/** How long the reconciler waits after a project's last event before it runs (the watcher has debounced already). */
export const RECONCILE_DEBOUNCE_MS = 400
/** Window focus reconciles again at most this often. */
const FOCUS_MS = 10_000
/** The stages whose cards are reconciled on every run; Done cards only when their target moved. */
const UNFINISHED = ['active', 'review', 'approved', 'merging']

/** A project being followed: its workspace as it was, what is waiting to be reconciled, and its run. */
interface Followed {
  ws: WorkspaceService
  path: string
  name: string
  platform: PlatformId
  alive: () => boolean
  watch: Disposable
  timer: NodeJS.Timeout | null
  /** Lines (Git branches) that moved since the last run: their Done cards are looked at too. */
  lines: Set<string>
  /** Cards asked for (a Work section read) since the last run, besides the unfinished ones. */
  cards: Set<number>
  running: Promise<void> | null
  again: boolean
}

const followed = new Map<string, Followed>()
const keyOf = (path: string): string => path.toLowerCase()

/** For tests: told when a project's run ends (its path). */
export const reconcilerTestHooks: { ran: ((path: string) => void) | null } = { ran: null }

/** Follows the open workspaces' projects: a watch for each new one, and the ones gone let go. */
function follow(): void {
  const now = new Map<string, { ws: WorkspaceService; path: string; name: string; platform: PlatformId }>()
  for (const ws of openWorkspaces()) {
    if (!ws.path) continue
    for (const p of ws.info()?.projects ?? []) if (p.platform) now.set(keyOf(p.path), { ws, path: p.path, name: p.name, platform: p.platform.id })
  }
  for (const [k, f] of followed) {
    const n = now.get(k)
    if (!n || n.ws !== f.ws || !f.alive()) drop(k)
  }
  for (const [k, n] of now) {
    if (followed.has(k)) continue
    const life = n.ws.lifetime
    const wsPath = n.ws.path
    const f: Followed = {
      ...n,
      alive: () => !life.aborted && n.ws.lifetime === life && n.ws.path === wsPath,
      watch: { dispose: () => undefined },
      timer: null,
      lines: new Set(),
      cards: new Set(),
      running: null,
      again: false
    }
    f.watch = observer.subscribe(n.path, (e) => onObserved(f, e))
    followed.set(k, f)
  }
}

function drop(k: string): void {
  const f = followed.get(k)
  if (!f) return
  followed.delete(k)
  f.watch.dispose()
  if (f.timer) clearTimeout(f.timer)
}

function onObserved(f: Followed, e: ObserveEvent): void {
  if (e.kind === 'lineMoved') f.lines.add(e.line)
  schedule(f)
}

/** Reconciles a project soon: once after its events settle. */
function schedule(f: Followed): void {
  if (!f.alive()) return
  if (f.timer) clearTimeout(f.timer)
  f.timer = setTimeout(() => {
    f.timer = null
    void runFor(f)
  }, RECONCILE_DEBOUNCE_MS)
  f.timer.unref?.()
}

/** One run at a time per project: a run asked for meanwhile runs after it. Never throws. */
function runFor(f: Followed): Promise<void> {
  if (f.running) {
    f.again = true
    return f.running
  }
  f.running = (async () => {
    try {
      do {
        f.again = false
        await reconcileProject(f)
      } while (f.again && f.alive())
    } catch (e) {
      if (f.alive()) log.warn('reconciling the cards of a project with what was observed', e)
    } finally {
      f.running = null
      reconcilerTestHooks.ran?.(f.path)
    }
  })()
  return f.running
}

/** The project's options (`project.json`'s `workflow`, SPEC §16.6), or its platform's defaults (#1218 records them). */
async function optionsOf(f: Followed): Promise<WorkflowOptions> {
  const cfg = await f.ws.projectConfig(f.path)
  const o = (cfg as { workflow?: { options?: unknown } }).workflow?.options
  if (o && typeof o === 'object') {
    try {
      if (compile(o as WorkflowOptions).ok) return o as WorkflowOptions
    } catch {
      // Unreadable: the defaults.
    }
  }
  return allOff(f.platform)
}

async function reconcileProject(f: Followed): Promise<void> {
  if (!f.alive() || boardReadOnly(f.ws)) return
  const lines = [...f.lines]
  const asked = [...f.cards]
  f.lines.clear()
  f.cards.clear()
  const options = await optionsOf(f)
  if (!f.alive()) return
  const wf = new Workflow({
    store: FactStore.forBoard(f.ws, { project: f.name, key: '' }),
    project: f.path,
    projectKey: '',
    options: () => options,
    slots: join(f.ws.hiveDir, 'slots'),
    autoRun: false,
    reconcileActs: false,
    // Each write a change of the board, only while the workspace is the one this run is for.
    locked: (fn) => boardWrite(f.ws, async () => fn(), { alive: f.alive })
  })
  for (const card of wf.store.cards()) {
    if (!f.alive()) return
    const s = wf.state(card)
    if (!s.started) continue
    const target = s.started.target
    const wanted = UNFINISHED.includes(card.stage) || asked.includes(card.id) || (card.stage === 'done' && !!target && lines.includes(target))
    if (!wanted) continue
    try {
      await reconcile(wf, card)
    } catch (e) {
      if (!f.alive()) return
      log.warn(`reconciling #${card.id}`, e)
    }
  }
}

/** Reconciles every project of a workspace soon (its open, a window focused). */
export function reconcileWorkspace(ws: WorkspaceService): void {
  follow()
  for (const f of followed.values()) if (f.ws === ws) schedule(f)
}

/** Reconciles a card's project soon, the card included whatever its stage (its Work section read). */
export function reconcileCard(ws: WorkspaceService, n: number, project: string): void {
  follow()
  for (const f of followed.values()) {
    if (f.ws !== ws || f.name.toLowerCase() !== project.toLowerCase()) continue
    f.cards.add(n)
    schedule(f)
  }
}

/** For tests: runs a project's reconciliation now and waits for it (and any run it was folded into); `lines`: lines moved. */
export async function reconcileNow(ws: WorkspaceService, projectPath: string, lines: string[] = []): Promise<void> {
  follow()
  const f = followed.get(keyOf(projectPath))
  if (!f || f.ws !== ws) return
  for (const l of lines) f.lines.add(l)
  if (f.timer) {
    clearTimeout(f.timer)
    f.timer = null
  }
  await runFor(f)
}

let stop: (() => void) | null = null
let lastFocus = 0

/** Starts following the open workspaces' projects for reconciliation (Hive starting). */
export function startReconciling(): void {
  if (stop) return
  const off = onHiveEvent((e) => {
    if (e.type === 'workspace-changed') follow()
    else if (e.type === 'window-state' && e.focused && Date.now() - lastFocus > FOCUS_MS) {
      lastFocus = Date.now()
      follow()
      for (const f of followed.values()) schedule(f)
    }
  })
  const closing = (path: string): void => {
    for (const [k, f] of followed) if (f.ws.path?.toLowerCase() === path.toLowerCase()) drop(k)
  }
  WorkspaceService.closingListeners.add(closing)
  follow()
  stop = () => {
    off()
    WorkspaceService.closingListeners.delete(closing)
    for (const k of [...followed.keys()]) drop(k)
  }
}

/** Stops it (Hive quitting; tests). */
export function stopReconciling(): void {
  stop?.()
  stop = null
}
