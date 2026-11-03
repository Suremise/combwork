import type { TemplateLoadWorkflow } from '@shared/types'
import { fmt, msg, tr } from '@shared/i18n'
import { PLATFORM_NAME } from '@shared/platform/switching'
import { optionTitle } from '@shared/workflow/optionTexts'
import { optionValueText } from './WorkflowOptions'
import { Icon } from './ui'

const M = {
  head: msg({ id: 'assistant.templateWorkflow.head', defaultMessage: 'Workflow', description: "The Load template dialog (HI-1910): the heading of the part about the template's workflow options. Glossary: workflow." }),
  apply: msg({ id: 'assistant.templateWorkflow.apply', defaultMessage: 'Also apply its workflow (Version Control → Workflow opens with it filled in, to save there)', description: "A tick box in the Load template dialog (HI-1910), ticked by default: after loading the agents, the project's Version Control tab opens at Workflow with the template's options filled in but not saved. Glossary: workflow." }),
  changes: msg({ id: 'assistant.templateWorkflow.changes', defaultMessage: '{n, plural, =0 {Its workflow for {platform} matches this project’s options.} one {Its workflow for {platform} changes # option:} other {Its workflow for {platform} changes # options:}}', description: "The Load template dialog (HI-1910): how many of the project's workflow options the template's would change ({n}); the list follows. {platform}: None or Git, as Hive names them." }),
  change: msg({ id: 'assistant.templateWorkflow.change', defaultMessage: '{option}: {now} → {next}', description: "The Load template dialog (HI-1910): a workflow option ({option}, its title) with its value now ({now}) and the template's ({next})." }),
  noCommand: msg({ id: 'assistant.templateWorkflow.noCommand', defaultMessage: '{count, plural, one {This project has no command for the check {checks}: add it in Version Control → Workflow before cards need it.} other {This project has no commands for the checks {checks}: add them in Version Control → Workflow before cards need them.}}', description: "The Load template dialog (HI-1910): the template's workflow names checks ({checks}, a list of names; {count} of them) this project has no command for. A template keeps check names, never commands. Glossary: check." }),
  identityOff: msg({ id: 'assistant.templateWorkflow.identityOff', defaultMessage: 'It turns the project identity on, but this project’s git config has no name and email, so it stays off.', description: "The Load template dialog (HI-1910): the template's workflow has the project identity on (G12: commits as the repository's identity), but this project's git config has none. Glossary: identity." }),
  needsGit: msg({ id: 'assistant.templateWorkflow.needsGit', defaultMessage: 'Its workflow is for Git, and this project has no version control yet. Set up Git first, or untick the box above to load only its agents.', description: "The Load template dialog (HI-1910): the template has only a Git workflow and the project has no version control. Set up Git… is the button beside it. Glossary: workflow." }),
  setUpGit: msg({ id: 'assistant.templateWorkflow.setUpGit', defaultMessage: 'Set Up Git…', description: "A button in the Load template dialog (HI-1910): closes it and opens the project's Version Control tab on Git's page, with Initialise repository…; once Git is set up, the dialog opens again. The … says another step follows: keep it." }),
  alsoGit: msg({ id: 'assistant.templateWorkflow.alsoGit', defaultMessage: 'It has a workflow for Git too, used once this project uses Git.', description: "The Load template dialog (HI-1910): a project with no version control loads the template's None workflow; it also has a Git one." }),
  noSection: msg({ id: 'assistant.templateWorkflow.noSection', defaultMessage: 'It has no workflow for {platform}, so this project’s options stay as they are.', description: "The Load template dialog (HI-1910): the template's workflow sections don't include the project's version control ({platform}: None or Git)." }),
  dropped: msg({ id: 'assistant.templateWorkflow.dropped', defaultMessage: '{count, plural, one {Its workflow for {platforms} can’t be used (made by another version of Combwork, or changed by hand), so it isn’t applied.} other {Its workflows for {platforms} can’t be used (made by another version of Combwork, or changed by hand), so they aren’t applied.}}', description: "The Load template dialog and the Templates view (HI-1910): the template's workflow sections for {platforms} (None, Git: a list; {count} of them) have values Hive can't use, so they are left out." })
}

