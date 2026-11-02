import { useEffect, useRef, useState } from 'react'
import type { McpCatalogFilter, McpCatalogRow, McpCatalogSourcePage } from '@shared/types'
import { fmt, msg, tr } from '@shared/i18n'
import { formatBytes } from '@shared/units'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { set, useStore } from '../store'
import { cx } from '../util'
import { Icon, SearchInput } from './ui'
import { Section } from './Sidebar'

const M = {
  search: msg({ id: 'mcp.catalog.search', defaultMessage: 'Search the catalogues', description: "The MCP view's Catalogue (HI-545): its search box (by name, description and tags)." }),
  filter: msg({ id: 'mcp.catalog.filter', defaultMessage: 'Show', description: "Accessible name of the Catalogue's filter (HI-545): which servers to show." }),
  source: msg({ id: 'mcp.catalog.source', defaultMessage: 'Source', description: "Accessible name of the Catalogue's source picker (HI-545)." }),
  allSources: msg({ id: 'mcp.catalog.allSources', defaultMessage: 'All sources', description: "The Catalogue's source picker (HI-545): every catalogue." }),
  all: msg({ id: 'mcp.catalog.filterAll', defaultMessage: 'All', description: "The Catalogue's filter (HI-545): every server." }),
  notInstalled: msg({ id: 'mcp.catalog.filterNotInstalled', defaultMessage: 'Not installed', description: "The Catalogue's filter (HI-545): servers not installed yet." }),
  installed: msg({ id: 'mcp.catalog.filterInstalled', defaultMessage: 'Installed', description: "The Catalogue's filter (HI-545): servers installed." }),
  updates: msg({ id: 'mcp.catalog.filterUpdates', defaultMessage: 'Updates available', description: "The Catalogue's filter (HI-545): installed servers with a newer version." }),
  meets: msg({ id: 'mcp.catalog.filterMeets', defaultMessage: 'Runs on this PC', description: "The Catalogue's filter (HI-545): servers whose requirements this PC meets (or Hive can't check)." }),
  loading: msg({ id: 'mcp.catalog.loading', defaultMessage: 'Reading the catalogues…', description: "The MCP view's Catalogue while it reads the catalogues (HI-545)." }),
  none: msg({ id: 'mcp.catalog.none', defaultMessage: 'No catalogues are on. Turn ours on, or add one, in Settings → MCP Catalogues.', description: "The Catalogue (HI-545) with every source off. Settings → MCP Catalogues as Hive names it." }),
  noMatch: msg({ id: 'mcp.catalog.noMatch', defaultMessage: 'No server matches.', description: "A catalogue source in the Catalogue (HI-545) with no server for the search and filter." }),
  more: msg({ id: 'mcp.catalog.more', defaultMessage: 'Show more ({left, number} left)', description: 'A button under a catalogue source (HI-545): loads its next servers. {left} is how many more match.' }),
  skipped: msg({ id: 'mcp.catalog.skipped', defaultMessage: '{n, plural, one {# entry skipped: not as catalogues give a server} other {# entries skipped: not as catalogues give a server}}', description: 'Under a catalogue source (HI-545): entries Hive left out because they are not valid.' }),
  unvetted: msg({ id: 'mcp.catalog.unvetted', defaultMessage: "Servers from this source aren't checked by Hive. Look at what one runs before you install it.", description: 'A note under a catalogue source the user added (HI-545), shown once: Hive does not vet its servers.' }),
  badgeInstalled: msg({ id: 'mcp.catalog.badgeInstalled', defaultMessage: 'Installed', description: 'A badge on a catalogue server (HI-545): it is installed.' }),
  badgeOther: msg({ id: 'mcp.catalog.badgeOther', defaultMessage: 'Name in use', description: 'A badge on a catalogue server (HI-545): a server of the same name, not from this catalogue, is installed.' }),
  badgeUpdate: msg({ id: 'mcp.catalog.badgeUpdate', defaultMessage: 'Update to {version}', description: 'A badge on a catalogue server (HI-545): a newer version is available.' }),
  badgeNeeds: msg({ id: 'mcp.catalog.badgeNeeds', defaultMessage: "Can't run here", description: "A badge on a catalogue server (HI-545): this PC doesn't meet one of its requirements." }),
  pick: msg({ id: 'mcp.catalog.pick', defaultMessage: 'Select a server in the Catalogue to see what it needs and install it.', description: "The MCP view's main area with the Catalogue tab and nothing selected (HI-545)." }),
  from: msg({ id: 'mcp.catalog.from', defaultMessage: 'From {source}', description: 'A catalogue server\'s view (HI-545): the catalogue it is in.' }),
  size: msg({ id: 'mcp.catalog.size', defaultMessage: 'Download: {size}', description: "A catalogue server's view (HI-545): the size of its zip." }),
  requires: msg({ id: 'mcp.catalog.requires', defaultMessage: 'Requirements', description: "A catalogue server's view (HI-545): the heading of what it needs on this PC." }),
  ok: msg({ id: 'mcp.catalog.ok', defaultMessage: 'Met', description: "A requirement's state in a catalogue server's view (HI-545), for screen readers." }),
  no: msg({ id: 'mcp.catalog.no', defaultMessage: 'Not met', description: "A requirement's state in a catalogue server's view (HI-545), for screen readers." }),
  unknown: msg({ id: 'mcp.catalog.unknown', defaultMessage: "Hive can't check this: make sure it's there", description: "A requirement's state in a catalogue server's view (HI-545): Hive can't check it on this PC." }),
  homepage: msg({ id: 'mcp.catalog.homepage', defaultMessage: 'Homepage', description: "A catalogue server's view (HI-545): opens its page in the browser." }),
  install: msg({ id: 'mcp.catalog.installAction', defaultMessage: 'Install…', description: "A catalogue server's view (HI-545): downloads, checks and shows it, before installing." }),
  update: msg({ id: 'mcp.catalog.updateAction', defaultMessage: 'Update to {version}…', description: "A catalogue server's view (HI-545): downloads the newer version and shows what changes, before updating." }),
  installedAt: msg({ id: 'mcp.catalog.installedAt', defaultMessage: 'Installed: {version}', description: "A catalogue server's view (HI-545): the version installed." }),
  cantRun: msg({ id: 'mcp.catalog.cantRun', defaultMessage: "This PC doesn't meet a requirement above, so it can't be installed.", description: "A catalogue server's view (HI-545) when a requirement Hive checked is not met: Install is greyed out." })
}

