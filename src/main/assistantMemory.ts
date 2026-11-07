// The Assistant's own memory (HI-2666): what its coding agent saved by itself about working with the user, kept for the
// folder its sessions run in (the workspace's own, sessions.ts's place for the Assistant). Shown in the Assistant view as
// a project's Memory tab shows a project's auto memory, its files read and written through the same file guard. Only a
// CLI whose adapter has `autoMemory` is shown; for another, nothing is said of what it keeps.
import type { AssistantMemory, ProviderId } from '../shared/types'
import { provider as adapterOf } from './providers'

/** The memory `provider` saves for the workspace's folder: its folder and files, or none shown (`folder: null`). */
export async function assistantMemoryFor(workspacePath: string, provider: ProviderId): Promise<AssistantMemory> {
  const adapter = adapterOf(provider)
  if (!adapter.autoMemory) return { provider, folder: null, files: [] }
  const m = await adapter.autoMemory(workspacePath)
  return { provider, folder: m.folder, files: m.files }
}
