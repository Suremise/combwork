import { useState } from 'react'
import { msg, tr } from '@shared/i18n'

/**
 * The projects to turn a workspace MCP server on in, in its workspace enable dialog (#1093): a box per project, ticked
 * where it is on (the projects' own choices, kept while the workspace had it off, and the selected project), then one
 * for the Hive Assistant (HI-1472, its own choice, as a project's), with All and None for the projects (the Assistant
 * only ever by its own box: off until ticked). `onChange` hears every project's pick (path → on) and the Assistant's.
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
      <input type="checkbox" className="checkbox" checked={forAssistant} onChange={(e) => pick(on, e.target.checked)} /> {tr(msg({ id: 'mcp.enable.assistant', defaultMessage: 'Hive Assistant', description: 'The MCP server enable dialog: the box that turns the server on for the Hive Assistant, after the projects.' }))}
    </label>
  )
  return (
    <div className="mcp-projects">
      {said}
      {!projects.length && <p className="hint">{tr(msg({ id: 'mcp.enable.noProjects', defaultMessage: "The workspace has no projects yet: turn it on in a project's MCP tab once there is one.", description: 'The MCP server enable dialog when the workspace has no projects to choose.' }))}</p>}
      <div className="flex">
        <strong>{tr(msg({ id: 'mcp.enable.projects', defaultMessage: 'Turn on in', description: 'The MCP server enable dialog: the label above the projects to tick.' }))}</strong>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn small subtle" onClick={() => pick(projects.map((p) => p.path), forAssistant)}>
          {tr(msg({ id: 'mcp.enable.all', defaultMessage: 'All', description: 'The MCP server enable dialog: a button that ticks every project.' }))}
        </button>
        <button type="button" className="btn small subtle" onClick={() => pick([], forAssistant)}>
          {tr(msg({ id: 'mcp.enable.none', defaultMessage: 'None', description: 'The MCP server enable dialog: a button that unticks every project.' }))}
        </button>
      </div>
      <div className="choice-list" role="group" aria-label={tr(msg({ id: 'mcp.enable.projectsLabel', defaultMessage: 'Projects to turn it on in', description: 'Accessible name of the list of projects to tick in the MCP server enable dialog.' }))}>
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
