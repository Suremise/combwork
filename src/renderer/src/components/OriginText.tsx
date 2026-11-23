import { tr } from '@shared/i18n'
import type { PlatformId } from '@shared/platform/descriptors'
import type { FormTabId, OptionKey } from '@shared/workflow/options'
import { ORIGIN_TEXT } from '../workflowOrigins'
import { showWorkflowDefaults } from '../store'

/**
 * Where a workflow option's or a slot default's value comes from, in words; "From Combwork defaults" and "From the
 * workspace" link to their tab of Settings → Version Control (HI-1837), where that value is set: with `at` (HI-3549), at
 * that option (or tab) of the level's form for its platform.
 */
export function OriginText({ origin, at }: { origin: keyof typeof ORIGIN_TEXT; at?: { key: OptionKey | FormTabId; platform: PlatformId } }) {
  const text = tr(ORIGIN_TEXT[origin])
  if (origin !== 'global' && origin !== 'workspace') return <>{text}</>
  return (
    <button type="button" className="workflow-origin-link" data-origin-link={origin} onClick={() => showWorkflowDefaults(origin, at)}>
      {text}
    </button>
  )
}
