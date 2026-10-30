import { useEffect, useState } from 'react'
import type { ProviderId } from '@shared/types'
import { isKnownProvider, providerName } from '@shared/providers'
import { ALL_KEY, answerFor, initialPicker, pickerAnswers, rolesOf, suggestedCli, type ConnectionAnswers, type ConnectionOption, type ConnectionsPlan, type PickedAgent, type PickerState } from '@shared/templateConnections'
import { connectionValues } from '@shared/templateLoad'
import { WORKFLOW_ROLE_TEXT, type WorkflowRole } from '@shared/workflow/roles'
import { msg, tr } from '@shared/i18n'
import { useStore } from '../store'
import { ProviderIcon } from './ProviderIcon'
import { Icon } from './ui'

/**
 * The connection picker of the template dialogs (HI-2109, HI-2105's wireframe): Load template's Connections section and
 * Choose Connections… on a project's agents. Same for all (one picker), else a row per role the agents have; Per agent
 * unfolds a row per agent, over its role's. A template keeps no connection: a role's picker starts on the first
 * connection on the CLI its agents suggest, else the first usable (shared/templateConnections.ts).
 */

const M = {
  heading: msg({ id: 'assistant.templateConnections.heading', defaultMessage: 'Connections', description: 'Heading of the Load template and Choose Connections dialogs\' section choosing which connection (a named setup on an account: model, effort, mode) the agents run on (HI-2109).' }),
  same: msg({ id: 'assistant.templateConnections.same', defaultMessage: 'Same for all', description: 'A tick box in the Connections section (HI-2109): one connection for every agent, in place of one per role.' }),
  roleRow: msg({ id: 'assistant.templateConnections.roleRow', defaultMessage: '{role, select, builder {Builders} reviewer {Reviewers} either {Either} other {Generalists}}', description: 'A row of the Connections section (HI-2109): the agents of one role in the workflow (glossary: builder, reviewer, either, generalist), as a plural group. either: the agents that build or review.' }),
  suggests: msg({ id: 'assistant.templateConnections.suggests', defaultMessage: 'suggests {cli}', description: "Beside a role's connection choice in Load template (HI-2109): the coding agent CLI the template suggests for that role ({cli}: \"Codex\"), which chose the connection first offered. Lower case." }),
  perAgent: msg({ id: 'assistant.templateConnections.perAgent', defaultMessage: 'Per agent', description: 'A disclosure in the Connections section (HI-2109): opens a connection choice for each agent, over its role\'s.' }),
  roleChoice: msg({ id: 'assistant.templateConnections.roleChoice', defaultMessage: "Its role's", description: "The first choice of an agent's own connection (Per agent, HI-2109): it takes the connection chosen for its role." }),
  keep: msg({ id: 'assistant.templateConnections.keep', defaultMessage: 'Keep each one’s', description: "Choose Connections (HI-2109): the first choice of a role's (or all agents') connection: each agent keeps the connection it has." }),
  keepOwn: msg({ id: 'assistant.templateConnections.keepOwn', defaultMessage: 'Keep its own ({name})', description: "Choose Connections (HI-2109), an agent's own row: it keeps the connection it has ({name})." }),
  label: msg({ id: 'assistant.templateConnections.label', defaultMessage: 'Connection for {who}', description: "Accessible name of a connection choice in the Connections section (HI-2109): {who} is all agents, a role's agents (\"Builders\") or an agent's name." }),
  all: msg({ id: 'assistant.templateConnections.all', defaultMessage: 'all agents', description: 'Stands for {who} in "Connection for {who}" (HI-2109): the Same for all choice. Lower case.' }),
  gone: msg({ id: 'assistant.templateConnections.gone', defaultMessage: 'A connection that can’t be used here', description: 'A choice of connection (HI-2109) that was removed, or whose account is off in this workspace: shown so nothing changes silently.' }),
  none: msg({ id: 'assistant.templateConnections.none', defaultMessage: 'No connection is usable in this workspace yet: agents get one once you add an account in Settings → Accounts & Connections.', description: 'The Connections section (HI-2109) when no connection is usable in this workspace: agents loaded now are made without one, and get one once an account is added. Settings → Accounts & Connections names a section: use its translated names.' })
}

/**
 * One connection choice, with the props HI-2108's ConnectionChoice takes (HB1's, so the switch is an import): `value` a
 * connection's id ('' for `empty`'s choice), `cli` only that CLI's, `unavailable` greys one out saying why, `label`
 * false for a table cell. `options` (the plan's, until the window lists connections itself) are grouped by account, in
 * the order; a value no longer among them stays listed, saying so.
 */
