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

/** A variant id Combwork passes as an effort (HI-2767): a short plain id, never one it would have to quote or escape. */
export const isVariantId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][\w.-]{0,39}$/.test(id)
/** At most this many variants a model, and models a listing: a bound on what a reply can make Combwork hold. */
const MAX_VARIANTS = 32
const MAX_MODELS = 5000

/**
 * The account's models with their variants, from `opencode api GET /api/model` (HI-2767, 2.2.6: `opencode models` is the
 * same call printed as provider/model; tests/fixtures/advanced/models-api-opencode-2.2.6.json). Each model's variants
 * (the advanced setting opencode.models.variants, each its opencode.models.variantId) are its effort levels: those of a
 * safe id shape, at most MAX_VARIANTS; a model listing none takes none ([]). Null when the reply isn't such a listing, so
 * the caller falls back to `opencode models` (no efforts: none is invented). The same id rules as parseOpencodeModels.
 */
export function parseOpencodeModelsApi(text: string, fields: { variants: string; variantId: string } = { variants: advanced.get<string>('opencode.models.variants'), variantId: advanced.get<string>('opencode.models.variantId') }): CatalogModel[] | null {
  let data: unknown
  try {
    data = (JSON.parse(text) as { data?: unknown })?.data
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null
  const out: CatalogModel[] = []
  const seen = new Set<string>()
  for (const m of data.slice(0, MAX_MODELS)) {
    if (!m || typeof m !== 'object') continue
    const { providerID, id } = m as { providerID?: unknown; id?: unknown }
    if (typeof providerID !== 'string' || typeof id !== 'string') continue
    const value = `${providerID}/${id}`
    if (seen.has(value) || !isOpencodeModelId(value) || isClaudeAgentModel(value)) continue
    seen.add(value)
    const listed = (m as Record<string, unknown>)[fields.variants]
    const efforts = Array.isArray(listed) ? [...new Set(listed.map((v) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[fields.variantId] : undefined)).filter(isVariantId))].slice(0, MAX_VARIANTS) : []
    out.push({ value, label: opencodeModelLabel(value), efforts })
  }
  return out
}
