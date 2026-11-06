import { englishText, type Text } from '../shared/advanced'
import { msg, tr } from '../shared/i18n'
import { asksYou } from '../shared/inbox'
import { emit, onCombworkEvent } from './events'
import { resolveAsks } from './notify'

const CLOSED = msg({ id: 'main.quit.closed', defaultMessage: 'Combwork has closed', description: 'A notice after Combwork quit without asking, its sessions stopped.' })
const CLOSED_BODY = msg({ id: 'main.quit.closedBody', defaultMessage: '{n, plural, one {# session was stopped. Resume it from Combwork next time; nothing was lost.} other {# sessions were stopped. Resume them from Combwork next time; nothing was lost.}}', description: 'The notice after Combwork quit: how many sessions it stopped.' })

/** The notice after Combwork quit without asking: in the language shown, its title in English for the Agent API too. */
export function closedNotice(stopped: number): { title: string; body: string; apiTitle: string; apiTitleText: Text } {
  // agent-stored: agentField says the events stream's title again in each caller's dialect, from apiTitleText (apiEvents.ts, HI-2465)
  return { title: tr(CLOSED), body: tr(CLOSED_BODY, { n: stopped }), apiTitle: englishText(CLOSED), apiTitleText: CLOSED }
}

const ANSWERED = msg({ id: 'main.notify.answered', defaultMessage: 'Answered', description: "What a notification that an agent waited for you (or asked you something) says once it no longer does (HI-2320): answered, or it moved on. Shown under its title, in the pop-up and the bell's list. Keep it short." })
const ENDED = msg({ id: 'main.notify.sessionEnded', defaultMessage: 'Its session ended', description: "What a notification that an agent waited for you says once its session has ended (HI-2320), so it no longer waits. Shown under its title, in the pop-up and the bell's list. Keep it short." })

/**
 * An agent waiting for you is told once per ask, as its own offer (main/notify.ts askOffer): once it no longer asks
 * (answered, or it moved on, stopped or ended), its entries say so and lose any button, in whichever window owns them
 * (HI-2320), and the Agent API's stream hears `notice-resolved` as before. Returns the unsubscribe.
 */
export function startNoticeResolver(): () => void {
  const asking = new Set<string>()
  const key = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`
  return onCombworkEvent((e) => {
    if (e.type === 'session-status') {
      const k = key(e.state.projectPath, e.state.agentId)
      if (asksYou(e.state)) asking.add(k)
      else if (asking.delete(k)) {
        resolveAsks(e.state.projectPath, e.state.agentId, tr(ANSWERED))
        emit({ type: 'notice-resolved', projectPath: e.state.projectPath, agentId: e.state.agentId })
      }
    } else if (e.type === 'session-exit') {
      if (asking.delete(key(e.projectPath, e.agentId))) {
        resolveAsks(e.projectPath, e.agentId, tr(ENDED))
        emit({ type: 'notice-resolved', projectPath: e.projectPath, agentId: e.agentId })
      }
    }
  })
}
