import { useId, useState } from 'react'
import type { PlatformId } from '@shared/platform/descriptors'
import { PLATFORM_NAME } from '@shared/platform/switching'
import { allOff, PRESETS, preset, type OptionKey, type PresetId } from '@shared/workflow/options'
import { optionTitle, PRESET_TEXT } from '@shared/workflow/optionTexts'
import { carriedFor, TEMPLATE_PLATFORMS, templateWorkflowOf, type TemplateWorkflow, type TemplateWorkflows } from '@shared/workflow/templateOptions'
import { msg, tr } from '@shared/i18n'
import { optionValueText } from './WorkflowOptions'
import { droppedText } from './TemplateLoadWorkflow'
import { TabPanel, Tabs } from './Tabs'
import { Icon } from './ui'

const M = {
  head: msg({ id: 'assistant.templates.workflowHead', defaultMessage: 'Workflow', description: "The Templates view (HI-1910): the heading of a template's workflow options, a tab for each version control (None, Git). Glossary: workflow." }),
  platforms: msg({ id: 'assistant.templates.workflowPlatforms', defaultMessage: 'Workflow for', description: "The Templates view (HI-1910): the accessible name of the tabs choosing which version control's workflow (None, Git) a template's section shows." }),
  none: msg({ id: 'assistant.templates.workflowNone', defaultMessage: 'No workflow for {platform}: loading it leaves a {platform} project’s options as they are.', description: "The Templates view (HI-1910): the template has no workflow section for this version control ({platform}: None or Git)." }),
  absent: msg({ id: 'assistant.templates.workflowAbsent', defaultMessage: 'none', description: "The Templates view (HI-1910): a short word after a version control's tab (None, Git) whose workflow section the template doesn't have." }),
  fromPreset: msg({ id: 'assistant.templates.workflowPreset', defaultMessage: '{preset, select, none {Not from a preset.} other {From the preset {name}.}}', description: "The Templates view (HI-1910): which preset a template's workflow section started from ({name}: Solo, Pair, Team), or none. Glossary: preset." }),
  fill: msg({ id: 'assistant.templates.workflowFill', defaultMessage: 'Fill from a preset', description: "The Templates view's template editor (HI-1910): the accessible name of the drop-down that fills this version control's workflow section from a preset (Solo, Pair, Team, All off), its check names kept." }),
  fillChoose: msg({ id: 'assistant.templates.workflowFillChoose', defaultMessage: 'Fill from a preset…', description: "The Templates view's template editor (HI-1910): the drop-down's first entry, before a preset is chosen." }),
  allOff: msg({ id: 'assistant.templates.workflowAllOff', defaultMessage: 'All off', description: "The Templates view's template editor (HI-1910): a drop-down entry filling the workflow section with every check and balance off (as the Workflow section's All off)." }),
  remove: msg({ id: 'assistant.templates.workflowRemove', defaultMessage: 'Remove', description: "The Templates view's template editor (HI-1910): a button removing this version control's workflow section from the template." }),
  editHint: msg({ id: 'assistant.templates.workflowEditHint', defaultMessage: 'To set options one by one, set them in a project’s Version Control → Workflow, then save its agents as a template under this name. A preset fills in its rules here, keeping the check names.', description: "The Templates view's template editor (HI-1910), under the workflow section: how to set individual options (in a project, then Save as Template), and what Fill from a preset does. Glossary: workflow, preset, check." })
}

/** A section's option value in words: the identity as on or off, the rest as the Workflow section says them. */
const valueOf = (key: OptionKey, v: unknown, platform: PlatformId): string => optionValueText(key, key === 'identity' ? !!v : v, platform)

/**
 * A template's workflow (HI-1910): a tab per version control (None, Git), each its section's preset and options, or that
 * it has none; a section that can't be used is said. With `edit` (the template editor): Fill from a preset (its rules,
 * the section's check names kept) and Remove; options one by one are set in a project, then saved as the template.
 */
