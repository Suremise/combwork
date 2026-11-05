import type { SessionStatus } from '@shared/types'
import { cx } from '../util'

/**
 * The Combwork Assistant's own mark (#399): the workspace's overseer, so it gets a glyph of its own rather than an agent's
 * dot: a hive cell with a crown in it, the queen of the hive (Darren's pick of three). Drawn in the codicons' style
 * (16 px, one colour, `currentColor`). With `status`, it is the Assistant's status icon: the mark in the status's colour
 * (the agents' dot colours), filled while it runs something, outlined while it doesn't, with the agents' status dot as a
 * badge on its corner (the same `dot` classes, so it reads like an agent's status everywhere else, not by colour alone).
 */
export function AssistantMark({ status, unseen, className, title }: { status?: SessionStatus | 'stopped'; unseen?: boolean; className?: string; title?: string }) {
  return (
    <span className={cx('assistant-mark', status && `status-${status}`, className)} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} data-status={status}>
      <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
        <path className="fill" d="M8 1.4 13.7 4.7v6.6L8 14.6 2.3 11.3V4.7z" />
        <path className="line" d="M8 1.4 13.7 4.7v6.6L8 14.6 2.3 11.3V4.7z" />
        <path className="solid" d="M5 10.6 4.7 6.6l1.9 1.5L8 5.5l1.4 2.6 1.9-1.5-.3 4z" />
      </svg>
      {status && <span className={cx('dot', status, unseen && 'unseen')} />}
    </span>
  )
}
