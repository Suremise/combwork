import { pairedShown, type SettingShown, type TemplateLoadView } from '@shared/templateLoad'
import { isKnownProvider } from '@shared/providers'
import { WORKFLOW_ROLE_TEXT } from '@shared/workflow/roles'
import { ProviderIcon } from './ProviderIcon'
import { Icon } from './ui'
import { AGENT_NAME_MAX } from '@shared/agentNames'
import { cx } from '../util'
import { locale, msg, tr, tRich, type Msg } from '@shared/i18n'
import { Children, Fragment, type ReactNode } from 'react'

const M = {
  noteSentence: msg({ id: 'assistant.templatePlan.noteSentence', defaultMessage: '{note}.', description: "Load template, under an agent that goes: what happens to its worktree ({note}), as a sentence (its first letter made a capital). Use your language's full stop." }),
  state: msg({ id: 'assistant.templatePlan.state', defaultMessage: 'Change', description: "Load template's table (#1315): the column saying what happens to each agent (replaced, new, removed)." }),
  stateReplaced: msg({ id: 'assistant.templatePlan.stateReplaced', defaultMessage: 'replaced', description: "Load template's table, the Change column: the template's agent replaces the project's agent of the same name. Lower case, a badge." }),
  stateNew: msg({ id: 'assistant.templatePlan.stateNew', defaultMessage: 'new', description: "Load template's table, the Change column: an agent the project doesn't have yet. Lower case, a badge." }),
  stateRemoved: msg({ id: 'assistant.templatePlan.stateRemoved', defaultMessage: 'removed', description: "Load template's table, the Change column: a project agent the template has none of: it goes. Lower case, a badge." }),
  stateReplacedTip: msg({ id: 'assistant.templatePlan.stateReplacedTip', defaultMessage: 'A new agent with these settings replaces the agent of the same name.', description: "Load template's table: tooltip on replaced." }),
  stateNewTip: msg({ id: 'assistant.templatePlan.stateNewTip', defaultMessage: 'An agent the project doesn’t have yet.', description: "Load template's table: tooltip on new." }),
  stateRemovedTip: msg({ id: 'assistant.templatePlan.stateRemovedTip', defaultMessage: 'The template has no agent of this name, so this one goes.', description: "Load template's table: tooltip on removed." }),
  agent: msg({ id: 'assistant.templatePlan.agent', defaultMessage: 'Agent', description: "Load template's table: the column of the agents' names." }),
  role: msg({ id: 'assistant.templatePlan.role', defaultMessage: 'Role', description: "Load template's table: the column of each agent's role in the workflow (Builder, Reviewer, Either; glossary: workflow role)." }),
  codingAgent: msg({ id: 'assistant.templatePlan.codingAgent', defaultMessage: 'Coding agent', description: "Load template's table: the column of each agent's CLI (Claude Code, Codex…)." }),
  model: msg({ id: 'assistant.templatePlan.model', defaultMessage: 'Model', description: "Load template's table: a column." }),
  effort: msg({ id: 'assistant.templatePlan.effort', defaultMessage: 'Effort', description: "Load template's table: a column (the model's reasoning effort)." }),
  mode: msg({ id: 'assistant.templatePlan.mode', defaultMessage: 'Mode', description: "Load template's table: a column (the permission mode)." }),
  fromTip: msg({ id: 'assistant.templatePlan.fromTip', defaultMessage: 'Its name in the template', description: "Load template's table: tooltip on an agent's name as the template has it, beside the box for its new name." }),
  nameLabel: msg({ id: 'assistant.templatePlan.nameLabel', defaultMessage: 'Name of agent {n}', description: "Load template's table: the accessible name of the box for agent number {n}'s name." }),
  withNote: msg({ id: 'assistant.templatePlan.withNote', defaultMessage: '{thing} <faint>{note}</faint>', description: "Load template: a name or a setting ({thing}), then a note about it in brackets ({note}, which brings its brackets: \"(default)\"), greyed. Keep the <faint> tags around {note}. Japanese and Chinese: no space before full-width brackets." }),
  isDefault: msg({ id: 'assistant.templatePlan.default', defaultMessage: '(default)', description: "Load template's table, after a model, effort or mode: the template leaves it to the project's or Hive's defaults." })
}

/** A note's first letter as a capital, in the window's language. */
const capitalised = (s: string): string => s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1)

type State = 'replaced' | 'new' | 'removed'
const STATE: Record<State, { label: Msg; tip: Msg; tone: string }> = {
  replaced: { label: M.stateReplaced, tip: M.stateReplacedTip, tone: '' },
  new: { label: M.stateNew, tip: M.stateNewTip, tone: 'accent' },
  removed: { label: M.stateRemoved, tip: M.stateRemovedTip, tone: 'warn' }
}

/** What happens to an agent (#1315): its badge, with what it means on hover. */
function Change({ state }: { state: State }) {
  return (
    <td className="template-plan-state">
      <span className={cx('badge', STATE[state].tone)} title={tr(STATE[state].tip)}>
        {tr(STATE[state].label)}
      </span>
    </td>
  )
}

