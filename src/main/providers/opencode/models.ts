import type { CatalogModel } from '../../../shared/types'
import { isClaudeAgentModel, isOpencodeModelId, opencodeModelLabel } from '../../../shared/opencode'
import { advanced } from '../../advanced'

/**
 * The account's models from `opencode models` (HI-2759, 2.2.6): one `provider/model` id a line
 * (tests/fixtures/advanced/models-opencode-2.2.6.txt). The line's shape is the advanced setting opencode.models.line (the
 * id its first group), so a change of format can be fixed without a release.
 *
 * Unknown-safe (HI-2523): the id is what Combwork passes and dialects match, never derived from a label; an id of an
 * unexpected shape is skipped, never guessed. Claude Agent's models are never listed (isClaudeAgentModel).
 */
export function parseOpencodeModels(text: string, line: RegExp = advanced.pattern('opencode.models.line')): CatalogModel[] {
  const out: CatalogModel[] = []
  const seen = new Set<string>()
  const re = new RegExp(line.source, line.flags.replace('g', ''))
  for (const raw of text.split(/\r?\n/)) {
    const id = re.exec(raw)?.[1]?.trim()
    if (!id || seen.has(id) || !isOpencodeModelId(id) || isClaudeAgentModel(id)) continue
    seen.add(id)
    out.push({ value: id, label: opencodeModelLabel(id) })
  }
  return out
}
