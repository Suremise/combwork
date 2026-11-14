import { msg, type Msg } from '../i18n/msg'
import type { EffortLevel } from '../types'

/**
 * What several providers' shared halves use (HI-3201): a leaf module, so a provider's module takes it without importing
 * another provider's, and without a cycle through the registry.
 */

/**
 * Effort levels' names in the window's words (#800), every provider's: the descriptors' effortLevels keep the English
 * for agents and the Agent API.
 */
export const EFFORT_TEXT = {
  none: msg({ id: 'agents.efforts.none', defaultMessage: 'None', description: 'An effort level (how hard the model thinks) in the effort picker: no reasoning. Keep it short.' }),
  minimal: msg({ id: 'agents.efforts.minimal', defaultMessage: 'Minimal', description: 'An effort level (how hard the model thinks) in the effort picker. Keep it short.' }),
  low: msg({ id: 'agents.efforts.low', defaultMessage: 'Low', description: 'An effort level (how hard the model thinks) in the effort picker. Keep it short.' }),
  medium: msg({ id: 'agents.efforts.medium', defaultMessage: 'Medium', description: 'An effort level (how hard the model thinks) in the effort picker. Keep it short.' }),
  high: msg({ id: 'agents.efforts.high', defaultMessage: 'High', description: 'An effort level (how hard the model thinks) in the effort picker. Keep it short.' }),
  xhigh: msg({ id: 'agents.efforts.xhigh', defaultMessage: 'Extra high', description: 'An effort level (how hard the model thinks) in the effort picker, between High and Max. Keep it short.' }),
  max: msg({ id: 'agents.efforts.max', defaultMessage: 'Max', description: 'The highest effort level (how hard the model thinks) of most models, in the effort picker. Keep it short.' }),
  ultra: msg({ id: 'agents.efforts.ultra', defaultMessage: 'Ultra', description: "Codex's effort level above Max (how hard the model thinks), in the effort picker. Keep it short." })
}

/**
 * A descriptor's effort levels: these, in this order, each with its English name (agents and the Agent API read it: the
 * message's own English) and its name in the window's words.
 */
export const effortLevels = (...values: (keyof typeof EFFORT_TEXT)[]): { value: EffortLevel; label: string; text: Msg }[] => values.map((v) => ({ value: v, label: EFFORT_TEXT[v].defaultMessage, text: EFFORT_TEXT[v] }))

/** The model pickers' group of older models, every provider's (#800). */
export const OLDER_VERSIONS = msg({ id: 'agents.models.olderGroup', defaultMessage: 'Older versions', description: 'A group of the model picker: earlier models, hidden until shown.' })

/** An OpenAI model's name: "gpt-6-luna" → "GPT-6 Luna", "gpt-5.6-terra" → "GPT-5.6 Terra"; anything else as it is. */
export function gptModelLabel(model: string): string {
  const m = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(model.trim())
  if (!m) return model
  const rest = (m[2] ?? '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
  return `GPT-${m[1]}${rest ? ` ${rest}` : ''}`
}
