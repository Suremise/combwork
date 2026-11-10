import { useState } from 'react'
import type { ProjectInfo, WorkflowChange, WorkflowForm } from '@shared/types'
import { merges, type PlatformId } from '@shared/platform/descriptors'
import { identityShown, type PresetId, type WorkflowOptions } from '@shared/workflow/options'
import { PRESET_SUMMARY, PRESET_TEXT } from '@shared/workflow/optionTexts'
import { asksPreset, STEP_PRESETS, suggestPreset } from '@shared/workflow/presetStep'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { confirm, notify, openVersionControl, set, showVersionControl, useLanguage, useStore } from '../store'
import { cx } from '../util'
import { ChoicePreview, optionValueText, problemText } from './WorkflowOptions'
import { Icon } from './ui'

/**
 * "How do you work? Solo / Pair / Team" (#1423, SPEC §16.3.5), under the Version Control tab's header while the project
 * asks (no preset, no options of its own and no answer for the platform in force: shared/workflow/presetStep.ts). The
 * preset its agents suggest is marked and previewed, worked out again as agents are added. Nothing is applied before
 * Choose, which saves through the Workflow section's save (recording the answer); Customise… opens that section with the
 * preset filled in, not saved; Not now leaves the options inherited and isn't asked again for this platform.
 */

const M = {
  title: msg({ id: 'git.vc.step.title', defaultMessage: 'How do you work?', description: 'The heading of the step that offers a new project a preset (Solo, Pair, Team), atop its Version Control tab.' }),
  intro: msg({ id: 'git.vc.step.intro', defaultMessage: 'A preset sets up this project’s workflow in one click: who reviews the work, which checks pass first and who merges. Nothing changes until you choose.', description: 'Under "How do you work?": what choosing a preset does (glossary 2.1: preset, workflow).' }),
  introNone: msg({ id: 'git.vc.step.introNone', defaultMessage: 'A preset sets up this project’s workflow in one click: who reviews the work and which checks pass first. Nothing changes until you choose.', description: 'Under "How do you work?" for a project without version control (None): what choosing a preset does. None has no merging, so unlike the Git intro it names no merges (glossary 2.1: preset, workflow).' }),
  presets: msg({ id: 'git.vc.step.presets', defaultMessage: 'Presets', description: 'Accessible name of the row of presets (Solo, Pair, Team) in the "How do you work?" step.' }),
  suggested: msg({ id: 'git.vc.step.suggested', defaultMessage: 'Suggested', description: 'A tag on the preset Combwork suggests for the project, in the "How do you work?" step.' }),
  why: msg({ id: 'git.vc.step.why', defaultMessage: '{why, select, solo {Suggested for one agent or none.} pair {Suggested for a builder and a reviewer.} other {Suggested for more agents than a builder and a reviewer.}}', description: 'Why Combwork suggests the marked preset, from the project’s agents, in the "How do you work?" step. Keep the select keys.' }),
  choose: msg({ id: 'git.vc.step.choose', defaultMessage: 'Choose {preset}', description: 'The step’s main button: saves the preset shown ({preset}: Solo, Pair, Team) as the project’s workflow options, after a confirmation.' }),
  customise: msg({ id: 'git.vc.step.customise', defaultMessage: 'Customise…', description: 'A button of the "How do you work?" step: opens the Workflow section with the preset shown filled in, not saved. The … says more follows: keep it.' }),
  notNow: msg({ id: 'git.vc.step.notNow', defaultMessage: 'Not Now', description: 'A button of the "How do you work?" step: no preset; the options stay inherited and the step isn’t offered again for this version control.' }),
  confirmTitle: msg({ id: 'git.vc.step.confirmTitle', defaultMessage: 'Use {preset} for {project}?', description: 'Title of the confirmation after Choose in the "How do you work?" step. {preset} is Solo, Pair or Team; {project} the project’s name.' }),
  nothing: msg({ id: 'git.vc.step.nothing', defaultMessage: 'Nothing is in flight yet: its options apply from the first card that starts.', description: 'The confirmation after Choose in the "How do you work?" step, when no card has started and no lane runs.' }),
  keeps: msg({ id: 'git.vc.step.keeps', defaultMessage: '{n, plural, one {The card in flight keeps the rules it started with; the options apply from the next card.} other {The # cards in flight keep the rules they started with; the options apply from the next card.}}', description: 'The confirmation after Choose in the "How do you work?" step, when cards have started (glossary: old rules).' }),
  use: msg({ id: 'git.vc.step.use', defaultMessage: 'Use {preset}', description: 'The confirm button after Choose in the "How do you work?" step. {preset} is Solo, Pair or Team.' }),
  saved: msg({ id: 'git.vc.step.saved', defaultMessage: '{project} uses {preset}', description: 'A notice after a preset was chosen in the "How do you work?" step.' }),
  details: msg({ id: 'git.vc.step.details', defaultMessage: 'What {preset} sets', description: 'A link in the "How do you work?" step: shows each option the preset shown ({preset}: Solo, Pair, Team) sets, and why.' }),
  hideDetails: msg({ id: 'git.vc.step.hideDetails', defaultMessage: 'Hide what {preset} sets', description: 'The link in the "How do you work?" step once the preset’s options are shown: hides them again. {preset} is Solo, Pair or Team.' }),
  cantSave: msg({ id: 'git.vc.step.cantSave', defaultMessage: 'This preset can’t be saved for the project:', description: 'Before the reasons a preset can’t be saved (it contradicts the workspace’s options, say), in the "How do you work?" step.' })
}

