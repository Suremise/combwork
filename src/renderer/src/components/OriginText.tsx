import { tr } from '@shared/i18n'
import { ORIGIN_TEXT } from '../workflowOrigins'
import { showWorkflowDefaults } from '../store'

/**
 * Where a workflow option's or a slot default's value comes from, in words; "From Hive defaults" and "From the
 * workspace" link to their tab of Settings → Version Control (HI-1837), where that value is set.
 */
export function OriginText({ origin }: { origin: keyof typeof ORIGIN_TEXT }) {
  const text = tr(ORIGIN_TEXT[origin])
  if (origin !== 'global' && origin !== 'workspace') return <>{text}</>
  return (
    <button type="button" className="workflow-origin-link" data-origin-link={origin} onClick={() => showWorkflowDefaults(origin)}>
      {text}
    </button>
  )
}
