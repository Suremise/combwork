/**
 * Which file fills a session's model slot (dialects, HI-2065; plans/2026-11-03-dialects-design.md, section 3).
 *
 * The per-agent "Dialect" setting is Auto or a file of the agent's CLI folder (a model file or a test copy). Auto
 * matches by the **real model ID** Combwork resolves for the launch (`dialectModelId` in shared/models.ts, so an alias goes
 * through the CLI's catalogue), never the friendly name:
 * 1. a file whose `model` is exactly that ID;
 * 2. else a file whose `model` is its base ID (no "[1m]" suffix or snapshot date: `baseModelId`);
 * 3. else none, and the chain is CLI → Workspace → Default.
 * No ID at all (the CLI's own default, an alias Combwork can't resolve) leaves the slot empty with "model unknown". A file
 * switched off leaves the slot empty too: its texts fall through, as for any layer.
 */
import { baseModelId } from '../../shared/models'
import type { DialectFolder, LoadedDialect } from './chain'

/** Auto's file for a model ID, among a folder's files: exact, then the base ID. Off files count (they empty the slot). */
export function autoModelFile(files: readonly LoadedDialect[], modelId: string): LoadedDialect | null {
  const claims = files.filter((f) => f.model && !f.claimTaken && !f.broken)
  const exact = claims.find((f) => f.model === modelId.trim())
  if (exact) return exact
  const base = baseModelId(modelId)
  return claims.find((f) => f.model!.trim().toLowerCase() === base) ?? null
}

/** The setting's value: Auto, or a file of the agent's CLI folder by its path ("claude-code/Opus 5.5 v2.json"). */
export type DialectPick = 'auto' | { file: string }

/** What fills a session's model slot, and why. */
export interface ModelSlot {
  /** The file, on; null: the slot is empty. */
  file: LoadedDialect | null
  /** The file that matched or was picked, even when it is off (the launch record can say so). */
  chosen: string | null
  /** Auto couldn't name the model. */
  modelUnknown: boolean
  /** The picked file is gone: Auto was used instead. */
  pickMissing?: true
}

/** Fills a session's model slot from its CLI folder, its model ID (null: unknown) and its pick. */
export function modelSlot(folder: DialectFolder | undefined, modelId: string | null, pick: DialectPick = 'auto'): ModelSlot {
  const files = folder?.files ?? []
  const fill = (f: LoadedDialect | null): LoadedDialect | null => (f && f.on && !f.broken ? f : null)
  if (pick !== 'auto') {
    const picked = files.find((f) => f.path === pick.file)
    // A pick is the A/B test: that file in the slot, whatever model runs (the layers below are as on Auto).
    if (picked) return { file: fill(picked), chosen: picked.path, modelUnknown: false }
  }
  const missing = pick !== 'auto' ? { pickMissing: true as const } : {}
  if (!modelId) return { file: null, chosen: null, modelUnknown: true, ...missing }
  const auto = autoModelFile(files, modelId)
  return { file: fill(auto), chosen: auto?.path ?? null, modelUnknown: false, ...missing }
}
