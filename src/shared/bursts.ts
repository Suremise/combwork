/**
 * Agents finishing together: one chime at a time, and one notification for a burst of finishes instead of a
 * pop-up each. Waiting for input is never grouped or delayed (main/sessions.ts notify()). Where they go is shared/notify.ts'.
 */

import { englishText } from './advanced'
import { fmt, msg, tr, type Msg } from './i18n'

/** At most one chime this often (per window). */
export const CHIME_GAP_MS = 2000
/** Finishes within this long of the last one are told together. */
export const FINISH_GROUP_MS = 3000
/** A steady stream of finishes is told at least this often. */
export const FINISH_GROUP_MAX_MS = 10_000

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
    private readonly now: () => number = Date.now,
    /** How many wait to be told, each time it changes (HI-2320: a tip waits while any do). */
    private readonly pending: (n: number) => void = () => undefined
  ) {}

  add(item: Finish): void {
    if (!this.items.length) this.firstAt = this.now()
    this.items.push(item)
    this.pending(this.items.length)
    if (this.timer) clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(FINISH_GROUP_MS, this.firstAt + FINISH_GROUP_MAX_MS - this.now()))
    this.timer = setTimeout(() => this.send(), wait)
  }

  /** Takes out the finishes not told yet that `match` picks (HI-2312: their agent started its next turn), and returns them. */
  drop(match: (item: Finish) => boolean): Finish[] {
    const dropped = this.items.filter(match)
    if (!dropped.length) return dropped
    this.items = this.items.filter((i) => !match(i))
    this.pending(this.items.length)
    if (!this.items.length && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    return dropped
  }

  private send(): void {
    this.timer = null
    const items = this.items
    this.items = []
    if (items.length) {
      this.pending(0)
      this.flush(items)
    }
  }
}
