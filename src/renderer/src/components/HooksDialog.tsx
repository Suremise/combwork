import { useEffect, useState } from 'react'
import { call, errorMessage } from '../api'
import { findProject, set, useStore } from '../store'
import { msg, tr } from '@shared/i18n'
import { formatTime } from '@shared/dates'
import { groupFired, type HookNote, type SessionHooks } from '@shared/hooks'
import { Icon, IconButton, LoadFailed, Modal } from './ui'

/**
 * An agent's Hooks dialog (HI-982): what its launch has (Hive's own as passed, and the CLI's others, each saying how sure
 * Hive is) and what Hive received, read when it opens and on Refresh. Read-only: nothing here changes a hook. An answer
 * for a launch that has since ended or restarted is said to be one, never shown as the current launch's.
 */
export function HooksDialog() {
  const target = useStore((s) => s.hooksFor)
  const project = useStore((s) => findProject(s, s.hooksFor?.project))
  const agent = project?.agents.find((a) => a.id === target?.agentId) ?? null
  const [data, setData] = useState<SessionHooks | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const path = target?.project
  const agentId = target?.agentId
  useEffect(() => {
    setData(undefined)
    setError(null)
    if (!path || !agentId) return
    let current = true
    void call('session:hooks', path, agentId).then(
      (d) => current && setData(d),
      (e) => current && setError(errorMessage(e))
    )
    return () => {
      current = false
    }
  }, [path, agentId, attempt])
  if (!target || !project || !agent) return null
  const close = (): void => set({ hooksFor: null })
  const liveRun = agent.live?.runId ?? null
  const stale = !!data && data.runId !== liveRun
  return (
    <Modal
      title={tr(M.title, { agent: agent.name })}
      icon="plug"
      wide
      onClose={close}
      footer={
        <button className="btn subtle" onClick={close}>
          {tr(M.close)}
        </button>
      }
    >
      <div className="flex hooks-head">
        <p className="muted grow">{tr(M.what)}</p>
        <IconButton icon="refresh" title={tr(M.refresh)} onClick={() => setAttempt((n) => n + 1)} />
      </div>
      {error ? (
        <LoadFailed what={tr(M.loadWhat)} error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : data === undefined ? (
        <p className="muted">{tr(M.loading)}</p>
      ) : data === null ? (
        <p className="muted" data-hooks="none">
          {tr(M.notRunning)}
        </p>
      ) : (
        <div className="hooks-body" data-run={data.runId}>
          {stale && (
            <p className="hooks-stale" data-hooks="stale">
              <Icon name="warning" /> {tr(M.stale)}{' '}
              <button className="link" onClick={() => setAttempt((n) => n + 1)}>
                {tr(M.refresh)}
              </button>
            </p>
          )}
          <h3 className="hooks-heading">{tr(M.loadedHeading)}</h3>
          <p className="faint">{tr(data.listing.basis === 'cli' ? M.basisCli : M.basisLaunch)}</p>
          {data.listing.notes.map((n, i) => (
            <p key={i} className="hooks-note muted" data-note={n.kind}>
              <Icon name="info" /> {noteText(n)}
            </p>
          ))}
          <div className="table-wrap">
            <table className="table hooks-table" data-table="loaded">
              <thead>
                <tr>
                  <th>{tr(M.colEvent)}</th>
                  <th>{tr(M.colSource)}</th>
                  <th>{tr(M.colCommand)}</th>
                  <th>{tr(M.colStatus)}</th>
                </tr>
              </thead>
              <tbody>
                {data.listing.rows.map((r, i) => (
                  <tr key={i} data-source={r.source} data-status={r.status}>
                    <td>
                      {r.event}
                      {r.matcher && <span className="faint"> ({r.matcher})</span>}
                    </td>
                    <td title={r.file}>{tr(M.source, { source: r.source })}</td>
                    <td className="hooks-command" title={r.command}>
                      <code>{r.command}</code>
                      {r.truncated && <span className="faint"> {tr(M.truncated)}</span>}
                    </td>
                    <td>
                      {tr(M.status, { status: r.status })}
                      {r.why && <div className="faint">{r.why}</div>}
                      {!r.observed && <div className="faint">{tr(M.notObserved)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="hooks-heading">{tr(M.firedHeading)}</h3>
          <p className="faint">{tr(M.firedWhat)}</p>
          {data.fired.length === 0 ? (
            <p className="muted" data-fired="none">
              {tr(M.noneFired)}
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table hooks-table" data-table="fired">
                <thead>
                  <tr>
                    <th>{tr(M.colTime)}</th>
                    <th>{tr(M.colEvent)}</th>
                    <th>{tr(M.colReply)}</th>
                    <th>{tr(M.colLedger)}</th>
                    <th>{tr(M.colMs)}</th>
                  </tr>
                </thead>
                <tbody>
                  {groupFired(data.fired).map((g, i) => (
                    <tr key={i} data-response={g.first.response} data-ledger={g.first.ledger}>
                      <td>{g.count > 1 ? tr(M.timeSpan, { from: formatTime(g.last.at), to: formatTime(g.first.at) }) : formatTime(g.first.at)}</td>
                      <td>
                        {g.count > 1 && <span className="hooks-count">{tr(M.count, { n: g.count })} </span>}
                        {g.first.event}
                        <div className="faint">{tr(M.receiver, { form: g.first.receiver })}</div>
                      </td>
                      <td title={g.first.why}>
                        {tr(M.response, { response: g.first.response })}
                        {g.first.why && <div className="faint hooks-why">{g.first.why}</div>}
                      </td>
                      <td title={g.first.ledgerWhy}>
                        {tr(M.ledger, { ledger: g.first.ledger })}
                        {g.first.ledgerWhy && <div className="faint hooks-why">{g.first.ledgerWhy}</div>}
                      </td>
                      <td>{tr(M.ms, { ms: g.first.ms })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

/** A listing's note, as a sentence. */
function noteText(n: HookNote): string {
  switch (n.kind) {
    case 'unreadable':
      return tr(M.noteUnreadable, { file: n.file, why: n.why })
    case 'notJson':
      return tr(M.noteNotJson, { file: n.file })
    case 'changed':
      return tr(M.noteChanged, { file: n.file })
    case 'cliUnknown':
      return tr(M.noteCliUnknown, { why: n.why })
    case 'more':
      return tr(M.noteMore, { n: n.count })
    case 'othersUnread':
      return tr(M.noteOthers)
    case 'unsure':
      return tr(M.noteUnsure, { what: n.what, why: n.why })
  }
}

const M = {
  title: msg({ id: 'hooks.title', defaultMessage: 'Hooks: {agent}', description: "The title of an agent's Hooks dialog (its ⋯ menu → Hooks…). {agent} is the agent's name." }),
  close: msg({ id: 'hooks.close', defaultMessage: 'Close', description: "The Hooks dialog's button that closes it." }),
  refresh: msg({ id: 'hooks.refresh', defaultMessage: 'Refresh', description: "The Hooks dialog's button that reads the agent's hooks again." }),
  what: msg({ id: 'hooks.what', defaultMessage: "The hooks this agent's session has, and what Combwork received from them. Combwork only shows them here: it never changes or turns off a hook.", description: "What an agent's Hooks dialog shows (at its top)." }),
  loadWhat: msg({ id: 'hooks.loadWhat', defaultMessage: "the agent's hooks", description: 'Fills "Could not load {what}" when the Hooks dialog fails to load.' }),
  loading: msg({ id: 'hooks.loading', defaultMessage: 'Reading…', description: 'The Hooks dialog while it reads the agent\'s hooks.' }),
  notRunning: msg({ id: 'hooks.notRunning', defaultMessage: "The agent isn't running: its hooks are listed while it runs.", description: "The Hooks dialog for an agent that isn't running." }),
  stale: msg({ id: 'hooks.stale', defaultMessage: 'The agent has restarted since this was read: it shows its earlier session.', description: 'The Hooks dialog, when the agent restarted after its hooks were read; a Refresh link follows.' }),
  loadedHeading: msg({ id: 'hooks.loadedHeading', defaultMessage: "What's loaded", description: "A heading in the Hooks dialog, over the hooks the agent's session has." }),
  basisCli: msg({ id: 'hooks.basisCli', defaultMessage: "As the coding agent lists them now for this session's settings. The session read its own when it started.", description: "Under What's loaded in the Hooks dialog: where the list comes from (the CLI's own listing, asked now)." }),
  basisLaunch: msg({ id: 'hooks.basisLaunch', defaultMessage: "As the session's settings files were when it started. The coding agent doesn't say which of them it loaded.", description: "Under What's loaded in the Hooks dialog: where the list comes from (its settings files, as read when the session started)." }),
  colEvent: msg({ id: 'hooks.col.event', defaultMessage: 'Event', description: 'A column of the Hooks dialog: the hook event (SessionStart, PreToolUse…).' }),
  colSource: msg({ id: 'hooks.col.source', defaultMessage: 'From', description: 'A column of the Hooks dialog: where a hook comes from (Combwork, the user, the project…).' }),
  colCommand: msg({ id: 'hooks.col.command', defaultMessage: 'Runs', description: 'A column of the Hooks dialog: the command or address a hook runs.' }),
  colStatus: msg({ id: 'hooks.col.status', defaultMessage: 'Loaded', description: 'A column of the Hooks dialog: whether the hook is loaded, and how sure Combwork is.' }),
  source: msg({ id: 'hooks.source', defaultMessage: "{source, select, combwork {Combwork} managed {Managed settings} cli {Command line} project {Project} local {Project (local)} user {User} plugin {Plugin} other {Other}}", description: "Where a hook comes from, in the Hooks dialog's From column." }),
  status: msg({ id: 'hooks.status', defaultMessage: '{status, select, passed {Passed by Combwork} trusted {Trusted} untrusted {Not trusted: won\'t run} modified {Changed since trusted: won\'t run} unverified {Configured · loading unverified} disabled {Turned off} notLoaded {Not loaded} unsupported {Unknown form} other {Unknown}}', description: "How sure Combwork is that a hook is loaded, in the Hooks dialog's Loaded column. Trusted, Not trusted and Changed since trusted are the coding agent's own trust in a hook." }),
  truncated: msg({ id: 'hooks.truncated', defaultMessage: '(cut short)', description: "In the Hooks dialog, after a hook's command that was too long to show whole." }),
  notObserved: msg({ id: 'hooks.notObserved', defaultMessage: 'Not observed by Combwork', description: "In the Hooks dialog, under a hook that isn't Combwork's: Combwork never sees when it runs." }),
  firedHeading: msg({ id: 'hooks.firedHeading', defaultMessage: 'What fired', description: "A heading in the Hooks dialog, over the hooks Combwork received from the agent's session." }),
  firedWhat: msg({ id: 'hooks.firedWhat', defaultMessage: "Combwork's own hooks it received, newest first (the last 50): Combwork's reply, and what Combwork made of it. Other hooks aren't seen by Combwork.", description: 'Under What fired in the Hooks dialog.' }),
  noneFired: msg({ id: 'hooks.noneFired', defaultMessage: 'None received yet.', description: 'Under What fired in the Hooks dialog, before any hook came.' }),
  colTime: msg({ id: 'hooks.col.time', defaultMessage: 'When', description: 'A column of the Hooks dialog: when Combwork received a hook.' }),
  colReply: msg({ id: 'hooks.col.reply', defaultMessage: "Combwork's reply", description: 'A column of the Hooks dialog: what Combwork answered the hook.' }),
  colLedger: msg({ id: 'hooks.col.ledger', defaultMessage: 'Taken as', description: "A column of the Hooks dialog: what Combwork made of the hook for the agent's status (applied, or ignored and why)." }),
  colMs: msg({ id: 'hooks.col.ms', defaultMessage: 'Combwork took', description: 'A column of the Hooks dialog: how long Combwork took to handle the hook (not how long a hook command ran).' }),
  timeSpan: msg({ id: 'hooks.timeSpan', defaultMessage: '{from}–{to}', description: 'In the Hooks dialog, the times of the first and last of several hooks alike shown as one row.' }),
  count: msg({ id: 'hooks.count', defaultMessage: '{n, number} ×', description: 'In the Hooks dialog, before a hook event shown once for several alike in a row ("34 × Stop").' }),
  receiver: msg({ id: 'hooks.receiver', defaultMessage: "through Combwork's {form} hook", description: "In the Hooks dialog, under a hook event: which of Combwork's hooks it came through. {form} is its form (http, command): keep it." }),
  response: msg({ id: 'hooks.response', defaultMessage: '{response, select, none {Nothing to say} context {Sent context} allowed {Allowed} warned {Allowed, with a warning} asked {Asked you} blocked {Blocked} error {Error} other {Unknown}}', description: "Combwork's reply to a hook, in the Hooks dialog's Combwork's reply column. Allowed is only what Combwork answered, not any other hook's answer." }),
  ledger: msg({ id: 'hooks.ledger', defaultMessage: '{ledger, select, applied {Applied} continued {Carried on by Combwork} ignored {Ignored} other {Not reached}}', description: "What Combwork made of a hook for the agent's status, in the Hooks dialog's Taken as column. Ignored is followed by why (an earlier turn's, a duplicate…)." }),
  ms: msg({ id: 'hooks.ms', defaultMessage: '{ms, number} ms', description: 'How long Combwork took to handle a hook, in milliseconds, in the Hooks dialog.' }),
  noteUnreadable: msg({ id: 'hooks.note.unreadable', defaultMessage: "{file} couldn't be read ({why}): its hooks aren't listed.", description: "A note in the Hooks dialog: a settings file Combwork couldn't read. {why} says why." }),
  noteNotJson: msg({ id: 'hooks.note.notJson', defaultMessage: "{file} isn't valid JSON, so the coding agent skips it: its hooks aren't listed.", description: "A note in the Hooks dialog: a settings file isn't JSON." }),
  noteChanged: msg({ id: 'hooks.note.changed', defaultMessage: "{file} has changed since the session started. This list is the session's start; what it loads now isn't known.", description: 'A note in the Hooks dialog: a settings file changed after the session started.' }),
  noteCliUnknown: msg({ id: 'hooks.note.cliUnknown', defaultMessage: "The coding agent couldn't list its hooks ({why}): only Combwork's are shown, and whether others load isn't known.", description: "A note in the Hooks dialog: asking the CLI for its hooks failed. {why} says why (the CLI's or the system's words)." }),
  noteMore: msg({ id: 'hooks.note.more', defaultMessage: '{n, plural, one {# more hook} other {# more hooks}} not listed.', description: 'A note in the Hooks dialog: a source has more hooks than the dialog lists.' }),
  noteOthers: msg({ id: 'hooks.note.othersUnread', defaultMessage: 'The coding agent may also load hooks Combwork doesn\'t read (its own plugins, the folder\'s). Only Combwork\'s are listed.', description: "A note in the Hooks dialog for a CLI whose other hooks Combwork doesn't read." }),
  noteUnsure: msg({ id: 'hooks.note.unsure', defaultMessage: '{what}: {why}', description: "A note in the Hooks dialog: an argument that leaves Combwork unsure what the CLI reads ({what}, such as --bare) and why." })
}