/** Why the Load button waits for the workflow (HI-1910): a Git-only workflow, ticked, in a project with no version control. */
export const workflowBlocks = (w: TemplateLoadWorkflow | null, apply: boolean): string | null => (w?.needsGit && apply ? tr(M.needsGit) : null)

/** The dropped sections' note (the Templates view says it too). */
export const droppedText = (platforms: readonly ('none' | 'git')[]): string => tr(M.dropped, { count: platforms.length, platforms: fmt.list(platforms.map((p) => tr(PLATFORM_NAME[p]))) })

/**
 * The Load template dialog's Workflow part (HI-1910): whether to apply the template's workflow (ticked), and what it
 * changes in this project, each option now and with it; check names it has no command for, an identity it can't turn on;
 * a Git-only workflow in a project with no version control waits for Git (Set Up Git…); a section that can't be used is
 * said, never applied. Nothing is saved here: the Workflow form opens with it, to save there.
 */
export function TemplateLoadWorkflowPart({ workflow, apply, onApply, onSetUpGit }: { workflow: TemplateLoadWorkflow; apply: boolean; onApply: (v: boolean) => void; onSetUpGit: () => void }) {
  const w = workflow
  const platform = tr(PLATFORM_NAME[w.platform])
  const o = w.overlay
  const canApply = !!o || w.needsGit
  return (
    <section className="template-workflow" data-template-workflow={w.platform}>
      <h4 className="template-workflow-h">{tr(M.head)}</h4>
      {w.dropped.length > 0 && (
        <p className="template-plan-note" data-workflow-dropped={w.dropped.join(' ')}>
          <Icon name="warning" /> {droppedText(w.dropped)}
        </p>
      )}
      {!canApply && w.sections.length > 0 && <p className="template-plan-note" data-workflow-none="">{tr(M.noSection, { platform })}</p>}
      {canApply && (
        <label className="flex template-workflow-apply">
          <input type="checkbox" checked={apply} data-workflow-apply="" onChange={(e) => onApply(e.target.checked)} /> {tr(M.apply)}
        </label>
      )}
      {w.needsGit && apply && (
        <div className="banner warn template-workflow-git" data-workflow-needs-git="">
          <Icon name="warning" />
          <span>{tr(M.needsGit)}</span>
          <button type="button" className="btn small" data-action="template-set-up-git" onClick={onSetUpGit}>
            {tr(M.setUpGit)}
          </button>
        </div>
      )}
      {o && apply && (
        <>
          <p className="template-plan-note" data-workflow-changes={o.changes.length}>
            {tr(M.changes, { n: o.changes.length, platform })}
          </p>
          {o.changes.length > 0 && (
            <ul className="template-workflow-list">
              {o.changes.map((c) => {
                const title = optionTitle(c.key, w.platform, o.options.folder)
                return title ? (
                  <li key={c.key} data-option={c.key}>
                    {tr(M.change, { option: tr(title), now: optionValueText(c.key, c.now, w.platform), next: optionValueText(c.key, c.next, w.platform) })}
                  </li>
                ) : null
              })}
            </ul>
          )}
          {o.missingCommands.length > 0 && (
            <p className="template-plan-note warn" data-workflow-no-command={o.missingCommands.join(' ')}>
              <Icon name="warning" /> {tr(M.noCommand, { count: o.missingCommands.length, checks: fmt.list(o.missingCommands) })}
            </p>
          )}
          {o.identityOff && <p className="template-plan-note" data-workflow-identity-off="">{tr(M.identityOff)}</p>}
        </>
      )}
      {w.alsoGit && <p className="template-plan-note faint" data-workflow-also-git="">{tr(M.alsoGit)}</p>}
    </section>
  )
}
