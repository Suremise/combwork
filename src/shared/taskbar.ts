/**
 * The taskbar button when something needs you (For you's count, #1632: the cards' requests and the agents stopped in
 * their panes; never an agent that only finished): a badge over Combwork's icon, the count in
 * the window title (Alt+Tab, hover), and a flash when an agent comes to ask you something while the window
 * isn't focused. Each window shows its own workspace's count.
 */
import { tr } from './i18n'
import { msg } from './i18n/msg'

/** The badge's text: nothing at 0, the number up to 9, then 9+. */
export function badgeText(count: number): string {
  if (count <= 0) return ''
  return count > 9 ? '9+' : String(count)
}

/** The window's title, prefixed with the count when there is one: "(2) alpha — work — Combwork". */
export function windowTitle(title: string, count: number): string {
  return count > 0 ? `(${count}) ${title}` : title
}

const NEED_YOU = msg({ id: 'workspace.taskbar.needYou', defaultMessage: '{count, plural, one {# needs you} other {# need you}}', description: "What the taskbar badge over Combwork's icon says to screen readers: how many things wait for you (requests on cards and agents stopped at a prompt, a sign-in, a question or an error). Keep it short." })

/** What the badge says to screen readers. */
export function badgeDescription(count: number): string {
  return tr(NEED_YOU, { count })
}

/**
 * Whether a change should flash the taskbar button: an agent comes to ask you something (asksYou: it waits for an
 * answer, or a question appears) while the window isn't focused.
 */
export function shouldFlash(askedBefore: boolean, askedNow: boolean, windowFocused: boolean, enabled: boolean): boolean {
  return enabled && !windowFocused && askedNow && !askedBefore
}
