import { agentMsg, say } from '../agentText'
import { msg, type Msg } from '../i18n/msg'
import type { ProviderId } from '../types'
import { providerDescriptor, providerModule } from '.'

/**
 * What a provider's CLI can't do in Combwork, said plainly (HI-3196): a data-only provider (its description, no adapter
 * of its own) has no hooks, transcript or usage, takes none of Combwork's tools or skills, and resumes and switches modes
 * only as its description says. A full provider has none of these gaps. Provider Setup and Agent Settings show them in
 * the window's words; the Agent API's provider listing names them in English.
 */
export type ProviderGap = 'tools' | 'hooks' | 'transcript' | 'cost' | 'resume' | 'liveMode'

export const PROVIDER_GAP_TEXT: Record<ProviderGap, Msg> = {
  tools: msg({ id: 'providers.gap.tools', defaultMessage: 'No Combwork tools, skills or guidance: no board, no inbox', description: 'What a CLI that runs from a description lacks (HI-3196), in a list under it in Provider Setup and Agent Settings.' }),
  hooks: msg({ id: 'providers.gap.hooks', defaultMessage: 'No hooks: no file locks or notices in its turns; its status is read from its screen', description: 'What a CLI that runs from a description lacks (HI-3196), in a list under it in Provider Setup and Agent Settings.' }),
  transcript: msg({ id: 'providers.gap.transcript', defaultMessage: 'No transcript: no conversation view, usage or context gauge', description: 'What a CLI that runs from a description lacks (HI-3196), in a list under it in Provider Setup and Agent Settings.' }),
  cost: msg({ id: 'providers.gap.cost', defaultMessage: 'No cost: Combwork has no prices for it', description: 'What a CLI that runs from a description lacks (HI-3196), in a list under it in Provider Setup and Agent Settings.' }),
  resume: msg({ id: 'providers.gap.resume', defaultMessage: 'No resume: a stopped session starts a new conversation', description: 'What a CLI that runs from a description lacks (HI-3196), when its description has no way to resume, in a list under it.' }),
  liveMode: msg({ id: 'providers.gap.liveMode', defaultMessage: 'No live mode switch: a restart changes its permission mode', description: 'What a CLI that runs from a description lacks (HI-3196), in a list under it in Provider Setup and Agent Settings.' })
}

/** The same, as agents and the Agent API read it (English, said in the reader's dialect). */
const AGENT: Record<ProviderGap, ReturnType<typeof agentMsg>> = {
  tools: agentMsg({ id: 'provider.gap.tools', text: 'no Combwork tools, skills or guidance (no board or inbox)', note: 'In the Agent API provider listing (HI-3196): what a CLI that runs from a description lacks, one item of a list.' }),
  hooks: agentMsg({ id: 'provider.gap.hooks', text: 'no hooks (no file locks or notices; status read from its screen)', note: 'In the Agent API provider listing (HI-3196): what a CLI that runs from a description lacks, one item of a list.' }),
  transcript: agentMsg({ id: 'provider.gap.transcript', text: 'no transcript (no conversation view, usage or context)', note: 'In the Agent API provider listing (HI-3196): what a CLI that runs from a description lacks, one item of a list.' }),
  cost: agentMsg({ id: 'provider.gap.cost', text: 'no cost (no prices)', note: 'In the Agent API provider listing (HI-3196): what a CLI that runs from a description lacks, one item of a list.' }),
  resume: agentMsg({ id: 'provider.gap.resume', text: 'no resume (a stopped session starts a new conversation)', note: 'In the Agent API provider listing (HI-3196): what a CLI that runs from a description lacks, one item of a list.' }),
  liveMode: agentMsg({ id: 'provider.gap.liveMode', text: 'no live mode switch (a restart changes its mode)', note: 'In the Agent API provider listing (HI-3196): what a CLI that runs from a description lacks, one item of a list.' })
}

/** What a provider's CLI lacks, in this order; none for a full provider or one this version doesn't know. */
export function providerGaps(id: ProviderId): ProviderGap[] {
  const m = providerModule(id)
  if (!m?.cli) return []
  const caps = providerDescriptor(id).capabilities
  const gaps: ProviderGap[] = []
  if (caps.session?.combworkTools === false) gaps.push('tools')
  gaps.push('hooks', 'transcript', 'cost')
  if (!m.cli.session) gaps.push('resume')
  if (!caps.modes?.liveModeSwitch || caps.modes.liveModeSwitch === 'none') gaps.push('liveMode')
  return gaps
}

/** A provider's gaps as agents read them (the Agent API's provider listing: `gaps`). */
export const providerGapsForAgents = (id: ProviderId): string[] => providerGaps(id).map((g) => say(AGENT[g]))
