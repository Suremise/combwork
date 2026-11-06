/**
 * The dialects service (dialects, HI-2065; plans/2026-11-03-dialects-design.md, sections 3 and 7, card 6): a
 * workspace's dialect files, checked against the schema, resolved into the chain a session or a request speaks in.
 *
 * - format.ts: a file's shape and its one check (the schema's);
 * - store.ts: `.combwork/dialects/` on disk, `.state.json`'s switches, saves, imports, duplicates, Promote, and the file a
 *   launch's resolved texts go in (`CW_DIALECT_FILE`);
 * - match.ts: which file fills a session's model slot (Auto by the real model ID, or the agent's pick);
 * - chain.ts: Model file → CLI → Workspace → Default, or API → Workspace → Default for a caller with no session.
 *
 * Sessions (card 6b, HI-2443) pin each session's chain at its launch (sessions.ts) and register the resolver; callers
 * with no session get the API chain (apiChain.ts).
 */
import { agentTextSchema } from './schema'
import { loadDialects } from './store'
import { modelSlot, type DialectPick, type ModelSlot } from './match'
import { resolveChain, type DialectSet, type ResolvedChain } from './chain'
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

/** A session's chain from a workspace's dialects as loaded: its model slot filled, then each id resolved down the chain. */
export function sessionChainOf(set: DialectSet, s: SessionDialect): ResolvedChain & { slot: ModelSlot } {
  const slot = modelSlot(set.folders[s.cli], s.modelId, s.pick)
  return { ...resolveChain(set, { kind: 'session', cli: s.cli, modelFile: slot.file, modelUnknown: slot.modelUnknown }), slot }
}

/** A session's chain from a workspace's dialects folder: its model slot filled, then each id resolved down the chain. */
export async function resolveSessionChain(dir: string, s: SessionDialect, schema: DialectSchema = agentTextSchema()): Promise<ResolvedChain & { slot: ModelSlot }> {
  return sessionChainOf(await loadDialects(dir, schema), s)
}

/** An agent's Dialect setting as saved (AgentDef.dialect) as a pick: absent, empty or "auto" is Auto. */
export const pickOf = (saved: string | null | undefined): DialectPick => (saved && saved.trim() && saved.trim().toLowerCase() !== 'auto' ? { file: saved.trim() } : 'auto')

/** What decides whether a session's chain is still the one it was launched on: its files and the texts they give. */
export const chainKey = (c: ResolvedChain): string => JSON.stringify([c.hash, c.layers, c.modelUnknown ?? false])

/** The chain of a caller with no session (a script, curl): API → Workspace → Default. */
export async function resolveApiChain(dir: string, schema: DialectSchema = agentTextSchema()): Promise<ResolvedChain> {
  return resolveChain(await loadDialects(dir, schema), { kind: 'api' })
}
