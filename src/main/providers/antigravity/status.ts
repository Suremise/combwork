import type { LiveDetails } from '../types'

/**
 * What agy's status line says of the session (its status-line docs; 1.5.0's recorded in HI-2545): the model by its name
 * (its `id` is a display name too, HI-2544: never matched as an id), its effort and the context window. Its tokens come
 * from the transcript (transcript.ts), which has each request's; agy publishes no prices, so there is no cost to show.
 */
export function agyStatusDetails(body: Record<string, any>): LiveDetails {
  const d: LiveDetails = {}
  const model = body?.model
  if (model && typeof model === 'object') {
    if (typeof model.display_name === 'string' && model.display_name) d.modelName = model.display_name
    if (typeof model.effort === 'string' && model.effort) d.effort = model.effort
  }
  const size = Number(body?.context_window?.context_window_size)
  if (Number.isFinite(size) && size > 0) d.contextWindow = size
  return d
}