export function TemplateWorkflowSection({ workflow, dropped, edit }: { workflow: TemplateWorkflows | undefined; dropped?: PlatformId[]; edit?: { disabled: boolean; onChange: (w: TemplateWorkflows) => void } }) {
  const base = useId()
  const [tab, setTab] = useState<PlatformId>(() => (workflow?.git || !workflow?.none ? 'git' : 'none'))
  const set = (p: PlatformId, s: TemplateWorkflow | null): void => {
    const next = { ...workflow }
    if (s) next[p] = s
    else delete next[p]
    edit?.onChange(next)
  }
  const fill = (p: PlatformId, choice: string): void => {
    const was = workflow?.[p]
    const chosen = choice === 'allOff' ? null : (choice as PresetId)
    const s = templateWorkflowOf(chosen ? preset(p, chosen) : allOff(p), chosen)
    // Its check names kept: a preset made for no project names none.
    const names = { ...(was?.options.preChecks ? { preChecks: was.options.preChecks } : {}), ...(p === 'git' && was?.options.mergeChecks ? { mergeChecks: was.options.mergeChecks } : {}) }
    set(p, { ...s, options: { ...s.options, ...names } })
  }
  return (
    <section className="template-workflow-view" data-template-workflow-view="">
      <h3 className="agent-dialog-h">{tr(M.head)}</h3>
      {dropped && dropped.length > 0 && (
        <p className="template-problem" data-workflow-dropped={dropped.join(' ')}>
          <Icon name="warning" /> {droppedText(dropped)}
        </p>
      )}
      <Tabs idBase={base} label={tr(M.platforms)} value={tab} onChange={setTab} items={TEMPLATE_PLATFORMS.map((p) => ({ id: p, label: tr(PLATFORM_NAME[p]), ...(workflow?.[p] ? {} : { tag: tr(M.absent) }), attrs: { 'data-workflow-platform': p } }))} />
      {TEMPLATE_PLATFORMS.map((p) => {
        const s = workflow?.[p]
        const keys = carriedFor(p).filter((k) => s?.options[k] !== undefined)
        return (
          <TabPanel key={p} idBase={base} id={p} selected={tab === p} className="template-workflow-panel" data-workflow-section={p}>
            {s ? (
              <>
                <p className="muted">{tr(M.fromPreset, { preset: s.preset ? 'yes' : 'none', name: s.preset ? tr(PRESET_TEXT[s.preset]) : '' })}</p>
                <ul className="template-workflow-list">
                  {keys.map((k) => {
                    const title = optionTitle(k, p, s.options.folder)
                    return title ? (
                      <li key={k} data-option={k}>
                        <span className="workflow-preview-option">{tr(title)}</span>: <strong>{valueOf(k, s.options[k], p)}</strong>
                      </li>
                    ) : null
                  })}
                </ul>
              </>
            ) : (
              <p className="muted" data-workflow-none={p}>
                {tr(M.none, { platform: tr(PLATFORM_NAME[p]) })}
              </p>
            )}
            {edit && (
              <div className="template-workflow-edit">
                <select className="select" aria-label={tr(M.fill)} disabled={edit.disabled} value="" data-workflow-fill={p} onChange={(e) => e.target.value && fill(p, e.target.value)}>
                  <option value="">{tr(M.fillChoose)}</option>
                  {PRESETS[p].map((x) => (
                    <option key={x.id} value={x.id}>
                      {tr(PRESET_TEXT[x.id])}
                    </option>
                  ))}
                  <option value="allOff">{tr(M.allOff)}</option>
                </select>
                {s && (
                  <button type="button" className="btn small subtle" disabled={edit.disabled} data-workflow-remove={p} onClick={() => set(p, null)}>
                    <Icon name="trash" /> {tr(M.remove)}
                  </button>
                )}
              </div>
            )}
          </TabPanel>
        )
      })}
      {edit && <p className="hint">{tr(M.editHint)}</p>}
    </section>
  )
}
