import { access } from 'original-fs/promises'
import { join } from 'path'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { createDelivery } from './deliveries'
import { workspaceOf } from './workspace'
import { CW_DIR } from '../shared/defaults'

/**
 * Hive's notes to a workspace's Assistant about its agents (HI-1612's resumes, HI-1973's retry waits): lines gathered for
 * a few seconds, so agents in the same trouble come in one control delivery, then what the user can change about it. Its
 * inbox is agent-facing: English. Nothing is sent where the workspace has no Assistant set up yet.
 */
const HIVE = { kind: 'hive', name: 'Combwork' } as const // i18n-ignore: the product's name, as a delivery's sender
const GATHER_MS = 5000

const gathered = new Map<string, { lines: string[]; timer: ReturnType<typeof setTimeout> }>()

/** A line for the Assistant of `projectPath`'s workspace, sent with the others gathered under the same `after`. */
export function noteForAssistant(projectPath: string, line: string, after: string): void {
  const home = workspaceOf(projectPath).assistantHome
  const k = `${home.toLowerCase()}\n${after}`
  const was = gathered.get(k)
  if (was) {
    was.lines.push(line)
    return
  }
  const timer = setTimeout(() => {
    const lines = gathered.get(k)?.lines ?? []
    gathered.delete(k)
    void access(join(home, CW_DIR, 'project.json'))
      .then(() => createDelivery(home, { agentId: ASSISTANT_AGENT_ID, kind: 'control', from: HIVE, body: `${lines.join(' ')} ${after}` }))
      .catch(() => undefined)
  }, GATHER_MS)
  timer.unref?.()
  gathered.set(k, { lines: [line], timer })
}
