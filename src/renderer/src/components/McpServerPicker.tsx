import { useEffect, useState } from 'react'
import type { McpServerInfo } from '@shared/types'
import { mcpServerShown, type McpFilter } from '@shared/agentMcp'
import { msg, tr } from '@shared/i18n'
import { set } from '../store'
import { cx } from '../util'
import { Icon, SearchInput } from './ui'

const M = {
  search: msg({ id: 'mcp.picker.search', defaultMessage: 'Search by name, description or tag', description: "The search box of the MCP view and of the Add server picker (HI-2059): finds servers by their name, description or tags." }),
  filter: msg({ id: 'mcp.picker.filter', defaultMessage: 'Show', description: "Accessible name of the filter beside the MCP servers' search box (All, Added somewhere, Added nowhere)." }),
  all: msg({ id: 'mcp.picker.all', defaultMessage: 'All', description: "The MCP servers' filter: every server." }),
  added: msg({ id: 'mcp.picker.added', defaultMessage: 'Added somewhere', description: "The MCP servers' filter: servers added to a project or the Combwork Assistant." }),
  nowhere: msg({ id: 'mcp.picker.nowhere', defaultMessage: 'Added nowhere', description: "The MCP servers' filter: servers added to no project and not to the Combwork Assistant." }),
  errors: msg({ id: 'mcp.picker.errors', defaultMessage: 'With problems', description: "The MCP view's filter: servers whose definition Combwork can't use." }),
  choose: msg({ id: 'mcp.picker.choose', defaultMessage: 'Choose a server to see what it runs.', description: 'The Add server picker (HI-2059) before a server is chosen; Add stays greyed out until one is.' }),
  allAdded: msg({ id: 'mcp.picker.allAdded', defaultMessage: 'Every server in the workspace is added here already.', description: 'The Add server picker (HI-2059) when every workspace server is added to this project or the Combwork Assistant.' }),
  noMatch: msg({ id: 'mcp.picker.noMatch', defaultMessage: 'No server matches.', description: "The MCP servers' list when nothing matches the search and filter." }),
  runs: msg({ id: 'mcp.picker.runs', defaultMessage: 'It runs:', description: 'The Add server picker (HI-2059): above what the chosen server runs (its command, address, folder, environment).' })
}

/**
 * The search box and filter over a list of MCP servers (HI-2059): the MCP view's and the Add server picker's.
 * `stacked`: each on a row of its own at full width (the sidebar, HI-2088), so the search's placeholder isn't cut.
 */
export function McpSearch({ query, filter, onQuery, onFilter, errors, stacked }: { query: string; filter: McpFilter; onQuery: (q: string) => void; onFilter: (f: McpFilter) => void; errors?: boolean; stacked?: boolean }) {
  return (
    <div className={cx('mcp-search', stacked && 'stacked')}>
      <SearchInput value={query} onChange={onQuery} placeholder={tr(M.search)} aria-label={tr(M.search)} data-mcp-search="" />
      <select className="select" value={filter} aria-label={tr(M.filter)} data-mcp-filter="" onChange={(e) => onFilter(e.target.value as McpFilter)}>
        <option value="all">{tr(M.all)}</option>
        <option value="added">{tr(M.added)}</option>
        <option value="nowhere">{tr(M.nowhere)}</option>
        {errors && <option value="errors">{tr(M.errors)}</option>}
      </select>
    </div>
  )
}

/**
 * Add server… (HI-2059): the workspace's servers not yet added to a project or the Combwork Assistant (`servers`, those
 * that can be added), found by search and filter; the one chosen shows what it runs and what to know about its
 * definition before Add, which stays greyed out (the dialog's `dialogBlocked`) until one is chosen. `onPick` hears it.
 */
export function McpServerPicker({ servers, onPick }: { servers: readonly McpServerInfo[]; onPick: (m: McpServerInfo | null) => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<McpFilter>('all')
  const [picked, setPicked] = useState<string | null>(null)
  const shown = servers.filter((m) => mcpServerShown(m, query, filter))
  const chosen = shown.find((m) => m.name === picked) ?? null
  useEffect(() => {
    onPick(chosen)
    set({ dialogBlocked: chosen ? null : tr(M.choose) })
  }, [chosen, onPick])
  useEffect(() => () => set({ dialogBlocked: null }), [])
  if (!servers.length) return <p className="hint">{tr(M.allAdded)}</p>
  return (
    <div className="mcp-picker">
      <McpSearch query={query} filter={filter} onQuery={setQuery} onFilter={setFilter} />
      <div className="mcp-picker-list" role="listbox" aria-label={tr(M.search)}>
        {!shown.length && <p className="hint">{tr(M.noMatch)}</p>}
        {shown.map((m) => {
          const tags = Array.isArray(m.def?.tags) ? m.def.tags.filter((t) => typeof t === 'string') : []
          return (
            <div key={m.name} className={cx('mcp-picker-row', picked === m.name && 'selected')} role="option" aria-selected={picked === m.name} tabIndex={0} data-mcp={m.name} onClick={() => setPicked(m.name)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setPicked(m.name))}>
              <Icon name={m.def?.url ? 'globe' : 'plug'} />
              <div className="ti-text">
                <div className="ti-name">
                  {m.name} {tags.map((t) => <span key={t} className="badge mcp-tag">{t}</span>)}
                </div>
                <div className="ti-desc">{m.def?.description ?? m.def?.command ?? m.def?.url}</div>
              </div>
            </div>
          )
        })}
      </div>
      <div className="mcp-picker-runs" data-mcp-runs={chosen?.name}>
        {chosen ? (
          <>
            {chosen.secretWarnings.map((w) => (
              <p key={w} className="warn">
                <Icon name="warning" /> {w}
              </p>
            ))}
            <div>{tr(M.runs)}</div>
            <ul className="mono">
              {chosen.runs.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="hint">{tr(M.choose)}</p>
        )}
      </div>
    </div>
  )
}
