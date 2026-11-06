import type { AgentInfo, ProjectInfo } from '../shared/types'
import { combworkName, safeWord, type ConsoleSource } from '../shared/devConsole'
import { maskText } from '../shared/redact'
import { ASSISTANT_NAME } from '../shared/assistant'
import { APP_NAME } from '../shared/appName'
import { devConsole, combworkSourceId, sessionSourceId } from './devConsole'
import { onCombworkEvent } from './events'
import { publicRun } from './apiEvents'
import type { WorkspaceService } from './workspace'

/**
 * The developer console's sources in a workspace (#636): each of its projects' agents, its Assistant, and Combwork itself;
 * an agent is a source whether it runs or not, so capture can start before it launches.
 */
export function consoleSources(ws: WorkspaceService): ConsoleSource[] {
  const info = ws.info()
  const wsPath = ws.path
  if (!info || !wsPath) return []
  const row = (p: ProjectInfo, a: AgentInfo, kind: 'session' | 'assistant'): ConsoleSource => {
    const id = sessionSourceId(p.path, a.id)
    return { id, kind, label: kind === 'assistant' ? ASSISTANT_NAME : maskText(`${p.name} · ${a.name}`), workspacePath: wsPath, projectPath: p.path, project: p.name, agentId: a.id, agent: a.name, provider: a.live?.provider ?? a.provider, capturing: devConsole.capturing(id), events: devConsole.count(id) }
  }
  const rows = info.projects.flatMap((p) => p.agents.map((a) => row(p, a, 'session')))
  if (info.assistant) rows.push(...info.assistant.agents.map((a) => row(info.assistant!, a, 'assistant')))
  const combwork = combworkSourceId(wsPath)
  rows.push({ id: combwork, kind: 'combwork', label: APP_NAME, workspacePath: wsPath, capturing: devConsole.capturing(combwork), events: devConsole.count(combwork) }) // the app's name (HI-2511), as the source of its own events
  return rows
}

/** Each run as last captured, per workspace's Combwork source: Progress changes often, and only a run's step or state counts. */
const runsSeen = new Map<string, Map<string, string>>()

/** Combwork's own events the console takes from Combwork's event bus: Progress runs as they start, step on and end. */
export function initDevConsole(): void {
  onCombworkEvent((e) => {
    if (e.type !== 'progress-changed') return
    const source = combworkSourceId(e.workspacePath)
    if (!devConsole.capturing(source)) {
      runsSeen.delete(source)
      return
    }
    const seen = runsSeen.get(source) ?? new Map<string, string>()
    runsSeen.set(source, seen)
    for (const r of e.runs) {
      const sig = `${r.state}|${r.step}|${r.total}|${r.waiting !== null}`
      if (seen.get(r.id) === sig) continue
      seen.set(r.id, sig)
      const pub = publicRun(r)
      // Its title stays in the payload (hidden there unless text is included): a reporter's title is still someone's text.
      devConsole.capture([source], () => ({ kind: 'progress', name: safeWord(r.state), raw: pub, made: { state: r.state, step: r.step, total: r.total, waiting: r.waiting !== null }, safe: { raw: { id: true, agentId: true, agentName: true, provider: true, source: true, state: true, staleReason: true, stopReason: true }, made: { state: true } }, summary: `progress run by ${combworkName(r.agentName)} → ${safeWord(r.state)}${typeof r.total === 'number' ? ` ${Number(r.step) || 0}/${r.total}` : ''}` })) // i18n-ignore: the developer console's event data, recorded like a log, stays English (#1104)
    }
    // Runs no longer listed are forgotten (the panel's list is bounded, so is this).
    const ids = new Set(e.runs.map((r) => r.id))
    for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id)
  })
}
