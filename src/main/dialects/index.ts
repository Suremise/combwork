/**
 * The dialects service (dialects, HI-2065; plans/2026-11-03-dialects-design.md, sections 3 and 7, card 6): a
 * workspace's dialect files, checked against the schema, resolved into the chain a session or a request speaks in.
 *
 * - format.ts: a file's shape and its one check (the schema's);
 * - store.ts: `.hive/dialects/` on disk, `.state.json`'s switches, saves, imports, duplicates, Promote, and the file a
 *   launch's resolved texts go in (`HIVE_DIALECT_FILE`);
 * - match.ts: which file fills a session's model slot (Auto by the real model ID, or the agent's pick);
 * - chain.ts: Model file → CLI → Workspace → Default, or API → Workspace → Default for a caller with no session.
 *
 * Nothing calls it yet but its tests and the scenarios: card 6b registers it with agent text's chain resolver and
 * pins each session's chain at its launch.
 */
import { agentTextSchema } from './schema'
import { loadDialects } from './store'
import { modelSlot, type DialectPick, type ModelSlot } from './match'
import { resolveChain, type ResolvedChain } from './chain'
import type { DialectSchema } from './format'

export { agentTextSchema } from './schema'
export * from './store'
export { autoModelFile, modelSlot, type DialectPick, type ModelSlot } from './match'
export { chainHash, resolveChain, type ChainLayer, type ChainRequest, type DialectFolder, type DialectSet, type LoadedDialect, type ResolvedChain } from './chain'
export { API_FOLDER, CLI_FILE, STATE_FILE, WORKSPACE_FILE, checkTexts, dialectFileText, parseDialectFile, textProblem, type DialectFile, type DialectSchema, type DialectText, type FileProblem, type TextProblem } from './format'

/** What a session's chain is resolved from: its CLI (the provider's id), its real model ID (null: unknown), its pick. */
export interface SessionDialect {
  cli: string
  modelId: string | null
  pick?: DialectPick
}

/** A session's chain from a workspace's dialects folder: its model slot filled, then each id resolved down the chain. */
export async function resolveSessionChain(dir: string, s: SessionDialect, schema: DialectSchema = agentTextSchema()): Promise<ResolvedChain & { slot: ModelSlot }> {
  const set = await loadDialects(dir, schema)
  const slot = modelSlot(set.folders[s.cli], s.modelId, s.pick)
  return { ...resolveChain(set, { kind: 'session', cli: s.cli, modelFile: slot.file, modelUnknown: slot.modelUnknown }), slot }
}

/** The chain of a caller with no session (a script, curl): API → Workspace → Default. */
export async function resolveApiChain(dir: string, schema: DialectSchema = agentTextSchema()): Promise<ResolvedChain> {
  return resolveChain(await loadDialects(dir, schema), { kind: 'api' })
}
