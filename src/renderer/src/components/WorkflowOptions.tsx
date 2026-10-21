import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectInfo, WorkflowChange, WorkflowForm, WorkflowOptionOrigin, WorkflowProblem } from '@shared/types'
import { CONTRADICTIONS, FORM_OPTIONS, NOT_OFFERED, reviewerAgent, type OkBefore, type OptionKey, type PresetId, type WorkflowOptions } from '@shared/workflow/options'
import { optionTitle, OPTION_TEXT, PRESET_NEEDS_TEXT, PRESET_TEXT, VALUE_TEXT } from '@shared/workflow/optionTexts'
import { LOOP_ROUNDS, loopDefaults } from '@shared/lanes'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { cardLabelOf, confirm, notify, openProjectSettings, set as setStore, setActivity, useStore } from '../store'
import { Icon, Switch, Tooltip } from './ui'

/**
 * Project Settings → Workflow (#1278, SPEC §16.19: P4's plain form, before the Version Control tab): the version control
 * (detected, read-only), a preset, and a row per option this version offers, each with where its value comes from and,
 * when the project sets it, a way back to inheriting. Edits are a draft until Save, which shows what changes and what
 * keeps the old rules first (§16.6.5), and lets the user apply the change to cards in flight (OP-38).
 */

const T = {
  platform: msg({ id: 'workflow.form.platform', defaultMessage: 'Version control', description: 'A row of Project Settings → Workflow (glossary 2.1): the project’s version control, detected, shown read-only.' }),
  platformDesc: msg({ id: 'workflow.form.platformDesc', defaultMessage: 'Found in the project folder. The options below are this version control’s.', description: 'Under the row "Version control" of Project Settings → Workflow.' }),
  git: msg({ id: 'workflow.form.git', defaultMessage: 'Git', description: 'A version control system’s name (glossary 2.1: keep).' }),
  none: msg({ id: 'workflow.form.none', defaultMessage: 'None', description: 'The version control of a project without any (glossary 2.1: None).' }),
  preset: msg({ id: 'workflow.form.preset', defaultMessage: 'Preset', description: 'A row of Project Settings → Workflow (glossary 2.1: preset): one choice that fills in every option.' }),
  presetDesc: msg({ id: 'workflow.form.presetDesc', defaultMessage: 'Fills in every option at once. Changing an option afterwards makes it Custom.', description: 'Under the row "Preset" of Project Settings → Workflow. Custom is a preset’s name: as translated there.' }),
  startedFrom: msg({ id: 'workflow.form.startedFrom', defaultMessage: 'Custom, started from {preset}', description: 'Project Settings → Workflow: the options were changed after a preset was chosen. {preset} is its name.' }),
  choose: msg({ id: 'workflow.form.choose', defaultMessage: 'Choose a preset…', description: 'The first entry of the preset choice in Project Settings → Workflow, when none was chosen.' }),
  unavailable: msg({ id: 'workflow.form.unavailable', defaultMessage: '{preset}: {why}', description: 'A preset that can’t be chosen yet, under the preset choice. {preset} is its name, {why} a whole sentence saying why.' }),
  from: {
    preset: msg({ id: 'workflow.form.from.preset', defaultMessage: 'From the preset', description: 'Where a workflow option’s value comes from: the preset chosen.' }),
    project: msg({ id: 'workflow.form.from.project', defaultMessage: 'Set for this project', description: 'Where a workflow option’s value comes from: set in this project.' }),
    workspace: msg({ id: 'workflow.form.from.workspace', defaultMessage: 'From the workspace', description: 'Where a workflow option’s value comes from: the workspace’s default.' }),
    global: msg({ id: 'workflow.form.from.global', defaultMessage: 'From Hive’s settings', description: 'Where a workflow option’s value comes from: Hive’s own default.' }),
    platform: msg({ id: 'workflow.form.from.platform', defaultMessage: 'Default', description: 'Where a workflow option’s value comes from: nobody set it (every rule off).' })
  } satisfies Record<WorkflowOptionOrigin | 'preset', ReturnType<typeof msg>>,
  inherit: msg({ id: 'workflow.form.inherit', defaultMessage: 'Inherit', description: 'A button beside a workflow option set for this project: stop setting it here, and use the workspace’s or Hive’s value.' }),
  inheritTip: msg({ id: 'workflow.form.inheritTip', defaultMessage: 'Use the inherited value: {value}', description: 'The tooltip of the Inherit button of a workflow option. {value} is the value it would have.' }),
  on: msg({ id: 'workflow.form.on', defaultMessage: 'On', description: 'A workflow option’s value: on.' }),
  off: msg({ id: 'workflow.form.off', defaultMessage: 'Off', description: 'A workflow option’s value: off.' }),
  defaultBranch: msg({ id: 'workflow.form.defaultBranch', defaultMessage: 'The repository’s default branch', description: 'The placeholder of the target branch field in Project Settings → Workflow: left empty, the default branch.' }),
  labels: msg({ id: 'workflow.form.labels', defaultMessage: 'Labels, separated by commas', description: 'The placeholder of the labels field of “Your OK before merging”.' }),
  noIdentity: msg({ id: 'workflow.form.noIdentity', defaultMessage: 'No name and email are set in git config yet.', description: 'Under “Commits use the project’s identity” when git has no identity configured.' }),
  identity: msg({ id: 'workflow.form.identity', defaultMessage: 'Commits as {name} <{email}>.', description: 'Under “Commits use the project’s identity”: the identity used, from git config.' }),
  checkName: msg({ id: 'workflow.form.checkName', defaultMessage: 'Name', description: 'The placeholder of a check’s name field (Project Settings → Workflow → Checks pass before review).' }),
  checkCommand: msg({ id: 'workflow.form.checkCommand', defaultMessage: 'Command', description: 'The placeholder of a check’s command field (Project Settings → Workflow → Checks pass before review).' }),
  addCheck: msg({ id: 'workflow.form.addCheck', defaultMessage: 'Add Check', description: 'A button under the checks of “Checks pass before review”.' }),
  removeCheck: msg({ id: 'workflow.form.removeCheck', defaultMessage: 'Remove', description: 'The tooltip of the button removing a check from “Checks pass before review”.' }),
  noneValue: msg({ id: 'workflow.form.noneValue', defaultMessage: 'None', description: 'An empty value in the list of what changes before saving workflow options: no checks, no commands, no folders.' }),
  noChecks: msg({ id: 'workflow.form.noChecks', defaultMessage: 'No checks.', description: 'Under “Checks pass before review” when it has none.' }),
  folders: msg({ id: 'workflow.form.folders', defaultMessage: 'Folders and files, separated by commas', description: 'The placeholder of the field “What the work is” (folders and files left out).' }),
  worktree: msg({ id: 'workflow.form.worktree', defaultMessage: 'In this version, a card’s own folder is its builder’s worktree.', description: 'Under “Where cards are built” in Project Settings → Workflow.' }),
  owned: msg({ id: 'workflow.form.owned', defaultMessage: 'Set in {where}.', description: 'Under a read-only row of Project Settings → Workflow (file locks, card loops): where the setting is changed. {where} is a link to it.' }),
  fileLocks: msg({ id: 'workflow.form.fileLocks', defaultMessage: 'File locks', description: 'A read-only row of Project Settings → Workflow for a project without version control (glossary 2.6, N7).' }),
  agentsSection: msg({ id: 'workflow.form.agentsSection', defaultMessage: 'Agents & Worktrees', description: 'A link to the section "Agents & Worktrees" of Project Settings: use its name as translated there.' }),
  loops: msg({ id: 'workflow.form.loops', defaultMessage: 'Rounds and wait', description: 'A read-only row of Project Settings → Workflow: the card loops’ rounds and wait.' }),
  loopsValue: msg({ id: 'workflow.form.loopsValue', defaultMessage: '{rounds, plural, one {# round} other {# rounds}}, wait {hours, plural, one {# hour} other {# hours}}', description: 'The value of the read-only row "Rounds and wait" of Project Settings → Workflow.' }),
  loopsSection: msg({ id: 'workflow.form.loopsSection', defaultMessage: 'Card loops', description: 'A link to the section "Card loops" of Project Settings: use its name as translated there.' }),
  notEnforced: msg({ id: 'workflow.form.notEnforced', defaultMessage: 'Workflow rules aren’t enforced (Settings → Advanced). These options are saved, and apply once the rules are enforced again.', description: 'A note atop Project Settings → Workflow while the switch "Workflow rules are enforced" is off.' }),
  invalid: msg({ id: 'workflow.form.invalid', defaultMessage: 'These options can’t be used, so every rule is off in this project:', description: 'A note atop Project Settings → Workflow: the saved options contradict each other or can’t be read; the reason follows.' }),
  save: msg({ id: 'workflow.form.save', defaultMessage: 'Save…', description: 'The button saving the workflow options (it shows what changes first).' }),
  discard: msg({ id: 'workflow.form.discard', defaultMessage: 'Discard Changes', description: 'The button dropping unsaved changes to the workflow options.' }),
  copy: msg({ id: 'workflow.form.copy', defaultMessage: 'Copy as JSON', description: 'The button copying the project’s workflow options as JSON, to paste into another project.' }),
  copied: msg({ id: 'workflow.form.copied', defaultMessage: 'Workflow options copied', description: 'A notification: the workflow options were copied to the clipboard.' }),
  paste: msg({ id: 'workflow.form.paste', defaultMessage: 'Paste JSON…', description: 'The button pasting workflow options copied from another project.' }),
  pasteTitle: msg({ id: 'workflow.form.pasteTitle', defaultMessage: 'Paste Workflow Options', description: 'The title of the dialog pasting workflow options as JSON.' }),
  pasteMessage: msg({ id: 'workflow.form.pasteMessage', defaultMessage: 'Paste options copied from a project with the same version control. They replace the form’s, to save afterwards.', description: 'The message of the dialog pasting workflow options as JSON.' }),
  pasteApply: msg({ id: 'workflow.form.pasteApply', defaultMessage: 'Use These Options', description: 'The confirm button of the dialog pasting workflow options.' }),
  pasteBad: msg({ id: 'workflow.form.pasteBad', defaultMessage: 'That isn’t workflow options copied from Hive.', description: 'An error pasting workflow options: the text isn’t the JSON Hive copies.' }),
  pastePlatform: msg({ id: 'workflow.form.pastePlatform', defaultMessage: 'These options are for another version control.', description: 'An error pasting workflow options: they were copied from a project with another version control.' }),
  cantSave: msg({ id: 'workflow.form.cantSave', defaultMessage: 'These options can’t be saved:', description: 'Above the reasons the workflow options can’t be saved, each a sentence of its own.' }),
  confirmTitle: msg({ id: 'workflow.form.confirmTitle', defaultMessage: 'Save Workflow Options', description: 'The title of the dialog before saving workflow options.' }),
  confirmMessage: msg({ id: 'workflow.form.confirmMessage', defaultMessage: 'The new options apply from the next card that starts.', description: 'The message of the dialog before saving workflow options.' }),
  changesHead: msg({ id: 'workflow.form.changesHead', defaultMessage: 'What changes:', description: 'In the dialog before saving workflow options: above the list of options that change, each with its old and new value.' }),
  changeLine: msg({ id: 'workflow.form.changeLine', defaultMessage: '{option}: {from} → {to}', description: 'A line of the list of what changes, in the dialog before saving workflow options: an option’s name, its value now and its new value.' }),
  noChanges: msg({ id: 'workflow.form.noChanges', defaultMessage: 'No option changes: only the preset they started from.', description: 'In the dialog before saving workflow options, when no option’s value changes.' }),
  lanes: msg({ id: 'workflow.form.lanes', defaultMessage: '{n, plural, one {This running lane keeps the old rules until it ends:} other {These running lanes keep the old rules until they end:}}', description: 'In the dialog before saving workflow options, above a list of lanes (glossary 2.1: old rules).' }),
  lane: msg({ id: 'workflow.form.lane', defaultMessage: 'Builder {builder}: {name}', description: 'A running lane in the dialog before saving workflow options: its builder agent and its name.' }),
  laneUnnamed: msg({ id: 'workflow.form.laneUnnamed', defaultMessage: 'Builder {builder}', description: 'A running lane without a name in the dialog before saving workflow options: its builder agent.' }),
  inFlight: msg({ id: 'workflow.form.inFlight', defaultMessage: '{n, plural, one {This card in flight keeps the old rules. Tick it to apply the new options to it now.} other {These cards in flight keep the old rules. Tick one to apply the new options to it now.}}', description: 'In the dialog before saving workflow options, above the cards already started (glossary 2.1: old rules). Ticking a card records an override on it.' }),
  saved: msg({ id: 'workflow.form.saved', defaultMessage: 'Workflow options saved', description: 'A notification: the workflow options were saved.' }),
  loadFailed: msg({ id: 'workflow.form.loadFailed', defaultMessage: 'Couldn’t read the workflow options: {error}', description: 'An error showing Project Settings → Workflow. {error} says why.' })
}

