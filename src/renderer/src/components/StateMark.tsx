import { createRoot } from 'react-dom/client'
import { AGENT_STATE_LABEL, AGENT_STATES, type AgentState } from '@shared/agentState'
import { tr } from '@shared/i18n'
import { cx } from '../util'

/**
 * An agent's state mark (#973): a diamond (waiting for you), a square (stalled), a pulsing dot (working, still under
 * reduced motion) or a ring (idle), in the theme's state colours. Shape carries the state as well as colour. Named by
 * its state for screen readers (or by `label`, a fuller status), or hidden from them where text beside it says it.
 */
export function StateMark({ state, label, decorative, className }: { state: AgentState; label?: string; decorative?: boolean; className?: string }) {
  if (decorative) return <span className={cx('state-mark', state, className)} aria-hidden="true" />
  return <span className={cx('state-mark', state, className)} role="img" aria-label={label ?? tr(AGENT_STATE_LABEL[state])} />
}

/**
 * For tests (the statemarks suite): the four marks with their names, in a box of their own over the window, until the
 * returned function removes it.
 */
;(window as unknown as { __cwStateMarks?: () => () => void }).__cwStateMarks = () => {
  const box = document.createElement('div')
  box.className = 'state-mark-gallery'
  document.body.appendChild(box)
  const root = createRoot(box)
  root.render(
    <>
      {AGENT_STATES.map((s) => (
        <span key={s} className={cx('state-mark-sample', s)}>
          <StateMark state={s} />
          <span aria-hidden="true">{tr(AGENT_STATE_LABEL[s])}</span>
        </span>
      ))}
    </>
  )
  return () => {
    root.unmount()
    box.remove()
  }
}