export function TemplateConnectionChoice({ id, value, onChange, cli, unavailable, label, options, empty, ariaLabel }: { id?: string; value: string; onChange: (id: string) => void; cli?: ProviderId; unavailable?: (c: ConnectionOption) => string | null; label?: false; options: readonly ConnectionOption[]; empty?: string; ariaLabel?: string }) {
  const settings = useStore((s) => s.settings)
  const shown = cli ? options.filter((o) => o.cli === cli) : options
  const accounts = [...new Map(shown.map((o) => [o.account, o])).values()]
  return (
    <>
      {label !== false && <label htmlFor={id}>{tr(M.heading)}</label>}
      <select id={id} className="input template-connection-choice" aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
        {empty !== undefined && <option value="">{empty}</option>}
        {accounts.map((a) => (
          <optgroup key={a.account} label={`${a.accountName} · ${isKnownProvider(a.cli) ? providerName(a.cli) : a.cli}`}>
            {shown
              .filter((o) => o.account === a.account)
              .map((o) => {
                const why = unavailable?.(o) ?? null
                return (
                  <option key={o.id} value={o.id} disabled={!!why} title={why ?? undefined}>
                    {`${o.name} — ${connectionValues(o, settings)}`}
                  </option>
                )
              })}
          </optgroup>
        ))}
        {value && !shown.some((o) => o.id === value) && <option value={value}>{tr(M.gone)}</option>}
      </select>
    </>
  )
}

/** The CLI a connection runs, as an icon and the connection's name (a table's cell). */
export function ConnectionName({ option }: { option: ConnectionOption | null }) {
  if (!option) return <span className="faint">—</span>
  return (
    <span className="template-connection-name" data-connection={option.id}>
      {isKnownProvider(option.cli) && <ProviderIcon provider={option.cli} />}
      {option.name}
    </span>
  )
}

/**
 * The Connections section (HI-2109). `keep` (Choose Connections…): each choice starts with "keep" ('') and an agent's own
 * row names the connection it has; without it (a load) each role says the CLI it suggests. `unavailable`: a connection an
 * agent can't take (a running agent's other CLI).
 */
