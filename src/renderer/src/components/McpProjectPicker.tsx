import { useState } from 'react'
import { msg, tr } from '@shared/i18n'

/**
 * The projects a workspace MCP server is added to, in the MCP view's Add to… dialog (HI-2059): a box per project, ticked
 * where it is added, then one for the Hive Assistant (HI-1472, as a project's), with All and None for the projects (the
 * Assistant only ever by its own box). `onChange` hears every project's pick (path → added) and the Assistant's.
 * `warnings`: what to know about its definition (a literal secret), shown first, as the dialog's detail would.
 */
export function McpProjectPicker({ projects, initial, assistant, warnings, onChange }: { projects: readonly { path: string; name: string }[]; initial: readonly string[]; assistant: boolean; warnings: readonly string[]; onChange: (picks: Record<string, boolean>, assistant: boolean) => void }) {
  const [on, setOn] = useState<string[]>(() => projects.filter((p) => initial.includes(p.path)).map((p) => p.path))
  const [forAssistant, setForAssistant] = useState(assistant)
  const pick = (next: string[], nextAssistant: boolean): void => {
    setOn(next)
    setForAssistant(nextAssistant)
    onChange(Object.fromEntries(projects.map((p) => [p.path, next.includes(p.path)])), nextAssistant)
  }
  const said = warnings.map((w) => <p key={w}>{w}</p>)
  const assistantRow = (
    <label className="flex" data-assistant>
      <input type="checkbox" className="checkbox" checked={forAssistant} onChange={(e) => pick(on, e.target.checked)} /> {tr(msg({ id: 'mcp.enable.assistant', defaultMessage: 'Hive Assistant', description: 'The MCP view’s Add to… dialog: the box that adds the server for the Hive Assistant, after the projects.' }))}
    </label>
  )
  return (
    <div className="mcp-projects">
      {said}
      {!projects.length && <p className="hint">{tr(msg({ id: 'mcp.places.noProjects', defaultMessage: "The workspace has no projects yet: add it in a project's MCP tab once there is one.", description: 'The MCP view’s Add to… dialog (HI-2059) when the workspace has no projects to choose.' }))}</p>}
      <div className="flex">
        <strong>{tr(msg({ id: 'mcp.places.projects', defaultMessage: 'Added to', description: 'The MCP view’s Add to… dialog (HI-2059): the label above the projects to tick.' }))}</strong>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn small subtle" onClick={() => pick(projects.map((p) => p.path), forAssistant)}>
          {tr(msg({ id: 'mcp.enable.all', defaultMessage: 'All projects', description: 'The MCP view’s Add to… dialog: a button that ticks every project (not the Hive Assistant, which has its own box).' }))}
        </button>
        <button type="button" className="btn small subtle" onClick={() => pick([], forAssistant)}>
          {tr(msg({ id: 'mcp.enable.none', defaultMessage: 'No projects', description: 'The MCP view’s Add to… dialog: a button that unticks every project (not the Hive Assistant, which has its own box).' }))}
        </button>
      </div>
      <div className="choice-list" role="group" aria-label={tr(msg({ id: 'mcp.places.projectsLabel', defaultMessage: 'Projects to add it to', description: 'Accessible name of the list of projects to tick in the MCP view’s Add to… dialog (HI-2059).' }))}>
        {projects.map((p) => (
          <label key={p.path} className="flex" data-project={p.name}>
            <input type="checkbox" className="checkbox" checked={on.includes(p.path)} onChange={(e) => pick(e.target.checked ? [...on, p.path] : on.filter((x) => x !== p.path), forAssistant)} /> {p.name}
          </label>
        ))}
        {assistantRow}
      </div>
    </div>
  )
}
