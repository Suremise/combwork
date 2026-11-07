import type { CatalogModel } from '../../../shared/types'
import { advanced } from '../../advanced'

export type { CatalogModel }

/**
 * The account's models from `agy models` (HI-2544). 1.5.0 has no machine-readable output for it (`--output-format` isn't
 * a flag of `models`, HI-2543): it prints one model a line, its id, a tab and its display name
 * (tests/fixtures/advanced/models-antigravity-1.5.0.txt). The line's shape is the advanced setting
 * antigravity.models.line (its id and name as groups), so a change of format can be fixed without a release.
 *
 * The id is what Combwork passes (`--model`) and what dialects match (hooks report it as `modelName`); the display name is
 * for show only and never turned into an id. A line that doesn't match is skipped, and an id of an unexpected shape is
 * kept as it is: an unknown model stays unknown, never guessed.
 */
export function parseModels(text: string, line: RegExp = advanced.pattern('antigravity.models.line')): CatalogModel[] {
  const out: CatalogModel[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const m = new RegExp(line.source, line.flags.replace('g', '')).exec(raw)
    const id = m?.[1]?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = m?.[2]?.trim()
    out.push({ value: id, label: label || id })
  }
  return out
}
