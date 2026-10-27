import { pairedShown, type SettingShown, type TemplateLoadView } from '@shared/templateLoad'
import { isKnownProvider } from '@shared/providers'
import type { ConnectionsView } from '@shared/accounts'
import type { ConnectionProblem, ProviderId, TemplateLoadPlan } from '@shared/types'
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
  connection: msg({ id: 'assistant.templatePlan.connection', defaultMessage: 'Connection', description: "Load template's table (HI-1769, with Connections on): the column of the connection each agent runs on (a login or service its coding agent CLI uses)." }),
  connectionDefault: msg({ id: 'assistant.templatePlan.connectionDefault', defaultMessage: "Workspace's default ({name})", description: "Load template's table, the Connection column (HI-1769): the agent follows the workspace's default connection for its CLI ({name}); also the first choice of the box for an agent whose own connection can't be used here." }),
  connectionNone: msg({ id: 'assistant.templatePlan.connectionNone', defaultMessage: "Workspace's default (none on: it can't start)", description: "Load template's table, the Connection column (HI-1769): the agent follows the workspace's default connection for its CLI, but none is on, so it can't start until one is." }),
  connectionLabel: msg({ id: 'assistant.templatePlan.connectionLabel', defaultMessage: 'Connection of {agent}', description: "Load template's table (HI-1769): the accessible name of the box choosing the connection of the agent {agent}." }),
  missing: msg({ id: 'assistant.templatePlan.connectionMissing', defaultMessage: '{name}: no connection with that id here', description: "Load template's table, the Connection column (HI-1769): the template's agent ran on a connection ({name}, its name when saved) that this machine doesn't have (never matched by name). The box under it chooses another." }),
  off: msg({ id: 'assistant.templatePlan.connectionOff', defaultMessage: '{name}: off in this workspace', description: "Load template's table, the Connection column (HI-1769): the template's agent ran on a connection ({name}) that is off in this workspace. The box under it chooses another." }),
  otherCli: msg({ id: 'assistant.templatePlan.connectionOtherCli', defaultMessage: "{name}: another CLI's connection", description: "Load template's table, the Connection column (HI-1769): the template's agent names a connection ({name}) of another coding agent CLI than its own. The box under it chooses one of its own CLI's." }),
  unnamed: msg({ id: 'assistant.templatePlan.connectionUnnamed', defaultMessage: 'Its connection', description: "Load template's table, the Connection column (HI-1769): stands for the name of a template agent's connection when the template doesn't say it, before \": no connection with that id here\"." }),
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
export function TemplatePlan({ view, edit, connections }: { view: TemplateLoadView; edit?: NameEdit; connections?: ConnectionEdit }) {
  const goes = new Map(view.removed.map((a) => [a.name.toLowerCase(), a]))
  // The Connection column only where one of its agents' CLIs has connections shown (HI-1769).
  const conn = connections && connections.view.preview && view.created.some((a) => isKnownProvider(a.provider) && connections.view.providers.includes(a.provider)) ? connections : undefined
  const columns = conn ? 7 : 6
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
            {conn && <th>{tr(M.connection)}</th>}
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
                  <td className="template-plan-model">
                    <Setting s={a.model} />
                  </td>
                  <td>{a.effort ? <Setting s={a.effort} /> : <span className="faint">—</span>}</td>
                  <td>{a.mode ? <Setting s={a.mode} /> : <span className="faint">—</span>}</td>
                  {conn && (isKnownProvider(a.provider) && conn.view.providers.includes(a.provider) ? <ConnectionCell edit={conn} index={i} provider={a.provider} agent={edit?.names[i] ?? a.name} /> : <td><span className="faint">—</span></td>)}
                </tr>
                {old && (
                  <tr data-old-of={a.name} className="template-plan-old-row">
                    <td />
                    <td colSpan={columns}>{oldNote(old)}</td>
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
                <td colSpan={columns - 1}>{a.note && oldNote(a.note)}</td>
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

/**
 * The Connection column (HI-1769, with Connections on): each agent's connection, and for each one `flagged` (its own can't
 * be used here: by `create`'s index) the box choosing another: the workspace's default first (null: it follows it), then
 * its CLI's connections on here, each pinned by id. Never matched by name, never another CLI's.
 */
export interface ConnectionEdit {
  view: ConnectionsView
  own: (string | undefined)[]
  flagged: TemplateLoadPlan['connections']
  choices: Record<number, string | null>
  onChoice: (index: number, id: string | null) => void
}

const PROBLEM: Record<ConnectionProblem, Msg> = { missing: M.missing, off: M.off, otherCli: M.otherCli }

function ConnectionCell({ edit, index, provider, agent }: { edit: ConnectionEdit; index: number; provider: ProviderId; agent: string }) {
  const { view } = edit
  const ws = view.workspace[provider]
  const on = view.connections.filter((c) => c.provider === provider && ws?.on.includes(c.id))
  const def = ws?.default ? view.connections.find((c) => c.id === ws.default) : undefined
  const followsDefault = def ? tr(M.connectionDefault, { name: def.name }) : tr(M.connectionNone)
  const flag = edit.flagged.find((f) => f.index === index)
  const own = edit.own[index]
  if (!flag) {
    const name = own ? view.connections.find((c) => c.id === own)?.name : undefined
    return (
      <td className="template-plan-connection" data-connection={own ?? ''}>
        {name ? (
          <>
            <Icon name="check" /> {name}
          </>
        ) : (
          <span className="faint">{followsDefault}</span>
        )}
      </td>
    )
  }
  const choice = edit.choices[index] ?? null
  return (
    <td className="template-plan-connection" data-connection={flag.id} data-connection-problem={flag.problem}>
      <div className="template-plan-connection-problem">
        <Icon name="warning" /> {tr(PROBLEM[flag.problem], { name: flag.name ?? tr(M.unnamed) })}
      </div>
      <select className="input" aria-label={tr(M.connectionLabel, { agent })} value={choice ?? ''} onChange={(e) => edit.onChoice(index, e.target.value || null)}>
        <option value="">{followsDefault}</option>
        {on.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </td>
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
  const text = <span className="template-plan-setting">{s.text}</span>
  return <>{s.isDefault ? withNote(text, tr(M.isDefault), 'faint template-plan-default') : text}</> // i18n-ignore: class names
}
