/**
 * The dialect chain (dialects, HI-2065; plans/2026-11-03-dialects-design.md, section 3): which override of each agent
 * text applies, resolved per id, the first layer from the top that has it winning.
 *
 * | Agent session                     | No session (scripts, curl) |
 * | Model file (the model slot)       | —                          |
 * | CLI file (`<CLI>/cli.json`)       | API (`api/cli.json`)       |
 * | Workspace (`workspace.json`)      | Workspace                  |
 * | Default (the code's English)      | Default                    |
 *
 * There is no family layer (decision 2). A file switched off is skipped, as if its slot were empty; an outdated
 * override is skipped for its id only, so that text falls through to the layer below (section 5). Which file fills the
 * model slot is match.ts's. Pure, and loadable in plain Node (the scenarios' harness records a run's chain with it).
 */
import { createHash } from 'crypto'
import type { DialectChain } from '../../shared/agentText/index.ts'
import type { FileProblem, TextProblem } from './format.ts'

/** A dialect file as loaded (store.ts): its overrides that match the schema, and those outdated. */
export interface LoadedDialect {
  /** Where it is in the dialects folder, with `/` ("claude-code/Opus 5.5.json", "workspace.json"). */
  path: string
  name: string
  /** Its model ID, for a model file. */
  model?: string
  /** The overrides that apply: id → ICU text. */
  texts: Readonly<Record<string, string>>
  /** The overrides that don't match the schema: flagged, and skipped. */
  outdated: readonly TextProblem[]
  /** Off in the view: its slot is empty. */
  on: boolean
  /** It can't be read as a dialect at all: it adds nothing. */
  broken?: FileProblem
  /** Another file of its folder claimed its model first: Auto never picks this one (it acts as a test copy). */
  claimTaken?: string
}

/** A CLI's folder (or the API's): its CLI file, and its model files and test copies. */
export interface DialectFolder {
  cli: LoadedDialect | null
  files: LoadedDialect[]
}

/** A workspace's dialects: the Workspace file, and each folder by its name (a provider's id, or `api`). */
export interface DialectSet {
  workspace: LoadedDialect | null
  folders: Readonly<Record<string, DialectFolder>>
}

export type ChainLayer = 'model' | 'cli' | 'api' | 'workspace'

/** A chain as resolved for a launch or a request: the merged overrides, each layer's file, and where each text came from. */
export interface ResolvedChain extends DialectChain {
  /** Each layer, top first, with the file that fills it (null: empty, off or missing). */
  layers: { layer: ChainLayer; file: string | null }[]
  /** Each overridden id → the file its text came from. */
  sources: Readonly<Record<string, string>>
  /** Auto couldn't name the model, so the model slot is empty: the launch record says "model unknown" (decision 4). */
  modelUnknown?: true
}

/** What a chain is resolved for: a session of a CLI (its model slot already chosen), or a caller with no session. */
export type ChainRequest = { kind: 'session'; cli: string; modelFile: LoadedDialect | null; modelUnknown?: boolean } | { kind: 'api' }

/** A hash of the resolved texts ('' for none, the Default): what the launch record, metrics and guidance revision name. */
export function chainHash(texts: Readonly<Record<string, string>>): string {
  const ids = Object.keys(texts).sort()
  if (!ids.length) return ''
  const h = createHash('sha256')
  for (const id of ids) h.update(`${id}\0${texts[id]}\0`)
  return h.digest('hex').slice(0, 16)
}

/** The layers of a request, top first. */
function layersOf(set: DialectSet, req: ChainRequest): { layer: ChainLayer; file: LoadedDialect | null }[] {
  if (req.kind === 'api') return [{ layer: 'api', file: set.folders.api?.cli ?? null }, { layer: 'workspace', file: set.workspace }]
  return [
    { layer: 'model', file: req.modelFile },
    { layer: 'cli', file: set.folders[req.cli]?.cli ?? null },
    { layer: 'workspace', file: set.workspace }
  ]
}

/** Resolves a request's chain: each id's text from the highest layer that has a matching override of it. */
export function resolveChain(set: DialectSet, req: ChainRequest): ResolvedChain {
  const layers = layersOf(set, req).map(({ layer, file }) => ({ layer, file: file && file.on && !file.broken ? file : null }))
  const texts: Record<string, string> = Object.create(null)
  const sources: Record<string, string> = Object.create(null)
  // Bottom up, each layer over the one below it.
  for (const { file } of [...layers].reverse()) {
    if (!file) continue
    for (const [id, text] of Object.entries(file.texts)) {
      texts[id] = text
      sources[id] = file.path
    }
  }
  return {
    texts,
    sources,
    files: layers.flatMap((l) => (l.file ? [l.file.path] : [])),
    hash: chainHash(texts),
    layers: layers.map((l) => ({ layer: l.layer, file: l.file?.path ?? null })),
    ...(req.kind === 'session' && req.modelUnknown ? { modelUnknown: true as const } : {})
  }
}
