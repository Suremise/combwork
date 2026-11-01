/**
 * Agents finishing together: one chime at a time, and one notification for a burst of finishes instead of a
 * pop-up each. Waiting for input is never grouped or delayed (main/sessions.ts notify()).
 */

import { englishText } from './advanced'
import { fmt, msg, tr, type Msg } from './i18n'
import type { AppSettings } from './types'

/** Where a notice goes: a banner in the focused Hive window, a Windows notification, or nowhere. */
export type NoticeRoute = 'banner' | 'windows' | 'none'

/** The Hive window you are using: the workspace it holds and the project it shows. */
export interface FocusedHive {
  workspacePath: string | null
  projectPath: string | null
}

const samePath = (a: string | null, b: string | null): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** At most one chime this often (per window). */
export const CHIME_GAP_MS = 2000
/** Finishes within this long of the last one are told together. */
export const FINISH_GROUP_MS = 3000
/** A steady stream of finishes is told at least this often. */
export const FINISH_GROUP_MAX_MS = 10_000

/**
 * Where a notice goes now (Settings → Notifications): decided when it happens and again when a group of finishes is
 * shown, since the settings or the focus may have changed while it was collected.
 * - Notifications off, or that kind off: nowhere.
 * - No Hive window focused: a Windows notification.
 * - A Hive window focused (`focused`): per *While Hive is focused*: a banner in that window (Show in Hive), nothing, or
 *   a Windows notification. A banner only for what *Show banners for* covers: every window's notices, the focused
 *   window's workspace's, or the project it shows; one it leaves out shows nothing at all. A notice about no project
 *   (plan usage) is for every scope.
 */
export function noticeRoute(
  n: Pick<AppSettings['notifications'], 'desktopNotifications' | 'notifyOnFinished' | 'notifyOnWaiting' | 'whileFocused' | 'bannerScope'>,
  kind: 'finished' | 'waiting' | 'notice',
  focused: FocusedHive | null,
  from: { workspacePath: string | null; projectPath: string | null }
): NoticeRoute {
  return noticeRouteWhy(n, kind, focused, from).route
}

/** noticeRoute, with why in a few English words for the log (HI-2312: each notice told is traced there). */
export function noticeRouteWhy(
  n: Pick<AppSettings['notifications'], 'desktopNotifications' | 'notifyOnFinished' | 'notifyOnWaiting' | 'whileFocused' | 'bannerScope'>,
  kind: 'finished' | 'waiting' | 'notice',
  focused: FocusedHive | null,
  from: { workspacePath: string | null; projectPath: string | null }
): { route: NoticeRoute; why: string } {
  if (!n.desktopNotifications) return { route: 'none', why: 'notifications off' }
  if (kind === 'finished' && !n.notifyOnFinished) return { route: 'none', why: 'finished notices off' }
  if (kind === 'waiting' && !n.notifyOnWaiting) return { route: 'none', why: 'waiting notices off' }
  if (!focused) return { route: 'windows', why: 'no Hive window focused' }
  if (n.whileFocused === 'nothing') return { route: 'none', why: 'Hive focused, set to show nothing' }
  if (n.whileFocused === 'windows') return { route: 'windows', why: 'Hive focused, set to Windows notifications' }
  if (!from.projectPath && !from.workspacePath) return { route: 'banner', why: 'about no project' }
  if (n.bannerScope === 'workspace' && !samePath(focused.workspacePath, from.workspacePath)) return { route: 'none', why: "banner scope: another workspace's" }
  if (n.bannerScope === 'project' && !samePath(focused.projectPath, from.projectPath)) return { route: 'none', why: "banner scope: another project's" }
  return { route: 'banner', why: `banner scope: ${n.bannerScope}` }
}

/** How many banners show at once (more are behind "+N more"), and how many that close by themselves are kept. */
export const MAX_BANNERS = 4

/**
 * The banners a window keeps, newest first: every one that stays until handled (a waiting agent's, unless set to close
 * like the others), however many, and the newest MAX_BANNERS of the rest. A new notice never pushes out one waiting.
 */
export function keepNotices<T>(newestFirst: readonly T[], staysUntilHandled: (n: T) => boolean, max = MAX_BANNERS): T[] {
  let others = 0
  return newestFirst.filter((n) => staysUntilHandled(n) || others++ < max)
}

export function chimeAllowed(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= CHIME_GAP_MS
}

export interface Finish {
  projectPath: string
  /** The project's folder name, and the agent's name. */
  project: string
  agent: string
  /** The agent's id: a finish whose agent has started its next turn by the time the group is told isn't told (HI-2312). */
  agentId?: string
  /** The notification it would get alone; `apiTitle`, its title in English for the Agent API (#847), when `title` is translated. */
  title: string
  apiTitle?: string
  body: string
}

const IN_PROJECT = msg({ id: 'main.finished.inProject', defaultMessage: '{n, plural, one {# agent finished in {project}} other {# agents finished in {project}}}', description: 'A notification for several agents of one project that finished together. {n} is how many (2 or more); the agents are listed under it.' })
const MANY = msg({ id: 'main.finished.many', defaultMessage: '{n, plural, one {# agent finished} other {# agents finished}}', description: 'A notification for agents of several projects that finished together. {n} is how many (2 or more); the projects are listed under it.' })

/** The title of the notification for finishes that came together (2 or more), formatted by `format`. */
function groupTitle(items: readonly Finish[], format: (m: Msg, values: { n: number; project?: string }) => string): string {
  const projects = new Set(items.map((i) => i.project))
  return projects.size === 1 ? format(IN_PROJECT, { n: items.length, project: items[0].project }) : format(MANY, { n: items.length })
}

/** One notification for finishes that came together: alone as before; else counted, by agent in one project or by project across several. */
export function finishedNotice(items: readonly Finish[]): { title: string; body: string } {
  if (items.length === 1) return { title: items[0].title, body: items[0].body }
  const projects = [...new Set(items.map((i) => i.project))]
  const title = groupTitle(items, (m, values) => tr(m, values as never))
  if (projects.length === 1) return { title, body: fmt.list(items.map((i) => i.agent), 'unit') }
  return {
    title,
    body: fmt.list(projects.map((p) => tr(msg({ id: 'main.finished.project', defaultMessage: '{project} ({n})', description: 'A project in the notification for agents that finished together, with how many of its agents finished.' }), { project: p, n: items.filter((i) => i.project === p).length })), 'unit')
  }
}

/** That notification's title in English, whatever language Hive shows, for the Agent API (#796: agent-facing text stays English). */
export function finishedApiTitle(items: readonly Finish[]): string {
  return items.length === 1 ? (items[0].apiTitle ?? items[0].title) : groupTitle(items, (m, values) => englishText({ m, values: { ...values } }))
}

/**
 * Collects finishes and hands them over together once none has come for FINISH_GROUP_MS (or FINISH_GROUP_MAX_MS
 * after the first, so a stream of them doesn't wait for ever).
 */
export class FinishBatcher {
  private items: Finish[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private firstAt = 0

  constructor(
    private readonly flush: (items: Finish[]) => void,
    private readonly now: () => number = Date.now
  ) {}

  add(item: Finish): void {
    if (!this.items.length) this.firstAt = this.now()
    this.items.push(item)
    if (this.timer) clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(FINISH_GROUP_MS, this.firstAt + FINISH_GROUP_MAX_MS - this.now()))
    this.timer = setTimeout(() => this.send(), wait)
  }

  private send(): void {
    this.timer = null
    const items = this.items
    this.items = []
    if (items.length) this.flush(items)
  }
}
