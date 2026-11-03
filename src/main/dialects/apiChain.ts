/**
 * The API chain of each workspace (dialects, HI-2443; plans/2026-11-03-dialects-design.md, section 3): what a caller with
 * no session (a script, curl, a viewer) is said Hive's text in, API → Workspace → Default. A session's chain is pinned
 * at its launch; this one has no launch, so it follows the files: loaded once, kept, and loaded again when the
 * workspace sees its dialects folder change (workspace.ts's watch). Agent text's resolver is synchronous, so the Agent
 * API makes sure it is loaded before it serves such a caller (`apiChainReady`), and binds the request's workspace for
 * the whole request (`inApiWorkspace`), its early and error replies too.
 */
import { AsyncLocalStorage } from 'async_hooks'
import { createLogger } from '../logger'
import { resolveChain, type ResolvedChain } from './chain'
import { agentTextSchema } from './schema'
import { dialectsDir, loadDialects } from './store'

const log = createLogger('dialects')

interface Entry {
  /** The chain as last loaded; null: the Default (none of its files overrides a text), or not loaded yet. */
  chain: ResolvedChain | null
  /** The load under way (the current generation's), if any. */
  loading: Promise<void> | null
  /** Bumped by each change: a load that started before it doesn't land. */
  generation: number
}

/** Each workspace's, by its .hive folder (lower case). */
const entries = new Map<string, Entry>()

function load(hiveDir: string, e: Entry): Promise<void> {
  const generation = e.generation
  const p = loadDialects(dialectsDir(hiveDir), agentTextSchema())
    .then((set) => resolveChain(set, { kind: 'api' }))
    .catch((err) => {
      log.warn("The API's dialect chain couldn't be loaded: callers with no session get the Default", err)
      return null
    })
    .then((chain) => {
      if (e.generation !== generation) return
      e.chain = chain && chain.hash ? chain : null
      e.loading = null
    })
  e.loading = p
  return p
}

/** Loads a workspace's API chain if it isn't yet (or a change is being loaded), and waits for it. */
export function apiChainReady(hiveDir: string): Promise<void> {
  const key = hiveDir.toLowerCase()
  const e = entries.get(key)
  if (e) return e.loading ?? Promise.resolve()
  const fresh: Entry = { chain: null, loading: null, generation: 0 }
  entries.set(key, fresh)
  return load(hiveDir, fresh)
}

/** A workspace's API chain as loaded: null for the Default, or while it isn't loaded yet (a load is started then). */
export function apiChain(hiveDir: string): ResolvedChain | null {
  const e = entries.get(hiveDir.toLowerCase())
  if (!e) void apiChainReady(hiveDir)
  return e?.chain ?? null
}

/** The workspace's dialects folder changed: its API chain is loaded again (the old one serves until it lands). */
export function apiChainChanged(hiveDir: string): void {
  const e = entries.get(hiveDir.toLowerCase())
  if (!e) return
  e.generation++
  void load(hiveDir, e)
}

/** The .hive folder of the workspace the current Agent API request is for (null: none it names, so the Default). */
const requestDir = new AsyncLocalStorage<string | null>()

/**
 * Runs an Agent API request of a caller with no session for its workspace (HR1 on HI-2443): the one the request names
 * or the only one open, decided once from the request, never from which window has the focus. Null: the Default.
 */
export const inApiWorkspace = <T>(hiveDir: string | null, fn: () => T): T => requestDir.run(hiveDir, fn)

/** The API chain of the current request's workspace (inApiWorkspace); null: the Default. */
export function requestApiChain(): ResolvedChain | null {
  const dir = requestDir.getStore()
  return dir ? apiChain(dir) : null
}

/** A workspace closed: its chain is forgotten. */
export function forgetApiChain(hiveDir: string): void {
  entries.delete(hiveDir.toLowerCase())
}
