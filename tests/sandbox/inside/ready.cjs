/**
 * When what the Sandbox driver (drive.cjs) reads is ready: conditions Combwork itself says are met, never a quiet spell
 * (tests/README.md: wait for Combwork to settle, not for a quiet spell). Each wait is bounded and gives null when it expires,
 * which the driver turns into a failed check, never a read of whatever is there. Node built-ins only: it runs inside the
 * Sandbox, and the unit tests (tests/sandboxChecks.test.ts) load it with stand-ins for the window and the Agent API.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** fn's first truthy value, polled every `every` ms; null once ms have passed. A throw counts as not yet. */
async function until(fn, ms, every = 250) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(every)
  }
}

const sameFolder = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/**
 * The new workspace is set up: Combwork's GET /v1/status names it as its workspace and lists its Combwork skills, which it
 * replies with only once the open has brought the bundled skills and modes up to date (servers.ts hiveSkillsNow, which
 * awaits the workspace's itemsUpToDate: workspace.ts's work after an open). `status` reads /v1/status. Gives the reply.
 */
function workspaceSetUp(status, folder, ms = 60_000, every = 250) {
  return until(async () => {
    const s = await status()
    return s && sameFolder(s.workspace?.path, folder) && Array.isArray(s.guidance?.skills) && s.guidance.skills.length > 0 ? s : null
  }, ms, every)
}

/**
 * Each workspace view the driver opens: its activity bar button's name, and the selectors that say it is shown with its
 * data loaded in a fresh workspace (one project, no cards, notes or servers of its own). `ready` must all be there and
 * `loading` none (selectors from the views' own markup: src/renderer/src/views, components).
 */
const VIEWS = [
  // Its projects' table, with the project's row (DataTable "ws-projects"); "Loading…" is an .empty-state meanwhile.
  { name: 'Workspace Overview', slug: 'workspace-overview', ready: ['.overview-page .ws-projects tbody tr:has-text("demo")'], loading: ['.main-area .empty-state .codicon-loading'] },
  // The columns once the board's stages have loaded (an empty .board[data-loading] meanwhile), Todo empty.
  { name: 'Task Board', slug: 'task-board', ready: ['.board-view .board:not([data-loading]) .board-column[data-column="todo"] .board-empty'], loading: ['.board-view .board[data-loading]'] },
  // The notes tree in the sidebar, which has only its pinned row and "No notes" until notes:tree replies: a fresh
  // workspace's shared notes hold the handovers folder.
  { name: 'Shared Notes', slug: 'shared-notes', ready: ['.pane-body .row[data-note="handovers"]'], loading: [] },
  // The skills list in the sidebar ("Loading…" meanwhile): the bundled skills' rows.
  { name: 'Skills', slug: 'skills', ready: ['.pane-body .row.skill-row'], loading: ['.pane-body .pane-empty .codicon-loading'] },
  // The servers list in the sidebar: "No MCP servers yet…" shows only once mcp:list has replied (none in a fresh one).
  { name: 'MCP Servers', slug: 'mcp-servers', ready: ['.pane-body .pane-empty:has-text("No MCP servers yet")'], loading: [] },
  // The Assistant's conversations, once session:list has replied ("Loading…" meanwhile): the sessions tree.
  { name: 'Assistant', slug: 'hive-assistant', ready: ['.sessions-list .sessions-tree'], loading: ['.main-area .empty-state .codicon-loading'] }
]
/** The view is shown and loaded: `count(selector)` counts matches in the window. Gives true, or null when ms pass. */
function viewReady(view, count, ms = 20_000, every = 250) {
  return until(async () => {
    for (const s of view.ready) if (!((await count(s)) > 0)) return false
    for (const s of view.loading) if ((await count(s)) > 0) return false
    return true
  }, ms, every)
}

module.exports = { sleep, until, sameFolder, workspaceSetUp, VIEWS, viewReady }