/** What becomes of an old agent's worktree, as a sentence (#1315: in the room its row has, never a narrow column). */
const oldNote = (note: string): ReactNode => <span className="faint template-plan-old">{tr(M.noteSentence, { note: capitalised(note) })}</span>

/**
 * The Load template dialog's plan (#511, one table since #1315): a row an agent, Agent · Change · Role · Coding agent ·
 * Model · Effort · Mode: the template's agents in its order, each replacing the project's agent of its name or new, then
 * the project's agents it has none of, removed. An agent's note is under its name, the agent it is paired with under its
 * role, and another provider than the template's (#1436) under its coding agent, saying why. What becomes of a removed
 * agent's worktree is said across its row's settings (it has none), a replaced one's on a line under its row. What the
 * template leaves to the defaults is shown as what it is here with a muted "(default)"; then the notes, said once.
 */
export function TemplatePlan({ view, edit }: { view: TemplateLoadView; edit?: NameEdit }) {
  const goes = new Map(view.removed.map((a) => [a.name.toLowerCase(), a]))
  return (
    <div className="template-plan">
      <table className="table template-plan-table">
        <thead>
          <tr>
            <th>{tr(M.agent)}</th>
            <th>{tr(M.state)}</th>
            <th>{tr(M.role)}</th>
            <th>{tr(M.codingAgent)}</th>
            <th>{tr(M.model)}</th>
            <th>{tr(M.effort)}</th>
            <th>{tr(M.mode)}</th>
          </tr>
        </thead>
        <tbody>
          {view.created.map((a, i) => {
            const old = a.replaces ? goes.get(a.name.toLowerCase())?.note : undefined
            return (
              // By place while names are edited: a key that changed with each key press would lose the field's focus.
              <Fragment key={edit ? i : a.name}>
                <tr data-agent={a.name} data-state={a.replaces ? 'replaced' : 'new'} className={cx(old && 'template-plan-has-old')}>
                  <td>
                    {edit ? (
                      <>
                        <span className="template-plan-from" title={tr(M.fromTip)}>
                          {edit.from[i]}
                        </span>
                        <Icon name="arrow-right" className="template-plan-arrow" />
                        <input className={cx(/* i18n-ignore: class names */ 'input template-plan-name-input', edit.problems[i] && 'invalid')} aria-label={tr(M.nameLabel, { n: i + 1 })} value={edit.names[i] ?? ''} maxLength={AGENT_NAME_MAX} onChange={(e) => edit.onName(i, e.target.value)} />
                        {edit.problems[i] && <div className="field-error">{edit.problems[i]}</div>}
                      </>
                    ) : (
                      <span className="template-plan-name">{a.name}</span>
                    )}
                    {a.note && <div className="faint">{a.note}</div>}
                  </td>
                  <Change state={a.replaces ? 'replaced' : 'new'} />
                  <td className="template-plan-role" data-role={a.role}>
                    {tr(WORKFLOW_ROLE_TEXT[a.role].name)}
                    {a.pairedWith && <div className="faint" data-paired-with={a.pairedWith}>{pairedShown(a.pairedWith)}</div>}
                  </td>
                  <td>
                    <span className="badge template-plan-provider">
                      {isKnownProvider(a.provider) && <ProviderIcon provider={a.provider} />}
                      {a.providerName}
                    </span>
                    {a.swapped && (
                      <div className="faint template-plan-swapped" data-swapped>
                        <Icon name="info" /> {a.swapped}
                      </div>
                    )}
                  </td>
                  <td>
                    <Setting s={a.model} />
                  </td>
                  <td>{a.effort ? <Setting s={a.effort} /> : <span className="faint">—</span>}</td>
                  <td>{a.mode ? <Setting s={a.mode} /> : <span className="faint">—</span>}</td>
                </tr>
                {old && (
                  <tr data-old-of={a.name} className="template-plan-old-row">
                    <td />
                    <td colSpan={6}>{oldNote(old)}</td>
                  </tr>
                )}
              </Fragment>
            )
          })}
          {view.removed
            .filter((a) => !a.replaced)
            .map((a) => (
              <tr key={`removed#${a.name}`} data-agent={a.name} data-state="removed" className="template-plan-removed-row">
                <td>
                  <span className="template-plan-name">{a.name}</span>
                </td>
                <Change state="removed" />
                <td colSpan={5}>{a.note && oldNote(a.note)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {view.notes.map((n) => (
        <p key={n} className="template-plan-note">
          {n}
        </p>
      ))}
    </div>
  )
}

/** The created agents' names, editable in the Load template dialog (#702) beside the template's own (`from`), each with why it can't be used. */
export interface NameEdit {
  from: string[]
  names: string[]
  problems: (string | null)[]
  onName: (index: number, name: string) => void
}

/** A name or setting with a note in brackets after it, spaced as the language does (#893: none before （ in Japanese). */
function withNote(thing: ReactNode, note: string, className: string): ReactNode[] {
  return Children.toArray(tRich<ReactNode>(M.withNote, { thing, note, faint: (chunks) => <span className={className}>{chunks}</span> }))
}

function Setting({ s }: { s: SettingShown }) {
  return <>{s.isDefault ? withNote(s.text, tr(M.isDefault), 'faint template-plan-default') : s.text}</> // i18n-ignore: class names
}
