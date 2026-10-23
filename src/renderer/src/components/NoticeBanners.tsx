import { useEffect, useRef, useState } from 'react'
import { keepNotices, MAX_BANNERS } from '@shared/bursts'
import type { Notice } from '@shared/types'
import { call } from '../api'
import { runCommand } from '../commands'
import { get, set, useStore } from '../store'
import { cx } from '../util'
import { Icon } from './ui'
import { msg, tr } from '@shared/i18n'

const M = {
  more: msg({ id: 'workspace.banners.more', defaultMessage: '+{count} more', description: 'Under the notification banners when more arrived than fit: shows the rest. Keep it short.' }),
  region: msg({ id: 'workspace.banners.region', defaultMessage: 'Notifications', description: 'The notification banners, for screen readers.' }),
  showProject: msg({ id: 'workspace.banners.showProject', defaultMessage: 'Show the project', description: "Tooltip on a notification banner about a project: clicking it shows the project." }),
  showProjectLabel: msg({ id: 'workspace.banners.showProjectLabel', defaultMessage: 'Show the project: {title}', description: "A notification banner's text, for screen readers ({title}: the notification)." }),
  dismiss: msg({ id: 'workspace.banners.dismiss', defaultMessage: 'Dismiss', description: "A notification banner's close button, for screen readers." })
}

/** Stays until clicked, dismissed or answered: a waiting agent's banner, unless set to close like the others. */
const staysUntilHandled = (n: Notice): boolean => n.kind === 'waiting' && (get().settings?.notifications.waitingBannerStays ?? true)

/**
 * A notice for this window's banners (shared/bursts.ts noticeRoute decided it goes here), the newest first. Those that
 * close by themselves give way to new ones; one waiting for you never does (keepNotices).
 */
export function addNotice(n: Notice): void {
  set((s) => ({ notices: keepNotices([n, ...s.notices.filter((x) => x.id !== n.id)], staysUntilHandled) }))
}

export function dismissNotice(id: string): void {
  set((s) => ({ notices: s.notices.filter((x) => x.id !== id) }))
}

/** The agent no longer waits for you: its waiting banner goes. */
export function resolveNotices(projectPath: string, agentId: string): void {
  const same = (n: Notice): boolean => n.kind === 'waiting' && n.agentId === agentId && n.projectPath?.toLowerCase() === projectPath.toLowerCase()
  set((s) => (s.notices.some(same) ? { notices: s.notices.filter((n) => !same(n)) } : {}))
}

/**
 * In-app banners (#157): what would have been a Windows notification while you use Hive, shown in the window you are
 * in, where Settings → Notifications puts them. A finished agent's (and other notices) close after a few seconds, kept
 * while the pointer is on them; a waiting agent's stay until clicked, dismissed or answered (unless set otherwise).
 * Clicking one shows its project, in whichever window has it.
 */
export function NoticeBanners() {
  const notices = useStore((s) => s.notices)
  const position = useStore((s) => s.settings?.notifications.bannerPosition ?? 'top-center')
  // More than fit: the newest show, and "+N more" shows the rest (they stay until handled, never dropped).
  const [expanded, setExpanded] = useState(false)
  const overflow = notices.length > MAX_BANNERS
  useEffect(() => {
    if (!overflow) setExpanded(false)
  }, [overflow])
  if (!notices.length) return null
  const shown = expanded ? notices : notices.slice(0, MAX_BANNERS)
  const more = notices.length - shown.length
  const moreRow = more > 0 && (
    <button className="notice-more" onClick={() => setExpanded(true)}>
      {tr(M.more, { count: more })}
    </button>
  )
  // Nearest the edge first: the newest at the top for banners at the top, at the bottom for those at the bottom.
  const bottom = position.startsWith('bottom')
  const list = bottom ? [...shown].reverse() : shown
  return (
    <div className={cx('notice-banners', `at-${position}`, expanded && overflow && 'expanded')} role="region" aria-label={tr(M.region)}>
      {bottom && moreRow}
      {list.map((n) => (
        <Banner key={n.id} notice={n} />
      ))}
      {!bottom && moreRow}
    </div>
  )
}

function Banner({ notice }: { notice: Notice }) {
  const seconds = useStore((s) => s.settings?.notifications.bannerSeconds ?? 6)
  const waitingStays = useStore((s) => s.settings?.notifications.waitingBannerStays ?? true)
  const stays = notice.kind === 'waiting' && waitingStays
  const [hovered, setHovered] = useState(false)
  // Keyboard focus in it holds it open like the pointer does, so it doesn't close under a keyboard user.
  const [focused, setFocused] = useState(false)
  // Time left before it closes, kept while the pointer (or the focus) is on it.
  const left = useRef(Math.max(1, seconds) * 1000)
  useEffect(() => {
    if (stays || hovered || focused) return
    const started = Date.now()
    const t = window.setTimeout(() => dismissNotice(notice.id), left.current)
    return () => {
      window.clearTimeout(t)
      left.current = Math.max(500, left.current - (Date.now() - started))
    }
  }, [stays, hovered, focused, notice.id])
  const open = (): void => {
    dismissNotice(notice.id)
    void call('notice:open', notice.projectPath).catch(() => undefined)
  }
  const icon = notice.kind === 'waiting' ? 'question' : notice.kind === 'finished' ? 'pass' : 'info'
  const text = (
    <>
      <div className="notice-title">{notice.title}</div>
      {notice.body && <div className="notice-body">{notice.body}</div>}
    </>
  )
  return (
    <div
      className={cx('notice-banner', notice.kind)}
      role={notice.kind === 'waiting' ? 'alert' : 'status'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
      onClick={open}
      title={notice.projectPath ? tr(M.showProject) : undefined}
    >
      <Icon name={icon} className="lead" />
      {/* The text is the project's button for the keyboard (Tab, then Enter or Space; its click reaches the banner's);
          the banner keeps its live role, so it is still announced as it appears. */}
      <div className="notice-main">
        {notice.projectPath ? (
          <button className="notice-text notice-open" aria-label={tr(M.showProjectLabel, { title: notice.title })}>
            {text}
          </button>
        ) : (
          <div className="notice-text">{text}</div>
        )}
        {/* Its button (#1437), under the text: a command of the window's, which closes the banner. */}
        {notice.action && (
          <button
            className="btn small notice-action"
            onClick={(e) => {
              e.stopPropagation()
              dismissNotice(notice.id)
              runCommand(notice.action!.command, ...(notice.action!.args ?? []))
            }}
          >
            {notice.action.label}
          </button>
        )}
      </div>
      <button
        className="icon-btn notice-close"
        aria-label={tr(M.dismiss)}
        onClick={(e) => {
          e.stopPropagation()
          dismissNotice(notice.id)
        }}
      >
        <Icon name="close" />
      </button>
    </div>
  )
}
