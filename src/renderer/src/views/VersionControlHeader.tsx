import { useEffect, useState } from 'react'
import type { ProjectInfo, WorkflowForm } from '@shared/types'
import type { PlatformId, ProjectPlatform } from '@shared/platform/descriptors'
import { FORM_OPTIONS } from '@shared/workflow/options'
import { PRESET_TEXT } from '@shared/workflow/optionTexts'
import { msg, tr, type Msg } from '@shared/i18n'
import { call } from '../api'
import { showVersionControl, useLanguage } from '../store'
import { cx } from '../util'
import { Icon, Tooltip } from '../components/ui'

/**
 * The top of the Version Control tab (#1416, SPEC §16.6 and §16.3.5): the project's version control as a None · Git
 * choice, what Hive finds in its folder, and "Workflow: Git · Team", which opens the Workflow section. The choice shows
 * the recorded platform only: Hive never switches it silently, and offers a switch when it detects another (#1419).
 */

/** The tab's words (the board's workflow link, #1420, says it as the tab does). */
export const M = {
  choice: msg({ id: 'git.vc.choice', defaultMessage: 'Version control', description: 'Accessible name of the None · Git choice atop the Version Control tab (glossary 2.1: version control).' }),
  none: msg({ id: 'git.vc.none', defaultMessage: 'None', description: 'The version control of a project without any, in the choice atop the Version Control tab and in "Workflow: None · Solo" (glossary 2.1: None).' }),
  git: msg({ id: 'git.vc.git', defaultMessage: 'Git', description: 'A version control system’s name, in the choice atop the Version Control tab (glossary 2.1: keep).' }),
  otherTip: msg({ id: 'git.vc.otherTip', defaultMessage: 'Hive detects the version control in this folder. When it finds a different one, it offers to switch.', description: 'Tooltip of the version control not in use, in the None · Git choice atop the Version Control tab (disabled: Hive offers the switch itself).' }),
  repo: msg({ id: 'git.vc.fact.repo', defaultMessage: 'This folder is a Git repository at {root}.', description: 'Atop the Version Control tab: what Hive found in the project folder. {root} is the repository root (glossary 2.1: repository root).' }),
  subfolder: msg({ id: 'git.vc.fact.subfolder', defaultMessage: 'This folder is inside a Git repository at {root}: branch and merge actions affect that whole repository.', description: 'Atop the Version Control tab, when the project is a subfolder of a larger repository. {root} is that repository’s root.' }),
  noRepo: msg({ id: 'git.vc.fact.none', defaultMessage: 'This folder has no version control.', description: 'Atop the Version Control tab, when the project folder has no repository.' }),
  other: msg({ id: 'git.vc.fact.other', defaultMessage: '{vcs} found: not supported yet, so this project uses None.', description: 'Atop the Version Control tab: another version control was found in the folder. {vcs} is its name (Mercurial, Jujutsu). None: glossary 2.1.' }),
  gone: msg({ id: 'git.vc.fact.gone', defaultMessage: 'The Git repository is gone from this folder. Until it’s back, what needs Git can’t be read.', description: 'Atop the Version Control tab of a Git project whose .git was removed or moved.' }),
  workflow: msg({ id: 'git.vc.workflow', defaultMessage: 'Workflow: {platform} · {state, select, preset {{preset}} custom {Custom (from {preset})} other {no preset chosen}}', description: 'A link atop the Version Control tab: the project’s workflow, its version control ({platform}: None or Git) and its preset ({preset}: Solo, Pair, Team); Custom when the options were changed after it. Opens the Workflow section. Glossary 2.1: workflow, preset, Custom.' }),
  workflowTip: msg({ id: 'git.vc.workflowTip', defaultMessage: 'Show the workflow options', description: 'Tooltip of the "Workflow: Git · Team" link atop the Version Control tab.' })
}

export const PLATFORM_TEXT: Record<PlatformId, Msg> = { none: M.none, git: M.git }
const CHOICES: PlatformId[] = ['none', 'git']

/** What Hive finds in the folder, in the tab's words. */
function factText(p: ProjectPlatform): string {
  const d = p.detected
  if (d.other) return tr(M.other, { vcs: d.other })
  if (p.id === 'git' && d.platform !== 'git') return tr(M.gone)
  if (d.platform === 'git' && d.root) return tr(d.subfolder ? M.subfolder : M.repo, { root: d.root })
  return tr(M.noRepo)
}

/** The preset the options came from, and whether they were changed since (Custom), as the form shows them. */
export function presetState(f: WorkflowForm): { state: 'preset' | 'custom' | 'none'; preset: WorkflowForm['preset'] } {
  if (!f.preset) return { state: 'none', preset: null }
  const p = f.presets.find((x) => x.id === f.preset)?.options
  const custom = !!p && FORM_OPTIONS[f.platform].some((k) => JSON.stringify(p[k]) !== JSON.stringify(f.options[k]))
  return { state: custom ? 'custom' : 'preset', preset: f.preset }
}

/** The project's workflow form, read again when its saved options change (here, or by the Assistant's tool). */
function useWorkflowForm(project: ProjectInfo): WorkflowForm | null {
  const saved = JSON.stringify(project.config.workflow ?? null)
  const [form, setForm] = useState<{ for: string; form: WorkflowForm } | null>(null)
  useEffect(() => {
    let live = true
    call('workflow:form', project.path).then(
      (f) => live && setForm({ for: project.path, form: f }),
      () => live && setForm(null)
    )
    return () => {
      live = false
    }
  }, [project.path, saved])
  return form?.for === project.path ? form.form : null
}

export function VersionControlHeader({ project, platform }: { project: ProjectInfo; platform: PlatformId }) {
  useLanguage()
  const form = useWorkflowForm(project)
  const preset = form ? presetState(form) : null
  return (
    <div className="vc-head" data-vc-head="">
      <div className="segmented vc-choice" role="radiogroup" aria-label={tr(M.choice)}>
        {CHOICES.map((id) =>
          id === platform ? (
            <button key={id} type="button" role="radio" aria-checked className="active" data-platform={id}>
              {tr(PLATFORM_TEXT[id])}
            </button>
          ) : (
            <Tooltip key={id} content={tr(M.otherTip)}>
              <button type="button" role="radio" aria-checked={false} aria-disabled className="vc-choice-off" data-platform={id}>
                {tr(PLATFORM_TEXT[id])}
              </button>
            </Tooltip>
          )
        )}
      </div>
      {project.platform && (
        <span className={cx('vc-fact', 'faint', project.platform.detected.other || (platform === 'git' && project.platform.detected.platform !== 'git') ? 'caution' : null)} data-vc-fact="">
          {factText(project.platform)}
        </span>
      )}
      {preset && (
        <Tooltip content={tr(M.workflowTip)}>
          <button type="button" className="link vc-workflow" data-action="vc-workflow" onClick={() => showVersionControl(project.path, 'workflow')}>
            <Icon name="git-pull-request" /> {tr(M.workflow, { platform: tr(PLATFORM_TEXT[platform]), state: preset.state, preset: preset.preset ? tr(PRESET_TEXT[preset.preset]) : '' })}
          </button>
        </Tooltip>
      )}
    </div>
  )
}