export function ConnectionsSection({ agents, options, state, onState, keep, unavailable }: { agents: readonly (PickedAgent & { current?: string })[]; options: readonly ConnectionOption[]; state: PickerState; onState: (s: PickerState) => void; keep?: boolean; unavailable?: (agent: number | null, c: ConnectionOption) => string | null }) {
  const [open, setOpen] = useState(() => Object.keys(state.agents).length > 0)
  const roles = rolesOf(agents)
  const roleName = (r: WorkflowRole): string => tr(M.roleRow, { role: r })
  // A role's (or all's) choice can't be what any of its agents can't take.
  const groupUnavailable = (members: number[]) => (c: ConnectionOption): string | null => {
    for (const i of members) {
      const why = unavailable?.(i, c)
      if (why) return why
    }
    return null
  }
  const indexes = (role: WorkflowRole | typeof ALL_KEY): number[] => agents.flatMap((a, i) => (role === ALL_KEY || a.role === role ? [i] : []))
  if (!options.length)
    return (
      <div className="template-connections" data-template-connections="">
        <h3 className="agent-dialog-h">{tr(M.heading)}</h3>
        <div className="banner warn">
          <Icon name="warning" /> {tr(M.none)}
        </div>
      </div>
    )
  const own = (i: number): string | undefined => (keep ? options.find((o) => o.id === agents[i].current)?.name : undefined)
  return (
    <div className="template-connections" data-template-connections="">
      <h3 className="agent-dialog-h">{tr(M.heading)}</h3>
      <div className="agent-form template-connections-form">
        <label className="checkbox template-connections-same">
          <input type="checkbox" data-same-for-all="" checked={state.same} onChange={(e) => onState({ ...state, same: e.target.checked })} /> {tr(M.same)}
        </label>
        <div data-connection-for="*">{state.same && <TemplateConnectionChoice label={false} options={options} value={state.all} onChange={(all) => onState({ ...state, all })} ariaLabel={tr(M.label, { who: tr(M.all) })} empty={keep ? tr(M.keep) : undefined} unavailable={groupUnavailable(indexes(ALL_KEY))} />}</div>
        {!state.same &&
          roles.map((r) => {
            const cli = keep ? undefined : suggestedCli(agents, r)
            return (
              <RoleRow key={r} name={roleName(r)} role={r} suggests={cli && isKnownProvider(cli) ? providerName(cli) : undefined}>
                <TemplateConnectionChoice label={false} options={options} value={state.roles[r] ?? ''} onChange={(id) => onState({ ...state, roles: { ...state.roles, [r]: id } })} ariaLabel={tr(M.label, { who: roleName(r) })} empty={keep ? tr(M.keep) : undefined} unavailable={groupUnavailable(indexes(r))} />
              </RoleRow>
            )
          })}
      </div>
      {!state.same && (
        <details className="template-connections-agents" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
          <summary data-per-agent="">{tr(M.perAgent)}</summary>
          <div className="agent-form">
            {agents.map((a, i) => (
              <RoleRow key={i} name={a.name} agent={a.name}>
                <TemplateConnectionChoice
                  label={false}
                  options={options}
                  value={state.agents[i] ?? ''}
                  onChange={(id) => onState({ ...state, agents: Object.fromEntries(Object.entries({ ...state.agents, [i]: id }).filter(([, v]) => v)) })}
                  ariaLabel={tr(M.label, { who: a.name })}
                  // Unset, it takes its role's choice; with none there (Choose Connections…), it keeps its own.
                  empty={!state.roles[a.role] && own(i) ? tr(M.keepOwn, { name: own(i)! }) : tr(M.roleChoice)}
                  unavailable={unavailable ? (c) => unavailable(i, c) : undefined}
                />
              </RoleRow>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

/** A row of the section: its label (a role's agents or an agent), the choice, and the CLI a role suggests. */
function RoleRow({ name, role, agent, suggests, children }: { name: string; role?: WorkflowRole; agent?: string; suggests?: string; children: React.ReactNode }) {
  return (
    <>
      <span className="template-connections-who">{name}</span>
      <div className="flex template-connections-row" data-connection-for={role ?? agent}>
        {children}
        {suggests && <span className="faint template-connections-suggests">{tr(M.suggests, { cli: suggests })}</span>}
      </div>
    </>
  )
}

const CHOOSE = {
  agent: msg({ id: 'assistant.chooseConnections.agent', defaultMessage: 'Agent', description: "Choose Connections' table (HI-2109): the column of the project's agents." }),
  role: msg({ id: 'assistant.chooseConnections.role', defaultMessage: 'Role', description: "Choose Connections' table (HI-2109): each agent's role in the workflow (glossary: workflow role)." }),
  now: msg({ id: 'assistant.chooseConnections.now', defaultMessage: 'Now', description: "Choose Connections' table (HI-2109): the connection each agent has now." }),
  next: msg({ id: 'assistant.chooseConnections.next', defaultMessage: 'After', description: "Choose Connections' table (HI-2109): the connection each agent gets with the choices below (the same as Now when kept)." }),
  running: msg({ id: 'assistant.chooseConnections.running', defaultMessage: 'running', description: "Choose Connections' table (HI-2109), under a running agent's name: it runs now (it keeps its old connection until it restarts). Lower case." }),
  otherCli: msg({ id: 'assistant.chooseConnections.otherCli', defaultMessage: '{agent} runs: another coding agent’s connection only while it is stopped', description: "Why a connection is greyed out in Choose Connections (HI-2109): the agent ({agent}) is running and that connection is another coding agent CLI's (its conversations stay with its CLI)." })
}

/**
 * Choose Connections…' body (HI-2109): the project's agents with the connection each has now and gets after, and the
 * Connections section under it, each choice starting at "keep". A running agent can't take another CLI's connection
 * (greyed out, saying why). `onAnswers` hears what the section answers, by the agents' names.
 */
export function ChooseConnectionsBody({ plan, onAnswers }: { plan: ConnectionsPlan; onAnswers: (a: ConnectionAnswers) => void }) {
  const agents = plan.agents.map((a) => ({ name: a.name, role: a.role, provider: a.provider, current: a.connection }))
  const [state, setState] = useState<PickerState>(() => initialPicker(agents, plan.options, () => ''))
  const answers = pickerAnswers(state, agents)
  const key = JSON.stringify(answers)
  useEffect(() => onAnswers(JSON.parse(key) as ConnectionAnswers), [key, onAnswers])
  const after = answerFor(agents, answers, (a) => (a as (typeof agents)[number]).current)
  const option = (id: string | undefined): ConnectionOption | null => plan.options.find((o) => o.id === id) ?? null
  const unavailable = (i: number | null, c: ConnectionOption): string | null => {
    const a = i === null ? null : plan.agents[i]
    return a && a.running && c.cli !== a.provider ? tr(CHOOSE.otherCli, { agent: a.name }) : null
  }
  return (
    <>
      <table className="table template-plan-table" data-choose-connections="">
        <thead>
          <tr>
            <th>{tr(CHOOSE.agent)}</th>
            <th>{tr(CHOOSE.role)}</th>
            <th>{tr(CHOOSE.now)}</th>
            <th>{tr(CHOOSE.next)}</th>
          </tr>
        </thead>
        <tbody>
          {plan.agents.map((a, i) => (
            <tr key={a.id} data-agent={a.name} data-changes={after[i] !== a.connection ? '' : undefined}>
              <td>
                <span className="template-plan-name">{a.name}</span>
                {a.running && <div className="faint">{tr(CHOOSE.running)}</div>}
              </td>
              <td>{tr(WORKFLOW_ROLE_TEXT[a.role].name)}</td>
              <td>
                <ConnectionName option={option(a.connection)} />
              </td>
              <td className="template-plan-connection" data-connection={after[i] ?? ''}>
                {after[i] !== a.connection ? <ConnectionName option={option(after[i])} /> : <span className="faint">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ConnectionsSection agents={agents} options={plan.options} state={state} onState={setState} keep unavailable={unavailable} />
    </>
  )
}