/** Options without their platform, as a save takes them. */
const ownOf = ({ platform: _p, ...rest }: WorkflowOptions): Partial<WorkflowOptions> => rest

export function PresetStep({ project, platform, form }: { project: ProjectInfo; platform: PlatformId; form: WorkflowForm | null }) {
  useLanguage()
  const [picked, setPicked] = useState<PresetId | null>(null)
  const [busy, setBusy] = useState(false)
  // What the preset sets and why, on request: the step stays a few lines, so the tab's sections keep their room.
  const [details, setDetails] = useState(false)
  if (!form || form.platform !== platform || !asksPreset(project.config, platform)) return null
  // Worked out again as agents are added while the step shows.
  const suggested = suggestPreset(project.agents)
  const presets = STEP_PRESETS.flatMap((id) => {
    const p = form.presets.find((x) => x.id === id)
    return p ? [p] : []
  })
  const shown = presets.find((p) => p.id === (picked ?? suggested)) ?? presets[0]
  if (!shown) return null
  const name = (id: PresetId): string => tr(PRESET_TEXT[id])

  const choose = async (): Promise<void> => {
    // As the Workflow section saves it, checked against what it was read with (#1418).
    const change: WorkflowChange = { preset: shown.id, options: ownOf(shown.options), base: { preset: form.preset, options: form.own } }
    setBusy(true)
    try {
      const check = await call('workflow:check', project.path, change)
      if (check.problems.length) {
        notify('error', tr(M.cantSave), check.problems.map(problemText).join('\n'))
        return
      }
      const n = check.inFlight.length
      const ok = await confirm({
        title: tr(M.confirmTitle, { preset: name(shown.id), project: project.name }),
        message: n ? tr(M.keeps, { n }) : tr(M.nothing),
        confirmLabel: tr(M.use, { preset: name(shown.id) }),
        run: async () => {
          await call('workflow:setOptions', project.path, change, { applyTo: [] })
        }
      })
      if (ok) notify('success', tr(M.saved, { project: project.name, preset: name(shown.id) }))
    } catch (e) {
      notify('error', errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const customise = (): void => {
    set({ workflowPrefill: { path: project.path, preset: shown.id } })
    showVersionControl(project.path, 'workflow')
  }
  const notNow = (): void => {
    void call('workflow:presetNotNow', project.path, platform).catch((e) => notify('error', errorMessage(e)))
  }

  return (
    <div className="vc-step" data-preset-step={platform}>
      <div className="vc-step-head">
        <h3>{tr(M.title)}</h3>
        <span className="s-desc">{tr(merges(platform) ? M.intro : M.introNone)}</span>
      </div>
      <div className="vc-step-presets" role="radiogroup" aria-label={tr(M.presets)}>
        {presets.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={p.id === shown.id} className={cx('vc-step-preset', p.id === shown.id && 'active')} data-preset={p.id} onClick={() => setPicked(p.id)}>
            <span className="vc-step-name">
              {name(p.id)}
              {p.id === suggested && <span className="vc-step-tag">{tr(M.suggested)}</span>}
            </span>
            {PRESET_SUMMARY[platform][p.id] && <span className="s-desc">{tr(PRESET_SUMMARY[platform][p.id]!)}</span>}
          </button>
        ))}
      </div>
      <div className="s-desc vc-step-why" data-suggested={suggested}>
        {tr(M.why, { why: suggested })}
      </div>
      {details && <ChoicePreview choice={shown.id} name={name(shown.id)} options={shown.options} effective={form.options} valueText={(k, v) => optionValueText(k, k === 'identity' ? identityShown(v, form.identity) : v, platform)} />}
      <div className="vc-step-actions">
        <button type="button" className="btn primary small" data-action="step-choose" disabled={busy} onClick={() => void choose()}>
          {tr(M.choose, { preset: name(shown.id) })}
        </button>
        <button type="button" className="btn small" data-action="step-customise" onClick={customise}>
          {tr(M.customise)}
        </button>
        <button type="button" className="btn subtle small" data-action="step-notnow" onClick={notNow}>
          {tr(M.notNow)}
        </button>
        <button type="button" className="link vc-step-details" data-action="step-details" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
          {tr(details ? M.hideDetails : M.details, { preset: name(shown.id) })}
        </button>
      </div>
    </div>
  )
}

const N = {
  text: msg({ id: 'git.vc.stepNotice.text', defaultMessage: '{n, plural, one {{projects} was added: how do you work?} other {{projects} were added: how do you work?}} A preset sets up a workflow in one click.', description: 'A notice for projects Combwork found in the workspace (or the Assistant added) that have no workflow yet: it offers the "How do you work?" step (glossary 2.1: preset, workflow). {projects} is a list of project names; {n} how many.' }),
  choose: msg({ id: 'git.vc.stepNotice.choose', defaultMessage: 'Choose…', description: 'A button of the notice for projects added without a workflow: opens the first one’s Version Control tab at "How do you work?". The … says more follows: keep it.' }),
  notNow: msg({ id: 'git.vc.stepNotice.notNow', defaultMessage: 'Not Now', description: 'A button of the notice for projects added without a workflow: answers "How do you work?" with Not now for each (their options stay inherited), so it isn’t shown again.' })
}

/**
 * The notice for projects added since 1.0 that weren't added here (#1423: found when the workspace is read, or added by
 * the Assistant or the Agent API) and still ask "How do you work?". A project switched to a platform it never had asks
 * in its tab instead, and one added from this window opens its tab at the step. Choose… opens the first one's tab; Not
 * now answers each, so it isn't shown again, after a restart too.
 */
export function NewProjectsNotice() {
  useLanguage()
  const workspace = useStore((s) => s.workspace)
  const readOnly = useStore((s) => s.boardState?.readOnly ?? null)
  const shownHere = useStore((s) => s.presetStepShown)
  if (!workspace || readOnly !== null) return null
  const projects = workspace.projects.filter((p) => p.platform && !p.config.workflow?.kept && !shownHere.includes(p.path) && asksPreset(p.config, p.platform.id))
  if (!projects.length) return null
  const choose = (): void => {
    set({ presetStepShown: [...shownHere, projects[0].path] })
    openVersionControl(projects[0].path, 'workflow')
  }
  const notNow = (): void => {
    for (const p of projects) void call('workflow:presetNotNow', p.path, p.platform!.id).catch((e) => notify('error', errorMessage(e)))
  }
  return (
    <div className="banner info wrap-banner step-notice" role="status" data-step-notice="">
      {/* The icon with its text, so they wrap as one (HI-1717). */}
      <span className="wrap-banner-text">
        <Icon name="info" />
        <span className="grow">{tr(N.text, { projects: fmt.list(projects.map((p) => p.name)), n: projects.length })}</span>
      </span>
      {/* Together, so in a narrow pane they wrap under the text as one (HI-1717). */}
      <span className="wrap-banner-actions">
        <button className="btn small primary" data-action="step-notice-choose" onClick={choose}>
          {tr(N.choose)}
        </button>
        <button className="btn small subtle" data-action="step-notice-notnow" onClick={notNow}>
          {tr(N.notNow)}
        </button>
      </span>
    </div>
  )
}
