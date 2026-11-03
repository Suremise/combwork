import { msg, tr } from '@shared/i18n'
import { formatTime } from '@shared/dates'
import type { SessionEnd } from '@shared/sessionEnd'
import type { AgentInfo } from '@shared/types'
import { projectKey, startingKey, useStore } from './store'

/**
 * A stopped agent's look (HI-1881): its pane dimmed with "Stopped · 20:46 · why" on its bar, its header and tile saying
 * "Stopped · 20:46". One source for all three: the agent's last ended run (sessionEnds), shown only while it is neither
 * running, nor starting (from the accepted click), nor failed to start (its failed bar says so). Presentation only: the
 * agent's state, marks and counts are untouched.
 */

const T = {
  line: msg({
    id: 'panes.stopped.line',
    defaultMessage: 'Stopped · {time} · {why, select, you {stopped by you} assistant {stopped by the Assistant} agent {stopped by an agent} lane {its lane ended} closed {its workspace closed} quit {Combwork quit} exited {its CLI exited} crashed {its CLI exited with code {code}} other {stopped}}',
    description: "The bar over a stopped agent's dimmed pane (HI-1881): when its session ended ({time}: a time of day) and why. {why} is who stopped it (you, the Hive Assistant, an agent, its card loop's lane ending, its workspace closing), Hive quitting, or its CLI ending by itself (cleanly, or with an error code {code}). Keep the · separators."
  }),
  label: msg({ id: 'panes.stopped.label', defaultMessage: 'Stopped · {time}', description: "A stopped agent's status in its pane's header and on its tile (HI-1881): {time} is when its session ended (a time of day)." })
}

/** The agent's last ended run, while it shows as stopped; null while it runs, starts, failed to start, or has none known. */
export function useStoppedEnd(path: string, a: AgentInfo | null): SessionEnd | null {
  return useStore((s) => {
    if (!a || a.live) return null
    if (s.starting[startingKey(path, a.id)]) return null
    const key = projectKey(path, a.id)
    if (s.startFailures[key]) return null
    return s.sessionEnds[key] ?? null
  })
}

/** "Stopped · 20:46 · stopped by you". */
export const stoppedLine = (end: SessionEnd): string => tr(T.line, { time: formatTime(end.at), why: end.why, code: end.code ?? 0 })

/** "Stopped · 20:46", for a header or a tile. */
export const stoppedLabel = (end: SessionEnd): string => tr(T.label, { time: formatTime(end.at) })
