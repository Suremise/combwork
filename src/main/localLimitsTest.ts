import type { ServerCaps } from '../shared/providers'
import { staticSupport } from '../shared/localModelLimits'
import { advanced } from './advanced'

/**
 * HI-2682: why a model ID alone rules out a local model's limits on this CLI (its advanced patterns as set now: an alias,
 * or a spelling it sizes itself); null for a CLI that takes no such limits.
 */
export function localLimitsTest(caps: ServerCaps): ((id: string) => 'alias' | 'spelling' | null) | null {
  const l = caps.localLimits
  if (!l) return null
  const alias = advanced.pattern(l.aliasSetting)
  const spelling = advanced.pattern(l.spellingSetting)
  return (id) => staticSupport(id, alias, spelling)
}