const FILTERS: McpCatalogFilter[] = ['all', 'notInstalled', 'installed', 'updates', 'meets']
const filterText = (f: McpCatalogFilter): string => (f === 'notInstalled' ? tr(M.notInstalled) : f === 'installed' ? tr(M.installed) : f === 'updates' ? tr(M.updates) : f === 'meets' ? tr(M.meets) : tr(M.all))

/** A row's badge: installed (or its name in use), an update, or can't run here. */
function badge(r: McpCatalogRow): { text: string; cls: string } | null {
  if (r.update) return { text: tr(M.badgeUpdate, { version: r.version }), cls: 'accent' }
  if (r.installed === 'other') return { text: tr(M.badgeOther), cls: 'warn' }
  if (r.installed) return { text: tr(M.badgeInstalled), cls: 'success' }
  if (r.checks.some((c) => c.state === 'no')) return { text: tr(M.badgeNeeds), cls: 'error' }
  return null
}

/**
 * The MCP view's Catalogue (HI-545): each source a category, ours first, with search and a filter, a page of servers
 * at a time. The catalogues are read when it opens and on ↻ (`mcpCatalogVersion`), never otherwise; a search, a filter
 * or the next page uses the copies read then. A reply to an older request is dropped.
 */
export function McpCatalogPanel() {
  const version = useStore((s) => s.mcpCatalogVersion)
  const picked = useStore((s) => s.mcpPick)
  const ws = useStore((s) => s.workspace?.path ?? null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<McpCatalogFilter>('all')
  const [only, setOnly] = useState('')
  const [pages, setPages] = useState<McpCatalogSourcePage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const read = useRef(-1)
  const noted = useRef(new Set<string>())
  useEffect(() => {
    const id = ++request.current
    // The catalogues are read again only when the view opens (or the workspace changes) and on ↻.
    const refresh = read.current !== version
    read.current = version
    const t = setTimeout(
      () =>
        void call('mcp:catalog', { query, filter, refresh }).then(
          (p) => id === request.current && (setPages(p), setError(null)),
          (e) => id === request.current && setError(errorMessage(e))
        ),
      refresh ? 0 : 200
    )
    return () => clearTimeout(t)
  }, [query, filter, version, ws])
  // A source Hive doesn't check: its note is said once, then remembered.
  useEffect(() => {
    for (const p of pages ?? []) {
      if (!p.noteDue || noted.current.has(p.url)) continue
      noted.current.add(p.url)
      void call('mcp:catalogNoted', p.url).catch(() => undefined)
    }
  }, [pages])
  const more = (url: string, offset: number): void => {
    const id = request.current
    void call('mcp:catalog', { query, filter, source: url, offset }).then((p) => {
      if (id !== request.current || !p[0]) return
      setPages((was) => (was ?? []).map((x) => (x.url === url ? { ...p[0], rows: [...x.rows, ...p[0].rows] } : x)))
    })
  }
  const shown = (pages ?? []).filter((p) => !only || p.url === only)
  return (
    <>
      <div className="mcp-search mcp-catalog-search">
        <SearchInput value={query} onChange={setQuery} placeholder={tr(M.search)} aria-label={tr(M.search)} data-catalog-search="" />
      </div>
      <div className="mcp-search mcp-catalog-filters">
        <select className="select" value={filter} aria-label={tr(M.filter)} data-catalog-filter="" onChange={(e) => setFilter(e.target.value as McpCatalogFilter)}>
          {FILTERS.map((v) => (
            <option key={v} value={v}>
              {filterText(v)}
            </option>
          ))}
        </select>
        <select className="select" value={only} aria-label={tr(M.source)} data-catalog-source="" onChange={(e) => setOnly(e.target.value)}>
          <option value="">{tr(M.allSources)}</option>
          {(pages ?? []).map((p) => (
            <option key={p.url} value={p.url}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="pane-empty">{error}</div>}
      {!pages && !error && (
        <div className="pane-empty">
          <Icon name="loading" spin /> {tr(M.loading)}
        </div>
      )}
      {pages && !pages.length && <div className="pane-empty">{tr(M.none)}</div>}
      {shown.map((p) => (
        <Section key={p.url} title={p.name} count={p.total}>
          <div data-catalog-source-url={p.url}>
            {(p.noteDue || noted.current.has(p.url)) && !p.ours && (
              <div className="pane-empty mcp-catalog-note" data-catalog-unvetted="">
                <Icon name="info" /> {tr(M.unvetted)}
              </div>
            )}
            {p.error && <div className="pane-empty mcp-catalog-error">{p.error}</div>}
            {!p.error && !p.total && <div className="pane-empty">{tr(M.noMatch)}</div>}
            {p.rows.map((r) => {
              const b = badge(r)
              return (
                <div key={r.name} className={cx(/* i18n-ignore: class names */ 'row tall', picked?.source === r.source && picked.name === r.name && 'selected')} data-catalog-server={r.name} onClick={() => set({ mcpPick: r })}>
                  <Icon name="package" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="label">
                      {r.name} <span className="faint">{r.version}</span>
                    </div>
                    <div className="desc" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.description}
                    </div>
                  </div>
                  {b && <span className={cx('badge', b.cls)}>{b.text}</span>}
                </div>
              )
            })}
            {p.rows.length < p.total && (
              <button className="btn small subtle mcp-catalog-more" onClick={() => more(p.url, p.rows.length)}>
                {tr(M.more, { left: p.total - p.rows.length })}
              </button>
            )}
            {p.skipped > 0 && <div className="pane-empty faint">{tr(M.skipped, { n: p.skipped })}</div>}
          </div>
        </Section>
      ))}
    </>
  )
}

/** A catalogue server's view (HI-545): where it comes from, what it needs on this PC, and Install or Update. */
export function McpCatalogDetail() {
  const r = useStore((s) => s.mcpPick)
  if (!r)
    return (
      <div className="empty-state" style={{ paddingTop: '14vh' }}>
        <Icon name="package" />
        <div>{tr(M.pick)}</div>
      </div>
    )
  const blocked = r.checks.some((c) => c.state === 'no')
  const host = (() => {
    try {
      return new URL(r.source).host || r.source
    } catch {
      return r.source
    }
  })()
  return (
    <div className="scroll-page">
      <div className="page-narrow mcp-catalog-detail" data-catalog-detail={r.name}>
        <h2 className="section">
          {r.name} <span className="faint">{r.version}</span>
        </h2>
        <p>{r.description}</p>
        <p className="hint">
          {tr(M.from, { source: host })} · {tr(M.size, { size: formatBytes(r.zip.size) })}
          {r.tags.length > 0 && <> · {fmt.list(r.tags, 'unit')}</>}
          {r.installed && r.installed !== 'other' && <> · {tr(M.installedAt, { version: r.installed })}</>}
        </p>
        <h3 className="section">{tr(M.requires)}</h3>
        <ul className="mcp-catalog-checks">
          {r.checks.map((c) => (
            <li key={`${c.kind}|${c.label}`} data-check={c.state}>
              <Icon name={c.state === 'ok' ? 'check' : c.state === 'no' ? 'close' : 'question'} />
              <span className="visually-hidden">{tr(c.state === 'ok' ? M.ok : c.state === 'no' ? M.no : M.unknown)}: </span>
              {c.label}
              {c.state === 'unknown' && <span className="faint"> — {tr(M.unknown)}</span>}
            </li>
          ))}
        </ul>
        {blocked && <p className="banner warn">{tr(M.cantRun)}</p>}
        <div className="flex">
          {r.update ? (
            <button className="btn primary" data-action="catalog-update" onClick={() => void actions.updateCatalogServer(r)}>
              <Icon name="cloud-download" /> {tr(M.update, { version: r.version })}
            </button>
          ) : (
            (!r.installed || r.installed === 'other') && (
              <button className="btn primary" data-action="catalog-install" disabled={blocked} onClick={() => void actions.installCatalogServer(r)}>
                <Icon name="cloud-download" /> {tr(M.install)}
              </button>
            )
          )}
          {r.homepage && (
            <button className="btn subtle" onClick={() => void call('app:openExternal', r.homepage!)}>
              <Icon name="link-external" /> {tr(M.homepage)}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
