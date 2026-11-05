import type { CatalogModel } from '../../../shared/types'
import type { CatalogRead } from '../types'

/**
 * Codex's models from `codex debug models` (#125): its catalog for this version and account, in its order. Read
 * defensively: unknown fields are ignored, a model's missing or odd field is left out (Combwork falls back for it), and
 * hidden models (visibility "hide": internal ones such as its auto-reviewer) aren't offered. Checked with 0.160.
 */
export function parseCodexModels(stdout: string): CatalogRead | null {
  let list: unknown
  try {
    list = (JSON.parse(stdout.replace(/^﻿/, '')) as { models?: unknown }).models
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const models = list
    .filter((m): m is Record<string, any> => !!m && typeof m === 'object' && !!str(m.slug) && m.visibility !== 'hide')
    .map((m, i) => ({ m, i, priority: typeof m.priority === 'number' ? m.priority : 99 }))
    .sort((a, b) => a.priority - b.priority || a.i - b.i)
    .map(({ m }): CatalogModel => {
      const value = str(m.slug)!
      const name = str(m.display_name)
      const out: CatalogModel = { value, label: name ? name.replace(/-/g, ' ').replace(/^GPT /, 'GPT-') : value }
      const description = str(m.description)
      if (description) out.description = description
      // Each level is { effort, description } (or, defensively, the level's name). An empty list says the model has no
      // levels; a list with none valid, or no list, is unknown, and Combwork falls back (#125, round 2).
      const raw = m.supported_reasoning_levels
      if (Array.isArray(raw)) {
        const valid = [...new Set(raw.map((l: unknown) => str((l as { effort?: unknown })?.effort) ?? str(l)).filter((x: string | undefined): x is string => !!x))] as string[]
        if (valid.length || !raw.length) out.efforts = valid
      }
      const def = str(m.default_reasoning_level)
      if (def && (!out.efforts || out.efforts.includes(def))) out.defaultEffort = def
      return out
    })
  return models.length ? { models } : null
}