/** A problem's sentence, in the window's language (an English reason when it has no message). */
const problemText = (p: WorkflowProblem): string => (p.kind === 'contradiction' ? tr(CONTRADICTIONS[p.id]) : p.kind === 'notOffered' ? tr(NOT_OFFERED[p.id]) : p.why)

/** The JSON Copy as JSON gives: the version control, the preset and every option in force. */
interface CopiedOptions {
  hiveWorkflow: 1
  platform: WorkflowOptions['platform']
  preset: PresetId | null
  options: Partial<WorkflowOptions>
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const list = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export function WorkflowOptionsForm({ project }: { project: ProjectInfo }) {
  const [form, setForm] = useState<WorkflowForm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<WorkflowChange | null>(null)
  const [problems, setProblems] = useState<WorkflowProblem[]>([])
  const settings = useStore((s) => s.settings)
  const workspaceLoops = loopDefaults({ loops: useStore((s) => s.workspace?.config.loops) })
  // Read for each project; the form's own saves read it again themselves.
  useEffect(() => {
    let live = true
    call('workflow:form', project.path)
      .then((f) => {
        if (!live) return
        setForm(f)
        setDraft({ preset: f.preset, options: { ...f.own } })
        setProblems([])
        setError(null)
      })
      .catch((e) => live && setError(errorMessage(e)))
    return () => {
      live = false
    }
  }, [project.path])

  const effective = useMemo((): WorkflowOptions | null => (form && draft ? ({ ...form.inherited, ...draft.options, platform: form.platform } as WorkflowOptions) : null), [form, draft])
  if (error) return <div className="s-desc error">{tr(T.loadFailed, { error })}</div>
  if (!form || !draft || !effective) return null
  const presetOf = (id: PresetId | null): WorkflowOptions | null => form.presets.find((p) => p.id === id)?.options ?? null
  const presetOptions = presetOf(draft.preset)
  const custom = !!presetOptions && FORM_OPTIONS[form.platform].some((k) => !same(presetOptions[k], effective[k]))
  const dirty = draft.preset !== form.preset || !same(draft.options, form.own)
  const set = <K extends OptionKey>(key: K, value: WorkflowOptions[K]): void => setDraft({ ...draft, options: { ...draft.options, [key]: value } })
  const inheritKey = (key: OptionKey): void => {
    const { [key]: _gone, ...rest } = draft.options
    setDraft({ ...draft, options: rest })
  }
  const choosePreset = (id: PresetId): void => {
    const p = presetOf(id)
    if (!p) return
    const { platform: _p, ...options } = p
    setDraft({ preset: id, options })
  }
  const originOf = (key: OptionKey): WorkflowOptionOrigin | 'preset' => {
    if (!(key in draft.options)) return form.inheritedOrigins[key]
    return presetOptions && same(presetOptions[key], draft.options[key]) ? 'preset' : 'project'
  }

  const save = async (): Promise<void> => {
    const check = await call('workflow:check', project.path, draft)
    setProblems(check.problems)
    if (check.problems.length) return
    // Each option that changes, its value now and its new one (the Assistant for Darren: a list, never one sentence).
    const changes = check.changed.flatMap((k) => {
      const title = k === 'platform' ? null : (optionTitle(k, form.platform) ?? OPTION_TEXT[k]?.title)
      return title && k !== 'platform' ? [tr(T.changeLine, { option: tr(title), from: valueText(k, form.options[k]), to: valueText(k, effective[k]) })] : []
    })
    const picked = new Set<number>()
    const ok = await confirm({
      title: tr(T.confirmTitle),
      message: tr(T.confirmMessage),
      wide: true,
      content: <SaveDetails changes={changes} check={check} picked={picked} />,
      confirmLabel: tr(T.save).replace(/…$/, ''),
      run: async () => {
        const f = await call('workflow:setOptions', project.path, draft, { applyTo: [...picked] })
        setForm(f)
        setDraft({ preset: f.preset, options: { ...f.own } })
      }
    })
    if (ok) notify('success', tr(T.saved))
  }
  const copy = (): void => {
    const { platform, ...options } = effective
    const out: CopiedOptions = { hiveWorkflow: 1, platform, preset: draft.preset, options }
    void navigator.clipboard.writeText(JSON.stringify(out, null, 2)).then(() => notify('success', tr(T.copied)))
  }
  const paste = async (): Promise<void> => {
    let text = ''
    await confirm({
      title: tr(T.pasteTitle),
      message: tr(T.pasteMessage),
      wide: true,
      content: <textarea className="input mono workflow-paste" rows={10} onChange={(e) => (text = e.target.value)} />,
      confirmLabel: tr(T.pasteApply),
      run: async () => {
        let v: Partial<CopiedOptions> | null = null
        try {
          v = JSON.parse(text) as Partial<CopiedOptions>
        } catch {
          v = null
        }
        if (!v || v.hiveWorkflow !== 1 || !v.options || typeof v.options !== 'object') throw new Error(tr(T.pasteBad))
        if (v.platform !== form.platform) throw new Error(tr(T.pastePlatform))
        const change: WorkflowChange = { preset: v.preset ?? null, options: v.options }
        // Checked as a save would check it (OP-5): refused with its reasons, else it fills the form, to save.
        const check = await call('workflow:check', project.path, change)
        if (check.problems.length) throw new Error([tr(T.cantSave), ...check.problems.map(problemText)].join('\n'))
        setDraft(change)
        setProblems([])
      }
    })
  }

  const rowOf = (key: OptionKey): React.ReactNode => {
    const title = optionTitle(key, form.platform)
    const text = OPTION_TEXT[key]
    if (!title || !text) return null
    const origin = originOf(key)
    return (
      <div className="setting workflow-option" key={key} data-option={key}>
        <div className="s-text">
          <div className="s-title">
            {key in draft.options && <span className="modified" />}
            {tr(title)}
          </div>
          <div className="s-desc">{tr(text.desc)}</div>
          {controlNote(key)}
          <div className="s-desc workflow-origin">
            {tr(T.from[origin])}
            {key in draft.options && (
              <Tooltip content={tr(T.inheritTip, { value: valueText(key, form.inherited[key]) })}>
                <button className="btn subtle small workflow-inherit" onClick={() => inheritKey(key)}>
                  {tr(T.inherit)}
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="s-control">{controlOf(key)}</div>
      </div>
    )
  }
  /** A value in words, for the Inherit button's tooltip. */
  const valueText = (key: OptionKey, v: unknown): string => {
    if (typeof v === 'boolean') return tr(v ? T.on : T.off)
    if (key === 'review') return tr(form.platform === 'none' && v === 'none' ? VALUE_TEXT.review.noneNone : VALUE_TEXT.review[v as keyof typeof VALUE_TEXT.review])
    const values = (VALUE_TEXT as Record<string, Record<string, ReturnType<typeof msg>>>)[key]
    if (values && typeof v === 'string' && values[v]) return tr(values[v])
    if (key === 'okBefore') return tr(VALUE_TEXT.okBefore[(v as OkBefore).mode])
    if (key === 'identity') return tr(v ? T.on : T.off)
    if (key === 'reviewers') return fmt.number(v as number)
    if (key === 'commands') return Object.keys(v as Record<string, string>).length ? fmt.list(Object.entries(v as Record<string, string>).map(([name, command]) => `${name} (${command})`)) : tr(T.noneValue) // i18n-ignore: a check's name and command, shown as they are
    if (Array.isArray(v)) return v.length ? fmt.list(v.map(String)) : tr(T.noneValue)
    if (key === 'target') return (v as string) || tr(T.defaultBranch)
    return String(v)
  }
  const select = <K extends OptionKey>(key: K, values: [string, string][], convert: (s: string) => WorkflowOptions[K] = (s) => s as WorkflowOptions[K]): React.ReactNode => (
    <select className="select" value={String(effective[key])} onChange={(e) => set(key, convert(e.target.value))}>
      {values.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  )
  const controlNote = (key: OptionKey): React.ReactNode => {
    if (key === 'identity') return <div className="s-desc">{form.identity ? tr(T.identity, { name: form.identity.name, email: form.identity.email }) : tr(T.noIdentity)}</div>
    if (key === 'folder' && effective.folder === 'slots') return <div className="s-desc">{tr(T.worktree)}</div>
    return null
  }
  const controlOf = (key: OptionKey): React.ReactNode => {
    const V = VALUE_TEXT
    switch (key) {
      case 'review':
        return select('review', [
          ['none', tr(form.platform === 'none' ? V.review.noneNone : V.review.none)],
          ['agent', tr(V.review.agent)],
          ['agentThenYou', tr(V.review.agentThenYou)],
          ['you', tr(V.review.you)]
        ])
      case 'reviewers':
        return select('reviewers', [['1', fmt.number(1)], ['2', fmt.number(2)]], (s) => (s === '2' ? 2 : 1))
      case 'sameness':
        return select('sameness', [['change', tr(V.sameness.change)], ['exact', tr(V.sameness.exact)]])
      case 'finish': {
        // Hive merges isn't offered in this version (§16.19.1): shown only for a project that has it, to change.
        const values: [string, string][] = [['agentMerges', tr(V.finish.agentMerges)], ['committed', tr(V.finish.committed)], ['notChecked', tr(V.finish.notChecked)]]
        return select('finish', effective.finish === 'hiveMerges' ? [['hiveMerges', tr(V.finish.hiveMerges)], ...values] : values)
      }
      case 'style':
        return select('style', [['merge', tr(V.style.merge)], ['squash', tr(V.style.squash)]])
      case 'folder':
        return select('folder', [['slots', tr(V.folder.slots)], ['project', tr(V.folder.project)]])
      case 'target':
        return <DraftText value={effective.target} placeholder={tr(T.defaultBranch)} onCommit={(v) => set('target', v.trim())} />
      case 'okBefore':
        return (
          <div className="workflow-stack">
            {/* Bound to its mode: the option itself is an object (HR6's round 1). */}
            <select className="select" value={effective.okBefore.mode} onChange={(e) => set('okBefore', { mode: e.target.value as OkBefore['mode'], labels: effective.okBefore.labels })}>
              <option value="never">{tr(V.okBefore.never)}</option>
              <option value="labels">{tr(V.okBefore.labels)}</option>
              <option value="every">{tr(V.okBefore.every)}</option>
            </select>
            {effective.okBefore.mode === 'labels' && <DraftText value={effective.okBefore.labels.join(', ')} placeholder={tr(T.labels)} onCommit={(v) => set('okBefore', { mode: 'labels', labels: list(v) })} />}
          </div>
        )
      case 'identity':
        return <Switch checked={!!effective.identity} disabled={!form.identity && !effective.identity} onChange={(v) => set('identity', v ? form.identity : null)} />
      case 'noSelfReview':
        return <Switch checked={effective.noSelfReview || reviewerAgent(effective.review)} disabled={reviewerAgent(effective.review)} onChange={(v) => set('noSelfReview', v)} />
      case 'stopOwnRuns':
      case 'dependenciesDone':
      case 'sharedFolderWarning':
        return <Switch checked={effective[key]} onChange={(v) => set(key, v)} />
      case 'preChecks':
        return <ChecksEditor names={effective.preChecks} commands={effective.commands} onChange={(names, commands) => setDraft({ ...draft, options: { ...draft.options, preChecks: names, commands } })} />
      case 'excluded':
        return <DraftText value={effective.excluded.join(', ')} placeholder={tr(T.folders)} onCommit={(v) => set('excluded', list(v))} />
      default:
        return null
    }
  }

  const rounds = project.config.loopRounds ?? workspaceLoops.rounds ?? LOOP_ROUNDS
  const hours = project.config.loopWaitHours ?? workspaceLoops.waitHours
  return (
    <div className="workflow-form">
      {!form.enforced && (
        <div className="banner warn workflow-note" role="status">
          <Icon name="warning" />
          <span>{tr(T.notEnforced)}</span>
          <button className="btn subtle small" onClick={() => (setStore({ settingsSection: 'advanced', settingsQuery: '' }), setActivity('settings'))}>
            {tr(msg({ id: 'workflow.form.openAdvanced', defaultMessage: 'Open Advanced', description: 'A button beside the note that workflow rules aren’t enforced: opens Settings → Advanced.' }))}
          </button>
        </div>
      )}
      {form.invalid && (
        <div className="banner warn workflow-note" role="status">
          <Icon name="warning" />
          <span>
            {tr(T.invalid)} {form.invalid}
          </span>
        </div>
      )}
      <div className="setting">
        <div className="s-text">
          <div className="s-title">{tr(T.platform)}</div>
          <div className="s-desc">{tr(T.platformDesc)}</div>
        </div>
        <div className="s-control workflow-platform">{tr(form.platform === 'git' ? T.git : T.none)}</div>
      </div>
      <div className="setting workflow-preset">
        <div className="s-text">
          <div className="s-title">{tr(T.preset)}</div>
          <div className="s-desc">{tr(T.presetDesc)}</div>
          {form.presets
            .filter((p) => p.needs)
            .map((p) => (
              <div className="s-desc workflow-unavailable" key={p.id}>
                {tr(T.unavailable, { preset: tr(PRESET_TEXT[p.id]), why: tr(PRESET_NEEDS_TEXT[p.needs!]) })}
              </div>
            ))}
        </div>
        <div className="s-control">
          <select className="select" value={draft.preset && !custom ? draft.preset : ''} onChange={(e) => e.target.value && choosePreset(e.target.value as PresetId)}>
            <option value="" disabled>
              {draft.preset ? tr(T.startedFrom, { preset: tr(PRESET_TEXT[draft.preset]) }) : tr(T.choose)}
            </option>
            {form.presets.map((p) => (
              <option key={p.id} value={p.id} disabled={!!p.needs}>
                {tr(PRESET_TEXT[p.id])}
              </option>
            ))}
          </select>
        </div>
      </div>
      {FORM_OPTIONS[form.platform].map(rowOf)}
      {form.platform === 'none' && (
        <ReadOnlyRow title={tr(T.fileLocks)} value={tr(msg({ id: 'workflow.form.fileLocksValue', defaultMessage: 'As set for the project’s agents', description: 'The value of the read-only row "File locks" in Project Settings → Workflow: its own setting decides.' }))} where={tr(T.agentsSection)} open={() => openProjectSettings(project.path, 'agents')} />
      )}
      <ReadOnlyRow title={tr(T.loops)} value={tr(T.loopsValue, { rounds, hours })} where={tr(T.loopsSection)} open={() => openProjectSettings(project.path, 'loops')} />
      {problems.length > 0 && (
        <div className="workflow-problems" role="alert">
          <div>{tr(T.cantSave)}</div>
          {problems.map((p, i) => (
            <div key={i}>{problemText(p)}</div>
          ))}
        </div>
      )}
      <div className="workflow-actions">
        <button className="btn primary" disabled={!dirty || !settings} onClick={() => void save().catch((e) => notify('error', errorMessage(e)))}>
          {tr(T.save)}
        </button>
        <button className="btn" disabled={!dirty} onClick={() => (setDraft({ preset: form.preset, options: { ...form.own } }), setProblems([]))}>
          {tr(T.discard)}
        </button>
        <span className="workflow-spacer" />
        <button className="btn subtle" onClick={copy}>
          {tr(T.copy)}
        </button>
        <button className="btn subtle" onClick={() => void paste()}>
          {tr(T.paste)}
        </button>
      </div>
    </div>
  )
}

/** A row whose setting lives elsewhere (file locks, card loops), shown with a link to it (#966: one owner per switch). */
function ReadOnlyRow({ title, value, where, open }: { title: string; value: string; where: string; open: () => void }) {
  return (
    <div className="setting workflow-readonly">
      <div className="s-text">
        <div className="s-title">{title}</div>
        <div className="s-desc">
          {tr(msg({ id: 'workflow.form.ownedPrefix', defaultMessage: 'Its own setting decides:', description: 'Before the link to where a read-only row of Project Settings → Workflow is set.' }))}{' '}
          <button className="link" onClick={open}>
            {where}
          </button>
        </div>
      </div>
      <div className="s-control">{value}</div>
    </div>
  )
}

/**
 * A text field typed freely (spaces, commas) and taken when it loses focus or on Enter: tidied then, never per keystroke
 * (HR6's round 1). A value changed from outside (a preset, a paste, Discard Changes) replaces what it shows.
 */
function DraftText({ value, placeholder, onCommit, className = 'input' }: { value: string; placeholder: string; onCommit: (v: string) => void; className?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return <input className={className} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)} onKeyDown={(e) => e.key === 'Enter' && onCommit(text)} />
}

type CheckRow = { name: string; command: string }

/** The checks before review: each a name and its command (§16.13: a run counts as the check only as that command). */
function ChecksEditor({ names, commands, onChange }: { names: string[]; commands: Record<string, string>; onChange: (names: string[], commands: Record<string, string>) => void }) {
  const given = JSON.stringify([names, commands])
  const [rows, setRows] = useState<CheckRow[]>(() => names.map((n) => ({ name: n, command: commands[n] ?? '' })))
  // What it last gave back: the props coming back as that keep the rows as typed; anything else (a preset, a paste,
  // Discard Changes) replaces them.
  const sent = useRef(given)
  useEffect(() => {
    if (given === sent.current) return
    sent.current = given
    const [n, c] = JSON.parse(given) as [string[], Record<string, string>]
    setRows(n.map((x) => ({ name: x, command: c[x] ?? '' })))
  }, [given])
  // Typed freely and taken as the field loses focus, tidied then (HR6's round 1: never trimmed per keystroke).
  const commit = (next: CheckRow[]): void => {
    const kept = next.map((r) => ({ name: r.name.trim(), command: r.command.trim() })).filter((r) => r.name || r.command)
    const n = kept.map((r) => r.name)
    const c = Object.fromEntries(kept.filter((r) => r.name && r.command).map((r) => [r.name, r.command]))
    sent.current = JSON.stringify([n, c])
    onChange(n, c)
  }
  const edit = (i: number, part: keyof CheckRow, v: string): void => setRows(rows.map((x, j) => (j === i ? { ...x, [part]: v } : x)))
  const change = (next: CheckRow[]): void => {
    setRows(next)
    commit(next)
  }
  return (
    <div className="workflow-stack workflow-checks">
      {!rows.length && <div className="s-desc">{tr(T.noChecks)}</div>}
      {rows.map((r, i) => (
        <div className="workflow-check" key={i}>
          <input className="input" value={r.name} placeholder={tr(T.checkName)} onChange={(e) => edit(i, 'name', e.target.value)} onBlur={() => commit(rows)} />
          <input className="input mono" value={r.command} placeholder={tr(T.checkCommand)} onChange={(e) => edit(i, 'command', e.target.value)} onBlur={() => commit(rows)} />
          <Tooltip content={tr(T.removeCheck)}>
            <button className="btn subtle small" aria-label={tr(T.removeCheck)} onClick={() => change(rows.filter((_x, j) => j !== i))}>
              <Icon name="close" />
            </button>
          </Tooltip>
        </div>
      ))}
      <button className="btn subtle small" onClick={() => change([...rows, { name: `check${rows.length + 1}`, command: '' }])}>
        {tr(T.addCheck)}
      </button>
    </div>
  )
}

/** What a save changes, the lanes keeping the old rules, and the cards in flight to apply the change to (OP-38). */
function SaveDetails({ changes, check, picked }: { changes: string[]; check: { lanes: { id: string; name: string | null; builder: string }[]; inFlight: { number: number; title: string }[] }; picked: Set<number> }) {
  const [, redraw] = useState(0)
  const tasks = useStore((s) => s.tasks)
  return (
    <div className="workflow-save">
      {changes.length ? (
        <>
          <p>{tr(T.changesHead)}</p>
          <ul className="workflow-changes">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>{tr(T.noChanges)}</p>
      )}
      {check.lanes.length > 0 && (
        <>
          <p>{tr(T.lanes, { n: check.lanes.length })}</p>
          <ul>
            {check.lanes.map((l) => (
              <li key={l.id}>{l.name ? tr(T.lane, { builder: l.builder, name: l.name }) : tr(T.laneUnnamed, { builder: l.builder })}</li>
            ))}
          </ul>
        </>
      )}
      {check.inFlight.length > 0 && (
        <>
          <p>{tr(T.inFlight, { n: check.inFlight.length })}</p>
          {check.inFlight.map((c) => (
            <label className="workflow-card" key={c.number}>
              <input
                type="checkbox"
                checked={picked.has(c.number)}
                onChange={(e) => {
                  if (e.target.checked) picked.add(c.number)
                  else picked.delete(c.number)
                  redraw((n) => n + 1)
                }}
              />{' '}
              {cardLabelOf({ tasks }, c.number)} {c.title}
            </label>
          ))}
        </>
      )}
    </div>
  )
}

const N = {
  text: msg({ id: 'workflow.presetsNotice.text', defaultMessage: '{n, plural, one {{projects} works} other {{projects} work}} as before this version. A preset sets up a workflow in one click: who reviews the work, which checks pass first and who merges.', description: 'The one-time notice after the upgrade to 1.0 (glossary 2.1: preset, workflow). {projects} is a list of project names; {n} how many.' }),
  choose: msg({ id: 'workflow.presetsNotice.choose', defaultMessage: 'Choose…', description: 'A button of the one-time presets notice: opens Project Settings → Workflow.' }),
  notNow: msg({ id: 'workflow.presetsNotice.notNow', defaultMessage: 'Not Now', description: 'A button of the one-time presets notice: dismisses it for good.' })
}

/**
 * The one-time notice after the upgrade (§16.17, OP-22): the projects kept today's way of working, and the presets on
 * offer. Choose… opens the first one's Workflow section; either answer is the last time it shows in the workspace.
 */
export function PresetsNotice() {
  const workspace = useStore((s) => s.workspace)
  const readOnly = useStore((s) => s.boardState?.readOnly ?? null)
  const [projects, setProjects] = useState<{ path: string; name: string }[] | null>(null)
  useEffect(() => {
    if (!workspace?.path || readOnly !== null) return setProjects(null)
    let live = true
    call('workflow:presetsNotice')
      .then((p) => live && setProjects(p))
      .catch(() => live && setProjects(null))
    return () => {
      live = false
    }
  }, [workspace, readOnly])
  if (!projects?.length) return null
  const answer = (choose: boolean): void => {
    if (choose) openProjectSettings(projects[0].path, 'workflow')
    setProjects(null)
    void call('workflow:presetsNoticeSaid').catch((e) => notify('error', errorMessage(e)))
  }
  return (
    <div className="banner info presets-notice" role="status">
      <Icon name="info" />
      <span className="grow">{tr(N.text, { projects: fmt.list(projects.map((p) => p.name)), n: projects.length })}</span>
      <button className="btn small primary" onClick={() => answer(true)}>
        {tr(N.choose)}
      </button>
      <button className="btn small subtle" onClick={() => answer(false)}>
        {tr(N.notNow)}
      </button>
    </div>
  )
}
